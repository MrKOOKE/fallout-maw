import { buildEffectKeyTokens } from "../utils/effect-key-tokens.mjs";
import { SYSTEM_ID } from "../constants.mjs";
import { evaluateActorEffectChangeBaseNumber, prepareActorEffectChangeForApplication } from "../utils/active-effect-changes.mjs";
import { isDodgeAmountModifierEffectKey } from "../combat/dodge-effect-keys.mjs";
import { getDamageTypeSettings, getResourceSettings } from "../settings/accessors.mjs";
import {
  ABILITY_FUNCTION_TYPES,
  getAbilityFunctionTriggerCostRows,
  normalizeAbilityFunctions
} from "../settings/abilities.mjs";
import { formatDurationShort } from "../utils/duration-parts.mjs";
import { isPostureEffectApplicableToActor } from "./posture-movement.mjs";
import { isTokenEquipmentHudEnabled, openTokenHudForInteraction } from "./token-equipment-hud.mjs";
import { appendGrappleFollowMovement, commitGrappleFollowOrchestrations, GRAPPLE_FOLLOW_ORCHESTRATION_OPTION } from "../combat/active-actions.mjs";
import { getConditionFunction, getProsthesisFunction, hasItemFunction, ITEM_FUNCTIONS } from "../utils/item-functions.mjs";
import {
  isBlockTurnOrderEnabled,
  isTokenDocumentInActiveBlockTurn
} from "../combat/turn-order-blocks.mjs";
import {
  getAbilityRoutePlanCommitter,
  getAbilityRoutePreviewBudget,
  isAbilityRoutePlanningInteractive
} from "./ability-route-preview-state.mjs";

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
const NATIVE_DRAG_START_TIMEOUT_MS = 250;
const NATIVE_DRAG_START_POLL_MS = 5;

let activeEffectTooltipAnchor = null;
let activeEffectTooltipToken = null;
let activateTooltipTimeout = null;
let deactivateTooltipTimeout = null;
let middleClickGuardRegistered = false;

/** Wait for Foundry's throttled synthetic pointermove to initialize native drag. */
function waitForMovementPlanningDrag(manager) {
  const startedAt = Date.now();
  return new Promise(resolve => {
    const check = () => {
      if (manager?.state === manager?.states?.DRAG) return resolve(true);
      if (manager?.state !== manager?.states?.GRABBED) return resolve(false);
      if ((Date.now() - startedAt) >= NATIVE_DRAG_START_TIMEOUT_MS) return resolve(false);
      globalThis.setTimeout(check, NATIVE_DRAG_START_POLL_MS);
    };
    check();
  });
}

/**
 * Enter Foundry's multi-click waypoint mode after a synthetic drag start.
 * Mirrors a prevented pointerup: stay in DRAG with interactionData.released.
 */
function softReleaseAbilityRouteDrag(token) {
  const manager = token?.mouseInteractionManager;
  if (!manager || manager.state !== manager.states.DRAG) return false;

  const eventSystem = canvas?.app?.renderer?.events;
  const boundary = eventSystem?.rootBoundary;
  if (boundary && eventSystem?.pointer) {
    const upEvent = boundary.createPointerEvent(eventSystem.pointer, "pointerup", token);
    upEvent.path = null;
    upEvent.nativeEvent = null;
    upEvent.button = 0;
    upEvent.buttons = 0;
    upEvent.defaultPrevented = false;
    try {
      manager.handleEvent(upEvent);
    } finally {
      boundary.freeEvent(upEvent);
    }
  }

  // Foundry restores DRAG after a prevented drop. If the callback chain did not
  // run (tests or an incomplete manager), still mark released so LKM waypoints
  // use the same multi-click mode as a native Ctrl-release.
  if (manager.state !== manager.states.DRAG) return false;
  if (manager.interactionData?.cancelled || manager.interactionData?.dropped) return false;
  manager.interactionData.released = true;
  return true;
}

/** Current native drag context for an ability-route executor, if any. */
function getAbilityRouteDragContext(token) {
  return token?.layer?._draggedToken?.mouseInteractionManager
    ?.interactionData?.contexts?.[token.document?.id] ?? null;
}

