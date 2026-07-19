import { getCharacteristicSettings, getCreatureOptions } from "../settings/accessors.mjs";
import {
  DEFAULT_ORGANISM_DEVELOPMENT_LIMIT
} from "../settings/creature-options.mjs";
import { formatResearchValue, roundResearchValue } from "../research/storage.mjs";
import { SYSTEM_ID } from "../constants.mjs";
import { toInteger } from "../utils/numbers.mjs";

const ORGANISM_EFFECT_NAME = "Развитие организма";
const ORGANISM_FLAG_KEY = "organismDevelopment";
const CHARACTERISTIC_BONUS = 2;

export const ORGANISM_DEVELOPMENT_LIMIT_EFFECT_KEY = "system.organismDevelopment.limit";

const LEGACY_ABILITY_KEYS = Object.freeze({
  str: "strength",
  dex: "dexterity",
  con: "endurance",
  int: "intelligence",
  wis: "perception",
  cha: "charisma",
  luc: "luck"
});

export function getOrganismDevelopmentRace(actor) {
  const raceId = String(actor?.system?.creature?.raceId ?? "");
  if (!raceId) return null;
  return getCreatureOptions().races.find(entry => entry.id === raceId) ?? null;
}

export function getOrganismDevelopmentThreshold(actor) {
  const race = getOrganismDevelopmentRace(actor);
  if (!race) return null;
  const rawThreshold = race?.organismDevelopment?.threshold;
  if (rawThreshold === "" || rawThreshold === null || rawThreshold === undefined) return null;
  const threshold = Number(rawThreshold);
  return Number.isFinite(threshold) && threshold > 0 ? threshold : null;
}

export function isOrganismDevelopmentEnabled(actor) {
  return getOrganismDevelopmentThreshold(actor) !== null;
}

export function getOrganismDevelopmentLimitBase(actorOrRace = null) {
  const race = actorOrRace && typeof actorOrRace === "object" && !actorOrRace.system
    ? actorOrRace
    : getOrganismDevelopmentRace(actorOrRace);
  const parsed = Number(race?.organismDevelopment?.limit);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.trunc(parsed)
    : DEFAULT_ORGANISM_DEVELOPMENT_LIMIT;
}

export function getOrganismDevelopmentLimit(actor) {
  const prepared = Number(actor?.system?.organismDevelopment?.limit);
  if (Number.isFinite(prepared) && prepared >= 0) return Math.trunc(prepared);
  return getOrganismDevelopmentLimitBase(actor);
}

export function getOrganismDevelopmentProgress(actor) {
  const stored = actor?.flags?.[SYSTEM_ID]?.[ORGANISM_FLAG_KEY] ?? {};
  return normalizeOrganismDevelopmentProgress(stored);
}

export function calculateActorPureCharacteristicSum(actor) {
  const characteristicSettings = getCharacteristicSettings();
  const sourceCharacteristics = actor?.system?._source?.characteristics ?? {};
  const developmentCharacteristics = actor?.system?.development?.characteristics ?? {};
  const organismBonuses = getOrganismDevelopmentCharacteristicBonuses(actor);

  return characteristicSettings.reduce((total, characteristic) => {
    const sourceValue = Object.hasOwn(sourceCharacteristics, characteristic.key)
      ? toInteger(sourceCharacteristics[characteristic.key])
      : toInteger(actor?.system?.characteristics?.[characteristic.key]);
    return total
      + sourceValue
      + toInteger(developmentCharacteristics[characteristic.key])
      + toInteger(organismBonuses[characteristic.key]);
  }, 0);
}

export function prepareOrganismDevelopmentForDisplay(actor) {
  const threshold = getOrganismDevelopmentThreshold(actor);
  const enabled = threshold !== null;
  const limit = getOrganismDevelopmentLimit(actor);
  const current = calculateActorPureCharacteristicSum(actor);
  const progress = getOrganismDevelopmentProgress(actor);
  const entries = enabled
    ? getCharacteristicSettings().map(characteristic => {
      const currentProgress = roundResearchValue(progress[characteristic.key] ?? 0);
      const completion = threshold > 0 ? Math.min(currentProgress / threshold, 1) : 0;
      const progressPercent = roundResearchValue(completion * 100);
      return {
        key: characteristic.key,
        label: characteristic.label || characteristic.key,
        progress: currentProgress,
        target: threshold,
        progressLabel: formatResearchValue(currentProgress),
        targetLabel: formatResearchValue(threshold),
        progressPercent,
        meterStyle: buildOrganismDevelopmentMeterStyle(),
        fillStyle: buildOrganismDevelopmentFillStyle(progressPercent),
        hasProgress: currentProgress > 0
      };
    })
    : [];

  return {
    enabled,
    threshold,
    thresholdLabel: enabled ? formatResearchValue(threshold) : "",
    limit,
    limitLabel: String(limit),
    current,
    currentLabel: String(current),
    entries,
    activeEntries: entries.filter(entry => entry.hasProgress),
    hasAnyProgress: entries.some(entry => entry.hasProgress),
    atLimit: current >= limit
  };
}

