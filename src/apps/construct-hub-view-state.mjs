const SCROLLERS = [".construct-hub-layout", ".construct-hub-workspace", ".construct-hub-overview", ".construct-hub-assembly",
  ".construct-hub-inspector", ".construct-hub-operations"];
const CONTROLS = "input,select,textarea,button,summary";

export function getConstructHubDetailKey(detail) {
  return detail.dataset.hubDetails ?? `${detail.parentElement.closest("[data-hub-details]")?.dataset.hubDetails ?? "assembly"}:${
    detail.querySelector(":scope > summary")?.textContent.trim() ?? ""}`;
}

function controlKey(element) {
  if (element.tagName === "SUMMARY") return `summary:${getConstructHubDetailKey(element.parentElement)}`;
  const attributes = Array.from(element.attributes).filter(attribute => attribute.name.startsWith("data-")
    || ["name", "type"].includes(attribute.name)).map(attribute => [attribute.name, attribute.value]);
  return attributes.length ? JSON.stringify([element.tagName, attributes]) : null;
}

function findControl(root, key) {
  return key ? Array.from(root.querySelectorAll(CONTROLS)).find(element => controlKey(element) === key) : null;
}

function isDisplayedControl(element) {
  if (!element?.getClientRects().length) return false;
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (parent.tagName === "DETAILS" && !parent.open && !parent.querySelector(":scope > summary")?.contains(element)) return false;
  }
  return true;
}

function visibleIn(element, scroller) {
  if (!isDisplayedControl(element)) return false;
  const rect = element.getBoundingClientRect(), frame = scroller.getBoundingClientRect();
  return rect.bottom > frame.top && rect.top < frame.bottom;
}

/** Capture at DOM replacement time, after the user's latest scroll and before any content disappears. */
export function captureConstructHubView(root) {
  const focus = root.ownerDocument.activeElement;
  const focused = root.contains(focus) ? focus : null;
  const details = new Map(Array.from(root.querySelectorAll("details"), detail => [getConstructHubDetailKey(detail), detail.open]));
  const scroll = SCROLLERS.map(selector => {
    const element = root.querySelector(selector);
    if (!element) return null;
    const controls = Array.from(element.querySelectorAll(CONTROLS));
    const anchor = element.scrollTop > 0 && (focused && element.contains(focused) && visibleIn(focused, element) ? focused
      : controls.find(control => controlKey(control) && visibleIn(control, element)));
    return { selector, top: element.scrollTop, left: element.scrollLeft, anchor: anchor && controlKey(anchor),
      offset: anchor ? anchor.getBoundingClientRect().top - element.getBoundingClientRect().top : 0 };
  }).filter(Boolean);
  return { details, scroll, focus: focused && controlKey(focused),
    selection: focused && typeof focused.selectionStart === "number" ? [focused.selectionStart, focused.selectionEnd] : null };
}

/** Restore disclosures before scroll ranges, and focus without asking the browser to scroll to the field. */
export function restoreConstructHubView(root, view, detailOverrides = new Map()) {
  if (!view) return;
  for (const detail of root.querySelectorAll("details")) {
    const key = getConstructHubDetailKey(detail);
    detail.dataset.hubDetails = key;
    if (detailOverrides.has(key)) detail.open = detailOverrides.get(key);
    else if (view.details.has(key)) detail.open = view.details.get(key);
  }
  const focus = findControl(root, view.focus);
  if (isDisplayedControl(focus)) {
    focus.focus({ preventScroll: true });
    if (view.selection) focus.setSelectionRange?.(...view.selection);
  }
  // Restore inner panes before their enclosing workspace and the compact outer layout.
  for (const position of [...view.scroll].reverse()) {
    const element = root.querySelector(position.selector);
    if (!element) continue;
    element.scrollLeft = position.left;
    element.scrollTop = position.top;
    const anchor = findControl(element, position.anchor);
    if (isDisplayedControl(anchor)) {
      const top = element.scrollTop + anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - position.offset;
      const maximum = element.scrollHeight - element.clientHeight;
      // Collapsing the fields below the clicked checkbox must not drag that checkbox down to the footer.
      // Keep just enough space below the form to retain the working position until the next update.
      if (element.style && top > maximum) element.style.paddingBottom = `${top - maximum}px`;
      element.scrollTop = top;
    }
  }
}
