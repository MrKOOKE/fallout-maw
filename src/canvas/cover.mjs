import { SYSTEM_ID } from "../constants.mjs";
import { refreshTokenActionHudForActor } from "../apps/token-action-hud.mjs";
import { getCoverSettings } from "../settings/accessors.mjs";
import { COVER_SETTINGS_SETTING } from "../settings/constants.mjs";

export const FORCED_COVER_FLAG = "forcedCover";
export const AUTO_COVER_FLAG = "autoCover";

const ACTIVE_EFFECT_SHOW_ICON_ALWAYS = 2;
const COVER_SOCKET = `system.${SYSTEM_ID}`;
const COVER_SOCKET_SCOPE = "fallout-maw.cover";
const COVER_SOCKET_TIMEOUT_MS = 10000;
const AUTO_COVER_FLUSH_DELAY_MS = 120;

const pendingCoverSocketRequests = new Map();
const pendingAutoCoverStates = new Map();
const autoCoverFlushTimers = new Map();
const autoCoverAttackQueues = new Map();

export function registerCoverHooks() {
  Hooks.on("renderTokenHUD", decorateTokenHudCoverPalette);
  Hooks.on("createActiveEffect", refreshTokenHudForCoverEffect);
  Hooks.on("updateActiveEffect", refreshTokenHudForCoverEffect);
  Hooks.on("deleteActiveEffect", refreshTokenHudForCoverEffect);
  Hooks.on("canvasReady", () => {
    if (!game.user?.isActiveGM) return;
    void clearLoadedAutoCoverEffects();
  });
  Hooks.on("updateSetting", setting => {
    if (setting?.key !== `${SYSTEM_ID}.${COVER_SETTINGS_SETTING}`) return;
    if (!game.user?.isActiveGM) return;
    void syncLoadedForcedCoverEffects();
  });
}

export function registerCoverSocket() {
  game.socket.on(COVER_SOCKET, handleCoverSocketMessage);
}

export function getCoverChoicesForToken(tokenDocument) {
  const activeKey = getActorForcedCoverKey(tokenDocument?.actor);
  return [
    {
      key: "",
      label: "Без укрытия",
      img: "icons/svg/cancel.svg",
      overlapPercent: 0,
      active: !activeKey
    },
    ...getCoverSettings().entries.map(entry => ({
      key: entry.key,
      label: entry.label,
      img: entry.img || "icons/svg/shield.svg",
      overlapPercent: entry.overlapPercent,
      active: entry.key === activeKey
    }))
  ];
}

export function getActorForcedCoverKey(actor) {
  return String(getActorForcedCoverData(actor)?.key ?? "");
}

export function getActorForcedCoverData(actor) {
  for (const effect of actor?.effects ?? []) {
    const data = effect.getFlag?.(SYSTEM_ID, FORCED_COVER_FLAG);
    if (data?.key && !effect.disabled) return data;
  }
  return null;
}

export async function setTokenForcedCover(tokenDocument, coverKey = "") {
  const actor = tokenDocument?.actor;
  if (!actor?.isOwner) return null;

  const key = String(coverKey ?? "").trim();
  const cover = getCoverSettings().entries.find(entry => entry.key === key) ?? null;
  const existing = actor.effects.filter(effect => effect.getFlag(SYSTEM_ID, FORCED_COVER_FLAG));

  if (!cover) {
    await deleteExistingCoverEffects(actor, existing.map(effect => effect.id));
    refreshCoverHudsForActor(actor);
    return null;
  }

  const signature = JSON.stringify({
    key: cover.key,
    tokenUuid: tokenDocument?.uuid ?? "",
    change: cover.change,
    overlapPercent: cover.overlapPercent
  });
  const current = existing.find(effect => effect.getFlag(SYSTEM_ID, FORCED_COVER_FLAG)?.signature === signature);
  const obsolete = existing.filter(effect => effect.id !== current?.id).map(effect => effect.id);
  await deleteExistingCoverEffects(actor, obsolete);
  await deleteExistingCoverEffects(actor, getActorAutoCoverEffects(actor).map(effect => effect.id));

  const data = buildCoverEffectData(tokenDocument, cover, signature);
  if (current && hasActorEffect(actor, current.id)) {
    const update = getEffectUpdateData(current, data);
    if (Object.keys(update).length) await updateCoverEffect(current, update);
    refreshCoverHudsForActor(actor);
    return current;
  }

  const created = await actor.createEmbeddedDocuments("ActiveEffect", [data]);
  refreshCoverHudsForActor(actor);
  return created?.[0] ?? null;
}

