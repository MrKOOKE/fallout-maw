const TOOL_CLASS_RANK = Object.freeze({ D: 0, C: 1, B: 2, A: 3, S: 4 });

export const REPAIR_TOOL_AVAILABILITY = Object.freeze({
  available: "available",
  noTargets: "noTargets",
  missingToolType: "missingToolType",
  depleted: "depleted",
  toolSkill: "toolSkill",
  toolClass: "toolClass",
  skillThreshold: "skillThreshold"
});

export function analyzeMassRepairToolAvailability({
  instruments = [],
  requirements = []
} = {}) {
  const normalizedRequirements = Array.isArray(requirements) ? requirements.filter(Boolean) : [];
  if (!normalizedRequirements.length) {
    return createUnavailableResult(
      REPAIR_TOOL_AVAILABILITY.noTargets,
      "Нет предметов для массового ремонта."
    );
  }

  const normalizedInstruments = Array.isArray(instruments) ? instruments.filter(Boolean) : [];
  const typeMatches = createMatches(
    normalizedInstruments,
    normalizedRequirements,
    ({ instrument, requirement }) => (
      String(instrument?.toolKey ?? "").trim() === String(requirement?.toolKey ?? "").trim()
    )
  );
  if (!typeMatches.length) {
    const labels = joinLabels(normalizedRequirements.map(requirement => (
      requirement?.toolLabel ?? requirement?.toolKey
    )));
    return createUnavailableResult(
      REPAIR_TOOL_AVAILABILITY.missingToolType,
      `Нет инструмента требуемого типа для массового ремонта${labels ? `: ${labels}` : "."}`
    );
  }

  const classMatches = typeMatches.filter(({ instrument, requirement }) => (
    toToolClassRank(instrument?.toolClass) >= toToolClassRank(requirement?.toolClass)
  ));
  if (!classMatches.length) {
    const closest = selectClosestClassMatch(typeMatches);
    const requiredClass = normalizeToolClass(closest?.requirement?.toolClass);
    const availableClass = normalizeToolClass(closest?.instrument?.toolClass);
    const toolLabel = String(
      closest?.requirement?.toolLabel
      ?? closest?.requirement?.toolKey
      ?? "ремонта"
    ).trim();
    return createUnavailableResult(
      REPAIR_TOOL_AVAILABILITY.toolClass,
      `Для массового ремонта нужен инструмент «${toolLabel}» класса ${requiredClass} или выше; доступен класс ${availableClass}.`
    );
  }

  const suppliedMatches = classMatches.filter(({ instrument }) => (
    toFiniteNumber(instrument?.supplyValue) > 0
  ));
  if (!suppliedMatches.length) {
    const labels = joinLabels(classMatches.map(({ instrument }) => instrument?.name));
    return createUnavailableResult(
      REPAIR_TOOL_AVAILABILITY.depleted,
      `У подходящих инструментов ремонта нет запаса${labels ? `: ${labels}` : "."}`
    );
  }

  const toolSkillMatches = suppliedMatches.filter(({ instrument }) => (
    Boolean(instrument?.requirementMet)
  ));
  if (!toolSkillMatches.length) {
    const closest = selectClosestToolSkillMatch(suppliedMatches);
    const instrument = closest?.instrument ?? {};
    const skillLabel = String(instrument.skillLabel ?? "").trim() || "требуемого навыка";
    return createUnavailableResult(
      REPAIR_TOOL_AVAILABILITY.toolSkill,
      `Для использования «${String(instrument.name ?? "инструмента")}» нужно ${toInteger(instrument.skillValue)} ${skillLabel} (сейчас ${toInteger(instrument.actorSkillValue)}).`
    );
  }

  const actionSkillMatches = toolSkillMatches.filter(({ requirement }) => (
    requirement?.skillThreshold?.met !== false
  ));
  if (!actionSkillMatches.length) {
    const closest = selectClosestActionSkillMatch(toolSkillMatches);
    const requirement = closest?.requirement ?? {};
    const threshold = requirement.skillThreshold ?? {};
    const itemLabel = String(requirement.itemName ?? "предмета").trim();
    const skillLabel = String(threshold.skillLabel ?? "").trim() || "Ремонт";
    return createUnavailableResult(
      REPAIR_TOOL_AVAILABILITY.skillThreshold,
      `Для ремонта «${itemLabel}» нужно ${toInteger(threshold.difficulty)} ${skillLabel} (сейчас ${toInteger(threshold.skillValue)}).`
    );
  }

  return {
    ok: true,
    code: REPAIR_TOOL_AVAILABILITY.available,
    message: "",
    instruments: uniqueInstruments(actionSkillMatches.map(({ instrument }) => instrument))
  };
}

function createMatches(instruments, requirements, predicate) {
  const matches = [];
  for (const requirement of requirements) {
    for (const instrument of instruments) {
      const match = { instrument, requirement };
      if (predicate(match)) matches.push(match);
    }
  }
  return matches;
}

function selectClosestClassMatch(matches) {
  return [...matches].sort((left, right) => (
    getClassDeficit(left) - getClassDeficit(right)
    || String(left.requirement?.itemName ?? "").localeCompare(String(right.requirement?.itemName ?? ""))
    || String(left.instrument?.name ?? "").localeCompare(String(right.instrument?.name ?? ""))
  )).at(0) ?? null;
}

function selectClosestToolSkillMatch(matches) {
  return [...matches].sort((left, right) => (
    getToolSkillDeficit(left.instrument) - getToolSkillDeficit(right.instrument)
    || String(left.instrument?.name ?? "").localeCompare(String(right.instrument?.name ?? ""))
  )).at(0) ?? null;
}

function selectClosestActionSkillMatch(matches) {
  return [...matches].sort((left, right) => (
    getActionSkillDeficit(left.requirement) - getActionSkillDeficit(right.requirement)
    || String(left.requirement?.itemName ?? "").localeCompare(String(right.requirement?.itemName ?? ""))
  )).at(0) ?? null;
}

function getClassDeficit({ instrument, requirement }) {
  return Math.max(0, toToolClassRank(requirement?.toolClass) - toToolClassRank(instrument?.toolClass));
}

function getToolSkillDeficit(instrument) {
  return Math.max(0, toInteger(instrument?.skillValue) - toInteger(instrument?.actorSkillValue));
}

function getActionSkillDeficit(requirement) {
  const threshold = requirement?.skillThreshold ?? {};
  return Math.max(0, toInteger(threshold.difficulty) - toInteger(threshold.skillValue));
}

function uniqueInstruments(instruments) {
  const unique = new Map();
  for (const instrument of instruments) {
    const key = String(
      instrument?.uid
      ?? `${instrument?.id ?? ""}:${instrument?.toolKey ?? ""}`
    );
    if (!unique.has(key)) unique.set(key, instrument);
  }
  return Array.from(unique.values());
}

function joinLabels(values) {
  return Array.from(new Set(
    values
      .map(value => String(value ?? "").trim())
      .filter(Boolean)
  )).map(label => `«${label}»`).join(", ");
}

function normalizeToolClass(value) {
  const normalized = String(value ?? "D").trim().toUpperCase();
  return Object.hasOwn(TOOL_CLASS_RANK, normalized) ? normalized : "D";
}

function toToolClassRank(value) {
  return TOOL_CLASS_RANK[normalizeToolClass(value)];
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function toInteger(value) {
  return Math.trunc(toFiniteNumber(value));
}

function createUnavailableResult(code, message) {
  return {
    ok: false,
    code,
    message,
    instruments: []
  };
}
