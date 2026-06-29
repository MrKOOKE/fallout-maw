import { getCharacteristicSettings, getCreatureOptions } from "../settings/accessors.mjs";
import { formatResearchValue, roundResearchValue } from "../research/storage.mjs";
import { SYSTEM_ID } from "../constants.mjs";

const ORGANISM_EFFECT_NAME = "Развитие организма";
const ORGANISM_FLAG_KEY = "organismDevelopment";
const CHARACTERISTIC_BONUS = 2;

const LEGACY_ABILITY_KEYS = Object.freeze({
  str: "strength",
  dex: "dexterity",
  con: "endurance",
  int: "intelligence",
  wis: "perception",
  cha: "charisma",
  luc: "luck"
});

export function getOrganismDevelopmentThreshold(actor) {
  const raceId = String(actor?.system?.creature?.raceId ?? "");
  const race = getCreatureOptions().races.find(entry => entry.id === raceId) ?? null;
  const threshold = Number(race?.organismDevelopment?.threshold ?? 1);
  return Number.isFinite(threshold) && threshold > 0 ? threshold : 1;
}

export function getOrganismDevelopmentProgress(actor) {
  const stored = actor?.flags?.[SYSTEM_ID]?.[ORGANISM_FLAG_KEY] ?? {};
  return normalizeOrganismDevelopmentProgress(stored);
}

export function prepareOrganismDevelopmentForDisplay(actor) {
  const threshold = getOrganismDevelopmentThreshold(actor);
  const progress = getOrganismDevelopmentProgress(actor);
  const entries = getCharacteristicSettings().map(characteristic => {
    const current = roundResearchValue(progress[characteristic.key] ?? 0);
    const completion = threshold > 0 ? Math.min(current / threshold, 1) : 0;
    const progressPercent = roundResearchValue(completion * 100);
    return {
      key: characteristic.key,
      label: characteristic.label || characteristic.key,
      progress: current,
      target: threshold,
      progressLabel: formatResearchValue(current),
      targetLabel: formatResearchValue(threshold),
      progressPercent,
      meterStyle: buildOrganismDevelopmentMeterStyle(),
      fillStyle: buildOrganismDevelopmentFillStyle(progressPercent),
      hasProgress: current > 0
    };
  });

  return {
    threshold,
    thresholdLabel: formatResearchValue(threshold),
    entries,
    activeEntries: entries.filter(entry => entry.hasProgress),
    hasAnyProgress: entries.some(entry => entry.hasProgress)
  };
}

export async function addOrganismDevelopment(actor, developmentValues = {}) {
  if (!actor || !developmentValues || typeof developmentValues !== "object") {
    return { upgraded: false, characteristicKey: null };
  }

  const threshold = getOrganismDevelopmentThreshold(actor);
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
  const changeKey = `system.characteristics.${characteristicKey}.value`;
  let existingEffect = actor.effects.find(effect => (effect.name || effect.label) === ORGANISM_EFFECT_NAME);

  if (existingEffect) {
    const changes = [...(existingEffect.changes ?? [])];
    const existingChange = changes.find(change => change.key === changeKey);
    if (existingChange) {
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
