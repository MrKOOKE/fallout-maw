import { TEMPLATES } from "../constants.mjs";
import { getCharacteristicSettings, getSkillSettings } from "../settings/accessors.mjs";
import {
  ABILITY_FUNCTION_TYPES,
  createAbilityFunction,
  normalizeAbilityEntry
} from "../settings/abilities.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { FalloutMaWFormApplicationV2 } from "./base-form-application-v2.mjs";

const TextEditor = foundry.applications.ux.TextEditor.implementation;

export class AbilityCatalogItemEditor extends FalloutMaWFormApplicationV2 {
  #activeTab = "details";
  #functionPickerActive = false;

  constructor(catalogApp, categoryId, abilityId, options = {}) {
    super(options);
    this.catalogApp = catalogApp;
    this.categoryId = categoryId;
    this.abilityId = abilityId;
    this.ability = normalizeAbilityEntry(catalogApp.getAbility(categoryId, abilityId));
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-ability-catalog-item-editor",
    classes: ["fallout-maw", "fallout-maw-sheet", "fallout-maw-item-sheet", "sheet", "item", "ability-catalog-item-editor"],
    position: {
      width: 930,
      height: 900
    },
    window: {
      resizable: true
    },
    actions: {
      editAbilityImage: this.#onEditAbilityImage,
      selectTab: this.#onSelectTab,
      addFunction: this.#onAddFunction,
      deleteFunction: this.#onDeleteFunction
    }
  };

  static PARTS = {
    form: {
      template: TEMPLATES.settings.abilityEditor
    }
  };

  get title() {
    return `Способность: ${this.ability.name}`;
  }

  async _prepareContext(options) {
    const characteristics = getCharacteristicSettings();
    const skills = getSkillSettings();
    const descriptionHTML = await TextEditor.enrichHTML(this.ability.description ?? "", {
      secrets: game.user?.isGM ?? false
    });
    return {
      ...(await super._prepareContext(options)),
      ability: this.ability,
      system: this.ability.system,
      isDetailsTab: this.#activeTab === "details",
      isFunctionsTab: this.#activeTab === "functions",
      tabs: {
        details: {
          id: "details",
          group: "primary",
          cssClass: this.#activeTab === "details" ? "active" : ""
        },
        functions: {
          id: "functions",
          group: "primary",
          cssClass: this.#activeTab === "functions" ? "active" : ""
        }
      },
      descriptionHTML,
      canAddFunction: true,
      showFunctionPicker: this.#functionPickerActive,
      functionChoices: [
        {
          value: "",
          label: "Выберите функцию",
          disabled: true,
          selected: true
        },
        {
          value: ABILITY_FUNCTION_TYPES.characteristicBonus,
          label: "Изменение характеристики"
        },
        {
          value: ABILITY_FUNCTION_TYPES.skillBonus,
          label: "Изменение навыка"
        }
      ],
      onlyFree: Boolean(this.ability.system?.acquisition?.onlyFree),
      onlyManual: Boolean(this.ability.system?.acquisition?.onlyManual),
      researchDifficulty: Math.max(0, toInteger(this.ability.system?.acquisition?.difficulty ?? 60)),
      researchSkillChoices: skills.map((skill, index) => ({
        key: skill.key,
        label: skill.label,
        selected: skill.key === this.ability.system?.acquisition?.skillKey || (!this.ability.system?.acquisition?.skillKey && index === 0)
      })),
      functions: (this.ability.system?.functions ?? []).map(entry => prepareFunctionForDisplay(entry, characteristics, skills))
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.element?.querySelector?.("[data-choose-ability-function]")?.addEventListener("change", event => this.#onChooseFunction(event));
  }

  async _processFormData(_event, _form, _formData) {
    this.#syncFromForm();
    this.ability = await this.catalogApp.saveAbility(this.categoryId, this.ability);
    ui.notifications.info("Способность сохранена.");
    return this.forceRender();
  }

  static #onSelectTab(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    this.#activeTab = target.dataset.tab ?? "details";
    return this.forceRender();
  }

  static #onEditAbilityImage(event) {
    event.preventDefault();
    this.#syncFromForm();
    const picker = new foundry.applications.apps.FilePicker.implementation({
      type: "image",
      current: this.ability.img,
      callback: path => {
        this.ability = normalizeAbilityEntry({
          ...this.ability,
          img: path
        });
        this.forceRender();
      }
    });
    return picker.render(true);
  }

