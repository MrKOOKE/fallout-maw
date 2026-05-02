export function getHtmlRoot(html) {
  const HTMLElementClass = globalThis.HTMLElement;
  if (HTMLElementClass && html instanceof HTMLElementClass) return html;
  if (HTMLElementClass && html?.element instanceof HTMLElementClass) return html.element;
  if (HTMLElementClass && html?.[0] instanceof HTMLElementClass) return html[0];
  return html ?? null;
}

export function escapeHtml(value) {
  const element = document.createElement("span");
  element.textContent = String(value);
  return element.innerHTML;
}
