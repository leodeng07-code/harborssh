from dataclasses import dataclass
import os
from pathlib import Path
import re
import threading

from .ha import read_ha, summarize_ha


MAC = r"(?:[0-9a-f]{4}(?:-[0-9a-f]{4}){2}|[0-9a-f]{2}(?::[0-9a-f]{2}){5})"
TOTAL = re.compile(r"^\s*Total\s*:\s*(\d+)\b", re.MULTILINE | re.IGNORECASE)
USER_PROMPT = r"^[ \t]*<[^<>\r\n]+>[ \t]*\r?$"
AUTH_REJECTED = "SSH 账号或密码验证失败"
STA_HEADER = re.compile(r"^\s*STA MAC\s+AP ID\s+AP name\b.*$", re.MULTILINE | re.IGNORECASE)
AP_HEADER = re.compile(r"^\s*ID\s+MAC\s+Name\s+Group\s+IP\s+Type\s+State\b.*$", re.MULTILINE | re.IGNORECASE)
RADIO_HEADER = re.compile(
    r"^[ \t]*AP ID[ \t]+(?:AP )?Name[ \t]+RfID[ \t]+Band[ \t]+Type[ \t]+"
    r"(?:Status|ST)[ \t]+CH/BW[ \t]+CE/ME[ \t]+STA[ \t]+CU\b.*$",
    re.MULTILINE | re.IGNORECASE,
)
RADIO_ROW = re.compile(
    r"(?P<ap_id>[0-9]+)\s+.+?\s+(?P<radio_id>[0-9]+)\s+(?P<band>[0-9]+(?:\.[0-9]+)?G|-)\s+"
    r"\S+\s+(?P<status>\S+)\s+(?P<channel>\S+)\s+\S+\s+(?:[0-9]+|-)\s+(?P<cu>\S+)(?:\s+.*)?",
    re.IGNORECASE,
)
AP_ROW = re.compile(
    rf"(?P<id>[0-9]+)\s+(?P<mac>{MAC})\s+(?P<name>.+?)\s+(?P<group>\S+)\s+"
    r"(?:[0-9]{1,3}(?:\.[0-9]{1,3}){3}|[0-9a-f:.]*:[0-9a-f:.]*(?:%[\w.-]+)?|-)"
    r"\s+\S+\s+(?P<state>\S+)\s+(?:[0-9]+|-)\s+\S+(?:\s+.*)?",
    re.IGNORECASE,
)
STA_PREFIX = re.compile(
    rf"(?P<mac>{MAC})\s+(?P<ap_id>[0-9]+)\s+.+?\s+(?P<radio_id>[0-9]+)/[0-9]+"
    r"\s+(?P<band>[0-9]+(?:\.[0-9]+)?G|-)\s+",
    re.IGNORECASE,
)


def mac_id(value):
    if not re.fullmatch(MAC, value, re.IGNORECASE):
        raise ValueError("MAC 格式无效")
    compact = re.sub(r"[:-]", "", value.lower())
    return "-".join(compact[i:i + 4] for i in range(0, 12, 4))


@dataclass(frozen=True)
class AP:
    id: int
    mac: str
    name: str
    group: str
    state: str

    @property
    def active(self):
        return self.state in {"nor", "normal"}


@dataclass(frozen=True)
class Station:
    mac: str
    ap_id: int
    radio_id: int
    band: str
    rates: str
    rssi: int | None
    ssid: str
    status: str = ""


@dataclass(frozen=True)
class Radio:
    ap_id: int
    radio_id: int
    band: str
    channel: str
    cu: int | None


@dataclass(frozen=True)
class OfflineRecord:
    mac: str
    device_time: str
    reason: str
    ap_name: str = ""


@dataclass
class Snapshot:
    name: str
    aps: list[AP]
    stations: list[Station]
    radios: list[Radio]
    error: str = ""
    radio_error: str = ""
    offline: list[OfflineRecord] | None = None
    offline_error: str = ""
    ha: dict | None = None


