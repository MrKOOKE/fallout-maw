function cloneCatalogValue(value) {
  if (typeof globalThis.structuredClone === "function") return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

export function getAbilityCopyName(name = "", existingNames = []) {
  const sourceName = String(name ?? "").trim() || "Способность";
  const copyMatch = sourceName.match(/^(.*?)(?:\s+Копия(?:\s+\d+)?)$/u);
  const baseName = String(copyMatch?.[1] ?? sourceName).trim() || "Способность";
  const copyBaseName = `${baseName} Копия`;
  const occupiedNames = new Set((Array.isArray(existingNames) ? existingNames : [])
    .map(value => String(value ?? "").trim().toLocaleLowerCase("ru"))
    .filter(Boolean));

  if (!occupiedNames.has(copyBaseName.toLocaleLowerCase("ru"))) return copyBaseName;
  for (let copyNumber = 2; copyNumber < Number.MAX_SAFE_INTEGER; copyNumber += 1) {
    const candidate = `${copyBaseName} ${copyNumber}`;
    if (!occupiedNames.has(candidate.toLocaleLowerCase("ru"))) return candidate;
  }
  return `${copyBaseName} ${Date.now()}`;
}

export function createAbilityCatalogCopy(ability = {}, {
  id = "",
  existingNames = []
} = {}) {
  const copy = cloneCatalogValue(ability ?? {});
  return {
    ...copy,
    id: String(id ?? "").trim(),
    name: getAbilityCopyName(copy?.name, existingNames)
  };
}