  static #onAddFunction(event) {
    event.preventDefault();
    this.#syncFromForm();
    this.#functionPickerActive = true;
    this.#activeTab = "functions";
    return this.forceRender();
  }

  #onChooseFunction(event) {
    event.preventDefault();
    this.#syncFromForm();
    const selected = String(event.currentTarget?.value ?? "");
    if (!Object.values(ABILITY_FUNCTION_TYPES).includes(selected)) return undefined;
    this.ability.system.functions.push(createAbilityFunction(selected));
    this.#functionPickerActive = false;
    this.#activeTab = "functions";
    return this.forceRender();
  }

  static #onDeleteFunction(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const row = target.closest("[data-ability-function-row]");
    const rows = Array.from(this.form?.querySelectorAll("[data-ability-function-row]") ?? []);
    const index = rows.indexOf(row);
    if (index >= 0) this.ability.system.functions.splice(index, 1);
    return this.forceRender();
  }

  #syncFromForm() {
    if (!this.form) return;
    const onlyFree = Boolean(this.form.querySelector("[data-field='onlyFree']")?.checked);
    this.ability = normalizeAbilityEntry({
      ...this.ability,
      name: this.form.querySelector("[data-field='name']")?.value ?? this.ability.name,
      img: this.form.querySelector("[data-field='img']")?.value ?? this.ability.img,
      description: readFieldValue(this.form.querySelector("[data-field='description']"), this.ability.description),
      system: {
        ...(this.ability.system ?? {}),
        cost: this.form.querySelector("[data-field='cost']")?.value ?? this.ability.system?.cost,
        acquisition: {
          onlyFree,
          onlyManual: onlyFree ? false : Boolean(this.form.querySelector("[data-field='onlyManual']")?.checked),
          skillKey: this.form.querySelector("[data-field='researchSkillKey']")?.value ?? this.ability.system?.acquisition?.skillKey,
          difficulty: this.form.querySelector("[data-field='researchDifficulty']")?.value ?? this.ability.system?.acquisition?.difficulty
        },
        functions: Array.from(this.form.querySelectorAll("[data-ability-function-row]") ?? []).map(row => ({
          id: row.dataset.functionId || foundry.utils.randomID(),
          type: row.dataset.functionType,
          target: row.querySelector("[data-field='functionTarget']")?.value ?? "",
          value: row.querySelector("[data-field='functionValue']")?.value ?? 0,
          condition: {
            enabled: Boolean(row.querySelector("[data-field='conditionEnabled']")?.checked),
            resource: "health",
            operator: row.querySelector("[data-field='conditionOperator']")?.value ?? "lte",
            percent: row.querySelector("[data-field='conditionPercent']")?.value ?? 50
          }
        }))
      }
    });
  }
}

function readFieldValue(element, fallback = "") {
  if (!element) return fallback;
  if ("value" in element) return element.value;
  return element.getAttribute("value") ?? fallback;
}

function prepareFunctionForDisplay(entry, characteristics, skills) {
  const type = String(entry?.type ?? ABILITY_FUNCTION_TYPES.characteristicBonus);
  const targetSettings = type === ABILITY_FUNCTION_TYPES.skillBonus ? skills : characteristics;
  return {
    ...entry,
    isSkill: type === ABILITY_FUNCTION_TYPES.skillBonus,
    typeLabel: type === ABILITY_FUNCTION_TYPES.skillBonus ? "Изменение навыка" : "Изменение характеристики",
    conditionEnabled: Boolean(entry?.condition?.enabled),
    conditionLte: String(entry?.condition?.operator ?? "lte") !== "gte",
    conditionGte: String(entry?.condition?.operator ?? "lte") === "gte",
    value: toInteger(entry?.value),
    conditionPercent: Math.max(0, Math.min(100, toInteger(entry?.condition?.percent ?? 50))),
    targetChoices: targetSettings.map(setting => ({
      key: setting.key,
      label: setting.label,
      selected: setting.key === entry?.target
    }))
  };
}
