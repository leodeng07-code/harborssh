from math import sin
from dataclasses import replace
from datetime import datetime, timezone
import random
import time

from .huawei import AP, OfflineRecord, Radio, Snapshot, Station
from .ha import summarize_ha
from .store import Policy


def synthetic_mac(prefix, number):
    return f"{prefix}-{number >> 16:04x}-{number & 0xffff:04x}"


def populate(store):
    interval = 300
    now = int(time.time())
    names = ["AC-01", "AC-02"]
    zones = ["B1 · 生产一车间", "B1 · 仓储区", "A2 · 办公区", "C1 · 质检区"]
    hotspot = {2: -25, 37: -21, 82: -17}
    policy = Policy()
    rng = random.Random(6508)
    aps = []
    for index in range(116):
        zone = index // 29
        mac = synthetic_mac("02ac", index + 1)
        building = ["B1-P", "B1-W", "A2", "C1"][zone]
        name = f"{building}-{index % 29 + 1:02d}"
        ap = AP(index, mac, name, f"GROUP-{zone + 1:02d}", "idle" if index == 96 else "nor")
        aps.append((ap, zone))
        store.locations[mac] = zones[zone]

    for step in range(288):
        snapshots = [Snapshot(name, [], [], []) for name in names]
        for source in snapshots:
            source.offline = []
        if step == 287:
            event = datetime.fromtimestamp(now - 5400, timezone.utc).isoformat(sep=" ", timespec="seconds")
            snapshots[0].offline.append(OfflineRecord(aps[96][0].mac, event, "Echo timeout"))
        source, backup = snapshots
        for index, (ap, zone) in enumerate(aps):
            source.aps.append(ap)
            if not ap.active:
                continue
            backup.aps.append(replace(ap, state="stdby"))
            peak = hotspot.get(index, 0)
            for radio_id, band, channel in [(0, "2.4G", "6/20M"), (1, "5G", "44/40M")]:
                cu = rng.randint(12, 49) if index != 37 else rng.randint(68, 80)
                source.radios.append(Radio(ap.id, radio_id, band, channel, cu))
            if index % 19 == 0:
                continue
            for slot in range(6 + index % 11):
                if index == 12 and slot == 0 and step >= 286:
                    continue
                radio = int(slot % 3 != 0)
                offset = round(4 * sin(step / 19 + index))
                rssi = -54 + rng.randint(-13, 9) + offset + peak
                if index == 11 and slot < 3 and step >= 286:
                    rssi = -79
                band = "5G" if radio else "2.4G"
                source.stations.append(Station(
                    synthetic_mac("02c1", index * 32 + slot), ap.id, radio, band,
                    "24/36" if rssi <= -75 else "144/173", rssi,
                    ["生产终端", "仓储手持", "办公 WLAN", "质检终端"][zone],
                ))
        for index, controller in enumerate(snapshots):
            controller.ha = summarize_ha({
                "group": {"id": 0, "vrid": 1, "interface": "Vlanif100", "backs_up_ap": True,
                          "vrrp": ("Master", "Backup")[index], "state": ("Active", "Inactive")[index],
                          "process": "Realtime", "service_index": 0},
                "service": {"state": "Connected", "peer": ("192.0.2.12", "192.0.2.11")[index]},
                "protect": {"enabled": False},
            }, controller.aps)
        store.record(now - (287 - step) * interval, snapshots, policy, interval, 30)
