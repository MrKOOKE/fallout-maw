export function captureApplicationScrollPositions(root, selectors = []) {
  const positions = new Map();
  if (!root) return positions;

  for (const selector of selectors) {
    const elements = selector ? root.querySelectorAll(selector) : [root];
    Array.from(elements ?? []).forEach((element, index) => {
      if (!element) return;
      positions.set(`${selector || ":root"}:${index}`, {
        left: element.scrollLeft ?? 0,
        top: element.scrollTop ?? 0
      });
    });
  }
  return positions;
}

export function restoreApplicationScrollPositions(root, positions = new Map(), selectors = []) {
  if (!root || !positions?.size) return;

  requestAnimationFrame(() => {
    for (const selector of selectors) {
      const elements = selector ? root.querySelectorAll(selector) : [root];
      Array.from(elements ?? []).forEach((element, index) => {
        const position = positions.get(`${selector || ":root"}:${index}`);
        if (!element || !position) return;
        element.scrollLeft = position.left;
        element.scrollTop = position.top;
      });
    }
  });
}