def table(output, header_pattern, command, allow_empty_without_total=False):
    if re.search(r"----\s*More\s*----", output, re.IGNORECASE):
        raise ValueError(f"{command} 回显仍有分页，请检查临时关闭分页的权限")
    header = header_pattern.search(output)
    totals = list(TOTAL.finditer(output))
    if not header:
        if len(totals) == 1 and int(totals[0][1]) == 0:
            return "", []
        raise ValueError(f"{command} 表头与预期格式不符")
    total = totals[-1] if totals else None
    end = total.start() if total and total.start() > header.end() else len(output)
    body = output[header.end():end]
    lines = [
        line.strip() for line in body.splitlines()
        if line.strip() and not re.fullmatch(r"\s*-+\s*", line) and not re.fullmatch(USER_PROMPT, line)
    ]
    if total is None:
        if allow_empty_without_total and not lines and re.search(r"^[ \t]*-{8,}", body, re.MULTILINE):
            return header[0], []
        raise ValueError(f"{command} 缺少 Total 行，请检查命令权限或回显是否完整")
    if len(lines) != int(total[1]):
        raise ValueError(f"{command} 回显有 {len(lines)} 行，Total 为 {total[1]}，请检查截断或折行")
    return header[0], lines


def parse_aps(output):
    _, lines = table(output, AP_HEADER, "display ap all")
    aps = []
    for index, line in enumerate(lines, 1):
        row = AP_ROW.fullmatch(line)
        if not row:
            raise ValueError(f"display ap all 第 {index} 行的 AP 字段格式不符")
        aps.append(AP(int(row["id"]), mac_id(row["mac"]), row["name"], row["group"], row["state"].lower()))
    if len({ap.id for ap in aps}) != len(aps) or len({ap.mac for ap in aps}) != len(aps):
        raise ValueError("display ap all 出现重复的 AP ID 或 MAC")
    return aps


def parse_stations(output, allow_empty_without_total=False):
    header, lines = table(output, STA_HEADER, "display station all", allow_empty_without_total)
    if not lines:
        return []
    layout = re.split(r"\bSSID\b", header, maxsplit=1, flags=re.I)
    if len(layout) != 2:
        raise ValueError("display station all 表头缺少 SSID")
    before, after = layout
    ip_columns = 2 if re.search(r"\bIPv6\b", before, re.I) else 1
    suffix_columns = re.findall(r"IPv6 address|Online time|Status", after, re.I)
    if re.sub(r"IPv6 address|Online time|Status", "", after, flags=re.I).strip():
        raise ValueError("display station all 的 SSID 后有未知列")
    stations = []
    for index, line in enumerate(lines, 1):
        # The AP name may contain spaces. Rf/WLAN and Band anchor the following fields.
        prefix = STA_PREFIX.match(line)
        if not prefix:
            raise ValueError(f"display station all 第 {index} 行的 MAC、AP ID、Rf/WLAN 或频段格式不符")
        # Keep spaces in the SSID while removing known suffix columns.
        fields = line[prefix.end():].split(maxsplit=4 + ip_columns)
        if len(fields) != 5 + ip_columns:
            raise ValueError(f"display station all 第 {index} 行字段不足")
        _, rates, raw_rssi, _ = fields[:4]
        if not re.fullmatch(r"(?:-?\d+|-|N/A|--)", raw_rssi, re.I):
            raise ValueError(f"display station all 第 {index} 行的 RSSI 格式不符")
        rssi = int(raw_rssi) if re.fullmatch(r"-?\d+", raw_rssi) else None
        if rssi is not None and not -127 <= rssi < 0:
            rssi = None
        tail = fields[-1].rsplit(maxsplit=len(suffix_columns))
        if len(tail) != 1 + len(suffix_columns):
            raise ValueError(f"display station all 第 {index} 行缺少 SSID 或附加列")
        ssid = tail[0]
        status = next((value for col, value in zip(suffix_columns, tail[1:]) if col.lower() == "status"), "")
        stations.append(Station(
            mac_id(prefix["mac"]), int(prefix["ap_id"]), int(prefix["radio_id"]),
            prefix["band"], rates, rssi, ssid, status,
        ))
    return stations


def parse_radios(output):
    _, lines = table(output, RADIO_HEADER, "display radio all")
    radios = []
    for index, line in enumerate(lines, 1):
        # Some AC releases append interference and working-mode fields after CU.
        row = RADIO_ROW.fullmatch(line)
        if not row:
            raise ValueError(f"display radio all 第 {index} 行字段格式不符")
        if row["status"].lower() != "on":
            continue
        raw_cu = row["cu"]
        cu = int(raw_cu[:-1]) if re.fullmatch(r"\d{1,3}%", raw_cu) else None
        if cu is not None and cu > 100:
            cu = None
        radios.append(Radio(int(row["ap_id"]), int(row["radio_id"]), row["band"], row["channel"], cu))
    if len({(r.ap_id, r.radio_id) for r in radios}) != len(radios):
        raise ValueError("display radio all 出现重复射频")
    return radios


