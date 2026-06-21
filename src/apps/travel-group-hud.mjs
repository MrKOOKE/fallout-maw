import { FALLOUT_MAW } from "../config/system-config.mjs";
import { TEMPLATES } from "../constants.mjs";
import { REACTION_RESOURCE_KEY } from "../combat/reaction-resources.mjs";
import { getActorNeedSettings, getResourceSettings } from "../settings/accessors.mjs";
import { TOKEN_ACTION_HUD_ENABLED_SETTING } from "../settings/constants.mjs";
import { FALLBACK_ICON, prepareIndicatorEntry } from "../utils/actor-display-data.mjs";
import {
  getTravelGroupData,
  getTravelGroupUnits,
  getTravelUnitPassengers,
  isTravelGroupCarrierActor,
  isTravelVehicleUnit,
  resolveTravelGroupUnitActor,
  resolveTravelPassengerActor
} from "../global-map/travel-group-data.mjs";
import { evaluateTravelSpeed } from "../global-map/travel-speed.mjs";
import {
  armTravelMovement,
  disarmTravelMovement,
  isTravelMovementArmed
} from "../global-map/travel-movement.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
let travelGroupHud = null;
let refreshHud = null;
let hooksRegistered = false;

export function registerTravelGroupHudHooks() {
  if (hooksRegistered) return;
  Hooks.on("controlToken", scheduleTravelGroupHudSync);
  Hooks.on("canvasReady", scheduleTravelGroupHudSync);
  Hooks.on("canvasTearDown", closeTravelGroupHud);
  Hooks.on("updateActor", scheduleOpenTravelGroupHudRender);
  Hooks.on("updateSetting", setting => {
    if (!String(setting?.key ?? "").startsWith(`${FALLOUT_MAW.id}.`)) return;
    if (setting.key === `${FALLOUT_MAW.id}.${TOKEN_ACTION_HUD_ENABLED_SETTING}`) scheduleTravelGroupHudSync();
    else scheduleOpenTravelGroupHudRender();
  });
  Hooks.on("falloutMaWTravelMovementState", scheduleOpenTravelGroupHudRender);
  window.addEventListener("resize", scheduleOpenTravelGroupHudRender);
  refreshHud = foundry.utils.debounce(syncTravelGroupHud, 60);
  hooksRegistered = true;
}

export function syncTravelGroupHud() {
  if (!game.ready || !canvas?.ready || !isHudEnabled()) return closeTravelGroupHud();
  const token = getSelectedTravelToken();
  if (!token) return closeTravelGroupHud();
  travelGroupHud ??= new TravelGroupHud();
  travelGroupHud.setToken(token);
  void travelGroupHud.render({ force: true });
}

function scheduleTravelGroupHudSync() {
  refreshHud?.();
}

function scheduleOpenTravelGroupHudRender() {
  if (travelGroupHud?.rendered) void travelGroupHud.render({ force: true });
}

function closeTravelGroupHud() {
  if (!travelGroupHud) return;
  const hud = travelGroupHud;
  travelGroupHud = null;
  void hud.close({ animate: false });
}

function getSelectedTravelToken() {
  return (canvas?.tokens?.controlled ?? []).find(token => (
    token?.actor?.testUserPermission?.(game.user, "LIMITED") && isTravelGroupCarrierActor(token.actor)
  )) ?? null;
}

function isHudEnabled() {
  try {
    return game.settings.get(FALLOUT_MAW.id, TOKEN_ACTION_HUD_ENABLED_SETTING) !== false;
  } catch (_error) {
    return true;
  }
}

class TravelGroupHud extends HandlebarsApplicationMixin(ApplicationV2) {
  #token = null;
  #openGroupId = "";
  #keyHandler = event => {
    if (event.key !== "Escape" || !isTravelMovementArmed(this.#token)) return;
    event.preventDefault();
    void disarmTravelMovement();
  };

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-travel-group-hud",
    classes: ["fallout-maw", "fallout-maw-travel-group-hud"],
    tag: "aside",
    window: { frame: false, positioned: false },
    actions: {
      toggleGroup: TravelGroupHud.#onToggleGroup,
      toggleMovement: TravelGroupHud.#onToggleMovement
    }
  };

  static PARTS = {
    hud: { root: true, template: TEMPLATES.travelGroupHud }
  };

