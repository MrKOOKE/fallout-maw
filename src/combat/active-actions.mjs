import { SYSTEM_ID } from "../constants.mjs";
import { requestSkillCheck } from "../rolls/skill-check.mjs";
import { getSkillSettings } from "../settings/accessors.mjs";
import { ACTION_RESOURCE_KEY, MOVEMENT_RESOURCE_KEY, getCombatMovementResourceState } from "./movement-resources.mjs";
import { POSTURE_CHANGE_ACTION_POINT_COST, setActorTokensPosture } from "../canvas/posture-movement.mjs";
import { toInteger } from "../utils/numbers.mjs";

const { DialogV2 } = foundry.applications.api;

export const GRAPPLE_TARGET_FLAG = "grappleTargetTokenId";
export const GRAPPLE_GRAPPLER_FLAG = "grappleGrapplerTokenId";
export const GRAPPLE_ACTION_POINT_COST = 4;

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
const pendingGrappleFollowMoves = new Map();

export function registerActiveActionHooks() {
  Hooks.on("preUpdateToken", onPreUpdateTokenGrapple);
  Hooks.on("updateToken", onUpdateTokenGrapple);
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

export async function useGrappleAction(token) {
  const tokenDocument = getTokenDocument(token);
  const actor = tokenDocument?.actor;
  if (!tokenDocument || !actor?.isOwner) return undefined;

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
  if (!actor?.isOwner || !targetDocument) {
    ui.notifications.warn(localizeHud("NoGrappledTarget"));
    return undefined;
  }

  const candidates = getAdjacentTokenPositions(grapplerDocument, targetDocument)
    .filter(position => validateTokenDestination(targetDocument, position, { ignoreIds: [grapplerDocument.id, targetDocument.id] }));
  if (!candidates.length) {
    ui.notifications.warn(localizeHud("NoDragCell"));
    return undefined;
  }

  const destination = await chooseTokenDestination(candidates);
  if (!destination) return undefined;

  const cost = getGrappleDragCost(grapplerDocument, targetDocument, destination);
  if (!canSpendMovementThenAction(actor, cost)) return undefined;
  await spendMovementThenAction(actor, cost);
  return requestMoveGrappledTarget(targetDocument, destination);
}

export async function requestPushKnockback({ attackerToken = null, targetToken = null, reason = "" } = {}) {
  const attackerDocument = getTokenDocument(attackerToken);
  const targetDocument = getTokenDocument(targetToken);
  if (!attackerDocument || !targetDocument || attackerDocument.id === targetDocument.id) return false;
  return requestActiveActionGMOperation("pushKnockback", {
    sceneId: attackerDocument.parent?.id ?? targetDocument.parent?.id ?? canvas.scene?.id ?? "",
    attackerTokenId: attackerDocument.id,
    targetTokenId: targetDocument.id,
    reason
  });
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
  return attemptGrapple(grapplerDocument, targetDocument);
}

async function attemptGrapple(grapplerDocument, targetDocument) {
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

  const uncontested = isUnableToResist(targetDocument) || await requestOwnerGrappleConsent(grapplerDocument, targetDocument);
  await spendActionPoints(grapplerDocument.actor, GRAPPLE_ACTION_POINT_COST);
  if (uncontested) return linkGrappleAndAnnounce(grapplerDocument, targetDocument);

  const attackerAthletics = getActorSkillValue(grapplerDocument.actor, "ath");
  const size = getGrappleSizeModifiers(grapplerDocument, targetDocument);
  const outcome = await requestSkillCheck({
    actor: targetDocument.actor,
    skillKey: resolveSkillKey(targetDocument.actor, "prc"),
    data: {
      difficulty: 50 + attackerAthletics + size.difficultyModifier,
      situationalModifier: size.resistanceModifier
    },
    animate: true,
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

async function escapeGrapple(targetDocument, grapplerDocument) {
  if (!targetDocument?.actor || !grapplerDocument?.actor) return requestUnlinkGrapple(grapplerDocument, targetDocument);
  if (!canSpendActionPoints(targetDocument.actor, POSTURE_CHANGE_ACTION_POINT_COST)) return undefined;
  await spendActionPoints(targetDocument.actor, POSTURE_CHANGE_ACTION_POINT_COST);

  const outcome = await requestSkillCheck({
    actor: targetDocument.actor,
    skillKey: resolveSkillKey(targetDocument.actor, "ath"),
    data: {
      difficulty: 50 + getActorSkillValue(grapplerDocument.actor, "ath")
    },
    animate: true,
    createMessage: true,
    prompt: false,
    requester: "grappleEscape"
  });
  if (!isSuccessfulCheck(outcome)) {
    await createActionMessage(formatHud("GrappleEscapeFailed", { target: targetDocument.name, grappler: grapplerDocument.name }), targetDocument.actor);
    return false;
  }

  await setActorTokensPosture(targetDocument.actor, "walk");
  await createActionMessage(formatHud("GrappleEscaped", { target: targetDocument.name, grappler: grapplerDocument.name }), targetDocument.actor);
  return requestUnlinkGrapple(grapplerDocument, targetDocument);
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
  const ok = await executeActiveActionGMOperation(message.action, message.payload ?? {});
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
  if (action === "linkGrapple") return linkGrappleDocuments(payload);
  if (action === "unlinkGrapple") return unlinkGrappleDocuments(payload);
  if (action === "moveGrappledTarget") return moveGrappledTargetDocument(payload);
  if (action === "pushKnockback") return pushKnockbackDocument(payload);
  return false;
}

async function linkGrappleDocuments({ sceneId = "", grapplerTokenId = "", targetTokenId = "" } = {}) {
  const scene = getScene(sceneId);
  const grappler = scene?.tokens?.get(grapplerTokenId);
  const target = scene?.tokens?.get(targetTokenId);
  if (!scene || !grappler || !target || grappler.id === target.id) return false;

  const updates = [];
  for (const document of scene.tokens.contents ?? []) {
    if (getGrappleTargetId(document) === target.id || getGrappleTargetId(document) === grappler.id) {
      updates.push({ _id: document.id, [`flags.${SYSTEM_ID}.-=${GRAPPLE_TARGET_FLAG}`]: null });
    }
    if (getGrapplerId(document) === target.id || getGrapplerId(document) === grappler.id) {
      updates.push({ _id: document.id, [`flags.${SYSTEM_ID}.-=${GRAPPLE_GRAPPLER_FLAG}`]: null });
    }
  }
  updates.push({ _id: grappler.id, [`flags.${SYSTEM_ID}.${GRAPPLE_TARGET_FLAG}`]: target.id });
  updates.push({ _id: target.id, [`flags.${SYSTEM_ID}.${GRAPPLE_GRAPPLER_FLAG}`]: grappler.id });
  await scene.updateEmbeddedDocuments("Token", mergeTokenUpdates(updates), { [GRAPPLE_SYNC_OPTION]: true });
  await syncGrappleEffect(target.actor, true, grappler);
  return true;
}

async function unlinkGrappleDocuments({ sceneId = "", grapplerTokenId = "", targetTokenId = "" } = {}) {
  const scene = getScene(sceneId);
  if (!scene) return false;
  const ids = new Set([grapplerTokenId, targetTokenId].filter(Boolean));
  if (!ids.size) return false;
  for (const id of [...ids]) {
    const document = scene.tokens.get(id);
    const targetId = getGrappleTargetId(document);
    const grapplerId = getGrapplerId(document);
    if (targetId) ids.add(targetId);
    if (grapplerId) ids.add(grapplerId);
  }
  const updates = [...ids].map(id => ({
    _id: id,
    [`flags.${SYSTEM_ID}.-=${GRAPPLE_TARGET_FLAG}`]: null,
    [`flags.${SYSTEM_ID}.-=${GRAPPLE_GRAPPLER_FLAG}`]: null
  })).filter(update => scene.tokens.get(update._id));
  if (!updates.length) return false;
  const targetActors = updates
    .map(update => scene.tokens.get(update._id)?.actor)
    .filter(Boolean);
  await scene.updateEmbeddedDocuments("Token", updates, { [GRAPPLE_SYNC_OPTION]: true });
  for (const actor of new Set(targetActors)) await syncGrappleEffect(actor, false);
  return true;
}

async function moveGrappledTargetDocument({ sceneId = "", targetTokenId = "", x = null, y = null } = {}) {
  const scene = getScene(sceneId);
  const target = scene?.tokens?.get(targetTokenId);
  if (!target) return false;
  const destination = { x: Number(x), y: Number(y) };
  if (!validateTokenDestination(target, destination, { ignoreIds: [target.id, getGrapplerId(target)].filter(Boolean) })) return false;
  await target.update(destination, { [GRAPPLE_SYNC_OPTION]: true });
  return true;
}

async function pushKnockbackDocument({ sceneId = "", attackerTokenId = "", targetTokenId = "", reason = "" } = {}) {
  const scene = getScene(sceneId);
  const attacker = scene?.tokens?.get(attackerTokenId);
  const target = scene?.tokens?.get(targetTokenId);
  if (!attacker || !target) return false;
  const destination = getPushDestination(attacker, target);
  if (!destination) return false;
  if (!validateTokenDestination(target, destination, { ignoreIds: [attacker.id, target.id] })) return false;
  await target.update(destination, { [GRAPPLE_SYNC_OPTION]: true });
  await createActionMessage(formatHud("PushKnockback", { target: target.name, attacker: attacker.name }), target.actor, reason);
  return true;
}

function onPreUpdateTokenGrapple(tokenDocument, changes, options) {
  if (options?.[GRAPPLE_SYNC_OPTION]) return true;
  const moves = foundry.utils.hasProperty(changes, "x") || foundry.utils.hasProperty(changes, "y");
  if (!moves) return true;

  const targetGrapplerId = getGrapplerId(tokenDocument);
  if (targetGrapplerId) {
    ui.notifications.warn(formatHud("GrappledMovementBlocked", { target: tokenDocument.name }));
    return false;
  }

  const grappleTargetId = getGrappleTargetId(tokenDocument);
  const targetDocument = getSceneToken(tokenDocument, grappleTargetId);
  if (!targetDocument) return true;

  const nextX = Number(foundry.utils.getProperty(changes, "x") ?? tokenDocument.x);
  const nextY = Number(foundry.utils.getProperty(changes, "y") ?? tokenDocument.y);
  const dx = nextX - tokenDocument.x;
  const dy = nextY - tokenDocument.y;
  if (Math.abs(dx) <= 0.5 && Math.abs(dy) <= 0.5) return true;

  const targetDestination = { x: targetDocument.x + dx, y: targetDocument.y + dy };
  if (!validateTokenDestination(targetDocument, targetDestination, { ignoreIds: [tokenDocument.id, targetDocument.id] })) {
    ui.notifications.warn(localizeHud("GrappledTargetCannotMove"));
    return false;
  }
  pendingGrappleFollowMoves.set(tokenDocument.id, {
    sceneId: tokenDocument.parent?.id ?? tokenDocument.scene?.id ?? canvas.scene?.id ?? "",
    targetTokenId: targetDocument.id,
    x: targetDestination.x,
    y: targetDestination.y
  });
  return true;
}

function onUpdateTokenGrapple(tokenDocument, changes, options) {
  if (options?.[GRAPPLE_SYNC_OPTION]) return;
  if (!foundry.utils.hasProperty(changes, "x") && !foundry.utils.hasProperty(changes, "y")) return;
  const pending = pendingGrappleFollowMoves.get(tokenDocument.id);
  if (!pending) return;
  pendingGrappleFollowMoves.delete(tokenDocument.id);
  void requestActiveActionGMOperation("moveGrappledTarget", pending);
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

async function requestOwnerGrappleConsent(grapplerDocument, targetDocument) {
  if (targetDocument?.actor?.testUserPermission?.(game.user, "OWNER")) return promptGrappleConsent(targetDocument);
  const owner = getResponsibleOwner(targetDocument?.actor);
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
  if (!game.combat) return true;
  const cost = Math.max(0, toInteger(amount));
  const state = getCombatMovementResourceState(actor);
  if (!state || cost <= state.action.value) return true;
  ui.notifications.warn(formatHud("InsufficientActionPoints", {
    actor: actor?.name ?? "",
    resource: state.action.label,
    cost,
    available: state.action.value
  }));
  return false;
}

async function spendActionPoints(actor, amount = 0) {
  if (!game.combat) return;
  const cost = Math.max(0, toInteger(amount));
  const state = getCombatMovementResourceState(actor);
  if (!state || cost <= 0) return;
  await actor.update({
    [`system.resources.${ACTION_RESOURCE_KEY}.value`]: Math.max(0, state.action.current - cost)
  });
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
  if (actionSpend) update[`system.resources.${ACTION_RESOURCE_KEY}.value`] = Math.max(0, state.action.current - actionSpend);
  if (Object.keys(update).length) await actor.update(update);
}

function getGrappleDragCost(grapplerDocument, targetDocument, destination) {
  const gridSize = Math.max(1, Number(canvas.grid?.size) || 100);
  const distanceCells = Math.max(1, Math.ceil(Math.hypot(destination.x - targetDocument.x, destination.y - targetDocument.y) / gridSize));
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
  const gridSize = Math.max(1, Number(canvas.grid?.size) || 100);
  const targetSize = getTokenPixelSize(targetDocument);
  const grapplerSize = getTokenPixelSize(grapplerDocument);
  const center = getTokenTopLeftFromCenter(grapplerDocument, getTokenCenter(grapplerDocument));
  const offsets = [
    { x: -targetSize.width, y: 0 },
    { x: grapplerSize.width, y: 0 },
    { x: 0, y: -targetSize.height },
    { x: 0, y: grapplerSize.height },
    { x: -targetSize.width, y: -targetSize.height },
    { x: grapplerSize.width, y: -targetSize.height },
    { x: -targetSize.width, y: grapplerSize.height },
    { x: grapplerSize.width, y: grapplerSize.height }
  ];
  return offsets.map(offset => snapTokenPosition(targetDocument, {
    x: center.x + offset.x,
    y: center.y + offset.y
  })).filter(position => Math.hypot(position.x - targetDocument.x, position.y - targetDocument.y) > gridSize * 0.25);
}

function chooseTokenDestination(candidates = []) {
  const layer = getDragPreviewLayer();
  const graphics = new PIXI.Graphics();
  graphics.name = GRAPPLE_DRAG_PREVIEW_NAME;
  for (const candidate of candidates) {
    const center = getTokenPositionCenter(candidate);
    graphics.lineStyle(3, 0x43c96b, 0.9);
    graphics.beginFill(0x43c96b, 0.18);
    graphics.drawCircle(center.x, center.y, Math.max(12, Number(canvas.grid?.size) * 0.2));
    graphics.endFill();
  }
  layer.addChild(graphics);
  return chooseCanvasPoint({
    preview: graphics,
    resolvePoint: point => {
      const destination = candidates
        .map(candidate => ({ candidate, distance: Math.hypot(getTokenPositionCenter(candidate).x - point.x, getTokenPositionCenter(candidate).y - point.y) }))
        .sort((left, right) => left.distance - right.distance)
        .at(0);
      if (!destination || destination.distance > Math.max(24, Number(canvas.grid?.size) * 0.5)) return undefined;
      return destination.candidate;
    }
  });
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

function getPushDestination(attackerDocument, targetDocument) {
  const gridSize = Math.max(1, Number(canvas.grid?.size) || 100);
  const attackerCenter = getTokenCenter(attackerDocument);
  const targetCenter = getTokenCenter(targetDocument);
  let dx = targetCenter.x - attackerCenter.x;
  let dy = targetCenter.y - attackerCenter.y;
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) dx = 1;
  const length = Math.max(1, Math.hypot(dx, dy));
  const destination = {
    x: targetDocument.x + Math.round(dx / length) * gridSize,
    y: targetDocument.y + Math.round(dy / length) * gridSize
  };
  return snapTokenPosition(targetDocument, destination);
}

function validateTokenDestination(tokenDocument, destination, { ignoreIds = [] } = {}) {
  if (!tokenDocument || !Number.isFinite(Number(destination?.x)) || !Number.isFinite(Number(destination?.y))) return false;
  const normalized = { x: Number(destination.x), y: Number(destination.y) };
  if (hasMovementCollision(tokenDocument, normalized)) return false;
  if (isDestinationOccupied(tokenDocument, normalized, { ignoreIds })) return false;
  return true;
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

function areTokensAdjacent(left, right) {
  const gap = getRectGap(getTokenRect(left), getTokenRect(right));
  const gridSize = Math.max(1, Number(canvas.grid?.size) || 100);
  return gap <= gridSize * 0.25;
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
  const gridSize = Math.max(1, Number(canvas.grid?.size) || 100);
  return {
    width: Math.max(gridSize, Number(tokenDocument?.width ?? 1) * gridSize),
    height: Math.max(gridSize, Number(tokenDocument?.height ?? 1) * gridSize)
  };
}

function getTokenSizeRank(tokenDocument) {
  return Math.max(1, Math.round(Math.max(Number(tokenDocument?.width) || 1, Number(tokenDocument?.height) || 1)));
}

function getTokenCenter(tokenDocument) {
  return getTokenPositionCenter({ x: tokenDocument.x, y: tokenDocument.y }, tokenDocument);
}

function getTokenPositionCenter(position, tokenDocument = null) {
  const size = tokenDocument ? getTokenPixelSize(tokenDocument) : { width: Number(canvas.grid?.size) || 100, height: Number(canvas.grid?.size) || 100 };
  return {
    x: (Number(position?.x) || 0) + size.width / 2,
    y: (Number(position?.y) || 0) + size.height / 2
  };
}

function getTokenTopLeftFromCenter(tokenDocument, center) {
  const size = getTokenPixelSize(tokenDocument);
  return { x: center.x - size.width / 2, y: center.y - size.height / 2 };
}

function snapTokenPosition(tokenDocument, position) {
  const snapped = tokenDocument?.getSnappedPosition?.(position) ?? canvas.grid?.getSnappedPosition?.(position.x, position.y) ?? position;
  return {
    x: Number(snapped.x ?? position.x) || 0,
    y: Number(snapped.y ?? position.y) || 0
  };
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
    system: { changes: [] }
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
