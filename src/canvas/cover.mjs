import { SYSTEM_ID } from "../constants.mjs";
import { refreshTokenActionHudForActor } from "../apps/token-action-hud.mjs";
import { getCoverSettings } from "../settings/accessors.mjs";
import { COVER_SETTINGS_SETTING } from "../settings/constants.mjs";

export const FORCED_COVER_FLAG = "forcedCover";

const ACTIVE_EFFECT_SHOW_ICON_ALWAYS = 2;

export function registerCoverHooks() {
  Hooks.on("renderTokenHUD", decorateTokenHudCoverPalette);
  Hooks.on("createActiveEffect", refreshTokenHudForCoverEffect);
  Hooks.on("updateActiveEffect", refreshTokenHudForCoverEffect);
  Hooks.on("deleteActiveEffect", refreshTokenHudForCoverEffect);
  Hooks.on("updateSetting", setting => {
    if (setting?.key !== `${SYSTEM_ID}.${COVER_SETTINGS_SETTING}`) return;
    if (!game.user?.isActiveGM) return;
    void syncLoadedForcedCoverEffects();
  });
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
  if (!effect?.getFlag?.(SYSTEM_ID, FORCED_COVER_FLAG)) return;
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

function getEffectUpdateData(effect, data) {
  const update = {};
  for (const key of ["name", "img", "origin", "transfer", "disabled", "showIcon"]) {
    if (effect[key] !== data[key]) update[key] = data[key];
  }
  const currentChanges = effect.system?.changes ?? [];
  const nextChanges = data.system?.changes ?? [];
  if (JSON.stringify(currentChanges) !== JSON.stringify(nextChanges)) update["system.changes"] = nextChanges;

  const currentData = effect.getFlag(SYSTEM_ID, FORCED_COVER_FLAG) ?? {};
  const nextData = data.flags[SYSTEM_ID][FORCED_COVER_FLAG];
  if (JSON.stringify(currentData) !== JSON.stringify(nextData)) {
    update[`flags.${SYSTEM_ID}.${FORCED_COVER_FLAG}`] = nextData;
  }
  if (effect.getFlag(SYSTEM_ID, "kind") !== "cover") update[`flags.${SYSTEM_ID}.kind`] = "cover";
  return update;
}

async function deleteExistingCoverEffects(actor, ids = []) {
  const existingIds = ids.filter(id => hasActorEffect(actor, id));
  if (!existingIds.length) return;

  try {
    await actor.deleteEmbeddedDocuments("ActiveEffect", existingIds);
  } catch (error) {
    if (!isMissingDocumentError(error)) throw error;
  }
}

async function updateCoverEffect(effect, update = {}) {
  try {
    await effect.update(update);
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
