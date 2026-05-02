export function getHtmlRoot(html) {
  return html?.[0] ?? html ?? null;
}

export function escapeHtml(value) {
  const element = document.createElement("span");
  element.textContent = String(value);
  return element.innerHTML;
}
