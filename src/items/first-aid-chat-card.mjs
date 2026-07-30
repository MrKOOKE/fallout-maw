import { isPeriodicHealingEffectKey } from "../combat/periodic-healing.mjs";
import { isSkillBonusPercentEffectKey } from "../utils/active-effect-keys.mjs";
import { formatDurationShort } from "../utils/duration-parts.mjs";
import { scaleFirstAidSignedValue } from "../utils/first-aid-scaling.mjs";
import { toInteger } from "../utils/numbers.mjs";

export function buildFirstAidApplicationCardContext({
  item = null,
  sourceActor = null,
  targetActor = null,
  targetName = "",
  resultKey = "success",
  resultLabel = "",
  firstAid = {},
  scaling = {},
  healing = 0,
  selectedLimbs = [],
  appliedLimbs = [],
  appliedNeeds = null,
  appliedDurationSeconds = 0,
  appliedWithdrawalDurationSeconds = 0,
  hasEffectRemoval = false,
  removeEffectDamageTypeKeys = [],
  removeEffectLimbKeys = [],
  criticalFailureDamage = 0,
  spentCharges = 1,
  showHealingEffectiveness = false,
  pathLabels = new Map(),
  needLabels = new Map(),
  limbLabels = new Map(),
  damageTypeLabels = new Map(),
  labels = {}
} = {}) {
  const resolvedLabels = {
    directHealing: "Healing",
    periodicHealing: "Regeneration",
    limbs: "Limbs",
    needs: "Needs",
    effectRemoval: "Removes effects",
    criticalFailureDamage: "Critical failure damage",
    notApplied: "—",
    zeroDuration: "0 sec.",
    ...labels
  };
  const effectMultiplier = toMultiplier(scaling.effect);
  const healingMultiplier = toMultiplier(scaling.healing);
  const withdrawalEffectMultiplier = toMultiplier(scaling.withdrawalEffect);
  const withdrawalHealingMultiplier = toMultiplier(scaling.withdrawalHealing);
  const mainTimedEffectApplied = Math.max(0, toInteger(appliedDurationSeconds)) > 0;
  const withdrawalApplied = Math.max(0, toInteger(appliedWithdrawalDurationSeconds)) > 0;
  const mainEffects = [];
  const withdrawalEffects = [];

  const baseHealing = Math.max(0, toInteger(firstAid.healing));
  if (baseHealing) {
    mainEffects.push(createComparisonRow({
      label: resolvedLabels.directHealing,
      configured: firstAid.healingIsPercentage ? `${baseHealing}%` : String(baseHealing),
      applied: String(Math.max(0, toInteger(healing))),
      appliedZero: toInteger(healing) === 0
    }));
  }

  const appliedLimbValues = new Map((Array.isArray(appliedLimbs) ? appliedLimbs : [])
    .map(entry => [String(entry?.limbKey ?? ""), toInteger(entry?.value)]));
  const limbValue = toInteger(firstAid.limbSelection?.value);
  for (const entry of Array.isArray(selectedLimbs) ? selectedLimbs : []) {
    const limbKey = String(entry?.limbKey ?? "").trim();
    const count = Math.max(0, toInteger(entry?.count));
    if (!limbKey || !count || !limbValue) continue;
    const configured = limbValue * count;
    const applied = appliedLimbValues.get(limbKey) ?? 0;
    mainEffects.push(createComparisonRow({
      label: `${resolvedLabels.limbs}: ${getMapLabel(limbLabels, limbKey)}`,
      configured: formatSignedNumber(configured),
      applied: formatSignedNumber(applied),
      appliedZero: applied === 0
    }));
  }

  const hasAppliedNeedResults = Array.isArray(appliedNeeds);
  const appliedNeedValues = new Map((hasAppliedNeedResults ? appliedNeeds : [])
    .map(entry => [
      String(entry?.key ?? entry?.needKey ?? "").trim(),
      toInteger(entry?.appliedDelta)
    ])
    .filter(([key]) => key));
  for (const entry of normalizeNeedEntries(firstAid.needs)) {
    const applied = hasAppliedNeedResults
      ? (appliedNeedValues.get(entry.key) ?? 0)
      : effectMultiplier > 0
        ? scaleFirstAidSignedValue(entry.value, effectMultiplier)
        : 0;
    mainEffects.push(createComparisonRow({
      label: `${resolvedLabels.needs}: ${getMapLabel(needLabels, entry.key)}`,
      configured: formatSignedNumber(entry.value),
      applied: formatSignedNumber(applied),
      appliedZero: applied === 0
    }));
  }

  mainEffects.push(...buildChangeRows(firstAid.changes, {
    effectMultiplier: mainTimedEffectApplied ? effectMultiplier : 0,
    healingMultiplier: mainTimedEffectApplied ? healingMultiplier : 0,
    pathLabels,
    labels: resolvedLabels
  }));

  const configuredRemovalKeys = getFirstAidRemoveEffectKeys(firstAid);
  if (configuredRemovalKeys.length) {
    const configured = configuredRemovalKeys.map(key => getMapLabel(damageTypeLabels, key)).join(", ");
    const appliedDamageTypes = hasEffectRemoval
      ? removeEffectDamageTypeKeys.map(key => getMapLabel(damageTypeLabels, key)).join(", ")
      : "";
    const appliedLimbNames = hasEffectRemoval
      ? removeEffectLimbKeys.map(key => getMapLabel(limbLabels, key)).join(", ")
      : "";
    const applied = [appliedDamageTypes, appliedLimbNames].filter(Boolean).join(" · ")
      || resolvedLabels.notApplied;
    mainEffects.push(createComparisonRow({
      label: resolvedLabels.effectRemoval,
      configured,
      applied,
      appliedZero: !hasEffectRemoval
    }));
  }

  if (resultKey === "criticalFailure") {
    const min = Math.max(0, toInteger(firstAid.criticalFailureDamageMin));
    const max = Math.max(min, toInteger(firstAid.criticalFailureDamageMax));
    if (min || max || criticalFailureDamage) {
      mainEffects.push(createComparisonRow({
        label: resolvedLabels.criticalFailureDamage,
        configured: min === max ? String(min) : `${min}–${max}`,
        applied: String(Math.max(0, toInteger(criticalFailureDamage))),
        appliedZero: toInteger(criticalFailureDamage) === 0
      }));
    }
  }

  withdrawalEffects.push(...buildChangeRows(firstAid.withdrawal, {
    effectMultiplier: withdrawalApplied ? withdrawalEffectMultiplier : 0,
    healingMultiplier: withdrawalApplied ? withdrawalHealingMultiplier : 0,
    pathLabels,
    labels: resolvedLabels
  }));

  const effectivenessPercent = formatPercent(effectMultiplier * 100);
  const healingEffectivenessPercent = formatPercent(healingMultiplier * 100);
  const baseDurationSeconds = Math.max(0, toInteger(firstAid.durationSeconds));
  const baseWithdrawalDurationSeconds = Math.max(0, toInteger(firstAid.withdrawalDurationSeconds));

  return {
    tone: getResultTone(resultKey),
    item: {
      name: String(item?.name ?? ""),
      img: String(item?.img ?? "icons/svg/heal.svg")
    },
    source: {
      name: String(sourceActor?.name ?? ""),
      img: String(sourceActor?.img ?? "icons/svg/mystery-man.svg")
    },
    target: {
      name: String(targetName || targetActor?.name || ""),
      img: String(targetActor?.img ?? "icons/svg/mystery-man.svg")
    },
    result: {
      key: String(resultKey ?? ""),
      label: String(resultLabel ?? resultKey ?? "")
    },
    effectiveness: `${effectivenessPercent}%`,
    healingEffectiveness: showHealingEffectiveness && healingEffectivenessPercent !== effectivenessPercent
      ? `${healingEffectivenessPercent}%`
      : "",
    duration: createDurationComparison(
      baseDurationSeconds,
      appliedDurationSeconds,
      resolvedLabels.zeroDuration
    ),
    withdrawalDuration: baseWithdrawalDurationSeconds || withdrawalEffects.length
      ? createDurationComparison(
        baseWithdrawalDurationSeconds,
        appliedWithdrawalDurationSeconds,
        resolvedLabels.zeroDuration
      )
      : null,
    spentCharges: Math.max(1, toInteger(spentCharges)),
    mainEffects,
    withdrawalEffects,
    hasMainEffects: mainEffects.length > 0,
    hasWithdrawalEffects: withdrawalEffects.length > 0
  };
}

