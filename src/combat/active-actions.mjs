import { GRAPPLE_FOLLOW_MOVEMENT_OPTION, GRAPPLE_FOLLOW_ORCHESTRATION_OPTION, SYSTEM_ID } from "../constants.mjs";
import { requestSkillCheck } from "../rolls/skill-check.mjs";
import { getCombatSettings, getSkillSettings } from "../settings/accessors.mjs";
import { MOVEMENT_RESOURCE_KEY, getCombatMovementResourceState } from "./movement-resources.mjs";
import { canSpendCombatActionPoints, spendCombatActionPoints } from "./reaction-resources.mjs";
import { POSTURE_CHANGE_ACTION_POINT_COST, setActorTokensPosture as setActorTokensPostureDirect } from "../canvas/posture-movement.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { ALL_COMBAT_DISADVANTAGE_EFFECT_KEY } from "../utils/active-effect-changes.mjs";
import {
  DEFAULT_GRAPPLED_ATTACK_DISADVANTAGE_AMOUNT,
  getGrappleCheckDifficultyBonus,
  getGrappleTargetAttackDisadvantageAmount,
  GRAPPLE_MODIFIER_KINDS
} from "./grapple-modifiers.mjs";
import { isActorUnableToAct } from "./reaction-hub.mjs";
import { notifyCombatResourcesSpent } from "./resource-spending.mjs";

const { DialogV2 } = foundry.applications.api;

export const GRAPPLE_TARGET_FLAG = "grappleTargetTokenId";
export const GRAPPLE_GRAPPLER_FLAG = "grappleGrapplerTokenId";
export const GRAPPLE_ACTION_POINT_COST = 4;

const GRAPPLED_ATTACK_DISADVANTAGE_AMOUNT = DEFAULT_GRAPPLED_ATTACK_DISADVANTAGE_AMOUNT;

const ACTIVE_ACTION_SOCKET = `system.${SYSTEM_ID}`;
const ACTIVE_ACTION_SOCKET_SCOPE = "fallout-maw.activeActions";
const ACTIVE_ACTION_SOCKET_TIMEOUT = 10000;
const GRAPPLE_SYNC_OPTION = "falloutMawGrappleSync";
const GRAPPLE_DRAG_PREVIEW_NAME = "fallout-maw-grapple-drag-preview";
const GRAPPLE_TARGET_PREVIEW_NAME = "fallout-maw-grapple-target-preview";
const GRAPPLE_EFFECT_FLAG = "grappleEffect";
const GRAPPLE_EFFECT_ICON = "systems/fallout-maw/icons/statuses/grappled.svg";
const ACTIVE_EFFECT_SHOW_ICON_ALWAYS = 2;
const SKILL_ALIASES = Object.freeze({
  ath: "athletics",
  prc: "resilience"
});
const pendingActiveActionSocketRequests = new Map();
const activeGrappleEscapePromptTokenIds = new Set();

export { GRAPPLE_FOLLOW_ORCHESTRATION_OPTION };

export function registerActiveActionHooks() {
  Hooks.on("preUpdateToken", onPreUpdateTokenGrapple);
  Hooks.on("deleteToken", onDeleteTokenGrapple);
}

export function registerActiveActionSocket() {
  game.socket.on(ACTIVE_ACTION_SOCKET, handleActiveActionSocketMessage);
}

export function getGrappleTargetId(tokenOrDocument) {
  return String(getTokenDocument(tokenOrDocument)?.getFlag?.(SYSTEM_ID, GRAPPLE_TARGET_FLAG) ?? "");
}

export function getGrapplerId(tokenOrDocument) {
  return String(getTokenDocument(tokenOrDocument)?.getFlag?.(SYSTEM_ID, GRAPPLE_GRAPPLER_FLAG) ?? "");
}

export function isActorGrappled(actor) {
  if (!actor) return false;
  if (actor.statuses?.has?.("grappled")) return true;
  return (actor.effects ?? []).some(effect => (
    !effect.disabled && effect.getFlag?.(SYSTEM_ID, GRAPPLE_EFFECT_FLAG)
  ));
}

export function appendGrappleFollowMovement(updates, movement, grapplerTokenOrDocument, grapplerPath = [], options = {}) {
  const grapplerDocument = getTokenDocument(grapplerTokenOrDocument);
  const targetDocument = getSceneToken(grapplerDocument, getGrappleTargetId(grapplerDocument));
  if (!grapplerDocument || !targetDocument) return true;
  if (!Array.isArray(updates) || !movement || typeof movement !== "object") return true;

  if (movement[targetDocument.id] || updates.some(update => update?._id === targetDocument.id)) {
    ui.notifications.warn(localizeHud("GrappledTargetCannotMove"));
    return false;
  }

  const orchestration = prepareGrappleFollowOrchestration(grapplerDocument, targetDocument, grapplerPath, movement, options);
  if (orchestration === false) return false;
  if (!orchestration) return true;

  if (!game.user?.isGM) {
    options[GRAPPLE_FOLLOW_ORCHESTRATION_OPTION] ??= [];
    options[GRAPPLE_FOLLOW_ORCHESTRATION_OPTION].push(orchestration);
    return true;
  }

  const sourceMovement = movement[grapplerDocument.id] ?? {};
  updates.push({ _id: targetDocument.id });
  movement[targetDocument.id] = {
    waypoints: orchestration.targetWaypoints,
    method: orchestration.method,
    autoRotate: false,
    showRuler: false,
    constrainOptions: { ignoreCost: true }
  };
  options[GRAPPLE_FOLLOW_MOVEMENT_OPTION] ??= {};
  options[GRAPPLE_FOLLOW_MOVEMENT_OPTION][targetDocument.id] = grapplerDocument.id;
  return true;
}

export async function requestGrappleFollowMove(orchestration = {}) {
  if (game.user?.isGM) return executeGrappleFollowMoveDocument(orchestration);
  return requestActiveActionGMOperation("grappleFollowMove", orchestration);
}

export async function commitGrappleFollowOrchestrations(orchestrations = []) {
  for (const orchestration of orchestrations) {
    const ok = await requestGrappleFollowMove(orchestration);
    if (!ok) return false;
  }
  return true;
}

export async function useGrappleAction(token) {
  const tokenDocument = getTokenDocument(token);
  const actor = tokenDocument?.actor;
  if (!tokenDocument || !actor?.isOwner || isActorUnableToAct(actor)) return undefined;

  const grappleTargetId = getGrappleTargetId(tokenDocument);
  if (grappleTargetId) return requestUnlinkGrapple(tokenDocument, getSceneToken(tokenDocument, grappleTargetId));

  const grapplerId = getGrapplerId(tokenDocument);
  if (grapplerId) return escapeGrapple(tokenDocument, getSceneToken(tokenDocument, grapplerId));

  return startGrappleTargetSelection(tokenDocument);
}

export async function startGrappleReposition(token) {
  const grapplerDocument = getTokenDocument(token);
  const actor = grapplerDocument?.actor;
  const targetDocument = getSceneToken(grapplerDocument, getGrappleTargetId(grapplerDocument));
  if (!actor?.isOwner || isActorUnableToAct(actor) || !targetDocument) {
    ui.notifications.warn(localizeHud("NoGrappledTarget"));
    return undefined;
  }

  const candidates = getAdjacentTokenPositions(grapplerDocument, targetDocument)
    .filter(position => validateTokenDestination(targetDocument, position, { ignoreIds: [grapplerDocument.id, targetDocument.id] }));
  if (!candidates.length) {
    ui.notifications.warn(localizeHud("NoDragCell"));
    return undefined;
  }

  const destination = await chooseTokenDestination(candidates, targetDocument);
  if (!destination) return undefined;

  const cost = getGrappleDragCost(grapplerDocument, targetDocument, destination);
  if (!canSpendMovementThenAction(actor, cost)) return undefined;
  await spendMovementThenAction(actor, cost);
  if (isActorUnableToAct(actor)) return undefined;
  return requestMoveGrappledTarget(targetDocument, destination);
}

export async function requestPushKnockback({ attackerToken = null, targetToken = null, reason = "" } = {}) {
  return requestKnockback({ attackerToken, targetToken, distanceCells: 1, reason });
}

export async function requestKnockback({ attackerToken = null, targetToken = null, distanceCells = 1, reason = "" } = {}) {
  const attackerDocument = getTokenDocument(attackerToken);
  const targetDocument = getTokenDocument(targetToken);
  if (!attackerDocument || !targetDocument || attackerDocument.id === targetDocument.id) return false;
  return requestActiveActionGMOperation("knockback", {
    sceneId: attackerDocument.parent?.id ?? targetDocument.parent?.id ?? canvas.scene?.id ?? "",
    attackerTokenId: attackerDocument.id,
    targetTokenId: targetDocument.id,
    distanceCells: Math.max(1, toInteger(distanceCells)),
    reason
  });
}

