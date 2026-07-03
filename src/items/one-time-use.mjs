import { SYSTEM_ID } from "../constants.mjs";
import {
  getCharacteristicSettings,
  getDamageTypeSettings,
  getNeedSettings,
  getProficiencySettings,
  getResourceSettings,
  getSkillSettings
} from "../settings/accessors.mjs";
import { buildEffectKeyTokens } from "../utils/effect-key-tokens.mjs";
import { escapeHtml } from "../utils/dom.mjs";
import {
  createItemStackPartRemovalUpdate,
  getItemQuantity,
  usesVirtualInventoryStacks
} from "../utils/inventory-containers.mjs";
import { getOneTimeUseFunction, hasItemFunction, ITEM_FUNCTIONS } from "../utils/item-functions.mjs";

const ONE_TIME_USE_STUDIED_FLAG = "oneTimeUseStudied";
const LEGACY_ONE_TIME_USE_STUDIED_FLAG = "oneTimeUseDump";
const LEGACY_ONE_TIME_USE_STUDIED_NAME = "Свалка";
const LEGACY_SKILL_KEY_REMAPS = Object.freeze({
  pilot: "athletics",
  intimidation: "speech"
});

export async function useOneTimeUseItem({ actor = null, item = null } = {}) {
  if (!actor || !item || !hasItemFunction(item, ITEM_FUNCTIONS.oneTimeUse)) return false;

  const oneTimeUse = getOneTimeUseFunction(item);
  const changes = normalizeOneTimeUseChanges(oneTimeUse.changes);
  if (!changes.length) {
    ui.notifications.warn(`${item.name}: изменения не настроены.`);
    return false;
  }
  if (getItemQuantity(item) <= 0) {
    ui.notifications.warn(`${item.name}: предмет израсходован.`);
    return false;
  }

  const studiedEffect = findOneTimeUseStudiedEffect(actor);
  if (isOneTimeUseRepeatBlocked(oneTimeUse, studiedEffect, item.name)) {
    ui.notifications.warn(`${item.name}: уже изучено, повторное применение недоступно.`);
    return false;
  }

  await applyOneTimeUseChanges(actor, item, changes, studiedEffect);
  await spendOneTimeUseItem(item);
  Hooks.callAll("fallout-maw.itemUsed", {
    actor,
    targetActor: actor,
    item,
    action: "oneTimeUse"
  });
  return true;
}

export function isOneTimeUseRepeatBlocked(oneTimeUse = {}, studiedEffect = null, itemName = "") {
  if (!Boolean(oneTimeUse?.repeatApplicationBlocked)) return false;
  const normalizedName = String(itemName ?? "").trim();
  if (!normalizedName) return false;
  return getOneTimeUseStudiedAppliedItems(studiedEffect)
    .some(entry => String(entry?.itemName ?? "").trim() === normalizedName);
}

export function normalizeOneTimeUseChanges(changes = []) {
  const source = Array.isArray(changes) ? changes : Object.values(changes ?? {});
  return source
    .map(change => ({
      id: String(change?.id ?? "").trim() || foundry.utils.randomID(),
      key: remapOneTimeUseChangeKey(String(change?.key ?? "").trim()),
      type: String(change?.type ?? "add").trim() || "add",
      value: String(change?.value ?? "").trim(),
      phase: String(change?.phase ?? "initial").trim() || "initial",
      priority: change?.priority ?? null
    }))
    .filter(change => change.key && change.value !== "");
}

export function remapOneTimeUseChangeKey(key = "") {
  let normalized = String(key ?? "").trim();
  if (!normalized) return "";

  for (const [legacyKey, nextKey] of Object.entries(LEGACY_SKILL_KEY_REMAPS)) {
    normalized = normalized.replaceAll(`system.skills.${legacyKey}.`, `system.skills.${nextKey}.`);
  }
  return normalized;
}

