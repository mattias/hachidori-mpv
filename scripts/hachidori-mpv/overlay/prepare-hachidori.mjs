// SPDX-License-Identifier: GPL-3.0-or-later
// Downloads the Hachidori Chrome release and prepares it for the overlay:
// overlay mode on, a fixed extension key, the mpv pages and one hook that
// reports added notes so mpv can fill their screenshot and sentence audio.
//
//   node prepare-hachidori.mjs                 the release your browser's Hachidori runs
//   node prepare-hachidori.mjs --release 0.3.1
//   node prepare-hachidori.mjs --source C:\path\to\hachidori\extension
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, "hachidori");
const pkg = JSON.parse(await fs.readFile(path.join(here, "package.json"), "utf8"));
const REPOSITORY = "bee-san/hachidori";

// Gives the overlay's extension one stable ID (kebloocgpfnbjcfjicfglnbopdhldech),
// so its storage and link survive updates.
const MANIFEST_KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyRezfLZ2aoa4tEHI5ZmPsgIMxsLTvyD2hPdEzb0zKstB4CDIsLnx/LOOHKM7b6kY9EkEF5mvpCzWG3XCGujLuxKlptf5aeKzqpuk0DWarqtfIrdq0rEKpbv0zGCPA3PwhITgphafSjTcWz167bQKAcb1vkBarn6gEto4AeLiSqpQDumjIYMWO/JJdT7GVnru7s4OtmEWRi3rxb9AYv4x1MT5cLPoB/7m/glZLt567cWrUPfJRzTa9KCGYuFhw9At94apJg4pK3jgrMNZM2zxtsH6hjpMPZitjcvHDCHxEr0I8XtS2KlbgY12WzRww3BHzM/udD46ODt+vxvUXOLhewIDAQAB";

const HOOKS = [
  {
    file: "overlay-mode.js",
    find: "export const OVERLAY_MODE = false;",
    replace: "export const OVERLAY_MODE = true;",
  },
  {
    // A confirmed add or update: tell the overlay page which note it was.
    file: "anki-content.js",
    find: "      record.noteIds = [result.noteId];\n",
    replace: "      record.noteIds = [result.noteId];\n"
      + "      window.dispatchEvent(new CustomEvent(\"hachidori-mpv-note\", { detail: JSON.stringify({ noteId: result.noteId,\n"
      + "        state: result.state, templateId: record.templateId ?? null }) }));\n",
  },
];

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function hostVersion() {
  try {
    const response = await fetch("http://127.0.0.1:19633/yomitanVersion", {
      method: "POST", body: "{}", signal: AbortSignal.timeout(3000) });
    const { version } = await response.json();
    return typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version) ? version : null;
  } catch {
    return null;
  }
}

async function github(url) {
  const headers = { "User-Agent": "hachidori-mpv", Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response;
}

async function downloadRelease(tag, into) {
  const release = await (await github(`https://api.github.com/repos/${REPOSITORY}/releases/tags/${tag}`)).json();
  const zip = release.assets.find(asset => asset.name.endsWith("-chrome.zip"));
  const sums = release.assets.find(asset => asset.name.endsWith("-SHA256SUMS.txt"));
  if (!zip) throw new Error(`Hachidori ${tag} has no Chrome zip`);
  console.log(`Downloading ${zip.name}…`);
  const bytes = Buffer.from(await (await github(zip.browser_download_url)).arrayBuffer());
  if (sums) {
    const text = await (await github(sums.browser_download_url)).text();
    const line = text.split("\n").find(entry => entry.trim().endsWith(zip.name));
    const expected = line?.trim().split(/\s+/)[0]?.toLowerCase();
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (expected && expected !== actual) throw new Error(`${zip.name}: SHA-256 mismatch`);
    if (expected) console.log("SHA-256 verified.");
  }
  const file = path.join(into, zip.name);
  await fs.writeFile(file, bytes);
  const extract = require("extract-zip");
  const out = path.join(into, "unzipped");
  await extract(file, { dir: out });
  // The archive holds the extension at its root or in one folder.
  if (await exists(path.join(out, "manifest.json"))) return { dir: out, tag, commit: zip.name.split("-")[2] ?? null };
  for (const entry of await fs.readdir(out, { withFileTypes: true })) {
    if (entry.isDirectory() && await exists(path.join(out, entry.name, "manifest.json"))) {
      return { dir: path.join(out, entry.name), tag, commit: zip.name.split("-")[2] ?? null };
    }
  }
  throw new Error(`${zip.name} has no manifest.json`);
}

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

async function patch(dir) {
  for (const hook of HOOKS) {
    const file = path.join(dir, hook.file);
    const text = await fs.readFile(file, "utf8");
    const normalised = text.replaceAll("\r\n", "\n");
    if (normalised.includes(hook.replace)) continue;
    if (!normalised.includes(hook.find)) {
      throw new Error(`${hook.file} has changed: this Hachidori release needs an updated hachidori-mpv.`);
    }
    await fs.writeFile(file, normalised.replace(hook.find, hook.replace));
  }
  const manifestFile = path.join(dir, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  manifest.key = MANIFEST_KEY;
  await fs.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.cp(path.join(here, "extension-addons"), dir, { recursive: true });
  return manifest.version;
}

async function main() {
  const source = argument("--source");
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "hachidori-mpv-prepare-"));
  try {
    let from;
    let origin;
    if (source) {
      from = path.resolve(source);
      origin = { source: from };
    } else {
      const requested = argument("--release") ?? process.env.HACHIDORI_RELEASE;
      const tag = requested ?? await hostVersion() ?? pkg.hachidori.fallbackRelease;
      if (!requested) console.log(`Using Hachidori ${tag}${tag === pkg.hachidori.fallbackRelease ? "" : ", the version your browser runs"}.`);
      const downloaded = await downloadRelease(tag, work);
      from = downloaded.dir;
      origin = { repository: `https://github.com/${REPOSITORY}`, release: downloaded.tag, commit: downloaded.commit };
    }
    const staging = path.join(work, "hachidori");
    await fs.cp(from, staging, { recursive: true });
    const version = await patch(staging);
    await fs.writeFile(path.join(staging, "SOURCE.json"), `${JSON.stringify({
      name: "Hachidori", version, ...origin, license: "GPL-3.0-or-later",
      modifications: [
        "overlay-mode.js enables overlay mode.",
        "manifest.json carries a fixed key so the extension keeps one ID.",
        "anki-content.js dispatches hachidori-mpv-note after a confirmed note write.",
        "mpv/ holds the hachidori-mpv engine host and bridge pages.",
      ],
      preparedAt: new Date().toISOString(),
    }, null, 2)}\n`);
    await fs.rm(target, { recursive: true, force: true });
    await fs.cp(staging, target, { recursive: true });
    console.log(`Hachidori ${version} is ready in ${target}`);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`prepare-hachidori: ${error.message}`);
  process.exit(1);
});
