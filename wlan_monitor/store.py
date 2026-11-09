from collections import defaultdict
from contextlib import contextmanager
from dataclasses import asdict, dataclass
import json
import math
from pathlib import Path
import sqlite3
import time

from .huawei import mac_id


@dataclass(frozen=True)
class Policy:
    weak_rssi: int = -75
    critical_rssi: int = -82
    min_weak: int = 3
    min_percent: int = 20
    consecutive: int = 3
    high_cu: int = 60

    def __post_init__(self):
        for key, value in asdict(self).items():
            if type(value) is not int:
                raise ValueError(f"policy.{key} 需要整数")
        if not -127 <= self.critical_rssi < self.weak_rssi < 0:
            raise ValueError("RSSI 阈值须满足 -127 ≤ 严重阈值 < 弱信号阈值 < 0")
        if self.min_weak < 1 or not 1 <= self.min_percent <= 100 or not 1 <= self.consecutive <= 60:
            raise ValueError("预警所需终端数、占比或连续轮数超出范围")
        if not 1 <= self.high_cu <= 100:
            raise ValueError("信道利用率门槛须在 1 到 100 之间")


SCHEMA = """
CREATE TABLE IF NOT EXISTS rounds (
    at INTEGER PRIMARY KEY,
    interval INTEGER NOT NULL,
    policy TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS controllers (
    at INTEGER NOT NULL REFERENCES rounds(at) ON DELETE CASCADE,
    name TEXT NOT NULL,
    error TEXT NOT NULL,
    radio_error TEXT NOT NULL,
    offline_error TEXT,
    PRIMARY KEY (at, name)
);
CREATE TABLE IF NOT EXISTS ac_ha (
    at INTEGER NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    PRIMARY KEY (at, name),
    FOREIGN KEY (at, name) REFERENCES controllers(at, name) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS aps (
    at INTEGER NOT NULL REFERENCES rounds(at) ON DELETE CASCADE,
    mac TEXT NOT NULL,
    name TEXT NOT NULL,
    ac TEXT NOT NULL,
    ap_group TEXT NOT NULL,
    state TEXT NOT NULL,
    quality TEXT NOT NULL,
    total INTEGER NOT NULL,
    valid INTEGER NOT NULL,
    weak INTEGER NOT NULL,
    critical INTEGER NOT NULL,
    p10 INTEGER,
    streak INTEGER NOT NULL,
    radios TEXT NOT NULL,
    PRIMARY KEY (at, mac)
);
CREATE INDEX IF NOT EXISTS aps_history ON aps(mac, at);
CREATE TABLE IF NOT EXISTS stations (
    mac TEXT PRIMARY KEY,
    ap_mac TEXT NOT NULL,
    radio_id INTEGER NOT NULL,
    band TEXT NOT NULL,
    rates TEXT NOT NULL,
    rssi INTEGER,
    ssid TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS stations_ap ON stations(ap_mac);
CREATE TABLE IF NOT EXISTS offline_events (
    kind TEXT NOT NULL, mac TEXT NOT NULL, event_time TEXT NOT NULL,
    ac TEXT NOT NULL, ap_name TEXT NOT NULL, reason TEXT NOT NULL,
    captured_at INTEGER NOT NULL, last_seen INTEGER, first_missing INTEGER,
    PRIMARY KEY (kind, mac, event_time, ac, reason)
);
CREATE INDEX IF NOT EXISTS offline_events_recent ON offline_events(captured_at);
CREATE TABLE IF NOT EXISTS station_presence (
    mac TEXT PRIMARY KEY, ac TEXT NOT NULL, ap_name TEXT NOT NULL,
    last_seen INTEGER NOT NULL, first_missing INTEGER
);
"""