async function applyOneTimeUseChanges(actor, item, changes = [], studiedEffect = null) {
  const effect = studiedEffect ?? findOneTimeUseStudiedEffect(actor);
  const appliedItems = upsertStudiedAppliedItem(
    normalizeStudiedAppliedItems(getOneTimeUseStudiedAppliedItems(effect)),
    item,
    changes
  );

  const mergedChanges = mergeOneTimeUseEffectChanges(
    effect?.system?.changes ?? effect?.changes ?? [],
    changes
  );
  const description = buildOneTimeUseStudiedDescription(appliedItems);
  const effectData = buildOneTimeUseStudiedEffectData({
    changes: mergedChanges,
    description,
    appliedItems
  });

  if (effect) {
    await effect.update({
      name: effectData.name,
      img: effectData.img,
      description: effectData.description,
      "system.changes": effectData.system.changes,
      [`flags.${SYSTEM_ID}.-${LEGACY_ONE_TIME_USE_STUDIED_FLAG}`]: null,
      [`flags.${SYSTEM_ID}.${ONE_TIME_USE_STUDIED_FLAG}`]: { appliedItems },
      [`flags.${SYSTEM_ID}.kind`]: "passive",
      disabled: false
    }, { animate: false });
    return;
  }

  await actor.createEmbeddedDocuments("ActiveEffect", [effectData], { animate: false });
}

export function findOneTimeUseStudiedEffect(actor) {
  return (actor?.effects ?? []).find(effect => isOneTimeUseStudiedEffect(effect)) ?? null;
}

function isOneTimeUseStudiedEffect(effect) {
  if (!effect) return false;
  if (effect.getFlag?.(SYSTEM_ID, ONE_TIME_USE_STUDIED_FLAG)) return true;
  if (effect.getFlag?.(SYSTEM_ID, LEGACY_ONE_TIME_USE_STUDIED_FLAG)) return true;
  return String(effect.name ?? "").trim() === getOneTimeUseStudiedEffectName()
    || String(effect.name ?? "").trim() === LEGACY_ONE_TIME_USE_STUDIED_NAME;
}

function getOneTimeUseStudiedAppliedItems(effect) {
  if (!effect) return [];
  const flagData = effect.getFlag?.(SYSTEM_ID, ONE_TIME_USE_STUDIED_FLAG)
    ?? effect.getFlag?.(SYSTEM_ID, LEGACY_ONE_TIME_USE_STUDIED_FLAG);
  const appliedItems = flagData?.appliedItems;
  return Array.isArray(appliedItems) ? appliedItems : [];
}

function getOneTimeUseStudiedEffectName() {
  const localized = game.i18n.localize("FALLOUTMAW.Effects.Studied");
  return localized === "FALLOUTMAW.Effects.Studied" ? "Изученное" : localized;
}

function mergeOneTimeUseEffectChanges(existing = [], incoming = []) {
  const merged = (Array.isArray(existing) ? existing : []).map(change => foundry.utils.deepClone(change));
  for (const change of incoming) {
    const match = merged.find(entry =>
      entry.key === change.key
      && entry.type === change.type
      && String(entry.phase ?? "initial") === String(change.phase ?? "initial")
    );
    if (match && change.type === "add") {
      const current = Number(match.value) || 0;
      const next = Number(change.value) || 0;
      match.value = String(current + next);
      continue;
    }
    merged.push(foundry.utils.deepClone(change));
  }
  return merged;
}

function buildOneTimeUseStudiedEffectData({ changes = [], description = "", appliedItems = [] } = {}) {
  return {
    type: "base",
    name: getOneTimeUseStudiedEffectName(),
    description,
    img: "icons/svg/book.svg",
    disabled: false,
    transfer: false,
    duration: {},
    system: {
      changes
    },
    flags: {
      [SYSTEM_ID]: {
        kind: "passive",
        [ONE_TIME_USE_STUDIED_FLAG]: {
          appliedItems
        }
      }
    }
  };
}

function upsertStudiedAppliedItem(appliedItems = [], item = null, changes = []) {
  const itemName = String(item?.name ?? "Предмет").trim() || "Предмет";
  const itemId = String(item?.id ?? "");
  const nextItems = appliedItems.map(entry => ({
    itemId: String(entry?.itemId ?? ""),
    itemName: String(entry?.itemName ?? "Предмет").trim() || "Предмет",
    changes: (entry?.changes ?? []).map(change => foundry.utils.deepClone(change))
  }));
  const existing = nextItems.find(entry => entry.itemName === itemName);
  if (existing) {
    existing.itemId = itemId || existing.itemId;
    existing.changes = mergeOneTimeUseEffectChanges(existing.changes, changes);
    return nextItems;
  }
  nextItems.push({
    itemId,
    itemName,
    changes: changes.map(change => foundry.utils.deepClone(change))
  });
  return nextItems;
}