export async function clearActorForcedCover(actor) {
  if (!actor?.isOwner) return;
  const ids = actor.effects
    .filter(effect => effect.getFlag(SYSTEM_ID, FORCED_COVER_FLAG))
    .map(effect => effect.id);
  await deleteExistingCoverEffects(actor, ids);
  refreshCoverHudsForActor(actor);
}

export function queueAttackAutoCoverSync(attackId, coverStates = []) {
  const id = String(attackId ?? "").trim();
  if (!id) return;

  const stateByActor = new Map();
  for (const state of coverStates) {
    const actorUuid = String(state?.actorUuid ?? state?.actor?.uuid ?? state?.target?.actor?.uuid ?? "").trim();
    if (!actorUuid) continue;
    stateByActor.set(actorUuid, normalizeAutoCoverState({ ...state, attackId: id }));
  }

  pendingAutoCoverStates.set(id, stateByActor);
  window.clearTimeout(autoCoverFlushTimers.get(id));
  autoCoverFlushTimers.set(id, window.setTimeout(() => flushAttackAutoCoverSync(id), AUTO_COVER_FLUSH_DELAY_MS));
}

export function clearAttackAutoCoverSync(attackId) {
  const id = String(attackId ?? "").trim();
  if (!id) return;

  window.clearTimeout(autoCoverFlushTimers.get(id));
  autoCoverFlushTimers.delete(id);
  pendingAutoCoverStates.delete(id);
  void syncAttackAutoCoverState(id, []);
}

function decorateTokenHudCoverPalette(app, element) {
  const root = getHookHtmlElement(app, element);
  const tokenDocument = app?.document ?? app?.object?.document;
  if (!root || !tokenDocument || root.querySelector("[data-fallout-maw-cover-control]")) return;

  const movementPalette = root.querySelector('.palette[data-palette="movementActions"]');
  if (!movementPalette) return;

  const choices = getCoverChoicesForToken(tokenDocument);
  const active = choices.find(choice => choice.active && choice.key) ?? null;
  const button = document.createElement("button");
  button.type = "button";
  button.className = `control-icon${active ? " active" : ""}`;
  button.dataset.action = "togglePalette";
  button.dataset.palette = "forcedCover";
  button.dataset.falloutMawCoverControl = "true";
  button.setAttribute("aria-label", "Укрытие");
  button.setAttribute("data-tooltip", "");
  button.innerHTML = `<img src="${escapeAttribute(active?.img || "icons/svg/shield.svg")}" alt="Укрытие">`;

  const palette = document.createElement("div");
  palette.className = "palette palette-list fallout-maw-cover-palette";
  palette.dataset.palette = "forcedCover";
  palette.innerHTML = choices.map(choice => `
    <a class="palette-list-entry ${choice.active ? "active" : ""}" data-cover-key="${escapeAttribute(choice.key)}">
      <span>
        <img src="${escapeAttribute(choice.img || "icons/svg/shield.svg")}" alt="${escapeAttribute(choice.label)}">
        ${escapeHtml(choice.label)}
      </span>
    </a>
  `).join("");

  for (const entry of palette.querySelectorAll("[data-cover-key]")) {
    entry.addEventListener("click", event => onTokenHudCoverClick(event, app, tokenDocument));
  }

  movementPalette.after(button, palette);
}

async function onTokenHudCoverClick(event, app, tokenDocument) {
  event.preventDefault();
  event.stopPropagation();
  if (!tokenDocument?.actor?.isOwner) return;
  const key = String(event.currentTarget?.dataset?.coverKey ?? "");
  await setTokenForcedCover(tokenDocument, key);
  return app?.render?.({ force: true });
}

async function syncLoadedForcedCoverEffects() {
  const actors = new Set(game.actors?.contents ?? []);
  for (const token of canvas?.tokens?.placeables ?? []) {
    if (token.actor) actors.add(token.actor);
  }

  for (const actor of actors) {
    const data = getActorForcedCoverData(actor);
    if (!data?.key) continue;
    const tokenDocument = canvas?.tokens?.placeables
      ?.find(token => token.actor?.uuid === actor.uuid || token.document?.uuid === data.tokenUuid)
      ?.document;
    await setTokenForcedCover(tokenDocument ?? { actor, uuid: data.tokenUuid }, data.key);
  }
}

