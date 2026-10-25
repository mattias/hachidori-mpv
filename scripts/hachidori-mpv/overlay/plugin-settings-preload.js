// SPDX-License-Identifier: GPL-3.0-or-later
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hdmpvSettings", {
  load: () => ipcRenderer.invoke("hdmpv-settings:load"),
  save: changes => ipcRenderer.invoke("hdmpv-settings:save", changes),
  openHachidori: () => ipcRenderer.invoke("hdmpv-settings:open-hachidori"),
});
