// SPDX-License-Identifier: GPL-3.0-or-later
// A small client for mpv's JSON IPC (a named pipe on Windows, a Unix socket
// elsewhere): commands with replies, property observation and events.
"use strict";

const net = require("node:net");
const { EventEmitter } = require("node:events");

class MpvIpc extends EventEmitter {
  constructor(path) {
    super();
    this.path = path;
    this.socket = null;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.observers = new Map();
    this.closed = false;
  }

  connect(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const attempt = () => {
        const socket = net.connect(this.path);
        socket.setEncoding("utf8");
        socket.once("connect", () => {
          this.socket = socket;
          socket.on("data", chunk => this.onData(chunk));
          socket.on("close", () => this.onClose());
          socket.on("error", error => this.emit("socket-error", error));
          resolve();
        });
        socket.once("error", error => {
          socket.destroy();
          if (Date.now() - started > timeoutMs) reject(error);
          else setTimeout(attempt, 250);
        });
      };
      attempt();
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      this.dispatch(message);
    }
  }

  dispatch(message) {
    if (message.request_id !== undefined && this.pending.has(message.request_id)) {
      const { resolve, reject } = this.pending.get(message.request_id);
      this.pending.delete(message.request_id);
      if (message.error === "success") resolve(message.data);
      else reject(new Error(`mpv: ${message.error}`));
      return;
    }
    if (message.event === "property-change") {
      const handler = this.observers.get(message.id);
      if (handler) handler(message.data, message.name);
      return;
    }
    if (message.event) this.emit(message.event, message);
  }

  onClose() {
    if (this.closed) return;
    this.closed = true;
    for (const { reject } of this.pending.values()) reject(new Error("mpv closed the connection"));
    this.pending.clear();
    this.emit("close");
  }

  command(...args) {
    if (this.closed || !this.socket) return Promise.reject(new Error("mpv is not connected"));
    const request_id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(request_id, { resolve, reject });
      this.socket.write(`${JSON.stringify({ command: args, request_id })}\n`);
    });
  }

  // Named-argument form, for commands such as screenshot-to-file.
  commandNamed(command) {
    if (this.closed || !this.socket) return Promise.reject(new Error("mpv is not connected"));
    const request_id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(request_id, { resolve, reject });
      this.socket.write(`${JSON.stringify({ command, request_id })}\n`);
    });
  }

  get(name) {
    return this.command("get_property", name);
  }

  getOr(name, fallback) {
    return this.get(name).catch(() => fallback);
  }

  set(name, value) {
    return this.command("set_property", name, value);
  }

  observe(name, handler) {
    const id = this.nextId++;
    this.observers.set(id, handler);
    return this.command("observe_property", id, name);
  }

  scriptMessage(...args) {
    return this.command("script-message", ...args.map(String)).catch(() => {});
  }

  close() {
    this.closed = true;
    this.socket?.destroy();
  }
}

module.exports = { MpvIpc };
