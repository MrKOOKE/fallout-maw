export function changedDataIntersectsPaths(changes = {}, watchedPaths = []) {
  const changedPaths = collectChangedLeafPaths(changes);
  if (!changedPaths.length) return false;
  const normalizedWatchedPaths = (watchedPaths ?? [])
    .map(normalizeDocumentPath)
    .filter(Boolean);
  return changedPaths.some(changedPath => normalizedWatchedPaths.some(watchedPath => (
    changedPath === watchedPath
    || changedPath.startsWith(`${watchedPath}.`)
    || watchedPath.startsWith(`${changedPath}.`)
  )));
}

export function collectChangedLeafPaths(value = {}, prefix = "") {
  if (!isTraversableChangeObject(value)) {
    return prefix ? [normalizeDocumentPath(prefix)] : [];
  }
  const entries = Object.entries(value);
  if (!entries.length) return prefix ? [normalizeDocumentPath(prefix)] : [];

  const paths = [];
  for (const [rawKey, child] of entries) {
    const key = normalizeDocumentPath(rawKey);
    if (!key) continue;
    const path = prefix ? `${normalizeDocumentPath(prefix)}.${key}` : key;
    if (isTraversableChangeObject(child) && Object.keys(child).length) {
      paths.push(...collectChangedLeafPaths(child, path));
    } else {
      paths.push(normalizeDocumentPath(path));
    }
  }
  return paths.filter(Boolean);
}

function normalizeDocumentPath(path = "") {
  return String(path ?? "")
    .split(".")
    .map(segment => segment.startsWith("-=") ? segment.slice(2) : segment)
    .filter(Boolean)
    .join(".");
}

function isTraversableChangeObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