function buildChangeRows(changes = [], {
  effectMultiplier = 1,
  healingMultiplier = 1,
  pathLabels = new Map(),
  labels = {}
} = {}) {
  const source = Array.isArray(changes) ? changes : Object.values(changes ?? {});
  return source
    .map(change => {
      const key = String(change?.key ?? "").trim();
      if (!key) return null;
      const healing = isPeriodicHealingEffectKey(key);
      const multiplier = healing ? healingMultiplier : effectMultiplier;
      const configuredValue = change?.value ?? "0";
      const appliedValue = scaleChangeValue(configuredValue, multiplier);
      return createComparisonRow({
        label: healing ? labels.periodicHealing : getEffectPathLabel(pathLabels, key),
        configured: formatChangeValue(change?.type, configuredValue, key),
        applied: formatChangeValue(change?.type, appliedValue, key),
        appliedZero: Number(appliedValue) === 0
      });
    })
    .filter(Boolean);
}

function normalizeNeedEntries(needs = []) {
  const source = Array.isArray(needs)
    ? needs
    : Object.entries(needs ?? {}).map(([needKey, value]) => ({ needKey, value }));
  return source
    .map(entry => ({
      key: String(entry?.needKey ?? "").trim(),
      value: toInteger(entry?.value)
    }))
    .filter(entry => entry.key && entry.value);
}

