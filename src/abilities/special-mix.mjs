import { SYSTEM_ID } from "../constants.mjs";
import { buildBearerExpirationEffectData } from "../effects/expiration-actions.mjs";

export const SPECIAL_MIX_FLAG = "specialMix";

export function getSpecialMixMedicineIdentity(item = null) {
  return String(item?.name ?? "").trim().toLocaleLowerCase("ru-RU");
}

export function isSpecialMixMedicineEligible(item = null) {
  const firstAid = item?.system?.functions?.firstAid;
  if (!item || item.type !== "gear" || firstAid?.enabled !== true) return false;
  if (Math.max(0, toInteger(item.system?.quantity)) <= 0) return false;
  if (firstAid.healingIsPercentage === true) return false;
  const maxCharges = Math.max(1, toInteger(firstAid.charges?.max) || 1);
  const charges = firstAid.charges?.value === undefined
    ? maxCharges
    : Math.max(0, Math.min(maxCharges, toInteger(firstAid.charges.value)));
  return charges > 0 && Boolean(getSpecialMixMedicineIdentity(item));
}

export function areDistinctSpecialMixMedicines(first = null, second = null) {
  if (!first || !second || String(first.id ?? first._id ?? "") === String(second.id ?? second._id ?? "")) return false;
  return getSpecialMixMedicineIdentity(first) !== getSpecialMixMedicineIdentity(second);
}

export function mergeSpecialMixFirstAid(first = {}, second = {}, {
  effectivenessPercentBonus = 100,
  durationPercentBonus = 50
} = {}) {
  const sources = [first ?? {}, second ?? {}];
  const effectivenessMultiplier = 1 + (Math.max(0, toInteger(effectivenessPercentBonus)) / 100);
  const durationMultiplier = 1 + (Math.max(0, toInteger(durationPercentBonus)) / 100);
  const positiveRanges = sources.map(source => Number(source.maxDistance) || 0).filter(value => value > 0);
  const needs = new Map();
  const removeEffects = new Set();
  for (const source of sources) {
    for (const entry of source.needs ?? []) {
      const key = String(entry?.needKey ?? "").trim();
      if (!key) continue;
      needs.set(key, (needs.get(key) ?? 0) + toInteger(entry.value));
    }
    for (const entry of source.removeEffects ?? []) {
      const key = String(entry?.damageTypeKey ?? "").trim();
      if (key) removeEffects.add(key);
    }
  }

  return {
    enabled: true,
    healing: scaleUnsignedValue(
      sources.reduce((sum, source) => sum + Math.max(0, toInteger(source.healing)), 0),
      effectivenessMultiplier
    ),
    healingIsPercentage: false,
    durationSeconds: scaleDurationAverage(sources.map(source => source.durationSeconds), durationMultiplier),
    actionPointCost: Math.max(0, ...sources.map(source => toInteger(source.actionPointCost))),
    maxDistance: positiveRanges.length ? Math.min(...positiveRanges) : 0,
    difficulty: Math.max(0, ...sources.map(source => toInteger(source.difficulty))),
    skillKey: String(sources.find(source => String(source.skillKey ?? "").trim())?.skillKey ?? "doctor"),
    criticalSuccessHealingBonus: Math.max(0, ...sources.map(source => toInteger(source.criticalSuccessHealingBonus))),
    criticalFailureDamageMin: Math.max(0, ...sources.map(source => toInteger(source.criticalFailureDamageMin))),
    criticalFailureDamageMax: Math.max(0, ...sources.map(source => toInteger(source.criticalFailureDamageMax))),
    charges: { value: 1, max: 1 },
    needs: [...needs].map(([needKey, value]) => ({
      needKey,
      value: scaleSignedValue(value, effectivenessMultiplier)
    })),
    limbSelection: {
      count: sources.some(source => Math.max(0, toInteger(source.limbSelection?.count)) > 0) ? 1 : 0,
      value: scaleSignedValue(
        sources.reduce((sum, source) => sum + toInteger(source.limbSelection?.value), 0),
        effectivenessMultiplier
      )
    },
    removeEffects: [...removeEffects].map(damageTypeKey => ({ damageTypeKey })),
    changes: mergeAndScaleChanges(sources.map(source => source.changes), effectivenessMultiplier),
    withdrawalDurationSeconds: scaleDurationAverage(
      sources.map(source => source.withdrawalDurationSeconds),
      durationMultiplier
    ),
    withdrawal: mergeAndScaleChanges(sources.map(source => source.withdrawal), effectivenessMultiplier)
  };
}

