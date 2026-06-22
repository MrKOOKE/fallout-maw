import { buildEffectKeyTokens } from "../utils/effect-key-tokens.mjs";
import { evaluateActorEffectChangeBaseNumber, prepareActorEffectChangeForApplication } from "../utils/active-effect-changes.mjs";
import { isDodgeAmountModifierEffectKey } from "../combat/dodge-effect-keys.mjs";
import { getDamageTypeSettings } from "../settings/accessors.mjs";
import { isPostureEffectApplicableToActor } from "./posture-movement.mjs";
import { appendGrappleFollowMovement } from "../combat/active-actions.mjs";
import { getConditionFunction, getProsthesisFunction, hasItemFunction, ITEM_FUNCTIONS } from "../utils/item-functions.mjs";

const TOOLTIP_ANCHOR_CLASS = "fallout-maw-token-effect-tooltip-anchor";
const TOOLTIP_CLASS = "fallout-maw-effect-tooltip";
const TOOLTIP_DIRECTION = "LEFT";
const TOOLTIP_ACTIVATION_MS = 200;
const TOOLTIP_DEACTIVATION_MS = 90;
const DAMAGE_EFFECT_CHANGE_ROOT = "system.damageEffects";
const POSTURE_EFFECT_CHANGE_ROOT = "system.postures";
const POSTURE_WEAPON_ACTION_COST_SUFFIX = ".weaponActionCost";
const BLEEDING_DAMAGE_TYPE_KEY = "bleeding";
const HEALTH_BAR_ATTRIBUTES = new Set(["resources.health", "system.resources.health"]);

let activeEffectTooltipAnchor = null;
let activeEffectTooltipToken = null;
let activateTooltipTimeout = null;
let deactivateTooltipTimeout = null;
let middleClickGuardRegistered = false;

/**
 * System token implementation with readable Active Effect icon tooltips.
 */
export class FalloutMaWToken extends foundry.canvas.placeables.Token {
  /**
   * Put the token into Foundry's native left-drag workflow after movement
   * planning was started from a DOM control instead of from the canvas.
   */
  startMovementPlanningDrag() {
    const manager = this.mouseInteractionManager;
    const eventSystem = canvas?.app?.renderer?.events;
    const boundary = eventSystem?.rootBoundary;
    if (!manager || !boundary || !eventSystem?.pointer) return false;

    if (manager.state > manager.states.HOVER) manager.cancel();
    if (manager.state === manager.states.NONE) {
      const hoverEvent = boundary.createPointerEvent(eventSystem.pointer, "pointerover", this);
      hoverEvent.path = null;
      hoverEvent.nativeEvent = null;
      hoverEvent.buttons = 0;
      try {
        manager.handleEvent(hoverEvent);
      } finally {
        boundary.freeEvent(hoverEvent);
      }
    }
    if (manager.state !== manager.states.HOVER) return false;

    // Do not let a recent canvas click turn this synthetic press into a double-click.
    manager.lcTime = 0;
    const downEvent = boundary.createPointerEvent(eventSystem.pointer, "pointerdown", this);
    downEvent.path = null;
    downEvent.nativeEvent = null;
    downEvent.button = 0;
    downEvent.buttons = 1;
    downEvent.defaultPrevented = false;
    try {
      manager.handleEvent(downEvent);
    } finally {
      boundary.freeEvent(downEvent);
    }
    if (manager.state !== manager.states.GRABBED) return false;

    // Cross the drag-resistance threshold immediately. The normal Foundry
    // pointermove/pointerup listeners take over from this point onward.
    const resistance = Number(manager.options?.dragResistance) || 10;
    manager.interactionData.screenOrigin.x -= resistance + 1;
    foundry.canvas.interaction.MouseInteractionManager.emulateMoveEvent();
    return true;
  }

  /** @override */
  _drawBar(index, bar, data) {
    if (HEALTH_BAR_ATTRIBUTES.has(String(data?.attribute ?? ""))) return this._drawHealthBar(index, bar, data);
    return super._drawBar(index, bar, data);
  }

