// SPDX-License-Identifier: GPL-3.0-or-later
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { updateConfText } = require("../conf-file");
const { animatedSpan } = require("../anki-media");

test("a documented default gets its line below the comment", () => {
  const text = "# Picture\n#screenshot_animated=no\n#screenshot_animated_fps=20\n";
  assert.equal(updateConfText(text, { screenshot_animated: true }),
    "# Picture\n#screenshot_animated=no\nscreenshot_animated=yes\n#screenshot_animated_fps=20\n");
});

test("an active line is changed in place and unknown lines are kept", () => {
  const text = "# mine\nfont_size=6\ncustom=1\r\n";
  assert.equal(updateConfText(text, { font_size: 7.5 }), "# mine\nfont_size=7.5\ncustom=1\n");
});

test("a key not in the file is appended", () => {
  assert.equal(updateConfText("", { key_repeat: "Ctrl+r" }), "key_repeat=Ctrl+r\n");
});

test("names and values that would break the file are refused", () => {
  assert.throws(() => updateConfText("", { "bad key": 1 }));
  assert.throws(() => updateConfText("", { font_family: "a\nautostart=no" }));
});

const line = { start: 100, end: 103 };
const pads = { audio_pad_start: 0.2, audio_pad_end: 0.3 };

test("the animated clip starts at the line and is capped by it", () => {
  assert.deepEqual(animatedSpan({ ...pads, screenshot_animated_clip_duration: 2 }, line), { start: 100, length: 2 });
  assert.deepEqual(animatedSpan({ ...pads, screenshot_animated_clip_duration: 5 }, line), { start: 100, length: 3 });
  assert.deepEqual(animatedSpan({ ...pads, screenshot_animated_clip_duration: 5 }, { start: 10, end: 10.1 }), { start: 10, length: 0.5 });
});

test("matching the audio, or a clip length of 0, spans the padded sentence audio", () => {
  const expected = { start: 99.8, length: 3.5 };
  const span = animatedSpan({ ...pads, screenshot_animated_match_audio: true, screenshot_animated_clip_duration: 2 }, line);
  assert.equal(span.start, expected.start);
  assert.ok(Math.abs(span.length - expected.length) < 1e-9);
  const zero = animatedSpan({ ...pads, screenshot_animated_clip_duration: 0 }, line);
  assert.ok(Math.abs(zero.length - expected.length) < 1e-9);
});