/** Push the live cursor into Foundry's drag destination/foundPath before confirm. */
function syncAbilityRouteDragDestination(token) {
  const pointer = canvas?.app?.renderer?.events?.pointer;
  if (!token || !pointer || !Number.isFinite(pointer.clientX) || !Number.isFinite(pointer.clientY)) return false;
  if (typeof token._updateDragDestination !== "function") return false;
  const point = canvas.canvasCoordinatesFromClient({ x: pointer.clientX, y: pointer.clientY });
  const shift = Boolean(game?.keyboard?.isModifierActive?.("SHIFT"));
  token._updateDragDestination(point, { snap: !shift });
  return true;
}

/** Preview budget still allows confirmation at the exact configured maximum. */
function isAbilityRoutePreviewWithinBudget(preview) {
  if (!preview) return false;
  const used = Number(preview.used);
  const total = Number(preview.total);
  const resourceUsed = Number(preview.resourceUsed);
  const resourceTotal = Number(preview.resourceTotal);
  if (Number.isFinite(used) && Number.isFinite(total) && used > total + 1e-6) return false;
  if (
    Number.isFinite(resourceUsed)
    && Number.isFinite(resourceTotal)
    && resourceUsed > resourceTotal + 1e-6
  ) return false;
  return true;
}

/** Wait for Foundry pathfinding kicked off by destination sync before Enter confirms. */
function waitForAbilityRoutePathReady(context, timeoutMs = 750) {
  if (!context) return Promise.resolve(false);
  if (!context.searching && Array.isArray(context.foundPath) && context.foundPath.length > 1) {
    return Promise.resolve(true);
  }
  const startedAt = Date.now();
  return new Promise(resolve => {
    const check = () => {
      if (!context.searching && Array.isArray(context.foundPath) && context.foundPath.length > 1) {
        return resolve(true);
      }
      if ((Date.now() - startedAt) >= timeoutMs) return resolve(false);
      globalThis.setTimeout(check, NATIVE_DRAG_START_POLL_MS);
    };
    check();
  });
}

/**
 * System token implementation with readable Active Effect icon tooltips.
 */
export class FalloutMaWToken extends foundry.canvas.placeables.Token {
  /**
   * Start Foundry's native movement-planning drag without changing the user's
   * camera or controlled token. Permission to persist the resulting plan is
   * checked separately by the owner/GM socket committer.
   */
  planAbilityMovement({
    allowedActions = null,
    direct = false,
    minCost = 0,
    maxCost = Infinity,
    minDistance = 0,
    maxDistance = Infinity,
    preventDrop = false,
    terrainOptions = {},
    constrainOptions = {},
    measureOptions = {},
    pathfindingOptions = {},
    moveOptions = {}
  } = {}) {
    if (allowedActions) {
      allowedActions = Array.from(allowedActions);
      if (!allowedActions.length) throw new Error("The allowed actions must not be empty.");
      if (!allowedActions.every(action => action in CONFIG.Token.movement.actions)) {
        throw new Error("Invalid movement action.");
      }
    }
    if (!canvas.ready) throw new Error("The canvas is not ready.");
    if (!getAbilityRoutePlanCommitter(this)) throw new Error("The ability route has no authority committer.");

    this.layer._cancelMovementPlanning();
    this.layer._cancelPlacement();
    canvas.regions._cancelPlacement();
    if (canvas.currentMouseManager) {
      canvas.currentMouseManager.interactionData.cancelled = true;
      canvas.currentMouseManager.cancel();
    }
    if (game.paused && !game.user.isGM) {
      ui.notifications.warn("GAME.PausedWarning", { localize: true });
      return Promise.resolve(null);
    }
    if (this.document.locked) {
      ui.notifications.warn("CONTROLS.ObjectIsLocked", { localize: true });
      return Promise.resolve(null);
    }
    if (this.document.hidden && !game.user.isGM) return Promise.resolve(null);

    const { promise, resolve, reject } = Promise.withResolvers();
    this.layer._movementPlanningContext = {
      object: this,
      allowedActions,
      direct,
      minCost,
      maxCost,
      minDistance,
      maxDistance,
      preventDrop,
      terrainOptions: foundry.utils.deepClone(terrainOptions),
      constrainOptions: foundry.utils.deepClone(constrainOptions),
      measureOptions: foundry.utils.deepClone(measureOptions),
      pathfindingOptions: foundry.utils.deepClone(pathfindingOptions),
      moveOptions: foundry.utils.deepClone(moveOptions),
      result: null,
      resolve,
      reject,
      violations: []
    };
    this.layer.activate({ tool: "select" });
    this.layer.setAllRenderFlags({ refreshState: true });
    return promise;
  }

