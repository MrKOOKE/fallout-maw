import { SYSTEM_ID } from "../constants.mjs";
import { canUserControlConstruct, getUserConstructCrewSeats, getConstructCrewSeatState, getConstructWeaponPartSlotId } from "../utils/construct-crew.mjs";
import { canUserUseConstructWeapon, getConstructWeaponOperatorConfig } from "../utils/construct-weapon-operator.mjs";
import { getConstructVisualRuntimeConfig as getConstructVisualConfig, normalizeConstructVisualRotation, resolveConstructVisualAnchors, resolveConstructVisualLayers } from "../utils/construct-visual-model.mjs";
import { isConstructAimWithinSector } from "../utils/construct-aim-geometry.mjs";
import { isConstructRotationPaid, recordConstructRotationProgress } from "../constructs/rotation-actions.mjs";
import { getInstalledConstructPartForSlot } from "../utils/construct-parts.mjs";
import { advanceConstructRotationRate, createConstructRotationRateState, getConstructRotationTravelDegrees,
  CONSTRUCT_ROTATION_REACHED_EPSILON } from "../utils/construct-rotation-rate.mjs";

const CHANNEL = `system.${SYSTEM_ID}`;
const SCOPE = `${SYSTEM_ID}.constructVisualPreview`;
const SEND_INTERVAL_MS = 100;
const LEASE_MS = 1500;
const outgoing = new Map();
const incoming = new Map();
const pendingVersions = new Map();
const rotationRates = new Map();
let registered = false;
let callbacks = {};

/** Register at ready. Renderer callbacks apply received angles directly, without smoothing or echoing. */
export function registerConstructVisualPreviewSocket(handlers = {}) {
  callbacks = { ...callbacks, ...handlers };
  if (registered || !globalThis.game?.socket) return;
  registered = true;
  game.socket.on(CHANNEL, handlePreviewMessage);
  globalThis.Hooks?.on?.("canvasTearDown", () => {
    clearConstructVisualPreview();
    for (const [key, state] of incoming) removeIncoming(key, state, "scene");
    pendingVersions.clear();
    rotationRates.clear();
  });
  globalThis.Hooks?.on?.("destroyToken", token => {
    clearConstructVisualPreview({ token });
    for (const [key, state] of incoming) if (state.tokenDocument === token.document) removeIncoming(key, state, "destroy");
    for (const [key, state] of rotationRates) if (state.tokenDocument === token.document) rotationRates.delete(key);
  });
  globalThis.Hooks?.on?.("updateToken", document => {
    for (const [key, state] of incoming) {
      if (state.tokenDocument.uuid === document.uuid) finishCommittedIncoming(key, state);
    }
  });
}

/** Call every local aiming tick, including stationary ticks, to keep the remote lease alive. */
export function publishConstructVisualPreview({ token, slotId, rotation, weapon = null, weaponFunctionId = "", passengerId = "", force = false } = {}) {
  const document = token?.document ?? token;
  const user = globalThis.game?.user;
  if (!registered || !document?.uuid || !user?.active || !Number.isFinite(rotation)) return false;
  const payload = { tokenUuid: document.uuid, slotId: String(slotId ?? ""), rotation,
    weaponUuid: String(weapon?.uuid ?? ""), weaponFunctionId: String(weaponFunctionId ?? ""), passengerId: String(passengerId ?? "") };
  if (!validatePreview(document, payload, user)) {
    clearConstructVisualPreview({ token, slotId });
    return false;
  }
  const key = partKey(document.uuid, payload.slotId);
  const now = Date.now();
  let state = outgoing.get(key);
  if (state && !force && now - state.lastSent < SEND_INTERVAL_MS) return false;
  if (!state) {
    state = { sessionId: foundry.utils.randomID(), sequence: 0, lastSent: 0, payload };
    outgoing.set(key, state);
  }
  const rotationState = acceptRotationPreview(document, payload, user, state.sessionId, now);
  if (!rotationState) return false;
  payload.rotation = rotationState.rate.rotation;
  state.lastSent = now;
  state.payload = payload;
  game.socket.emit(CHANNEL, { scope: SCOPE, type: "preview", sessionId: state.sessionId,
    sequence: ++state.sequence, ...payload, rotation: normalizeConstructVisualRotation(payload.rotation) });
  return true;
}

