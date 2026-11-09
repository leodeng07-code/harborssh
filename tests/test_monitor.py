from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory
import time
import unittest
from unittest.mock import patch

from wlan_monitor.diagnostics import AIR_FIELDS, STA_FIELDS, TRAFFIC_FIELDS, parse_metrics
from wlan_monitor.ha import parse_group, parse_protect, parse_service, read_ha, summarize_ha
from wlan_monitor.huawei import AP, Radio, Snapshot, Station, collect, parse_aps, parse_offline, parse_radios, parse_stations, validate_station_aps
from wlan_monitor.store import Policy, Store


AP_OUTPUT = """
Total AP information:
nor : normal [1]
---------------------------------------------------
ID MAC Name Group IP Type State STA Uptime ExtraInfo
---------------------------------------------------
0 02ac-0000-0001 example default 192.0.2.31 AP5030DN nor 2 5H -
---------------------------------------------------
Total: 1
"""
STA_OUTPUT = """
Rf/WLAN: Radio ID/WLAN ID
Rx/Tx: link receive rate/link transmit rate(Mbps)
---------------------------------------------------
STA MAC AP ID Ap name Rf/WLAN Band Type Rx/Tx RSSI VLAN IPv4 address SSID IPv6 address Online time Status
---------------------------------------------------
02c1-0000-0001 0 example 1/2 5G 11ax 24/54 -81 10 192.0.2.41 WLAN Test 2001:db8::41 000:00:03:00 Normal
02c1-0000-0002 0 example 0/2 2.4G 11n -/- - 10 - Test - 000:00:01:00 Normal
---------------------------------------------------
Total: 2 2.4G: 1 5G: 1
"""
RADIO_OUTPUT = """
CH/BW:Channel/Bandwidth
CE:Current EIRP (dBm)
ME:Max EIRP (dBm)
CU:Channel utilization
---------------------------------------------------
AP ID Name RfID Band Type Status CH/BW CE/ME STA CU
---------------------------------------------------
0 example 0 2.4G bgn on 6/20M 17/17 1 73%
0 example 1 5G an11ac on 44/40M 17/17 1 -
---------------------------------------------------
Total:2
"""
AP_OFFLINE_OUTPUT = """
MAC               Last offline time      Reason
---------------------------------------------------------------------
02ac-0000-0001    2026-11-09/08:15:23    Echo timeout
---------------------------------------------------------------------
Total records: 1
"""
STA_OFFLINE_OUTPUT = """
Rf/WLAN: Radio ID/WLAN ID
---------------------------------------------------------------------
STA MAC         AP ID Ap name        Rf/WLAN    Last record time
                Reason
---------------------------------------------------------------------
02c1-0000-0001  0     example AP     1/2        2026-11-09/08:15:24
                The signal strength is too low.
---------------------------------------------------------------------
Total stations: 1 Total records: 1
"""
AIR_OUTPUT = """
Wireless noise(dBm)                  :-104
Wireless port up rate(Kbps)          :5
Wireless port down rate(Kbps)        :120
Wireless channel utilization(%)      :84
"""
STA_DETAIL_OUTPUT = """
Station online time(ddd:hh:mm:ss)          : 000:06:30:19
The upstream SNR(dB)                      : 55.0
The upstream aggregate receive power(dBm)  : -52.0
Station connect rate(Mbps)                 : 103
"""
TRAFFIC_OUTPUT = """
Packets sent to the station                         : 11234
Bytes received from the station                     : 323444
Wireless data rate sent to the station(kbps)         : 4320
Wireless data rate received from the station(kbps)   : 4599
"""
HSB_GROUP_OUTPUT = """
Hot Standby Group Information:
----------------------------------------------------------
HSB-group ID                 : 0
Vrrp Group ID                : 1
Vrrp Interface               : Vlanif100
Service Index                : 3
Group Vrrp Status            : Master
Group Status                 : Active
Group Backup Process         : Realtime
Group Backup Modules         : Access-user,
                               AP,
                               DHCP
----------------------------------------------------------
"""
HSB_SERVICE_OUTPUT = """
Hot Standby Service Information:
Local IP Address : 192.0.2.11
Peer IP Address  : 192.0.2.12
Service State    : Connected
Shared-key       : fixture-secret
"""
AC_PROTECT_OUTPUT = """
Protect state    : enable
Protect AC IPv4  : 192.0.2.12
Protect AC IPv6  : 2001:db8::2
Priority         : 0
Protect restore  : enable
"""


