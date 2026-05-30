import { TEMPLATES } from "../constants.mjs";
import { getAbilityCatalog, getSkillSettings, resetAbilityCatalog, setAbilityCatalog } from "../settings/accessors.mjs";
import { LOCKED_FEATURES_CATEGORY_ID, normalizeAbilityCatalog, normalizeAbilityEntry } from "../settings/abilities.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { AbilityCatalogItemEditor } from "./ability-catalog-item-editor.mjs";
import { FalloutMaWFormApplicationV2 } from "./base-form-application-v2.mjs";
import { activateSettingsReorder } from "./settings-reorder.mjs";

export class AbilitySettingsConfig extends FalloutMaWFormApplicationV2 {
  constructor(options = {}) {
    super(options);
    this.catalog = getAbilityCatalog();
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-ability-settings",
    classes: ["fallout-maw", "fallout-maw-config-form", "ability-settings-config"],
    position: {
      width: 1040,
      height: 760
    },
    window: {
      resizable: true
    },
    actions: {
      addCategory: this.#onAddCategory,
      deleteCategory: this.#onDeleteCategory,
      addAbility: this.#onAddAbility,
      editAbility: this.#onEditAbility,
      deleteAbility: this.#onDeleteAbility,
      resetDefaults: this.#onResetDefaults
    }
  };

  static PARTS = {
    form: {
      template: TEMPLATES.settings.abilities
    }
  };

  get title() {
    return "Способности/Особенности";
  }

  async _prepareContext(options) {
    return {
      ...(await super._prepareContext(options)),
      catalog: {
        categories: (this.catalog.categories ?? []).map(category => ({
          ...category,
          isFeatures: category.id === LOCKED_FEATURES_CATEGORY_ID,
          deletable: !category.locked,
          createLabel: category.id === LOCKED_FEATURES_CATEGORY_ID ? "Создать особенность" : "Создать способность",
          emptyLabel: category.id === LOCKED_FEATURES_CATEGORY_ID ? "В каталоге нет особенностей." : "В каталоге нет способностей.",
          abilities: (category.abilities ?? []).map(ability => ({
            ...ability,
            isFeature: category.id === LOCKED_FEATURES_CATEGORY_ID,
            cost: toInteger(ability.system?.cost)
          }))
        }))
      }
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    activateSettingsReorder(this.element, "[data-ability-category-row]");
  }

  async _processFormData(_event, _form, _formData) {
    this.catalog = await setAbilityCatalog(this.readCatalogFromForm());
    ui.notifications.info("Настройки способностей сохранены.");
    return this.forceRender();
  }

  getAbility(categoryId, abilityId) {
    const category = this.catalog.categories.find(entry => entry.id === categoryId);
    return category?.abilities?.find(entry => entry.id === abilityId) ?? null;
  }

  async saveAbility(categoryId, ability) {
    const normalized = normalizeAbilityEntry(ability);
    const category = this.catalog.categories.find(entry => entry.id === categoryId);
    if (!category) return null;
    const index = category.abilities.findIndex(entry => entry.id === normalized.id);
    if (index >= 0) category.abilities[index] = normalized;
    else category.abilities.push(normalized);
    this.catalog = await setAbilityCatalog(this.catalog);
    const saved = this.getAbility(categoryId, normalized.id) ?? normalized;
    this.#syncAbilityRow(categoryId, saved);
    return saved;
  }

  #syncAbilityRow(categoryId, ability) {
    const categoryRow = Array.from(this.form?.querySelectorAll("[data-ability-category-row]") ?? [])
      .find(row => row.dataset.categoryId === categoryId);
    const abilityRow = Array.from(categoryRow?.querySelectorAll("[data-ability-row]") ?? [])
      .find(row => row.dataset.abilityId === ability.id);
    if (!abilityRow) return;

    const nameInput = abilityRow.querySelector("[data-field='abilityName']");
    if (nameInput) nameInput.value = ability.name;
    const imgInput = abilityRow.querySelector("[data-field='abilityImg']");
    if (imgInput) imgInput.value = ability.img;
    const costInput = abilityRow.querySelector("[data-field='abilityCost']");
    if (costInput) costInput.value = String(toInteger(ability.system?.cost));
    const img = abilityRow.querySelector("img");
    if (img) img.src = ability.img;
  }

