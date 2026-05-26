import { FALLOUT_MAW } from "../config/system-config.mjs";
import { getAbilityCatalog } from "../settings/accessors.mjs";
import { ABILITY_SOURCE_FLAG, getAbilitySourceId, prepareAbilityItemData } from "../settings/abilities.mjs";
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
  return created?.[0] ?? null;
}

export async function completeAbilityResearch(actor, researchId = "") {
  const research = getResearchById(actor?.system?.researches, researchId);
  if (!research || research.type !== "ability") return null;
  if (Number(research.progress) < Number(research.target)) return null;

  const created = await grantCatalogAbility(actor, research.sourceId);
  await actor.deleteResearch(researchId);
  return {
    research,
    item: created
  };
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