/** Esc, confirmed rotation, attack finish and destruction clear only this client's own sessions. */
export function clearConstructVisualPreview({ token = null, tokenUuid = "", slotId = "", committedRotation = null } = {}) {
  const uuid = token?.document?.uuid ?? token?.uuid ?? tokenUuid;
  for (const [key, state] of outgoing) {
    if (uuid && state.payload.tokenUuid !== uuid || slotId && state.payload.slotId !== slotId) continue;
    outgoing.delete(key);
    endRotationHistory(key, game.user?.id, state.sessionId);
    globalThis.game?.socket?.emit?.(CHANNEL, { scope: SCOPE, type: "clear", sessionId: state.sessionId,
      sequence: ++state.sequence, tokenUuid: state.payload.tokenUuid, slotId: state.payload.slotId,
      ...(Number.isFinite(committedRotation) ? { committedRotation } : {}) });
  }
}

async function handlePreviewMessage(message = {}, senderUserId = "") {
  if (message.scope !== SCOPE || !["preview", "clear"].includes(message.type)) return;
  // The second callback argument is assigned by Foundry's server, never by the payload.
  const sender = globalThis.game?.users?.get?.(String(senderUserId));
  if (!sender?.active || sender.id === game.user?.id || !validEnvelope(message)) return;
  const key = partKey(message.tokenUuid, message.slotId);
  const versionKey = `${sender.id}:${message.sessionId}:${key}`;
  const previous = pendingVersions.get(versionKey);
  if (previous && message.sequence <= previous.sequence) return;
  pendingVersions.set(versionKey, { sequence: message.sequence, at: Date.now() });
  prunePendingVersions();
  if (message.type === "clear") {
    const state = incoming.get(key);
    if (state?.senderUserId === sender.id && state.sessionId === message.sessionId) {
      if (Number.isFinite(message.committedRotation) && Math.abs(message.committedRotation) <= 180) {
        // The message is only a handoff hint, never authority to change stored yaw.
        // Keep the authenticated reached frame if the document update is still in flight.
        state.pendingClearRotation = message.committedRotation;
        if (!finishCommittedIncoming(key, state)) return;
      } else removeIncoming(key, state, "clear");
    }
    else endRotationHistory(key, sender.id, message.sessionId);
    return;
  }
  if (!Number.isFinite(message.rotation) || Math.abs(message.rotation) > 180) return;
  if (outgoing.has(key) && Date.now() - outgoing.get(key).lastSent < LEASE_MS) return;
  const existing = incoming.get(key);
  if (existing && existing.senderUserId !== sender.id && Date.now() - existing.receivedAt < LEASE_MS) return;
  let document;
  try { document = globalThis.fromUuidSync?.(message.tokenUuid) ?? await globalThis.fromUuid?.(message.tokenUuid); }
  catch { return; }
  // A later clear or yaw update wins even if UUID resolution finishes out of order.
  if (pendingVersions.get(versionKey)?.sequence !== message.sequence) return;
  if (!document?.object || document.parent?.id !== globalThis.canvas?.scene?.id) return;
  if (!validatePreview(document, message, sender)) {
    const active = incoming.get(key);
    if (active?.senderUserId === sender.id) removeIncoming(key, active, "unavailable");
    else endRotationHistory(key, sender.id, message.sessionId);
    return;
  }
  const current = incoming.get(key);
  if (current && current.senderUserId !== sender.id && Date.now() - current.receivedAt < LEASE_MS) return;
  const accepted = acceptRotationPreview(document, message, sender, message.sessionId, Date.now());
  if (!accepted) return;
  recordConstructRotationProgress(document, message.slotId, accepted.rate.rotation);
  if (current) globalThis.clearTimeout(current.timeout);
  const state = { tokenDocument: document, token: document.object, slotId: message.slotId,
    rotation: accepted.rate.rotation, senderUserId: sender.id, sessionId: message.sessionId, receivedAt: Date.now() };
  incoming.set(key, state);
  state.timeout = globalThis.setTimeout(() => removeIncoming(key, state, "timeout"), LEASE_MS);
  try { callbacks.onPreview?.(previewCallbackPayload(state)); }
  catch (error) { console.error(`${SYSTEM_ID} | Construct visual preview failed`, error); }
}

