import { SYSTEM_ID } from "../constants.mjs";
import {
  ABILITY_CONDITION_TYPES,
  ABILITY_FUNCTION_TYPES,
  getAbilitySourceId,
  normalizeAbilityFunctions
} from "../settings/abilities.mjs";
import { abilityConditionsApply, getAbilityEffectChanges, getAbilityEffectChangesFromFunctions } from "./evaluation.mjs";

const ABILITY_EFFECT_FLAG_KEY = "abilityEffect";
const ITEM_EFFECT_FLAG_KEY = "itemEffect";
const ACTIVE_EFFECT_SHOW_ICON_CONDITIONAL = 1;
const ACTIVE_EFFECT_SHOW_ICON_ALWAYS = 2;
const processingActors = new Set();

export function registerAbilityEffectHooks() {
  Hooks.on("createItem", item => {
    if (item?.type === "ability" || isEquipmentItem(item) || hasItemFreeSettingsFunction(item)) void syncActorAbilityEffects(item.parent);
  });
  Hooks.on("updateItem", (item, changes) => {
    if (item?.type === "ability" || isEquipmentItem(item) || isEquipmentItemUpdate(changes) || isItemFreeSettingsUpdate(item, changes)) void syncActorAbilityEffects(item.parent);
  });
  Hooks.on("deleteItem", item => {
    if (item?.type === "ability") {
      void deleteAbilityEffects(item.parent, item.id);
      return;
    }
    if (item?.type === "gear") void deleteItemFreeSettingsEffects(item.parent, item.id);
    if (isEquipmentItem(item)) void syncActorAbilityEffects(item.parent);
  });
  Hooks.on("updateActor", (actor, changes) => {
    if (!isAbilityEffectSyncRelevant(changes)) return;
    void syncActorAbilityEffects(actor);
  });
  Hooks.on("updateActiveEffect", effect => {
    if (!effect?.getFlag?.(SYSTEM_ID, ABILITY_EFFECT_FLAG_KEY) && !effect?.getFlag?.(SYSTEM_ID, ITEM_EFFECT_FLAG_KEY)) return;
    void syncActorAbilityEffects(effect.parent);
  });
  Hooks.on("deleteActiveEffect", effect => {
    if (!effect?.getFlag?.(SYSTEM_ID, ABILITY_EFFECT_FLAG_KEY) && !effect?.getFlag?.(SYSTEM_ID, ITEM_EFFECT_FLAG_KEY)) return;
    void syncActorAbilityEffects(effect.parent);
  });
  Hooks.on("canvasReady", () => void syncLoadedActorAbilityEffects());
}

export async function syncLoadedActorAbilityEffects() {
  if (!game.user?.isActiveGM) return;
  const actors = new Map();
  for (const actor of game.actors ?? []) actors.set(actor.uuid, actor);
  for (const token of canvas?.tokens?.placeables ?? []) {
    if (token.actor) actors.set(token.actor.uuid, token.actor);
  }
  for (const actor of actors.values()) await syncActorAbilityEffects(actor);
}

export async function syncActorAbilityEffects(actor) {
  if (!actor || !game.user?.isActiveGM) return;
  if (!["character", "construct"].includes(actor.type)) return;
  if (processingActors.has(actor.uuid)) return;

  processingActors.add(actor.uuid);
  try {
    const abilityItems = actor.items?.filter(item => item.type === "ability") ?? [];
    const activeAbilityItemIds = new Set(abilityItems.map(item => item.id));
    const itemFreeSettingsItems = actor.items?.filter(item => isActiveItemFreeSettingsItem(item)) ?? [];
    const activeItemFreeSettingsItemIds = new Set(itemFreeSettingsItems.map(item => item.id));

    for (const item of abilityItems) {
      await syncSingleAbilityEffect(actor, item);
    }
    for (const item of itemFreeSettingsItems) {
      await syncSingleItemFreeSettingsEffect(actor, item);
    }

    const stale = actor.effects
      .filter(effect => {
        const data = effect.getFlag(SYSTEM_ID, ABILITY_EFFECT_FLAG_KEY);
        return data?.abilityItemId && !activeAbilityItemIds.has(data.abilityItemId);
      })
      .map(effect => effect.id);
    if (stale.length) await actor.deleteEmbeddedDocuments("ActiveEffect", stale);

    const staleItemEffects = actor.effects
      .filter(effect => {
        const data = effect.getFlag(SYSTEM_ID, ITEM_EFFECT_FLAG_KEY);
        return data?.itemId && !activeItemFreeSettingsItemIds.has(data.itemId);
      })
      .map(effect => effect.id);
    if (staleItemEffects.length) await actor.deleteEmbeddedDocuments("ActiveEffect", staleItemEffects);
  } finally {
    processingActors.delete(actor.uuid);
  }
}

