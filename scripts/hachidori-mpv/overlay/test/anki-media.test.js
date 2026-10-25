// SPDX-License-Identifier: GPL-3.0-or-later
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { targetFields, safeName, stamp } = require("../anki-media");

const kiku = {
  name: "Default",
  model: "Kiku",
  fields: {
    Expression: { value: "{expression}" },
    Picture: { value: "{screenshot}" },
    SentenceAudio: { value: "" },
    Sentence: { value: "{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}" },
  },
};

test("a Kiku Template fills Picture and its blank SentenceAudio", () => {
  assert.deepEqual(targetFields({ format: kiku, model: "Kiku", options: {} }),
    { picture: ["Picture"], audio: ["SentenceAudio"] });
});

test("a mapped {sentence-audio} and {gif} are used as mapped", () => {
  const format = { fields: { Image: { value: "{gif}" }, Clip: { value: "{sentence-audio}" }, SentenceAudio: { value: "" } } };
  assert.deepEqual(targetFields({ format, model: "Lapis", options: {} }), { picture: ["Image"], audio: ["Clip"] });
});

test("a SentenceAudio field the user filled is left alone", () => {
  const format = { ...kiku, fields: { ...kiku.fields, SentenceAudio: { value: "{audio}" } } };
  assert.deepEqual(targetFields({ format, model: "Kiku", options: {} }).audio, []);
});

test("an unknown note type without markers gets nothing", () => {
  const format = { fields: { Front: { value: "{expression}" }, Back: { value: "{glossary}" } } };
  assert.deepEqual(targetFields({ format, model: "Basic", options: {} }), { picture: [], audio: [] });
});

test("script-opts overrides win", () => {
  const options = { screenshot_field: "Image", sentence_audio_field: "Audio" };
  assert.deepEqual(targetFields({ format: kiku, model: "Kiku", options }), { picture: ["Image"], audio: ["Audio"] });
});

test("media names are safe and ordered by time", () => {
  assert.equal(safeName("Solo Leveling Season 2 - 13.mkv"), "Solo_Leveling_Season_2_-_13");
  assert.equal(safeName("葬送のフリーレン 第1話.mkv"), "葬送のフリーレン_第1話");
  assert.equal(stamp(599.36), "0h09m59s360");
  assert.equal(stamp(3725.5), "1h02m05s500");
});
