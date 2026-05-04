import { TEMPLATES } from "../constants.mjs";
import { IDENTIFIER_PATTERN, validateFormula } from "../formulas/index.mjs";
import {
  getSkillAdvancementSettings,
  getCharacteristicSettings,
  getSkillSettings,
  resetSkillSettings,
  setSkillSettings
} from "../settings/accessors.mjs";
import { format, localize } from "../utils/i18n.mjs";
import { FalloutMaWFormApplicationV2 } from "./base-form-application-v2.mjs";
import { activateFormulaAutocomplete } from "./formula-autocomplete.mjs";
import { activateSettingsReorder } from "./settings-reorder.mjs";

export class SkillFormulasConfig extends FalloutMaWFormApplicationV2 {
  constructor(options = {}) {
    super(options);
    this.skills = getSkillSettings();
    this.skillAdvancement = getSkillAdvancementSettings();
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-skill-settings",
    classes: ["fallout-maw", "fallout-maw-config-form", "fallout-maw-formula-config", "skill-settings-config"],
    position: {
      width: 900,
      height: "auto"
    },
    window: {
      resizable: true
    },
    actions: {
      createSkill: this.#onCreateSkill,
      deleteSkill: this.#onDeleteSkill,
      resetDefaults: this.#onResetDefaults
    }
  };

  static PARTS = {
    form: {
      template: TEMPLATES.settings.skillFormulas
    }
  };

  get title() {
    return localize("FALLOUTMAW.Settings.Skills.Title");
  }

  async _prepareContext(options) {
    const characteristics = getCharacteristicSettings();
    return {
      ...(await super._prepareContext(options)),
      characteristics,
      signatureMultiplier: this.skillAdvancement.signatureMultiplier,
      signatureFlatBonus: this.skillAdvancement.signatureFlatBonus,
      skills: this.skills.map(skill => ({
        ...skill,
        advancement: this.skillAdvancement.entries?.[skill.key] ?? {
          base: 0,
          characteristics: Object.fromEntries(characteristics.map(characteristic => [characteristic.key, 0]))
        },
        characteristics: characteristics.map(characteristic => ({
          ...characteristic,
          value: Number(this.skillAdvancement.entries?.[skill.key]?.characteristics?.[characteristic.key] ?? 0)
        }))
      }))
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    activateFormulaAutocomplete(this.element, { characteristics: getCharacteristicSettings() });
    activateSettingsReorder(this.element, "[data-skill-row]");
  }

  async _processFormData(_event, _form, _formData) {
    const skills = this.#readSkillsFromForm();
    const advancement = this.#readSkillAdvancementFromForm();
    this.#validateSkills(skills);
    await setSkillSettings({ entries: skills, advancement });
    this.skills = getSkillSettings();
    this.skillAdvancement = getSkillAdvancementSettings();
    ui.notifications.info(localize("FALLOUTMAW.Messages.SkillsSaved"));
    return this.forceRender();
  }

  static #onCreateSkill(event) {
    event.preventDefault();
    this.skills = this.#readSkillsFromForm();
    this.skills.push({
      key: this.#getUniqueKey("newSkill"),
      abbr: this.#getUniqueAbbr("new"),
      label: "Новый навык",
      formula: "0"
    });
    return this.forceRender();
  }

  static #onDeleteSkill(event, target) {
    event.preventDefault();
    const rows = Array.from(this.form?.querySelectorAll("[data-skill-row]") ?? []);
    const index = rows.indexOf(target.closest("[data-skill-row]"));
    if (index < 0) return undefined;

    this.skills = this.#readSkillsFromForm();
    this.skills.splice(index, 1);
    return this.forceRender();
  }

  static async #onResetDefaults(event) {
    event.preventDefault();
    await resetSkillSettings();
    this.skills = getSkillSettings();
    this.skillAdvancement = getSkillAdvancementSettings();
    return this.forceRender();
  }

  #readSkillsFromForm() {
    const rows = Array.from(this.form?.querySelectorAll("[data-skill-row]") ?? []);
    return rows.map(row => ({
      key: row.querySelector("[data-field='key']")?.value?.trim() ?? "",
      abbr: row.querySelector("[data-field='abbr']")?.value?.trim() ?? "",
      label: row.querySelector("[data-field='label']")?.value?.trim() ?? "",
      formula: row.querySelector("[data-field='formula']")?.value?.trim() ?? "0"
    }));
  }

  #readSkillAdvancementFromForm() {
    const rows = Array.from(this.form?.querySelectorAll("[data-skill-advancement-row]") ?? []);
    return {
      signatureMultiplier: Number(this.form?.querySelector("[data-field='signatureMultiplier']")?.value ?? 0),
      signatureFlatBonus: Number(this.form?.querySelector("[data-field='signatureFlatBonus']")?.value ?? 0),
      entries: Object.fromEntries(
        rows.map(row => {
          const key = row.dataset.skillKey ?? "";
          const base = Number(row.querySelector("[data-field='baseMultiplier']")?.value ?? 0);
          const characteristics = Object.fromEntries(
            Array.from(row.querySelectorAll("[data-characteristic-key]") ?? []).map(input => [
              input.dataset.characteristicKey,
              Number(input.value ?? 0)
            ])
          );
          return [key, { base, characteristics }];
        })
      )
    };
  }

  #validateSkills(skills) {
    const keys = new Set();
    const abbreviations = new Set();
    const characteristics = getCharacteristicSettings();

    for (const [index, skill] of skills.entries()) {
      const key = String(skill.key ?? "").trim();
      const abbr = String(skill.abbr ?? "").trim();

      if (!IDENTIFIER_PATTERN.test(key)) throwValidationError(format("FALLOUTMAW.Validation.SkillKeyInvalid", { index: index + 1 }));
      if (keys.has(key)) throwValidationError(format("FALLOUTMAW.Validation.SkillKeyDuplicate", { key }));

      if (!IDENTIFIER_PATTERN.test(abbr)) throwValidationError(format("FALLOUTMAW.Validation.SkillAbbrInvalid", { index: index + 1 }));
      if (abbreviations.has(abbr)) throwValidationError(format("FALLOUTMAW.Validation.SkillAbbrDuplicate", { abbr }));

      keys.add(key);
      abbreviations.add(abbr);

      try {
        validateFormula(skill.formula, { characteristics });
      } catch (error) {
        throwValidationError(`${skill.label || key}: ${error.message}`);
      }
    }
  }

  #getUniqueKey(baseKey) {
    const keys = new Set(this.skills.map(skill => skill.key));
    if (!keys.has(baseKey)) return baseKey;

    let index = 2;
    while (keys.has(`${baseKey}${index}`)) index += 1;
    return `${baseKey}${index}`;
  }

  #getUniqueAbbr(baseAbbr) {
    const abbreviations = new Set(this.skills.map(skill => skill.abbr));
    if (!abbreviations.has(baseAbbr)) return baseAbbr;

    let index = 2;
    while (abbreviations.has(`${baseAbbr}${index}`)) index += 1;
    return `${baseAbbr}${index}`;
  }
}

function throwValidationError(message) {
  ui.notifications.error(message);
  throw new Error(message);
}