class HATests(unittest.TestCase):
    def test_vrrp_role_requires_ap_backup_and_consistent_runtime_states(self):
        group = parse_group(HSB_GROUP_OUTPUT)
        self.assertEqual((group["backs_up_ap"], group["vrid"], group["service_index"]), (True, 1, 3))
        self.assertEqual(summarize_ha({"group": group}, [])["role"], "primary")
        self.assertEqual(summarize_ha({"group": dict(group, vrrp="Backup", state="Inactive")}, [])["role"], "standby")
        self.assertEqual(summarize_ha({"group": dict(group, vrrp="Initialize", state="Switching")}, [])["role"], "switching")
        self.assertEqual(summarize_ha({"group": dict(group, vrrp="Backup")}, [])["role"], "unknown")
        unrelated = parse_group(HSB_GROUP_OUTPUT.replace("AP,", "Access-AP,"))
        self.assertEqual(summarize_ha({"group": unrelated}, parse_aps(AP_OUTPUT))["role"], "unknown")
        self.assertIsNone(parse_group(HSB_GROUP_OUTPUT + "---- More ----"))

    def test_collects_bound_service_and_does_not_retain_shared_key(self):
        outputs = {
            "display ac protect": AC_PROTECT_OUTPUT,
            "display hsb-group 0": HSB_GROUP_OUTPUT,
            "display hsb-service 3": HSB_SERVICE_OUTPUT,
        }
        ha = read_ha(lambda command, timeout: outputs[command])
        self.assertEqual(ha["service"], {"state": "Connected", "peer": "192.0.2.12"})
        self.assertNotIn("fixture-secret", str(ha))
        self.assertEqual((ha["protect"]["priority"], ha["protect"]["peers"]), (0, ["192.0.2.12", "2001:db8::2"]))
        self.assertEqual(parse_service(HSB_SERVICE_OUTPUT.replace("Connected", "Not Valid"))["state"], "Not Valid")
        self.assertEqual(parse_protect("Protect state: disable")["enabled"], False)

    def test_optional_commands_do_not_invalidate_ap_and_station_data(self):
        outputs = {
            "display ap all": AP_OUTPUT,
            "display station all": STA_OUTPUT,
            "display radio all": RADIO_OUTPUT,
            "display ap offline-record all": AP_OFFLINE_OUTPUT,
            "display ac protect": "Error: Permission denied.",
            "display hsb-group 0": "Error: Permission denied.",
            "display hsb-service 0": "Error: Permission denied.",
        }
        with patch("wlan_monitor.huawei.query_device", side_effect=lambda device, operation, password: operation(
            lambda command, **kwargs: outputs[command]
        )):
            result = collect({"name": "AC1"})
            self.assertEqual((result.error, len(result.aps), len(result.stations)), ("", 1, 2))
            self.assertEqual((result.ha["role"], result.ha["active"], len(result.ha["unread"])), ("unknown", 1, 3))
            outputs["display hsb-group 0"] = HSB_GROUP_OUTPUT
            outputs["display hsb-service 3"] = HSB_SERVICE_OUTPUT
            outputs["display station all"] = "unrecognized"
            result = collect({"name": "AC1"})
            self.assertTrue(result.error)
            self.assertEqual((result.ha["role"], result.ha["active"]), ("primary", 1))


