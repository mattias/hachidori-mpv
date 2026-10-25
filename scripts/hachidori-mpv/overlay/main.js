// SPDX-License-Identifier: GPL-3.0-or-later
// hachidori-mpv overlay: runs the real Hachidori extension (overlay mode,
// linked to the sharing Hachidori in your browser) in a transparent window
// over each mpv that asks for it. One process serves every mpv instance.
"use strict";

const { app, BrowserWindow, ipcMain, session, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { MpvIpc } = require("./mpv-ipc");
const { WindowTracker } = require("./window-tracker");
const { fillNoteMedia } = require("./anki-media");

app.setName("hachidori-mpv");
app.setPath("userData", path.join(app.getPath("appData"), "hachidori-mpv"));
// Hachidori's popup audio should play without a click first.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
if (process.env.HACHIDORI_MPV_DEBUG_PORT) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.HACHIDORI_MPV_DEBUG_PORT);
}

const EXTENSION_DIR = path.join(__dirname, "hachidori");
const DEBUG = process.argv.includes("--hachidori-debug");
const HEARTBEAT_MS = 2000;

const log = (...args) => console.log("[hachidori-mpv]", ...args);
const argValue = (argv, name) => {
  const prefix = `--${name}=`;
  const entry = argv.find(value => typeof value === "string" && value.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : null;
};

const firstIpc = argValue(process.argv, "mpv-ipc");
if (!app.requestSingleInstanceLock({ ipc: firstIpc })) {
  // Another overlay process already runs; it attaches to this mpv instead.
  app.quit();
  process.exit(0);
}

let extension = null;
let engineWindow = null;
let bridgeWindow = null;
let settingsWindow = null;
let ready = null;
const sessions = new Map(); // ipc path → OverlaySession

async function loadHachidori() {
  if (!fs.existsSync(path.join(EXTENSION_DIR, "manifest.json"))) {
    throw new Error("Hachidori is not prepared. Run install.ps1 / install.sh again.");
  }
  const ses = session.defaultSession;
  // A new Hachidori must not meet an old service worker.
  const source = JSON.parse(fs.readFileSync(path.join(EXTENSION_DIR, "SOURCE.json"), "utf8"));
  const marker = path.join(app.getPath("userData"), "hachidori-prepared.json");
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(marker, "utf8")).preparedAt; } catch {}
  if (previous !== source.preparedAt) {
    log("Hachidori changed; clearing its old service worker.");
    await ses.clearStorageData({ storages: ["serviceworkers"] }).catch(() => {});
  }
  const api = ses.extensions ?? ses;
  const readyIds = new Set();
  const onReady = (_event, ext) => readyIds.add(ext.id);
  api.on("extension-ready", onReady);
  try {
    extension = await api.loadExtension(EXTENSION_DIR, { allowFileAccess: true });
    const started = Date.now();
    while (!readyIds.has(extension.id) && Date.now() - started < 15000) await new Promise(r => setTimeout(r, 50));
  } finally {
    api.off?.("extension-ready", onReady);
  }
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({ preparedAt: source.preparedAt, version: source.version }));
  log(`Hachidori ${source.version} loaded (${extension.id}).`);
}