  _drawHealthBar(index, bar, data) {
    const actor = this.actor;
    const maxInfo = calculateHealthBarMaximums(actor, data);
    if (maxInfo.totalMax <= 0) return super._drawBar(index, bar, data);

    const value = Math.max(0, Number(data?.value) || 0);
    const availableValuePct = maxInfo.availableMax > 0
      ? Math.clamp(value, 0, maxInfo.availableMax) / maxInfo.availableMax
      : 0;
    const valuePct = Math.clamp(value, 0, maxInfo.totalMax) / maxInfo.totalMax;
    const blockedPct = Math.clamp(maxInfo.blockedMax, 0, maxInfo.totalMax) / maxInfo.totalMax;
    const availablePct = Math.clamp(maxInfo.availableMax, 0, maxInfo.totalMax) / maxInfo.totalMax;
    const color = Color.fromRGB([1 - (availableValuePct / 2), availableValuePct, 0]);

    const { width, height } = this.document.getSize();
    const s = canvas.dimensions.uiScale;
    const bw = width;
    const bh = 8 * (this.document.height >= 2 ? 1.5 : 1) * s;

    bar.clear();
    bar.lineStyle(s, 0x000000, 1.0);
    bar.beginFill(0x000000, 0.5).drawRoundedRect(0, 0, bw, bh, 3 * s);
    if (maxInfo.blockedMax > 0) {
      const x = availablePct * bw;
      const w = blockedPct * bw;
      bar.beginFill(0x550000, 1.0).lineStyle(1, 0x000000, 1.0).drawRoundedRect(x, 0, w, bh, 2 * s);
    }
    bar.beginFill(color, 1.0).lineStyle(s, 0x000000, 1.0).drawRoundedRect(0, 0, valuePct * bw, bh, 2 * s);

    const posY = index === 0 ? height - bh : 0;
    bar.position.set(0, posY);
  }

  /** @override */
  _prepareDragLeftDropUpdates(event) {
    const result = super._prepareDragLeftDropUpdates(event);
    if (!result) return result;
    const [updates, options = {}] = result;
    const movement = options.movement;
    if (!Array.isArray(updates) || !movement || typeof movement !== "object") return result;

    for (const [tokenId, instruction] of Object.entries(movement)) {
      if (!instruction?.waypoints?.length) continue;
      const context = getDragInteractionContext(event, tokenId);
      const path = context?.foundPath;
      if (!Array.isArray(path) || path.length <= 1) continue;
      const token = context?.token ?? getCanvasToken(tokenId) ?? this;
      if (!appendGrappleFollowMovement(updates, movement, token, path, options)) return null;
    }
    return [updates, options];
  }

  /** @override */
  async _drawEffects() {
    if (activeEffectTooltipToken === this) deactivateEffectTooltip();
    this.effects.renderable = false;

    this.effects.removeChildren().forEach(child => child.destroy());
    this.effects.bg = this.effects.addChild(new PIXI.Graphics());
    this.effects.bg.zIndex = -1;
    this.effects.overlay = null;

    const SHOW_ICON = CONST.ACTIVE_EFFECT_SHOW_ICON;
    const activeEffects = this.actor?.appliedEffects.filter(effect => (
      isPostureEffectApplicableToActor(effect, this.actor)
      && (
        (effect.showIcon === SHOW_ICON.ALWAYS)
        || ((effect.showIcon === SHOW_ICON.CONDITIONAL) && effect.isTemporary)
      )
    )) ?? [];
    const overlayEffect = activeEffects.findLast(effect => effect.flags.core?.overlay);

    const promises = [];
    for (const [index, effect] of activeEffects.entries()) {
      const promise = effect === overlayEffect
        ? this._drawEffectOverlay(effect)
        : this._drawEffectIcon(effect);
      promises.push(promise.then(icon => {
        if (icon) icon.zIndex = index;
      }));
    }
    await Promise.allSettled(promises);

    this.effects.sortChildren();
    this.effects.renderable = true;
    this.renderFlags.set({ refreshEffects: true });
  }

  async _drawEffectIcon(effect) {
    const icon = await super._drawEffect(effect.img, effect.tint);
    if (!icon) return icon;
    this._activateEffectIconInteraction(icon, effect);
    return icon;
  }

  async _drawEffectOverlay(effect) {
    const icon = await this._drawEffectIcon(effect);
    if (icon) icon.alpha = 0.8;
    this.effects.overlay = icon ?? null;
    return icon;
  }

