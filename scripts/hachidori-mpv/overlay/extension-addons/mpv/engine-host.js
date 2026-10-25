// SPDX-License-Identifier: GPL-3.0-or-later
// Decides who runs the dictionary engine before the overlay hosts one. Two
// IDBFS engines must never share one store, so the overlay hosts
// offscreen.html itself only where chrome.offscreen is missing (Electron).
import { chromeOffscreenSupported, ensureChromeOffscreen } from "../chrome-offscreen.js";

globalThis.hachidoriMpvEngineHost = (async () => {
  if (!chromeOffscreenSupported()) return false;
  await ensureChromeOffscreen("offscreen.html");
  return true;
})();