function hiddenWindow() {
  return new BrowserWindow({ show: false, width: 1, height: 1, skipTaskbar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
}

// Electron has no chrome.offscreen, so the overlay hosts Hachidori's
// offscreen document (its engine, audio and Anki work) itself.
async function startEngine() {
  engineWindow = hiddenWindow();
  await engineWindow.loadURL(`chrome-extension://${extension.id}/mpv/engine-host.html`);
  const extensionOwnsEngine = await engineWindow.webContents.executeJavaScript("hachidoriMpvEngineHost");
  if (extensionOwnsEngine) {
    engineWindow.destroy();
    engineWindow = null;
    return;
  }
  await engineWindow.loadURL(`chrome-extension://${extension.id}/offscreen.html`);
}

async function startBridge() {
  bridgeWindow = hiddenWindow();
  await bridgeWindow.loadURL(`chrome-extension://${extension.id}/mpv/bridge.html`);
  const started = Date.now();
  while (!(await bridgeWindow.webContents.executeJavaScript("typeof globalThis.hachidoriMpv === 'object'"))) {
    if (Date.now() - started > 10000) throw new Error("the bridge page did not start");
    await new Promise(r => setTimeout(r, 50));
  }
}

function bridge(call) {
  if (!bridgeWindow || bridgeWindow.isDestroyed()) return Promise.reject(new Error("the bridge is not running"));
  return bridgeWindow.webContents.executeJavaScript(`globalThis.hachidoriMpv.${call}`);
}

async function ensureLinked(notify) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const result = await bridge("ensureLinked()");
      if (result.linked) {
        if (result.changed) {
          log(`Linked to ${result.host}.`);
          notify(`linked to ${result.host}`);
        }
        return true;
      }
      if (attempt === 0) log(`Not linked yet: ${result.error}`);
    } catch (error) {
      if (attempt === 0) log(`Link check failed: ${error.message}`);
    }
    if (attempt === 2) notify("waiting for the sharing Hachidori (open your browser and Anki)", 6);
    await new Promise(r => setTimeout(r, 4000));
  }
  return false;
}

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({ width: 1440, height: 900, minWidth: 800, minHeight: 500, title: "Hachidori",
    autoHideMenuBar: true, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  settingsWindow.removeMenu();
  settingsWindow.loadURL(`chrome-extension://${extension.id}/settings.html`);
  settingsWindow.on("closed", () => { settingsWindow = null; });
}

class OverlaySession {
  constructor(ipcPath) {
    this.ipcPath = ipcPath;
    this.mpv = new MpvIpc(ipcPath);
    this.window = null;
    this.tracker = null;
    this.options = {};
    this.state = { subText: "", subStart: null, subEnd: null, pause: false, osd: null, title: "", fullscreen: false };
    this.interactive = false;
    this.pausedByHover = false;
    this.lookupLine = null;
    this.heartbeat = null;
    this.closed = false;
    this.pid = null;
  }

  notify(text, seconds = 3) {
    void this.mpv.scriptMessage("hachidori-mpv-osd", text, seconds);
  }

  send(channel, value) {
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send(channel, value);
  }

  async start() {
    await this.mpv.connect();
    this.mpv.on("close", () => this.close());
    this.mpv.on("client-message", message => this.onClientMessage(message.args ?? []));
    this.pid = await this.mpv.getOr("pid", null);
    await this.readOptions();
    await this.mpv.observe("user-data/hachidori-mpv/options", () => { void this.readOptions(); });

    this.window = new BrowserWindow({
      show: false, frame: false, transparent: true, backgroundColor: "#00000000", hasShadow: false,
      resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, focusable: false, thickFrame: false, roundedCorners: false,
      webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false,
        backgroundThrottling: false },
    });
    this.window.setIgnoreMouseEvents(true, { forward: true });
    this.window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    if (DEBUG) this.window.webContents.openDevTools({ mode: "detach" });
    // A (re)loaded page starts empty: give it everything it draws from.
    this.window.webContents.on("did-finish-load", () => {
      this.interactive = true;
      this.setInteractive(false);
      void this.readOptions();
      const [width, height] = this.window.getContentSize();
      this.send("hdmpv:layout", { width, height });
      this.pushState();
    });
    await this.window.loadFile(path.join(__dirname, "overlay.html"));
    this.window.on("closed", () => this.close());

    const windowId = await this.mpv.getOr("window-id", null);
    this.tracker = new WindowTracker({
      overlay: this.window,
      windowId,
      onBounds: (dip, physical) => {
        this.window.setBounds(dip);
        this.physical = physical;
        if (!this.window.isVisible()) this.window.showInactive();
        this.send("hdmpv:layout", { width: dip.width, height: dip.height });
      },
      onHidden: () => this.window.hide(),
      onGone: () => this.close(),
    });
    if (!this.tracker.start()) {
      log("mpv's window cannot be tracked here; the overlay covers the screen mpv is on.");
      const { screen } = require("electron");
      const bounds = screen.getPrimaryDisplay().bounds;
      this.window.setBounds(bounds);
      this.window.setAlwaysOnTop(true, "floating");
      this.window.showInactive();
      this.send("hdmpv:layout", { width: bounds.width, height: bounds.height });
    }

    const observe = (name, key) => this.mpv.observe(name, value => {
      this.state[key] = value;
      this.pushState();
    });
    await observe("sub-text", "subText");
    await observe("sub-start", "subStart");
    await observe("sub-end", "subEnd");
    await observe("pause", "pause");
    await observe("osd-dimensions", "osd");
    await observe("media-title", "title");
    await observe("fullscreen", "fullscreen");
    await this.mpv.observe("mouse-pos", value => this.onMpvMouse(value));

    await this.mpv.scriptMessage("hachidori-mpv-attached");
    this.heartbeat = setInterval(() => { void this.mpv.scriptMessage("hachidori-mpv-heartbeat"); }, HEARTBEAT_MS);
    if (this.options.auto_link !== false) void ensureLinked((text, seconds) => this.notify(text, seconds));
    log(`attached to mpv at ${this.ipcPath}`);
  }

  async readOptions() {
    try {
      this.options = JSON.parse(await this.mpv.get("user-data/hachidori-mpv/options"));
    } catch {
      this.options = {};
    }
    let userCss = "";
    if (this.options.config_dir) {
      try { userCss = fs.readFileSync(path.join(this.options.config_dir, "script-opts", "hachidori-mpv.css"), "utf8"); } catch {}
    }
    this.send("hdmpv:options", { ...this.options, userCss });
  }

  pushState() {
    this.send("hdmpv:state", this.state);
  }

  onClientMessage(args) {
    if (args[0] !== "hachidori-mpv-overlay") return;
    if (args[1] === "detach") this.close();
    else if (args[1] === "settings") openSettings();
    else if (args[1] === "reload") this.window?.webContents.reload();
  }

  // mpv still sees the pointer while the overlay lets clicks through; that
  // is how the overlay notices the pointer reaching a subtitle on systems
  // that do not forward mouse moves to click-through windows.
  onMpvMouse(value) {
    if (!value || this.interactive || !this.window || !this.state.osd || !this.window.isVisible()) return;
    const [width, height] = this.window.getContentSize();
    const scaleX = width / (this.state.osd.w || width);
    const scaleY = height / (this.state.osd.h || height);
    this.send("hdmpv:pointer", { x: value.x * scaleX, y: value.y * scaleY, hover: value.hover });
  }

  setInteractive(on) {
    if (!this.window || this.window.isDestroyed() || on === this.interactive) return;
    this.interactive = on;
    this.window.setIgnoreMouseEvents(!on, { forward: true });
  }

  async hover(on) {
    if (!this.options.pause_on_hover) return;
    if (on) {
      if (!this.state.pause) {
        this.pausedByHover = true;
        await this.mpv.set("pause", true).catch(() => {});
      }
    } else if (this.pausedByHover) {
      this.pausedByHover = false;
      if (this.state.pause) await this.mpv.set("pause", false).catch(() => {});
    }
  }

  async noteAdded(detail) {
    const line = detail.line ?? this.lookupLine;
    if (!this.options.fill_screenshot && !this.options.fill_sentence_audio) return;
    try {
      const context = await bridge(`ankiContext(${JSON.stringify(detail.templateId ?? null)})`).catch(() => ({}));
      const result = await fillNoteMedia({ mpv: this.mpv, options: this.options, pid: this.pid, log,
        context: { noteId: detail.noteId, templateName: context.templateName, ankiUrl: context.url, ankiKey: context.apiKey, line } });
      const parts = [];
      if (result.filled.length) parts.push(`added ${result.filled.join(", ")}`);
      if (result.warnings?.length) parts.push(result.warnings.join(" "));
      if (parts.length) this.notify(`note ${detail.noteId}: ${parts.join(". ")}`, result.warnings?.length ? 6 : 2.5);
      log(`note ${detail.noteId}:`, parts.join(". ") || "nothing to fill");
    } catch (error) {
      log(`note ${detail.noteId}: ${error.message}`);
      this.notify(`could not add mpv media to note ${detail.noteId}: ${error.message}`, 6);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    this.tracker?.stop();
    if (this.pausedByHover && this.state.pause) void this.mpv.set("pause", false).catch(() => {});
    void this.mpv.scriptMessage("hachidori-mpv-detached").finally(() => this.mpv.close());
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    sessions.delete(this.ipcPath);
    log(`detached from ${this.ipcPath}`);
    if (sessions.size === 0) setTimeout(() => { if (sessions.size === 0) app.quit(); }, 1500);
  }
}

function sessionFor(sender) {
  for (const entry of sessions.values()) if (entry.window?.webContents === sender) return entry;
  return null;
}

ipcMain.on("hdmpv:interactive", (event, on) => sessionFor(event.sender)?.setInteractive(on === true));
ipcMain.on("hdmpv:hover", (event, on) => { void sessionFor(event.sender)?.hover(on === true); });
ipcMain.on("hdmpv:lookup-line", (event, line) => {
  const entry = sessionFor(event.sender);
  if (entry) entry.lookupLine = line;
});
ipcMain.on("hdmpv:note", (event, detail) => { void sessionFor(event.sender)?.noteAdded(detail); });
ipcMain.on("hdmpv:focus-mpv", event => sessionFor(event.sender)?.tracker?.focusMpv());
ipcMain.handle("hdmpv:open-external", (_event, url) => {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("only web links open");
  if (parsed.username || parsed.password) throw new Error("links with credentials do not open");
  return shell.openExternal(parsed.toString());
});

async function attach(ipcPath) {
  if (!ipcPath || sessions.has(ipcPath)) return;
  await ready;
  const entry = new OverlaySession(ipcPath);
  sessions.set(ipcPath, entry);
  try {
    await entry.start();
  } catch (error) {
    log(`could not attach to ${ipcPath}: ${error.message}`);
    entry.notify(`overlay error: ${error.message}`, 6);
    entry.close();
  }
}

app.on("second-instance", (_event, argv, _cwd, data) => {
  void attach(data?.ipc ?? argValue(argv, "mpv-ipc"));
});

app.on("window-all-closed", () => {
  // Hidden engine and bridge windows keep the app alive; sessions decide.
});

app.whenReady().then(async () => {
  ready = (async () => {
    await loadHachidori();
    await startEngine();
    await startBridge();
  })();
  try {
    await ready;
  } catch (error) {
    log(error.message);
    const mpv = new MpvIpc(firstIpc);
    await mpv.connect(3000).catch(() => {});
    await mpv.scriptMessage("hachidori-mpv-osd", `overlay error: ${error.message}`, 8);
    mpv.close();
    app.quit();
    return;
  }
  if (firstIpc) await attach(firstIpc);
  else if (process.argv.includes("--settings")) openSettings();
  else app.quit();
});
