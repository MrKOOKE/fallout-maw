/** Update the hacking view without detaching its controls or scroll containers. */
export function syncHackingDOM(current, next) {
  if (current.nodeType !== 1) {
    if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
    return;
  }

  for (const attribute of Array.from(current.attributes)) {
    if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
  }
  for (const attribute of Array.from(next.attributes)) {
    if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
  }

  const keyed = new Map(Array.from(current.childNodes).flatMap(node => {
    const key = nodeKey(node);
    return key ? [[key, node]] : [];
  }));
  let cursor = current.firstChild;
  for (const desired of Array.from(next.childNodes)) {
    const key = nodeKey(desired);
    let match = key ? keyed.get(key) : cursor;
    if (!compatible(match, desired) || (!key && nodeKey(match))) match = null;
    if (match) {
      if (match !== cursor) current.insertBefore(match, cursor);
      syncHackingDOM(match, desired);
    } else {
      match = desired.cloneNode(true);
      current.insertBefore(match, cursor);
    }
    cursor = match.nextSibling;
  }
  while (cursor) {
    const nextSibling = cursor.nextSibling;
    current.removeChild(cursor);
    cursor = nextSibling;
  }
}

function nodeKey(node) {
  if (node?.nodeType !== 1) return "";
  const focus = node.getAttribute("data-focus-key");
  if (focus) return `focus:${focus}`;
  const scroll = node.getAttribute("data-hack-scroll");
  return scroll ? `scroll:${scroll}` : "";
}

function compatible(current, next) {
  return current?.nodeType === next.nodeType && (next.nodeType !== 1 || current.tagName === next.tagName);
}