def validate_station_aps(aps, stations):
    ap_ids = {ap.id for ap in aps}
    if any(station.ap_id not in ap_ids for station in stations):
        raise ValueError("终端表含 AP 清单中不存在的 ID，可能正在切换，请核对下一轮")


class QueryError(ValueError):
    pass


class InteractiveLoginRequired(Exception):
    pass


_DEVICE_LOCKS = {}
_DEVICE_LOCKS_GUARD = threading.Lock()


def query_device(device, operation, *, password=None, interactive=False):
    key = (device["host"], device.get("port", 22))
    with _DEVICE_LOCKS_GUARD:
        lock = _DEVICE_LOCKS.setdefault(key, threading.Lock())
    if not lock.acquire(blocking=not interactive):
        raise QueryError("该 AC 正在采样，请稍后重试")
    try:
        return _query_session(device, operation, password=password, read_timeout=12 if interactive else 35)
    finally:
        lock.release()


def _query_session(device, operation, *, password, read_timeout):
    if password is None and device.get("password_env"):
        password = os.getenv(device["password_env"])
    if device.get("password_env") and not password:
        raise QueryError("采集密码环境变量未设置")
    key_file = str(Path(device["key_file"]).expanduser()) if device.get("key_file") else None
    if key_file and not Path(key_file).is_file():
        raise QueryError("SSH 私钥文件不存在")
    try:
        from netmiko.exceptions import NetmikoAuthenticationException, NetmikoTimeoutException
        from netmiko.huawei import HuaweiSSH
    except ImportError:
        raise QueryError("请先安装 requirements.txt 中的 SSH 依赖") from None

    class ReadOnlyHuaweiSSH(HuaweiSSH):
        def special_login_handler(self):
            # The stock driver may confirm a security prompt and save configuration.
            prompts = rf"{USER_PROMPT}|{self.password_change_prompt}|security\s+risks\s+in\s+the\s+configuration"
            response = self.read_until_pattern(pattern=prompts, re_flags=re.MULTILINE | re.I, read_timeout=10)
            if not re.search(USER_PROMPT, response, re.MULTILINE):
                raise InteractiveLoginRequired

        def cleanup(self, command=""):
            pass

    options = dict(
        device_type="huawei", host=device["host"], port=device.get("port", 22),
        username=device["username"], password=password, use_keys=bool(key_file),
        key_file=key_file, allow_agent=False, ssh_strict=True, system_host_keys=not device.get("pinned_hosts", False),
        conn_timeout=8, auth_timeout=10, banner_timeout=10,
    )
    if device.get("known_hosts"):
        options.update(alt_host_keys=True, alt_key_file=str(Path(device["known_hosts"]).expanduser()))

    try:
        with ReadOnlyHuaweiSSH(**options) as connection:
            prompt = connection.find_prompt()
            if not re.fullmatch(USER_PROMPT, prompt):
                raise InteractiveLoginRequired
            expect = rf"(?m)^{re.escape(prompt)}[ \t]*$"

            def query(command, *, timeout=read_timeout):
                return connection.send_command(command, expect_string=expect, read_timeout=timeout)

            return operation(query)
    except InteractiveLoginRequired:
        raise QueryError("AC 登录需要人工处理交互提示") from None
    except NetmikoAuthenticationException:
        raise QueryError(AUTH_REJECTED) from None
    except NetmikoTimeoutException as exc:
        reason = str(exc).lower()
        if "known_hosts" in reason or "host key for server" in reason:
            raise QueryError("SSH 主机密钥未登记或不匹配，请核对设备指纹") from None
        raise QueryError("SSH 连接或协商失败，请检查管理网、端口和 SSH 服务") from None
    except QueryError:
        raise
    except ValueError as exc:
        if str(exc).startswith(("display ", "终端表")):
            raise QueryError(str(exc)) from None
        raise QueryError("SSH 或采集参数有误") from None
    except Exception as exc:
        raise QueryError(f"SSH 或命令执行失败（{type(exc).__name__}）") from None


