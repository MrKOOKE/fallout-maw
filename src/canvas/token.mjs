import { buildEffectKeyTokens } from "../utils/effect-key-tokens.mjs";
import { getDamageTypeSettings } from "../settings/accessors.mjs";

const TOOLTIP_ANCHOR_CLASS = "fallout-maw-token-effect-tooltip-anchor";
const TOOLTIP_CLASS = "fallout-maw-effect-tooltip";
const TOOLTIP_DIRECTION = "LEFT";
const TOOLTIP_ACTIVATION_MS = 200;
const TOOLTIP_DEACTIVATION_MS = 90;
const DAMAGE_EFFECT_CHANGE_ROOT = "system.damageEffects";
const BLEEDING_DAMAGE_TYPE_KEY = "bleeding";

let activeEffectTooltipAnchor = null;
let activeEffectTooltipToken = null;
let activateTooltipTimeout = null;
let deactivateTooltipTimeout = null;
let middleClickGuardRegistered = false;

/**
 * System token implementation with readable Active Effect icon tooltips.
 */
export class FalloutMaWToken extends foundry.canvas.placeables.Token {
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
      (effect.showIcon === SHOW_ICON.ALWAYS)
      || ((effect.showIcon === SHOW_ICON.CONDITIONAL) && effect.isTemporary)
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
    icon.on("pointerover", () => this._scheduleEffectTooltip(icon, effect));
    icon.on("pointerout", () => scheduleEffectTooltipDeactivation());
    icon.on("pointerupoutside", () => scheduleEffectTooltipDeactivation());
  }

  _scheduleEffectTooltip(icon, effect) {
    if (!game.tooltip || !effect) return;
    registerMiddleClickGuard();
    window.clearTimeout(deactivateTooltipTimeout);
    window.clearTimeout(activateTooltipTimeout);

    activeEffectTooltipToken = this;
    const anchor = getEffectTooltipAnchor();
    positionEffectTooltipAnchor(anchor, icon);

    const html = buildEffectTooltipHTML(effect);
    if (game.tooltip.element === anchor) {
      game.tooltip.tooltip.innerHTML = foundry.utils.cleanHTML(html);
      resetTooltipAnchor(anchor);
      return;
    }

    activateTooltipTimeout = window.setTimeout(() => {
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

function buildEffectTooltipHTML(effect) {
  const name = localizeDocumentName(effect.name);
  const changes = getEffectChanges(effect).map(formatEffectChange).filter(Boolean);

  return `
    <article class="fallout-maw-effect-tooltip-content">
      <header>
        <img src="${escapeHTML(effect.img || "icons/svg/aura.svg")}" alt="">
        <div>
          <strong>${escapeHTML(name)}</strong>
          ${effect.disabled ? `<span>${escapeHTML(localize("FALLOUTMAW.Effects.Disabled"))}</span>` : ""}
        </div>
      </header>
      <dl>
        <div>
          <dt>${escapeHTML(localize("FALLOUTMAW.Effects.Duration"))}</dt>
          <dd>${escapeHTML(getEffectDurationLabel(effect))}</dd>
        </div>
      </dl>
      ${changes.length ? `<section class="changes">
        <h4>${escapeHTML(localize("FALLOUTMAW.Effects.Changes"))}</h4>
        <ol>${changes.map(change => `<li>${change}</li>`).join("")}</ol>
      </section>` : ""}
    </article>
  `;
}

function getEffectDurationLabel(effect) {
  const label = String(effect.duration?.label ?? "").trim();
  return label || localize("FALLOUTMAW.Common.None");
}

function getEffectChanges(effect) {
  const changes = effect.system?.changes ?? effect.changes ?? [];
  return Array.isArray(changes) ? changes.filter(change => String(change?.key ?? "").trim()) : [];
}

function formatEffectChange(change) {
  const damageEffect = formatDamageEffectChange(change);
  if (damageEffect) return damageEffect;

  const key = String(change?.key ?? "");
  if (key.startsWith(`${DAMAGE_EFFECT_CHANGE_ROOT}.`)) return "";
  const path = getChangeKeyLabel(key);
  const value = stringifyChangeValue(change?.value);
  if (key.startsWith("system.costs.actions.")) {
    return `<strong>${escapeHTML(stripEffectPathSuffix(path))}:</strong><span>${escapeHTML(formatActionPointDelta(value))}</span>`;
  }
  return `<strong>${escapeHTML(path)}:</strong><span>${escapeHTML(value)}</span>`;
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

function formatActionPointDelta(value) {
  const number = Number(value);
  const text = Number.isFinite(number) ? String(number) : String(value ?? "");
  return `${text} ${localize("FALLOUTMAW.Common.ActionPointsShort")}`;
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
