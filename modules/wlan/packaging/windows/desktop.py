"""Local service behind the Windows desktop window."""

import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
from http.cookies import CookieError, SimpleCookie
from http.server import ThreadingHTTPServer
import ipaddress
import json
import msvcrt
import os
from pathlib import Path
import re
from secrets import compare_digest, token_urlsafe
import socket
import sys
from tempfile import TemporaryDirectory
import threading
import time
from urllib.parse import parse_qs, urlsplit

from paramiko import HostKeys, SSHException, Transport

from secrets_dpapi import protect, unprotect
from wlan_monitor import diagnostics
from wlan_monitor.__main__ import collect_loop, make_handler, parse_config
from wlan_monitor.huawei import AUTH_REJECTED, QueryError
from wlan_monitor.store import Store


ASSETS = Path(__file__).with_name("gui")
DEVICE_FIELDS = ("name", "host", "port", "username")
HOST = re.compile(r"[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9.])?")


def device_settings(raw):
    if not isinstance(raw, list) or not 1 <= len(raw) <= 2:
        raise ValueError("请选择一台或两台 AC")
    devices = []
    for index, entry in enumerate(raw, 1):
        if not isinstance(entry, dict):
            raise ValueError(f"第 {index} 台 AC 的配置格式有误")
        device = {}
        for field in ("name", "host", "username"):
            value = entry.get(field)
            if not isinstance(value, str) or not value.strip() or len(value) > 253 or not value.isprintable():
                raise ValueError(f"请填写第 {index} 台 AC 的名称、管理地址和 SSH 用户名")
            device[field] = value.strip()
        host = device["host"]
        try:
            device["host"] = str(ipaddress.ip_address(host))
            if "%" in host:
                raise ValueError
        except ValueError:
            if not HOST.fullmatch(host):
                raise ValueError(f"第 {index} 台 AC 的管理地址格式有误") from None
            device["host"] = host.lower()
        port = entry.get("port", 22)
        if type(port) is not int or not 1 <= port <= 65535:
            raise ValueError(f"第 {index} 台 AC 的 SSH 端口须在 1 到 65535 之间")
        device["port"] = port
        devices.append(device)
    if len({device["name"] for device in devices}) != len(devices):
        raise ValueError("两台 AC 的显示名称需要不同")
    if len({host_id(device) for device in devices}) != len(devices):
        raise ValueError("两台 AC 的管理地址和 SSH 端口不能相同")
    return devices


def host_id(device):
    return device["host"] if device["port"] == 22 else f"[{device['host']}]:{device['port']}"


def matches_account(device, previous):
    return host_id(device) == host_id(previous) and device["username"] == previous["username"]


def probe(device, old, legacy_hosts):
    address = host_id(device)
    if address in old:
        return old[address], None
    try:
        with socket.create_connection((device["host"], device["port"]), timeout=8) as connection:
            with Transport(connection) as transport:
                transport.start_client(timeout=8)
                key = transport.get_remote_server_key()
    except (OSError, SSHException):
        raise ValueError(f"{device['name']} 的 SSH 指纹读取失败，请检查管理网和 SSH 端口") from None
    pin = f"{key.get_name()} {key.get_base64()}"
    for path in legacy_hosts:
        known = HostKeys()
        try:
            known.load(str(path))
            if known.check(address, key):
                return pin, None
        except (OSError, SSHException, ValueError):
            continue
    fingerprint = base64.b64encode(hashlib.sha256(key.asbytes()).digest()).decode("ascii").rstrip("=")
    return pin, {"name": device["name"], "address": address, "algorithm": key.get_name(), "sha256": "SHA256:" + fingerprint}


