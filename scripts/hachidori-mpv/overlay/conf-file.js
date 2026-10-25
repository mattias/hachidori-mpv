// SPDX-License-Identifier: GPL-3.0-or-later
// Writes settings into script-opts/hachidori-mpv.conf the way a person
// would: a key's existing line is changed in place, a key that is only
// documented (#key=default) gets its line right below that comment, and
// anything else is appended. Comments and unknown lines are kept.
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

function formatConfValue(value) {
  if (value === true) return "yes";
  if (value === false) return "no";
  return String(value);
}

function escapeKey(key) {
  return key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function updateConfText(text, changes) {
  const lines = text === "" ? [] : text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  for (const [key, value] of Object.entries(changes)) {
    if (!/^[a-z0-9_]+$/.test(key)) throw new Error(`invalid setting name: ${key}`);
    const formatted = formatConfValue(value);
    if (/[\r\n]/.test(formatted)) throw new Error(`${key} cannot hold a line break`);
    const line = `${key}=${formatted}`;
    const active = lines.findIndex(entry => new RegExp(`^\\s*${escapeKey(key)}\\s*=`).test(entry));
    if (active >= 0) {
      lines[active] = line;
      continue;
    }
    const documented = lines.findIndex(entry => new RegExp(`^\\s*#\\s*${escapeKey(key)}\\s*=`).test(entry));
    if (documented >= 0) lines.splice(documented + 1, 0, line);
    else lines.push(line);
  }
  return `${lines.join("\n")}\n`;
}

async function saveConf(configDir, changes) {
  const file = path.join(configDir, "script-opts", "hachidori-mpv.conf");
  let text = "";
  try { text = await fs.readFile(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, updateConfText(text, changes));
  return file;
}

module.exports = { formatConfValue, updateConfText, saveConf };