async function clearLoadedAutoCoverEffects() {
  for (const actor of getLoadedCoverActors()) {
    await deleteExistingCoverEffects(actor, getActorAutoCoverEffects(actor).map(effect => effect.id));
  }
}

function getLoadedCoverActors() {
  const actors = new Set(game.actors?.contents ?? []);
  for (const token of canvas?.tokens?.placeables ?? []) {
    if (token.actor) actors.add(token.actor);
  }
  return actors;
}

function buildCoverEffectData(tokenDocument, cover, signature) {
  return {
    type: "base",
    name: cover.label,
    img: cover.img || "icons/svg/shield.svg",
    origin: tokenDocument?.uuid ?? "",
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    system: {
      changes: buildCoverEffectChanges(cover)
    },
    flags: {
      [SYSTEM_ID]: {
        kind: "cover",
        [FORCED_COVER_FLAG]: {
          key: cover.key,
          label: cover.label,
          img: cover.img,
          overlapPercent: cover.overlapPercent,
          tokenUuid: tokenDocument?.uuid ?? "",
          signature
        }
      }
    }
  };
}

function buildAutoCoverEffectData(state, cover, signature) {
  return {
    type: "base",
    name: cover.label,
    img: cover.img || "icons/svg/shield.svg",
    origin: state.attackerTokenUuid || state.targetTokenUuid || "",
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    system: {
      changes: buildCoverEffectChanges(cover)
    },
    flags: {
      [SYSTEM_ID]: {
        kind: "cover",
        [AUTO_COVER_FLAG]: {
          attackId: state.attackId,
          key: cover.key,
          label: cover.label,
          img: cover.img,
          overlapPercent: cover.overlapPercent,
          attackerTokenUuid: state.attackerTokenUuid,
          targetTokenUuid: state.targetTokenUuid,
          signature
        }
      }
    }
  };
}

function buildCoverEffectChanges(cover) {
  const change = cover?.change ?? {};
  const key = String(change.key ?? "").trim();
  if (!key) return [];
  return [{
    key,
    type: String(change.type ?? "add").trim() || "add",
    value: String(change.value ?? "0").trim(),
    phase: String(change.phase ?? "initial").trim() || "initial",
    priority: Number.isFinite(Number(change.priority)) ? Math.trunc(Number(change.priority)) : 0
  }];
}

function refreshTokenHudForCoverEffect(effect) {
  if (!effect?.getFlag?.(SYSTEM_ID, FORCED_COVER_FLAG) && !effect?.getFlag?.(SYSTEM_ID, AUTO_COVER_FLAG)) return;
  const actor = effect.parent;
  refreshCoverHudsForActor(actor);
  const hud = canvas?.hud?.token;
  if (!actor || !hud?.rendered) return;

  const hudActor = hud.document?.actor ?? hud.object?.actor;
  if (!hudActor || hudActor.uuid !== actor.uuid) return;
  void hud.render({ force: true });
}

function refreshCoverHudsForActor(actor) {
  refreshTokenActionHudForActor(actor);
}

function flushAttackAutoCoverSync(attackId) {
  autoCoverFlushTimers.delete(attackId);
  const stateByActor = pendingAutoCoverStates.get(attackId);
  pendingAutoCoverStates.delete(attackId);
  void syncAttackAutoCoverState(attackId, Array.from(stateByActor?.values() ?? []));
}

async function syncAttackAutoCoverState(attackId, states = []) {
  const id = String(attackId ?? "").trim();
  if (!id) return;
  if (game.user?.isGM) {
    await enqueueAttackAutoCoverSync(id, states);
    return;
  }
  try {
    await requestCoverSocket("syncAttackAutoCoverState", { attackId: id, states });
  } catch (error) {
    console.error(`${SYSTEM_ID} | Auto cover socket sync failed`, error);
  }
}

function enqueueAttackAutoCoverSync(attackId, states = []) {
  const id = String(attackId ?? "").trim();
  if (!id) return null;
  const previous = autoCoverAttackQueues.get(id) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => reconcileAttackAutoCoverState(id, states))
    .catch(error => console.error(`${SYSTEM_ID} | Auto cover sync failed`, error))
    .finally(() => {
      if (autoCoverAttackQueues.get(id) === next) autoCoverAttackQueues.delete(id);
    });
  autoCoverAttackQueues.set(id, next);
  return next;
}