  /**
   * Put the token into Foundry's native left-drag workflow after movement
   * planning was started from a DOM control instead of from the canvas.
   */
  async startMovementPlanningDrag() {
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

    // Foundry throttles emulateMoveEvent, so drag initialization happens on a
    // later task. Do not inspect clones or let the caller cancel movement
    // planning until the native manager has actually entered DRAG.
    const started = await waitForMovementPlanningDrag(manager);
    const clones = manager.interactionData?.clones ?? [];
    const abilityRoute = isAbilityRoutePlanningInteractive(this);
    const valid = started && (
      !abilityRoute
      || (
        clones.length === 1
        && clones[0]?._original === this
        && manager.interactionData?.contexts?.[this.document.id]?.token === this
      )
    );
    if (valid) {
      // Foundry's TokenLayer waypoint clicks expect the "released but still
      // DRAG" state that normally follows a prevented pointerup. Synthetic
      // starts never get that release, so LKM never reaches _onDragClickLeft.
      if (abilityRoute && !softReleaseAbilityRouteDrag(this)) {
        manager.interactionData.cancelled = true;
        manager.cancel();
        return false;
      }
      return true;
    }

    // A failed synthetic start must not remain GRABBED and begin a delayed
    // drag after the movement-planning context has already been cancelled.
    manager.interactionData.cancelled = true;
    manager.cancel();
    return false;
  }

  /** @override */
  _initializeDragLeft(event) {
    if (!isAbilityRoutePlanningInteractive(this)) return super._initializeDragLeft(event);

    // PlaceableObject normally clones layer.controlled. Ability routes always
    // belong to the selected executor, which may be non-owned and deliberately
    // remains uncontrolled. Hold this override exactly while Foundry performs
    // its synchronous native initialization so the clone/context are [this].
    const controllableObjects = this.layer.options.controllableObjects;
    try {
      this.layer.options.controllableObjects = false;
      return super._initializeDragLeft(event);
    } finally {
      this.layer.options.controllableObjects = controllableObjects;
    }
  }

  /** Complete the system's ability-route variant of native movement planning. */
  async completeAbilityRoutePlanning() {
    if (!this.isDragged || !isAbilityRoutePlanningInteractive(this)) return false;

    // Confirm uses the live cursor square as destination even when the user never
    // LKM-planted that final cell as an intermediate waypoint.
    syncAbilityRouteDragDestination(this);

    const context = getAbilityRouteDragContext(this);
    if (!(await waitForAbilityRoutePathReady(context))) {
      ui?.notifications?.warn?.("Маршрут ещё строится. Дождитесь завершения поиска пути.");
      return false;
    }

    const preview = getAbilityRoutePreviewBudget(this);
    if (!Array.isArray(context?.foundPath) || context.foundPath.length <= 1) {
      ui?.notifications?.warn?.("Укажите точку назначения маршрута.");
      return false;
    }
    if (preview?.invalid || context?.unreachableWaypoints?.length) {
      ui?.notifications?.warn?.("Маршрут недоступен по правилам перемещения.");
      return false;
    }
    if (!isAbilityRoutePreviewWithinBudget(preview)) {
      ui?.notifications?.warn?.("Маршрут превышает заданный бюджет.");
      return false;
    }

    this._triggerDragLeftDrop();
    return true;
  }

  /** @override */
  _shouldPreventDragLeftDrop(event) {
    if (isAbilityRoutePlanningInteractive(this) && !event.interactionData.dropped) return true;
    return super._shouldPreventDragLeftDrop(event);
  }

  /** @override */
  _canDrag(user, event) {
    if (isAbilityRoutePlanningInteractive(this)) {
      return !canvas.regions?._placementContext && game.activeTool === "select";
    }
    return super._canDrag(user, event);
  }

  /** @override */
  _onDragClickLeft(event) {
    if (!isAbilityRoutePlanningInteractive(this)) return super._onDragClickLeft(event);
    this._addDragWaypoint(event.interactionData.origin, { snap: !event.shiftKey });
    canvas.mouseInteractionManager.cancel();
  }

  /** @override */
  _canHUD(user, event) {
    if (super._canHUD(user, event)) return true;
    return Boolean(this.layer?.active && this.actor && isTokenEquipmentHudEnabled());
  }

