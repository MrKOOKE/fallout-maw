import { TEMPLATES } from "../constants.mjs";
import { CRAFTING_RESOLUTION_MODES } from "../settings/crafting.mjs";
import { getCraftingSettings, setCraftingSettings } from "../settings/accessors.mjs";
import { FalloutMaWFormApplicationV2, getExpandedFormData } from "./base-form-application-v2.mjs";

export class CraftingSettingsConfig extends FalloutMaWFormApplicationV2 {
  constructor(options = {}) {
    super(options);
    this.settings = getCraftingSettings();
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-crafting-settings",
    classes: ["fallout-maw", "fallout-maw-config-form", "fallout-maw-crafting-settings"],
    position: {
      width: 720,
      height: "auto"
    },
    window: {
      resizable: true
    },
    form: {
      closeOnSubmit: true
    }
  };

  static PARTS = {
    form: {
      template: TEMPLATES.settings.crafting
    }
  };

  get title() {
    return "Ремесло";
  }

  async _prepareContext(options) {
    return {
      ...(await super._prepareContext(options)),
      settings: this.settings,
      craftModeChoices: createModeChoices(this.settings.craft.mode),
      repairModeChoices: createModeChoices(this.settings.repair.mode),
      medicineModeChoices: createModeChoices(this.settings.medicine.mode),
      craftSkillChecks: this.settings.craft.mode === CRAFTING_RESOLUTION_MODES.skillChecks,
      repairSkillChecks: this.settings.repair.mode === CRAFTING_RESOLUTION_MODES.skillChecks
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    for (const select of this.element?.querySelectorAll?.("[data-crafting-mode]") ?? []) {
      select.addEventListener("change", () => this.#syncConditionalSections());
    }
    this.#syncConditionalSections();
  }

  async _processFormData(_event, _form, formData) {
    await setCraftingSettings(getExpandedFormData(formData));
    this.settings = getCraftingSettings();
    ui.notifications.info("Настройки ремесла сохранены.");
    return this.forceRender();
  }

  #syncConditionalSections() {
    for (const select of this.element?.querySelectorAll?.("[data-crafting-mode]") ?? []) {
      const section = String(select.dataset.craftingMode ?? "");
      const options = this.element?.querySelector?.(`[data-crafting-check-options="${section}"]`);
      if (options) options.hidden = select.value !== CRAFTING_RESOLUTION_MODES.skillChecks;
    }
  }
}

function createModeChoices(activeMode) {
  return [
    {
      key: CRAFTING_RESOLUTION_MODES.skillChecks,
      label: "Проверки навыков",
      selected: activeMode === CRAFTING_RESOLUTION_MODES.skillChecks
    },
    {
      key: CRAFTING_RESOLUTION_MODES.skillThreshold,
      label: "Навык как порог",
      selected: activeMode === CRAFTING_RESOLUTION_MODES.skillThreshold
    }
  ];
}
