import { FALLOUT_MAW } from "../config/system-config.mjs";
import { getAbilityCatalog } from "../settings/accessors.mjs";
import { ABILITY_SOURCE_FLAG, getAbilitySourceId, prepareAbilityItemData } from "../settings/abilities.mjs";
import { getAbilityAcquisitionChanges } from "./evaluation.mjs";
import { getResearchById } from "../research/storage.mjs";

export function findCatalogAbility(sourceId = "", catalog = getAbilityCatalog()) {
  const normalizedSourceId = String(sourceId ?? "").trim();
  if (!normalizedSourceId) return null;
  for (const category of catalog.categories ?? []) {
    const ability = (category.abilities ?? []).find(entry => entry.id === normalizedSourceId);
    if (ability) return { ability, category };
  }
  return null;
}

export function actorHasAbility(actor, sourceId = "") {
  const normalizedSourceId = String(sourceId ?? "").trim();
  if (!normalizedSourceId) return false;
  return actor?.items?.some?.(item => item.type === "ability" && getAbilitySourceId(item) === normalizedSourceId) ?? false;
}

export async function grantCatalogAbility(actor, sourceId = "") {
  if (!actor || actorHasAbility(actor, sourceId)) return null;
  const entry = findCatalogAbility(sourceId);
  if (!entry) return null;
  const itemData = prepareAbilityItemData(entry.ability, { categoryId: entry.category.id });
  const created = await actor.createEmbeddedDocuments("Item", [itemData]);
  const item = created?.[0] ?? null;
  await applyAbilityAcquisitionChanges(actor, item);
  return item;
}

export async function completeAbilityResearch(actor, researchId = "") {
  const research = getResearchById(actor?.system?.researches, researchId);
  if (!research || research.type !== "ability") return null;
  if (Number(research.progress) < Number(research.target)) return null;

  const created = await grantAbilityResearchReward(actor, research);
  await actor.deleteResearch(researchId);
  return {
    research,
    item: created
  };
}

export async function grantAbilityResearchReward(actor, research = {}) {
  if (!actor) return null;
  const sourceId = String(research?.sourceId ?? "").trim();
  if (sourceId && actorHasAbility(actor, sourceId)) return null;

  const itemData = getAbilityRewardItemData(research) ?? getCatalogAbilityRewardItemData(sourceId);
  if (!itemData) return null;
  const normalizedItemData = foundry.utils.deepClone(itemData);
  delete normalizedItemData._id;

  const rewardSourceId = getRewardAbilitySourceId(normalizedItemData) || sourceId;
  if (rewardSourceId && actorHasAbility(actor, rewardSourceId)) return null;

  const created = await actor.createEmbeddedDocuments("Item", [normalizedItemData]);
  const item = created?.[0] ?? null;
  await applyAbilityAcquisitionChanges(actor, item);
  return item;
}

export async function clearAbilityResearchSpending(actor, sourceId = "") {
  const normalizedSourceId = String(sourceId ?? "").trim();
  if (!actor || !normalizedSourceId) return actor;
  const spending = foundry.utils.deepClone(actor.system?.development?.abilityResearches ?? {});
  if (!Object.hasOwn(spending, normalizedSourceId)) return actor;
  delete spending[normalizedSourceId];
  return actor.update({ "system.development.abilityResearches": spending });
}

export function getAbilitySourceFlagPath() {
  return `flags.${FALLOUT_MAW.id}.${ABILITY_SOURCE_FLAG}`;
}

function getAbilityRewardItemData(research = {}) {
  for (const reward of research.rewards ?? []) {
    const itemData = reward?.itemData;
    if (itemData?.type === "ability") return itemData;
  }
  return null;
}

function getCatalogAbilityRewardItemData(sourceId = "") {
  const entry = findCatalogAbility(sourceId);
  if (!entry) return null;
  return prepareAbilityItemData(entry.ability, { categoryId: entry.category.id });
}

function getRewardAbilitySourceId(itemData = {}) {
  return String(itemData?.flags?.[FALLOUT_MAW.id]?.[ABILITY_SOURCE_FLAG]?.id ?? "");
}

async function applyAbilityAcquisitionChanges(actor, item) {
  const changes = getAbilityAcquisitionChanges(item);
  if (!actor || !changes.length) return;

  const updates = {};
  for (const change of changes) {
    const key = String(change?.key ?? "").trim();
    if (!key.startsWith("system.")) continue;

    const current = Number(foundry.utils.getProperty(actor, key)) || 0;
    const value = Number(change?.value) || 0;
    let next = value;
    if (change.type === "add") next = current + value;
    else if (change.type === "multiply") next = current * value;
    else if (change.type === "upgrade") next = Math.max(current, value);
    else if (change.type === "downgrade") next = Math.min(current, value);
    foundry.utils.setProperty(updates, key, next);
  }

  if (Object.keys(foundry.utils.flattenObject(updates)).length) await actor.update(updates);
}
