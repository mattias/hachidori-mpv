// SPDX-License-Identifier: GPL-3.0-or-later
// Keeps an overlay window over mpv's video area.
//
// Windows: user32 through koffi. The overlay becomes an owned window of
// mpv's, so it follows mpv's z-order, hides when mpv is minimised and never
// floats above other programs.
// X11: xwininfo/xprop polling, always-on-top only while mpv is active.
"use strict";

const { execFile } = require("node:child_process");
const { screen } = require("electron");

const POLL_MS = 80;

function createWin32() {
  const koffi = require("koffi");
  const user32 = koffi.load("user32.dll");
  const RECT = koffi.struct("HDMPV_RECT", { left: "long", top: "long", right: "long", bottom: "long" });
  const POINT = koffi.struct("HDMPV_POINT", { x: "long", y: "long" });
  const api = {
    IsWindow: user32.func("bool __stdcall IsWindow(intptr hWnd)"),
    IsIconic: user32.func("bool __stdcall IsIconic(intptr hWnd)"),
    IsWindowVisible: user32.func("bool __stdcall IsWindowVisible(intptr hWnd)"),
    GetClientRect: user32.func("bool __stdcall GetClientRect(intptr hWnd, _Out_ HDMPV_RECT *rect)"),
    ClientToScreen: user32.func("bool __stdcall ClientToScreen(intptr hWnd, _Inout_ HDMPV_POINT *point)"),
    SetWindowLongPtrW: user32.func("intptr __stdcall SetWindowLongPtrW(intptr hWnd, int index, intptr value)"),
    GetForegroundWindow: user32.func("intptr __stdcall GetForegroundWindow()"),
    SetForegroundWindow: user32.func("bool __stdcall SetForegroundWindow(intptr hWnd)"),
  };
  const GWLP_HWNDPARENT = -8;
  return {
    read(hwnd) {
      if (!api.IsWindow(hwnd)) return { gone: true };
      if (api.IsIconic(hwnd) || !api.IsWindowVisible(hwnd)) return { hidden: true };
      const rect = {};
      if (!api.GetClientRect(hwnd, rect)) return { hidden: true };
      const origin = { x: 0, y: 0 };
      api.ClientToScreen(hwnd, origin);
      return { physical: { x: origin.x, y: origin.y, width: rect.right - rect.left, height: rect.bottom - rect.top } };
    },
    attach(overlay, hwnd) {
      const own = overlay.getNativeWindowHandle();
      const handle = own.length >= 8 ? own.readBigUInt64LE(0) : BigInt(own.readUInt32LE(0));
      api.SetWindowLongPtrW(handle, GWLP_HWNDPARENT, hwnd);
    },
    focusMpv(hwnd) {
      api.SetForegroundWindow(hwnd);
    },
    toDip(overlay, physical) {
      return screen.screenToDipRect(overlay, physical);
    },
    alwaysOnTop: false,
  };
}

function run(command, args) {
  return new Promise(resolve => {
    execFile(command, args, { timeout: 1000 }, (error, stdout) => resolve(error ? null : stdout));
  });
}

function createX11() {
  return {
    async read(id) {
      const info = await run("xwininfo", ["-id", String(id)]);
      if (info === null) return { gone: true };
      const number = label => Number((info.match(new RegExp(`${label}:\\s*(-?\\d+)`)) || [])[1]);
      if (!/Map State:\s*IsViewable/.test(info)) return { hidden: true };
      const physical = { x: number("Absolute upper-left X"), y: number("Absolute upper-left Y"),
        width: number("Width"), height: number("Height") };
      const active = await run("xprop", ["-root", "_NET_ACTIVE_WINDOW"]);
      const activeId = active ? parseInt((active.match(/0x[0-9a-f]+/i) || ["0"])[0], 16) : null;
      return { physical, active: activeId === null ? true : activeId === Number(id) };
    },
    attach() {},
    focusMpv() {},
    toDip(_overlay, physical) {
      // X11 reports device pixels; Electron's DIPs differ by the display scale.
      const display = screen.getDisplayMatching(physical);
      const scale = display?.scaleFactor || 1;
      return { x: Math.round(physical.x / scale), y: Math.round(physical.y / scale),
        width: Math.round(physical.width / scale), height: Math.round(physical.height / scale) };
    },
    alwaysOnTop: true,
  };
}

function createPlatform() {
  if (process.platform === "win32") return createWin32();
  if (process.platform === "linux" && !process.env.WAYLAND_DISPLAY) return createX11();
  if (process.platform === "linux") {
    // XWayland windows still answer xwininfo when mpv runs with an X11 context.
    return createX11();
  }
  return null;
}

class WindowTracker {
  constructor({ overlay, windowId, onBounds, onHidden, onGone }) {
    this.overlay = overlay;
    this.windowId = windowId;
    this.onBounds = onBounds;
    this.onHidden = onHidden;
    this.onGone = onGone;
    this.platform = createPlatform();
    this.timer = null;
    this.last = "";
    this.busy = false;
    this.attached = false;
  }

  get supported() {
    return this.platform !== null && this.windowId !== null && this.windowId !== undefined;
  }

  start() {
    if (!this.supported) return false;
    this.timer = setInterval(() => { void this.tick(); }, POLL_MS);
    void this.tick();
    return true;
  }

  async tick() {
    if (this.busy || this.overlay.isDestroyed()) return;
    this.busy = true;
    try {
      const state = await this.platform.read(this.windowId);
      if (this.overlay.isDestroyed()) return;
      if (state.gone) { this.stop(); this.onGone?.(); return; }
      if (state.hidden || !state.physical || state.physical.width < 2) {
        if (this.last !== "hidden") { this.last = "hidden"; this.onHidden?.(); }
        return;
      }
      if (!this.attached) {
        this.platform.attach(this.overlay, this.windowId);
        this.attached = true;
      }
      if (this.platform.alwaysOnTop) {
        const focusedOverlay = this.overlay.isFocused();
        this.overlay.setAlwaysOnTop(state.active || focusedOverlay, "floating");
      }
      const dip = this.platform.toDip(this.overlay, state.physical);
      const key = JSON.stringify([dip, state.physical]);
      if (key !== this.last) {
        this.last = key;
        this.onBounds?.(dip, state.physical);
      }
    } catch (error) {
      console.error("[tracker]", error);
    } finally {
      this.busy = false;
    }
  }

  focusMpv() {
    try { this.platform?.focusMpv(this.windowId); } catch {}
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { WindowTracker };