async function reconcileAttackAutoCoverState(attackId, states = []) {
  const desired = new Map();
  for (const state of states.map(state => normalizeAutoCoverState({ ...state, attackId }))) {
    if (!state.actorUuid || !state.coverKey) continue;
    const actor = getActorByUuid(state.actorUuid);
    if (!actor || getActorForcedCoverData(actor)?.key) continue;
    desired.set(state.actorUuid, { state, actor });
  }

  for (const { actor, effect } of getAttackAutoCoverEffectEntries(attackId)) {
    const desiredEntry = desired.get(actor.uuid);
    if (!desiredEntry) {
      await deleteExistingCoverEffects(actor, [effect.id]);
      refreshCoverHudsForActor(actor);
      continue;
    }
    if (effect.getFlag(SYSTEM_ID, AUTO_COVER_FLAG)?.key !== desiredEntry.state.coverKey) {
      await deleteExistingCoverEffects(actor, [effect.id]);
    }
  }

  for (const { state, actor } of desired.values()) {
    await applyAutoCoverState(actor, state);
  }
}

async function applyAutoCoverState(actor, state) {
  const cover = getCoverSettings().entries.find(entry => entry.key === state.coverKey) ?? null;
  if (!actor || !cover) return;
  const existing = getActorAutoCoverEffects(actor)
    .filter(effect => effect.getFlag(SYSTEM_ID, AUTO_COVER_FLAG)?.attackId === state.attackId);
  const signature = getAutoCoverSignature(state, cover);
  const current = existing.find(effect => effect.getFlag(SYSTEM_ID, AUTO_COVER_FLAG)?.signature === signature);
  const obsolete = existing.filter(effect => effect.id !== current?.id).map(effect => effect.id);
  await deleteExistingCoverEffects(actor, obsolete);

  const data = buildAutoCoverEffectData(state, cover, signature);
  if (current && hasActorEffect(actor, current.id)) {
    const update = getEffectUpdateData(current, data, AUTO_COVER_FLAG);
    if (Object.keys(update).length) await updateCoverEffect(current, update);
  } else {
    await actor.createEmbeddedDocuments("ActiveEffect", [data], { animate: false });
  }

  refreshCoverHudsForActor(actor);
}

function getAutoCoverSignature(state, cover) {
  return JSON.stringify({
    attackId: state.attackId,
    key: cover.key,
    attackerTokenUuid: state.attackerTokenUuid,
    targetTokenUuid: state.targetTokenUuid,
    change: cover.change,
    overlapPercent: cover.overlapPercent
  });
}

function getHookHtmlElement(app, element) {
  if (element instanceof HTMLElement) return element;
  if (element?.[0] instanceof HTMLElement) return element[0];
  if (app?.element instanceof HTMLElement) return app.element;
  if (app?.element?.[0] instanceof HTMLElement) return app.element[0];
  return null;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  })[character]);
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

function getEffectUpdateData(effect, data, flag = FORCED_COVER_FLAG) {
  const update = {};
  for (const key of ["name", "img", "origin", "transfer", "disabled", "showIcon"]) {
    if (effect[key] !== data[key]) update[key] = data[key];
  }
  const currentChanges = effect.system?.changes ?? [];
  const nextChanges = data.system?.changes ?? [];
  if (JSON.stringify(currentChanges) !== JSON.stringify(nextChanges)) update["system.changes"] = nextChanges;

  const currentData = effect.getFlag(SYSTEM_ID, flag) ?? {};
  const nextData = data.flags[SYSTEM_ID][flag];
  if (JSON.stringify(currentData) !== JSON.stringify(nextData)) {
    update[`flags.${SYSTEM_ID}.${flag}`] = nextData;
  }
  if (effect.getFlag(SYSTEM_ID, "kind") !== "cover") update[`flags.${SYSTEM_ID}.kind`] = "cover";
  return update;
}

function getActorAutoCoverEffects(actor) {
  return (actor?.effects?.contents ?? Array.from(actor?.effects ?? []))
    .filter(effect => effect?.getFlag?.(SYSTEM_ID, AUTO_COVER_FLAG));
}

function getAttackAutoCoverEffectEntries(attackId) {
  const id = String(attackId ?? "").trim();
  if (!id) return [];
  const entries = [];
  for (const actor of getLoadedCoverActors()) {
    for (const effect of getActorAutoCoverEffects(actor)) {
      if (effect.getFlag(SYSTEM_ID, AUTO_COVER_FLAG)?.attackId === id) entries.push({ actor, effect });
    }
  }
  return entries;
}

