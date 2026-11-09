# 园区无线信号监测

面向两台华为 AC6508（VRP V200R022C00SPC100）的园区无线监测原型。按 AP 汇总在线终端的接收信号强度（RSSI），通过持续弱信号和信道利用率为现场复测排优先级。

## Windows 10/11 图形便携版

完整解压 `WlanMonitor-Windows-x64.zip`，双击 `WlanMonitor.exe`。在窗口的「采集设置」保存 1 至 16 台 AC 的只读 SSH 账号和密码。首次连接新设备时，按窗口提示与管理员核对 SSH 主机指纹。旧版配置的地址、端口和用户名会带入设置。

密码由 Windows DPAPI 为当前用户加密。以后打开应用会自动开始采集，最小化时继续运行，关闭窗口时结束。配置与 SQLite 数据保存在 `%LOCALAPPDATA%\WlanMonitor`，旧版历史数据可沿用。窗口使用 Microsoft Edge WebView2，缺少运行环境时可打开包内的 Microsoft 安装程序。

点击 AP 列表任意一行即可打开详情。在「采集设置」暂停采集后，可以选择秒或分钟并保存周期。默认 5 分钟，支持 15 秒至 24 小时。

维护者可在装有 Python 3.11 及以上版本、pip 和 Go 1.21 及以上版本的主机上执行 `python3 packaging/windows/build.py`。脚本在 `dist` 生成 ZIP 与 SHA-256 校验文件。

修改 Windows 图标后，用 librsvg、Pillow 和 Go 从 SVG 重新生成资源文件。

```bash
rsvg-convert -w 256 -h 256 packaging/windows/icon.svg -o /tmp/wlan-monitor-icon.png
python3 -c 'from PIL import Image; Image.open("/tmp/wlan-monitor-icon.png").save("/tmp/wlan-monitor-icon.ico", sizes=[(n, n) for n in (16, 20, 24, 32, 40, 48, 64, 256)])'
go run github.com/tc-hib/go-winres@v0.3.3 simply --arch amd64 --manifest none --icon /tmp/wlan-monitor-icon.ico --out packaging/windows/rsrc
```

## 打开演示

使用 Python 3.10 或更新版本，在项目目录执行。

```bash
python3 -m wlan_monitor demo
```