export function buildSpecialMixItemData({
  firstItem = null,
  secondItem = null,
  abilityItem = null,
  settings = {},
  startTime = 0,
  placement = null
} = {}) {
  if (!isSpecialMixMedicineEligible(firstItem) || !isSpecialMixMedicineEligible(secondItem)) {
    throw new TypeError("Two usable medicines are required for a special mix.");
  }
  if (!areDistinctSpecialMixMedicines(firstItem, secondItem)) {
    throw new TypeError("Special mix ingredients must be different medicines.");
  }

  const firstData = toObject(firstItem);
  const secondData = toObject(secondItem);
  const firstAid = mergeSpecialMixFirstAid(
    firstItem.system.functions.firstAid,
    secondItem.system.functions.firstAid,
    settings
  );
  const name = `Особый намес: ${String(firstItem.name)} + ${String(secondItem.name)}`;
  const img = String(abilityItem?.img || firstItem.img || secondItem.img || "icons/svg/mystery-man.svg");
  const spoilDurationSeconds = Math.max(1, toInteger(settings.spoilDurationSeconds ?? 1800));
  const data = clone(firstData);
  delete data._id;
  delete data.id;
  delete data.folder;
  delete data.sort;
  delete data.ownership;
  data.name = name;
  data.type = "gear";
  data.img = img;
  data.effects = [buildBearerExpirationEffectData({
    name: "Препарат испортится",
    img,
    durationSeconds: spoilDurationSeconds,
    startTime,
    origin: String(abilityItem?.uuid ?? "")
  })];
  data.flags = {
    [SYSTEM_ID]: {
      [SPECIAL_MIX_FLAG]: {
        abilityItemUuid: String(abilityItem?.uuid ?? ""),
        ingredientNames: [String(firstItem.name), String(secondItem.name)],
        createdAt: Number(startTime) || 0,
        spoilDurationSeconds
      }
    }
  };
  data.system = {
    ...clone(firstData.system ?? {}),
    description: buildSpecialMixDescription(firstItem, secondItem, settings, spoilDurationSeconds),
    quantity: 1,
    maxStack: 1,
    stackParts: [],
    itemCategory: "Первая помощь",
    weight: Math.max(0, Number(firstData.system?.weight) || 0) + Math.max(0, Number(secondData.system?.weight) || 0),
    price: Math.max(0, Number(firstData.system?.price) || 0) + Math.max(0, Number(secondData.system?.price) || 0),
    equipped: false,
    locked: false,
    container: { parentId: String(placement?.parentId ?? "") },
    placement: {
      ...(clone(firstData.system?.placement ?? {})),
      ...(placement?.placement ?? placement ?? {}),
      mode: "inventory",
      equipmentSlot: "",
      weaponSet: "",
      weaponSlot: "",
      limbKey: "",
      constructPartOrder: 0
    },
    occupiedSlots: {},
    functions: { firstAid }
  };
  return data;
}

export function getSpecialMixMedicineDetails(item = null, labels = {}) {
  const firstAid = item?.system?.functions?.firstAid ?? {};
  return getSpecialMixFirstAidDetails(firstAid, labels);
}

export function getSpecialMixFirstAidDetails(firstAid = {}, {
  pathLabels = new Map(),
  needLabels = new Map(),
  damageTypeLabels = new Map()
} = {}) {
  const rows = [];
  const healing = Math.max(0, toInteger(firstAid.healing));
  if (healing > 0) rows.push({ label: "Здоровье", value: formatSigned(healing) });

  const limbCount = Math.max(0, toInteger(firstAid.limbSelection?.count));
  const limbValue = toInteger(firstAid.limbSelection?.value);
  if (limbCount > 0) {
    rows.push({
      label: `Состояние частей тела (до ${limbCount})`,
      value: formatSigned(limbValue)
    });
  }

  for (const entry of firstAid.needs ?? []) {
    const key = String(entry?.needKey ?? "").trim();
    if (!key) continue;
    rows.push({
      label: `Потребность: ${getLabel(needLabels, key)}`,
      value: formatSigned(toInteger(entry.value))
    });
  }

  appendChangeDetails(rows, firstAid.changes, { pathLabels });

  for (const entry of firstAid.removeEffects ?? []) {
    const key = String(entry?.damageTypeKey ?? "").trim();
    if (!key) continue;
    rows.push({ label: "Снимает эффект", value: getLabel(damageTypeLabels, key) });
  }

  const withdrawalDurationSeconds = Math.max(0, toInteger(firstAid.withdrawalDurationSeconds));
  const withdrawal = getValidChanges(firstAid.withdrawal);
  if (withdrawalDurationSeconds > 0 || withdrawal.length > 0) {
    rows.push({ kind: "section", label: "Отдача:" });
    if (withdrawalDurationSeconds > 0) {
      rows.push({ label: "Длительность", value: formatShortDuration(withdrawalDurationSeconds) });
    }
    appendChangeDetails(rows, withdrawal, { pathLabels });
  }

  const durationSeconds = Math.max(0, toInteger(firstAid.durationSeconds));
  const chargesMax = Math.max(1, toInteger(firstAid.charges?.max) || 1);
  const chargesValue = Math.max(0, Math.min(chargesMax, toInteger(firstAid.charges?.value ?? chargesMax)));
  return {
    rows,
    durationSeconds,
    durationLabel: durationSeconds > 0 ? `эффект ${formatShortDuration(durationSeconds)}` : "мгновенно",
    chargesLabel: `заряды ${chargesValue}/${chargesMax}`
  };
}

