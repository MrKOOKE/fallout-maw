import { FalloutMaWFormApplicationV2 } from "../apps/base-form-application-v2.mjs";
import { FALLOUT_MAW } from "../config/system-config.mjs";
import { getTokenPrototypeDefaultForActorType } from "../settings/token-prototype-defaults.mjs";
import { TRAVEL_GROUP_IMAGE_DEFAULT } from "./constants.mjs";
import { queueGlobalMapApplicationPosition } from "./window-position.mjs";

const TEMPLATE = `systems/${FALLOUT_MAW.id}/templates/global-map/travel-settings.hbs`;

export class GlobalMapTravelSettings extends FalloutMaWFormApplicationV2 {
  #initialPositionApplied = false;

  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    id: "fallout-maw-global-map-travel-settings",
    classes: [...super.DEFAULT_OPTIONS.classes, "standard-form", "fallout-maw-global-map-editor"],
    position: { width: 420, height: "auto" },
    window: { title: "Путешествие", resizable: false }
  };

  static PARTS = {
    form: { template: TEMPLATE }
  };

  async _prepareContext() {
    return {};
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    if (this.#initialPositionApplied) return;
    this.#initialPositionApplied = true;
    queueGlobalMapApplicationPosition(this);
  }

  async _processFormData() {}
}

export function getTravelGroupPrototypeToken() {
  return getTokenPrototypeDefaultForActorType("group");
}

export function getTravelGroupImage() {
  return String(getTravelGroupPrototypeToken()?.texture?.src ?? "").trim()
    || TRAVEL_GROUP_IMAGE_DEFAULT;
}
