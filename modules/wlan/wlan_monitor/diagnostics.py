"""Read-only WLAN diagnostic queries and normalized metrics."""

from dataclasses import asdict
import re
import time

from .huawei import QueryError, mac_id, parse_aps, parse_offline, query_device


AIR_FIELDS = {
    "Wireless noise(dBm)": ("noise", "底噪", "dBm"),
    "Wireless port up rate(Kbps)": ("up", "射频上行流量", "kbps"),
    "Wireless port down rate(Kbps)": ("down", "射频下行流量", "kbps"),
    "Wireless channel utilization(%)": ("cu", "信道利用率", "%"),
    "Wireless PER(%)": ("per", "报文错误率", "%"),
}
STA_FIELDS = {
    "The upstream SNR(dB)": ("snr", "上行信噪比", "dB"),
    "The upstream aggregate receive power(dBm)": ("power", "上行接收功率", "dBm"),
    "Station's RSSI(dBm)": ("rssi", "关联 RSSI", "dBm"),
    "Station's Noise(dBm)": ("noise", "底噪", "dBm"),
    "Station connect rate(Mbps)": ("link_rate", "关联速率", "Mbps"),
    "Station online time(ddd:hh:mm:ss)": ("online_time", "在线时长（天:时:分:秒）", ""),
}
TRAFFIC_FIELDS = {
    "Packets sent to the station": ("tx_packets", "AP 发给终端的报文", "包"),
    "Packets received from the station": ("rx_packets", "AP 收到的终端报文", "包"),
    "Bytes sent to the station": ("tx_bytes", "AP 发给终端的累计流量", "B"),
    "Bytes received from the station": ("rx_bytes", "AP 收到的终端累计流量", "B"),
    "Wireless data rate sent to the station(kbps)": ("tx_rate", "发给终端的实际速率", "kbps"),
    "Wireless data rate received from the station(kbps)": ("rx_rate", "收到的终端实际速率", "kbps"),
    "Trigger roam total": ("roam_total", "漫游触发", "次"),
    "Trigger roam failed": ("roam_failed", "漫游触发失败", "次"),
}


def parse_metrics(output, schema, command):
    def normalized(key):
        return re.sub(r"\s+", "", key).lower()

    aliases = {normalized(key): field for key, field in schema.items()}
    metrics = {}
    for line in output.splitlines():
        # Colons in the unit label (ddd:hh:mm:ss) aren't separators.
        row = re.match(r"^\s*((?:[^:()]|\([^)]*\))+)\s*:\s*(.*?)\s*$", line)
        if not row or normalized(row[1]) not in aliases:
            continue
        key, label, unit = aliases[normalized(row[1])]
        value = row[2].split(" //", 1)[0].strip()
        if key == "online_time":
            value = value if re.fullmatch(r"\d+:\d{2}:\d{2}:\d{2}", value) else None
        elif re.fullmatch(r"-?\d+(?:\.\d+)?%?", value):
            numeric = value.removesuffix("%")
            value = float(numeric) if "." in numeric else int(numeric)
            if unit == "%" and not 0 <= value <= 100:
                value = None
        else:
            value = None
        metrics[key] = {"key": key, "label": label, "unit": unit, "value": value}
    if not metrics:
        raise QueryError(f"{command} 未返回可识别指标，请检查权限和设备回显")
    return list(metrics.values())


def _section(query, command, parse, *, field="metrics"):
    try:
        return {field: parse(query(command)), "error": ""}
    except ValueError as exc:
        return {field: [], "error": str(exc)}
    except Exception as exc:
        return {field: [], "error": f"{command} 查询失败（{type(exc).__name__}）"}


def air(device, password, ap_mac, radio_id):
    ap_mac = mac_id(ap_mac)
    if type(radio_id) is not int or not 0 <= radio_id <= 15:
        raise ValueError("射频 ID 无效")

    def read(query):
        aps = parse_aps(query("display ap all"))
        ap = next((item for item in aps if item.mac == ap_mac and item.active), None)
        if ap is None:
            raise QueryError("这台 AP 当前未在此 AC 服务，请刷新后重试")
        command = f"display ap traffic statistics wireless ap-id {ap.id} radio {radio_id}"
        return _section(query, command, lambda output: parse_metrics(output, AIR_FIELDS, command))

    return {"at": int(time.time()), **query_device(device, read, password=password, interactive=True)}


def station(device, password, mac):
    mac = mac_id(mac)

    def read(query):
        info = f"display station sta-mac {mac}"
        traffic = f"display station statistics sta-mac {mac}"
        return {
            "info": _section(query, info, lambda output: parse_metrics(output, STA_FIELDS, info)),
            "traffic": _section(query, traffic, lambda output: parse_metrics(output, TRAFFIC_FIELDS, traffic)),
        }

    return {"at": int(time.time()), **query_device(device, read, password=password, interactive=True)}


def station_offline(device, password, mac):
    mac = mac_id(mac)
    command = f"display station offline-record sta-mac {mac}"
    result = query_device(
        device, lambda query: _section(query, command, lambda output: parse_offline(output, mac), field="events"),
        password=password, interactive=True,
    )
    return {"ac": device["name"], "error": result["error"], "events": [asdict(event) for event in result["events"]]}