function normalizeAutoCoverState(state = {}) {
  return {
    attackId: String(state.attackId ?? "").trim(),
    actorUuid: String(state.actorUuid ?? state.actor?.uuid ?? state.target?.actor?.uuid ?? "").trim(),
    targetTokenUuid: String(state.targetTokenUuid ?? state.target?.document?.uuid ?? state.target?.document?.id ?? "").trim(),
    attackerTokenUuid: String(state.attackerTokenUuid ?? "").trim(),
    coverKey: String(state.coverKey ?? "").trim(),
    obstructionPercent: clampPercent(state.obstructionPercent)
  };
}

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(100, Math.max(0, Math.round(number)));
}

function getActorByUuid(uuid) {
  const id = String(uuid ?? "").trim();
  if (!id) return null;
  const actor = globalThis.fromUuidSync?.(id) ?? foundry.utils.fromUuidSync?.(id);
  if (actor) return actor;
  return game.actors?.contents?.find(candidate => candidate.uuid === id || candidate.id === id) ?? null;
}

async function requestCoverSocket(action, payload = {}) {
  const gm = getResponsibleGM();
  if (!gm) return null;
  const requestId = foundry.utils.randomID();
  const requesterUserId = game.user?.id ?? "";
  const promise = new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingCoverSocketRequests.delete(requestId);
      reject(new Error("GM did not answer cover request."));
    }, COVER_SOCKET_TIMEOUT_MS);
    pendingCoverSocketRequests.set(requestId, { resolve, reject, timeout });
  });
  game.socket.emit(COVER_SOCKET, {
    scope: COVER_SOCKET_SCOPE,
    type: "request",
    action,
    requestId,
    requesterUserId,
    gmUserId: gm.id,
    payload
  });
  return promise;
}

async function handleCoverSocketMessage(message = {}) {
  if (message?.scope !== COVER_SOCKET_SCOPE) return;

  if (message.type === "response") {
    if (message.recipientUserId && message.recipientUserId !== game.user?.id) return;
    const pending = pendingCoverSocketRequests.get(message.requestId);
    if (!pending) return;
    window.clearTimeout(pending.timeout);
    pendingCoverSocketRequests.delete(message.requestId);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error || "Cover socket request failed."));
    return;
  }

  if (message.type !== "request") return;
  if (!game.user?.isGM || message.gmUserId !== game.user.id) return;

  try {
    const result = await handleCoverSocketRequest(message.action, message.payload ?? {});
    game.socket.emit(COVER_SOCKET, {
      scope: COVER_SOCKET_SCOPE,
      type: "response",
      requestId: message.requestId,
      recipientUserId: message.requesterUserId,
      ok: true,
      result
    });
  } catch (error) {
    console.error(`${SYSTEM_ID} | Cover socket request failed`, error);
    game.socket.emit(COVER_SOCKET, {
      scope: COVER_SOCKET_SCOPE,
      type: "response",
      requestId: message.requestId,
      recipientUserId: message.requesterUserId,
      ok: false,
      error: error.message
    });
  }
}

async function handleCoverSocketRequest(action, payload = {}) {
  if (action === "syncAttackAutoCoverState") {
    await enqueueAttackAutoCoverSync(payload.attackId, payload.states ?? []);
  }
  return undefined;
}

function getResponsibleGM() {
  return (game.users?.contents ?? [])
    .filter(user => user.active && user.isGM)
    .sort((left, right) => left.id.localeCompare(right.id))
    .at(0) ?? null;
}

async function deleteExistingCoverEffects(actor, ids = []) {
  const existingIds = ids.filter(id => hasActorEffect(actor, id));
  if (!existingIds.length) return;

  try {
    await actor.deleteEmbeddedDocuments("ActiveEffect", existingIds, { animate: false });
  } catch (error) {
    if (!isMissingDocumentError(error)) throw error;
  }
}

async function updateCoverEffect(effect, update = {}) {
  try {
    await effect.update(update, { animate: false });
  } catch (error) {
    if (!isMissingDocumentError(error)) throw error;
  }
}

function hasActorEffect(actor, effectId) {
  const id = String(effectId ?? "");
  if (!id) return false;
  if (actor?.effects?.has?.(id)) return true;
  if (actor?.effects?.get?.(id)) return true;
  return Boolean(actor?.effects?.some?.(effect => effect.id === id));
}

function isMissingDocumentError(error) {
  return /does not exist/i.test(String(error?.message ?? error ?? ""));
}
