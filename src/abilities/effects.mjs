import { SYSTEM_ID } from "../constants.mjs";
import { getCharacteristicSettings, getSkillSettings } from "../settings/accessors.mjs";
import { getAbilitySourceId } from "../settings/abilities.mjs";
import { toInteger } from "../utils/numbers.mjs";

const ABILITY_EFFECT_FLAG_KEY = "abilityEffect";
const ACTIVE_EFFECT_SHOW_ICON_ALWAYS = 2;
const processingActors = new Set();

export function registerAbilityEffectHooks() {
  Hooks.on("createItem", item => {
    if (item?.type === "ability") void syncActorAbilityEffects(item.parent);
  });
  Hooks.on("updateItem", item => {
    if (item?.type === "ability") void syncActorAbilityEffects(item.parent);
  });
  Hooks.on("deleteItem", item => {
    if (item?.type === "ability") void deleteAbilityEffects(item.parent, item.id);
  });
  Hooks.on("updateActor", (actor, changes) => {
    if (!isAbilityEffectSyncRelevant(changes)) return;
    void syncActorAbilityEffects(actor);
  });
  Hooks.on("updateActiveEffect", effect => {
    if (!effect?.getFlag?.(SYSTEM_ID, ABILITY_EFFECT_FLAG_KEY)) return;
    void syncActorAbilityEffects(effect.parent);
  });
  Hooks.on("deleteActiveEffect", effect => {
    if (!effect?.getFlag?.(SYSTEM_ID, ABILITY_EFFECT_FLAG_KEY)) return;
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
  if (!["character", "npc"].includes(actor.type)) return;
  if (processingActors.has(actor.uuid)) return;

  processingActors.add(actor.uuid);
  try {
    const abilityItems = actor.items?.filter(item => item.type === "ability") ?? [];
    const activeAbilityItemIds = new Set(abilityItems.map(item => item.id));

    for (const item of abilityItems) {
      await syncSingleAbilityEffect(actor, item);
    }

    const stale = actor.effects
      .filter(effect => {
        const data = effect.getFlag(SYSTEM_ID, ABILITY_EFFECT_FLAG_KEY);
        return data?.abilityItemId && !activeAbilityItemIds.has(data.abilityItemId);
      })
      .map(effect => effect.id);
    if (stale.length) await actor.deleteEmbeddedDocuments("ActiveEffect", stale);
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
  const signature = JSON.stringify({ itemId: item.id, sourceId, changes });
  const current = existing.find(effect => effect.getFlag(SYSTEM_ID, ABILITY_EFFECT_FLAG_KEY)?.signature === signature);
  const obsolete = existing.filter(effect => effect.id !== current?.id).map(effect => effect.id);
  if (obsolete.length) await actor.deleteEmbeddedDocuments("ActiveEffect", obsolete);

  if (current) {
    const update = {};
    if (current.disabled) update.disabled = false;
    if (current.name !== item.name) update.name = item.name;
    if (current.img !== item.img) update.img = item.img;
    if (current.origin !== item.uuid) update.origin = item.uuid;
    if (Object.keys(update).length) await current.update(update);
    return;
  }

  await actor.createEmbeddedDocuments("ActiveEffect", [buildAbilityActiveEffectData(item, changes, signature, sourceId)]);
}

function buildAbilityActiveEffectData(item, changes, signature, sourceId) {
  return {
    type: "base",
    name: item.name,
    img: item.img || "icons/svg/aura.svg",
    origin: item.uuid,
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
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

function buildAbilityEffectChanges(actor, item) {
  const characteristicKeys = new Set(getCharacteristicSettings().map(entry => entry.key));
  const skillKeys = new Set(getSkillSettings().map(entry => entry.key));
  const healthPercent = getHealthPercent(actor.system);
  const changes = [];

  for (const entry of item.system?.functions ?? []) {
    if (!abilityConditionApplies(entry?.condition, healthPercent)) continue;
    const target = String(entry?.target ?? "");
    const value = toInteger(entry?.value);
    if (!target || !value) continue;

    const key = getAbilityEffectKey(entry.type, target, characteristicKeys, skillKeys);
    if (!key) continue;
    changes.push({
      key,
      type: "add",
      value: String(value),
      phase: "initial",
      priority: null
    });
  }

  return changes;
}

function getAbilityEffectKey(type, target, characteristicKeys, skillKeys) {
  if (type === "characteristicBonus" && characteristicKeys.has(target)) return `system.characteristics.${target}`;
  if (type === "skillBonus" && skillKeys.has(target)) return `system.skills.${target}.bonus`;
  return "";
}

function abilityConditionApplies(condition = {}, healthPercent = 100) {
  if (!condition?.enabled) return true;
  const threshold = Math.max(0, Math.min(100, toInteger(condition.percent ?? 50)));
  return String(condition.operator ?? "lte") === "gte"
    ? healthPercent >= threshold
    : healthPercent <= threshold;
}

function getHealthPercent(sourceSystem = {}) {
  const health = sourceSystem?.resources?.health;
  const max = Math.max(0, Number(health?.max) || 0);
  if (max <= 0) return 100;

  const value = Number.isFinite(Number(health?.value))
    ? Number(health.value)
    : max - Math.max(0, Number(health?.spent) || 0);
  return Math.max(0, Math.min(100, (value / max) * 100));
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
    || path.startsWith("system.limbs."));
}