export function getKnockbackMaximumStrength(difficulty = 0, options = {}) {
  const settings = getCombatSettings().knockback;
  const initialDifficulty = Math.max(0, toInteger(difficulty));
  const threshold = Math.max(1, toInteger(options.repeatThreshold ?? settings.repeatDifficultyThreshold));
  const step = Math.max(1, toInteger(options.difficultyStep ?? settings.repeatDifficultyStep));
  let strength = 1;
  let nextDifficulty = initialDifficulty - step;
  while (nextDifficulty >= threshold) {
    strength += 1;
    nextDifficulty -= step;
  }
  return strength;
}

export async function resolveKnockback({
  attackerToken = null,
  targetToken = null,
  difficulty = 0,
  maximumStrength = null,
  repeatThreshold = null,
  difficultyStep = null,
  reason = "",
  requester = "knockbackResistance"
} = {}) {
  const attackerDocument = getTokenDocument(attackerToken);
  const targetDocument = getTokenDocument(targetToken);
  if (!attackerDocument || !targetDocument?.actor || attackerDocument.id === targetDocument.id) return null;
  const initialDifficulty = Math.max(0, toInteger(difficulty));
  const settings = getCombatSettings().knockback;
  const threshold = repeatThreshold ?? settings.repeatDifficultyThreshold;
  const step = Math.max(1, toInteger(difficultyStep ?? settings.repeatDifficultyStep));
  const availableStrength = getKnockbackMaximumStrength(initialDifficulty, { repeatThreshold: threshold, difficultyStep: step });
  const checkCount = Math.max(1, Math.min(
    availableStrength,
    maximumStrength === null ? availableStrength : toInteger(maximumStrength)
  ));
  const unableToResist = isUnableToResist(targetDocument);
  let failedChecks = unableToResist ? checkCount : 0;
  const outcomes = [];
  for (let index = 0; !unableToResist && index < checkCount; index += 1) {
    const outcome = await requestSkillCheck({
      actor: targetDocument.actor,
      skillKey: resolveSkillKey(targetDocument.actor, "prc"),
      data: {
        difficulty: Math.max(0, initialDifficulty - (step * index)),
        actorToken: targetDocument.object ?? targetDocument,
        targetToken: attackerDocument.object ?? attackerDocument
      },
      animate: false,
      createMessage: true,
      prompt: false,
      requester
    });
    outcomes.push(outcome);
    if (!["success", "criticalSuccess"].includes(String(outcome?.result?.key ?? ""))) failedChecks += 1;
  }
  const moved = failedChecks > 0
    ? await requestKnockback({ attackerToken: attackerDocument, targetToken: targetDocument, distanceCells: failedChecks, reason })
    : false;
  return { difficulty: initialDifficulty, checkCount, failedChecks, moved, outcomes, unableToResist };
}

async function startGrappleTargetSelection(grapplerDocument) {
  const candidates = (canvas.tokens?.placeables ?? [])
    .map(token => token.document)
    .filter(document => document?.id !== grapplerDocument.id && document.actor && areTokensAdjacent(grapplerDocument, document));
  if (!candidates.length) {
    ui.notifications.warn(localizeHud("NoAdjacentGrappleTarget"));
    return undefined;
  }
  const targetDocument = await chooseGrappleTarget(candidates, { restoreControlledToken: grapplerDocument });
  if (!targetDocument) return undefined;
  return requestAttemptGrapple(grapplerDocument, targetDocument);
}

async function attemptGrapple(grapplerDocument, targetDocument, options = {}) {
  if (!targetDocument) return undefined;
  if (!areTokensAdjacent(grapplerDocument, targetDocument)) {
    ui.notifications.warn(localizeHud("GrappleTargetAdjacent"));
    return undefined;
  }
  if (getGrapplerId(targetDocument)) {
    ui.notifications.warn(localizeHud("GrappleTargetAlreadyGrappled"));
    return undefined;
  }
  if (!canSpendActionPoints(grapplerDocument.actor, GRAPPLE_ACTION_POINT_COST)) return undefined;

  const uncontested = isUnableToResist(targetDocument) || await requestOwnerGrappleConsent(grapplerDocument, targetDocument, {
    allowGmLocalPrompt: options.allowGmLocalPrompt !== false
  });
  await spendActionPoints(grapplerDocument.actor, GRAPPLE_ACTION_POINT_COST);
  if (isActorUnableToAct(grapplerDocument.actor)) return false;
  if (uncontested) return linkGrappleAndAnnounce(grapplerDocument, targetDocument);

  const attackerAthletics = getActorSkillValue(grapplerDocument.actor, "ath");
  const size = getGrappleSizeModifiers(grapplerDocument, targetDocument);
  const grappleDifficultyBonus = getGrappleCheckDifficultyBonus({
    grapplerActor: grapplerDocument.actor,
    targetActor: targetDocument.actor,
    grapplerDocument,
    targetDocument,
    kind: GRAPPLE_MODIFIER_KINDS.resistance
  });
  const outcome = await requestSkillCheck({
    actor: targetDocument.actor,
    skillKey: resolveSkillKey(targetDocument.actor, "prc"),
    data: {
      difficulty: 50 + attackerAthletics + size.difficultyModifier + grappleDifficultyBonus,
      situationalModifier: size.resistanceModifier
    },
    animate: false,
    createMessage: true,
    prompt: false,
    requester: "grappleResistance"
  });
  if (isSuccessfulCheck(outcome)) {
    await createActionMessage(formatHud("GrappleResisted", { target: targetDocument.name, grappler: grapplerDocument.name }), targetDocument.actor);
    return false;
  }
  return linkGrappleAndAnnounce(grapplerDocument, targetDocument);
}

async function requestAttemptGrapple(grapplerDocument, targetDocument) {
  if (!grapplerDocument || !targetDocument) return false;
  if (game.user?.isGM) return attemptGrapple(grapplerDocument, targetDocument);
  return requestActiveActionGMOperation("attemptGrapple", {
    sceneId: grapplerDocument.parent?.id ?? targetDocument.parent?.id ?? canvas.scene?.id ?? "",
    grapplerTokenId: grapplerDocument.id,
    targetTokenId: targetDocument.id
  });
}

async function escapeGrapple(targetDocument, grapplerDocument) {
  if (!targetDocument?.actor || !grapplerDocument?.actor) return requestUnlinkGrapple(grapplerDocument, targetDocument);
  if (!canSpendActionPoints(targetDocument.actor, POSTURE_CHANGE_ACTION_POINT_COST)) return undefined;
  await spendActionPoints(targetDocument.actor, POSTURE_CHANGE_ACTION_POINT_COST);
  if (isActorUnableToAct(targetDocument.actor)) return false;

  const size = getGrappleEscapeSizeModifiers(grapplerDocument, targetDocument);
  const grappleDifficultyBonus = getGrappleCheckDifficultyBonus({
    grapplerActor: grapplerDocument.actor,
    targetActor: targetDocument.actor,
    grapplerDocument,
    targetDocument,
    kind: GRAPPLE_MODIFIER_KINDS.escape
  });
  const outcome = await requestSkillCheck({
    actor: targetDocument.actor,
    skillKey: resolveSkillKey(targetDocument.actor, "ath"),
    data: {
      difficulty: 50 + getActorSkillValue(grapplerDocument.actor, "ath") + size.difficultyModifier + grappleDifficultyBonus,
      situationalModifier: size.escapeModifier
    },
    animate: false,
    createMessage: true,
    prompt: false,
    requester: "grappleEscape"
  });
  if (!isSuccessfulCheck(outcome)) {
    await createActionMessage(formatHud("GrappleEscapeFailed", { target: targetDocument.name, grappler: grapplerDocument.name }), targetDocument.actor);
    return false;
  }

  await requestSetActorTokensPosture(targetDocument.actor, "walk");
  await createActionMessage(formatHud("GrappleEscaped", { target: targetDocument.name, grappler: grapplerDocument.name }), targetDocument.actor);
  return requestUnlinkGrapple(grapplerDocument, targetDocument);
}

async function requestSetActorTokensPosture(actor, action = "walk") {
  if (!actor?.uuid) return false;
  if (game.user?.isGM) {
    await setActorTokensPostureDirect(actor, action);
    return true;
  }
  return requestActiveActionGMOperation("setActorTokensPosture", {
    actorUuid: actor.uuid,
    action
  });
}