打开 [本地看板](http://127.0.0.1:8765/)。演示使用两台模拟 AC、116 台 AP 和 24 小时模拟数据。演示数据与正式数据库隔离，退出后清理。

## 接入园区 AC

在能访问 AC 管理网的 Linux 主机上使用专用账号。该账号需能执行下列命令。

| 命令 | 用途 |
| --- | --- |
| `screen-length 0 temporary` | 临时关闭当前 SSH 会话分页 |
| `display ap all` | 读取 AP MAC、分组和运行状态 |
| `display station all` | 批量读取在线终端的 RSSI、关联 AP、频段和协商速率 |
| `display radio all` | 读取射频信道和利用率。该项失败时，终端采集可继续 |
| `display ap offline-record all` | 批量读取 AP 下线时间及原因。失败时保留其他采样 |
| `display ac protect` | 查询双链路保护开关、保护 AC 和优先级 |
| `display hsb-group 0` | 查询 WLAN 热备组的 VRRP 角色、组状态和备份阶段 |
| `display hsb-service 0` | 查询 HSB 通道状态和对端地址。热备组回显有服务编号时用该编号查询 |

采集器每轮为每台 AC 建立一个 SSH 会话，通过已验证的 SSH 主机密钥识别设备。请用运行程序的系统账号把已核对指纹的设备公钥加入 `~/.ssh/known_hosts`，也可以在对应 AC 的配置项填写 `known_hosts` 指定文件。遇到要求改密或确认的登录提示时，采集器结束该会话。

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
cp config.example.json config.json
```

编辑 [配置样例](config.example.json) 的副本，替换两台 AC 的名称、管理地址和账号。端口默认 22，可用 `port` 覆盖。将 AP MAC 加入 `locations` 可显示楼栋、楼层或车间位置。未填写位置时，看板显示 AP 分组。

密码通过环境变量提供。也可改用 `key_file` 指定 SSH 私钥。以密码为例，在同一个终端执行以下命令。

```bash
read -rsp 'AC 1 SSH 密码：' WLAN_AC1_PASSWORD
printf '\n'
export WLAN_AC1_PASSWORD
read -rsp 'AC 2 SSH 密码：' WLAN_AC2_PASSWORD
printf '\n'
export WLAN_AC2_PASSWORD

python -m wlan_monitor collect --db data/pilot.sqlite
```

试采前可在配置副本中先保留一台 AC，确认 AP 数量、终端数量和 RSSI 与设备回显一致，再恢复两台配置，核对主备去重或分担管理的结果。试采成功后启动看板。

```bash
python -m wlan_monitor run
```

该进程同时运行定时采集和本机看板。正式数据库默认写入 `data/wlan.sqlite`。一个数据库对应同一组 AC，使用一个常驻采集进程。看板监听 `127.0.0.1:8765`，远程主机上的看板可以通过 SSH 端口转发访问。

```bash
ssh -N -L 8765:127.0.0.1:8765 user@采集主机
```

## 诊断工作区

- 「问题总览」显示本轮问题分布和近 24 小时趋势。一个 AP 可同时属于多个问题类别。信道利用率门槛默认为 60%，可在 `policy.high_cu` 中调整。
- 「AP 排查」默认隐藏未见异常的 AP，资料缺失的 AP 会保留在「数据待核」。Windows 版可点击「查空口」，按需查询该 AP 射频的底噪、流量和利用率。终端的「诊断」可读取关联详情与实际流量。
- 「掉线记录」批量保留 AC 的 AP 下线记录。终端连续两轮完整采样未出现时，标记疑似离线并保留观察区间。输入终端 MAC 可按需查询各 AC 保存的下线时间及原因。设备时间保留 AC 回显。

界面参照 HarborSSH v0.6.2 的默认主题和工作区布局。后续接入其 React/Electron 主程序时，可在 `src/App.tsx` 增加无线监测入口并沿用宿主主题变量。将本项目的快照、AP 详情、事件和诊断接口映射到宿主的 Electron IPC，由主进程使用现有连接库及凭据保管。当前交付是可独立运行的 Windows 版。

## 看板口径

- **持续弱信号**默认每 5 分钟采一次。当同一 AP 下 RSSI ≤ −75 dBm 的终端至少 3 台、且占有效样本至少 20%，连续满足 3 轮时，列入「优先复测」。RSSI ≤ −82 dBm 的终端另计为严重弱信号。以上参数均可在 `config.json` 中调整。预警显示在看板内。
- **信号趋势**可切换最近 24 小时或 7 天。弱信号占比的分母为有有效 RSSI 的终端。P10 RSSI 为从弱到强排序后的第 10 百分位。没有有效样本时曲线断开。变更弱信号 RSSI 阈值后，旧阈值下计算的弱信号占比留空。
- **双 AC 统计**使用 AP 的物理 MAC 对齐主备清单，从本轮显示 `nor` 或 `normal` 的 AC 统计关联终端。两台 AC 都报告同一 AP 处于服务状态，或同一终端在本轮有多处关联记录时，受影响的 AP 标为「归属待核」，等待后续采样。失败或缺失的采样不会填零，也不计入连续预警。
- **AC 主备状态**根据绑定 AP 业务的 HSB 组运行状态识别 VRRP 主用和备用。双链路场景按本轮 AP 的正常注册和备用状态展示，可在同一台 AC 上看到两种链路。正常注册、备用和其他状态数量按各台 AC 独立计算。未取得可识别回显时保留其他采样。
- **保存范围**默认保留 30 天的 AP 汇总，终端 MAC、RSSI 和 SSID 明细在下一轮替换。采集器保留解析后的字段，终端 IP 和 CLI 原始回显不写入数据库。
- **现场复测**RSSI 是 AP 收到终端信号的强度，弱信号集中在同一区域并持续出现时，可安排覆盖复测。RSSI 尚可而信道利用率持续偏高时，优先排查信道干扰或空口拥塞。增加或移动 AP 前，可在实际工位用生产终端检查下行信号和业务体验。离线终端或尚未有终端接入的区域需要现场测量。

华为资料：[终端 RSSI](https://info.support.huawei.com/network/ptmngsys/Web/tsrev_wlan/cn/content/wlan/03_edesk_sta_display_rate_is_slow/edesk_sta_display_rate_is_slow_edesk001.html)、[AP 状态](https://info.support.huawei.com/network/ptmngsys/Web/tsrev_wlan/cn/content/wlan/11_edesk_ap_online_fail/edesk_ap_online_fail_edesk001.html)、[信道利用率](https://info.support.huawei.com/network/ptmngsys/Web/tsrev_wlan/cn/content/wlan/01_terminal_network_slow/edesk_sta_rate_is_slow_edesk007.html)。

## 核对现场回显

目前已验证模拟数据和本机模拟 SSH 设备。园区实机尚待联调。若试采报告表头、分页或行数不匹配，可在本地保存同一台 AC 的完整 UTF-8 回显，然后运行以下命令。

```bash
python3 -m wlan_monitor check-output --ap ap.txt --station stations.txt --radio radios.txt
python3 -m unittest discover -s tests -v
```

`--radio` 可省略。检查命令只打印解析计数。反馈格式问题时，提供命令名、表头、少量脱敏数据行、末尾的 Total 行，以及主备 AP 的状态缩写即可。