function buildSpecialMixDescription(firstItem, secondItem, settings, spoilDurationSeconds) {
  const effectiveness = Math.max(0, toInteger(settings.effectivenessPercentBonus ?? 100));
  const duration = Math.max(0, toInteger(settings.durationPercentBonus ?? 50));
  return [
    `<p><strong>Смешано:</strong> ${escapeHtml(firstItem.name)} + ${escapeHtml(secondItem.name)}.</p>`,
    `<p><strong>Эффективность:</strong> +${effectiveness}%<br><strong>Длительность:</strong> +${duration}%</p>`,
    `<p><strong>Препарат испортится через ${formatShortDuration(spoilDurationSeconds)}.</strong></p>`
  ].join("");
}

function formatShortDuration(value) {
  const seconds = Math.max(0, toInteger(value));
  if (seconds % 3600 === 0 && seconds >= 3600) return `${seconds / 3600} ч`;
  if (seconds % 60 === 0 && seconds >= 60) return `${seconds / 60} мин`;
  return `${seconds} с`;
}

function mergeAndScaleChanges(changeLists, multiplier) {
  const merged = [];
  const additiveGroups = new Map();
  for (const list of changeLists) {
    for (const source of Array.isArray(list) ? list : Object.values(list ?? {})) {
      const change = normalizeChange(source);
      if (!change.key) continue;
      if (change.type !== "add") {
        merged.push({ ...change, value: scaleChangeValue(change.value, multiplier) });
        continue;
      }
      const signature = `${change.key}\u0000${change.phase}\u0000${change.priority ?? ""}`;
      const group = additiveGroups.get(signature);
      if (group) group.values.push(change.value);
      else additiveGroups.set(signature, { change, values: [change.value] });
    }
  }
  for (const { change, values } of additiveGroups.values()) {
    merged.push({ ...change, value: combineAndScaleAddValues(values, multiplier) });
  }
  return merged;
}

function normalizeChange(source = {}) {
  const rawPriority = source?.priority;
  return {
    key: String(source?.key ?? "").trim(),
    type: ["add", "multiply", "override", "upgrade", "downgrade"].includes(String(source?.type ?? ""))
      ? String(source.type)
      : "add",
    value: String(source?.value ?? "0").trim() || "0",
    phase: String(source?.phase ?? "initial").trim() || "initial",
    priority: rawPriority === null || rawPriority === undefined || rawPriority === ""
      ? null
      : toInteger(rawPriority)
  };
}

function combineAndScaleAddValues(values, multiplier) {
  const numbers = values.map(Number);
  if (numbers.every(Number.isFinite)) {
    return String(scaleSignedValue(numbers.reduce((sum, value) => sum + value, 0), multiplier));
  }
  const expression = values.length === 1
    ? values[0]
    : values.map(value => `(${value})`).join(" + ");
  return multiplier === 1 ? expression : `(${expression}) * ${formatNumber(multiplier)}`;
}

function scaleChangeValue(value, multiplier) {
  const number = Number(value);
  if (Number.isFinite(number)) return String(scaleSignedValue(number, multiplier));
  return multiplier === 1 ? String(value) : `(${value}) * ${formatNumber(multiplier)}`;
}

function scaleDurationAverage(values, multiplier) {
  const normalized = values.map(value => Math.max(0, toInteger(value)));
  if (!normalized.some(Boolean)) return 0;
  const average = Math.floor(normalized.reduce((sum, value) => sum + value, 0) / normalized.length);
  return scaleUnsignedValue(average, multiplier);
}

function scaleUnsignedValue(value, multiplier) {
  return Math.max(0, Math.floor(Math.max(0, Number(value) || 0) * Math.max(0, Number(multiplier) || 0)));
}

function scaleSignedValue(value, multiplier) {
  const number = Number(value) || 0;
  if (!number) return 0;
  const scaled = Math.floor(Math.abs(number) * Math.max(0, Number(multiplier) || 0));
  return number < 0 ? -scaled : scaled;
}

function appendChangeDetails(rows, changes, { pathLabels, prefix = "" } = {}) {
  for (const source of getValidChanges(changes)) {
    const change = normalizeChange(source);
    rows.push({
      label: `${prefix}${getLabel(pathLabels, change.key)}`,
      value: formatChangeValue(change)
    });
  }
}

function getValidChanges(changes) {
  return (Array.isArray(changes) ? changes : Object.values(changes ?? {}))
    .filter(change => String(change?.key ?? "").trim());
}

function formatChangeValue(change) {
  if (change.type === "override") return `= ${change.value}`;
  if (change.type === "multiply") return `× ${change.value}`;
  const number = Number(change.value);
  return Number.isFinite(number) ? formatSigned(number) : `${change.value.startsWith("-") ? "" : "+"}${change.value}`;
}

function formatSigned(value) {
  const number = Number(value) || 0;
  return number > 0 ? `+${formatNumber(number)}` : formatNumber(number);
}

function formatNumber(value) {
  const number = Math.round((Number(value) || 0) * 100) / 100;
  return String(number);
}

function getLabel(labels, key) {
  return String(labels?.get?.(key) ?? key);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function toObject(value) {
  return typeof value?.toObject === "function" ? value.toObject() : clone(value ?? {});
}

function clone(value) {
  return globalThis.structuredClone ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function toInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}