async function linkGrappleAndAnnounce(grapplerDocument, targetDocument) {
  const linked = await requestLinkGrapple(grapplerDocument, targetDocument);
  if (linked) await createActionMessage(formatHud("GrappleStarted", { grappler: grapplerDocument.name, target: targetDocument.name }), grapplerDocument.actor);
  return linked;
}

async function requestLinkGrapple(grapplerDocument, targetDocument) {
  if (!grapplerDocument || !targetDocument) return false;
  return requestActiveActionGMOperation("linkGrapple", {
    sceneId: grapplerDocument.parent?.id ?? targetDocument.parent?.id ?? canvas.scene?.id ?? "",
    grapplerTokenId: grapplerDocument.id,
    targetTokenId: targetDocument.id
  });
}

async function requestUnlinkGrapple(grapplerDocument, targetDocument = null) {
  const tokenDocument = grapplerDocument ?? targetDocument;
  if (!tokenDocument) return false;
  return requestActiveActionGMOperation("unlinkGrapple", {
    sceneId: tokenDocument.parent?.id ?? tokenDocument.scene?.id ?? canvas.scene?.id ?? "",
    grapplerTokenId: grapplerDocument?.id ?? "",
    targetTokenId: targetDocument?.id ?? ""
  });
}

async function requestMoveGrappledTarget(targetDocument, destination) {
  return requestActiveActionGMOperation("moveGrappledTarget", {
    sceneId: targetDocument?.parent?.id ?? targetDocument?.scene?.id ?? canvas.scene?.id ?? "",
    targetTokenId: targetDocument?.id ?? "",
    x: destination?.x,
    y: destination?.y
  });
}

async function requestActiveActionGMOperation(action, payload = {}) {
  if (game.user?.isGM) return executeActiveActionGMOperation(action, payload);

  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn(localizeHud("NoActiveGMTokenUpdate"));
    return false;
  }

  const requestId = foundry.utils.randomID();
  return new Promise(resolve => {
    const timeout = window.setTimeout(() => {
      pendingActiveActionSocketRequests.delete(requestId);
      ui.notifications.warn(localizeHud("GMNoResponseActiveAction"));
      resolve(false);
    }, ACTIVE_ACTION_SOCKET_TIMEOUT);
    pendingActiveActionSocketRequests.set(requestId, { resolve, timeout });
    game.socket.emit(ACTIVE_ACTION_SOCKET, {
      scope: ACTIVE_ACTION_SOCKET_SCOPE,
      action,
      payload,
      requestId,
      targetUserId: gm.id,
      senderUserId: game.user?.id ?? ""
    });
  });
}

async function handleActiveActionSocketMessage(message = {}) {
  if (message.scope !== ACTIVE_ACTION_SOCKET_SCOPE) return;
  if (message.senderUserId && message.senderUserId === game.user?.id) return;

  if (message.action === "response") {
    const pending = pendingActiveActionSocketRequests.get(message.requestId);
    if (!pending) return;
    window.clearTimeout(pending.timeout);
    pendingActiveActionSocketRequests.delete(message.requestId);
    pending.resolve(Boolean(message.ok));
    return;
  }

  if (message.action === "confirmGrappleConsent") {
    if (message.targetUserId && message.targetUserId !== game.user?.id) return;
    const ok = await DialogV2.confirm({
      window: { title: localizeHud("GrappleConsentTitle") },
      content: `<p>${escapeHtml(formatHud("GrappleConsentPromptRemote", {
        target: message.payload?.targetName ?? "",
        grappler: message.payload?.grapplerName ?? ""
      }))}</p>`,
      rejectClose: false,
      modal: true
    });
    game.socket.emit(ACTIVE_ACTION_SOCKET, {
      scope: ACTIVE_ACTION_SOCKET_SCOPE,
      action: "response",
      requestId: message.requestId,
      ok,
      senderUserId: game.user?.id ?? "",
      targetUserId: message.senderUserId ?? ""
    });
    return;
  }

  if (!game.user?.isGM) return;
  if (message.targetUserId && message.targetUserId !== game.user.id) return;
  let ok = false;
  try {
    ok = await executeActiveActionGMOperation(message.action, message.payload ?? {});
  } catch (error) {
    console.error(`${SYSTEM_ID} | Active action socket operation failed`, error);
  }
  if (message.requestId) {
    game.socket.emit(ACTIVE_ACTION_SOCKET, {
      scope: ACTIVE_ACTION_SOCKET_SCOPE,
      action: "response",
      requestId: message.requestId,
      ok,
      senderUserId: game.user.id,
      targetUserId: message.senderUserId ?? ""
    });
  }
}

async function executeActiveActionGMOperation(action, payload = {}) {
  if (action === "attemptGrapple") return attemptGrappleDocuments(payload);
  if (action === "linkGrapple") return linkGrappleDocuments(payload);
  if (action === "unlinkGrapple") return unlinkGrappleDocuments(payload);
  if (action === "moveGrappledTarget") return moveGrappledTargetDocument(payload);
  if (action === "grappleFollowMove") return executeGrappleFollowMoveDocument(payload);
  if (action === "setActorTokensPosture") return setActorTokensPostureDocument(payload);
  if (action === "pushKnockback" || action === "knockback") return knockbackDocument(payload);
  return false;
}

async function setActorTokensPostureDocument({ actorUuid = "", action = "walk" } = {}) {
  const actor = await fromUuid(String(actorUuid ?? ""));
  if (!actor) return false;
  await setActorTokensPostureDirect(actor, action);
  return true;
}

async function attemptGrappleDocuments({ sceneId = "", grapplerTokenId = "", targetTokenId = "" } = {}) {
  const scene = getScene(sceneId);
  const grappler = scene?.tokens?.get(grapplerTokenId);
  const target = scene?.tokens?.get(targetTokenId);
  if (!scene || !grappler || !target || grappler.id === target.id) return false;
  return attemptGrapple(grappler, target, { allowGmLocalPrompt: false });
}

async function linkGrappleDocuments({ sceneId = "", grapplerTokenId = "", targetTokenId = "" } = {}) {
  const scene = getScene(sceneId);
  const grappler = scene?.tokens?.get(grapplerTokenId);
  const target = scene?.tokens?.get(targetTokenId);
  if (!scene || !grappler || !target || grappler.id === target.id) return false;

  const updates = [];
  const clearedEffectActors = new Set();
  queueBreakGrappleRelationsForToken(scene, grappler.id, updates, clearedEffectActors);
  queueBreakGrappleRelationsForToken(scene, target.id, updates, clearedEffectActors);
  updates.push({ _id: grappler.id, [`flags.${SYSTEM_ID}.${GRAPPLE_TARGET_FLAG}`]: target.id });
  updates.push({ _id: target.id, [`flags.${SYSTEM_ID}.${GRAPPLE_GRAPPLER_FLAG}`]: grappler.id });
  await scene.updateEmbeddedDocuments("Token", mergeTokenUpdates(updates), { [GRAPPLE_SYNC_OPTION]: true });
  for (const actor of clearedEffectActors) await syncGrappleEffect(actor, false);
  await syncGrappleEffect(target.actor, true, grappler);
  return true;
}

async function unlinkGrappleDocuments({ sceneId = "", grapplerTokenId = "", targetTokenId = "" } = {}) {
  const scene = getScene(sceneId);
  if (!scene) return false;
  const updates = [];
  const clearedEffectActors = new Set();
  if (grapplerTokenId && targetTokenId && grapplerTokenId !== targetTokenId) {
    queueUnlinkGrapplePair(scene, grapplerTokenId, targetTokenId, updates, clearedEffectActors);
  } else {
    const tokenId = grapplerTokenId || targetTokenId;
    queueBreakGrappleRelationsForToken(scene, tokenId, updates, clearedEffectActors);
  }
  return commitGrappleUnlinks(scene, updates, clearedEffectActors);
}

async function breakGrappleRelationsForToken(scene, tokenId = "") {
  const updates = [];
  const clearedEffectActors = new Set();
  queueBreakGrappleRelationsForToken(scene, tokenId, updates, clearedEffectActors);
  return commitGrappleUnlinks(scene, updates, clearedEffectActors);
}

function queueBreakGrappleRelationsForToken(scene, tokenId = "", updates = [], clearedEffectActors = new Set()) {
  if (!scene || !tokenId) return;
  const document = scene.tokens?.get(tokenId);

  const targetId = getGrappleTargetId(document);
  if (targetId) queueUnlinkGrapplePair(scene, tokenId, targetId, updates, clearedEffectActors);

  const grapplerId = getGrapplerId(document);
  if (grapplerId) queueUnlinkGrapplePair(scene, grapplerId, tokenId, updates, clearedEffectActors);

  for (const other of scene.tokens?.contents ?? []) {
    if (!other || other.id === tokenId) continue;
    if (getGrappleTargetId(other) === tokenId) queueUnlinkGrapplePair(scene, other.id, tokenId, updates, clearedEffectActors);
    if (getGrapplerId(other) === tokenId) queueUnlinkGrapplePair(scene, tokenId, other.id, updates, clearedEffectActors);
  }
}