class ParserTests(unittest.TestCase):
    def test_diagnostics_keep_units_zeroes_and_offline_reasons(self):
        results = [parse_metrics(data, fields, "display test") for data, fields in (
            (AIR_OUTPUT, AIR_FIELDS), (STA_DETAIL_OUTPUT, STA_FIELDS), (TRAFFIC_OUTPUT, TRAFFIC_FIELDS)
        )]
        values = [{entry["key"]: entry["value"] for entry in metrics} for metrics in results]
        self.assertEqual((values[0]["noise"], values[0]["cu"], values[1]["online_time"], values[2]["rx_rate"]),
                         (-104, 84, "000:06:30:19", 4599))
        ap = parse_offline(AP_OFFLINE_OUTPUT)[0]
        sta = parse_offline(STA_OFFLINE_OUTPUT, "02c1-0000-0001")[0]
        self.assertEqual((ap.device_time, ap.reason), ("2026-11-09 08:15:23", "Echo timeout"))
        self.assertEqual((sta.ap_name, sta.reason), ("example AP", "The signal strength is too low."))
        self.assertEqual(parse_offline("Total records: 0"), [])
        with self.assertRaises(ValueError):
            parse_offline(AP_OFFLINE_OUTPUT.replace("records: 1", "records: 2"))

    def test_ap_offline_validates_record_total_separately_from_ap_count(self):
        heading, divider, *_ = AP_OFFLINE_OUTPUT.strip().splitlines()
        records = []
        for ap_id in range(157):
            mac = f"02ac-0000-{ap_id:04x}"
            records.extend([
                f"{mac} 2026-09-29/18:26:16  CAPWAP control tunnel heartbeat timeout",
                f"{mac} 2026-08-22/15:56:46  The AP is powered off and restarts",
            ])
            if ap_id < 133:
                records.append(f"{mac} 2025-12-11/18:11:14  The AP group name is modified")
        output = "\n".join([divider, heading, divider, *records, divider, "Total APs: 157 Total records: 447", "<AC6508>"])
        rows = parse_offline(output)
        self.assertEqual((len(rows), len({row.mac for row in rows})), (447, 157))
        self.assertEqual((rows[0].device_time, rows[0].reason), (
            "2026-09-29 18:26:16", "CAPWAP control tunnel heartbeat timeout",
        ))
        self.assertEqual(parse_offline("Total APs: 0 Total records: 0"), [])
        with self.assertRaisesRegex(ValueError, "分页"):
            parse_offline(output.replace(records[30], "---- More ----\n" + records[30]))
        with self.assertRaisesRegex(ValueError, "446 条记录，汇总为 447"):
            parse_offline(output.replace(records[-1] + "\n", ""))

    def test_station_format_variants(self):
        stations = parse_stations(STA_OUTPUT)
        self.assertEqual((stations[0].ssid, stations[0].status, stations[0].rssi), ("WLAN Test", "Normal", -81))
        self.assertIsNone(stations[1].rssi)
        simpler = (
            "Total: 1 2.4G: 0 5G: 1\n"
            "STA MAC AP ID Ap name Rf/WLAN Band Type Rx/Tx RSSI VLAN IP address SSID\n"
            "02c1-0000-0001 0 example 1/2 5G 11ax 24/54 -81 10 192.0.2.41 WLAN Test\n"
            "--------\n<test>"
        )
        self.assertEqual(parse_stations(simpler)[0].ssid, "WLAN Test")

    def test_truncated_or_paged_output_is_rejected(self):
        for output in (STA_OUTPUT.replace("Total: 2", "Total: 3"), STA_OUTPUT + "---- More ----"):
            with self.assertRaises(ValueError):
                parse_stations(output)

    def test_only_nonserving_controller_may_omit_total_for_empty_station_table(self):
        empty = "STA MAC AP ID Ap name Rf/WLAN Band Type Rx/Tx RSSI VLAN IP address SSID\n--------\n"
        self.assertEqual(parse_stations(empty, allow_empty_without_total=True), [])
        with self.assertRaises(ValueError):
            parse_stations(empty)

    def test_ap_identity_and_radio_fields(self):
        aps = parse_aps(AP_OUTPUT)
        self.assertTrue(aps[0].active)
        radios = parse_radios(RADIO_OUTPUT)
        self.assertEqual((radios[0].channel, radios[0].cu, radios[1].cu), ("6/20M", 73, None))
        validate_station_aps(aps, parse_stations(STA_OUTPUT))
        with self.assertRaises(ValueError):
            validate_station_aps([], parse_stations(STA_OUTPUT))

    def test_radio_utilization_precedes_interference_and_working_mode(self):
        output = """
CH/BW:Channel/Bandwidth
CU:Channel utilization
CCI/TX/RX/NF:Co-channel interference/Transmit time ratio/Receive time ratio/Noise floor
ST:Status
WM:Working Mode
------------------------------------------------------------------------------
AP ID Name              RfID Band Type ST  CH/BW   CE/ME STA CU  CCI/TX/RX/NF WM
------------------------------------------------------------------------------
99    AP-S85 LK-1FCCX2   0    2.4G 11ax on  6/20M   17/17 1   73% 3/14/4/-95  normal
99    AP-S85 LK-1FCCX2   1    5G   11ax on  44/40M  20/20 0   -   -/-/-/-     monitor proxy dual-band-scan
99    AP-S85 LK-1FCCX2   2    6G   -    off -       -     0   -   -/-/-/-     -
------------------------------------------------------------------------------
Total: 3
"""
        radios = parse_radios(output)
        self.assertEqual([(r.ap_id, r.radio_id, r.channel, r.cu) for r in radios], [
            (99, 0, "6/20M", 73),
            (99, 1, "44/40M", None),
        ])

    def test_ap_name_with_space_preserves_active_state_and_station_fields(self):
        name = "AP-S85 LK-1FCCX2"
        aps = parse_aps(AP_OUTPUT.replace("0 02ac-0000-0001 example", f"99 02ac-0000-0001 {name}"))
        stations = parse_stations(
            "STA MAC          AP ID Ap name                          Rf/WLAN  Band  Type  Rx/Tx      RSSI  VLAN  IP address       SSID        Status\n"
            f"02c1-0000-0001   99    {name:<31}1/1      5G    11ax  455/344    -55   1013  192.0.2.41       WLAN Test   Normal\n"
            "Total: 1 2.4G: 0 5G: 1 6G: 0\n"
        )
        radios = parse_radios(RADIO_OUTPUT.replace("0 example ", f"99 {name} "))
        self.assertEqual((aps[0].name, aps[0].group, aps[0].active), (name, "default", True))
        self.assertEqual(stations[0], Station("02c1-0000-0001", 99, 1, "5G", "455/344", -55, "WLAN Test", "Normal"))
        self.assertEqual((radios[0].ap_id, radios[0].radio_id, radios[0].cu), (99, 0, 73))
        validate_station_aps(aps, stations)


