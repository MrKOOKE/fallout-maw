import { TEMPLATES } from "../constants.mjs";
import { getAbilityCatalog, getSkillSettings, resetAbilityCatalog, setAbilityCatalog } from "../settings/accessors.mjs";
import { LOCKED_FEATURES_CATEGORY_ID, normalizeAbilityCatalog, normalizeAbilityEntry } from "../settings/abilities.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { AbilityCatalogItemEditor } from "./ability-catalog-item-editor.mjs";
import { FalloutMaWFormApplicationV2 } from "./base-form-application-v2.mjs";
import { activateSettingsReorder } from "./settings-reorder.mjs";

const { DialogV2 } = foundry.applications.api;
const { FormDataExtended } = foundry.applications.ux;

export class AbilitySettingsConfig extends FalloutMaWFormApplicationV2 {
  #expandedCategoryIds = new Set();

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
    form: {
      closeOnSubmit: true
    },
    actions: {
      addCategory: this.#onAddCategory,
      deleteCategory: this.#onDeleteCategory,
      toggleCategory: this.#onToggleCategory,
      addAbility: this.#onAddAbility,
      moveAbility: this.#onMoveAbility,
      toggleAbilityVisibility: this.#onToggleAbilityVisibility,
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
          collapse: buildCategoryCollapseState(this.#expandedCategoryIds.has(String(category.id ?? ""))),
          abilities: (category.abilities ?? []).map(ability => ({
            ...ability,
            isFeature: category.id === LOCKED_FEATURES_CATEGORY_ID,
            cost: toInteger(ability.system?.cost),
            visible: ability.visible !== false,
            visibilityIconClass: ability.visible === false ? "fa-eye-slash" : "fa-eye",
            visibilityTitle: ability.visible === false
              ? "Показать в повышении уровня"
              : "Скрыть из повышения уровня"
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
    const visibilityInput = abilityRow.querySelector("[data-field='abilityVisible']");
    if (visibilityInput) visibilityInput.value = ability.visible === false ? "false" : "true";
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
            visible: abilityRow.querySelector("[data-field='abilityVisible']")?.value !== "false",
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

  static #onToggleCategory(event, target) {
    event.preventDefault();
    this.catalog = this.readCatalogFromForm();
    const categoryId = target.closest("[data-ability-category-row]")?.dataset.categoryId ?? "";
    if (!categoryId) return undefined;
    if (this.#expandedCategoryIds.has(categoryId)) this.#expandedCategoryIds.delete(categoryId);
    else this.#expandedCategoryIds.add(categoryId);
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

  static async #onMoveAbility(event, target) {
    event.preventDefault();
    this.catalog = this.readCatalogFromForm();
    const sourceCategoryId = target.closest("[data-ability-category-row]")?.dataset.categoryId ?? "";
    const abilityId = target.closest("[data-ability-row]")?.dataset.abilityId ?? "";
    if (!sourceCategoryId || !abilityId) return undefined;

    const sourceCategory = this.catalog.categories.find(category => category.id === sourceCategoryId);
    const abilityIndex = sourceCategory?.abilities?.findIndex(ability => ability.id === abilityId) ?? -1;
    if (!sourceCategory || abilityIndex < 0) return undefined;

    const targetCategoryId = await requestAbilityTargetCategory(this.catalog, sourceCategoryId);
    if (!targetCategoryId || targetCategoryId === sourceCategoryId) return undefined;

    const targetCategory = this.catalog.categories.find(category => category.id === targetCategoryId);
    if (!targetCategory) return undefined;

    const [ability] = sourceCategory.abilities.splice(abilityIndex, 1);
    targetCategory.abilities.push(ability);
    this.#expandedCategoryIds.add(targetCategoryId);
    return this.forceRender();
  }

  static #onToggleAbilityVisibility(event, target) {
    event.preventDefault();
    this.catalog = this.readCatalogFromForm();
    const categoryId = target.closest("[data-ability-category-row]")?.dataset.categoryId ?? "";
    const abilityId = target.closest("[data-ability-row]")?.dataset.abilityId ?? "";
    const ability = this.getAbility(categoryId, abilityId);
    if (!ability) return undefined;
    ability.visible = ability.visible === false;
    return this.forceRender();
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

function buildCategoryCollapseState(expanded = false) {
  return {
    cssClass: expanded ? "" : "collapsed",
    ariaExpanded: expanded ? "true" : "false",
    iconClass: expanded ? "fa-chevron-down" : "fa-chevron-right"
  };
}

async function requestAbilityTargetCategory(catalog, sourceCategoryId = "") {
  const options = (catalog.categories ?? [])
    .filter(category => category.id !== sourceCategoryId)
    .map(category => `<option value="${escapeAttribute(category.id)}">${escapeHTML(category.name)}</option>`)
    .join("");
  if (!options) {
    ui.notifications.warn("Нет другого каталога для переноса.");
    return "";
  }

  const result = await DialogV2.input({
    window: { title: "Переместить способность" },
    content: `
      <label class="fallout-maw-stacked-field">
        <span>Новый каталог</span>
        <select name="categoryId">${options}</select>
      </label>
    `,
    ok: {
      label: "Переместить",
      icon: "fa-solid fa-arrow-right-arrow-left",
      callback: (_event, button) => new FormDataExtended(button.form).object
    },
    buttons: [{
      action: "cancel",
      label: "Отмена"
    }],
    rejectClose: false,
    position: { width: 420 }
  });

  return typeof result?.categoryId === "string" ? result.categoryId : "";
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

function escapeHTML(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

function escapeAttribute(value) {
  return escapeHTML(value).replace(/"/g, "&quot;");
}