function queueUnlinkGrapplePair(scene, grapplerTokenId = "", targetTokenId = "", updates = [], clearedEffectActors = new Set()) {
  if (!scene || !grapplerTokenId || !targetTokenId || grapplerTokenId === targetTokenId) return;
  const grappler = scene.tokens?.get(grapplerTokenId);
  const target = scene.tokens?.get(targetTokenId);
  let linked = false;

  if (grappler && getGrappleTargetId(grappler) === targetTokenId) {
    updates.push({ _id: grappler.id, [`flags.${SYSTEM_ID}.-=${GRAPPLE_TARGET_FLAG}`]: null });
    linked = true;
  }
  if (target && getGrapplerId(target) === grapplerTokenId) {
    updates.push({ _id: target.id, [`flags.${SYSTEM_ID}.-=${GRAPPLE_GRAPPLER_FLAG}`]: null });
    if (target.actor) clearedEffectActors.add(target.actor);
    linked = true;
  }
  if (linked && target?.actor) clearedEffectActors.add(target.actor);
}

async function commitGrappleUnlinks(scene, updates = [], clearedEffectActors = new Set()) {
  const merged = mergeTokenUpdates(updates).filter(update => scene?.tokens?.get(update._id));
  if (!merged.length && !clearedEffectActors.size) return false;
  if (merged.length) await scene.updateEmbeddedDocuments("Token", merged, { [GRAPPLE_SYNC_OPTION]: true });
  for (const actor of clearedEffectActors) await syncGrappleEffect(actor, false);
  return true;
}

async function moveGrappledTargetDocument({ sceneId = "", targetTokenId = "", x = null, y = null } = {}) {
  const scene = getScene(sceneId);
  const target = scene?.tokens?.get(targetTokenId);
  if (!target) return false;
  const destination = snapTokenPosition(target, { x: Number(x), y: Number(y) });
  if (!validateTokenDestination(target, destination, { ignoreIds: [target.id, getGrapplerId(target)].filter(Boolean) })) return false;
  await target.update(destination, { [GRAPPLE_SYNC_OPTION]: true });
  return true;
}

async function executeGrappleFollowMoveDocument({
  sceneId = "",
  grapplerTokenId = "",
  targetTokenId = "",
  grapplerWaypoints = [],
  targetWaypoints = [],
  method = "keyboard",
  planned = false,
  autoRotate = false,
  showRuler = false,
  grapplerConstrainOptions = null,
  terrainOptions = null,
  measureOptions = null
} = {}) {
  const scene = getScene(sceneId);
  const grappler = scene?.tokens?.get(grapplerTokenId);
  const target = scene?.tokens?.get(targetTokenId);
  if (!scene || !grappler || !target || !grapplerWaypoints.length || !targetWaypoints.length) return false;

  const moveOptions = {
    [GRAPPLE_FOLLOW_MOVEMENT_OPTION]: { [target.id]: grappler.id }
  };
  const results = await scene.moveTokens({
    [grappler.id]: {
      waypoints: grapplerWaypoints,
      method,
      planned,
      autoRotate,
      showRuler,
      constrainOptions: grapplerConstrainOptions ?? undefined,
      terrainOptions: terrainOptions ?? undefined,
      measureOptions: measureOptions ?? undefined
    },
    [target.id]: {
      waypoints: targetWaypoints,
      method,
      autoRotate: false,
      showRuler: false,
      constrainOptions: { ignoreCost: true }
    }
  }, moveOptions);

  return Boolean(results?.[grappler.id] && results?.[target.id]);
}

async function knockbackDocument({ sceneId = "", attackerTokenId = "", targetTokenId = "", distanceCells = 1, reason = "" } = {}) {
  const scene = getScene(sceneId);
  const attacker = scene?.tokens?.get(attackerTokenId);
  const target = scene?.tokens?.get(targetTokenId);
  if (!attacker || !target) return false;
  const destination = getKnockbackDestination(attacker, target, distanceCells);
  if (!destination) return false;
  await breakGrappleRelationsForToken(scene, target.id);
  await target.update(destination, { [GRAPPLE_SYNC_OPTION]: true });
  await createActionMessage(formatHud("PushKnockback", { target: target.name, attacker: attacker.name }), target.actor, reason);
  return true;
}

function onPreUpdateTokenGrapple(tokenDocument, changes, options) {
  if (options?.[GRAPPLE_SYNC_OPTION]) return true;
  const moves = foundry.utils.hasProperty(changes, "x") || foundry.utils.hasProperty(changes, "y");
  if (!moves) return true;

  const targetGrapplerId = getGrapplerId(tokenDocument);
  if (!targetGrapplerId) return true;

  const isFollow = getFollowMovementGrapplerId(options, tokenDocument.id) === targetGrapplerId;
  const passed = hasPassedMovement(options?._movement?.[targetGrapplerId]);
  if (isFollow) return passed ? true : false;

  void promptGrappleEscapeOnMoveAttempt(tokenDocument, targetGrapplerId);
  return false;
}

function onDeleteTokenGrapple(tokenDocument) {
  if (!game.user?.isGM) return;
  void unlinkGrappleDocuments({
    sceneId: tokenDocument.parent?.id ?? tokenDocument.scene?.id ?? canvas.scene?.id ?? "",
    grapplerTokenId: tokenDocument.id,
    targetTokenId: tokenDocument.id
  });
}

function getGrappleCandidate(grapplerDocument) {
  const targets = [...(game.user?.targets ?? [])]
    .map(token => token.document)
    .filter(document => document?.id !== grapplerDocument.id && document.actor);
  if (targets.length === 1) return targets[0];
  const adjacent = (canvas.tokens?.placeables ?? [])
    .map(token => token.document)
    .filter(document => document?.id !== grapplerDocument.id && document.actor && areTokensAdjacent(grapplerDocument, document));
  if (adjacent.length === 1) return adjacent[0];
  ui.notifications.warn(adjacent.length ? localizeHud("ChooseGrappleTarget") : localizeHud("NoAdjacentGrappleTarget"));
  return null;
}

async function requestOwnerGrappleConsent(grapplerDocument, targetDocument, { allowGmLocalPrompt = true } = {}) {
  const owner = getResponsibleOwner(targetDocument?.actor);
  if (!game.user?.isGM && targetDocument?.actor?.testUserPermission?.(game.user, "OWNER")) return promptGrappleConsent(targetDocument);
  if (allowGmLocalPrompt && game.user?.isGM && !owner && targetDocument?.actor?.testUserPermission?.(game.user, "OWNER")) return promptGrappleConsent(targetDocument);
  if (!owner) return false;

  const requestId = foundry.utils.randomID();
  return new Promise(resolve => {
    const timeout = window.setTimeout(() => {
      pendingActiveActionSocketRequests.delete(requestId);
      resolve(false);
    }, ACTIVE_ACTION_SOCKET_TIMEOUT);
    pendingActiveActionSocketRequests.set(requestId, { resolve, timeout });
    game.socket.emit(ACTIVE_ACTION_SOCKET, {
      scope: ACTIVE_ACTION_SOCKET_SCOPE,
      action: "confirmGrappleConsent",
      requestId,
      targetUserId: owner.id,
      senderUserId: game.user?.id ?? "",
      payload: {
        grapplerName: grapplerDocument?.name ?? "",
        targetName: targetDocument?.name ?? ""
      }
    });
  });
}

async function promptGrappleConsent(targetDocument) {
  return DialogV2.confirm({
    window: { title: localizeHud("GrappleConsentTitle") },
    content: `<p>${escapeHtml(formatHud("GrappleConsentPrompt", { target: targetDocument.name }))}</p>`,
    rejectClose: false,
    modal: true
  });
}

