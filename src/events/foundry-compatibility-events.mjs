import { SYSTEM_ID } from "../constants.mjs";
import { dispatchSystemEvent } from "./dispatcher.mjs";

let hooksRegistered = false;

/** Semantic mirrors for existing gameplay Hooks. The legacy Hooks remain the compatibility surface. */
export function registerFoundryCompatibilitySystemEventHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  Hooks.on("fallout-maw.weaponActionResolved", context => void emitWeaponActionResolved(context));
  Hooks.on("fallout-maw.weaponAttackCheckResolved", context => void emitWeaponAttackCheckResolved(context));
  Hooks.on("fallout-maw.energyConsumptionChanged", actor => void emitEnergyConsumptionChanged(actor));
  Hooks.on(`${SYSTEM_ID}.recipeKnowledgeUpdated`, context => void emitRecipeKnowledgeChanged(context));
}

async function emitWeaponActionResolved(context = {}) {
  const actor = context.actor ?? context.weapon?.actor ?? null;
  if (!actor) return;
  await dispatchSystemEvent("fallout-maw.weapon.action.resolved", {
    data: {
      actorUuid: String(actor.uuid ?? ""),
      weaponUuid: String(context.weapon?.uuid ?? ""),
      actionKey: String(context.actionKey ?? context.weaponActionKey ?? ""),
      weaponFunctionId: String(context.weaponFunctionId ?? "")
    },
    outcome: { success: true }
  }, {
    kind: "legacyWeaponActionResolved",
    operationId: `weapon-action:${actor.uuid}:${foundry.utils.randomID()}`,
    sceneUuid: String(canvas?.scene?.uuid ?? ""),
    combatUuid: String(game.combat?.uuid ?? ""),
    chainRef: context?.chainRef ?? null,
    participants: { source: participant(actor, context.token, context.weapon), target: null, related: [] }
  });
}

async function emitWeaponAttackCheckResolved(context = {}) {
  const actor = context.actor ?? context.token?.actor ?? null;
  if (!actor) return;
  const outcome = context.outcome ?? {};
  await dispatchSystemEvent("fallout-maw.weapon.attack.checkResolved", {
    data: {
      actorUuid: String(actor.uuid ?? ""),
      weaponUuid: String(context.weapon?.uuid ?? ""),
      actionKey: String(context.actionKey ?? ""),
      weaponFunctionId: String(context.weaponFunctionId ?? ""),
      attackId: String(context.weaponAttackId ?? ""),
      resultKey: String(outcome?.result?.key ?? outcome?.resultKey ?? ""),
      success: Boolean(outcome?.success ?? outcome?.result?.success)
    },
    outcome: {
      success: Boolean(outcome?.success ?? outcome?.result?.success),
      resultKey: String(outcome?.result?.key ?? outcome?.resultKey ?? "")
    }
  }, {
    kind: "legacyWeaponAttackCheckResolved",
    operationId: `weapon-check:${context.weaponAttackId ?? foundry.utils.randomID()}`,
    sceneUuid: String(context.token?.document?.parent?.uuid ?? canvas?.scene?.uuid ?? ""),
    combatUuid: String(game.combat?.uuid ?? ""),
    chainRef: context?.chainRef ?? null,
    participants: { source: participant(actor, context.token, context.weapon), target: null, related: [] }
  });
}

async function emitEnergyConsumptionChanged(actor) {
  if (!isCurrentActiveGM() || !actor?.uuid) return;
  await dispatchSystemEvent("fallout-maw.item.energyConsumer.changed", {
    data: { actorUuid: String(actor.uuid), source: "energyConsumption" }
  }, {
    kind: "energyConsumptionChanged",
    operationId: `energy-consumption:${actor.uuid}:${foundry.utils.randomID()}`,
    sceneUuid: String(canvas?.scene?.uuid ?? ""),
    combatUuid: String(game.combat?.uuid ?? ""),
    participants: { source: participant(actor), target: null, related: [] }
  });
}

async function emitRecipeKnowledgeChanged(context = {}) {
  if (!isCurrentActiveGM()) return;
  const actors = Array.from(context?.actors ?? []).filter(actor => actor?.uuid);
  for (const actor of actors) {
    await dispatchSystemEvent("fallout-maw.actor.recipe.learned", {
      data: { actorUuid: String(actor.uuid), source: "recipeKnowledgeManager" }
    }, {
      kind: "recipeKnowledgeChanged",
      operationId: `recipe-knowledge:${actor.uuid}:${foundry.utils.randomID()}`,
      sceneUuid: String(canvas?.scene?.uuid ?? ""),
      combatUuid: String(game.combat?.uuid ?? ""),
      participants: { source: participant(actor), target: null, related: [] }
    });
  }
}

function participant(actor = null, token = null, item = null) {
  const tokenDocument = token?.document ?? token;
  const value = {
    actorUuid: String(actor?.uuid ?? ""),
    tokenUuid: String(tokenDocument?.uuid ?? ""),
    itemUuid: String(item?.uuid ?? "")
  };
  return Object.values(value).some(Boolean) ? value : null;
}

function isCurrentActiveGM() {
  return Boolean(game.users?.activeGM?.id && game.users.activeGM.id === game.user?.id);
}