/** A changed saved yaw is not evidence of elapsed aiming time. Only this
 * authenticated, still-live history can authorize a different final angle. */
export function validateConstructVisualRotationCommit(document, slotId, rotation, user) {
  const key = partKey(document?.uuid, slotId);
  const context = getRotationContext(document, slotId);
  if (!context || !Number.isFinite(rotation) || !user?.active
    || !isConstructAimWithinSector(rotation, context.part, context.sector.anchorRotation)) {
    resetConstructVisualRotationHistory(document, slotId, user?.id);
    return { ok: false, reason: "unavailable" };
  }
  // Fire-only operators and an unchanged confirmation do not need a new turn.
  if (getConstructRotationTravelDegrees(context.savedRotation, rotation, context.sector)
    <= CONSTRUCT_ROTATION_REACHED_EPSILON) return { ok: true, rotation: context.savedRotation };
  const entry = rotationRates.get(key);
  const now = Date.now();
  if (!entry || entry.historyUserId !== user.id || now - entry.updatedAt > LEASE_MS
    || entry.fingerprint !== context.fingerprint || entry.savedRotation !== context.savedRotation
    || !validatePreview(document, { ...entry.payload, rotation }, user)) {
    resetConstructVisualRotationHistory(document, slotId, user.id);
    return { ok: false, reason: "missingHistory" };
  }
  const advanced = advanceConstructRotationRate(entry.rate, rotation, context.part.rotationSpeed, now, context.sector);
  if (!advanced.reached) return { ok: false, reason: "notReached" };
  entry.rate = advanced.state;
  entry.updatedAt = now;
  return { ok: true, rotation: advanced.state.rotation };
}

/** Expiration/clear resets the angle history, retaining consumed rate credit.
 * A new session therefore cannot obtain a new network allowance by clearing. */
export function resetConstructVisualRotationHistory(document, slotId = "", userId = "") {
  const uuid = document?.uuid;
  for (const [key, entry] of rotationRates) {
    if (uuid && entry.tokenDocument.uuid !== uuid || slotId && entry.slotId !== slotId
      || userId && entry.historyUserId !== userId) continue;
    const remote = incoming.get(key);
    if (remote && (!userId || remote.senderUserId === userId)) removeIncoming(key, remote, "unavailable");
    else endRotationHistory(key, entry.historyUserId, entry.sessionId);
  }
}

function acceptRotationPreview(document, payload, user, sessionId, now) {
  const key = partKey(document.uuid, payload.slotId);
  const context = getRotationContext(document, payload.slotId);
  if (!context) return null;
  let entry = rotationRates.get(key);
  if (entry?.historyUserId && entry.historyUserId !== user.id && now - entry.updatedAt < LEASE_MS) return null;
  const continuing = entry && entry.historyUserId === user.id && entry.sessionId === sessionId
    && now - entry.updatedAt <= LEASE_MS && entry.fingerprint === context.fingerprint
    && entry.savedRotation === context.savedRotation;
  if (!continuing) {
    const credit = entry ? entry.rate.creditSeconds + Math.max(0, (now - entry.rate.timeMs) / 1000) : undefined;
    entry = { tokenDocument: document, slotId: payload.slotId, fingerprint: context.fingerprint,
      savedRotation: context.savedRotation,
      rate: createConstructRotationRateState(context.savedRotation, now, credit), updatedAt: now };
    rotationRates.set(key, entry);
  }
  const advanced = advanceConstructRotationRate(entry.rate, payload.rotation, context.part.rotationSpeed, now, context.sector);
  entry.rate = advanced.state;
  entry.historyUserId = user.id;
  entry.sessionId = sessionId;
  entry.payload = { ...payload };
  entry.updatedAt = now;
  return entry;
}

