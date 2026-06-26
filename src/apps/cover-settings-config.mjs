import { TEMPLATES } from "../constants.mjs";
import { buildEffectKeyTokens } from "../utils/effect-key-tokens.mjs";
import { activateEffectKeyAutocomplete } from "./effect-key-autocomplete.mjs";
import { activateFormulaAutocomplete } from "./formula-autocomplete.mjs";
import {
  getCoverSettings,
  getCharacteristicSettings,
  resetCoverSettings,
  setCoverSettings,
  getSkillSettings
} from "../settings/accessors.mjs";
import {
  createBlankCoverEntry,
  getCoverChangeTypeChoices,
  normalizeCoverSettings
} from "../settings/cover.mjs";
import { FalloutMaWFormApplicationV2, getExpandedFormData } from "./base-form-application-v2.mjs";

const { FormDataExtended } = foundry.applications.ux;

export class CoverSettingsConfig extends FalloutMaWFormApplicationV2 {
  constructor(options = {}) {
    super(options);
    this.settings = getCoverSettings();
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-cover-settings",
    classes: ["fallout-maw", "fallout-maw-config-form", "fallout-maw-cover-settings"],
    position: {
      width: 980,
      height: "auto"
    },
    window: {
      resizable: true
    },
    form: {
      closeOnSubmit: true
    },
    actions: {
      addCoverEntry: this.#onAddCoverEntry,
      deleteCoverEntry: this.#onDeleteCoverEntry,
      browseCoverImage: this.#onBrowseCoverImage,
      resetDefaults: this.#onResetDefaults
    }
  };

  static PARTS = {
    form: {
      template: TEMPLATES.settings.cover
    }
  };

  get title() {
    return "Укрытия";
  }

  async _prepareContext(options) {
    return {
      ...(await super._prepareContext(options)),
      entries: this.settings.entries.map((entry, index) => ({
        ...entry,
        index,
        change: {
          ...entry.change,
          typeChoices: getCoverChangeTypeChoices(entry.change?.type)
        }
      }))
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    activateEffectKeyAutocomplete(this.element, buildEffectKeyTokens());
    activateFormulaAutocomplete(this.element, {
      characteristics: getCharacteristicSettings(),
      skills: getSkillSettings()
    });
    for (const input of this.element?.querySelectorAll("[data-cover-img-input]") ?? []) {
      input.addEventListener("input", event => this.#previewCoverImage(event.currentTarget));
    }
  }

  async _processFormData(_event, _form, formData) {
    const data = getExpandedFormData(formData);
    this.settings = await setCoverSettings(data.settings ?? {});
    ui.notifications.info("Настройки укрытий сохранены.");
    return this.forceRender();
  }

  static #onAddCoverEntry(event) {
    event.preventDefault();
    this.settings = this.#readSettingsFromForm();
    this.settings.entries.push(createBlankCoverEntry(this.settings.entries.length));
    return this.forceRender();
  }

  static #onDeleteCoverEntry(event, target) {
    event.preventDefault();
    const index = Number(target.closest("[data-cover-entry-index]")?.dataset.coverEntryIndex);
    if (!Number.isInteger(index) || index < 0) return undefined;
    this.settings = this.#readSettingsFromForm();
    this.settings.entries.splice(index, 1);
    return this.forceRender();
  }

  static async #onBrowseCoverImage(event, target) {
    event.preventDefault();
    const row = target.closest("[data-cover-entry-index]");
    const index = Number(row?.dataset.coverEntryIndex);
    if (!Number.isInteger(index) || index < 0) return undefined;

    this.settings = this.#readSettingsFromForm();
    const current = String(this.settings.entries[index]?.img ?? "");
    const picker = new foundry.applications.apps.FilePicker.implementation({
      type: "image",
      current,
      callback: path => {
        this.settings.entries[index].img = String(path ?? "").trim();
        this.forceRender();
      }
    });
    await picker.browse(undefined, { render: false });
    return picker.render({ force: true });
  }

  static async #onResetDefaults(event) {
    event.preventDefault();
    this.settings = await resetCoverSettings();
    return this.forceRender();
  }

  #readSettingsFromForm() {
    const form = this.form;
    if (!form) return normalizeCoverSettings(this.settings);
    const data = getExpandedFormData(new FormDataExtended(form));
    return normalizeCoverSettings(data.settings ?? {});
  }

  #previewCoverImage(input) {
    const row = input?.closest?.("[data-cover-entry-index]");
    const preview = row?.querySelector?.("[data-cover-img-preview]");
    if (!preview) return;
    preview.src = input.value?.trim() || "icons/svg/shield.svg";
  }
}
