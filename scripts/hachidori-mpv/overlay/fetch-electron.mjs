// SPDX-License-Identifier: GPL-3.0-or-later
// Downloads the Electron runtime into node_modules/electron/dist, checked
// against the checksums the electron package ships. Electron's own
// postinstall needs a newer Node than many systems have; this does not.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const electronDir = path.join(here, "node_modules", "electron");
const { version } = JSON.parse(await fs.readFile(path.join(electronDir, "package.json"), "utf8"));
const checksums = JSON.parse(await fs.readFile(path.join(electronDir, "checksums.json"), "utf8"));
const platform = process.env.ELECTRON_INSTALL_PLATFORM || process.platform;
const arch = process.env.ELECTRON_INSTALL_ARCH || process.arch;
const dist = path.join(electronDir, "dist");

try {
  if ((await fs.readFile(path.join(dist, "version"), "utf8")).replace(/^v/, "").trim() === version) {
    console.log(`Electron ${version} is already installed.`);
    process.exit(0);
  }
} catch {}

const name = `electron-v${version}-${platform}-${arch}.zip`;
const expected = checksums[name];
if (!expected) throw new Error(`Electron ${version} has no build named ${name}`);
const url = `https://github.com/electron/electron/releases/download/v${version}/${name}`;
console.log(`Downloading ${name}…`);
const response = await fetch(url);
if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error(`${name}: SHA-256 mismatch`);
const work = await fs.mkdtemp(path.join(os.tmpdir(), "hachidori-mpv-electron-"));
try {
  const zip = path.join(work, name);
  await fs.writeFile(zip, bytes);
  await fs.rm(dist, { recursive: true, force: true });
  await require("extract-zip")(zip, { dir: dist });
  const executable = { win32: "electron.exe", darwin: "Electron.app/Contents/MacOS/Electron" }[platform] ?? "electron";
  if (platform !== "win32") await fs.chmod(path.join(dist, executable), 0o755);
  await fs.writeFile(path.join(electronDir, "path.txt"), executable);
  console.log(`Electron ${version} is ready.`);
} finally {
  await fs.rm(work, { recursive: true, force: true });
}
