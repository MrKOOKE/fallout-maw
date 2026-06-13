import { TEMPLATES } from "../constants.mjs";
import {
  cancelWorldTrapPlacement,
  getWorldTrapPlacementState,
  startWorldTrapPlacement
} from "../canvas/traps.mjs";
import { getFactionSettings } from "../settings/factions.mjs";
import { ITEM_FUNCTIONS, hasItemFunction } from "../utils/item-functions.mjs";
import { normalizeImagePath } from "../utils/actor-display-data.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const CONTROL_ID = "fallout-maw-trap-placement-control";
let hooksRegistered = false;

export function registerTrapPlacementControlHooks() {
  if (hooksRegistered) return;
  Hooks.on("renderSceneControls", injectTrapPlacementControlButton);
  Hooks.on("createItem", rerenderTrapPlacementControl);
  Hooks.on("updateItem", rerenderTrapPlacementControl);
  Hooks.on("deleteItem", rerenderTrapPlacementControl);
  hooksRegistered = true;
}

function injectTrapPlacementControlButton(_app, element) {
  if (!game.user?.isGM) return;
  const root = element instanceof HTMLElement ? element : element?.[0];
  const menu = root?.matches?.("#scene-controls-layers")
    ? root
    : root?.querySelector("#scene-controls-layers");
  if (!menu || menu.querySelector("[data-fallout-maw-trap-placement-control]")) return;

  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "control ui-control layer icon fa-solid fa-bomb fallout-maw-trap-placement-main-control";
  button.dataset.falloutMawTrapPlacementControl = "true";
  button.dataset.tooltip = "";
  button.setAttribute("aria-label", game.i18n.localize("FALLOUTMAW.TrapPlacement.Title"));
  button.setAttribute("aria-pressed", "false");
  button.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    toggleTrapPlacementControl();
    updateTrapPlacementControlButtonState();
  });
  item.append(button);

  const animationItem = menu.querySelector("[data-fallout-maw-animation-library]")?.closest("li");
  if (animationItem?.nextSibling) animationItem.parentElement.insertBefore(item, animationItem.nextSibling);
  else menu.append(item);
  updateTrapPlacementControlButtonState();
}

function toggleTrapPlacementControl() {
  const existing = foundry.applications.instances.get(CONTROL_ID);
  if (existing) return existing.close();
  return new TrapPlacementControl().render({ force: true });
}

function rerenderTrapPlacementControl(item = null) {
  if (item?.actor || item?.pack) return;
  const app = foundry.applications.instances.get(CONTROL_ID);
  if (app?.rendered) void app.render({ force: true });
}

function updateTrapPlacementControlButtonState() {
  const button = document.querySelector("[data-fallout-maw-trap-placement-control]");
  if (!button) return;
  const active = Boolean(foundry.applications.instances.get(CONTROL_ID)?.rendered);
  button.classList.toggle("active", active);
  button.setAttribute("aria-pressed", String(active));
}

class TrapPlacementControl extends HandlebarsApplicationMixin(ApplicationV2) {
  #factionName = "";

  static DEFAULT_OPTIONS = {
    id: CONTROL_ID,
    classes: ["fallout-maw", "fallout-maw-trap-placement-control"],
    position: {
      width: 430,
      height: "auto"
    },
    window: {
      resizable: false
    },
    actions: {
      placeTrap: this.#onPlaceTrap
    }
  };

  static PARTS = {
    body: {
      template: TEMPLATES.trapPlacementControl
    }
  };

  get title() {
    return game.i18n.localize("FALLOUTMAW.TrapPlacement.Title");
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const activePlacement = getWorldTrapPlacementState();
    const trapItems = (game.items?.contents ?? [])
      .filter(item => !item.actor && hasItemFunction(item, ITEM_FUNCTIONS.trap, { ignoreBroken: true }))
      .sort((left, right) => left.name.localeCompare(right.name, game.i18n.lang))
      .map(item => ({
        id: item.id,
        name: item.name,
        img: normalizeImagePath(item.img, "icons/svg/hazard.svg"),
        placing: activePlacement?.itemId === item.id
      }));
    return {
      ...context,
      factionOptions: buildFactionOptions(this.#factionName),
      trapItems,
      hasTrapItems: trapItems.length > 0
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    if (this.element) {
      this.element.style.zIndex = getWorldTrapPlacementState() ? "100001" : "";
    }
    this.element?.querySelector("[data-trap-placement-faction]")?.addEventListener("change", event => {
      this.#factionName = String(event.currentTarget?.value ?? "").trim();
    });
    this.#positionNearControl();
    updateTrapPlacementControlButtonState();
  }

  _onClose(options) {
    super._onClose(options);
    updateTrapPlacementControlButtonState();
  }

  static async #onPlaceTrap(event, target) {
    event.preventDefault();
    const itemId = String(target.dataset.itemId ?? "");
    if (getWorldTrapPlacementState()?.itemId === itemId) {
      cancelWorldTrapPlacement({ notify: true, refreshApplication: false });
      await this.render({ force: true });
      return true;
    }
    const item = game.items?.get(itemId);
    if (!item) return undefined;
    const started = await startWorldTrapPlacement({
      item,
      factionName: this.#factionName,
      application: this
    });
    if (started) await this.render({ force: true });
    return started;
  }

  #positionNearControl() {
    const button = document.querySelector("[data-fallout-maw-trap-placement-control]");
    if (!button || !this.element) return;
    const rect = button.getBoundingClientRect();
    this.setPosition({
      left: Math.round(rect.right + 8),
      top: Math.round(rect.top)
    });
  }
}

function buildFactionOptions(selectedFaction = "") {
  return [
    { value: "", label: game.i18n.localize("FALLOUTMAW.TrapPlacement.NoFaction") },
    ...getFactionSettings().map(name => ({ value: name, label: name }))
  ].map(option => ({
    ...option,
    selected: option.value === selectedFaction
  }));
}
