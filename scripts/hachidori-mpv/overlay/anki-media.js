// SPDX-License-Identifier: GPL-3.0-or-later
// The media Hachidori cannot take inside mpv: the video frame for
// {screenshot}/{gif} fields and the subtitle line's audio for
// {sentence-audio}. Hachidori adds the note exactly as in the browser; this
// fills those fields of the new note afterwards, only where they are empty.
"use strict";

const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// The sentence-audio field the Kiku, Lapis and Senren presets leave blank,
// filled the way Hachidori's own Netflix mining fills it.
const SENTENCE_AUDIO_FIELDS = [["kiku", "SentenceAudio"], ["lapis", "SentenceAudio"], ["senren", "sentenceAudio"]];
const PICTURE_MARKER = /\{(?:screenshot|gif)\}/i;
const SENTENCE_AUDIO_MARKER = /\{sentence-audio\}/i;

function run(command, args, timeout = 60000) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${path.basename(command)} failed: ${String(stderr || error.message).trim().split("\n").slice(-3).join(" ")}`;
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

async function mpvExecutableDir(pid) {
  if (!pid) return null;
  try {
    if (process.platform === "linux") return path.dirname(await fs.readlink(`/proc/${pid}/exe`));
    if (process.platform === "win32") {
      const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `(Get-Process -Id ${Number(pid)}).Path`], 10000);
      const exe = out.trim();
      return exe ? path.dirname(exe) : null;
    }
  } catch {}
  return null;
}

const ffmpegCache = new Map();
async function findFfmpeg(options, pid) {
  if (options.ffmpeg_path) return options.ffmpeg_path;
  if (ffmpegCache.has(pid)) return ffmpegCache.get(pid);
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  let found = null;
  const dir = await mpvExecutableDir(pid);
  if (dir && fsSync.existsSync(path.join(dir, exe))) found = path.join(dir, exe);
  if (!found) {
    try { await run(exe, ["-version"], 10000); found = exe; } catch {}
  }
  ffmpegCache.set(pid, found);
  return found;
}

function safeName(value) {
  return String(value || "mpv").replace(/\.[a-z0-9]{2,4}$/i, "").replace(/[^\p{L}\p{N}_-]+/gu, "_")
    .replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 60) || "mpv";
}

function stamp(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  return `${h}h${String(m).padStart(2, "0")}m${String(s).padStart(2, "0")}s${String(ms % 1000).padStart(3, "0")}`;
}

class AnkiConnect {
  constructor(url, key) {
    this.url = url || "http://127.0.0.1:8765";
    this.key = key || "";
  }
  async invoke(action, params = {}) {
    const body = { action, version: 6, params };
    if (this.key) body.key = this.key;
    const response = await fetch(this.url, { method: "POST", body: JSON.stringify(body) });
    const reply = await response.json();
    if (reply.error) throw new Error(`AnkiConnect ${action}: ${reply.error}`);
    return reply.result;
  }
}

async function cardFormats(relayUrl) {
  if (!relayUrl) return [];
  try {
    const response = await fetch(`${relayUrl.replace(/\/$/, "")}/ankiCardFormats`, {
      method: "POST", body: "{}", signal: AbortSignal.timeout(4000) });
    const formats = await response.json();
    return Array.isArray(formats) ? formats : [];
  } catch {
    return [];
  }
}

// The fields this note's Template maps to {screenshot}/{gif} and
// {sentence-audio}, with the script-opts overrides on top.
function targetFields({ format, model, options }) {
  const entries = Object.entries(format?.fields ?? {});
  const value = entry => typeof entry === "string" ? entry : String(entry?.value ?? "");
  const picture = entries.filter(([, entry]) => PICTURE_MARKER.test(value(entry))).map(([field]) => field);
  const audio = entries.filter(([, entry]) => SENTENCE_AUDIO_MARKER.test(value(entry))).map(([field]) => field);
  if (audio.length === 0) {
    const family = SENTENCE_AUDIO_FIELDS.find(([name]) => String(model).toLowerCase().includes(name));
    const blank = family && entries.find(([field, entry]) => field === family[1] && value(entry).trim() === "");
    if (blank) audio.push(family[1]);
  }
  return {
    picture: options.screenshot_field ? [options.screenshot_field] : picture,
    audio: options.sentence_audio_field ? [options.sentence_audio_field] : audio,
  };
}

async function takeScreenshot({ mpv, ffmpeg, options, base, tmp }) {
  const format = String(options.screenshot_format || "webp").toLowerCase();
  const raw = path.join(tmp, `${base}.png`);
  if (!ffmpeg) {
    const direct = path.join(tmp, `${base}.${format}`);
    await mpv.commandNamed({ name: "screenshot-to-file", filename: direct, flags: "video" });
    return direct;
  }
  await mpv.commandNamed({ name: "screenshot-to-file", filename: raw, flags: "video" });
  const out = path.join(tmp, `${base}.${format}`);
  const height = Number(options.screenshot_height) || 0;
  const quality = Math.min(100, Math.max(1, Number(options.screenshot_quality) || 80));
  const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", raw];
  if (height > 0) args.push("-vf", `scale=-2:'min(${height},ih)'`);
  if (format === "webp") args.push("-c:v", "libwebp", "-quality", String(quality));
  else if (format === "jpg" || format === "jpeg") args.push("-q:v", String(Math.round(2 + (100 - quality) / 100 * 29)));
  else if (format === "avif") args.push("-c:v", "libaom-av1", "-still-picture", "1", "-crf", String(Math.round(63 - quality * 0.5)));
  args.push("-frames:v", "1", out);
  await run(ffmpeg, args);
  await fs.rm(raw, { force: true });
  return out;
}

const encoderCache = new Map();
async function hasEncoder(ffmpeg, encoder) {
  const key = `${ffmpeg}\n${encoder}`;
  if (!encoderCache.has(key)) {
    encoderCache.set(key, run(ffmpeg, ["-hide_banner", "-encoders"], 15000)
      .then(out => new RegExp(`\\s${encoder}\\s`).test(out), () => false));
  }
  return encoderCache.get(key);
}

// Anki Miner's animated picture: AVIF (libsvtav1) or WebP (libwebp_anim),
// falling back from AVIF to WebP when this ffmpeg has no SVT-AV1.
async function animatedFormat(ffmpeg, configured) {
  const wanted = String(configured || "avif").toLowerCase() === "webp" ? "webp" : "avif";
  if (wanted === "avif" && await hasEncoder(ffmpeg, "libsvtav1")) return "avif";
  if (await hasEncoder(ffmpeg, "libwebp_anim")) return "webp";
  return null;
}

// The clip's span, as Anki Miner chooses it: from the subtitle's start, as
// long as clip_duration but never longer than the subtitle (0.5 s at
// least); or, with match_audio (or a clip length of 0), the sentence
// audio's padded span.
function animatedSpan(options, line) {
  const padStart = Number(options.audio_pad_start) || 0;
  const padEnd = Number(options.audio_pad_end) || 0;
  const configured = Number(options.screenshot_animated_clip_duration);
  const duration = Math.max(0, line.end - line.start);
  if (options.screenshot_animated_match_audio === true || configured === 0) {
    const start = Math.max(0, line.start - padStart);
    return { start, length: Math.max(line.end + padEnd - start, 0.5) };
  }
  return { start: line.start, length: Math.min(Number.isFinite(configured) && configured > 0 ? configured : 2, Math.max(duration, 0.5)) };
}

async function takeAnimated({ mpv, ffmpeg, options, base, tmp, line }) {
  if (!ffmpeg) throw new Error("ffmpeg was not found; set ffmpeg_path in hachidori-mpv.conf");
  if (!(Number.isFinite(line?.start) && Number.isFinite(line?.end))) throw new Error("the subtitle line has no timing");
  const format = await animatedFormat(ffmpeg, options.screenshot_animated_format);
  if (!format) throw new Error("this ffmpeg has neither libsvtav1 nor libwebp_anim");
  const input = await mpv.get("path");
  const { start, length } = animatedSpan(options, line);
  const fps = Math.max(1, Math.round(Number(options.screenshot_animated_fps) || 20));
  const height = Math.max(16, Math.round(Number(options.screenshot_animated_height) || 720));
  const quality = Math.max(0, Math.min(100, Math.round(Number(options.screenshot_animated_quality) || 0)));
  const out = path.join(tmp, `${base}.${format}`);
  const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-ss", start.toFixed(3), "-t", length.toFixed(3), "-i", input, "-an", "-sn", "-dn",
    "-vf", `fps=${fps},scale=-2:'min(${height},ih)'`];
  if (format === "avif") {
    args.push("-c:v", "libsvtav1", "-crf", String(Math.round(63 - quality / 100 * 63)), "-pix_fmt", "yuv420p", "-loop", "0");
  } else {
    args.push("-c:v", "libwebp_anim", "-quality", String(quality), "-loop", "0");
  }
  args.push(out);
  await run(ffmpeg, args, 180000);
  return out;
}

async function cutAudio({ mpv, ffmpeg, options, base, tmp, line }) {
  if (!ffmpeg) throw new Error("ffmpeg was not found; set ffmpeg_path in hachidori-mpv.conf");
  if (!(Number.isFinite(line?.start) && Number.isFinite(line?.end) && line.end > line.start)) {
    throw new Error("the subtitle line has no timing");
  }
  const track = await mpv.getOr("current-tracks/audio", null);
  if (!track) throw new Error("no audio track is playing");
  const input = track.external ? track["external-filename"] : await mpv.get("path");
  const map = track.external ? "0:a:0" : `0:${track["ff-index"]}`;
  const audioDelay = Number(await mpv.getOr("audio-delay", 0)) || 0;
  const start = Math.max(0, line.start - audioDelay - (Number(options.audio_pad_start) || 0));
  const end = line.end - audioDelay + (Number(options.audio_pad_end) || 0);
  const mp3 = String(options.audio_format).toLowerCase() === "mp3";
  const out = path.join(tmp, `${base}.${mp3 ? "mp3" : "ogg"}`);
  await run(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-ss", start.toFixed(3), "-i", input, "-t", (end - start).toFixed(3),
    "-map", map, "-vn", "-sn", "-dn", "-ac", "2",
    ...(mp3 ? ["-c:a", "libmp3lame", "-b:a", String(options.audio_bitrate || "128k")]
      : ["-c:a", "libopus", "-b:a", String(options.audio_bitrate || "64k")]),
    out], 120000);
  return out;
}

async function storeMedia(anki, file) {
  const data = (await fs.readFile(file)).toString("base64");
  const name = path.basename(file);
  const stored = await anki.invoke("storeMediaFile", { filename: name, data });
  await fs.rm(file, { force: true });
  return typeof stored === "string" && stored ? stored : name;
}

// Fills the new note's empty picture and sentence-audio fields.
// `context`: { noteId, templateName, line, ankiUrl, ankiKey }
async function fillNoteMedia({ mpv, options, context, pid, log }) {
  const anki = new AnkiConnect(options.ankiconnect_url || context.ankiUrl, options.ankiconnect_key || context.ankiKey);
  const [info] = await anki.invoke("notesInfo", { notes: [context.noteId] });
  if (!info) throw new Error(`note ${context.noteId} was not found`);
  const formats = await cardFormats(options.relay_api_url);
  const format = formats.find(entry => context.templateName && entry.name === context.templateName)
    ?? formats.find(entry => entry.model === info.modelName) ?? null;
  const fields = targetFields({ format, model: info.modelName, options });
  const empty = field => Object.hasOwn(info.fields, field) && !String(info.fields[field].value ?? "").trim();
  const pictureFields = options.fill_screenshot ? fields.picture.filter(empty) : [];
  const audioFields = options.fill_sentence_audio ? fields.audio.filter(empty) : [];
  if (pictureFields.length === 0 && audioFields.length === 0) {
    log(`note ${context.noteId}: no empty picture or sentence-audio field to fill`);
    return { filled: [] };
  }

  const ffmpeg = await findFfmpeg(options, pid);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "hachidori-mpv-"));
  const title = await mpv.getOr("media-title", "mpv");
  // The picture is the frame on screen; the audio is the line. Equal names
  // are equal media, so a second note from the same frame or line shares it.
  const now = Number(await mpv.getOr("time-pos", 0)) || 0;
  const lineStart = Number.isFinite(context.line?.start) ? context.line.start : now;
  const prefix = `hachidori-mpv_${safeName(title)}`;
  const update = {};
  const warnings = [];
  try {
    if (pictureFields.length) {
      try {
        let file;
        if (options.screenshot_animated === true) {
          const base = `${prefix}_${stamp(lineStart)}-${stamp(context.line?.end ?? lineStart)}_anim`;
          file = await takeAnimated({ mpv, ffmpeg, options, base, tmp, line: context.line });
        } else {
          file = await takeScreenshot({ mpv, ffmpeg, options, base: `${prefix}_${stamp(now)}`, tmp });
        }
        const name = await storeMedia(anki, file);
        for (const field of pictureFields) update[field] = `<img src="${name}">`;
      } catch (error) {
        warnings.push(`Screenshot: ${error.message}`);
      }
    }
    if (audioFields.length) {
      try {
        const base = `${prefix}_${stamp(lineStart)}-${stamp(context.line?.end ?? lineStart)}`;
        const name = await storeMedia(anki, await cutAudio({ mpv, ffmpeg, options, base, tmp, line: context.line }));
        for (const field of audioFields) update[field] = `[sound:${name}]`;
      } catch (error) {
        warnings.push(`Sentence audio: ${error.message}`);
      }
    }
    if (Object.keys(update).length) {
      await anki.invoke("updateNoteFields", { note: { id: context.noteId, fields: update } });
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
  return { filled: Object.keys(update), warnings };
}

module.exports = { fillNoteMedia, targetFields, findFfmpeg, hasEncoder, animatedSpan, safeName, stamp };