async function promptGrappleEscapeOnMoveAttempt(targetDocument, grapplerId = "") {
  const tokenDocument = getTokenDocument(targetDocument);
  const grapplerDocument = getSceneToken(tokenDocument, grapplerId);
  if (!tokenDocument?.actor || !grapplerDocument?.actor) return;
  if (activeGrappleEscapePromptTokenIds.has(tokenDocument.id)) return;
  if (!canSpendActionPoints(tokenDocument.actor, POSTURE_CHANGE_ACTION_POINT_COST)) return;

  activeGrappleEscapePromptTokenIds.add(tokenDocument.id);
  try {
    const confirmed = await DialogV2.confirm({
      window: { title: localizeHud("GrappleEscapeMoveTitle") },
      content: `<p>${escapeHtml(formatHud("GrappleEscapeMovePrompt", {
        target: tokenDocument.name,
        grappler: grapplerDocument.name,
        cost: POSTURE_CHANGE_ACTION_POINT_COST
      }))}</p>`,
      yes: {
        icon: "fa-solid fa-person-running",
        label: localizeHud("EscapeGrapple")
      },
      no: {
        label: game.i18n.localize("Cancel")
      },
      rejectClose: false,
      modal: true
    });
    if (confirmed) await escapeGrapple(tokenDocument, grapplerDocument);
  } finally {
    activeGrappleEscapePromptTokenIds.delete(tokenDocument.id);
  }
}

function isUnableToResist(tokenDocument) {
  const defeatedStatus = CONFIG.specialStatusEffects.DEFEATED;
  return Boolean(
    tokenDocument?.actor?.statuses?.has("dead")
    || tokenDocument?.actor?.statuses?.has("unconscious")
    || tokenDocument?.hasStatusEffect?.("dead")
    || tokenDocument?.hasStatusEffect?.("unconscious")
    || (defeatedStatus && (tokenDocument?.actor?.statuses?.has(defeatedStatus) || tokenDocument?.hasStatusEffect?.(defeatedStatus)))
  );
}

function canSpendActionPoints(actor, amount = 0) {
  return canSpendCombatActionPoints(actor, amount);
}

async function spendActionPoints(actor, amount = 0) {
  await spendCombatActionPoints(actor, amount);
}

function canSpendMovementThenAction(actor, amount = 0) {
  if (!game.combat) return true;
  const cost = Math.max(0, toInteger(amount));
  const state = getCombatMovementResourceState(actor);
  if (!state || cost <= state.total) return true;
  ui.notifications.warn(formatHud("InsufficientMovementAction", {
    actor: actor?.name ?? "",
    movement: state.movement.label,
    action: state.action.label,
    cost,
    available: state.total
  }));
  return false;
}

async function spendMovementThenAction(actor, amount = 0) {
  if (!game.combat) return;
  const cost = Math.max(0, toInteger(amount));
  const state = getCombatMovementResourceState(actor);
  if (!state || cost <= 0) return;
  const movementSpend = Math.min(cost, state.movement.value);
  const actionSpend = Math.min(cost - movementSpend, state.action.value);
  const update = {};
  if (movementSpend) update[`system.resources.${MOVEMENT_RESOURCE_KEY}.value`] = Math.max(0, state.movement.current - movementSpend);
  if (Object.keys(update).length) await actor.update(update);
  if (actionSpend) await spendCombatActionPoints(actor, actionSpend, { suppressResourceNotification: true });
  await notifyCombatResourcesSpent(actor, {
    [MOVEMENT_RESOURCE_KEY]: movementSpend,
    [state.action.key]: actionSpend
  }, { type: "activeAction" });
}

function getGrappleDragCost(grapplerDocument, targetDocument, destination) {
  const step = getTokenGridStep(targetDocument);
  const dx = Math.abs(Number(destination.x) - Number(targetDocument.x));
  const dy = Math.abs(Number(destination.y) - Number(targetDocument.y));
  const distanceCells = Math.max(1, Math.ceil(Math.hypot(dx / step.x, dy / step.y)));
  return Math.ceil(distanceCells * getGrappleDragSizeMultiplier(grapplerDocument, targetDocument));
}

function getGrappleDragSizeMultiplier(grapplerDocument, targetDocument) {
  const diff = getTokenSizeRank(targetDocument) - getTokenSizeRank(grapplerDocument);
  if (diff <= -1) return 1;
  if (diff === 1) return 2;
  if (diff >= 2) return 4;
  return 1;
}

function getGrappleSizeModifiers(grapplerDocument, targetDocument) {
  const diff = getTokenSizeRank(targetDocument) - getTokenSizeRank(grapplerDocument);
  if (diff <= -1) return { difficultyModifier: 50, resistanceModifier: 0 };
  if (diff === 1) return { difficultyModifier: 0, resistanceModifier: 100 };
  if (diff >= 2) return { difficultyModifier: 0, resistanceModifier: 200 };
  return { difficultyModifier: 0, resistanceModifier: 0 };
}

function getGrappleEscapeSizeModifiers(grapplerDocument, targetDocument) {
  const diff = getTokenSizeRank(targetDocument) - getTokenSizeRank(grapplerDocument);
  if (diff <= -1) return { difficultyModifier: 50, escapeModifier: 0 };
  if (diff === 1) return { difficultyModifier: 0, escapeModifier: 50 };
  if (diff >= 2) return { difficultyModifier: 0, escapeModifier: 100 };
  return { difficultyModifier: 0, escapeModifier: 0 };
}

function getActorSkillValue(actor, skillKey = "") {
  return toInteger(actor?.system?.skills?.[resolveSkillKey(actor, skillKey)]?.value);
}

function resolveSkillKey(actor, skillKey = "") {
  const requested = String(skillKey ?? "");
  if (actor?.system?.skills?.[requested]) return requested;
  const alias = SKILL_ALIASES[requested] ?? requested;
  if (actor?.system?.skills?.[alias]) return alias;
  const setting = getSkillSettings().find(skill => skill.key === requested || skill.abbr === requested || skill.key === alias || skill.abbr === alias);
  return setting?.key ?? alias;
}

function isSuccessfulCheck(outcome) {
  return ["success", "criticalSuccess"].includes(String(outcome?.result?.key ?? ""));
}

function getAdjacentTokenPositions(grapplerDocument, targetDocument) {
  const step = getTokenGridStep(targetDocument);
  const targetSize = getTokenPixelSize(targetDocument);
  const grapplerRect = getTokenRect(grapplerDocument);
  const minX = grapplerRect.x - targetSize.width;
  const maxX = grapplerRect.x + grapplerRect.width;
  const minY = grapplerRect.y - targetSize.height;
  const maxY = grapplerRect.y + grapplerRect.height;
  const positions = [];

  for (const x of getSteppedRange(minX, maxX, step.x)) {
    positions.push({ x, y: minY }, { x, y: maxY });
  }
  for (const y of getSteppedRange(minY, maxY, step.y)) {
    positions.push({ x: minX, y }, { x: maxX, y });
  }

  const seen = new Set();
  const candidates = [];
  for (const position of positions) {
    const snapped = snapTokenPosition(targetDocument, position);
    const key = getPositionKey(snapped);
    if (seen.has(key) || isSameTokenPosition(snapped, targetDocument, Math.min(step.x, step.y) * 0.25)) continue;
    seen.add(key);

    const rect = getTokenRect(targetDocument, snapped);
    if (rectsOverlap(rect, grapplerRect)) continue;
    if (!areRectsAdjacent(grapplerRect, rect)) continue;
    candidates.push(snapped);
  }

  const grapplerCenter = getTokenCenter(grapplerDocument);
  return candidates.sort((left, right) => {
    const leftCenter = getTokenPositionCenter(left, targetDocument);
    const rightCenter = getTokenPositionCenter(right, targetDocument);
    const leftAngle = Math.atan2(leftCenter.y - grapplerCenter.y, leftCenter.x - grapplerCenter.x);
    const rightAngle = Math.atan2(rightCenter.y - grapplerCenter.y, rightCenter.x - grapplerCenter.x);
    if (leftAngle !== rightAngle) return leftAngle - rightAngle;
    return Math.hypot(leftCenter.x - grapplerCenter.x, leftCenter.y - grapplerCenter.y)
      - Math.hypot(rightCenter.x - grapplerCenter.x, rightCenter.y - grapplerCenter.y);
  });
}

function chooseTokenDestination(candidates = [], tokenDocument = null) {
  const layer = getDragPreviewLayer();
  const graphics = new PIXI.Graphics();
  graphics.name = GRAPPLE_DRAG_PREVIEW_NAME;
  if (tokenDocument) drawDestinationGridPreview(graphics, candidates, tokenDocument);
  else drawDestinationPointPreview(graphics, candidates);
  layer.addChild(graphics);
  return chooseCanvasPoint({
    preview: graphics,
    resolvePoint: point => {
      if (tokenDocument) {
        const byRect = getNearestTokenDestination(candidates.filter(candidate => isPointInRect(point, getTokenRect(tokenDocument, candidate))), point, tokenDocument);
        if (byRect) return byRect;
      }
      const destination = getNearestTokenDestination(candidates, point, tokenDocument, { includeDistance: true });
      const step = getTokenGridStep(tokenDocument);
      if (!destination || destination.distance > Math.max(24, Math.min(step.x, step.y) * 0.5)) return undefined;
      return destination.candidate;
    }
  });
}