async function syncSingleAbilityEffect(actor, item) {
  const existing = actor.effects.filter(effect => effect.getFlag(SYSTEM_ID, ABILITY_EFFECT_FLAG_KEY)?.abilityItemId === item.id);
  const changes = buildAbilityEffectChanges(actor, item);
  if (!changes.length) {
    if (existing.length) await actor.deleteEmbeddedDocuments("ActiveEffect", existing.map(effect => effect.id));
    return;
  }

  const sourceId = getAbilitySourceId(item);
  const showIcon = getAbilityEffectShowIcon(actor, item);
  const signature = JSON.stringify({ itemId: item.id, sourceId, changes, showIcon });
  const current = existing.find(effect => effect.getFlag(SYSTEM_ID, ABILITY_EFFECT_FLAG_KEY)?.signature === signature);
  const obsolete = existing.filter(effect => effect.id !== current?.id).map(effect => effect.id);
  if (obsolete.length) await actor.deleteEmbeddedDocuments("ActiveEffect", obsolete);

  if (current) {
    const update = {};
    if (current.disabled) update.disabled = false;
    if (current.name !== item.name) update.name = item.name;
    if (current.img !== item.img) update.img = item.img;
    if (current.origin !== item.uuid) update.origin = item.uuid;
    if (current.showIcon !== showIcon) update.showIcon = showIcon;
    if (Object.keys(update).length) await current.update(update);
    return;
  }

  await actor.createEmbeddedDocuments("ActiveEffect", [buildAbilityActiveEffectData(item, changes, signature, sourceId, showIcon)]);
}

async function syncSingleItemFreeSettingsEffect(actor, item) {
  const existing = actor.effects.filter(effect => effect.getFlag(SYSTEM_ID, ITEM_EFFECT_FLAG_KEY)?.itemId === item.id);
  const changes = buildItemFreeSettingsEffectChanges(actor, item);
  if (!changes.length) {
    if (existing.length) await actor.deleteEmbeddedDocuments("ActiveEffect", existing.map(effect => effect.id));
    return;
  }

  const showIcon = getItemFreeSettingsEffectShowIcon(actor, item);
  const signature = JSON.stringify({ itemId: item.id, changes, showIcon });
  const current = existing.find(effect => effect.getFlag(SYSTEM_ID, ITEM_EFFECT_FLAG_KEY)?.signature === signature);
  const obsolete = existing.filter(effect => effect.id !== current?.id).map(effect => effect.id);
  if (obsolete.length) await actor.deleteEmbeddedDocuments("ActiveEffect", obsolete);

  if (current) {
    const update = {};
    if (current.disabled) update.disabled = false;
    if (current.name !== item.name) update.name = item.name;
    if (current.img !== item.img) update.img = item.img;
    if (current.origin !== item.uuid) update.origin = item.uuid;
    if (current.showIcon !== showIcon) update.showIcon = showIcon;
    if (Object.keys(update).length) await current.update(update);
    return;
  }

  await actor.createEmbeddedDocuments("ActiveEffect", [buildItemFreeSettingsActiveEffectData(item, changes, signature, showIcon)]);
}

function buildAbilityActiveEffectData(item, changes, signature, sourceId, showIcon) {
  return {
    type: "base",
    name: item.name,
    img: item.img || "icons/svg/aura.svg",
    origin: item.uuid,
    transfer: false,
    disabled: false,
    showIcon,
    system: { changes },
    flags: {
      [SYSTEM_ID]: {
        kind: "active",
        [ABILITY_EFFECT_FLAG_KEY]: {
          abilityItemId: item.id,
          abilitySourceId: sourceId,
          signature
        }
      }
    }
  };
}

function buildItemFreeSettingsActiveEffectData(item, changes, signature, showIcon) {
  return {
    type: "base",
    name: item.name,
    img: item.img || "icons/svg/item-bag.svg",
    origin: item.uuid,
    transfer: false,
    disabled: false,
    showIcon,
    system: { changes },
    flags: {
      [SYSTEM_ID]: {
        kind: "active",
        [ITEM_EFFECT_FLAG_KEY]: {
          itemId: item.id,
          signature
        }
      }
    }
  };
}

function buildAbilityEffectChanges(actor, item) {
  return getAbilityEffectChanges(actor, item)
    .filter(change => !String(change?.key ?? "").startsWith("system.skillAdvancementBase."));
}

function buildItemFreeSettingsEffectChanges(actor, item) {
  return getAbilityEffectChangesFromFunctions(actor, item?.system?.functions?.freeSettings?.entries ?? [], {
    abilityItemId: item?.id ?? ""
  })
    .filter(change => !String(change?.key ?? "").startsWith("system.skillAdvancementBase."));
}

function getAbilityEffectShowIcon(actor, item) {
  return hasActiveRuntimeAbilityState(actor, item)
    ? ACTIVE_EFFECT_SHOW_ICON_ALWAYS
    : ACTIVE_EFFECT_SHOW_ICON_CONDITIONAL;
}

