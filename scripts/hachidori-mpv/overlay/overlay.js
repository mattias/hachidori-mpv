// SPDX-License-Identifier: GPL-3.0-or-later
// The overlay page: draws mpv's current subtitle as page text, so Hachidori's
// own content script scans it, and tells the main process when the window
// must take the mouse (a subtitle or popup under the pointer).
"use strict";

(() => {
  const subtitle = document.getElementById("subtitle");
  const userCss = document.getElementById("user-css");
  const root = document.documentElement;

  let options = {};
  let height = window.innerHeight;
  let state = { subText: "", subStart: null, subEnd: null };
  let shownText = null;
  let popupShown = false;
  let interactive = false;
  let hovering = false;
  let pointer = null;

  function applyStyle() {
    const pct = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback) / 100 * height;
    const fontSize = pct(options.font_size, 5.6);
    root.style.setProperty("--sub-font-size", `${fontSize}px`);
    root.style.setProperty("--sub-bottom", `${pct(options.bottom_margin, 5.5)}px`);
    root.style.setProperty("--sub-outline", `${(Number(options.outline_size) || 0) * fontSize / 4}px`);
    if (options.font_family) root.style.setProperty("--sub-font-family", options.font_family);
    if (options.font_weight) root.style.setProperty("--sub-font-weight", String(options.font_weight));
    if (options.font_color) root.style.setProperty("--sub-color", options.font_color);
    if (options.outline_color) root.style.setProperty("--sub-outline-color", options.outline_color);
    if (options.background_color) root.style.setProperty("--sub-background", options.background_color);
    if (options.max_width) root.style.setProperty("--sub-max-width", `${options.max_width}%`);
    userCss.textContent = options.userCss || "";
  }

  // Only a changed line replaces the text, so an open popup keeps its source.
  // The lines of one subtitle are adjacent inline runs; CSS breaks between
  // them. Hachidori ends a sentence at a block, a <br> or a "\n" text node,
  // and a subtitle wrapped over two lines is still one sentence.
  function render() {
    const text = typeof state.subText === "string" ? state.subText.replace(/\r/g, "").trim() : "";
    if (text === shownText) return;
    shownText = text;
    subtitle.replaceChildren(...text.split("\n").filter(Boolean).map(line => {
      const span = document.createElement("span");
      span.className = "line";
      span.textContent = line;
      return span;
    }));
    subtitle.hidden = text === "";
    if (pointer) update(pointer.x, pointer.y);
  }

  function currentLine() {
    return { text: shownText ?? "", start: state.subStart, end: state.subEnd };
  }

  // Anything under the pointer that is not the transparent page itself is
  // the subtitle or a Hachidori popup.
  function update(x, y) {
    pointer = { x, y };
    const element = x === null ? null : document.elementFromPoint(x, y);
    const overSubtitle = !!element && !subtitle.hidden && subtitle.contains(element);
    const overPopup = !!element && element !== root && element !== document.body
      && element.id !== "stage" && !overSubtitle;
    const wantInteractive = overSubtitle || overPopup || popupShown;
    if (wantInteractive !== interactive) {
      interactive = wantInteractive;
      window.hdmpv.setInteractive(interactive);
    }
    const wantHover = overSubtitle || overPopup || popupShown;
    if (wantHover !== hovering) {
      hovering = wantHover;
      if (hovering) window.hdmpv.lookupLine(currentLine());
      window.hdmpv.hover(hovering);
    }
  }

  window.addEventListener("mousemove", event => update(event.clientX, event.clientY), { passive: true });
  document.addEventListener("mouseleave", () => update(null, null));
  window.addEventListener("blur", () => { if (!popupShown) update(null, null); });

  // A hidden page draws nothing; say so in overlay.log when it happens.
  document.addEventListener("visibilitychange", () => window.hdmpv.log(`page ${document.visibilityState}`));

  window.addEventListener("hachidori-popup-shown", () => {
    popupShown = true;
    window.hdmpv.lookupLine(currentLine());
    if (pointer) update(pointer.x, pointer.y);
  });
  window.addEventListener("hachidori-popup-hidden", () => {
    popupShown = false;
    if (pointer) update(pointer.x, pointer.y);
  });

  window.addEventListener("hachidori-mpv-note", event => {
    let detail = event.detail;
    if (typeof detail === "string") {
      try { detail = JSON.parse(detail); } catch { return; }
    }
    if (!detail || !Number.isSafeInteger(detail.noteId)) return;
    window.hdmpv.note({ noteId: detail.noteId, state: detail.state, templateId: detail.templateId ?? null });
  });

  window.hdmpv.onOptions(value => { options = value || {}; applyStyle(); });
  window.hdmpv.onLayout(value => { height = value.height || window.innerHeight; applyStyle(); });
  window.hdmpv.onState(value => {
    state = value || state;
    if (value?.title) document.title = value.title;
    render();
    subtitle.classList.toggle("repeating", state.repeat === "yes");
  });
  // mpv's pointer, while this window lets clicks through.
  window.hdmpv.onPointer(value => {
    if (!value?.hover) update(null, null);
    else update(value.x, value.y);
  });
  window.addEventListener("resize", () => { height = window.innerHeight; applyStyle(); });
})();
