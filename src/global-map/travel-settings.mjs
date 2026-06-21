import { FalloutMaWFormApplicationV2, getExpandedFormData } from "../apps/base-form-application-v2.mjs";
import { FALLOUT_MAW } from "../config/system-config.mjs";
import {
  GLOBAL_MAP_TRAVEL_IMAGE_SETTING,
  TRAVEL_GROUP_FLAG,
  TRAVEL_GROUP_IMAGE_DEFAULT,
  TRAVEL_GROUP_TOKEN_FLAG
} from "./constants.mjs";
import { queueGlobalMapApplicationPosition } from "./window-position.mjs";

const TEMPLATE = `systems/${FALLOUT_MAW.id}/templates/global-map/travel-settings.hbs`;

export class GlobalMapTravelSettings extends FalloutMaWFormApplicationV2 {
  #initialPositionApplied = false;

  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    id: "fallout-maw-global-map-travel-settings",
    classes: [...super.DEFAULT_OPTIONS.classes, "standard-form", "fallout-maw-global-map-editor"],
    position: { width: 520, height: "auto" },
    window: { title: "Путешествие", resizable: false },
    form: {
      handler: GlobalMapTravelSettings.handleFormSubmit,
      submitOnChange: false,
      closeOnSubmit: true
    }
  };

  static PARTS = {
    form: { template: TEMPLATE }
  };

  async _prepareContext() {
    return { image: getTravelGroupImage() };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    if (this.#initialPositionApplied) return;
    this.#initialPositionApplied = true;
    queueGlobalMapApplicationPosition(this);
  }

  async _processFormData(_event, _form, formData) {
    const values = getExpandedFormData(formData);
    const image = String(values.image ?? "").trim() || TRAVEL_GROUP_IMAGE_DEFAULT;
    await game.settings.set(FALLOUT_MAW.id, GLOBAL_MAP_TRAVEL_IMAGE_SETTING, image);
  }
}

export function getTravelGroupImage() {
  return String(game.settings.get(FALLOUT_MAW.id, GLOBAL_MAP_TRAVEL_IMAGE_SETTING) ?? "").trim()
    || TRAVEL_GROUP_IMAGE_DEFAULT;
}

export async function syncTravelGroupImages(image = getTravelGroupImage()) {
  if (game.users?.activeGM?.id !== game.user?.id) return;
  const normalized = String(image ?? "").trim() || TRAVEL_GROUP_IMAGE_DEFAULT;
  const actors = (game.actors?.contents ?? []).filter(actor => actor.getFlag(FALLOUT_MAW.id, TRAVEL_GROUP_FLAG)?.groupId);
  for (const actor of actors) {
    const update = {
      img: normalized,
      "prototypeToken.texture.src": normalized
    };
    await actor.update(update, { falloutMaWTravelGroupBypass: true });
  }
  for (const scene of game.scenes?.contents ?? []) {
    const updates = (scene.tokens?.contents ?? [])
      .filter(token => token.getFlag(FALLOUT_MAW.id, TRAVEL_GROUP_TOKEN_FLAG)?.groupId)
      .map(token => ({ _id: token.id, "texture.src": normalized }));
    if (updates.length) await scene.updateEmbeddedDocuments("Token", updates);
  }
}
