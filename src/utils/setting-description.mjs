import { escapeHtml } from "./dom.mjs";

/** Preserve descriptions entered before the rich text editor was introduced. */
export function prepareSettingDescription(description) {
  const source = String(description ?? "").trim();
  if (!source || /<\/?[a-z][^>]*>/i.test(source)) return source;
  return `<p>${escapeHtml(source).replace(/\r\n?|\n/g, "<br>")}</p>`;
}

export function enrichSettingDescription(description, actor = null) {
  return foundry.applications.ux.TextEditor.implementation.enrichHTML(prepareSettingDescription(description), {
    async: true,
    secrets: actor?.isOwner ?? true,
    relativeTo: actor,
    rollData: actor?.getRollData?.() ?? {}
  });
}
