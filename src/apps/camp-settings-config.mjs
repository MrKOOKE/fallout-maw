import { TEMPLATES } from "../constants.mjs";
import {
  getCampSettings,
  getNeedSettings,
  setCampSettings
} from "../settings/accessors.mjs";
import {
  createDefaultCampSettings,
  normalizeCampRestPlaceEffects,
  normalizeCampSettings
} from "../settings/camp.mjs";
import { FalloutMaWFormApplicationV2 } from "./base-form-application-v2.mjs";

export class CampSettingsConfig extends FalloutMaWFormApplicationV2 {
  constructor(options = {}) {
    super(options);
    this.settings = getCampSettings();
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-camp-settings",
    classes: ["fallout-maw", "fallout-maw-config-form", "fallout-maw-camp-settings"],
    position: {
      width: 820,
      height: "auto"
    },
    window: {
      resizable: true
    },
    actions: {
      addRestPlace: this.#onAddRestPlace,
      deleteRestPlace: this.#onDeleteRestPlace,
      openPlaceSettings: this.#onOpenPlaceSettings,
      resetDefaults: this.#onResetDefaults
    }
  };

  static PARTS = {
    form: {
      template: TEMPLATES.settings.camp
    }
  };

  get title() {
    return "Лагерь";
  }

  async _prepareContext(options) {
    return {
      ...(await super._prepareContext(options)),
      restPlaces: this.settings.restPlaces
    };
  }

  async _processFormData(_event, _form, _formData) {
    this.settings = normalizeCampSettings(this.#readSettingsFromForm());
    await setCampSettings(this.settings);
    ui.notifications.info("Настройки лагеря сохранены.");
    return this.forceRender();
  }

  static async #onAddRestPlace(event) {
    event.preventDefault();
    this.settings = this.#readSettingsFromForm();
    const id = getUniqueRestPlaceId(this.settings.restPlaces, "restPlace");
    this.settings.restPlaces.push({
      id,
      label: "Новое место",
      effects: []
    });
    return this.forceRender();
  }

  static async #onDeleteRestPlace(event, target) {
    event.preventDefault();
    this.settings = this.#readSettingsFromForm();
    const index = getRestPlaceRowIndex(this.form, target);
    if (index < 0) return undefined;
    this.settings.restPlaces.splice(index, 1);
    if (!this.settings.restPlaces.length) this.settings = createDefaultCampSettings();
    return this.forceRender();
  }

  static async #onOpenPlaceSettings(event, target) {
    event.preventDefault();
    this.settings = this.#readSettingsFromForm();
    const index = getRestPlaceRowIndex(this.form, target);
    const place = this.settings.restPlaces[index];
    if (!place) return undefined;
    return new CampPlaceSettingsConfig({
      place,
      submit: effects => {
        const active = this.#readSettingsFromForm();
        if (!active.restPlaces[index]) return;
        active.restPlaces[index].effects = effects;
        this.settings = normalizeCampSettings(active);
        this.forceRender();
      }
    }).render({ force: true });
  }

  static async #onResetDefaults(event) {
    event.preventDefault();
    this.settings = createDefaultCampSettings();
    return this.forceRender();
  }

  #readSettingsFromForm() {
    const rows = Array.from(this.form?.querySelectorAll("[data-camp-rest-place-row]") ?? []);
    const currentById = new Map((this.settings?.restPlaces ?? []).map(place => [place.id, place]));
    return normalizeCampSettings({
      restPlaces: rows.map((row, index) => {
        const previous = currentById.get(row.dataset.placeId) ?? this.settings?.restPlaces?.[index] ?? {};
        return {
          id: row.querySelector("[data-field='id']")?.value?.trim() ?? "",
          label: row.querySelector("[data-field='label']")?.value?.trim() ?? "",
          effects: previous.effects ?? []
        };
      })
    });
  }
}

class CampPlaceSettingsConfig extends FalloutMaWFormApplicationV2 {
  constructor({ place, submit } = {}, options = {}) {
    super(options);
    this.place = foundry.utils.deepClone(place ?? {});
    this.submit = submit;
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-camp-place-settings",
    classes: ["fallout-maw", "fallout-maw-config-form", "fallout-maw-camp-place-settings"],
    position: {
      width: 620,
      height: "auto"
    },
    window: {
      resizable: true
    },
    actions: {
      addEffect: this.#onAddEffect,
      deleteEffect: this.#onDeleteEffect
    }
  };

  static PARTS = {
    form: {
      template: TEMPLATES.settings.campPlace
    }
  };

  get title() {
    return `${this.place?.label || "Место отдыха"}: настройки`;
  }

  async _prepareContext(options) {
    return {
      ...(await super._prepareContext(options)),
      place: this.place,
      effects: normalizeCampRestPlaceEffects(this.place.effects),
      needOptions: getNeedSettings().map(need => ({
        value: need.key,
        label: need.label || need.key
      }))
    };
  }

  async _processFormData(_event, _form, _formData) {
    const effects = this.#readEffectsFromForm();
    this.submit?.(effects);
    return this.close();
  }

  static async #onAddEffect(event) {
    event.preventDefault();
    this.place.effects = this.#readEffectsFromForm();
    this.place.effects.push({
      needKey: getNeedSettings()[0]?.key ?? "sleepiness",
      perHour: 0
    });
    return this.forceRender();
  }

  static async #onDeleteEffect(event, target) {
    event.preventDefault();
    this.place.effects = this.#readEffectsFromForm();
    const rows = Array.from(this.form?.querySelectorAll("[data-camp-place-effect-row]") ?? []);
    const row = target.closest("[data-camp-place-effect-row]");
    const index = rows.indexOf(row);
    if (index >= 0) this.place.effects.splice(index, 1);
    return this.forceRender();
  }

  #readEffectsFromForm() {
    const rows = Array.from(this.form?.querySelectorAll("[data-camp-place-effect-row]") ?? []);
    return normalizeCampRestPlaceEffects(rows.map(row => ({
      needKey: row.querySelector("[data-field='needKey']")?.value ?? "",
      perHour: row.querySelector("[data-field='perHour']")?.value ?? 0
    })));
  }
}

function getRestPlaceRowIndex(form, target) {
  const rows = Array.from(form?.querySelectorAll("[data-camp-rest-place-row]") ?? []);
  const row = target.closest("[data-camp-rest-place-row]");
  return rows.indexOf(row);
}

function getUniqueRestPlaceId(restPlaces = [], base = "restPlace") {
  const used = new Set(restPlaces.map(place => place.id));
  let index = restPlaces.length + 1;
  let id = `${base}${index}`;
  while (used.has(id)) id = `${base}${index += 1}`;
  return id;
}