function endRotationHistory(key, userId, sessionId) {
  const entry = rotationRates.get(key);
  if (!entry || entry.historyUserId !== userId || entry.sessionId !== sessionId) return;
  const context = getRotationContext(entry.tokenDocument, entry.slotId);
  entry.historyUserId = "";
  entry.sessionId = "";
  entry.payload = null;
  if (context) {
    const now = Date.now();
    const credit = entry.rate.creditSeconds + Math.max(0, (now - entry.rate.timeMs) / 1000);
    entry.savedRotation = context.savedRotation;
    entry.fingerprint = context.fingerprint;
    entry.rate = createConstructRotationRateState(context.savedRotation, now, credit);
  }
}

function getRotationContext(document, slotId) {
  if (!document?.actor || document.documentName !== "Token") return null;
  const config = getConstructVisualConfig(document.actor);
  const part = config.parts.find(row => row.slotId === slotId && row.rotates);
  if (!config.enabled || !part) return null;
  const token = document.object;
  // Authority starts from stored rotations. Renderer previews are deliberately
  // excluded: they are the input being checked, not a trusted initial angle.
  const options = {
    width: Math.max(1, Number(token?.w) || Number(document.width) || 1) * Math.abs(Number(document.texture?.scaleX) || 1),
    height: Math.max(1, Number(token?.h) || Number(document.height) || 1) * Math.abs(Number(document.texture?.scaleY) || 1),
    rotations: document.getFlag?.(SYSTEM_ID, "constructVisualState")?.rotations
      ?? document.flags?.[SYSTEM_ID]?.constructVisualState?.rotations ?? {}
  };
  const layer = resolveConstructVisualLayers(document.actor, options).find(row => row.slotId === slotId);
  if (!layer?.visible || layer.broken) return null;
  const anchor = resolveConstructVisualAnchors(document.actor, options).find(row => row.id === part.anchorId);
  const sector = { minRotation: part.minRotation, maxRotation: part.maxRotation, anchorRotation: anchor?.rotation ?? 0 };
  const installed = getInstalledConstructPartForSlot(document.actor, slotId);
  return { part, sector, savedRotation: layer.rotation,
    fingerprint: JSON.stringify([installed?.id, part.id, part.anchorId, part.rotationSpeed,
      part.minRotation, part.maxRotation, sector.anchorRotation]) };
}