class Desktop:
    def __init__(self, directory, temp):
        self.directory = directory
        self.path = directory / "desktop.json"
        self.known_hosts = temp / "known_hosts"
        self.store = Store(directory / "wlan.sqlite")
        self.lock = threading.RLock()
        self.diagnostic_lock = threading.Lock()
        self.pending = None
        self.worker = None
        self.stop_event = threading.Event()
        self.error = ""
        self.settings = {}
        self.legacy_hosts = [Path.home() / ".ssh" / "known_hosts"]
        legacy = directory / "config.json"
        source = self.path if self.path.exists() else legacy
        if source.exists():
            try:
                settings = json.loads(source.read_text(encoding="utf-8-sig"))
                ac = settings["ac"]
                valid = device_settings(ac)
                if source == legacy:
                    for original in ac:
                        if original.get("known_hosts"):
                            path = Path(original["known_hosts"]).expanduser()
                            self.legacy_hosts.append(directory / path)
                else:
                    for original, device in zip(ac, valid):
                        for field in ("host_key", "password_dpapi"):
                            if isinstance(original.get(field), str):
                                device[field] = original[field]
                self.settings = {key: settings[key] for key in (
                    "policy", "interval_seconds", "interval_unit", "history_days", "locations",
                ) if key in settings}
                self.settings["ac"] = valid
            except (OSError, ValueError, KeyError, TypeError):
                self.error = "无法读取或解密旧设置，请在采集设置中重新保存账号。"

    def state(self):
        with self.lock:
            running = self.worker is not None and self.worker.is_alive()
            return {
                "state": "stopping" if running and self.stop_event.is_set() else "running" if running else "stopped",
                "error": self.error,
                "intervalSeconds": self.settings.get("interval_seconds", 300),
                "intervalUnit": self.settings.get("interval_unit"),
                "devices": [
                    {**{field: d.get(field) for field in DEVICE_FIELDS}, "saved": bool(d.get("password_dpapi"))}
                    for d in self.settings.get("ac", []) if isinstance(d, dict)
                ],
            }

    def ready(self):
        devices = self.settings.get("ac", [])
        return bool(devices) and all(d.get("password_dpapi") and d.get("host_key") for d in devices)

    def start_if_configured(self):
        if self.ready():
            try:
                self.start()
            except ValueError as exc:
                self.error = str(exc)
            except (OSError, TypeError, KeyError):
                self.error = "无法恢复上次采集，请在设置中检查当前 Windows 用户的配置。"

    def collector_config(self, settings):
        return parse_config({
            **settings,
            "ac": [
                {
                    **{key: d[key] for key in DEVICE_FIELDS},
                    "password_env": "WLAN_DESKTOP_PASSWORD",
                    "known_hosts": str(self.known_hosts),
                    "pinned_hosts": True,
                }
                for d in settings["ac"]
            ],
        })

    def start(self):
        with self.lock:
            if self.state()["state"] == "running":
                return
            if self.state()["state"] == "stopping":
                raise ValueError("正在结束本轮采集，请稍后重试")
            if self.diagnostic_lock.locked():
                raise ValueError("请等待本次诊断结束后再恢复采集")
            if not self.ready():
                raise ValueError("请先保存 AC 账号与 SSH 指纹")
            devices = self.settings["ac"]
            try:
                passwords = {d["name"]: unprotect(d["password_dpapi"]) for d in devices}
            except (OSError, ValueError):
                raise ValueError("当前 Windows 用户无法解密已保存密码，请重新输入并保存") from None

            self.known_hosts.write_text(
                "".join(f"{host_id(d)} {d['host_key']}\n" for d in devices), encoding="ascii",
            )
            targets, policy, interval, days, locations = self.collector_config(self.settings)
            self.store.locations = locations
            self.stop_event = threading.Event()
            self.worker = threading.Thread(
                target=collect_loop, args=(self.store, (targets, policy, interval, days), self.stop_event, passwords),
                kwargs={"pause_on_auth": True}, daemon=True,
            )
            self.error = ""
            self.worker.start()

    def stop(self):
        with self.lock:
            self.stop_event.set()

    def require_stopped(self):
        if self.state()["state"] != "stopped":
            raise ValueError("请先暂停采集并等待本轮结束，再修改设置")
        if self.diagnostic_lock.locked():
            raise ValueError("请等待本次诊断结束后再修改设置")

    def diagnose(self, request):
        with self.lock:
            if not self.ready():
                raise ValueError("请先保存 AC 的 SSH 账号和指纹")
            if not self.diagnostic_lock.acquire(blocking=False):
                raise ValueError("已有诊断正在查询，请稍后重试")
        try:
            with self.lock:
                targets, _, _, _, _ = self.collector_config(self.settings)
                passwords = {d["name"]: unprotect(d["password_dpapi"]) for d in self.settings["ac"]}
                if not self.known_hosts.exists():
                    self.known_hosts.write_text(
                        "".join(f"{host_id(d)} {d['host_key']}\n" for d in self.settings["ac"]), encoding="ascii",
                    )
            kind = request.get("kind")
            mac = request.get("mac")
            if not isinstance(mac, str):
                raise ValueError("请输入有效的 MAC 地址")
            if kind == "offline":
                def read_events(device):
                    name = device["name"]
                    try:
                        return diagnostics.station_offline(device, passwords[name], mac)
                    except QueryError as exc:
                        return {"ac": name, "events": [], "error": str(exc)}
                with ThreadPoolExecutor(max_workers=2) as pool:
                    results = list(pool.map(read_events, targets))
                if any(result["error"] == AUTH_REJECTED for result in results):
                    self.stop()
                self.store.record_station_events(results)
                return {"sources": results, "events": self.store.events(mac)}
            if kind == "air":
                item = self.store.read(mac)
                if item is None or item["ap"]["quality"] in {"inactive", "conflict"}:
                    raise ValueError("本轮没有明确的服务 AC，请刷新 AP 状态后重试")
                ac = item["ap"]["ac"]
                radio = request.get("radio")
                if radio not in {r["radio_id"] for r in item["ap"]["radios"]}:
                    raise ValueError("请从本轮已知的射频列表中选择")
            elif kind == "station":
                ac = self.store.station_source(mac)
            else:
                raise ValueError("未知的诊断类型")
            device = next((d for d in targets if d["name"] == ac), None)
            if not device:
                raise ValueError("本轮没有该目标的明确关联记录，请刷新后重试")
            if kind == "air":
                return diagnostics.air(device, passwords[ac], mac, radio)
            return diagnostics.station(device, passwords[ac], mac)
        except QueryError as exc:
            if str(exc) == AUTH_REJECTED:
                self.stop()
            raise
        finally:
            self.diagnostic_lock.release()

    def prepare(self, raw, *, recheck=False):
        devices = device_settings(raw)
        with self.lock:
            self.require_stopped()
            old = {} if recheck else {host_id(d): d["host_key"] for d in self.settings.get("ac", []) if d.get("host_key")}
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda device: probe(device, old, self.legacy_hosts), devices))
        with self.lock:
            self.require_stopped()
            ticket = token_urlsafe(24)
            self.pending = (ticket, time.monotonic() + 180, devices, results)
            return {"ticket": ticket, "fingerprints": [item for _, item in results if item]}

    def save(self, request):
        with self.lock:
            self.require_stopped()
            if not self.pending:
                raise ValueError("验证已失效，请重新保存设置")
            ticket, expiry, devices, results = self.pending
            if request.get("ticket") != ticket or time.monotonic() > expiry:
                raise ValueError("验证已失效，请重新保存设置")
            if any(item for _, item in results) and request.get("trusted") is not True:
                raise ValueError("请先核对并确认 SSH 主机指纹")
            passwords = request.get("passwords")
            if not isinstance(passwords, list) or len(passwords) != len(devices):
                raise ValueError("请输入每台 AC 的 SSH 密码")
            next_devices = []
            for device, password, (pin, _) in zip(devices, passwords, results):
                if not isinstance(password, str) or len(password) > 1024:
                    raise ValueError(f"{device['name']} 的密码格式有误")
                previous = next((d for d in self.settings.get("ac", []) if matches_account(device, d)), {})
                encrypted = protect(password) if password else previous.get("password_dpapi")
                if not encrypted:
                    raise ValueError(f"请输入 {device['name']} 的 SSH 密码")
                next_devices.append({**device, "host_key": pin, "password_dpapi": encrypted})
            settings = {**self.settings, "ac": next_devices}
            if "interval_seconds" in request:
                unit = request.get("interval_unit")
                interval = request["interval_seconds"]
                if unit not in ("seconds", "minutes") or (unit == "minutes" and (type(interval) is not int or interval % 60)):
                    raise ValueError("请选择秒或整分钟作为采样周期")
                settings.update(interval_seconds=interval, interval_unit=unit)
            self.collector_config(settings)
            temp = self.path.with_suffix(".tmp")
            try:
                temp.write_text(json.dumps(settings, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                temp.replace(self.path)
            finally:
                temp.unlink(missing_ok=True)
            self.pending = None
            self.settings = settings
            self.start()


def make_desktop_handler(desktop, secret):
    base = make_handler(desktop.store, False)
    cookie_name = "wlan_" + secret[:8]
    assets = {
        "/settings": ("settings.html", "text/html; charset=utf-8"),
        "/settings.js": ("settings.js", "text/javascript; charset=utf-8"),
        "/settings.css": ("settings.css", "text/css; charset=utf-8"),
    }

    class Handler(base):
        def host(self):
            return f"127.0.0.1:{self.server.server_port}"

        def authenticated(self):
            if self.headers.get("Host") != self.host():
                return False
            try:
                cookie = SimpleCookie(self.headers.get("Cookie", "")).get(cookie_name)
            except CookieError:
                return False
            return cookie is not None and compare_digest(cookie.value.encode(), secret.encode())

        def do_GET(self):
            url = urlsplit(self.path)
            if self.headers.get("Host") == self.host() and url.path == "/open":
                key = parse_qs(url.query).get("token", [""])[0]
                if compare_digest(key.encode(), secret.encode()):
                    self.send_response(303)
                    self.send_header("Set-Cookie", f"{cookie_name}={secret}; HttpOnly; SameSite=Strict; Path=/")
                    self.send_header("Location", "/" if desktop.state()["state"] == "running" else "/settings")
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Referrer-Policy", "no-referrer")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
            if not self.authenticated():
                self.json({"error": "请从桌面应用重新打开窗口"}, 403)
                return
            if url.path in assets:
                filename, content_type = assets[url.path]
                self.respond((ASSETS / filename).read_bytes(), content_type)
            elif url.path == "/api/desktop":
                self.json(desktop.state())
            elif url.path == "/api/dashboard":
                state = desktop.state()
                self.json({"demo": False, "desktop": state["state"], "intervalSeconds": state["intervalSeconds"],
                           "diagnostics": desktop.ready(), "snapshot": desktop.store.read()})
            else:
                super().do_GET()

        def do_POST(self):
            if (not self.authenticated() or self.headers.get("Origin") != "http://" + self.host()
                    or self.headers.get_content_type() != "application/json"):
                self.json({"error": "无效的本机请求"}, 403)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 16384:
                    raise ValueError("请求大小无效")
                request = json.loads(self.rfile.read(length))
                if not isinstance(request, dict):
                    raise ValueError("请求格式无效")
                if self.path == "/api/diagnostics":
                    self.json(desktop.diagnose(request))
                    return
                if self.path == "/api/desktop/prepare":
                    self.json(desktop.prepare(request.get("devices"), recheck=request.get("recheck") is True))
                    return
                if self.path == "/api/desktop/save":
                    desktop.save(request)
                elif self.path == "/api/desktop/start":
                    desktop.start()
                elif self.path == "/api/desktop/stop":
                    desktop.stop()
                else:
                    self.json({"error": "找不到操作"}, 404)
                    return
                self.json(desktop.state())
            except (ValueError, TypeError, KeyError) as exc:
                self.json({"error": str(exc)}, 400)
            except OSError:
                self.json({"error": "Windows 无法加密或写入配置，请确认当前账号有权访问本机配置目录"}, 500)

    return Handler


def main():
    local = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    directory = local / "WlanMonitor"
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / "collector.lock").open("ab") as lock, TemporaryDirectory(prefix="wlan-desktop-") as temp:
        lock.seek(0)
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            print("无线采集服务已打开，请先关闭另一个无线监测窗口。", file=sys.stderr, flush=True)
            return
        desktop = Desktop(directory, Path(temp))
        secret = token_urlsafe(32)
        with ThreadingHTTPServer(("127.0.0.1", 0), make_desktop_handler(desktop, secret)) as server:
            def watch_parent():
                sys.stdin.buffer.read()
                desktop.stop()
                server.shutdown()

            threading.Thread(target=watch_parent, daemon=True).start()
            print(f"http://127.0.0.1:{server.server_port}/open?token={secret}", flush=True)
            desktop.start_if_configured()
            server.serve_forever()


if __name__ == "__main__":
    main()
