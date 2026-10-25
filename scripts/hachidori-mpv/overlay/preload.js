// SPDX-License-Identifier: GPL-3.0-or-later
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hdmpv", {
  onState: handler => ipcRenderer.on("hdmpv:state", (_event, value) => handler(value)),
  onOptions: handler => ipcRenderer.on("hdmpv:options", (_event, value) => handler(value)),
  onLayout: handler => ipcRenderer.on("hdmpv:layout", (_event, value) => handler(value)),
  onPointer: handler => ipcRenderer.on("hdmpv:pointer", (_event, value) => handler(value)),
  setInteractive: on => ipcRenderer.send("hdmpv:interactive", on === true),
  hover: on => ipcRenderer.send("hdmpv:hover", on === true),
  lookupLine: line => ipcRenderer.send("hdmpv:lookup-line", line),
  note: detail => ipcRenderer.send("hdmpv:note", detail),
  focusMpv: () => ipcRenderer.send("hdmpv:focus-mpv"),
});

// Overlay-mode link buttons ask the embedding host to open their URL.
window.addEventListener("hachidori-open-external", event => {
  const detail = event.detail;
  if (!detail || typeof detail.requestId !== "string") return;
  ipcRenderer.invoke("hdmpv:open-external", detail.url).then(
    () => ({ requestId: detail.requestId, ok: true }),
    error => ({ requestId: detail.requestId, ok: false, error: error.message }),
  ).then(result => window.dispatchEvent(new CustomEvent("hachidori-open-external-result", { detail: result })));
});