  /** @override */
  _onClickLeft(event) {
    if (!isAbilityRoutePlanningInteractive(this)) return super._onClickLeft(event);
    // While the executor is already in native drag, a click on the token itself
    // must plant a waypoint instead of being swallowed before TokenLayer sees it.
    if (this.isDragged) {
      this._addDragWaypoint(event.interactionData.origin, { snap: !event.shiftKey });
      canvas.mouseInteractionManager.cancel();
    }
    event.stopPropagation();
  }

  /** @override */
  _onDragClickRight(event) {
    // Ability routes distinguish short RMB (undo waypoint) from RMB pan via
    // createRightClickPanGuard. Foundry's default cancels canvas pan here.
    if (isAbilityRoutePlanningInteractive(this)) return;
    return super._onDragClickRight(event);
  }

  /** @override */
  _onClickRight(event) {
    if (!this.isOwner && isTokenEquipmentHudEnabled()) {
      event.stopPropagation();
      return openTokenHudForInteraction(this);
    }
    return super._onClickRight(event);
  }

  /** @override */
  _refreshTurnMarker() {
    if (!isBlockTurnOrderEnabled(game.combat)) return super._refreshTurnMarker();
    if (!isTokenDocumentInActiveBlockTurn(this.document, game.combat)) {
      this._clearTurnMarker();
      return;
    }

    const { turnMarker } = this.document;
    const markersEnabled = CONFIG.Combat.settings.turnMarker.enabled
      && (turnMarker.mode !== CONST.TOKEN_TURN_MARKER_MODES.DISABLED);
    if (markersEnabled) {
      const TokenTurnMarker = foundry.canvas.placeables.tokens.TokenTurnMarker;
      if (!this.turnMarker) this.turnMarker = this.addChildAt(new TokenTurnMarker(this), 0);
      canvas.tokens.turnMarkers.add(this);
      this.turnMarker.draw();
    } else if (this.turnMarker) {
      canvas.tokens.turnMarkers.delete(this);
      this.turnMarker.destroy();
      this.turnMarker = null;
    }
  }

