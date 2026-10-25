// SPDX-License-Identifier: GPL-3.0-or-later
// The overlay's handle on its own Hachidori: link it to the sharing
// Hachidori, and read the Anki connection and Template names it mirrors.
// Electron's main process calls these with executeJavaScript.
const SHARING_TARGET = "hachidori-sharing";
let counter = 0;

async function send(type, fields = {}, target = SHARING_TARGET) {
  counter += 1;
  const reply = await chrome.runtime.sendMessage({ target, type, requestId: `mpv-${type.replace(/^hd_/, "")}-${counter}`, ...fields });
  if (!reply) throw new Error("Hachidori's service worker did not reply");
  return reply;
}

async function sharingStatus() {
  const reply = await send("hd_sharing_status");
  if (!reply.ok) throw new Error(reply.error || "the sharing status could not be read");
  return reply.sharing;
}

globalThis.hachidoriMpv = {
  async status() {
    const sharing = await sharingStatus();
    return { linked: sharing?.client?.linked === true, client: sharing?.client ?? null, enabled: sharing?.enabled ?? null,
      connected: sharing?.connected ?? null };
  },

  // Links to the Hachidori sharing through Anki on this computer, once.
  // Returns what happened in a few words.
  async ensureLinked() {
    const sharing = await sharingStatus();
    if (sharing?.client?.linked === true) return { linked: true, changed: false };
    const probe = await send("hd_sharing_client_probe", { address: "" });
    if (!probe.ok) return { linked: false, changed: false, error: probe.error || "no sharing Hachidori was found" };
    const link = await send("hd_sharing_client_link", { address: probe.address });
    if (!link.ok) return { linked: false, changed: false, error: link.error || "linking failed" };
    return { linked: true, changed: true, host: probe.display ?? probe.address };
  },

  // The AnkiConnect address and the name of a Template, from the options the
  // link mirrors from the sharing Hachidori.
  async ankiContext(templateId) {
    const { options } = await chrome.storage.local.get("options");
    const anki = options?.anki ?? {};
    const templates = Array.isArray(anki.templates) ? anki.templates : [];
    const template = templates.find(entry => entry?.id === templateId) ?? templates[0] ?? null;
    return {
      url: typeof anki.url === "string" ? anki.url : (typeof template?.url === "string" ? template.url : ""),
      apiKey: typeof anki.apiKey === "string" ? anki.apiKey : (typeof template?.apiKey === "string" ? template.apiKey : ""),
      templateName: typeof template?.name === "string" ? template.name : null,
    };
  },
};