  setToken(token) {
    if (this.#token?.id && this.#token.id !== token?.id) {
      this.#openGroupId = "";
      if (isTravelMovementArmed(this.#token)) void disarmTravelMovement();
    }
    this.#token = token;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const actor = this.#token?.actor;
    const group = getTravelGroupData(actor) ?? {};
    const vehicles = [];
    const walkers = [];
    for (const unit of getTravelGroupUnits(actor)) {
      const unitActor = await resolveTravelGroupUnitActor(unit);
      const speedKmh = evaluateTravelSpeed(unitActor, unit.travelFormulaData, {
        fallback: unit.speedKmh || group.effectiveSpeedKmh
      });
      if (isTravelVehicleUnit(unit, unitActor)) {
        const passengers = getTravelUnitPassengers(unit, unitActor);
        vehicles.push({
          id: unit.id,
          name: unit.actorName || unitActor?.name || unit.tokenData?.name || "Транспорт",
          img: unit.actorImg || unitActor?.img || unit.tokenData?.texture?.src || FALLBACK_ICON,
          count: passengers.length,
          countLabel: participantCountLabel(passengers.length),
          speedKmh,
          speedLabel: formatSpeed(speedKmh),
          members: await Promise.all(passengers.map(preparePassengerMember)),
          empty: passengers.length === 0
        });
      } else {
        walkers.push({
          speedKmh,
          member: prepareMember(unitActor, {
            name: unit.actorName || unitActor?.name || unit.tokenData?.name || "Участник путешествия",
            img: unit.actorImg || unitActor?.img || unit.tokenData?.texture?.src || FALLBACK_ICON,
            missing: !unitActor
          })
        });
      }
    }
    const footSpeed = walkers.length ? Math.min(...walkers.map(entry => entry.speedKmh)) : 0;
    const blocks = vehicles.map(vehicle => prepareBlock(vehicle, this.#openGroupId));
    if (walkers.length) {
      blocks.push(prepareBlock({
        id: "walkers",
        name: "Пешая группа",
        img: actor?.img || FALLBACK_ICON,
        count: walkers.length,
        countLabel: participantCountLabel(walkers.length),
        speedLabel: formatSpeed(footSpeed),
        members: walkers.map(entry => entry.member),
        empty: false,
        walkers: true
      }, this.#openGroupId));
    }
    const speeds = [...vehicles.map(vehicle => vehicle.speedKmh), ...(walkers.length ? [footSpeed] : [])]
      .filter(speed => Number.isFinite(speed));
    const groupSpeed = speeds.length ? Math.min(...speeds) : Math.max(0, Number(group.effectiveSpeedKmh) || 0);
    return {
      ...context,
      actor,
      blocks,
      empty: blocks.length === 0,
      movementArmed: isTravelMovementArmed(this.#token),
      groupSpeedLabel: formatSpeed(groupSpeed),
      fallbackIcon: FALLBACK_ICON
    };
  }

  _attachFrameListeners() {
    super._attachFrameListeners();
    window.removeEventListener("keydown", this.#keyHandler);
    window.addEventListener("keydown", this.#keyHandler);
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    requestAnimationFrame(() => positionMemberPanel(this.element));
  }

  async _onClose(options) {
    window.removeEventListener("keydown", this.#keyHandler);
    if (isTravelMovementArmed(this.#token)) await disarmTravelMovement();
    await super._onClose(options);
  }

  static #onToggleGroup(event, target) {
    event.preventDefault();
    const id = String(target.dataset.groupId ?? "");
    this.#openGroupId = this.#openGroupId === id ? "" : id;
    return this.render({ force: true });
  }

  static async #onToggleMovement(event) {
    event.preventDefault();
    if (isTravelMovementArmed(this.#token)) return undefined;
    const planning = this.#token.planMovement();
    if (!this.#token.startMovementPlanningDrag()) {
      this.#token.layer?._cancelMovementPlanning?.();
      return undefined;
    }
    const armed = await armTravelMovement(this.#token);
    if (!armed) {
      this.#token.layer?._cancelMovementPlanning?.();
      return undefined;
    }
    const plan = await planning;
    if (!plan) {
      await disarmTravelMovement();
      return undefined;
    }
    await this.#token.document.startMovement(plan.id);
    return undefined;
  }
}

function prepareBlock(block, openGroupId) {
  return { ...block, open: block.id === openGroupId };
}

async function preparePassengerMember(passenger) {
  const actor = await resolveTravelPassengerActor(passenger);
  return prepareMember(actor, {
    name: passenger.actorName || actor?.name || "Недоступный участник",
    img: passenger.actorImg || actor?.img || FALLBACK_ICON,
    missing: !actor
  });
}

function prepareMember(actor, fallback = {}) {
  if (!actor) return { ...fallback, meters: [] };
  const resources = getResourceSettings()
    .filter(resource => resource.key !== REACTION_RESOURCE_KEY)
    .map(resource => prepareIndicatorEntry({ ...resource, data: actor.system?.resources?.[resource.key] }));
  const needs = getActorNeedSettings(actor)
    .map(need => prepareIndicatorEntry({ ...need, data: actor.system?.needs?.[need.key] }));
  return {
    name: actor.name || fallback.name,
    img: actor.img || fallback.img,
    missing: false,
    meters: [...resources, ...needs]
  };
}

function formatSpeed(value) {
  const speed = Math.max(0, Number(value) || 0);
  return `${Number.isInteger(speed) ? speed : speed.toFixed(1)} км/ч`;
}

function participantCountLabel(count) {
  const value = Math.max(0, Number(count) || 0);
  return `${value} участн.`;
}

function positionMemberPanel(element) {
  const panel = element?.querySelector?.("[data-travel-member-panel]");
  if (!panel) return;
  panel.style.transform = "";
  const rect = panel.getBoundingClientRect();
  const overflowRight = rect.right - (window.innerWidth - 12);
  if (overflowRight <= 0) return;
  const scale = Math.max(0.01, Number(getComputedStyle(document.documentElement)
    .getPropertyValue("--fallout-maw-token-action-hud-scale")) || 1) * 1.5;
  panel.style.transform = `translateX(${-Math.ceil(overflowRight / scale)}px)`;
}