function normalizeStudiedAppliedItems(appliedItems = []) {
  const normalized = [];
  for (const entry of appliedItems ?? []) {
    const itemName = String(entry?.itemName ?? "Предмет").trim() || "Предмет";
    const existing = normalized.find(item => item.itemName === itemName);
    if (existing) {
      existing.itemId = String(entry?.itemId ?? existing.itemId ?? "");
      existing.changes = mergeOneTimeUseEffectChanges(existing.changes, entry?.changes ?? []);
      continue;
    }
    normalized.push({
      itemId: String(entry?.itemId ?? ""),
      itemName,
      changes: (entry?.changes ?? []).map(change => foundry.utils.deepClone(change))
    });
  }
  return normalized;
}

function buildOneTimeUseStudiedDescription(appliedItems = []) {
  const pathLabels = buildOneTimeUsePathLabelMap();
  return normalizeStudiedAppliedItems(appliedItems).map(entry => {
    const itemName = escapeHtml(String(entry?.itemName ?? "Предмет"));
    const changeSummaries = (entry?.changes ?? [])
      .map(change => escapeHtml(formatOneTimeUseChangeSummary(change, pathLabels)))
      .filter(Boolean)
      .join(", ");
    const line = changeSummaries ? `${itemName}: ${changeSummaries}` : itemName;
    return `<p>${line}</p>`;
  }).join("");
}

function buildOneTimeUsePathLabelMap() {
  const map = new Map();
  for (const token of buildEffectKeyTokens()) {
    if (token?.path) map.set(token.path, token.label || token.path);
  }
  for (const entry of getSkillSettings()) {
    map.set(`system.skills.${entry.key}.bonus`, entry.label ?? entry.key);
    map.set(`system.skills.${entry.key}.value`, entry.label ?? entry.key);
  }
  for (const entry of getCharacteristicSettings()) {
    map.set(`system.characteristics.${entry.key}`, entry.label ?? entry.key);
  }
  for (const entry of getResourceSettings()) {
    map.set(`system.resources.${entry.key}.bonus`, entry.label ?? entry.key);
    map.set(`system.resources.${entry.key}.max`, entry.label ?? entry.key);
  }
  for (const entry of getNeedSettings()) {
    map.set(`system.needs.${entry.key}.bonus`, entry.label ?? entry.key);
  }
  for (const entry of getProficiencySettings()) {
    map.set(`system.proficiencies.${entry.key}.bonus`, entry.label ?? entry.key);
  }
  for (const entry of getDamageTypeSettings()) {
    map.set(`system.damageMitigation.${entry.key}.bonus`, entry.label ?? entry.key);
  }
  return map;
}

function formatOneTimeUseChangeSummary(change = {}, pathLabels = new Map()) {
  const pathLabel = pathLabels.get(change.key) ?? formatOneTimeUseFallbackPathLabel(change.key);
  const value = formatOneTimeUseChangeValue(change.type, change.value);
  return value ? `${pathLabel}: ${value}` : pathLabel;
}

function formatOneTimeUseFallbackPathLabel(key = "") {
  return String(key ?? "")
    .replace(/^system\./, "")
    .split(".")
    .filter(Boolean)
    .join(" / ");
}

function formatOneTimeUseChangeValue(type = "add", value = "") {
  const normalizedType = String(type ?? "add");
  const normalizedValue = String(value ?? "").trim();
  if (!normalizedValue) return "";

  if (normalizedType === "add") {
    const number = Number(normalizedValue);
    if (Number.isFinite(number)) return number >= 0 ? `+${normalizedValue}` : normalizedValue;
    return normalizedValue.startsWith("-") ? normalizedValue : `+${normalizedValue}`;
  }
  if (normalizedType === "override") return `= ${normalizedValue}`;
  if (normalizedType === "multiply") return `× ${normalizedValue}`;
  if (normalizedType === "upgrade") return `≥ ${normalizedValue}`;
  if (normalizedType === "downgrade") return `≤ ${normalizedValue}`;
  return normalizedValue;
}

async function spendOneTimeUseItem(item) {
  const quantity = getItemQuantity(item);
  if (usesVirtualInventoryStacks(item)) {
    const updateData = createItemStackPartRemovalUpdate(item, 1, 0);
    if (!updateData || (updateData["system.quantity"] ?? 0) <= 0) return item.delete();
    const { _id, ...changes } = updateData;
    return item.update(changes);
  }
  const next = Math.max(0, quantity - 1);
  if (next <= 0) return item.delete();
  return item.update({ "system.quantity": next });
}
