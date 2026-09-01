import { SYSTEM_ID } from "../constants.mjs";
import { normalizeAttackDistanceContext } from "../utils/attack-distance.mjs";
import { serializeWeaponContextData } from "../utils/weapon-context.mjs";
import { dispatchSystemEvent } from "./dispatcher.mjs";

let hooksRegistered = false;

/** Semantic mirrors for existing gameplay Hooks. The legacy Hooks remain the compatibility surface. */
export function registerFoundryCompatibilitySystemEventHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  Hooks.on("fallout-maw.weaponActionResolved", context => void emitWeaponActionResolved(context));
  Hooks.on("fallout-maw.weaponAttackCheckResolved", context => {
    if (context?.falloutMawSemanticMirror === true) return;
    void emitWeaponAttackCheckResolved(context);
  });
  Hooks.on("fallout-maw.weaponAttackResolved", context => {
    if (context?.falloutMawSemanticMirror === true) return;
    void emitWeaponAttackResolved(context);
  });
  Hooks.on("fallout-maw.energyConsumptionChanged", actor => void emitEnergyConsumptionChanged(actor));
  Hooks.on(`${SYSTEM_ID}.recipeKnowledgeUpdated`, context => void emitRecipeKnowledgeChanged(context));
}

async function emitWeaponActionResolved(context = {}) {
  const actor = context.actor ?? context.weapon?.actor ?? null;
  if (!actor) return;
  const attackDistanceContext = normalizeAttackDistanceContext(context);
  await dispatchSystemEvent("fallout-maw.weapon.action.resolved", {
    data: {
      actorUuid: String(actor.uuid ?? ""),
      weaponUuid: String(context.weapon?.uuid ?? ""),
      actionKey: String(context.actionKey ?? context.weaponActionKey ?? ""),
      weaponFunctionId: String(context.weaponFunctionId ?? ""),
      weaponData: serializeWeaponContextData(context.weaponData),
      ...attackDistanceContext,
      damageHubOperationRef: String(context.damageHubOperationRef ?? "")
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

export async function emitWeaponAttackCheckResolved(context = {}) {
  const actor = context.actor ?? context.token?.actor ?? null;
  if (!actor) return;
  const outcome = context.outcome ?? {};
  const attackDistanceContext = normalizeAttackDistanceContext({
    attackDistanceMeters: context.attackDistanceMeters ?? outcome?.check?.attackDistanceMeters,
    effectiveRange: context.effectiveRange ?? outcome?.check?.effectiveRange
  });
  const checkOccurrenceId = String(context.checkOccurrenceId ?? "").trim()
    || `${String(context.weaponAttackId ?? "check")}:${foundry.utils.randomID()}`;
  await dispatchSystemEvent("fallout-maw.weapon.attack.checkResolved", {
    data: {
      actorUuid: String(actor.uuid ?? ""),
      weaponUuid: String(context.weapon?.uuid ?? ""),
      actionKey: String(context.actionKey ?? ""),
      weaponFunctionId: String(context.weaponFunctionId ?? ""),
      weaponData: serializeWeaponContextData(context.weaponData ?? outcome?.check?.weaponData),
      attackId: String(context.weaponAttackId ?? ""),
      resultKey: String(outcome?.result?.key ?? outcome?.resultKey ?? ""),
      success: Boolean(outcome?.success ?? outcome?.result?.success),
      ...attackDistanceContext,
      damageHubOperationRef: String(context.damageHubOperationRef ?? "")
    },
    outcome: {
      success: Boolean(outcome?.success ?? outcome?.result?.success),
      resultKey: String(outcome?.result?.key ?? outcome?.resultKey ?? "")
    }
  }, {
    kind: "legacyWeaponAttackCheckResolved",
    operationId: `weapon-check:${checkOccurrenceId}`,
    sceneUuid: String(context.token?.document?.parent?.uuid ?? canvas?.scene?.uuid ?? ""),
    combatUuid: String(game.combat?.uuid ?? ""),
    chainRef: context?.chainRef ?? null,
    participants: { source: participant(actor, context.token, context.weapon), target: null, related: [] }
  });
}

export async function emitWeaponAttackResolved(context = {}) {
  if (context?.attackCheckAggregate !== true) return;
  const actor = context.actor ?? context.actorToken?.actor ?? null;
  const actorUuid = String(actor?.uuid ?? context.attackerUuid ?? context.actorUuid ?? "").trim();
  const attackCheckCount = Math.max(0, Number(context.attackCheckCount) || 0);
  if (!actorUuid || attackCheckCount <= 0) return;

  const attackCheckTargetActorUuids = uniqueUuids(context.attackCheckTargetActorUuids);
  const targetActorUuids = uniqueUuids([
    ...attackCheckTargetActorUuids,
    ...(Array.isArray(context.targetActorUuids) ? context.targetActorUuids : [])
  ]);
  const successfulAttackTargetActorUuids = uniqueUuids(context.successfulAttackTargetActorUuids);
  const killedTargetUuids = uniqueUuids(context.killedTargetUuids);
  const successfulAttackCheckCount = Math.max(0, Number(context.successfulAttackCheckCount) || 0);
  const successfulAttack = context.successfulAttack === true || successfulAttackCheckCount > 0;
  const attackId = String(context.attackId ?? "").trim();
  const deferredImpactPending = context.deferredImpactPending === true;
  const deferredImpactResolution = context.deferredImpactResolution === true;
  const attackPhase = deferredImpactResolution
    ? "deferredImpact"
    : deferredImpactPending
      ? "deferredLaunch"
      : "immediate";
  const source = participant(actor, context.actorToken, null) ?? {
    actorUuid,
    tokenUuid: String(context.tokenUuid ?? ""),
    itemUuid: String(context.weaponUuid ?? "")
  };
  source.itemUuid ||= String(context.weaponUuid ?? "");

  await dispatchSystemEvent("fallout-maw.weapon.attack.resolved", {
    data: {
      actorUuid,
      weaponUuid: String(context.weaponUuid ?? ""),
      weaponName: String(context.weaponName ?? context.weapon?.name ?? ""),
      actionKey: String(context.actionKey ?? context.weaponActionKey ?? ""),
      weaponFunctionId: String(context.weaponFunctionId ?? ""),
      attackId,
      attackCheckCount,
      successfulAttackCheckCount,
      successfulAttack,
      attackCheckTargetActorUuids,
      successfulAttackTargetActorUuids,
      killedTargetUuids,
      targetActorUuids,
      attackCycleAggregate: true,
      attackPhase,
      deferredImpactPending,
      deferredImpactResolution,
      suppressGenericEventReactions: true
    },
    outcome: { success: successfulAttack }
  }, {
    kind: "weaponAttackCycleResolved",
    operationId: `weapon-attack-cycle:${attackId || foundry.utils.randomID()}${attackPhase === "immediate" ? "" : `:${attackPhase}`}`,
    sceneUuid: String(context.actorToken?.document?.parent?.uuid ?? canvas?.scene?.uuid ?? ""),
    combatUuid: String(game.combat?.uuid ?? ""),
    chainRef: context?.chainRef ?? null,
    participants: {
      source,
      target: null,
      related: targetActorUuids.map(actorUuid => ({ actorUuid, tokenUuid: "", itemUuid: "" }))
    }
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

function uniqueUuids(values = []) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map(value => String(value ?? "").trim())
    .filter(Boolean)));
}

function isCurrentActiveGM() {
  return Boolean(game.users?.activeGM?.id && game.users.activeGM.id === game.user?.id);
}
