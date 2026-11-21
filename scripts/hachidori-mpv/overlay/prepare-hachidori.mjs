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

// Each hook's edits apply together. A required hook missing from a release
// stops the install; an optional one is skipped with a warning.
const HOOKS = [
  {
    file: "overlay-mode.js",
    edits: [{
      find: "export const OVERLAY_MODE = false;",
      replace: "export const OVERLAY_MODE = true;",
    }],
  },
  {
    // A confirmed add or update: tell the overlay page which note it was.
    file: "anki-content.js",
    edits: [{
      find: "      record.noteIds = [result.noteId];\n",
      replace: "      record.noteIds = [result.noteId];\n"
        + "      window.dispatchEvent(new CustomEvent(\"hachidori-mpv-note\", { detail: JSON.stringify({ noteId: result.noteId,\n"
        + "        state: result.state, templateId: record.templateId ?? null }) }));\n",
    }],
  },
  {
    // A root popup above a subtitle line overlaps that line's top by the gap
    // the overlay page sets (data-hdmpv-popup-gap), so it covers the line
    // above instead of leaving a strip of it between the word and the popup.
    file: "content.js",
    optional: "the popup keeps Hachidori's own distance from the subtitle",
    edits: [
      {
        find: "  function calculatePopupPosition(anchorRect, viewport, vertical, preferBelow = false) {\n",
        replace: "  function calculatePopupPosition(anchorRect, viewport, vertical, preferBelow = false) {\n"
          + "    const hdmpvGap = Number(document.documentElement.dataset.hdmpvPopupGap);\n"
          + "    if (!vertical && !preferBelow && Number.isFinite(hdmpvGap)) {\n"
          + "      const placed = hdmpvPopupPosition(anchorRect, viewport, vertical, preferBelow, hdmpvGap);\n"
          + "      if (placed.placement === \"above\") return placed;\n"
          + "    }\n"
          + "    return hdmpvPopupPosition(anchorRect, viewport, vertical, preferBelow, POPUP_GAP_PX);\n"
          + "  }\n"
          + "  function hdmpvPopupPosition(anchorRect, viewport, vertical, preferBelow, gap) {\n",
      },
      {
        find: "}, viewport, { gap: POPUP_GAP_PX, padding: POPUP_PADDING_PX, vertical, preferBelow });",
        replace: "}, viewport, { gap, padding: POPUP_PADDING_PX, vertical, preferBelow });",
      },
    ],
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

async function download(url) {
  const response = await fetch(url, { headers: { "User-Agent": "hachidori-mpv" } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response;
}

// The commit a release tag names, read from the repository's git refs over
// plain HTTPS. That is not GitHub's REST API, so its 60-requests-an-hour
// limit for unauthenticated callers does not apply.
async function tagCommit(tag) {
  const text = await (await download(`https://github.com/${REPOSITORY}.git/info/refs?service=git-upload-pack`)).text();
  const refs = new Map();
  for (const line of text.split("\n")) {
    const match = line.match(/([0-9a-f]{40}) (refs\/tags\/\S+)/);
    if (match) refs.set(match[2], match[1]);
  }
  // An annotated tag's commit is its peeled ^{} entry.
  return refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`) ?? null;
}

// The release's Chrome zip and checksum file. Hachidori names them after the
// tag's commit (hachidori-0.5.2-6cd6124abaa1-chrome.zip), so they are found
// without the REST API; the API, with GITHUB_TOKEN when set, is the fallback.
async function releaseAssets(tag) {
  const base = `https://github.com/${REPOSITORY}/releases/download/${encodeURIComponent(tag)}`;
  try {
    const commit = await tagCommit(tag);
    if (commit) {
      const stem = `hachidori-${tag}-${commit.slice(0, 12)}`;
      const zip = { name: `${stem}-chrome.zip`, url: `${base}/${stem}-chrome.zip` };
      const probe = await fetch(zip.url, { method: "HEAD", headers: { "User-Agent": "hachidori-mpv" } });
      if (probe.ok) return { zip, sums: { name: `${stem}-SHA256SUMS.txt`, url: `${base}/${stem}-SHA256SUMS.txt` } };
    }
  } catch {
    // Fall through to the API.
  }
  const headers = { "User-Agent": "hachidori-mpv", Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases/tags/${encodeURIComponent(tag)}`, { headers });
  if (response.status === 403 || response.status === 429) {
    throw new Error("GitHub's API limit for this network is used up and the release files could not be found without it. "
      + "Try again in an hour, or set GITHUB_TOKEN to a GitHub token first.");
  }
  if (response.status === 404) throw new Error(`Hachidori has no release ${tag}`);
  if (!response.ok) throw new Error(`GitHub API: HTTP ${response.status}`);
  const release = await response.json();
  const asset = suffix => {
    const found = release.assets.find(entry => entry.name.endsWith(suffix));
    return found ? { name: found.name, url: found.browser_download_url } : null;
  };
  return { zip: asset("-chrome.zip"), sums: asset("-SHA256SUMS.txt") };
}

async function downloadRelease(tag, into) {
  const { zip, sums } = await releaseAssets(tag);
  if (!zip) throw new Error(`Hachidori ${tag} has no Chrome zip`);
  console.log(`Downloading ${zip.name}…`);
  const bytes = Buffer.from(await (await download(zip.url)).arrayBuffer());
  if (sums) {
    const text = await (await download(sums.url)).text();
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
    let text = (await fs.readFile(file, "utf8")).replaceAll("\r\n", "\n");
    const pending = hook.edits.filter(edit => !text.includes(edit.replace));
    if (pending.some(edit => !text.includes(edit.find))) {
      if (hook.optional) {
        console.warn(`Warning: ${hook.file} has changed, so ${hook.optional}.`);
        continue;
      }
      throw new Error(`${hook.file} has changed: this Hachidori release needs an updated hachidori-mpv.`);
    }
    for (const edit of pending) text = text.replace(edit.find, edit.replace);
    await fs.writeFile(file, text);
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
        "content.js lets a root popup overlap its subtitle line by the overlay page's data-hdmpv-popup-gap.",
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
  // Not process.exit(): on Windows, Node 24 can abort with a libuv assertion
  // when it exits while fetch's sockets are still closing.
  process.exitCode = 1;
});
