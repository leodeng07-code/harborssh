import re
from ipaddress import ip_address


def _fields(output):
    if re.search(r"----\s*More\s*----", output, re.I):
        return {}
    fields = {}
    key = None
    for line in output.splitlines():
        label, colon, value = line.partition(":")
        if colon:
            key = " ".join(label.lower().split())
            fields[key] = value.strip()
        elif key == "group backup modules" and re.fullmatch(r"\s+[\w][\w, -]*", line):
            fields[key] += "," + line.strip()
        else:
            key = None
    return fields


def _number(value):
    return int(value) if re.fullmatch(r"[0-9]{1,4}", value or "") else None


def _address(value):
    try:
        address = ip_address(value)
    except ValueError:
        return None
    return str(address) if not address.is_unspecified else None


def parse_group(output):
    fields = _fields(output)
    group = _number(fields.get("hsb-group id"))
    if group is None or not fields.get("group status"):
        return None
    return {
        "id": group,
        "vrid": _number(fields.get("vrrp group id")),
        "interface": fields.get("vrrp interface"),
        "vrrp": fields.get("group vrrp status"),
        "state": fields["group status"],
        "process": fields.get("group backup process"),
        "service_index": _number(fields.get("service index")),
        "backs_up_ap": "ap" in re.split(r"[,\s]+", fields.get("group backup modules", "").lower()),
    }


def parse_service(output):
    fields = _fields(output)
    if not fields.get("service state"):
        return None
    return {
        "state": fields["service state"],
        "peer": _address(fields.get("peer ip address")),
    }


def parse_protect(output):
    fields = _fields(output)
    state = fields.get("protect state", "").lower()
    if state not in {"enable", "disable"}:
        return None
    return {
        "enabled": state == "enable",
        "peers": [address for key in ("protect ac ipv4", "protect ac", "protect ac ipv6")
                  if (address := _address(fields.get(key)))],
        "priority": _number(fields.get("priority")),
    }


def read_ha(query):
    result = {"unread": []}
    for key, command, parser in (
        ("protect", "display ac protect", parse_protect),
        ("group", "display hsb-group 0", parse_group),
        ("service", "display hsb-service", parse_service),
    ):
        if key == "service":
            index = (result.get("group") or {}).get("service_index")
            command += f" {index if index is not None else 0}"
        try:
            output = query(command, timeout=8)
        except Exception:
            result["unread"].append(f"{command} 未完成，已结束本轮主备查询")
            break
        parsed = parser(output)
        if parsed is None:
            result["unread"].append(f"{command} 无可识别状态")
            continue
        result[key] = parsed
    return result


def summarize_ha(ha, aps):
    ha = dict(ha or {})
    if aps is None:
        active = standby = other = None
    else:
        active = sum(ap.active for ap in aps)
        standby = sum(ap.state in {"stdby", "standby"} for ap in aps)
        other = len(aps) - active - standby
    group = ha.get("group") or {}
    vrrp = (group.get("vrrp") or "").lower()
    state = (group.get("state") or "").lower()
    dual_link = (ha.get("protect") or {}).get("enabled")
    mode, role = "unknown", "unknown"
    if group.get("backs_up_ap") and (group.get("vrid") is not None or vrrp in {"master", "backup", "initialize"}):
        mode = "vrrp"
        role = {
            ("master", "active"): "primary",
            ("backup", "inactive"): "standby",
        }.get((vrrp, state), "switching" if state == "switching" else "unknown")
    elif dual_link or standby:
        mode = "dual_link" if dual_link else "ap_state"
        if active and standby:
            role = "mixed"
        elif standby:
            role = "standby_link"
        elif active:
            role = "primary_link"
    return dict(ha, mode=mode, role=role, active=active, standby=standby, other=other)