  _activateEffectIconInteraction(icon, effect) {
    icon.eventMode = "static";
    icon.interactive = true;
    icon.cursor = "help";
    icon.on("pointerover", event => this._scheduleEffectTooltip(event, icon, effect));
    icon.on("pointerout", () => scheduleEffectTooltipDeactivation());
    icon.on("pointerupoutside", () => scheduleEffectTooltipDeactivation());
  }

  _scheduleEffectTooltip(event, icon, effect) {
    if (!game.tooltip || !effect) return;
    const point = getClientPoint(event);
    if (!isCanvasTopmostAtPoint(point)) return;
    registerMiddleClickGuard();
    window.clearTimeout(deactivateTooltipTimeout);
    window.clearTimeout(activateTooltipTimeout);

    activeEffectTooltipToken = this;
    const anchor = getEffectTooltipAnchor();
    positionEffectTooltipAnchor(anchor, icon);

    const html = buildEffectTooltipHTML(effect, this.actor);
    if (game.tooltip.element === anchor) {
      game.tooltip.tooltip.innerHTML = foundry.utils.cleanHTML(html);
      resetTooltipAnchor(anchor);
      return;
    }

    activateTooltipTimeout = window.setTimeout(() => {
      if (!isCanvasTopmostAtPoint(point)) return;
      positionEffectTooltipAnchor(anchor, icon);
      game.tooltip.activate(anchor, {
        html,
        cssClass: TOOLTIP_CLASS,
        direction: TOOLTIP_DIRECTION
      });
    }, TOOLTIP_ACTIVATION_MS);
  }

  /** @override */
  destroy(options) {
    if (activeEffectTooltipToken === this) deactivateEffectTooltip();
    return super.destroy(options);
  }
}

function getDragInteractionContext(event, tokenId) {
  const contexts = event?.interactionData?.contexts;
  if (!contexts) return null;
  if (contexts instanceof Map) return contexts.get(tokenId) ?? null;
  return contexts[tokenId] ?? null;
}

function getCanvasToken(tokenId) {
  if (typeof canvas?.tokens?.get === "function") return canvas.tokens.get(tokenId);
  return (canvas?.tokens?.placeables ?? []).find(token => token?.id === tokenId) ?? null;
}

function getEffectTooltipAnchor() {
  if (activeEffectTooltipAnchor?.isConnected) return activeEffectTooltipAnchor;

  const anchor = document.createElement("span");
  anchor.className = TOOLTIP_ANCHOR_CLASS;
  anchor.setAttribute("aria-hidden", "true");
  document.body.append(anchor);
  activeEffectTooltipAnchor = anchor;
  return anchor;
}

function positionEffectTooltipAnchor(anchor, icon) {
  const rect = getIconClientRect(icon);
  anchor.style.left = `${rect.left}px`;
  anchor.style.top = `${rect.top}px`;
  anchor.style.width = `${Math.max(1, rect.width)}px`;
  anchor.style.height = `${Math.max(1, rect.height)}px`;
  resetTooltipAnchor(anchor);
}

function resetTooltipAnchor(anchor) {
  if ((game.tooltip?.element === anchor) && (typeof game.tooltip._setAnchor === "function")) {
    game.tooltip._setAnchor(TOOLTIP_DIRECTION);
  }
}

function scheduleEffectTooltipDeactivation() {
  window.clearTimeout(activateTooltipTimeout);
  window.clearTimeout(deactivateTooltipTimeout);
  deactivateTooltipTimeout = window.setTimeout(() => deactivateEffectTooltip(), TOOLTIP_DEACTIVATION_MS);
}

function deactivateEffectTooltip() {
  window.clearTimeout(activateTooltipTimeout);
  window.clearTimeout(deactivateTooltipTimeout);
  if (game.tooltip?.element === activeEffectTooltipAnchor) game.tooltip.deactivate();
  activeEffectTooltipAnchor?.remove();
  activeEffectTooltipAnchor = null;
  activeEffectTooltipToken = null;
}