class Store:
    def __init__(self, path, locations=None):
        self.path = Path(path)
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.locations = locations or {}
        with self.connect() as db:
            db.execute("PRAGMA journal_mode = WAL")
            db.executescript(SCHEMA)
            if "offline_error" not in {column["name"] for column in db.execute("PRAGMA table_info(controllers)")}:
                db.execute("ALTER TABLE controllers ADD COLUMN offline_error TEXT")

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys = ON")
        try:
            with db:
                yield db
        finally:
            db.close()

    def record(self, at, snapshots, policy, interval, history_days):
        candidates = defaultdict(list)
        for snapshot in snapshots:
            if not snapshot.error:
                for ap in snapshot.aps:
                    candidates[ap.mac].append((snapshot, ap))

        selected, active_keys, conflicts = {}, {}, set()
        for mac, entries in candidates.items():
            active = [(source, ap) for source, ap in entries if ap.active]
            if len(active) > 1:
                conflicts.add(mac)
            # Prefer the serving AC. Otherwise show one inventory record for the AP.
            source, ap = (active or entries)[0]
            selected[mac] = (source, ap)
            if len(active) == 1:
                active_keys[source.name, ap.id] = mac

        station_candidates = defaultdict(list)
        radios_by_ap = defaultdict(list)
        for snapshot in snapshots:
            if snapshot.error:
                continue
            for station in snapshot.stations:
                mac = active_keys.get((snapshot.name, station.ap_id))
                if mac and station.status.lower() not in {"backup", "bak", "standby", "stdby", "delay"}:
                    station_candidates[station.mac].append((mac, station))
            for radio in snapshot.radios:
                mac = active_keys.get((snapshot.name, radio.ap_id))
                if mac:
                    radios_by_ap[mac].append(radio)

        stations_by_ap = defaultdict(list)
        for entries in station_candidates.values():
            if len(entries) > 1:
                # A roaming STA can be seen on both ACs during one round.
                conflicts.update(mac for mac, _ in entries)
                continue
            mac, station = entries[0]
            stations_by_ap[mac].append(station)

        policy_json = json.dumps(asdict(policy), sort_keys=True)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            previous = db.execute("SELECT * FROM rounds ORDER BY at DESC LIMIT 1").fetchone()
            if previous and at <= previous["at"]:
                raise ValueError("本轮时间早于或等于已入库轮次，请检查重复采集或服务器时钟")
            streaks = {}
            continuous = (previous and previous["interval"] == interval
                          and interval * 0.5 <= at - previous["at"] <= interval * 1.75)
            old_policy = Policy(**json.loads(previous["policy"])) if previous else None
            if continuous and old_policy == policy:
                streaks = dict(db.execute("SELECT mac, streak FROM aps WHERE at = ? AND streak > 0", (previous["at"],)))

            db.execute("INSERT INTO rounds VALUES (?, ?, ?)", (at, interval, policy_json))
            db.executemany("INSERT INTO controllers (at, name, error, radio_error, offline_error) VALUES (?, ?, ?, ?, ?)", (
                (at, s.name, s.error, s.radio_error,
                 s.offline_error or ("" if s.offline is not None else None)) for s in snapshots
            ))
            db.executemany("INSERT INTO ac_ha VALUES (?, ?, ?)", (
                (at, source.name, json.dumps(source.ha, ensure_ascii=False))
                for source in snapshots if source.ha is not None
            ))
            self._record_ap_events(db, at, snapshots, selected)
            stable = continuous and {row[0] for row in db.execute(
                "SELECT name FROM controllers WHERE at = ?", (previous["at"],)
            )} == {source.name for source in snapshots}
            complete = bool(snapshots) and not conflicts and all(not source.error for source in snapshots)
            self._record_presence(db, at, selected, stations_by_ap, stable, complete)
            db.execute("DELETE FROM stations")
            for mac, (source, ap) in selected.items():
                stations = stations_by_ap[mac]
                rssi = sorted(s.rssi for s in stations if s.rssi is not None)
                valid = len(rssi)
                weak = sum(value <= policy.weak_rssi for value in rssi)
                critical = sum(value <= policy.critical_rssi for value in rssi)
                p10 = rssi[math.ceil(valid / 10) - 1] if valid else None
                streak = 0
                if mac in conflicts:
                    quality = "conflict"
                elif not ap.active:
                    quality = "inactive"
                elif not valid:
                    quality = "unknown" if stations else "empty"
                elif weak >= policy.min_weak and 100 * weak >= policy.min_percent * valid:
                    streak = streaks.get(mac, 0) + 1
                    quality = "alert" if streak >= policy.consecutive else "watch"
                else:
                    quality = "weak" if weak else "normal"
                radios = sorted(radios_by_ap[mac], key=lambda item: item.radio_id)
                db.execute("INSERT INTO aps VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (
                    at, mac, ap.name, source.name, ap.group, ap.state, quality, len(stations), valid,
                    weak, critical, p10, streak, json.dumps([asdict(r) for r in radios])
                ))
                db.executemany("INSERT INTO stations VALUES (?, ?, ?, ?, ?, ?, ?)", (
                    (s.mac, mac, s.radio_id, s.band, s.rates, s.rssi, s.ssid) for s in stations
                ))
            db.execute("DELETE FROM rounds WHERE at < ?", (at - history_days * 86400,))
            db.execute("DELETE FROM offline_events WHERE captured_at < ?", (at - history_days * 86400,))

    def _record_ap_events(self, db, at, snapshots, selected):
        for source in snapshots:
            for event in source.offline or ():
                name = selected[event.mac][1].name if event.mac in selected else event.ap_name
                db.execute("INSERT OR IGNORE INTO offline_events VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)", (
                    "ap", event.mac, event.device_time, source.name, name, event.reason, at,
                ))

    def _record_presence(self, db, at, selected, stations_by_ap, stable, complete):
        if not stable or not complete:
            db.execute("DELETE FROM station_presence")
        if not complete:
            return
        observed = {
            sta.mac: (source.name, ap.name)
            for mac, (source, ap) in selected.items()
            for sta in stations_by_ap[mac]
        }
        for previous in db.execute("SELECT * FROM station_presence").fetchall():
            mac = previous["mac"]
            if mac in observed:
                continue
            first_missing = previous["first_missing"]
            if first_missing is None:
                db.execute("UPDATE station_presence SET first_missing = ? WHERE mac = ?", (at, mac))
            else:
                db.execute("INSERT OR IGNORE INTO offline_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", (
                    "station_missing", mac, str(first_missing), previous["ac"], previous["ap_name"],
                    "连续两轮未观察到关联", at, previous["last_seen"], first_missing,
                ))
                db.execute("DELETE FROM station_presence WHERE mac = ?", (mac,))
        db.executemany("""
            INSERT INTO station_presence VALUES (?, ?, ?, ?, NULL)
            ON CONFLICT(mac) DO UPDATE SET ac=excluded.ac, ap_name=excluded.ap_name,
                last_seen=excluded.last_seen, first_missing=NULL
        """, ((mac, ac, ap_name, at) for mac, (ac, ap_name) in observed.items()))

    def record_station_events(self, results):
        at = int(time.time())
        with self.connect() as db:
            db.executemany("INSERT OR IGNORE INTO offline_events VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)", (
                ("station", event["mac"], event["device_time"], result["ac"], event["ap_name"], event["reason"], at)
                for result in results if not result["error"] for event in result["events"]
            ))

    def events(self, mac=None):
        with self.connect() as db:
            if mac:
                rows = db.execute("""SELECT * FROM offline_events WHERE mac=? ORDER BY captured_at DESC, event_time DESC LIMIT 100""", (mac_id(mac),))
            else:
                rows = db.execute("""SELECT * FROM offline_events ORDER BY captured_at DESC, event_time DESC LIMIT 100""")
            return [dict(row) for row in rows]

    def station_source(self, mac):
        with self.connect() as db:
            row = db.execute("""
                SELECT a.ac FROM stations s JOIN aps a ON a.mac=s.ap_mac
                WHERE s.mac=? AND a.at=(SELECT MAX(at) FROM rounds) AND a.quality<>'conflict'
            """, (mac_id(mac),)).fetchone()
            return row["ac"] if row else None

    def _ap_data(self, row):
        ap = dict(row)
        ap["location"] = self.locations.get(ap["mac"], "")
        ap["radios"] = json.loads(ap["radios"])
        return ap

    def read(self, mac=None, history_days=1):
        with self.connect() as db:
            db.execute("BEGIN")
            latest = db.execute("SELECT * FROM rounds ORDER BY at DESC LIMIT 1").fetchone()
            if not latest:
                return None
            at = latest["at"]
            result = {
                "at": at, "interval": latest["interval"], "policy": json.loads(latest["policy"]),
                "stale": time.time() - at > latest["interval"] * 2,
            }
            if mac is None:
                result["controllers"] = [
                    dict(row, ha=json.loads(row["ha"]) if row["ha"] else None)
                    for row in db.execute("""
                        SELECT c.name, c.error, c.radio_error, c.offline_error, h.status AS ha
                        FROM controllers c LEFT JOIN ac_ha h USING (at, name)
                        WHERE c.at = ? ORDER BY c.name
                    """, (at,))
                ]
                result["aps"] = [self._ap_data(row) for row in db.execute("SELECT * FROM aps WHERE at = ?", (at,))]
                result["trend"] = [dict(row) for row in db.execute("""
                    WITH status AS (
                        SELECT at, MAX(error <> '') AS incomplete, MAX(radio_error <> '') AS radio_incomplete
                        FROM controllers WHERE at > ? GROUP BY at
                    )
                    SELECT r.at,
                        CASE WHEN s.incomplete=0 AND json_extract(r.policy, '$.weak_rssi')=? THEN
                            COUNT(CASE WHEN a.weak > 0 AND a.quality<>'conflict' THEN 1 END) END AS weak,
                        CASE WHEN s.incomplete=0 THEN COUNT(CASE WHEN a.quality='inactive' AND a.state NOT IN ('standby','stdby') THEN 1 END) END AS inactive,
                        CASE WHEN s.incomplete=0 AND s.radio_incomplete=0 AND MAX(
                            EXISTS(SELECT 1 FROM json_each(a.radios) WHERE json_type(value,'$.cu')='integer')
                        )=1 THEN COUNT(CASE WHEN a.quality<>'conflict' AND
                            EXISTS(SELECT 1 FROM json_each(a.radios) WHERE json_extract(value,'$.cu') >= ?) THEN 1 END) END AS busy
                    FROM rounds r JOIN status s ON s.at=r.at LEFT JOIN aps a ON a.at=r.at
                    WHERE r.at > ? GROUP BY r.at ORDER BY r.at
                """, (at - 86400, result["policy"]["weak_rssi"], result["policy"].get("high_cu", Policy.high_cu), at - 86400))]
                return result

            row = db.execute("SELECT * FROM aps WHERE at = ? AND mac = ?", (at, mac_id(mac))).fetchone()
            if row is None:
                return None
            result["ap"] = self._ap_data(row)
            result["stations"] = [
                dict(station) for station in db.execute(
                    "SELECT mac, radio_id, band, rates, rssi, ssid FROM stations WHERE ap_mac = ? ORDER BY rssi IS NULL, rssi, mac",
                    (row["mac"],)
                )
            ]
            result["history"] = [
                dict(sample) for sample in db.execute("""
                    SELECT rounds.at, rounds.policy, aps.quality, aps.valid, aps.weak, aps.p10
                    FROM rounds LEFT JOIN aps ON aps.at = rounds.at AND aps.mac = ?
                    WHERE rounds.at > ? ORDER BY rounds.at
                """, (row["mac"], at - history_days * 86400))
            ]
            return result