export async function addOrganismDevelopment(actor, developmentValues = {}) {
  if (!actor || !developmentValues || typeof developmentValues !== "object") {
    return { upgraded: false, characteristicKey: null };
  }

  const threshold = getOrganismDevelopmentThreshold(actor);
  if (threshold === null) {
    return { upgraded: false, characteristicKey: null, disabled: true };
  }

  const limit = getOrganismDevelopmentLimit(actor);
  const pureSum = calculateActorPureCharacteristicSum(actor);
  if (pureSum >= limit) {
    return { upgraded: false, characteristicKey: null, atLimit: true };
  }

  const current = getOrganismDevelopmentProgress(actor);
  let upgradedCharacteristicKey = null;

  for (const [rawKey, rawValue] of Object.entries(developmentValues)) {
    const characteristicKey = resolveOrganismCharacteristicKey(rawKey);
    const value = Number(rawValue);
    if (!characteristicKey || !Number.isFinite(value) || value <= 0) continue;
    current[characteristicKey] = (current[characteristicKey] ?? 0) + value;
    if (!upgradedCharacteristicKey && current[characteristicKey] >= threshold) {
      upgradedCharacteristicKey = characteristicKey;
    }
  }

  if (upgradedCharacteristicKey) {
    await applyOrganismDevelopmentEffect(actor, upgradedCharacteristicKey);
    await setOrganismDevelopmentProgress(actor, createDefaultOrganismDevelopmentProgress());
    return { upgraded: true, characteristicKey: upgradedCharacteristicKey };
  }

  await setOrganismDevelopmentProgress(actor, current);
  return { upgraded: false, characteristicKey: null };
}

export function prepareActorOrganismDevelopmentLimitBase(system) {
  if (!system || typeof system !== "object") return;
  const raceId = String(system.creature?.raceId ?? "");
  const race = raceId
    ? getCreatureOptions().races.find(entry => entry.id === raceId) ?? null
    : null;
  system.organismDevelopment ??= {};
  system.organismDevelopment.limit = getOrganismDevelopmentLimitBase(race);
}

function getOrganismDevelopmentCharacteristicBonuses(actor) {
  const effect = actor?.effects?.find(entry => (entry.name || entry.label) === ORGANISM_EFFECT_NAME);
  if (!effect) return {};

  const bonuses = {};
  for (const change of effect.changes ?? []) {
    const characteristicKey = resolveCharacteristicKeyFromEffectPath(change.key);
    if (!characteristicKey) continue;
    const mode = Number(change.mode ?? CONST.ACTIVE_EFFECT_MODES.ADD);
    const value = Number(change.value);
    if (!Number.isFinite(value)) continue;
    if (mode === CONST.ACTIVE_EFFECT_MODES.ADD) {
      bonuses[characteristicKey] = (bonuses[characteristicKey] ?? 0) + value;
    }
  }
  return bonuses;
}

function resolveCharacteristicKeyFromEffectPath(rawKey = "") {
  const key = String(rawKey ?? "").trim();
  const match = key.match(/^system\.characteristics\.([^.]+)(?:\.value)?$/);
  if (!match?.[1]) return "";
  return resolveOrganismCharacteristicKey(match[1]);
}

function resolveOrganismCharacteristicKey(rawKey = "") {
  const key = String(rawKey ?? "").trim();
  if (!key) return "";
  if (LEGACY_ABILITY_KEYS[key]) return LEGACY_ABILITY_KEYS[key];
  const characteristics = getCharacteristicSettings();
  if (characteristics.some(entry => entry.key === key)) return key;
  const byAbbr = characteristics.find(entry => entry.abbr === key);
  return byAbbr?.key ?? "";
}

function createDefaultOrganismDevelopmentProgress() {
  return Object.fromEntries(getCharacteristicSettings().map(entry => [entry.key, 0]));
}

function normalizeOrganismDevelopmentProgress(values = {}) {
  const normalized = createDefaultOrganismDevelopmentProgress();
  for (const [key, rawValue] of Object.entries(values ?? {})) {
    const characteristicKey = resolveOrganismCharacteristicKey(key);
    const value = Number(rawValue);
    if (!characteristicKey || !Number.isFinite(value) || value < 0) continue;
    normalized[characteristicKey] = value;
  }
  return normalized;
}

