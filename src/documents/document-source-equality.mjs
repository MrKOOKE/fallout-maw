/** Compare plain persisted document sources without allocating entry/key arrays. */
export function documentSourcesEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b || typeof a !== "object") return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!documentSourcesEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const pa = Object.getPrototypeOf(a);
  const pb = Object.getPrototypeOf(b);
  if ((pa !== Object.prototype && pa !== null) || (pb !== Object.prototype && pb !== null)) {
    return foundry.utils.equals(a, b);
  }
  let count = 0;
  for (const key in a) {
    if (!Object.hasOwn(a, key)) continue;
    if (!Object.hasOwn(b, key) || !documentSourcesEqual(a[key], b[key])) return false;
    count++;
  }
  for (const key in b) if (Object.hasOwn(b, key) && --count < 0) return false;
  return count === 0;
}
