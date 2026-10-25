// SPDX-License-Identifier: GPL-3.0-or-later
// The plugin's Settings window. Every change is saved at once to
// script-opts/hachidori-mpv.conf and applied to every open mpv.
"use strict";

(() => {
  // Anki Miner's animated size presets: [fps, height, quality].
  const ANIMATED_PRESETS = { small: [12, 480, 30], balanced: [20, 720, 30], high: [24, 1080, 50] };

  const SECTIONS = [
    {
      id: "picture", title: "Picture",
      intro: "Hachidori adds the note with your Template. mpv then fills the Template's {screenshot} or {gif} field, when it is empty, with a picture from the video.",
      groups: [
        { fields: [
          { key: "fill_screenshot", type: "switch", label: "Add a picture to the card" },
          { key: "screenshot_animated", type: "segmented", label: "Picture", choices: [[false, "Still frame"], [true, "Animated clip"]],
            help: "An animated clip is a short AVIF or WebP of the line. Larger files and a slower encode; not every Anki client plays animated pictures." },
        ] },
        { title: "Still frame", when: o => !o.screenshot_animated, fields: [
          { key: "screenshot_format", type: "select", label: "Format", choices: [["webp", "WebP"], ["jpg", "JPEG"], ["avif", "AVIF"], ["png", "PNG"]],
            help: "The frame on screen when you mine." },
          { key: "screenshot_height", type: "number", label: "Height", min: 0, max: 4320, step: 10, unit: "px", help: "Scaled down to this height; 0 keeps the video's size. Never enlarged." },
          { key: "screenshot_quality", type: "range", label: "Quality", min: 1, max: 100, step: 1 },
        ] },
        { title: "Animated clip", when: o => o.screenshot_animated, fields: [
          { key: "screenshot_animated_format", type: "select", label: "Animated format", choices: [["avif", "AVIF"], ["webp", "WebP"]],
            help: "AVIF: smaller files; WebP: broader Anki client support.", note: formatNote },
          { key: "screenshot_animated_clip_duration", type: "number", label: "Clip length", min: 0, max: 10, step: 0.5, unit: "s",
            help: "Length of the clip from the subtitle's start, capped by the subtitle's duration. 0 = same as sentence audio: the clip spans the sentence audio instead.",
            after: clipLengthLabel },
          { key: "animated_size", type: "select", label: "Size", virtual: true, choices: [["small", "Small"], ["balanced", "Balanced"], ["high", "High"], ["custom", "Custom"]],
            help: "Frame rate, height and quality for the animated clip.", read: presetOf, write: writePreset },
          { key: "screenshot_animated_fps", type: "number", label: "Frame rate", min: 1, max: 60, step: 1, unit: "fps", when: o => presetOf(o) === "custom" },
          { key: "screenshot_animated_height", type: "number", label: "Height", min: 16, max: 4320, step: 10, unit: "px", when: o => presetOf(o) === "custom" },
          { key: "screenshot_animated_quality", type: "range", label: "Quality", min: 0, max: 100, step: 1, when: o => presetOf(o) === "custom" },
        ] },
      ],
    },
    {
      id: "audio", title: "Sentence audio",
      intro: "The subtitle line's audio goes into the Template's {sentence-audio} field, or the blank SentenceAudio field of Kiku, Lapis and Senren notes.",
      groups: [{ fields: [
        { key: "fill_sentence_audio", type: "switch", label: "Add the sentence audio to the card" },
        { key: "audio_format", type: "segmented", label: "Audio format", choices: [["opus", "Opus"], ["mp3", "MP3"]],
          note: o => o.audio_format === "opus" ? "Opus clips do not play in AnkiMobile on iPhone or iPad. Choose MP3 if you review there." : "" },
        { key: "audio_bitrate", type: "select", label: "Audio bitrate", choices: [["32k", "32 kbps"], ["48k", "48 kbps"], ["64k", "64 kbps"], ["96k", "96 kbps"], ["128k", "128 kbps"], ["192k", "192 kbps"]],
          help: "Higher = better quality, larger files; 64–96 kbps is plenty for speech." },
        { key: "audio_pad_start", type: "number", label: "Padding before", min: 0, max: 5, step: 0.05, unit: "s", help: "Extra time before the subtitle. Also used by repeat." },
        { key: "audio_pad_end", type: "number", label: "Padding after", min: 0, max: 5, step: 0.05, unit: "s", help: "Extra time after the subtitle. Also used by repeat." },
      ] }],
    },
    {
      id: "fields", title: "Card fields",
      intro: "By default the fields come from the Template you mine with. Name a field here to use it instead.",
      groups: [{ fields: [
        { key: "screenshot_field", type: "text", label: "Picture field", placeholder: "From the Template" },
        { key: "sentence_audio_field", type: "text", label: "Sentence audio field", placeholder: "From the Template" },
      ] }],
    },
    {
      id: "playback", title: "Playback & keys",
      intro: "These keys work while the overlay is on and give mpv its usual keys back when it is off.",
      groups: [
        { fields: [
          { key: "key_prev_sub", type: "text", label: "Previous subtitle", placeholder: "Off", help: "An mpv key name, e.g. LEFT, Ctrl+LEFT, a." },
          { key: "key_next_sub", type: "text", label: "Next subtitle", placeholder: "Off" },
          { key: "key_repeat", type: "text", label: "Repeat the line", placeholder: "Off",
            help: "Loops the current subtitle line until you press it again. Previous/next move the loop along." },
        ] },
        { fields: [
          { key: "pause_on_hover", type: "switch", label: "Pause while looking up", help: "Pause while the pointer is on a subtitle or a popup is open, and play on when it leaves." },
          { key: "autostart", type: "switch", label: "Start with every video", help: "Start the overlay when a file with subtitles opens. Otherwise press Alt+h." },
          { key: "hide_mpv_subs", type: "switch", label: "Hide mpv's subtitles", help: "The overlay draws the subtitles itself." },
          { key: "auto_link", type: "switch", label: "Link to the shared Hachidori automatically" },
        ] },
      ],
    },
    {
      id: "subtitles", title: "Subtitles",
      intro: "How the overlay draws subtitles. Sizes are percentages of the video's height. For more, put CSS in script-opts/hachidori-mpv.css.",
      groups: [{ fields: [
        { key: "font_family", type: "text", label: "Font" },
        { key: "font_size", type: "number", label: "Size", min: 1, max: 30, step: 0.1, unit: "%" },
        { key: "font_weight", type: "select", label: "Weight", choices: [[400, "Regular"], [500, "Medium"], [600, "Semibold"], [700, "Bold"], [800, "Extra bold"]] },
        { key: "font_color", type: "color", label: "Colour" },
        { key: "outline_color", type: "color", label: "Outline colour" },
        { key: "outline_size", type: "number", label: "Outline", min: 0, max: 2, step: 0.02 },
        { key: "background_color", type: "text", label: "Background", help: "Any CSS colour, e.g. transparent or rgba(0,0,0,0.5)." },
        { key: "bottom_margin", type: "number", label: "Distance from the bottom", min: 0, max: 50, step: 0.5, unit: "%" },
        { key: "max_width", type: "number", label: "Maximum width", min: 20, max: 100, step: 1, unit: "%" },
      ] }],
    },
    {
      id: "advanced", title: "Advanced",
      groups: [{ fields: [
        { key: "ffmpeg_path", type: "text", label: "ffmpeg", placeholder: "Next to mpv, then PATH" },
        { key: "ankiconnect_url", type: "text", label: "AnkiConnect address", placeholder: "The one Hachidori uses" },
        { key: "ankiconnect_key", type: "text", label: "AnkiConnect key", placeholder: "The one Hachidori uses" },
        { key: "relay_api_url", type: "text", label: "Relay API", help: "The Hachidori Relay's Yomitan-compatible API, which says which fields your Templates map." },
        { key: "debug", type: "switch", label: "Developer tools", help: "Opens the overlay's DevTools the next time it starts." },
      ] }],
    },
  ];

  let options = {};
  let info = {};
  const rows = [];
  const status = document.getElementById("status");

  function presetOf(o) {
    const triple = [o.screenshot_animated_fps, o.screenshot_animated_height, o.screenshot_animated_quality].map(Number);
    for (const [name, preset] of Object.entries(ANIMATED_PRESETS)) {
      if (preset.every((value, index) => value === triple[index])) return name;
    }
    return "custom";
  }

  function writePreset(value) {
    if (value === "custom") {
      return { screenshot_animated_fps: options.screenshot_animated_fps, screenshot_animated_height: options.screenshot_animated_height,
        screenshot_animated_quality: options.screenshot_animated_quality, _custom: true };
    }
    const [fps, height, quality] = ANIMATED_PRESETS[value];
    return { screenshot_animated_fps: fps, screenshot_animated_height: height, screenshot_animated_quality: quality };
  }

  function clipLengthLabel(o) {
    return Number(o.screenshot_animated_clip_duration) === 0 ? "Same as sentence audio" : "";
  }

  function formatNote(o) {
    if (!info.encoders) return "";
    if (!info.ffmpeg) return "ffmpeg was not found: no picture or audio can be made. Set it under Advanced.";
    const { avif, webp } = info.encoders;
    if (o.screenshot_animated_format === "avif" && !avif) {
      return webp ? "This ffmpeg has no SVT-AV1 encoder, so WebP is made instead." : "This ffmpeg can make neither AVIF nor animated WebP.";
    }
    if (o.screenshot_animated_format === "webp" && !webp) return "This ffmpeg has no animated WebP encoder.";
    return "";
  }

  function el(tag, props = {}, children = []) {
    const node = Object.assign(document.createElement(tag), props);
    for (const child of [].concat(children)) if (child) node.append(child);
    return node;
  }

  let customPreset = false;
  let saveChain = Promise.resolve();
  function save(changes) {
    const { _custom, ...real } = changes;
    if (_custom) customPreset = true;
    Object.assign(options, real);
    if (Object.hasOwn(real, "screenshot_animated_clip_duration")) {
      real.screenshot_animated_match_audio = Number(real.screenshot_animated_clip_duration) === 0;
      options.screenshot_animated_match_audio = real.screenshot_animated_match_audio;
    }
    refresh();
    if (Object.keys(real).length === 0) return;
    saveChain = saveChain.then(() => window.hdmpvSettings.save(real)).then(() => {
      status.textContent = "Saved";
      status.className = "ok";
    }, error => {
      status.textContent = `Not saved: ${error.message}`;
      status.className = "error";
    });
  }

  function control(field) {
    const id = `f-${field.key}`;
    const value = () => (field.read ? field.read(options) : options[field.key]);
    let input;
    let sync;
    switch (field.type) {
      case "switch": {
        input = el("input", { type: "checkbox", id });
        input.addEventListener("change", () => save({ [field.key]: input.checked }));
        sync = () => { input.checked = value() === true; };
        return { node: el("span", { className: "switch" }, [input, el("span")]), sync };
      }
      case "segmented": {
        const buttons = field.choices.map(([choice, label]) => {
          const button = el("button", { type: "button", textContent: label });
          button.addEventListener("click", () => save({ [field.key]: choice }));
          return [choice, button];
        });
        sync = () => { for (const [choice, button] of buttons) button.setAttribute("aria-pressed", String(value() === choice)); };
        return { node: el("span", { className: "segmented", role: "group" }, buttons.map(([, b]) => b)), sync };
      }
      case "select": {
        input = el("select", { id }, field.choices.map(([choice, label]) => el("option", { value: String(choice), textContent: label })));
        input.addEventListener("change", () => {
          const choice = field.choices.find(([c]) => String(c) === input.value)[0];
          save(field.write ? field.write(choice) : { [field.key]: choice });
        });
        sync = () => {
          const current = field.key === "animated_size" && customPreset ? "custom" : value();
          input.value = String(current);
        };
        return { node: input, sync };
      }
      case "range": {
        input = el("input", { type: "range", id, min: field.min, max: field.max, step: field.step });
        const out = el("span", { className: "unit" });
        input.addEventListener("input", () => { out.textContent = input.value; });
        input.addEventListener("change", () => save({ [field.key]: Number(input.value) }));
        sync = () => { input.value = String(value()); out.textContent = String(value()); };
        return { node: el("span", { className: "control-inner" }, [input, out]), sync, wide: true };
      }
      case "number": {
        input = el("input", { type: "number", id, min: field.min, max: field.max, step: field.step });
        input.addEventListener("change", () => {
          const number = Number(input.value);
          if (input.value === "" || !Number.isFinite(number)) { sync(); return; }
          save({ [field.key]: Math.min(field.max, Math.max(field.min, number)) });
        });
        const unit = el("span", { className: "unit", textContent: field.unit || "" });
        const after = el("span", { className: "unit" });
        sync = () => {
          if (document.activeElement !== input) input.value = String(value());
          after.textContent = field.after ? field.after(options) : "";
        };
        return { node: el("span", { className: "control-inner" }, [input, unit, after]), sync };
      }
      case "color": {
        input = el("input", { type: "color", id });
        const text = el("input", { type: "text", value: "" });
        input.addEventListener("change", () => save({ [field.key]: input.value }));
        text.addEventListener("change", () => save({ [field.key]: text.value.trim() }));
        sync = () => {
          if (/^#[0-9a-f]{6}$/i.test(value())) input.value = value();
          if (document.activeElement !== text) text.value = value();
        };
        return { node: el("span", { className: "control-inner" }, [input, text]), sync };
      }
      default: {
        input = el("input", { type: "text", id, placeholder: field.placeholder || "", spellcheck: false });
        input.addEventListener("change", () => save({ [field.key]: input.value.trim() }));
        sync = () => { if (document.activeElement !== input) input.value = value() ?? ""; };
        return { node: input, sync };
      }
    }
  }

  function render() {
    const nav = document.getElementById("nav");
    const container = document.getElementById("sections");
    for (const section of SECTIONS) {
      nav.append(el("a", { href: `#${section.id}`, textContent: section.title }));
      const node = el("section", { id: section.id }, [el("h2", { textContent: section.title }),
        section.intro ? el("p", { textContent: section.intro }) : null]);
      for (const group of section.groups) {
        const box = el("div", { className: "group" }, group.title ? el("h3", { textContent: group.title }) : null);
        if (group.when) rows.push({ node: box, when: group.when });
        for (const field of group.fields) {
          const { node: input, sync } = control(field);
          const note = el("div", { className: "note" });
          const row = el("div", { className: "field" }, [
            el("label", { htmlFor: `f-${field.key}`, textContent: field.label }),
            el("div", { className: "control" }, input),
            field.help ? el("div", { className: "help", textContent: field.help }) : null,
            note,
          ]);
          rows.push({ node: row, when: field.when, sync, note: field.note && (() => { note.textContent = field.note(options); }) });
          box.append(row);
        }
        node.append(box);
      }
      container.append(node);
    }
    const links = [...nav.querySelectorAll("a")];
    const main = document.querySelector("main");
    const mark = () => {
      let current = SECTIONS[0].id;
      for (const section of SECTIONS) {
        if (document.getElementById(section.id).offsetTop - main.scrollTop <= 40) current = section.id;
      }
      for (const link of links) link.classList.toggle("active", link.getAttribute("href") === `#${current}`);
    };
    main.addEventListener("scroll", mark, { passive: true });
    mark();
  }

  function refresh() {
    if (presetOf(options) !== "custom") customPreset = false;
    for (const row of rows) {
      if (row.when) row.node.hidden = !row.when(options);
      row.sync?.();
      row.note?.();
    }
  }

  document.getElementById("open-hachidori").addEventListener("click", () => { void window.hdmpvSettings.openHachidori(); });

  window.hdmpvSettings.load().then(loaded => {
    options = loaded.options;
    info = loaded;
    customPreset = presetOf(options) === "custom";
    document.getElementById("conf-path").textContent = loaded.confPath;
    render();
    refresh();
  }, error => {
    status.textContent = `Could not read the settings: ${error.message}`;
    status.className = "error";
  });
})();