function getNearestTokenDestination(candidates = [], point, tokenDocument = null, { includeDistance = false } = {}) {
  const destination = candidates
    .map(candidate => {
      const center = getTokenPositionCenter(candidate, tokenDocument);
      return { candidate, distance: Math.hypot(center.x - point.x, center.y - point.y) };
    })
    .sort((left, right) => left.distance - right.distance)
    .at(0);
  if (!destination) return null;
  return includeDistance ? destination : destination.candidate;
}

function drawDestinationPointPreview(graphics, candidates = []) {
  const step = getTokenGridStep();
  for (const candidate of candidates) {
    const center = getTokenPositionCenter(candidate);
    graphics.lineStyle(3, 0x43c96b, 0.9);
    graphics.beginFill(0x43c96b, 0.18);
    graphics.drawCircle(center.x, center.y, Math.max(12, Math.min(step.x, step.y) * 0.2));
    graphics.endFill();
  }
}

function drawDestinationGridPreview(graphics, candidates = [], tokenDocument) {
  const cells = getDestinationPreviewCells(candidates, tokenDocument);
  const step = getTokenGridStep(tokenDocument);
  const pointRadius = Math.max(8, Math.min(step.x, step.y) * 0.12);

  graphics.lineStyle(0);
  graphics.beginFill(0x43c96b, 0.12);
  for (const cell of cells.values()) graphics.drawRect(cell.x, cell.y, cell.width, cell.height);
  graphics.endFill();

  graphics.lineStyle(1, 0x43c96b, 0.35);
  for (const cell of cells.values()) {
    graphics.moveTo(cell.x, cell.y);
    graphics.lineTo(cell.x + cell.width, cell.y);
    graphics.moveTo(cell.x, cell.y);
    graphics.lineTo(cell.x, cell.y + cell.height);
  }

  graphics.lineStyle(4, 0x43c96b, 0.95);
  for (const cell of cells.values()) {
    if (!cells.has(getCellKey(cell.x, cell.y - step.y))) {
      graphics.moveTo(cell.x, cell.y);
      graphics.lineTo(cell.x + cell.width, cell.y);
    }
    if (!cells.has(getCellKey(cell.x + step.x, cell.y))) {
      graphics.moveTo(cell.x + cell.width, cell.y);
      graphics.lineTo(cell.x + cell.width, cell.y + cell.height);
    }
    if (!cells.has(getCellKey(cell.x, cell.y + step.y))) {
      graphics.moveTo(cell.x + cell.width, cell.y + cell.height);
      graphics.lineTo(cell.x, cell.y + cell.height);
    }
    if (!cells.has(getCellKey(cell.x - step.x, cell.y))) {
      graphics.moveTo(cell.x, cell.y + cell.height);
      graphics.lineTo(cell.x, cell.y);
    }
  }

  graphics.lineStyle(4, 0x43c96b, 0.9);
  graphics.beginFill(0x43c96b, 0.22);
  for (const candidate of candidates) {
    const center = getTokenPositionCenter(candidate, tokenDocument);
    graphics.drawCircle(center.x, center.y, pointRadius);
  }
  graphics.endFill();
}

function getDestinationPreviewCells(candidates = [], tokenDocument) {
  const step = getTokenGridStep(tokenDocument);
  const cells = new Map();
  for (const candidate of candidates) {
    const rect = getTokenRect(tokenDocument, candidate);
    for (const x of getCoveredCellStarts(rect.x, rect.width, step.x)) {
      for (const y of getCoveredCellStarts(rect.y, rect.height, step.y)) {
        const cell = {
          x,
          y,
          width: Math.min(step.x, rect.x + rect.width - x),
          height: Math.min(step.y, rect.y + rect.height - y)
        };
        cells.set(getCellKey(cell.x, cell.y), cell);
      }
    }
  }
  return cells;
}

function chooseGrappleTarget(candidates = [], { restoreControlledToken = null } = {}) {
  const layer = getDragPreviewLayer();
  const graphics = new PIXI.Graphics();
  graphics.name = GRAPPLE_TARGET_PREVIEW_NAME;
  for (const candidate of candidates) {
    const rect = getTokenRect(candidate);
    graphics.lineStyle(3, 0xffd166, 0.95);
    graphics.beginFill(0xffd166, 0.16);
    graphics.drawRoundedRect(rect.x, rect.y, rect.width, rect.height, 6);
    graphics.endFill();
  }
  layer.addChild(graphics);
  return chooseCanvasPoint({
    preview: graphics,
    restoreControlledToken,
    resolvePoint: point => candidates.find(document => isPointInRect(point, getTokenRect(document)))
  });
}

function chooseCanvasPoint({ preview = null, restoreControlledToken = null, resolvePoint } = {}) {
  const view = canvas.app?.view;
  if (!view || typeof resolvePoint !== "function") {
    preview?.destroy?.();
    return Promise.resolve(null);
  }

  return new Promise(resolve => {
    let finished = false;
    let previewDestroyed = false;
    const shield = createCanvasClickShield();
    const stopCanvasEvent = event => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
    };
    const removeListeners = () => {
      for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "auxclick", "contextmenu"]) {
        view.removeEventListener(type, onCanvasEvent, true);
        shield?.removeEventListener(type, onCanvasEvent, true);
      }
      shield?.remove();
    };
    const destroyPreview = () => {
      if (previewDestroyed) return;
      previewDestroyed = true;
      preview?.destroy?.();
    };
    const finish = value => {
      if (finished) return;
      finished = true;
      restoreTokenControl(restoreControlledToken);
      destroyPreview();
      resolve(value);
      for (const delay of [0, 50, 200]) window.setTimeout(() => restoreTokenControl(restoreControlledToken), delay);
      window.setTimeout(removeListeners, 300);
    };
    const onCanvasEvent = event => {
      stopCanvasEvent(event);
      if (finished) return;
      if (event.type === "contextmenu" || event.type === "auxclick" || event.button === 2) {
        finish(null);
        return;
      }
      if (event.type !== "pointerdown" && event.type !== "mousedown") return;
      if (event.button !== 0) return;
      const point = getCanvasPointFromClientEvent(event);
      const value = point ? resolvePoint(point, event) : undefined;
      if (value !== undefined) finish(value ?? null);
    };

    for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "auxclick", "contextmenu"]) {
      view.addEventListener(type, onCanvasEvent, true);
      shield?.addEventListener(type, onCanvasEvent, true);
    }
  });
}

function createCanvasClickShield() {
  const parent = document.body;
  if (!parent) return null;
  const shield = document.createElement("div");
  shield.dataset.falloutMawCanvasChoiceShield = "true";
  Object.assign(shield.style, {
    position: "fixed",
    inset: "0",
    zIndex: "50",
    background: "transparent",
    cursor: "crosshair",
    pointerEvents: "auto"
  });
  parent.appendChild(shield);
  return shield;
}

function restoreTokenControl(tokenDocument) {
  const token = getTokenDocument(tokenDocument)?.object;
  if (!token?.control) return;
  token.control({ releaseOthers: true });
}

function getCanvasPointFromClientEvent(event) {
  const client = { x: Number(event?.clientX), y: Number(event?.clientY) };
  if (!Number.isFinite(client.x) || !Number.isFinite(client.y)) return null;
  if (typeof canvas.canvasCoordinatesFromClient === "function") return canvas.canvasCoordinatesFromClient(client);
  const point = new PIXI.Point(client.x, client.y);
  return canvas.stage?.worldTransform?.applyInverse?.(point, point) ?? null;
}

function getKnockbackDestination(attackerDocument, targetDocument, distanceCells = 1) {
  const gridSize = Math.max(1, Number(canvas.grid?.size) || 100);
  const attackerCenter = getTokenCenter(attackerDocument);
  const targetCenter = getTokenCenter(targetDocument);
  let dx = targetCenter.x - attackerCenter.x;
  let dy = targetCenter.y - attackerCenter.y;
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) dx = 1;
  const length = Math.max(1, Math.hypot(dx, dy));
  const step = {
    x: Math.round(dx / length) * gridSize,
    y: Math.round(dy / length) * gridSize
  };
  let destination = { x: targetDocument.x, y: targetDocument.y };
  for (let index = 0; index < Math.max(1, toInteger(distanceCells)); index += 1) {
    const candidate = snapTokenPosition(targetDocument, {
      x: destination.x + step.x,
      y: destination.y + step.y
    });
    if (!validateTokenDestination(targetDocument, candidate, { ignoreIds: [attackerDocument.id, targetDocument.id] })) break;
    destination = candidate;
  }
  return destination.x === targetDocument.x && destination.y === targetDocument.y ? null : destination;
}

