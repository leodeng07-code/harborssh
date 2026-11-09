"use strict";

if (location.protocol === "harbor-wlan:" && window.parent !== window) {
  window.addEventListener("message", ({source, data}) => {
    if (source !== window.parent || data?.type !== "harbor-wlan-theme" || !data.colors) return;
    const root = document.documentElement;
    root.style.colorScheme = data.light ? "light" : "dark";
    for (const [key, color] of Object.entries(data.colors)) {
      if (/^[a-z]+(?:-[a-z]+)*$/.test(key) && /^#[0-9a-f]{6}$/i.test(color)) {
        root.style.setProperty(`--${key}`, color);
      }
    }
  });
}