function getItemFreeSettingsEffectShowIcon(actor, item) {
  return hasActiveRuntimeItemFreeSettingsState(actor, item)
    ? ACTIVE_EFFECT_SHOW_ICON_ALWAYS
    : ACTIVE_EFFECT_SHOW_ICON_CONDITIONAL;
}

function hasActiveRuntimeAbilityState(actor, item) {
  return normalizeAbilityFunctions(item?.system?.functions ?? [])
    .filter(entry => entry.type === ABILITY_FUNCTION_TYPES.effectChanges)
    .some(entry => {
      const conditions = entry.conditions ?? [];
      if (!hasRuntimeConditions(conditions)) return false;
      return abilityConditionsApply(actor, conditions, {
        abilityItemId: item.id,
        functionId: entry.id
      })
        ? hasApplicableAbilityChanges(entry.changes)
        : hasApplicableAbilityChanges(entry.penalties);
    });
}

function hasActiveRuntimeItemFreeSettingsState(actor, item) {
  return normalizeAbilityFunctions(item?.system?.functions?.freeSettings?.entries ?? [])
    .filter(entry => entry.type === ABILITY_FUNCTION_TYPES.effectChanges)
    .some(entry => {
      const conditions = entry.conditions ?? [];
      if (!hasRuntimeConditions(conditions)) return false;
      return abilityConditionsApply(actor, conditions, {
        abilityItemId: item.id,
        functionId: entry.id
      })
        ? hasApplicableAbilityChanges(entry.changes)
        : hasApplicableAbilityChanges(entry.penalties);
    });
}

function hasRuntimeConditions(conditions = []) {
  return conditions.some(condition => (
    condition?.type
    && condition.type !== ABILITY_CONDITION_TYPES.limitedChanges
    && condition.type !== ABILITY_CONDITION_TYPES.cooldown
  ));
}

function hasApplicableAbilityChanges(changes = []) {
  return (changes ?? []).some(change => (
    String(change?.key ?? "").trim()
    && String(change?.value ?? "") !== ""
    && !String(change?.key ?? "").startsWith("system.skillAdvancementBase.")
  ));
}

async function deleteAbilityEffects(actor, abilityItemId = "") {
  if (!actor || !game.user?.isActiveGM || !abilityItemId) return;
  const ids = actor.effects
    .filter(effect => effect.getFlag(SYSTEM_ID, ABILITY_EFFECT_FLAG_KEY)?.abilityItemId === abilityItemId)
    .map(effect => effect.id);
  if (ids.length) await actor.deleteEmbeddedDocuments("ActiveEffect", ids);
}

function isAbilityEffectSyncRelevant(changes = {}) {
  const paths = Object.keys(foundry.utils.flattenObject(changes ?? {}));
  return paths.some(path => path === "system.resources.health"
    || path.startsWith("system.resources.health.")
    || path === "system.limbs"
    || path.startsWith("system.limbs.")
    || path === "system.creature.raceId");
}

async function deleteItemFreeSettingsEffects(actor, itemId = "") {
  if (!actor || !game.user?.isActiveGM || !itemId) return;
  const ids = actor.effects
    .filter(effect => effect.getFlag(SYSTEM_ID, ITEM_EFFECT_FLAG_KEY)?.itemId === itemId)
    .map(effect => effect.id);
  if (ids.length) await actor.deleteEmbeddedDocuments("ActiveEffect", ids);
}

function isEquipmentItem(item) {
  if (!item?.parent || item.type === "ability") return false;
  return item.system?.placement?.mode === "equipment"
    || item.system?.placement?.mode === "weapon"
    || Object.values(item.system?.occupiedSlots ?? {}).some(Boolean);
}

function isEquipmentItemUpdate(changes = {}) {
  const paths = Object.keys(foundry.utils.flattenObject(changes ?? {}));
  return paths.some(path => path === "system.placement"
    || path.startsWith("system.placement.")
    || path === "system.equipped"
    || path === "system.occupiedSlots"
    || path.startsWith("system.occupiedSlots."));
}

function hasItemFreeSettingsFunction(item) {
  return item?.type === "gear" && Boolean(item.system?.functions?.freeSettings?.enabled);
}

function isActiveItemFreeSettingsItem(item) {
  if (!hasItemFreeSettingsFunction(item)) return false;
  return Boolean(item.system?.equipped)
    || item.system?.placement?.mode === "equipment"
    || item.system?.placement?.mode === "weapon"
    || item.system?.placement?.mode === "constructPart";
}

function isItemFreeSettingsUpdate(item, changes = {}) {
  if (item?.type !== "gear") return false;
  const paths = Object.keys(foundry.utils.flattenObject(changes ?? {}));
  return hasItemFreeSettingsFunction(item)
    || paths.some(path => path === "system.functions.freeSettings"
      || path.startsWith("system.functions.freeSettings.")
      || path === "system.equipped"
      || path === "system.placement"
      || path.startsWith("system.placement.")
      || path === "system.functions.constructPart"
      || path.startsWith("system.functions.constructPart."));
}