function getFirstAidRemoveEffectKeys(firstAid = {}) {
  const source = Array.isArray(firstAid.removeEffects)
    ? firstAid.removeEffects
    : Object.entries(firstAid.removeEffects ?? {}).map(([damageTypeKey]) => ({ damageTypeKey }));
  return Array.from(new Set(source
    .map(entry => String(entry?.damageTypeKey ?? entry?.key ?? "").trim())
    .filter(Boolean)));
}

function scaleChangeValue(value, multiplier) {
  const factor = toMultiplier(multiplier);
  if (factor <= 0) return 0;
  const number = Number(value);
  if (!Number.isFinite(number) || factor === 1) return value;
  return scaleFirstAidSignedValue(number, factor);
}

function createComparisonRow({ label, configured, applied, appliedZero = false }) {
  return {
    label: String(label ?? ""),
    configured: String(configured ?? ""),
    applied: String(applied ?? ""),
    appliedZero: Boolean(appliedZero)
  };
}

function createDurationComparison(configuredSeconds, appliedSeconds, zeroDuration) {
  const configured = Math.max(0, toInteger(configuredSeconds));
  const applied = Math.max(0, toInteger(appliedSeconds));
  return {
    configured: formatDurationShort(configured) || zeroDuration,
    applied: formatDurationShort(applied) || zeroDuration,
    appliedZero: applied === 0
  };
}

function formatChangeValue(type = "add", value = 0, key = "") {
  const normalizedType = String(type ?? "add");
  const text = String(value ?? "0").trim() || "0";
  const suffix = isSkillBonusPercentEffectKey(key) && normalizedType !== "multiply" ? "%" : "";
  if (normalizedType === "override") return `= ${text}${suffix}`;
  if (normalizedType === "multiply") return `× ${text}`;
  const number = Number(text);
  if (Number.isFinite(number)) return `${formatSignedNumber(number)}${suffix}`;
  return `${text.startsWith("-") ? "" : "+"}${text}${suffix}`;
}

function formatSignedNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value ?? "");
  const text = formatNumber(number);
  return number > 0 ? `+${text}` : text;
}

function formatPercent(value) {
  return formatNumber(Math.max(0, Number(value) || 0));
}

function formatNumber(value) {
  const rounded = Math.round((Number(value) || 0) * 100) / 100;
  return String(rounded);
}

function getMapLabel(labels, key) {
  if (labels instanceof Map) return String(labels.get(key) ?? key);
  return String(labels?.[key] ?? key);
}

function getEffectPathLabel(pathLabels, key) {
  const label = getMapLabel(pathLabels, key);
  if (label !== key) return label;
  return String(key)
    .replace(/^system\./, "")
    .split(".")
    .filter(Boolean)
    .map(part => part.replace(/([a-z])([A-Z])/g, "$1 $2"))
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" / ");
}

function getResultTone(resultKey) {
  if (resultKey === "criticalSuccess") return "critical-success";
  if (resultKey === "failure") return "failure";
  if (resultKey === "criticalFailure") return "critical-failure";
  return "success";
}

function toMultiplier(value) {
  return Math.max(0, Number(value) || 0);
}