def collect(device, *, password=None):
    name = device["name"]

    def read_snapshot(query):
        result = Snapshot(name, [], [], [])
        aps = None
        try:
            aps = parse_aps(query("display ap all"))
            result.aps = aps
            result.stations = parse_stations(query("display station all"),
                                             allow_empty_without_total=not any(ap.active for ap in aps))
            validate_station_aps(aps, result.stations)
        except ValueError as exc:
            result.error = str(exc)
            result.ha = summarize_ha(read_ha(query), aps)
            return result

        ha = {"unread": ["SSH 命令执行中断，本轮未读取主备参数"]}
        try:
            try:
                result.radios = parse_radios(query("display radio all"))
            except ValueError as exc:
                result.radio_error = str(exc)
            except Exception as exc:
                result.radio_error = f"射频采集失败（{type(exc).__name__}）"
                result.offline_error = "射频命令执行失败，本轮未继续查询 AP 下线记录"
                return result
            try:
                result.offline = parse_offline(query("display ap offline-record all"))
            except ValueError as exc:
                result.offline_error = str(exc)
            except Exception as exc:
                result.offline_error = f"AP 下线记录采集失败（{type(exc).__name__}）"
                return result
            ha = read_ha(query)
        finally:
            result.ha = summarize_ha(ha, aps)
        return result

    try:
        return query_device(device, read_snapshot, password=password)
    except QueryError as exc:
        return Snapshot(name, [], [], [], error=str(exc))


_OFFLINE_TIME = r"[0-9]{4}-[0-9]{2}-[0-9]{2}[/ T][0-9]{2}:[0-9]{2}:[0-9]{2}(?:[+-][0-9]{2}:[0-9]{2}|Z)?"
_OFFLINE_TOTAL = re.compile(
    r"^[ \t]*(?:Total[ \t]+(?:stations|APs)[ \t]*:[ \t]*[0-9]+[ \t]+)?"
    r"Total[ \t]+records[ \t]*:[ \t]*(\d+)",
    re.I | re.M,
)


def parse_offline(output, station_mac=None):
    command = "display station offline-record" if station_mac else "display ap offline-record all"
    if re.search(r"----\s*More\s*----", output, re.I):
        raise ValueError(f"{command} 回显仍有分页，请检查临时关闭分页的权限")
    header = re.search(r"^[ \t]*(?:STA |AP )?MAC\s+.+?offline time\b.*$" if not station_mac else
                       r"^[ \t]*STA MAC\s+AP ID\s+AP name\b.*\b(?:Last record time|Last offline time)\b.*$",
                       output, re.M | re.I)
    total = _OFFLINE_TOTAL.search(output)
    if not total:
        raise ValueError(f"{command} 缺少完整的下线记录汇总")
    count = int(total[1])
    if not header:
        if count == 0:
            return []
        raise ValueError(f"{command} 表头与预期格式不符")
    leading = r"\s+[0-9]+\s+(?P<name>.+?)\s+(?:[0-9]+|-)/(?:[0-9]+|-)\s+" if station_mac else r"\s+"
    row_pattern = re.compile(rf"(?P<mac>{MAC}){leading}(?P<at>{_OFFLINE_TIME})(?:\s+(?P<reason>.*))?", re.I)
    rows = []
    for line in output[header.end():total.start()].splitlines():
        line = line.strip()
        if not line or re.fullmatch(r"-+|Reason", line, re.I):
            continue
        row = row_pattern.fullmatch(line)
        if row:
            mac = mac_id(row["mac"])
            if station_mac and mac != station_mac:
                raise ValueError(f"{command} 回显的终端 MAC 与查询不一致")
            rows.append((mac, row["at"].replace("/", " "), row.groupdict().get("name") or "", [row["reason"] or ""]))
        elif rows and not re.match(rf"{MAC}\s", line, re.I):
            rows[-1][-1].append(line)
        else:
            raise ValueError(f"{command} 记录格式不符")
    if len(rows) != count:
        raise ValueError(f"{command} 有 {len(rows)} 条记录，汇总为 {count}")
    return [OfflineRecord(mac, at, " ".join(piece for piece in parts if piece) or "—", name)
            for mac, at, name, parts in rows]