function registerMiddleClickGuard() {
  if (middleClickGuardRegistered) return;
  window.addEventListener("pointerup", event => {
    if (event.button !== 1) return;
    if (!game.tooltip?.tooltip?.classList?.contains(TOOLTIP_CLASS)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  middleClickGuardRegistered = true;
}

function buildEffectTooltipHTML(effect, actor = null) {
  const name = localizeDocumentName(effect.name);
  const changes = getEffectChanges(effect).map(change => formatEffectChange(change, actor, effect)).filter(Boolean);
  const duration = getEffectDurationLabel(effect);
  const description = String(effect.description ?? "").trim();

  return `
    <article class="fallout-maw-effect-tooltip-content">
      <header>
        <img src="${escapeHTML(effect.img || "icons/svg/aura.svg")}" alt="">
        <div>
          <strong>${escapeHTML(name)}</strong>
          ${effect.disabled ? `<span>${escapeHTML(localize("FALLOUTMAW.Effects.Disabled"))}</span>` : ""}
        </div>
      </header>
      ${duration ? `<dl>
        <div>
          <dt>${escapeHTML(localize("FALLOUTMAW.Effects.Duration"))}</dt>
          <dd>${escapeHTML(duration)}</dd>
        </div>
      </dl>` : ""}
      ${description ? `<section class="description">${foundry.utils.cleanHTML(description)}</section>` : ""}
      ${changes.length ? `<section class="changes">
        <h4>${escapeHTML(localize("FALLOUTMAW.Effects.Changes"))}</h4>
        <ol>${changes.map(change => `<li>${change}</li>`).join("")}</ol>
      </section>` : ""}
    </article>
  `;
}

function getEffectDurationLabel(effect) {
  const label = String(effect.duration?.label ?? "").trim();
  if (!label || label === localize("FALLOUTMAW.Common.None") || label === localize("COMMON.None")) return "";
  return label;
}

function getEffectChanges(effect) {
  const changes = effect.system?.changes ?? effect.changes ?? [];
  return Array.isArray(changes) ? changes.filter(change => String(change?.key ?? "").trim()) : [];
}

function formatEffectChange(change, actor = null, effect = null) {
  const damageEffect = formatDamageEffectChange(change);
  if (damageEffect) return damageEffect;

  const key = String(change?.key ?? "");
  if (key.startsWith(`${DAMAGE_EFFECT_CHANGE_ROOT}.`)) return "";
  const path = getChangeKeyLabel(key);
  if (isDodgeAmountModifierEffectKey(key)) {
    const value = evaluateActorEffectChangeBaseNumber(actor, { ...change, effect }, {
      fallback: Number(change?.value),
      stage: getEffectChangePreparationStage(change)
    });
    return `<strong>${escapeHTML(path)}:</strong><span>${escapeHTML(`${formatSignedValue(value, change?.type)}%`)}</span>`;
  }
  const preparedChange = prepareTooltipEffectChange(actor, change, effect);
  if (!preparedChange) return "";
  const value = stringifyChangeValue(preparedChange.value);
  if (key.startsWith("system.costs.actions.")) {
    return `<strong>${escapeHTML(stripEffectPathSuffix(path))}:</strong><span>${escapeHTML(formatActionPointDelta(value, preparedChange.type))}</span>`;
  }
  if (isPostureWeaponActionCostChange(key)) {
    return `<strong>${escapeHTML(path)}:</strong><span>${escapeHTML(formatActionPointDelta(value, preparedChange.type))}</span>`;
  }
  return `<strong>${escapeHTML(path)}:</strong><span>${escapeHTML(formatSignedValue(value, preparedChange.type))}</span>`;
}

function prepareTooltipEffectChange(actor, change = {}, effect = null) {
  return prepareActorEffectChangeForApplication(actor, { ...change, effect }, {
    stage: getEffectChangePreparationStage(change)
  });
}

function getEffectChangePreparationStage(change = {}) {
  return String(change?.phase ?? "") === "initial" ? "initial-active-effect" : "prepared";
}

function formatDamageEffectChange(change) {
  const data = parseDamageEffectChange(change);
  if (!data) return "";

  const kind = String(data.kind ?? "");
  if (kind === "bleedingDamage") {
    const label = getDamageTypeLabel(BLEEDING_DAMAGE_TYPE_KEY);
    return `<strong>${escapeHTML(formatDamageEffectLabel(label, data.limbKey))}:</strong><span>${escapeHTML(formatTickDamage(data))}</span>`;
  }
  if (kind === "periodicDamage") {
    const label = getDamageTypeLabel(data.damageTypeKey) || String(data.damageTypeKey ?? "");
    return `<strong>${escapeHTML(formatDamageEffectLabel(label, data.limbKey))}:</strong><span>${escapeHTML(formatPeriodicDamage(data))}</span>`;
  }
  if (kind === "limbLoss") {
    return `<strong>${escapeHTML(localize("FALLOUTMAW.Effects.LimbLoss"))}:</strong><span>${escapeHTML(getLimbLabel(data.limbKey))}</span>`;
  }
  return "";
}

function parseDamageEffectChange(change) {
  const key = String(change?.key ?? "").trim();
  if (!key.startsWith(`${DAMAGE_EFFECT_CHANGE_ROOT}.`)) return null;
  if (foundry.utils.isPlainObject(change?.value)) return foundry.utils.deepClone(change.value);
  if (typeof change?.value !== "string") return null;
  try {
    const data = JSON.parse(change.value.trim());
    return foundry.utils.isPlainObject(data) ? data : null;
  } catch (_error) {
    return null;
  }
}

function formatDamageEffectLabel(label, limbKey) {
  const limbLabel = getLimbLabel(limbKey);
  return limbLabel ? `${label} (${limbLabel})` : label;
}

function formatPeriodicDamage(data) {
  const amount = Math.max(0, Number(data.amountPerTick) || 0);
  const interval = Math.max(1, Number(data.intervalSeconds) || 0);
  return `-${amount} ${localize("FALLOUTMAW.Common.HealthShort")} / ${interval} ${localize("FALLOUTMAW.Common.SecondsShort")}`;
}

function formatTickDamage(data) {
  const amounts = Array.isArray(data.tickAmounts) ? data.tickAmounts : [];
  const total = amounts.reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
  const remaining = Math.max(0, Number(data.remainingTicks) || 0);
  const suffix = remaining ? `, ${remaining} ${localize("FALLOUTMAW.Common.TicksShort")}` : "";
  return `-${total} ${localize("FALLOUTMAW.Common.HealthShort")}${suffix}`;
}

function getDamageTypeLabel(key) {
  const damageType = getDamageTypeSettings().find(entry => entry.key === key);
  return String(damageType?.label || key || "");
}

function getLimbLabel(key) {
  const limbKey = String(key ?? "").trim();
  if (!limbKey) return "";
  const actor = activeEffectTooltipToken?.actor;
  return String(actor?.system?.limbs?.[limbKey]?.label || limbKey);
}

function getChangeKeyLabel(key) {
  const token = getEffectKeyTokenMap().get(key);
  return token?.label || key;
}

function getEffectKeyTokenMap() {
  const map = new Map();
  for (const token of buildEffectKeyTokens()) map.set(token.path, token);
  return map;
}

function stripEffectPathSuffix(label) {
  return String(label ?? "").replace(/:\s*[^:]+$/, "");
}

function isPostureWeaponActionCostChange(key) {
  return key.startsWith(`${POSTURE_EFFECT_CHANGE_ROOT}.`) && key.endsWith(POSTURE_WEAPON_ACTION_COST_SUFFIX);
}

function formatActionPointDelta(value, type = "") {
  const text = formatSignedValue(value, type);
  return `${text} ${localize("FALLOUTMAW.Common.ActionPointsShort")}`;
}

function formatSignedValue(value, type = "") {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value ?? "");
  const sign = String(type ?? "add") === "add" && number > 0 ? "+" : "";
  return `${sign}${number}`;
}

function stringifyChangeValue(value) {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function getIconClientRect(icon) {
  const bounds = icon?.getBounds?.();
  const view = canvas?.app?.view;
  const rect = view?.getBoundingClientRect?.();
  if (bounds && rect) {
    const resolution = canvas.app.renderer?.resolution || 1;
    return {
      left: rect.left + (bounds.x / resolution),
      top: rect.top + (bounds.y / resolution),
      width: bounds.width / resolution,
      height: bounds.height / resolution
    };
  }

  return { left: window.innerWidth / 2, top: window.innerHeight / 2, width: 1, height: 1 };
}

function getClientPoint(event) {
  const nativeEvent = event?.nativeEvent ?? event?.originalEvent ?? event;
  if (Number.isFinite(nativeEvent?.clientX) && Number.isFinite(nativeEvent?.clientY)) {
    return { x: nativeEvent.clientX, y: nativeEvent.clientY };
  }
  return null;
}

function isCanvasTopmostAtPoint(point) {
  const view = canvas?.app?.view;
  if (!view || !point) return false;
  const element = document.elementFromPoint(point.x, point.y);
  return element === view;
}

function calculateHealthBarMaximums(actor, data = {}) {
  const fallbackMax = Math.max(0, Number(data?.max) || 0);
  if (!actor) return { availableMax: fallbackMax, blockedMax: 0, totalMax: fallbackMax };

  let availableMax = 0;
  let blockedMax = 0;
  for (const [limbKey, limb] of Object.entries(actor.system?.limbs ?? {})) {
    const limbMax = Math.max(0, toInteger(limb?.max));
    const prosthesis = getInstalledProsthesis(actor, limbKey);
    if (prosthesis) {
      const contribution = getIntegratedProsthesisHealth(prosthesis, limb);
      availableMax += contribution.max;
      continue;
    }
    if (Boolean(limb?.missing)) {
      blockedMax += limbMax;
      continue;
    }

    const cap = getLimbTraumaCap(actor, limbKey, limbMax);
    availableMax += cap;
    blockedMax += Math.max(0, limbMax - cap);
  }

  if (availableMax <= 0 && blockedMax <= 0) availableMax = fallbackMax;
  const totalMax = Math.max(availableMax + blockedMax, fallbackMax);
  return { availableMax, blockedMax: Math.max(0, totalMax - availableMax), totalMax };
}

function getLimbTraumaCap(actor, limbKey = "", limbMax = 0) {
  return (actor.items ?? [])
    .filter(item => item?.type === "trauma" && String(item.system?.limbKey ?? "") === limbKey)
    .reduce((cap, item) => Math.min(cap, getTraumaLimbCap(item, limbMax)), limbMax);
}

function getTraumaLimbCap(trauma, limbMax = 0) {
  const max = Math.max(0, toInteger(limbMax));
  const percent = Math.max(0, Math.min(100, toInteger(trauma?.system?.thresholdPercent)));
  return Math.floor((max * percent) / 100);
}

function getIntegratedProsthesisHealth(prosthesis, limb = {}) {
  if (!prosthesis) return { value: 0, max: 0 };
  const integration = Math.max(0, Math.min(100, toInteger(getProsthesisFunction(prosthesis).integrationPercent)));
  if (integration <= 0) return { value: 0, max: 0 };

  if (!hasItemFunction(prosthesis, ITEM_FUNCTIONS.condition)) {
    const max = toIntegratedHealthValue(Math.max(0, toInteger(limb?.max)), integration);
    return { value: max, max };
  }

  const condition = getConditionFunction(prosthesis);
  const conditionMax = Math.max(0, toInteger(condition.max));
  const conditionValue = Math.min(Math.max(0, toInteger(condition.value)), conditionMax);
  return {
    value: toIntegratedHealthValue(conditionValue, integration),
    max: toIntegratedHealthValue(conditionMax, integration)
  };
}

function toIntegratedHealthValue(value = 0, integration = 0) {
  return Math.max(0, Math.round((Math.max(0, toInteger(value)) * Math.max(0, Math.min(100, toInteger(integration)))) / 100));
}

function getInstalledProsthesis(actor, limbKey = "") {
  const key = String(limbKey ?? "").trim();
  if (!key) return null;
  return Array.from(actor?.items ?? []).find(item => (
    item?.type === "gear"
    && item.system?.equipped
    && hasItemFunction(item, ITEM_FUNCTIONS.prosthesis)
    && String(item.system?.placement?.mode ?? "") === "prosthesis"
    && String(item.system?.placement?.limbKey ?? "") === key
  )) ?? null;
}

function toInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function localizeDocumentName(value) {
  const text = String(value ?? "");
  return game.i18n.has(text) ? game.i18n.localize(text) : text;
}

function localize(key) {
  return game.i18n.localize(key);
}

function escapeHTML(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}