class SignalTests(unittest.TestCase):
    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.store = Store(Path(directory.name) / "test.sqlite")
        self.at = int(time.time()) - 3600
        self.ap = AP(0, "02ac-0000-0001", "example", "default", "nor")
        self.stations = [Station(f"02c1-0000-{n:04x}", 0, 1, "5G", "24/54", rssi, "WLAN") for n, rssi in enumerate(
            [-85, -78, -75, -55, None], 1
        )]

    def sample(self, snapshots, policy=Policy(), elapsed=300):
        self.at += elapsed
        self.store.record(self.at, snapshots, policy, 300, 30)
        return self.store.read()

    def test_missing_station_needs_two_complete_rounds_and_ap_records_dedupe(self):
        connected = Snapshot("AC1", [self.ap], self.stations[:1], [], offline=parse_offline(AP_OFFLINE_OUTPUT))
        absent = replace(connected, stations=[])
        failed = Snapshot("AC1", [], [], [], error="timeout")
        self.sample([connected])
        self.sample([absent])
        self.sample([failed])
        self.sample([absent])
        self.sample([absent])
        self.assertEqual([event["kind"] for event in self.store.events()], ["ap"])
        self.sample([connected])
        last_seen = self.at
        self.sample([absent])
        first_missing = self.at
        self.sample([absent])
        self.sample([absent])
        event, ap = self.store.events()
        self.assertEqual((event["kind"], event["last_seen"], event["first_missing"]),
                         ("station_missing", last_seen, first_missing))
        self.assertEqual(ap["kind"], "ap")

    def test_trend_uses_configured_channel_threshold_and_leaves_radio_gaps(self):
        radio = Radio(0, 1, "5G", "36/80M", 70)
        data = self.sample([Snapshot("AC1", [self.ap], self.stations, [radio])], Policy(high_cu=70))
        self.assertEqual(data["trend"][-1]["busy"], 1)
        data = self.sample([Snapshot("AC1", [self.ap], self.stations, [], radio_error="format")], Policy(high_cu=70))
        self.assertIsNone(data["trend"][-1]["busy"])

    def test_weak_signal_streak_excludes_unknown_rssi_and_resets_on_failure(self):
        ok = Snapshot("AC1", [self.ap], self.stations, [])
        for expected in ("watch", "watch", "alert"):
            ap = self.sample([ok])["aps"][0]
            self.assertEqual(ap["quality"], expected)
            self.assertEqual((ap["total"], ap["valid"], ap["weak"], ap["critical"], ap["p10"]), (5, 4, 3, 1, -85))
        failed = self.sample([Snapshot("AC1", [], [], [], error="timeout")])
        self.assertEqual(failed["aps"], [])
        self.assertEqual(failed["controllers"][0]["error"], "timeout")
        self.assertEqual(self.sample([ok])["aps"][0]["streak"], 1)
        history = self.store.read(self.ap.mac)["history"]
        self.assertIsNone(history[-2]["quality"])
        self.assertEqual(self.sample([ok], elapsed=700)["aps"][0]["streak"], 1)

    def test_serving_ap_wins_over_standby_and_streak_survives_failover(self):
        standby = replace(self.ap, id=5, state="stdby")
        replica = [replace(s, ap_id=5) for s in self.stations]
        result = self.sample([Snapshot("AC1", [standby], replica, []), Snapshot("AC2", [self.ap], self.stations, [])])
        self.assertEqual([(a["ac"], a["total"]) for a in result["aps"]], [("AC2", 5)])
        result = self.sample([Snapshot("AC1", [replace(standby, state="nor")], replica, []),
                              Snapshot("AC2", [replace(self.ap, state="stdby")], self.stations, [])])
        self.assertEqual([(a["ac"], a["streak"]) for a in result["aps"]], [("AC1", 2)])
        self.assertEqual(len(self.store.read(self.ap.mac)["stations"]), 5)

    def test_ac_role_counts_survive_ap_dedup_and_update_on_switchover(self):
        other = replace(self.ap, id=1, mac="02ac-0000-0002")
        protect = {"protect": parse_protect(AC_PROTECT_OUTPUT)}

        def snapshot(name, *aps):
            return Snapshot(name, list(aps), [], [], ha=summarize_ha(protect, aps))

        old = self.sample([Snapshot("AC1", [self.ap], [], [])])
        self.assertIsNone(old["controllers"][0]["ha"])
        result = self.sample([snapshot("AC1", self.ap, replace(other, state="standby")),
                              snapshot("AC2", other, replace(self.ap, state="stdby"))])
        self.assertEqual(len(result["aps"]), 2)
        self.assertEqual([(ac["ha"]["role"], ac["ha"]["active"], ac["ha"]["standby"]) for ac in result["controllers"]],
                         [("mixed", 1, 1), ("mixed", 1, 1)])
        result = self.sample([snapshot("AC1", self.ap, other),
                              snapshot("AC2", replace(self.ap, state="stdby"), replace(other, state="stdby"))])
        self.assertEqual([ac["ha"]["role"] for ac in result["controllers"]], ["primary_link", "standby_link"])

    def test_ambiguous_roaming_station_is_excluded(self):
        other_ap = replace(self.ap, mac="02ac-0000-0002")
        result = self.sample([
            Snapshot("AC1", [self.ap], self.stations, []),
            Snapshot("AC2", [other_ap], self.stations[:1], []),
        ])
        self.assertEqual({ap["quality"] for ap in result["aps"]}, {"conflict"})
        self.assertNotIn(self.stations[0].mac, {s["mac"] for s in self.store.read(self.ap.mac)["stations"]})