function validateTokenDestination(tokenDocument, destination, { ignoreIds = [] } = {}) {
  if (!tokenDocument || !Number.isFinite(Number(destination?.x)) || !Number.isFinite(Number(destination?.y))) return false;
  const normalized = { x: Number(destination.x), y: Number(destination.y) };
  if (hasMovementCollision(tokenDocument, normalized)) return false;
  if (isDestinationOccupied(tokenDocument, normalized, { ignoreIds })) return false;
  return true;
}

function prepareGrappleFollowOrchestration(grapplerDocument, targetDocument, grapplerPath = [], movement = {}, options = {}) {
  const path = normalizeGrappleFollowPath(grapplerDocument, grapplerPath);
  if (path.length <= 1) return null;

  const targetWaypoints = buildGrappleFollowWaypoints(grapplerDocument, targetDocument, path);
  if (!targetWaypoints.length) return null;

  const destination = targetWaypoints.at(-1);
  if (!validateTokenDestination(targetDocument, destination, { ignoreIds: [grapplerDocument.id, targetDocument.id] })) {
    ui.notifications.warn(localizeHud("GrappledTargetCannotMove"));
    return false;
  }

  const sourceMovement = movement[grapplerDocument.id] ?? {};
  return {
    sceneId: grapplerDocument.parent?.id ?? grapplerDocument.scene?.id ?? canvas.scene?.id ?? "",
    grapplerTokenId: grapplerDocument.id,
    targetTokenId: targetDocument.id,
    grapplerWaypoints: path.slice(1).map(waypoint => cloneFollowWaypoint(waypoint)).filter(Boolean),
    targetWaypoints,
    method: sourceMovement.method ?? options.method ?? "api",
    planned: Boolean(sourceMovement.planned),
    autoRotate: Boolean(sourceMovement.autoRotate ?? options.autoRotate),
    showRuler: Boolean(sourceMovement.showRuler ?? options.showRuler),
    grapplerConstrainOptions: sourceMovement.constrainOptions ?? options.constrainOptions ?? null,
    terrainOptions: sourceMovement.terrainOptions ?? options.terrainOptions ?? null,
    measureOptions: sourceMovement.measureOptions ?? options.measureOptions ?? null
  };
}

function cloneFollowWaypoint(waypoint = {}) {
  const normalized = normalizeMovementWaypoint(waypoint);
  if (!normalized) return null;
  return {
    ...normalized,
    action: waypoint.action,
    snapped: waypoint.snapped,
    explicit: waypoint.explicit,
    checkpoint: waypoint.checkpoint ?? true,
    elevation: waypoint.elevation,
    width: waypoint.width,
    height: waypoint.height,
    depth: waypoint.depth,
    shape: waypoint.shape,
    level: waypoint.level
  };
}

function normalizeGrappleFollowPath(grapplerDocument, path = []) {
  const origin = getTokenMovementOrigin(grapplerDocument);
  const waypoints = Array.isArray(path)
    ? path.map(normalizeMovementWaypoint).filter(Boolean)
    : [];
  if (!waypoints.length) return [origin];
  if (!isSameMovementWaypoint(waypoints[0], origin)) waypoints.unshift(origin);
  else waypoints[0] = { ...waypoints[0], ...origin };
  return waypoints;
}

function buildGrappleFollowWaypoints(grapplerDocument, targetDocument, grapplerPath) {
  const targetOrigin = getTokenMovementOrigin(targetDocument);
  let currentTarget = { x: targetOrigin.x, y: targetOrigin.y };
  const waypoints = [];
  let prevGrappler = grapplerPath[0];

  for (const waypoint of grapplerPath.slice(1)) {
    const dx = Number(waypoint.x) - Number(prevGrappler.x);
    const dy = Number(waypoint.y) - Number(prevGrappler.y);
    const shifted = {
      x: currentTarget.x + dx,
      y: currentTarget.y + dy
    };
    const snapped = snapTokenPosition(targetDocument, shifted);
    const targetWaypoint = {
      ...waypoint,
      x: snapped.x,
      y: snapped.y,
      width: targetOrigin.width,
      height: targetOrigin.height,
      depth: targetOrigin.depth,
      shape: targetOrigin.shape,
      level: targetOrigin.level,
      action: waypoint.action ?? "displace",
      snapped: true,
      explicit: waypoint.explicit ?? false,
      checkpoint: waypoint.checkpoint ?? true
    };
    if (Number.isFinite(Number(targetOrigin.elevation)) || Number.isFinite(Number(waypoint.elevation))) {
      const originElevation = Number(targetOrigin.elevation) || 0;
      const prevElevation = Number(prevGrappler.elevation) || originElevation;
      targetWaypoint.elevation = (Number(targetOrigin.elevation) || 0) + ((Number(waypoint.elevation) || prevElevation) - prevElevation);
    }
    waypoints.push(targetWaypoint);
    currentTarget = snapped;
    prevGrappler = waypoint;
  }
  return waypoints;
}

