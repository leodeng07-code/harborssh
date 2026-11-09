"use strict";

const $ = id => document.getElementById(id);
const list = $("devices");
const stateLabels = {running: "采集中", stopping: "正在暂停", stopped: "已暂停"};
let initialized = false;
let state;
let busy = false;
const intervalValue = $("interval-value");
const intervalUnit = $("interval-unit");

function intervalBounds() {
  const minutes = intervalUnit.value === "minutes";
  intervalValue.min = minutes ? 1 : 15;
  intervalValue.max = minutes ? 1440 : 86400;
}

async function call(path, payload) {
  const options = payload === undefined ? {} : {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(payload),
  };
  const response = await fetch("/api/desktop" + path, {...options, signal: AbortSignal.timeout(20000)});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "操作失败");
  return data;
}

function feedback(message = "") {
  $("feedback").textContent = message;
  $("feedback").hidden = !message;
}

function renumber() {
  [...list.children].forEach((card, i) => {
    card.querySelector(".device-title").textContent = `第 ${i + 1} 台 AC`;
    card.querySelector(".remove").hidden = list.children.length === 1;
  });
  $("add").hidden = list.children.length >= 2;
}

function addDevice(device = {}) {
  const card = $("device-template").content.firstElementChild.cloneNode(true);
  const defaults = {name: list.children.length ? "AC-02" : "AC-01", host: "", port: 22, username: ""};
  for (const key of Object.keys(defaults)) {
    card.querySelector(`[name=${key}]`).value = device[key] ?? defaults[key];
  }
  const password = card.querySelector("[name=password]");
  password.placeholder = device.saved ? "已保存，留空沿用" : "输入只读账号密码";
  password.required = !device.saved;
  if (device.saved) {
    const check = () => {
      const identityChanged = ["host", "port", "username"].some(key =>
        card.querySelector(`[name=${key}]`).value.trim() !== String(device[key]));
      password.required = identityChanged;
      password.placeholder = identityChanged ? "账号已变更，请重新输入" : "已保存，留空沿用";
    };
    for (const key of ["host", "port", "username"]) card.querySelector(`[name=${key}]`).addEventListener("input", check);
  }
  card.querySelector(".remove").addEventListener("click", () => {
    card.remove();
    renumber();
  });
  list.append(card);
  renumber();
}

function render(data) {
  state = data;
  if (!initialized) {
    const seconds = data.intervalSeconds;
    intervalUnit.value = data.intervalUnit || (seconds % 60 === 0 ? "minutes" : "seconds");
    intervalValue.value = intervalUnit.value === "minutes" ? seconds / 60 : seconds;
    intervalBounds();
    if (data.devices.length) data.devices.forEach(addDevice);
    else addDevice();
    initialized = true;
    if (data.error) feedback(data.error);
  }
  $("service-state").textContent = stateLabels[data.state];
  $("service-state").className = "badge " + (data.state === "running" ? "normal" : data.state === "stopping" ? "watch" : "");
  const configured = data.devices.length > 0 && data.devices.every(d => d.saved);
  $("service-description").textContent = data.state === "running" ? "正在定时查询 AC。修改设备前请先暂停。"
    : data.state === "stopping" ? "本轮查询结束后暂停。"
      : configured ? "已保存 SSH 账号，可以立即开始采集。" : "请录入设备地址和 SSH 账号。";
  const toggle = $("toggle");
  toggle.hidden = !configured && data.state === "stopped";
  toggle.textContent = data.state === "stopped" ? "开始采集" : "暂停采集";
  toggle.disabled = busy || data.state === "stopping";
  $("form-fields").disabled = busy || data.state !== "stopped";
  $("refresh-key-wrap").hidden = !configured;
}

async function poll() {
  try {
    if (!busy) render(await call(""));
  } catch {
    feedback("无法读取本机服务状态，请重新打开应用。");
  } finally {
    setTimeout(poll, 1800);
  }
}

function confirmFingerprints(entries) {
  const dialog = $("trust");
  const cards = entries.map(item => {
    const card = document.createElement("div");
    card.className = "key-card";
    const title = document.createElement("strong");
    title.textContent = `${item.name} · ${item.address}`;
    const fingerprint = document.createElement("code");
    fingerprint.textContent = `${item.algorithm}  ${item.sha256}`;
    card.append(title, fingerprint);
    return card;
  });
  $("fingerprints").replaceChildren(...cards);
  dialog.returnValue = "cancel";
  dialog.showModal();
  return new Promise(resolve => dialog.addEventListener("close", () => resolve(dialog.returnValue === "trust"), {once: true}));
}

$("add").addEventListener("click", () => addDevice());
intervalUnit.addEventListener("change", () => {
  const value = intervalValue.valueAsNumber;
  intervalBounds();
  if (Number.isFinite(value)) {
    intervalValue.value = intervalUnit.value === "minutes" ? Math.max(1, Math.round(value / 60)) : value * 60;
  }
});
$("toggle").addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  feedback();
  render(state);
  try {
    state = await call(state.state === "stopped" ? "/start" : "/stop", {});
  } catch (error) {
    feedback(error.message);
  } finally {
    busy = false;
    render(state);
  }
});
$("config").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy || !state) return;
  const values = [...list.children].map(card =>
    Object.fromEntries([...card.querySelectorAll("input")].map(input => [input.name, input.value])));
  const devices = values.map(({password, port, ...device}) => ({...device, port: Number(port)}));
  const passwords = values.map(value => value.password);
  const recheck = $("refresh-key").checked;
  const interval_unit = intervalUnit.value;
  const interval_seconds = intervalValue.valueAsNumber * (interval_unit === "minutes" ? 60 : 1);
  busy = true;
  feedback();
  render(state);
  $("save").textContent = "正在检查连接…";
  try {
    const {ticket, fingerprints} = await call("/prepare", {devices, recheck});
    if (fingerprints.length && !await confirmFingerprints(fingerprints)) return;
    $("save").textContent = "正在保存…";
    await call("/save", {ticket, trusted: true, passwords, interval_seconds, interval_unit});
    for (const input of list.querySelectorAll("input[type=password]")) input.value = "";
    location.assign("/");
  } catch (error) {
    feedback(error.message);
  } finally {
    busy = false;
    $("save").textContent = "保存并开始采集";
    render(state);
  }
});

poll();
