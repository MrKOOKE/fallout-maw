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
  existingNames = [],
  idFactory = null
} = {}) {
  const copy = cloneCatalogValue(ability ?? {});
  const result = {
    ...copy,
    id: String(id ?? "").trim(),
    name: getAbilityCopyName(copy?.name, existingNames)
  };
  remapEvolutionFamilyIds(result, {
    originalRootId: String(copy?.id ?? "").trim(),
    idFactory
  });
  return result;
}

function remapEvolutionFamilyIds(rootAbility, { originalRootId = "", idFactory = null } = {}) {
  const idMap = new Map();
  const occupied = new Set([String(rootAbility?.id ?? "").trim()].filter(Boolean));
  if (originalRootId && rootAbility.id) idMap.set(originalRootId, rootAbility.id);

  const allocateId = oldId => {
    const generated = typeof idFactory === "function"
      ? idFactory(oldId)
      : globalThis.foundry?.utils?.randomID?.();
    const base = String(generated ?? "").trim() || `${String(oldId ?? "evolution").trim() || "evolution"}-copy`;
    if (!occupied.has(base)) {
      occupied.add(base);
      return base;
    }
    for (let suffix = 2; suffix < Number.MAX_SAFE_INTEGER; suffix += 1) {
      const candidate = `${base}-${suffix}`;
      if (occupied.has(candidate)) continue;
      occupied.add(candidate);
      return candidate;
    }
    return `${base}-${Date.now()}`;
  };

  const assignIds = ability => {
    for (const node of ability?.system?.evolution?.nodes ?? []) {
      const oldId = String(node?.id ?? node?.ability?.id ?? "").trim();
      const nextId = allocateId(oldId);
      if (oldId) idMap.set(oldId, nextId);
      node.id = nextId;
      node.ability ??= {};
      node.ability.id = nextId;
      assignIds(node.ability);
    }
  };
  assignIds(rootAbility);

  const remapReferences = ability => {
    const evolution = ability?.system?.evolution;
    for (const link of evolution?.links ?? []) {
      link.fromId = idMap.get(String(link.fromId ?? "")) ?? link.fromId;
      link.toId = idMap.get(String(link.toId ?? "")) ?? link.toId;
      link.id = allocateId(link.id);
    }
    for (const requirement of ability?.system?.acquisitionRequirements ?? []) {
      if (!Array.isArray(requirement?.abilityIds)) continue;
      requirement.abilityIds = requirement.abilityIds.map(sourceId => idMap.get(String(sourceId ?? "")) ?? sourceId);
    }
    for (const node of evolution?.nodes ?? []) remapReferences(node.ability);
  };
  remapReferences(rootAbility);
}
