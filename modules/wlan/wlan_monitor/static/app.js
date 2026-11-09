"use strict";

const $ = id => document.getElementById(id);
const categories = {
  weak: {label: "弱信号", color: "var(--rose)", hint: "至少一台终端达到弱信号阈值"},
  busy: {label: "空口繁忙", color: "var(--amber)", hint: "至少一个射频达到利用率门槛"},
  inactive: {label: "未在服务", color: "var(--blue)", hint: "本轮未在 AC 上正常注册"},
  pending: {label: "数据待核", color: "var(--violet)", hint: "信号、射频或归属信息缺失"},
};
const labels = {overview: "问题总览", inventory: "AP 排查", events: "掉线记录"};
const statuses = {running: "采集中", stopping: "正在暂停", stopped: "已暂停"};
const eventLabels = {ap: "AP 下线", station: "终端下线", station_missing: "疑似离线"};
const comparable = new Set(["alert", "watch", "weak", "normal"]);
const timeZone = "Asia/Shanghai";
const dateFormat = new Intl.DateTimeFormat("zh-CN", {
  timeZone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const hourFormat = new Intl.DateTimeFormat("zh-CN", {timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23"});
const dayFormat = new Intl.DateTimeFormat("zh-CN", {timeZone, month: "2-digit", day: "2-digit"});
const numberFormat = new Intl.NumberFormat("zh-CN");
const fmt = n => numberFormat.format(n);
const date = at => dateFormat.format(at * 1000);
const signed = n => n == null ? "—" : `${n} dBm`;
const ratio = ap => ap.valid && comparable.has(ap.quality) ? 100 * ap.weak / ap.valid : null;
const percent = n => n == null ? "—" : `${n.toFixed(1).replace(/\.0$/, "")}%`;
const maxCU = ap => ap.radios.reduce((max, radio) => radio.cu == null ? max : Math.max(max ?? 0, radio.cu), null);
const position = ap => ap.location || `AP 组 ${ap.ap_group}`;
let snapshot;
let view = "overview";
let canDiagnose = false;
let selected = null;
let apRequest = 0;
let eventRequest = 0;
let refreshTimer;
let events = [];
let eventMac = "";

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(text, className, onClick) {
  const node = el("button", text, className);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}
function badge(label, tone) {
  return el("span", label, `badge ${tone || ""}`);
}
function stat(title, value, detail, tone = "") {
  const node = el("div", null, `stat ${tone}`);
  node.append(el("span", title, "muted"), el("strong", value), el("span", detail, "stat-note"));
  return node;
}
function placeholder(tbody, text, columns) {
  const tr = el("tr");
  const td = el("td", text, "empty-state");
  td.colSpan = columns;
  tr.append(td);
  tbody.replaceChildren(tr);
}
function issues(ap, policy = snapshot?.policy) {
  if (ap.quality === "conflict") return ["pending"];
  if (ap.quality === "inactive") return ["standby", "stdby"].includes(ap.state) ? ["pending"] : ["inactive"];
  const result = [];
  const cu = maxCU(ap);
  if (ap.weak > 0) result.push("weak");
  if (cu !== null && cu >= (policy?.high_cu ?? 60)) result.push("busy");
  if (cu === null || ap.radios.some(radio => radio.cu == null) || ap.quality === "unknown" || ap.total > ap.valid) {
    result.push("pending");
  }
  return result;
}
function issueBadges(ap) {
  const div = el("div", null, "badges");
  const found = issues(ap);
  if (!found.length) div.append(badge("未见异常", "normal"));
  for (const issue of found) {
    div.append(badge(issue === "weak" && ap.quality === "alert" ? "持续弱信号" : categories[issue].label, issue));
  }
  return div;
}
function rank(a, b) {
  const severity = ap => issues(ap).includes("inactive") ? 5 : ap.quality === "alert" ? 4
    : issues(ap).includes("busy") ? 3 : ap.weak > 0 ? 2 : issues(ap).length;
  return severity(b) - severity(a) || (ratio(b) || 0) - (ratio(a) || 0) || (maxCU(b) || 0) - (maxCU(a) || 0)
    || a.name.localeCompare(b.name, "zh-CN", {numeric: true});
}
function message(text) {
  $("message").hidden = !text;
  $("message").textContent = text || "";
}
function selectView(name) {
  if (view !== name) document.querySelector(".view-scroll").scrollTop = 0;
  view = name;
  $("breadcrumb").textContent = labels[name];
  for (const key of Object.keys(labels)) $(`view-${key}`).hidden = key !== name;
  for (const node of document.querySelectorAll("[data-view]")) {
    if (node.dataset.view === name) node.setAttribute("aria-current", "page");
    else node.removeAttribute("aria-current");
  }
  if (name === "events") loadEvents();
}
function browseIssue(key) {
  $("filter").value = key;
  $("search").value = "";
  $("hide-healthy").checked = true;
  selectView("inventory");
  renderInventory();
}
const haRoles = {
  primary: ["主用", "normal"],
  standby: ["备用", "inactive"],
  primary_link: ["主用链路", "normal"],
  standby_link: ["备用链路", "inactive"],
  mixed: ["主备链路并存", "pending"],
  switching: ["切换中", "busy"],
  unknown: ["角色待核", "pending"],
};
const haModes = {vrrp: "VRRP 热备", dual_link: "双链路 · 按 AP", ap_state: "按 AP 注册状态观察"};

function haBadge(ac, stale) {
  const [label, tone] = haRoles[ac.ha?.role] || (ac.error ? ["未读到主备", "weak"] : haRoles.unknown);
  return badge(label, stale ? "pending" : tone);
}

function renderSources(data) {
  $("sources").replaceChildren(...(data?.controllers || []).map(ac => {
    const item = el("div", null, "source");
    const head = el("div", null, "source-head");
    head.append(el("strong", ac.name), haBadge(ac, data.stale));
    item.append(head);
    item.append(el("p", data.stale ? "采样已过期" : ac.error ? "AP / 终端采集失败" : "采集成功", "muted"));
    if (ac.error) item.append(el("p", ac.error, "source-note danger"));
    if (ac.ha?.active != null) {
      item.append(el("p", `AP · 注册 ${fmt(ac.ha.active)} / 备用 ${fmt(ac.ha.standby)}`, "muted"));
    }
    if (ac.radio_error) item.append(el("p", `射频 · ${ac.radio_error}`, "source-note warning"));
    if (ac.offline_error) item.append(el("p", `AP 下线记录 · ${ac.offline_error}`, "source-note warning"));
    return item;
  }));
}
function renderHA(data) {
  $("ac-ha-sample").textContent = !data ? "等待采样" : data.stale ? "历史采样" : "本轮 · 各 AC 独立统计";
  const rows = (data?.controllers || []).map(ac => {
    const card = el("div", null, "ha-card");
    const title = el("div", null, "ha-title");
    const ha = ac.ha;
    title.append(el("h3", ac.name), haBadge(ac, data.stale));
    card.append(title);
    if (!ha) {
      card.append(el("p", ac.error || "等待新版采集首轮主备数据。", "muted"));
      return card;
    }
    const {group, service, protect} = ha;
    const stats = el("dl", null, "ha-counts");
    for (const [label, count] of [["正常注册 AP", ha.active], ["备用 AP", ha.standby], ["其他状态 AP", ha.other]]) {
      const stat = el("div");
      stat.append(el("dt", label), el("dd", count == null ? "—" : fmt(count), "mono"));
      stats.append(stat);
    }
    const mode = haModes[ha.mode] || "主备方式待核";
    const status = el("div", null, "ha-facts");
    status.append(el("span", mode));
    if (service) {
      const connected = service.state.toLowerCase() === "connected";
      status.append(el("span", connected ? "HSB 通道已连接" : `HSB 通道 ${service.state}`,
                       connected ? "ha-connected" : ha.mode === "unknown" ? "" : "warning"));
    }
    const details = [];
    if (group) {
      details.push(`HSB 组 ${group.id}`, `VRID ${group.vrid ?? "—"}`);
      if (group.interface && group.interface !== "-") details.push(group.interface);
      if (group.vrrp && group.state) details.push(`${group.vrrp} / ${group.state}`);
      if (group.process && group.process !== "-") details.push(group.process === "Realtime" ? "实时备份" : group.process);
      if (!group.backs_up_ap) details.push("未见 AP 备份模块");
    }
    if (service?.peer) details.push(`HSB 对端 ${service.peer}`);
    if (protect) {
      details.push(protect.enabled ? "双链路已启用" : "双链路未启用");
      if (protect.enabled && protect.priority != null) details.push(`优先级 ${protect.priority}`);
      if (protect.peers?.length) details.push(`保护 AC ${protect.peers.join(" / ")}`);
    }
    card.append(stats, status);
    if (details.length) card.append(el("p", details.join(" · "), "muted ha-detail"));
    if (ha.unread?.length) {
      const readback = el("details", null, "ha-readback muted");
      const list = el("ul");
      list.append(...ha.unread.map(note => el("li", note)));
      readback.append(el("summary", "查看未取得的主备回显"), list);
      card.append(readback);
    }
    return card;
  });
  $("ac-ha-status").replaceChildren(...(rows.length ? rows : [el("p", "等待第一轮 AC 主备采样。", "empty-state")]));
}

function renderOverview(data) {
  renderHA(data);
  if (!data) {
    $("cards").replaceChildren();
    $("distribution").replaceChildren(el("p", "等待第一轮采样。", "empty-state"));
    $("trend").replaceChildren();
    $("queue").replaceChildren();
    return;
  }
  const {aps, policy} = data;
  const withIssue = aps.filter(ap => issues(ap).length);
  const valid = aps.reduce((sum, ap) => sum + (comparable.has(ap.quality) ? ap.valid : 0), 0);
  const weak = aps.reduce((sum, ap) => sum + (comparable.has(ap.quality) ? ap.weak : 0), 0);
  const online = aps.filter(ap => /^(nor|normal)$/.test(ap.state)).length;
  const failed = data.controllers.filter(ac => ac.error).length;
  const observed = data.controllers.length > failed;
  $("cards").replaceChildren(
    stat("本轮 AP", observed ? fmt(aps.length) : "—", `${online} 台正常注册`),
    stat("需排查 AP", observed ? fmt(withIssue.length) : "—", "按 AP 去重", "red"),
    stat("弱信号终端", valid ? fmt(weak) : "—", valid ? `占有效样本 ${percent(100 * weak / valid)}` : "无有效 RSSI", "amber"),
    stat("采集成功 AC", `${data.controllers.length - failed} / ${data.controllers.length}`, data.stale ? "历史采样" : "本轮采样"),
  );
  $("distribution").replaceChildren(...Object.entries(categories).map(([key, category]) => {
    const count = aps.filter(ap => issues(ap).includes(key)).length;
    const row = button(null, `issue-bar ${key}`, () => browseIssue(key));
    const meter = el("meter");
    meter.max = Math.max(aps.length, 1);
    meter.value = count;
    meter.setAttribute("aria-label", category.label);
    const description = el("div", null, "bar-heading");
    description.append(el("strong", category.label), el("span", observed ? `${count} 台` : "—", "mono"));
    row.append(description, meter, el("small", category.hint, "muted"));
    return row;
  }));
  $("rule").textContent = `弱信号 ≤ ${policy.weak_rssi} dBm · 空口繁忙 ≥ ${policy.high_cu ?? 60}% · 同一 AP 可出现在多个类别。`;
  $("trend").replaceChildren(overviewTrend(data));
  const queue = withIssue.sort(rank).slice(0, 6).map(ap => {
    const row = button(null, "queue-item", () => showAP(ap));
    const title = el("span", null, "queue-name");
    title.append(el("strong", ap.name), el("span", position(ap), "muted"));
    row.append(title, issueBadges(ap), el("span", ap.weak > 0 ? `${ap.weak} 台弱信号` : `最高利用率 ${percent(maxCU(ap))}`, "mono muted"), el("span", "›", "arrow"));
    return row;
  });
  $("queue").replaceChildren(...(queue.length ? queue : [el("p", observed ? "本轮已采样的 AP 未发现异常。" : "等待可用的 AC 采样。", "empty-state")]));
  $("issue-count").textContent = observed ? withIssue.length : "—";
}
function renderInventory() {
  const query = $("search").value.trim().toLowerCase();
  const filter = $("filter").value;
  const aps = snapshot?.aps || [];
  const entries = aps.filter(ap => {
    const found = issues(ap);
    return (!$("hide-healthy").checked || found.length) && (filter === "all" || found.includes(filter))
      && [ap.name, ap.mac, ap.location, ap.ap_group, ap.ac].some(value => value.toLowerCase().includes(query));
  }).sort(rank);
  $("result-count").textContent = `显示 ${entries.length} / ${aps.length} 台 · 可展开查看射频和终端详情`;
  if (!entries.length) {
    placeholder($("inventory"), snapshot ? "没有符合当前筛选条件的 AP。" : "等待第一轮采样。", 5);
    return;
  }
  $("inventory").replaceChildren(...entries.map(ap => {
    const row = el("tr", null, ap.mac === selected ? "ap-row selected" : "ap-row");
    row.addEventListener("click", () => showAP(ap));
    const title = el("td");
    const link = el("button", ap.name, "ap-link");
    link.type = "button";
    title.append(link, el("span", `${position(ap)} · ${ap.ac}`, "sub"));
    const issue = el("td");
    issue.append(issueBadges(ap));
    const observed = !["inactive", "conflict"].includes(ap.quality);
    row.append(title, el("td", observed ? fmt(ap.total) : "—", "mono"),
      el("td", percent(ratio(ap)), "mono"), el("td", percent(maxCU(ap)), "mono"), issue);
    return row;
  }));
}
async function getJSON(url, payload) {
  const options = payload === undefined ? {} : {
    method: "POST", headers: {"Content-Type": "application/json", "X-Wlan-Request": "desktop"}, body: JSON.stringify(payload),
  };
  const timeout = payload === undefined ? 8000 : payload.kind === "offline" ? 230000 : 65000;
  const response = await fetch(url, {...options, signal: AbortSignal.timeout(timeout)});
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "读取失败");
  return body;
}
async function refresh() {
  clearTimeout(refreshTimer);
  $("refresh").disabled = true;
  let delay = 30000;
  try {
    const data = await getJSON("/api/dashboard");
    snapshot = data.snapshot;
    canDiagnose = !!data.diagnostics;
    $("mode").textContent = `● ${data.demo ? "演示数据" : statuses[data.desktop] || "本地采集"}`;
    $("mode").className = `mode ${data.demo ? "demo" : ""}`;
    $("settings-link").hidden = !data.desktop;
    $("event-query").hidden = !canDiagnose;
    const interval = data.intervalSeconds ?? snapshot?.interval;
    if (data.desktop === "running" && interval) delay = Math.min(delay, interval * 500);
    if (data.desktop === "running" && (!snapshot || snapshot.stale)) delay = 2500;
    $("timestamp").textContent = snapshot ? `${snapshot.stale ? "历史采样" : "最近采样"} · ${date(snapshot.at)}` : "等待采样";
    $("status").textContent = interval ? `本地数据 · 每 ${interval} 秒采样` : "本地数据";
    const problems = [];
    if (snapshot?.stale) problems.push("采样已过期，当前显示历史结果。");
    const failures = snapshot?.controllers.filter(ac => ac.error).length || 0;
    if (failures) problems.push(`${failures} 台 AC 本轮采集失败，以下只统计已观测数据。`);
    message(problems.join(" "));
    renderSources(snapshot);
    renderOverview(snapshot);
    renderInventory();
    if (view === "events" && !eventMac) loadEvents();
  } catch {
    message("暂时无法读取最新采样，页面保留上次结果。");
  } finally {
    $("refresh").disabled = false;
    refreshTimer = setTimeout(refresh, delay);
  }
}

const svgNS = "http://www.w3.org/2000/svg";
function svgNode(tag, attributes, text) {
  const node = document.createElementNS(svgNS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text != null) node.textContent = text;
  return node;
}
function lineChart(series, {at, days = 1, interval, ticks, unit = "", limit, title}) {
  if (!series.some(line => line.points.some(point => point.value != null))) {
    return el("p", "这段时间没有可用的连续采样。", "empty-state");
  }
  const span = days * 86400;
  const x = value => 41 + 469 * (value - at + span) / span;
  const y = value => 140 - 119 * (value - ticks[0]) / (ticks.at(-1) - ticks[0]);
  const svg = svgNode("svg", {viewBox: "0 0 535 171", class: "chart-svg", role: "img", "aria-label": title});
  for (const tick of ticks) {
    svg.append(svgNode("line", {x1: 41, x2: 510, y1: y(tick), y2: y(tick), class: "grid"}));
    svg.append(svgNode("text", {x: 35, y: y(tick) + 4, "text-anchor": "end"}, `${tick}${unit}`));
  }
  for (const part of [0, .25, .5, .75, 1]) {
    const t = at - span * (1 - part);
    const label = (days === 1 ? hourFormat : dayFormat).format(t * 1000);
    svg.append(svgNode("text", {x: x(t), y: 163, "text-anchor": "middle"}, label));
  }
  if (limit != null) svg.append(svgNode("line", {x1: 41, x2: 510, y1: y(limit), y2: y(limit), class: "limit"}));
  for (const line of series) {
    let path = "";
    let prior = null;
    for (const point of line.points) {
      if (point.value == null) {
        prior = null;
        continue;
      }
      const continuous = prior != null && point.at - prior <= interval * 1.75;
      const cx = x(point.at).toFixed(2);
      const cy = y(point.value).toFixed(2);
      path += `${continuous ? "L" : "M"}${cx},${cy} `;
      if (!continuous || point.at === at) svg.append(svgNode("circle", {cx, cy, r: 2.4, fill: line.color}));
      prior = point.at;
    }
    const pathAttributes = {d: path, stroke: line.color, class: "data-line"};
    if (line.dash) pathAttributes["stroke-dasharray"] = line.dash;
    svg.append(svgNode("path", pathAttributes));
  }
  return svg;
}
function overviewTrend(data) {
  const points = data.trend || [];
  const series = ["weak", "inactive", "busy"].map(key => ({
    ...categories[key], key, dash: key === "busy" ? "4 4" : null,
    points: points.map(point => ({at: point.at, value: point[key]})),
  }));
  const top = Math.max(1, ...series.flatMap(line => line.points.map(point => point.value || 0)));
  const step = Math.max(1, Math.ceil(top / 4));
  const div = el("div", null, "overview-chart");
  const legend = el("div", null, "legend");
  for (const line of series) legend.append(el("span", line.label, line.key));
  div.append(legend, lineChart(series, {
    at: data.at, interval: data.interval, ticks: [0, step, 2 * step, 3 * step, 4 * step], title: "近 24 小时各类异常 AP 数量",
  }), el("p", "单位为 AP 台数。缺失或间隔过长的采样留空。", "panel-note muted"));
  return div;
}
function apTrend(history, at, days, policy, interval, field) {
  const weak = field === "weak";
  const points = history.map(sample => {
    const share = ratio(sample);
    const value = weak ? (JSON.parse(sample.policy).weak_rssi === policy.weak_rssi ? share : null)
      : (share == null ? null : sample.p10);
    return {at: sample.at, value};
  });
  return lineChart([{points, color: "var(--accent)"}], {
    at, days, interval, ticks: weak ? [0, 25, 50, 75, 100] : [-130, -104, -78, -52, -26, 0],
    unit: weak ? "%" : "", limit: weak ? policy.min_percent : policy.weak_rssi,
    title: weak ? "弱信号终端占比" : "P10 RSSI",
  });
}
function diagnosticSection(title, result) {
  const section = el("section", null, "diag-section");
  section.append(el("h3", title));
  if (result.error) {
    section.append(el("p", result.error, "notice"));
    return section;
  }
  const list = el("dl", null, "diag-values");
  for (const metric of result.metrics) {
    const value = metric.value == null ? "—" : `${metric.value}${metric.unit ? " " + metric.unit : ""}`;
    list.append(el("dt", metric.label), el("dd", value, "mono"));
  }
  section.append(list);
  return section;
}
async function runDiagnostic(trigger, target, payload, render) {
  trigger.disabled = true;
  target.replaceChildren(el("p", "正在从服务 AC 读取…", "muted"));
  try {
    const response = await getJSON("/api/diagnostics", payload);
    target.replaceChildren(...render(response));
  } catch (error) {
    target.replaceChildren(el("p", error.message, "notice"));
  } finally {
    trigger.disabled = false;
  }
}
function radioPanel(ap) {
  const section = el("section", null, "details-section");
  section.append(el("h3", "射频诊断"));
  if (!ap.radios.length) {
    section.append(el("p", "本轮没有射频数据。", "muted"));
    return section;
  }
  const output = el("div");
  const table = el("div", null, "radio-list");
  for (const radio of ap.radios) {
    const row = el("div", null, "radio-row");
    row.append(el("strong", `${radio.band} · 射频 ${radio.radio_id}`),
      el("span", `${radio.channel} · ${percent(radio.cu)}`, "mono muted"));
    if (canDiagnose && !["inactive", "conflict"].includes(ap.quality)) {
      const trigger = button("查空口", "button", () => runDiagnostic(trigger, output, {
        kind: "air", mac: ap.mac, radio: radio.radio_id,
      }, data => [diagnosticSection(`${radio.band} 空口详情`, data)]));
      row.append(trigger);
    }
    table.append(row);
  }
  section.append(table, output);
  return section;
}
function clientPanel(stations, policy) {
  const section = el("section", null, "details-section");
  section.append(el("h3", `本轮关联终端 · ${stations.length}`));
  if (!stations.length) {
    section.append(el("p", "本轮没有关联终端。", "muted"));
    return section;
  }
  const band = el("select");
  band.setAttribute("aria-label", "按频段筛选终端");
  for (const item of ["全部频段", ...new Set(stations.map(station => station.band))]) band.append(el("option", item));
  const list = el("div", null, "client-list");
  const output = el("div");
  function renderClients() {
    const filtered = band.selectedIndex === 0 ? stations : stations.filter(station => station.band === band.value);
    list.replaceChildren(...filtered.map(station => {
      const row = el("div", null, "client-row");
      const identity = el("div");
      identity.append(el("strong", station.mac, "mono"), el("span", `${station.ssid} · ${station.band} · Rx/Tx ${station.rates} Mbps`, "sub"));
      row.append(identity, el("span", signed(station.rssi), `mono ${station.rssi != null && station.rssi <= policy.weak_rssi ? "danger" : ""}`));
      if (canDiagnose) {
        const trigger = button("诊断", "button", () => runDiagnostic(trigger, output, {kind: "station", mac: station.mac},
          data => [diagnosticSection(`${station.mac} · 终端详情`, data.info), diagnosticSection("实际流量", data.traffic),
            button("查看该终端掉线记录 →", "text-button", () => openEvents(station.mac))]));
        row.append(trigger);
      }
      return row;
    }));
  }
  band.addEventListener("change", renderClients);
  renderClients();
  section.append(band, list, output);
  return section;
}
async function showAP(summary, days = 1) {
  const request = ++apRequest;
  selected = summary.mac;
  selectView("inventory");
  renderInventory();
  $("inventory-split").classList.add("with-details");
  $("details").hidden = false;
  if (window.matchMedia("(max-width: 980px)").matches) $("details").scrollIntoView({block: "nearest"});
  $("ap-title").textContent = summary.name;
  $("ap-subtitle").textContent = `${position(summary)} · ${summary.ac} · ${summary.mac}`;
  $("ap-content").replaceChildren(el("p", "正在读取 AP 数据…", "empty-state"));
  try {
    const {ap, stations, policy, history, at, interval, stale} = await getJSON(`/api/ap?mac=${encodeURIComponent(summary.mac)}&days=${days}`);
    if (request !== apRequest) return;
    const detail = el("div", null, "ap-status");
    detail.append(issueBadges(ap), el("p", `${date(at)}${stale ? " · 历史" : ""} · ${ap.state} · P10 ${signed(ap.p10)}`, "muted"));
    const trends = el("details", null, "details-section");
    const toggle = el("summary", "信号趋势");
    const range = el("select");
    range.setAttribute("aria-label", "趋势时间范围");
    for (const [value, label] of [[1, "近 24 小时"], [7, "近 7 天"]]) {
      const option = el("option", label);
      option.value = value;
      option.selected = value === days;
      range.append(option);
    }
    const charts = el("div", null, "detail-trends");
    for (const [field, title] of [["weak", "弱信号占比"], ["p10", "P10 RSSI"]]) {
      charts.append(el("h3", title), apTrend(history, at, days, policy, interval, field));
    }
    range.addEventListener("change", () => showAP(ap, Number(range.value)));
    trends.open = days !== 1;
    trends.append(toggle, range, charts);
    $("ap-content").replaceChildren(detail, radioPanel(ap), clientPanel(stations, policy), trends);
  } catch (error) {
    if (request === apRequest) $("ap-content").replaceChildren(el("p", error.message, "notice"));
  }
}
function closeDetails() {
  ++apRequest;
  selected = null;
  $("details").hidden = true;
  $("inventory-split").classList.remove("with-details");
  renderInventory();
}
function renderEvents() {
  const kind = $("event-filter").value;
  const items = events.filter(event => kind === "all" || kind === event.kind);
  if (!items.length) {
    placeholder($("events"), "当前范围没有下线记录。", 5);
    return;
  }
  $("events").replaceChildren(...items.map(event => {
    const row = el("tr");
    const type = el("td");
    type.append(badge(eventLabels[event.kind], event.kind === "station_missing" ? "pending" : "inactive"));
    const time = event.kind === "station_missing" ? `${date(event.last_seen)} 至 ${date(event.first_missing)}` : event.event_time;
    const identity = el("td");
    identity.append(el("strong", event.ap_name || "—"), el("span", event.mac, "sub mono"));
    if (event.kind === "station_missing" && canDiagnose) {
      identity.append(button("查 AC 记录", "text-button sub", () => queryOffline(event.mac)));
    }
    row.append(type, el("td", time, "mono"), identity, el("td", event.ac), el("td", event.reason));
    return row;
  }));
}
async function loadEvents() {
  const request = ++eventRequest;
  try {
    const result = await getJSON("/api/events" + (eventMac ? `?mac=${encodeURIComponent(eventMac)}` : ""));
    if (request !== eventRequest) return;
    events = result.events;
    renderEvents();
    $("event-feedback").textContent = eventMac ? `${eventMac} · 本机已保存记录` : "最近记录 · 可按类型筛选";
  } catch (error) {
    if (request === eventRequest) $("event-feedback").textContent = error.message;
  }
}
function openEvents(mac) {
  $("event-mac").value = mac;
  eventMac = mac;
  $("event-filter").value = "all";
  selectView("events");
}
async function queryOffline(mac) {
  const request = ++eventRequest;
  $("event-mac").value = mac;
  eventMac = mac;
  $("event-query").disabled = true;
  $("event-feedback").textContent = "正在查询已配置的 AC…";
  try {
    const result = await getJSON("/api/diagnostics", {kind: "offline", mac});
    if (request !== eventRequest) return;
    events = result.events;
    $("event-filter").value = "all";
    renderEvents();
    $("event-feedback").textContent = result.sources.map(source =>
      `${source.ac} · ${source.error || `${source.events.length} 条 AC 记录`}`).join("　");
  } catch (error) {
    if (request === eventRequest) $("event-feedback").textContent = error.message;
  } finally {
    $("event-query").disabled = false;
  }
}

for (const node of document.querySelectorAll("[data-view]")) {
  node.addEventListener("click", () => selectView(node.dataset.view));
}
$("refresh").addEventListener("click", refresh);
$("open-inventory").addEventListener("click", () => browseIssue("all"));
$("search").addEventListener("input", renderInventory);
$("filter").addEventListener("change", renderInventory);
$("hide-healthy").addEventListener("change", renderInventory);
$("close-details").addEventListener("click", closeDetails);
$("event-filter").addEventListener("change", renderEvents);
$("event-mac").addEventListener("input", () => {
  if (!$("event-mac").value && eventMac) {
    eventMac = "";
    loadEvents();
  }
});
$("event-form").addEventListener("submit", event => {
  event.preventDefault();
  const mac = $("event-mac").value.trim();
  if (mac && canDiagnose) queryOffline(mac);
  else {
    eventMac = mac;
    loadEvents();
  }
});
refresh();