function normalizeMovementWaypoint(waypoint) {
  const x = Number(waypoint?.x);
  const y = Number(waypoint?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { ...waypoint, x, y };
}

function getTokenMovementOrigin(tokenDocument) {
  return {
    x: Number(tokenDocument?._source?.x ?? tokenDocument?.x) || 0,
    y: Number(tokenDocument?._source?.y ?? tokenDocument?.y) || 0,
    elevation: Number(tokenDocument?._source?.elevation ?? tokenDocument?.elevation) || 0,
    width: tokenDocument?._source?.width ?? tokenDocument?.width,
    height: tokenDocument?._source?.height ?? tokenDocument?.height,
    depth: tokenDocument?._source?.depth ?? tokenDocument?.depth,
    shape: tokenDocument?._source?.shape ?? tokenDocument?.shape,
    level: tokenDocument?._source?.level ?? tokenDocument?.level
  };
}

function isSameMovementWaypoint(left, right) {
  return Math.abs((Number(left?.x) || 0) - (Number(right?.x) || 0)) <= 0.5
    && Math.abs((Number(left?.y) || 0) - (Number(right?.y) || 0)) <= 0.5;
}

function getFollowMovementGrapplerId(options, tokenId) {
  return String(options?.[GRAPPLE_FOLLOW_MOVEMENT_OPTION]?.[tokenId] ?? "");
}

function hasPassedMovement(movement) {
  return Array.isArray(movement?.passed?.waypoints) && movement.passed.waypoints.length > 0;
}

function hasMovementCollision(tokenDocument, destination) {
  const object = tokenDocument.object;
  if (!object?.checkCollision) return false;
  const origin = getTokenCenter(tokenDocument);
  const end = getTokenPositionCenter(destination, tokenDocument);
  return Boolean(object.checkCollision(end, { origin, type: "move", mode: "any" }));
}

function isDestinationOccupied(tokenDocument, destination, { ignoreIds = [] } = {}) {
  const scene = tokenDocument.parent ?? tokenDocument.scene ?? canvas.scene;
  const ignored = new Set(ignoreIds.filter(Boolean));
  const rect = getTokenRect(tokenDocument, destination);
  return (scene?.tokens?.contents ?? []).some(other => {
    if (!other?.actor || ignored.has(other.id) || other.id === tokenDocument.id) return false;
    return rectsOverlap(rect, getTokenRect(other));
  });
}

export function areTokensAdjacent(left, right) {
  return areTokensAdjacentAt(left, null, right, null);
}

export function areTokensAdjacentAt(left, leftPosition = null, right, rightPosition = null) {
  return areRectsAdjacent(getTokenRect(left, leftPosition), getTokenRect(right, rightPosition));
}

function areRectsAdjacent(left, right) {
  const gap = getRectGap(left, right);
  const step = getTokenGridStep();
  return gap <= Math.min(step.x, step.y) * 0.25;
}

function getRectGap(left, right) {
  const dx = Math.max(0, Math.max(left.x - (right.x + right.width), right.x - (left.x + left.width)));
  const dy = Math.max(0, Math.max(left.y - (right.y + right.height), right.y - (left.y + left.height)));
  return Math.hypot(dx, dy);
}

function rectsOverlap(left, right) {
  const epsilon = 1;
  return left.x < right.x + right.width - epsilon
    && left.x + left.width > right.x + epsilon
    && left.y < right.y + right.height - epsilon
    && left.y + left.height > right.y + epsilon;
}

function isPointInRect(point, rect) {
  return point.x >= rect.x
    && point.x <= rect.x + rect.width
    && point.y >= rect.y
    && point.y <= rect.y + rect.height;
}

function getTokenRect(tokenDocument, position = null) {
  const size = getTokenPixelSize(tokenDocument);
  return {
    x: Number(position?.x ?? tokenDocument.x) || 0,
    y: Number(position?.y ?? tokenDocument.y) || 0,
    width: size.width,
    height: size.height
  };
}

function getTokenPixelSize(tokenDocument) {
  const fallback = getTokenGridSize(tokenDocument);
  const size = getTokenDocumentSize(tokenDocument);
  return {
    width: Math.max(fallback.x * 0.5, Number(size?.width) || Number(tokenDocument?.width ?? 1) * fallback.x || fallback.x),
    height: Math.max(fallback.y * 0.5, Number(size?.height) || Number(tokenDocument?.height ?? 1) * fallback.y || fallback.y)
  };
}

function getTokenSizeRank(tokenDocument) {
  return Math.max(1, Math.round(Math.max(Number(tokenDocument?.width) || 1, Number(tokenDocument?.height) || 1)));
}

function getTokenCenter(tokenDocument) {
  const center = getTokenDocumentCenter(tokenDocument);
  if (center) return center;
  return getTokenPositionCenter({ x: tokenDocument.x, y: tokenDocument.y }, tokenDocument);
}

function getTokenPositionCenter(position, tokenDocument = null) {
  const size = tokenDocument ? getTokenPixelSize(tokenDocument) : { width: Number(canvas.grid?.size) || 100, height: Number(canvas.grid?.size) || 100 };
  return {
    x: (Number(position?.x) || 0) + size.width / 2,
    y: (Number(position?.y) || 0) + size.height / 2
  };
}

function snapTokenPosition(tokenDocument, position) {
  const snapped = tokenDocument?.getSnappedPosition?.(position) ?? canvas.grid?.getSnappedPosition?.(position.x, position.y) ?? position;
  return {
    x: Number(snapped.x ?? position.x) || 0,
    y: Number(snapped.y ?? position.y) || 0
  };
}

function getTokenDocumentSize(tokenDocument) {
  try {
    return tokenDocument?.getSize?.() ?? null;
  } catch (_error) {
    return null;
  }
}

function getTokenDocumentCenter(tokenDocument) {
  try {
    const center = tokenDocument?.getCenterPoint?.();
    if (!center) return null;
    return {
      x: Number(center.x) || 0,
      y: Number(center.y) || 0
    };
  } catch (_error) {
    return null;
  }
}

function getTokenGridStep(tokenDocument = null) {
  const gridSize = getTokenGridSize(tokenDocument);
  const grid = tokenDocument?.parent?.grid ?? tokenDocument?.scene?.grid ?? canvas.grid ?? canvas.scene?.grid;
  if (!grid?.isSquare) return { x: gridSize.x / 2, y: gridSize.y / 2 };
  const width = Math.max(0.5, Math.round(Number(tokenDocument?.width ?? 1) * 2) / 2);
  const height = Math.max(0.5, Math.round(Number(tokenDocument?.height ?? 1) * 2) / 2);
  return {
    x: width < 1 || !Number.isInteger(width) ? gridSize.x / 4 : gridSize.x,
    y: height < 1 || !Number.isInteger(height) ? gridSize.y / 4 : gridSize.y
  };
}

function getTokenGridSize(tokenDocument = null) {
  const grid = tokenDocument?.parent?.grid ?? tokenDocument?.scene?.grid ?? canvas.grid ?? canvas.scene?.grid;
  const sizeX = Math.max(1, Number(grid?.sizeX ?? grid?.size) || 100);
  const sizeY = Math.max(1, Number(grid?.sizeY ?? grid?.size) || sizeX);
  return { x: sizeX, y: sizeY };
}

function getSteppedRange(start, end, step) {
  const min = Math.min(Number(start) || 0, Number(end) || 0);
  const max = Math.max(Number(start) || 0, Number(end) || 0);
  const distance = Math.max(0, max - min);
  const increment = Math.max(1, Number(step) || 1);
  const count = Math.ceil(distance / increment);
  const values = [];
  for (let i = 0; i <= count; i += 1) values.push(Math.min(max, min + (i * increment)));
  if (values.at(-1) !== max) values.push(max);
  return values;
}

function getCoveredCellStarts(start, size, step) {
  const origin = Number(start) || 0;
  const increment = Math.max(1, Number(step) || 1);
  const count = Math.max(1, Math.ceil((Math.max(0, Number(size) || 0) / increment) - 1e-6));
  const values = [];
  for (let i = 0; i < count; i += 1) values.push(origin + (i * increment));
  return values;
}

function getPositionKey(position) {
  return `${Math.round(Number(position?.x) || 0)},${Math.round(Number(position?.y) || 0)}`;
}

function getCellKey(x, y) {
  return `${Math.round(Number(x) || 0)},${Math.round(Number(y) || 0)}`;
}

function isSameTokenPosition(position, tokenDocument, tolerance = 0.25) {
  return Math.hypot((Number(position?.x) || 0) - (Number(tokenDocument?.x) || 0), (Number(position?.y) || 0) - (Number(tokenDocument?.y) || 0)) <= tolerance;
}

function getSceneToken(tokenDocument, tokenId = "") {
  if (!tokenDocument || !tokenId) return null;
  return (tokenDocument.parent ?? tokenDocument.scene ?? canvas.scene)?.tokens?.get(tokenId) ?? null;
}

function getTokenDocument(tokenOrDocument) {
  return tokenOrDocument?.document ?? tokenOrDocument ?? null;
}

function getScene(sceneId = "") {
  return game.scenes?.get(sceneId) ?? canvas.scene ?? null;
}

function getResponsibleGM() {
  return (game.users?.contents ?? [])
    .filter(user => user.active && user.isGM)
    .sort((left, right) => left.id.localeCompare(right.id))
    .at(0) ?? null;
}

function getResponsibleOwner(actor) {
  return (game.users?.contents ?? [])
    .filter(user => user.active && !user.isGM && actor?.testUserPermission?.(user, "OWNER"))
    .sort((left, right) => left.id.localeCompare(right.id))
    .at(0) ?? null;
}

function getDragPreviewLayer() {
  return canvas.controls?._rulerPaths ?? canvas.controls ?? canvas.stage;
}

function mergeTokenUpdates(updates = []) {
  const merged = new Map();
  for (const update of updates) {
    const id = update._id;
    if (!id) continue;
    merged.set(id, { ...(merged.get(id) ?? { _id: id }), ...update });
  }
  return [...merged.values()];
}

async function syncGrappleEffect(actor, active = false, grapplerDocument = null) {
  if (!actor) return;
  const effects = actor.effects?.filter(effect => effect.getFlag(SYSTEM_ID, GRAPPLE_EFFECT_FLAG)) ?? [];
  if (!active) {
    if (effects.length) await actor.deleteEmbeddedDocuments("ActiveEffect", effects.map(effect => effect.id), { animate: false });
    return;
  }
  const name = localizeHud("GrappledEffectName");
  const existing = effects.at(0);
  const attackDisadvantageAmount = getGrappleTargetAttackDisadvantageAmount({
    grapplerActor: grapplerDocument?.actor ?? null,
    targetActor: actor,
    grapplerDocument,
    baseAmount: GRAPPLED_ATTACK_DISADVANTAGE_AMOUNT
  });
  const data = {
    type: "base",
    name,
    img: GRAPPLE_EFFECT_ICON,
    disabled: false,
    statuses: ["grappled"],
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    flags: {
      core: {
        overlay: true
      },
      [SYSTEM_ID]: {
        [GRAPPLE_EFFECT_FLAG]: {
          grapplerTokenId: grapplerDocument?.id ?? "",
          grapplerName: grapplerDocument?.name ?? ""
        }
      }
    },
    system: {
      changes: [{
        key: ALL_COMBAT_DISADVANTAGE_EFFECT_KEY,
        type: "add",
        value: String(attackDisadvantageAmount),
        phase: "initial",
        priority: null
      }]
    }
  };
  if (existing) {
    const { type: _type, ...updateData } = data;
    await existing.update(updateData, { animate: false });
    if (effects.length > 1) await actor.deleteEmbeddedDocuments("ActiveEffect", effects.slice(1).map(effect => effect.id), { animate: false });
    return;
  }
  await actor.createEmbeddedDocuments("ActiveEffect", [data], { animate: false });
}

async function createActionMessage(content, actor = null, flavor = "") {
  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor,
    content: `<p>${escapeHtml(content)}</p>`
  });
}

function localizeHud(key) {
  return game.i18n.localize(`FALLOUTMAW.Settings.HUD.${key}`);
}

function formatHud(key, data = {}) {
  return game.i18n.format(`FALLOUTMAW.Settings.HUD.${key}`, data);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[character]));
}