function validatePreview(document, payload, user) {
  const actor = document.actor;
  const config = getConstructVisualConfig(actor);
  if (document.documentName !== "Token" || actor?.type !== "construct" || !config.enabled || !payload.slotId) return false;
  if (!user.isGM && (game.paused || document.locked || document.hidden)) return false;
  const part = config.parts.find(part => part.slotId === payload.slotId && part.rotates);
  if (!part) return false;
  if (!isConstructRotationPaid(document, payload.slotId, payload.rotation)) return false;
  const token = document.object;
  const options = { width: Math.max(1, Number(token?.w) || Number(document.width) || 1) * Math.abs(Number(document.texture?.scaleX) || 1),
    height: Math.max(1, Number(token?.h) || Number(document.height) || 1) * Math.abs(Number(document.texture?.scaleY) || 1),
    rotations: { ...(document.getFlag?.(SYSTEM_ID, "constructVisualState")?.rotations ?? {}),
      ...(callbacks.getRotations?.(token) ?? {}) } };
  const layer = resolveConstructVisualLayers(actor, options).find(row => row.slotId === payload.slotId);
  if (!layer?.visible || layer.broken) return false;
  const anchor = resolveConstructVisualAnchors(actor, options).find(row => row.id === part.anchorId);
  if (!isConstructAimWithinSector(payload.rotation, part, anchor?.rotation ?? 0)) return false;
  if (payload.weaponUuid) {
    const weapon = (actor.items?.contents ?? Array.from(actor.items ?? [])).find(item => item.uuid === payload.weaponUuid);
    const boundPart = getConstructWeaponOperatorConfig(weapon, payload.weaponFunctionId).partSlotId || getConstructWeaponPartSlotId(actor, weapon);
    return Boolean(weapon && boundPart === payload.slotId && canUserUseConstructWeapon(actor, weapon, user, "aim", payload.weaponFunctionId,
      { partSlotId: payload.slotId, passengerId: payload.passengerId }));
  }
  if (!canUserControlConstruct(actor, user, "aim", { partSlotId: payload.slotId })) return false;
  if (!payload.passengerId) return true;
  return getUserConstructCrewSeats(actor, user).some(seat => seat.partSlotId === payload.slotId
    && seat.functions.includes("aim") && getConstructCrewSeatState(actor, seat).occupant?.id === payload.passengerId);
}

function validEnvelope(message) {
  return typeof message.tokenUuid === "string" && message.tokenUuid.length <= 200
    && /^Scene\.[A-Za-z0-9_-]+\.Token\.[A-Za-z0-9_-]+$/.test(message.tokenUuid)
    && typeof message.slotId === "string" && message.slotId.length > 0 && message.slotId.length <= 100
    && typeof message.sessionId === "string" && message.sessionId.length > 0 && message.sessionId.length <= 64
    && Number.isSafeInteger(message.sequence) && message.sequence > 0
    && [message.weaponUuid, message.weaponFunctionId, message.passengerId].every(value => value === undefined || typeof value === "string" && value.length <= 200);
}

function partKey(tokenUuid, slotId) { return `${tokenUuid}:${slotId}`; }
function previewCallbackPayload(state) {
  return { token: state.token, tokenDocument: state.tokenDocument, slotId: state.slotId,
    rotation: state.rotation, senderUserId: state.senderUserId };
}
function removeIncoming(key, state, reason) {
  if (incoming.get(key) !== state) return;
  globalThis.clearTimeout(state.timeout);
  incoming.delete(key);
  endRotationHistory(key, state.senderUserId, state.sessionId);
  try { callbacks.onClear?.({ ...previewCallbackPayload(state), reason }); }
  catch (error) { console.error(`${SYSTEM_ID} | Construct visual preview cleanup failed`, error); }
}

function finishCommittedIncoming(key, state) {
  const context = getRotationContext(state.tokenDocument, state.slotId);
  if (!Number.isFinite(state.pendingClearRotation) || !context
    || getConstructRotationTravelDegrees(context.savedRotation, state.pendingClearRotation, context.sector) > CONSTRUCT_ROTATION_REACHED_EPSILON) return false;
  removeIncoming(key, state, "committed");
  return true;
}
function prunePendingVersions() {
  const cutoff = Date.now() - (LEASE_MS * 4);
  for (const [key, state] of pendingVersions) if (state.at < cutoff) pendingVersions.delete(key);
  while (pendingVersions.size > 2048) pendingVersions.delete(pendingVersions.keys().next().value);
}

export const CONSTRUCT_VISUAL_PREVIEW_TESTING = Object.freeze({ handleMessage: handlePreviewMessage, validatePreview,
  outgoing, incoming, pendingVersions, rotationRates, sendIntervalMs: SEND_INTERVAL_MS, leaseMs: LEASE_MS });
