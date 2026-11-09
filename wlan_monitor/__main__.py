import argparse
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import threading
import time
from urllib.parse import parse_qs, urlsplit
import webbrowser

from . import demo, huawei
from .store import Policy, Store


STATIC = Path(__file__).with_name("static")
DEFAULT_PORT = 8765
AC_WORKERS = 4


def load_config(path):
    return parse_config(json.loads(Path(path).read_text(encoding="utf-8-sig")))


def parse_config(config):
    devices = config["ac"]
    if not isinstance(devices, list) or not devices:
        raise ValueError("请配置至少一台 AC")
    for device in devices:
        if not all(isinstance(device.get(field), str) and device[field].strip() for field in ("name", "host", "username")):
            raise ValueError("每台 AC 都需要 name、host 和 username")
        if "password" in device or not (device.get("password_env") or device.get("key_file")):
            raise ValueError("请配置 password_env 或 key_file")
        port = device.get("port", 22)
        if type(port) is not int or not 1 <= port <= 65535:
            raise ValueError("AC 端口超出范围")
    if len({device["name"] for device in devices}) != len(devices):
        raise ValueError("AC 名称须唯一")
    interval = config.get("interval_seconds", 300)
    days = config.get("history_days", 30)
    if type(interval) is not int or not 15 <= interval <= 86400:
        raise ValueError("采样周期须在 15 秒到 24 小时之间")
    if type(days) is not int or days < 1:
        raise ValueError("保存期限须至少为 1 天")
    locations = {huawei.mac_id(mac): str(zone) for mac, zone in config.get("locations", {}).items()}
    return devices, Policy(**config.get("policy", {})), interval, days, locations


def collect_round(store, devices, policy, interval, days, *, passwords=None, stop_on_auth=None):
    passwords = passwords or {}
    with ThreadPoolExecutor(max_workers=AC_WORKERS) as pool:
        snapshots = list(pool.map(lambda device: huawei.collect(device, password=passwords.get(device["name"])), devices))
    if stop_on_auth is not None and any(s.error == huawei.AUTH_REJECTED for s in snapshots):
        stop_on_auth.set()
    store.record(int(time.time()), snapshots, policy, interval, days)
    for s in snapshots:
        status = s.error or f"{len(s.aps)} 台 AP，{len(s.stations)} 条终端记录"
        radio_status = f"；{s.radio_error}" if s.radio_error else ""
        print(f"{s.name} · {status}{radio_status}", flush=True)
    return not any(s.error for s in snapshots)


def collect_loop(store, config, stopped, passwords, *, pause_on_auth=False):
    while not stopped.is_set():
        started = time.monotonic()
        try:
            collect_round(store, *config, passwords=passwords, stop_on_auth=stopped if pause_on_auth else None)
        except (OSError, ValueError) as exc:
            print(f"采样未入库 · {exc}", flush=True)
        except Exception as exc:
            print(f"采样未入库 · {type(exc).__name__}", flush=True)
        # If a poll overruns its interval, wait a full interval before opening SSH again.
        remaining = started + config[2] - time.monotonic()
        stopped.wait(remaining if remaining > 0 else config[2])


