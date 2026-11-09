"""Assemble the portable Windows x64 ZIP from a host with Python, pip and Go."""

import argparse
import hashlib
from io import BytesIO
import os
from pathlib import Path
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory
from urllib.request import urlopen
from zipfile import ZipFile


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
PYTHON_VERSION = "3.14.10"
PYTHON_SHA256 = "90905e64a840557d8c1bc4f5b74db3d7ee85e3ffb217611cac1c7813acea4159"
WEBVIEW_SETUP = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"


def build_backend(bundle):
    runtime = bundle / "runtime"
    app = bundle / "app"
    runtime.mkdir(parents=True)
    app.mkdir()
    url = f"https://www.python.org/ftp/python/{PYTHON_VERSION}/python-{PYTHON_VERSION}-embed-amd64.zip"
    print(f"下载 Python.org Windows x64 嵌入运行时 {PYTHON_VERSION}", flush=True)
    with urlopen(url, timeout=45) as response:
        archive = response.read()
    if hashlib.sha256(archive).hexdigest() != PYTHON_SHA256:
        raise ValueError("Python 运行时的 SHA-256 校验失败")
    with ZipFile(BytesIO(archive)) as source:
        source.extractall(runtime)
    (runtime / "python314._pth").write_text("python314.zip\n.\n../app\n../app/vendor\n", encoding="ascii")

    subprocess.run([
        sys.executable, "-m", "pip", "install", "--disable-pip-version-check",
        "--platform", "win_amd64", "--python-version", "3.14", "--implementation", "cp",
        "--abi", "cp314", "--only-binary=:all:", "--no-compile", "--target", str(app / "vendor"),
        "-r", str(ROOT / "requirements.txt"),
    ], check=True)
    shutil.rmtree(app / "vendor" / "bin", ignore_errors=True)
    shutil.copytree(ROOT / "wlan_monitor", app / "wlan_monitor", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    for filename in ("desktop.py", "secrets_dpapi.py"):
        shutil.copy2(HERE / filename, app)
    shutil.copytree(HERE / "gui", app / "gui")


def build(destination, go):
    destination.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix="wlan-windows-") as work:
        bundle = Path(work) / "WlanMonitor"
        build_backend(bundle)
        shutil.copy2(ROOT / "config.example.json", bundle)
        (bundle / "快速开始.txt").write_text((HERE / "quickstart.txt").read_text(encoding="utf-8"), encoding="utf-8-sig")
        with urlopen(WEBVIEW_SETUP, timeout=45) as response, (bundle / "MicrosoftEdgeWebview2Setup.exe").open("wb") as setup:
            shutil.copyfileobj(response, setup)

        env = dict(os.environ, GOOS="windows", GOARCH="amd64", CGO_ENABLED="0", GOTOOLCHAIN="local")
        go_root = Path(subprocess.check_output([go, "env", "GOROOT"], env=env, text=True).strip())
        shutil.copy2(go_root / "LICENSE", bundle / "Go-LICENSE.txt")
        subprocess.run([
            go, "build", "-trimpath", "-ldflags=-s -w -H=windowsgui", "-o", str(bundle / "WlanMonitor.exe"), "."
        ], cwd=HERE, env=env, check=True)
        licenses = {
            "github.com/jchv/go-webview2": "LICENSE",
            "github.com/jchv/go-winloader": "LICENSE.md",
            "golang.org/x/sys": "LICENSE",
        }
        for module, filename in licenses.items():
            directory = Path(subprocess.check_output(
                [go, "list", "-m", "-f", "{{.Dir}}", module], cwd=HERE, env=env, text=True,
            ).strip())
            shutil.copy2(directory / filename, bundle / f"{module.rsplit('/', 1)[-1]}-LICENSE.txt")
            if module == "github.com/jchv/go-webview2":
                sdk = directory / "webviewloader" / "sdk"
                shutil.copy2(sdk / "x64" / "WebView2Loader.dll", bundle)
                shutil.copy2(sdk / "LICENSE.txt", bundle / "WebView2Loader-LICENSE.txt")
        base = destination / "WlanMonitor-Windows-x64"
        output = Path(shutil.make_archive(str(base), "zip", work, bundle.name))
    with output.open("rb") as stream:
        checksum = hashlib.file_digest(stream, "sha256").hexdigest()
    output.with_suffix(".zip.sha256").write_text(f"{checksum}  {output.name}\n", encoding="ascii")
    print(output)


def main():
    parser = argparse.ArgumentParser(description="构建 Windows 10/11 x64 便携版")
    parser.add_argument("--output", type=Path, default=ROOT / "dist")
    parser.add_argument("--go", default=shutil.which("go") or "go")
    parser.add_argument("--backend-only", type=Path, help="仅生成用于嵌入的 Windows 采集运行时")
    args = parser.parse_args()
    if args.backend_only:
        build_backend(args.backend_only.resolve())
    else:
        build(args.output.resolve(), args.go)


if __name__ == "__main__":
    main()