async function setOrganismDevelopmentProgress(actor, progress = {}) {
  await actor.setFlag(SYSTEM_ID, ORGANISM_FLAG_KEY, normalizeOrganismDevelopmentProgress(progress));
}

async function applyOrganismDevelopmentEffect(actor, characteristicKey) {
  if (!actor || !characteristicKey) return;
  const changeKey = `system.characteristics.${characteristicKey}`;
  const legacyChangeKey = `${changeKey}.value`;
  let existingEffect = actor.effects.find(effect => (effect.name || effect.label) === ORGANISM_EFFECT_NAME);

  if (existingEffect) {
    const changes = [...(existingEffect.changes ?? [])];
    const existingChange = changes.find(change => change.key === changeKey || change.key === legacyChangeKey);
    if (existingChange) {
      existingChange.key = changeKey;
      existingChange.value = String(Number(existingChange.value || 0) + CHARACTERISTIC_BONUS);
    } else {
      changes.push({
        key: changeKey,
        mode: CONST.ACTIVE_EFFECT_MODES.ADD,
        value: String(CHARACTERISTIC_BONUS)
      });
    }
    await existingEffect.update({ changes });
    return;
  }

  await actor.createEmbeddedDocuments("ActiveEffect", [{
    name: ORGANISM_EFFECT_NAME,
    img: "icons/svg/upgrade.svg",
    changes: [{
      key: changeKey,
      mode: CONST.ACTIVE_EFFECT_MODES.ADD,
      value: String(CHARACTERISTIC_BONUS)
    }]
  }]);
}

const ORGANISM_DEVELOPMENT_METER_COLOR = "#c9a227";

function buildOrganismDevelopmentMeterStyle() {
  const baseColor = ORGANISM_DEVELOPMENT_METER_COLOR;
  return [
    "--meter-sections: 12",
    `--meter-color: ${baseColor}`,
    `--meter-color-strong: ${mixOrganismHexColor(baseColor, "#ffffff", 0.2)}`,
    `--meter-color-dark: ${mixOrganismHexColor(baseColor, "#000000", 0.28)}`,
    `--meter-color-soft: ${hexToOrganismRgba(baseColor, 0.2)}`,
    `--meter-color-glow: ${hexToOrganismRgba(baseColor, 0.34)}`
  ].join("; ");
}

function buildOrganismDevelopmentFillStyle(percent) {
  const baseColor = ORGANISM_DEVELOPMENT_METER_COLOR;
  const strongColor = mixOrganismHexColor(baseColor, "#ffffff", 0.2);
  const darkColor = mixOrganismHexColor(baseColor, "#000000", 0.28);
  return [
    `width: ${roundResearchValue(percent)}%`,
    `background: linear-gradient(180deg, ${strongColor}, ${darkColor})`,
    `box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.22), 0 0 14px ${hexToOrganismRgba(baseColor, 0.34)}`
  ].join("; ");
}

function mixOrganismHexColor(hexColor, mixWith, amount = 0.5) {
  const parse = hex => {
    const normalized = String(hex ?? "").trim().replace(/^#/, "");
    if (normalized.length === 3) {
      return normalized.split("").map(char => Number.parseInt(`${char}${char}`, 16));
    }
    if (normalized.length === 6) {
      return [
        Number.parseInt(normalized.slice(0, 2), 16),
        Number.parseInt(normalized.slice(2, 4), 16),
        Number.parseInt(normalized.slice(4, 6), 16)
      ];
    }
    return [0, 0, 0];
  };
  const [r1, g1, b1] = parse(hexColor);
  const [r2, g2, b2] = parse(mixWith);
  const mix = (left, right) => Math.round(left + ((right - left) * amount));
  return `#${[mix(r1, r2), mix(g1, g2), mix(b1, b2)].map(value => value.toString(16).padStart(2, "0")).join("")}`;
}

function hexToOrganismRgba(hexColor, alpha = 1) {
  const normalized = String(hexColor ?? "").trim().replace(/^#/, "");
  const channels = normalized.length === 3
    ? normalized.split("").map(char => Number.parseInt(`${char}${char}`, 16))
    : [
      Number.parseInt(normalized.slice(0, 2), 16),
      Number.parseInt(normalized.slice(2, 4), 16),
      Number.parseInt(normalized.slice(4, 6), 16)
    ];
  return `rgba(${channels[0] ?? 0}, ${channels[1] ?? 0}, ${channels[2] ?? 0}, ${alpha})`;
}
