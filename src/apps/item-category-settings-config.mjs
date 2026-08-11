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
      deleteCategory: this.#onDeleteCategory,
      createSubcategory: this.#onCreateSubcategory,
      deleteSubcategory: this.#onDeleteSubcategory
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
    this.categories.push({ label: this.#getUniqueLabel("Новая категория"), subcategories: [] });
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

  static #onCreateSubcategory(event, target) {
    event.preventDefault();
    const rows = Array.from(this.form?.querySelectorAll("[data-item-category-row]") ?? []);
    const index = rows.indexOf(target.closest("[data-item-category-row]"));
    if (index < 0) return undefined;

    this.categories = this.#readCategoriesFromForm();
    const category = this.categories[index];
    category.subcategories.push({
      label: this.#getUniqueSubcategoryLabel(category, "Новая подкатегория")
    });
    return this.forceRender();
  }

  static #onDeleteSubcategory(event, target) {
    event.preventDefault();
    const categoryRows = Array.from(this.form?.querySelectorAll("[data-item-category-row]") ?? []);
    const categoryIndex = categoryRows.indexOf(target.closest("[data-item-category-row]"));
    if (categoryIndex < 0) return undefined;
    const subcategoryRows = Array.from(categoryRows[categoryIndex].querySelectorAll("[data-item-subcategory-row]"));
    const subcategoryIndex = subcategoryRows.indexOf(target.closest("[data-item-subcategory-row]"));
    if (subcategoryIndex < 0) return undefined;

    this.categories = this.#readCategoriesFromForm();
    this.categories[categoryIndex].subcategories.splice(subcategoryIndex, 1);
    return this.forceRender();
  }


  #readCategoriesFromForm() {
    const rows = Array.from(this.form?.querySelectorAll("[data-item-category-row]") ?? []);
    return rows.map(row => ({
      label: row.querySelector("[data-field='categoryLabel']")?.value?.trim() ?? "",
      subcategories: Array.from(row.querySelectorAll("[data-item-subcategory-row]")).map(subcategoryRow => ({
        label: subcategoryRow.querySelector("[data-field='subcategoryLabel']")?.value?.trim() ?? ""
      }))
    }));
  }

  #validateCategories(categories) {
    const labels = new Set();
    for (const [index, category] of categories.entries()) {
      const label = String(category?.label ?? "").trim();
      if (!label) throwValidationError(`Категория ${index + 1}: название не должно быть пустым.`);
      if (labels.has(label)) throwValidationError(`Категория предметов "${label}" повторяется.`);
      labels.add(label);
      const subcategoryLabels = new Set();
      for (const [subcategoryIndex, subcategory] of (category.subcategories ?? []).entries()) {
        const subcategoryLabel = String(subcategory?.label ?? "").trim();
        if (!subcategoryLabel) {
          throwValidationError(`Категория "${label}", подкатегория ${subcategoryIndex + 1}: название не должно быть пустым.`);
        }
        if (subcategoryLabels.has(subcategoryLabel)) {
          throwValidationError(`Подкатегория "${subcategoryLabel}" в категории "${label}" повторяется.`);
        }
        subcategoryLabels.add(subcategoryLabel);
      }
    }
  }

  #getUniqueLabel(baseLabel) {
    const labels = new Set(this.categories.map(category => category.label));
    if (!labels.has(baseLabel)) return baseLabel;

    let index = 2;
    while (labels.has(`${baseLabel} ${index}`)) index += 1;
    return `${baseLabel} ${index}`;
  }

  #getUniqueSubcategoryLabel(category, baseLabel) {
    const labels = new Set((category?.subcategories ?? []).map(entry => entry.label));
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