  readCatalogFromForm() {
    const categoryRows = Array.from(this.form?.querySelectorAll("[data-ability-category-row]") ?? []);
    const categories = categoryRows.map((categoryRow, categoryIndex) => {
      const categoryId = categoryRow.dataset.categoryId || foundry.utils.randomID();
      const existingCategory = this.catalog.categories.find(entry => entry.id === categoryId);
      return {
        id: categoryId,
        name: categoryRow.querySelector("[data-field='categoryName']")?.value?.trim() || existingCategory?.name || `Категория ${categoryIndex + 1}`,
        locked: Boolean(existingCategory?.locked),
        abilities: Array.from(categoryRow.querySelectorAll("[data-ability-row]") ?? []).map((abilityRow, abilityIndex) => {
          const abilityId = abilityRow.dataset.abilityId || foundry.utils.randomID();
          const existingAbility = existingCategory?.abilities?.find(entry => entry.id === abilityId) ?? {};
          return normalizeAbilityEntry({
            ...existingAbility,
            id: abilityId,
            name: abilityRow.querySelector("[data-field='abilityName']")?.value ?? existingAbility.name,
            img: abilityRow.querySelector("[data-field='abilityImg']")?.value ?? existingAbility.img,
            description: existingAbility.description,
            system: {
              ...(existingAbility.system ?? {}),
              cost: categoryId === LOCKED_FEATURES_CATEGORY_ID
                ? 0
                : abilityRow.querySelector("[data-field='abilityCost']")?.value ?? existingAbility.system?.cost
            }
          }, abilityIndex);
        })
      };
    });
    return normalizeAbilityCatalog({ categories }, getSkillSettings());
  }

  static #onAddCategory(event) {
    event.preventDefault();
    this.catalog = this.readCatalogFromForm();
    this.catalog.categories.push({
      id: foundry.utils.randomID(),
      name: "Новая категория",
      locked: false,
      abilities: []
    });
    return this.forceRender();
  }

  static #onDeleteCategory(event, target) {
    event.preventDefault();
    this.catalog = this.readCatalogFromForm();
    const index = getRowIndex(this.form, target, "[data-ability-category-row]");
    if (index < 0 || this.catalog.categories[index]?.locked) return undefined;
    this.catalog.categories.splice(index, 1);
    return this.forceRender();
  }

  static async #onAddAbility(event, target) {
    event.preventDefault();
    this.catalog = this.readCatalogFromForm();
    const categoryIndex = getRowIndex(this.form, target, "[data-ability-category-row]");
    const category = this.catalog.categories[categoryIndex];
    if (!category) return undefined;
    const firstSkill = getSkillSettings()[0]?.key ?? "";
    const isFeatures = category.id === LOCKED_FEATURES_CATEGORY_ID;
    const ability = normalizeAbilityEntry({
      id: foundry.utils.randomID(),
      name: isFeatures ? "Новая особенность" : "Новая способность",
      img: isFeatures ? "icons/svg/upgrade.svg" : "icons/svg/aura.svg",
      system: {
        cost: 0,
        acquisition: {
          onlyFree: false,
          onlyManual: false,
          skillKey: firstSkill,
          difficulty: 60
        },
        functions: []
      }
    });
    category.abilities.push(ability);
    await this.forceRender();
    return new AbilityCatalogItemEditor(this, category.id, ability.id).render(true);
  }

  static #onEditAbility(event, target) {
    event.preventDefault();
    this.catalog = this.readCatalogFromForm();
    const categoryRow = target.closest("[data-ability-category-row]");
    const abilityRow = target.closest("[data-ability-row]");
    const categoryId = categoryRow?.dataset.categoryId ?? "";
    const abilityId = abilityRow?.dataset.abilityId ?? "";
    if (!categoryId || !abilityId) return undefined;
    return new AbilityCatalogItemEditor(this, categoryId, abilityId).render(true);
  }

  static #onDeleteAbility(event, target) {
    event.preventDefault();
    this.catalog = this.readCatalogFromForm();
    const categoryElement = target.closest("[data-ability-category-row]");
    const categoryIndex = getRowIndex(this.form, target, "[data-ability-category-row]");
    const abilityIndex = getScopedRowIndex(categoryElement, target, "[data-ability-row]");
    if (categoryIndex < 0 || abilityIndex < 0) return undefined;
    this.catalog.categories[categoryIndex]?.abilities?.splice(abilityIndex, 1);
    return this.forceRender();
  }

  static async #onResetDefaults(event) {
    event.preventDefault();
    this.catalog = await resetAbilityCatalog();
    return this.forceRender();
  }
}

function getRowIndex(form, target, selector) {
  const row = target.closest(selector);
  const rows = Array.from(form?.querySelectorAll(selector) ?? []);
  return rows.indexOf(row);
}

function getScopedRowIndex(scope, target, selector) {
  const row = target.closest(selector);
  const rows = Array.from(scope?.querySelectorAll(selector) ?? []);
  return rows.indexOf(row);
}