  _clearTurnMarker() {
    if (!this.turnMarker) return;
    canvas.tokens.turnMarkers.delete(this);
    this.turnMarker.destroy();
    this.turnMarker = null;
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
  _onDragLeftDrop(event) {
    if (!event.interactionData.dropped && this._shouldPreventDragLeftDrop(event)) {
      event.interactionData.released = true;
      event.preventDefault();
      return;
    }
    if (isAbilityRoutePlanningInteractive(this) && event.interactionData.dropped) {
      const context = event.interactionData.contexts?.[this.document.id];
      if (context?.searching || !Array.isArray(context?.foundPath) || context.foundPath.length <= 1) {
        // Keep waypoint mode alive instead of silently cancelling the draft.
        event.interactionData.dropped = false;
        event.interactionData.released = true;
        event.preventDefault();
        ui?.notifications?.warn?.("Укажите точку назначения маршрута.");
        return;
      }
    }
    event.interactionData.dropped = true;
    const { clones } = event.interactionData;
    if (!clones) return false;

    let result = this._prepareDragLeftDropUpdates(event);
    if (!result) return;
    if (!Array.isArray(result[0])) result = [result];
    const [updates, options = {}] = result;
    const orchestrations = options[GRAPPLE_FOLLOW_ORCHESTRATION_OPTION];
    const routePlanCommitter = getAbilityRoutePlanCommitter(this);

    event.interactionData.clearPreviewContainer = false;
    if (routePlanCommitter) {
      void Promise.resolve(routePlanCommitter({ token: this, updates, options }))
        .then(committed => {
          if (committed) return;
          ui?.notifications?.warn?.("Не удалось сохранить маршрут. Попробуйте построить его снова.");
          if (this.layer._movementPlanningContext?.object === this) {
            this.layer._movementPlanningContext.result = null;
          }
        })
        .catch(error => {
          console.warn("fallout-maw | Ability route plan commit failed", error);
          ui?.notifications?.warn?.("Не удалось сохранить маршрут. Попробуйте построить его снова.");
          if (this.layer._movementPlanningContext?.object === this) {
            this.layer._movementPlanningContext.result = null;
          }
        })
        .finally(() => this.layer.clearPreviewContainer());
      return;
    }
    if (!game.user?.isGM && orchestrations?.length) {
      void commitGrappleFollowOrchestrations(orchestrations).finally(() => {
        this.layer.clearPreviewContainer();
      });
      return;
    }

    canvas.scene.updateEmbeddedDocuments("Token", updates, options).finally(() => {
      this.layer.clearPreviewContainer();
    });
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

export function buildEffectTooltipHTML(effect, actor = null) {
  const name = localizeDocumentName(effect.name);
  const changes = getEffectChanges(effect).map(change => formatEffectChange(change, actor, effect)).filter(Boolean);
  const triggerCosts = getEffectTriggerCostRows(effect, actor);
  const triggerCostLines = formatEffectTriggerCostRows(triggerCosts);
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
      ${triggerCostLines.length ? `<section class="changes trigger-costs">
        <h4>${escapeHTML(localize("FALLOUTMAW.Ability.TriggerCost.Costs"))}</h4>
        <ol>${triggerCostLines.map(line => `<li>${line}</li>`).join("")}</ol>
      </section>` : ""}
      ${changes.length ? `<section class="changes">
        <h4>${escapeHTML(localize("FALLOUTMAW.Effects.Changes"))}</h4>
        <ol>${changes.map(change => `<li>${change}</li>`).join("")}</ol>
      </section>` : ""}
    </article>
  `;
}

function getEffectTriggerCostRows(effect, actor = null) {
  const systemFlags = effect?.flags?.[SYSTEM_ID] ?? {};
  const auraCosts = systemFlags?.auraGenerated?.triggerCost?.costs;
  if (Array.isArray(auraCosts) || (auraCosts && typeof auraCosts === "object")) {
    return normalizeTooltipTriggerCostRows(auraCosts);
  }

  const sourceItem = resolveEffectSourceItem(effect, actor, systemFlags);
  if (!sourceItem) return [];
  const functions = getEffectSourceFunctions(sourceItem)
    .filter(abilityFunction => abilityFunction.type === ABILITY_FUNCTION_TYPES.effectChanges)
    .filter(abilityFunction => getAbilityFunctionTriggerCostRows(abilityFunction).length > 0);
  if (!functions.length) return [];

  const functionIds = getEffectSourceFunctionIds(systemFlags);
  const effectChangeKeys = new Set(getEffectChanges(effect).map(change => String(change?.key ?? "").trim()).filter(Boolean));
  const applicable = functionIds.size
    ? functions.filter(abilityFunction => functionIds.has(String(abilityFunction.id ?? "")))
    : functions.filter(abilityFunction => abilityFunctionMatchesEffectChanges(abilityFunction, effectChangeKeys));
  return applicable.flatMap(abilityFunction => getAbilityFunctionTriggerCostRows(abilityFunction));
}

function resolveEffectSourceItem(effect, actor = null, systemFlags = {}) {
  const uuidCandidates = [
    systemFlags?.eventReaction?.sourceItemUuid,
    systemFlags?.abilityTimedTriggerEffect?.sourceItemUuid,
    systemFlags?.auraGenerated?.triggerCost?.sourceItemUuid,
    effect?.origin
  ];
  for (const uuid of uuidCandidates) {
    const item = resolveItemUuidSync(uuid);
    if (item) return item;
  }

  const itemIds = [
    systemFlags?.abilityEffect?.abilityItemId,
    systemFlags?.itemEffect?.itemId,
    systemFlags?.abilityItemUseEffect?.abilityItemId,
    systemFlags?.abilityTimedTriggerEffect?.sourceItemId,
    systemFlags?.activeApplication?.abilityItemId
  ].map(value => String(value ?? "").trim()).filter(Boolean);
  const sourceActors = [actor, effect?.parent, activeEffectTooltipToken?.actor].filter(Boolean);
  for (const sourceActor of sourceActors) {
    for (const itemId of itemIds) {
      const item = sourceActor?.items?.get?.(itemId)
        ?? Array.from(sourceActor?.items ?? []).find(entry => String(entry?.id ?? "") === itemId);
      if (item) return item;
    }
  }
  return null;
}

function resolveItemUuidSync(uuid = "") {
  const value = String(uuid ?? "").trim();
  if (!value) return null;
  try {
    const document = globalThis.fromUuidSync?.(value) ?? foundry.utils.fromUuidSync?.(value) ?? null;
    return document?.documentName === "Item" || document?.constructor?.metadata?.name === "Item" ? document : null;
  } catch (_error) {
    return null;
  }
}

function getEffectSourceFunctions(sourceItem = null) {
  const functions = sourceItem?.type === "ability"
    ? sourceItem.system?.functions ?? []
    : sourceItem?.type === "gear"
      ? sourceItem.system?.functions?.freeSettings?.entries ?? []
      : [];
  return normalizeAbilityFunctions(functions);
}

function getEffectSourceFunctionIds(systemFlags = {}) {
  return new Set([
    systemFlags?.eventReaction?.functionId,
    systemFlags?.abilityTimedTriggerEffect?.functionId,
    systemFlags?.abilityItemUseEffect?.functionId,
    systemFlags?.activeApplication?.functionId,
    systemFlags?.auraGenerated?.functionId
  ].map(value => String(value ?? "").trim()).filter(Boolean));
}

function abilityFunctionMatchesEffectChanges(abilityFunction = {}, effectChangeKeys = new Set()) {
  if (!effectChangeKeys.size) return false;
  return [...(abilityFunction?.changes ?? []), ...(abilityFunction?.penalties ?? [])]
    .some(change => effectChangeKeys.has(String(change?.key ?? "").trim()));
}

function normalizeTooltipTriggerCostRows(value = []) {
  return (Array.isArray(value) ? value : Object.values(value ?? {})).map((row, index) => ({
    id: String(row?.id ?? `cost-${index + 1}`),
    resourceKey: String(row?.resourceKey ?? "").trim(),
    formula: String(row?.formula ?? "0").trim() || "0",
    overloadAmount: Math.max(0, Math.trunc(Number(row?.overloadAmount) || 0)),
    overloadDurationSeconds: Math.max(0, Math.trunc(Number(row?.overloadDurationSeconds) || 0))
  })).filter(row => row.resourceKey);
}

function formatEffectTriggerCostRows(costs = []) {
  const resourceLabels = new Map(getResourceSettings().map(resource => [
    String(resource?.key ?? ""),
    String(resource?.label ?? resource?.key ?? "")
  ]));
  resourceLabels.set("reactionPoints", localize("FALLOUTMAW.Events.Reaction.Resources.ReactionPoints"));
  const overloadLabel = localize("FALLOUTMAW.Ability.TriggerCost.Overload");
  const lines = [];
  for (const cost of normalizeTooltipTriggerCostRows(costs)) {
    const resourceLabel = resourceLabels.get(cost.resourceKey) ?? cost.resourceKey;
    lines.push(`<strong>${escapeHTML(resourceLabel)}:</strong><span>${escapeHTML(cost.formula)}</span>`);
    if (cost.overloadAmount > 0 && cost.overloadDurationSeconds > 0) {
      lines.push(`<strong>${escapeHTML(`${overloadLabel}: ${resourceLabel}`)}:</strong><span>${escapeHTML(`+${cost.overloadAmount}, ${formatDurationShort(cost.overloadDurationSeconds)}`)}</span>`);
    }
  }
  return lines;
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
  const damageEffect = formatDamageEffectChange(change, actor);
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

function formatDamageEffectChange(change, actor = null) {
  const data = parseDamageEffectChange(change);
  if (!data) return "";

  const kind = String(data.kind ?? "");
  if (kind === "bleedingDamage") {
    const label = getDamageTypeLabel(BLEEDING_DAMAGE_TYPE_KEY);
    return `<strong>${escapeHTML(formatDamageEffectLabel(label, data.limbKey, actor))}:</strong><span>${escapeHTML(formatTickDamage(data))}</span>`;
  }
  if (kind === "periodicDamage") {
    const label = getDamageTypeLabel(data.damageTypeKey) || String(data.damageTypeKey ?? "");
    return `<strong>${escapeHTML(formatDamageEffectLabel(label, data.limbKey, actor))}:</strong><span>${escapeHTML(formatPeriodicDamage(data))}</span>`;
  }
  if (kind === "limbLoss") {
    return `<strong>${escapeHTML(localize("FALLOUTMAW.Effects.LimbLoss"))}:</strong><span>${escapeHTML(getLimbLabel(data.limbKey, actor))}</span>`;
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

function formatDamageEffectLabel(label, limbKey, actor = null) {
  const limbLabel = getLimbLabel(limbKey, actor);
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

function getLimbLabel(key, actor = null) {
  const limbKey = String(key ?? "").trim();
  if (!limbKey) return "";
  const sourceActor = actor ?? activeEffectTooltipToken?.actor;
  return String(sourceActor?.system?.limbs?.[limbKey]?.label || limbKey);
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