def make_handler(store, demonstration):
    assets = {
        "/": ("index.html", "text/html; charset=utf-8"),
        "/app.js": ("app.js", "text/javascript; charset=utf-8"),
        "/styles.css": ("styles.css", "text/css; charset=utf-8"),
        "/theme.js": ("theme.js", "text/javascript; charset=utf-8"),
    }

    class Handler(BaseHTTPRequestHandler):
        def respond(self, data, content_type, status=200):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'; base-uri 'none'")
            self.end_headers()
            self.wfile.write(data)

        def json(self, data, status=200):
            self.respond(json.dumps(data, ensure_ascii=False).encode(), "application/json; charset=utf-8", status)

        def do_GET(self):
            # A browser can only access the local UI using its loopback origin.
            if self.headers.get("Host") != f"127.0.0.1:{self.server.server_port}":
                self.json({"error": "请使用本机 127.0.0.1 地址访问"}, 403)
                return
            url = urlsplit(self.path)
            if url.path in assets:
                filename, content_type = assets[url.path]
                self.respond((STATIC / filename).read_bytes(), content_type)
            elif url.path == "/api/dashboard":
                snapshot = store.read()
                if demonstration and snapshot:
                    snapshot["stale"] = False
                self.json({"demo": demonstration, "snapshot": snapshot})
            elif url.path == "/api/ap":
                query = parse_qs(url.query)
                try:
                    mac = huawei.mac_id(query.get("mac", [""])[0])
                except ValueError:
                    self.json({"error": "AP MAC 格式无效"}, 400)
                    return
                days = query.get("days", ["1"])[0]
                if days not in {"1", "7"}:
                    self.json({"error": "趋势范围支持 1 天或 7 天"}, 400)
                    return
                result = store.read(mac, history_days=int(days))
                if result is None:
                    self.json({"error": "本轮没有这台 AP 的数据"}, 404)
                else:
                    if demonstration:
                        result["stale"] = False
                    self.json(result)
            elif url.path == "/api/events":
                mac = parse_qs(url.query).get("mac", [None])[0]
                try:
                    self.json({"events": store.events(mac)})
                except ValueError:
                    self.json({"error": "MAC 格式无效"}, 400)
            else:
                self.json({"error": "找不到页面"}, 404)

        def log_message(self, format, *args):
            pass

    return Handler


def serve(store, port, config=None, *, open_browser=False, passwords=None):
    stopped = threading.Event()
    with ThreadingHTTPServer(("127.0.0.1", port), make_handler(store, config is None)) as server:
        if config:
            threading.Thread(target=collect_loop, args=(store, config, stopped, passwords), daemon=True).start()
        url = f"http://127.0.0.1:{server.server_port}/"
        print(f"打开 {url}   Ctrl+C 停止", flush=True)
        if open_browser:
            try:
                webbrowser.open(url)
            except OSError:
                pass
        try:
            server.serve_forever()
        finally:
            stopped.set()


def run_demo(port, *, open_browser=False):
    with TemporaryDirectory(prefix="wlan-monitor-") as directory:
        store = Store(Path(directory) / "demo.sqlite")
        demo.populate(store)
        serve(store, port, open_browser=open_browser)


def main():
    parser = argparse.ArgumentParser(description="园区无线信号监测")
    commands = parser.add_subparsers(dest="command", required=True)
    demo_cmd = commands.add_parser("demo", help="用隔离的模拟数据打开看板")
    demo_cmd.add_argument("--port", type=int, default=DEFAULT_PORT)
    for name, help_text in [("run", "持续采集并打开看板"), ("collect", "采集一轮以验证设备接入")]:
        live = commands.add_parser(name, help=help_text)
        live.add_argument("--config", default="config.json")
        live.add_argument("--db", default="data/wlan.sqlite")
        if name == "run":
            live.add_argument("--port", type=int, default=DEFAULT_PORT)
    check = commands.add_parser("check-output", help="在本机核对保存的设备回显")
    check.add_argument("--ap", required=True)
    check.add_argument("--station", required=True)
    check.add_argument("--radio")
    args = parser.parse_args()

    try:
        if args.command == "demo":
            run_demo(args.port)
            return 0
        if args.command == "check-output":
            aps = huawei.parse_aps(Path(args.ap).read_text(encoding="utf-8-sig"))
            stations = huawei.parse_stations(
                Path(args.station).read_text(encoding="utf-8-sig"),
                allow_empty_without_total=not any(ap.active for ap in aps),
            )
            huawei.validate_station_aps(aps, stations)
            print(f"解析成功 · {len(aps)} 台 AP · {len(stations)} 条终端 · {sum(s.rssi is not None for s in stations)} 条有效 RSSI")
            if args.radio:
                radios = huawei.parse_radios(Path(args.radio).read_text(encoding="utf-8-sig"))
                print(f"解析成功 · {len(radios)} 个已开启的射频")
            return 0

        devices, policy, interval, days, locations = load_config(args.config)
        store = Store(args.db, locations)
        config = (devices, policy, interval, days)
        if args.command == "collect":
            return 0 if collect_round(store, *config) else 1
        serve(store, args.port, config)
    except KeyboardInterrupt:
        return 0
    except (OSError, ValueError, KeyError, TypeError) as exc:
        parser.exit(1, f"无法运行 · {exc}\n")


if __name__ == "__main__":
    raise SystemExit(main())
