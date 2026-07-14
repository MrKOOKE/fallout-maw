import { TEMPLATES } from "../constants.mjs";
import { getItemCategorySettings, setItemCategorySettings } from "../settings/accessors.mjs";
import { FalloutMaWFormApplicationV2 } from "./base-form-application-v2.mjs";
import { activateSettingsReorder } from "./settings-reorder.mjs";

export class ItemCategorySettingsConfig extends FalloutMaWFormApplicationV2 {
  constructor(options = {}) {
    super(options);
    this.categories = getItemCategorySettings();
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-item-category-settings",
    classes: ["fallout-maw", "fallout-maw-config-form", "item-category-settings-config"],
    position: {
      width: 620,
      height: "auto"
    },
    window: {
      resizable: true
    },
    form: {
      closeOnSubmit: true
    },
    actions: {
      createCategory: this.#onCreateCategory,
      deleteCategory: this.#onDeleteCategory
    }
  };

  static PARTS = {
    form: {
      template: TEMPLATES.settings.itemCategories
    }
  };

  get title() {
    return "Категории предметов";
  }

  async _prepareContext(options) {
    return {
      ...(await super._prepareContext(options)),
      categories: this.categories
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    activateSettingsReorder(this.element, "[data-item-category-row]");
  }

  async _processFormData(_event, _form, _formData) {
    const categories = this.#readCategoriesFromForm();
    this.#validateCategories(categories);

    await setItemCategorySettings(categories);
    this.categories = getItemCategorySettings();
    ui.notifications.info("Категории предметов сохранены.");
    return this.forceRender();
  }

  static #onCreateCategory(event) {
    event.preventDefault();
    this.categories = this.#readCategoriesFromForm();
    this.categories.push({ label: this.#getUniqueLabel("Новая категория") });
    return this.forceRender();
  }

  static #onDeleteCategory(event, target) {
    event.preventDefault();
    const rows = Array.from(this.form?.querySelectorAll("[data-item-category-row]") ?? []);
    const index = rows.indexOf(target.closest("[data-item-category-row]"));
    if (index < 0) return undefined;

    this.categories = this.#readCategoriesFromForm();
    this.categories.splice(index, 1);
    return this.forceRender();
  }


  #readCategoriesFromForm() {
    const rows = Array.from(this.form?.querySelectorAll("[data-item-category-row]") ?? []);
    return rows.map(row => ({
      label: row.querySelector("[data-field='label']")?.value?.trim() ?? ""
    }));
  }

  #validateCategories(categories) {
    const labels = new Set();
    for (const [index, category] of categories.entries()) {
      const label = String(category?.label ?? "").trim();
      if (!label) throwValidationError(`Категория ${index + 1}: название не должно быть пустым.`);
      if (labels.has(label)) throwValidationError(`Категория предметов "${label}" повторяется.`);
      labels.add(label);
    }
  }

  #getUniqueLabel(baseLabel) {
    const labels = new Set(this.categories.map(category => category.label));
    if (!labels.has(baseLabel)) return baseLabel;

    let index = 2;
    while (labels.has(`${baseLabel} ${index}`)) index += 1;
    return `${baseLabel} ${index}`;
  }
}

function throwValidationError(message) {
  ui.notifications.error(message);
  throw new Error(message);
}
