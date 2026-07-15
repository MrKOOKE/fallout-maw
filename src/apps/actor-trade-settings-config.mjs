import { TEMPLATES } from "../constants.mjs";
import { getCurrencySettings, getItemCategorySettings } from "../settings/accessors.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { FalloutMaWFormApplicationV2, getExpandedFormData } from "./base-form-application-v2.mjs";

const TRADE_DIRECTIONS = new Set(["increase", "decrease"]);
const TRADE_OVERRIDE_MODES = new Set(["percent", "fixed"]);
const FormDataExtended = foundry.applications.ux.FormDataExtended;
const TextEditor = foundry.applications.ux.TextEditor.implementation;

export class ActorTradeSettingsConfig extends FalloutMaWFormApplicationV2 {
  constructor(actor, options = {}) {
    super(options);
    if (!actor) throw new Error("ActorTradeSettingsConfig requires an actor.");
    this.actor = actor;
    this._autoSaveTimer = null;
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-actor-trade-settings",
    classes: ["fallout-maw", "fallout-maw-config-form", "fallout-maw-actor-trade-settings"],
    position: {
      width: 720,
      height: "auto"
    },
    window: {
      resizable: true
    },
    form: {
      closeOnSubmit: false
    }
  };

  static PARTS = {
    form: {
      template: TEMPLATES.actorTradeSettings
    }
  };

  get title() {
    return `Торговля: ${this.actor.name}`;
  }

  async close(options = {}) {
    this.#cancelScheduledAutoSave();
    if (this.form) await this.#saveDraft(this.#getCurrentDraft());
    return super.close(options);
  }

  async _prepareContext(options) {
    const trade = this.actor.system.trade ?? {};
    const sourceTrade = this.actor._source?.system?.trade ?? {};
    const legacyMarkup = toInteger(trade.markupPercent);
    const sell = sourceTrade.sell
      ? normalizeAdjustment(trade.sell, "increase")
      : normalizeAdjustment({ percent: Math.abs(legacyMarkup), direction: legacyMarkup < 0 ? "decrease" : "increase" }, "increase");
    const currencies = getCurrencySettings();
    const primaryCurrencyKey = currencies.find(currency => currency.primaryTrade)?.key ?? currencies.at(0)?.key ?? "";
    const categorySuggestions = Array.from(new Set([
      ...getItemCategorySettings().map(category => String(category.label ?? category.name ?? category.key ?? "").trim()),
      ...this.actor.items.map(item => String(item.system?.itemCategory ?? "").trim())
    ].filter(Boolean))).sort((left, right) => left.localeCompare(right, "ru"));

    return {
      ...(await super._prepareContext(options)),
      actor: this.actor,
      categorySuggestions,
      settings: {
        infiniteInventory: Boolean(trade.infiniteInventory),
        sell,
        buy: normalizeAdjustment(trade.buy, "decrease"),
        categoryOverrides: normalizeCategoryOverrides(trade.categoryOverrides),
        itemOverrides: normalizeItemOverrides(trade.itemOverrides, primaryCurrencyKey).map(entry => ({
          ...entry,
          isPercent: entry.mode === "percent",
          currencies: currencies.map(currency => ({
            ...currency,
            selectedSell: currency.key === entry.fixedSell.currencyKey,
            selectedBuy: currency.key === entry.fixedBuy.currencyKey
          }))
        }))
      }
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element;
    root?.querySelectorAll("[data-trade-remove-category]").forEach(button => {
      button.addEventListener("click", event => void this.#removeCategory(event));
    });
    root?.querySelectorAll("[data-trade-remove-item]").forEach(button => {
      button.addEventListener("click", event => void this.#removeItem(event));
    });
    root?.querySelector("[data-trade-add-category]")?.addEventListener("click", event => void this.#addCategory(event));
    root?.querySelectorAll("[data-trade-item-mode]").forEach(select => {
      select.addEventListener("change", event => this.#toggleItemOverrideMode(event));
    });
    root?.querySelectorAll("input:not([type='hidden']), select").forEach(control => {
      control.addEventListener("change", () => void this.#saveCurrentForm());
      if (control.matches("input[type='number'], input[type='text']")) {
        control.addEventListener("input", () => this.#scheduleAutoSave());
      }
    });
    const dropzone = root?.querySelector("[data-trade-item-dropzone]");
    dropzone?.addEventListener("dragover", event => {
      event.preventDefault();
      dropzone.classList.add("drag-over");
    });
    dropzone?.addEventListener("dragleave", () => dropzone.classList.remove("drag-over"));
    dropzone?.addEventListener("drop", event => void this.#addDroppedItem(event));
  }

  async _processFormData(_event, _form, formData) {
    const data = getExpandedFormData(formData);
    const trade = data.trade ?? {};
    const sell = normalizeAdjustment(trade.sell, "increase");
    const buy = normalizeAdjustment(trade.buy, "decrease");
    const categoryOverrides = normalizeCategoryOverrides(trade.categoryOverrides);
    const primaryCurrencyKey = getCurrencySettings().find(currency => currency.primaryTrade)?.key ?? getCurrencySettings().at(0)?.key ?? "";
    const itemOverrides = normalizeItemOverrides(trade.itemOverrides, primaryCurrencyKey);
    await this.actor.update({
      "system.trade.infiniteInventory": Boolean(trade.infiniteInventory),
      "system.trade.markupPercent": adjustmentToSignedPercent(sell),
      "system.trade.sell": sell,
      "system.trade.buy": buy,
      "system.trade.categoryOverrides": categoryOverrides,
      "system.trade.itemOverrides": itemOverrides
    });
  }

  async #addCategory(event) {
    event.preventDefault();
    this.#cancelScheduledAutoSave();
    const draft = this.#getCurrentDraft();
    draft.categoryOverrides.push({
      id: foundry.utils.randomID(),
      category: "",
      sell: { percent: 0, direction: "increase" },
      buy: { percent: 0, direction: "decrease" }
    });
    await this.#saveDraft(draft);
    return this.render();
  }

  async #removeCategory(event) {
    event.preventDefault();
    this.#cancelScheduledAutoSave();
    const id = String(event.currentTarget?.dataset?.tradeRemoveCategory ?? "");
    const draft = this.#getCurrentDraft();
    draft.categoryOverrides = draft.categoryOverrides.filter(entry => entry.id !== id);
    await this.#saveDraft(draft);
    return this.render();
  }

  async #removeItem(event) {
    event.preventDefault();
    this.#cancelScheduledAutoSave();
    const id = String(event.currentTarget?.dataset?.tradeRemoveItem ?? "");
    const draft = this.#getCurrentDraft();
    draft.itemOverrides = draft.itemOverrides.filter(entry => entry.id !== id);
    await this.#saveDraft(draft);
    return this.render();
  }

  #toggleItemOverrideMode(event) {
    const row = event.currentTarget?.closest?.("[data-trade-item-override]");
    if (!row) return;
    const fixed = event.currentTarget.value === "fixed";
    row.querySelector("[data-trade-percent-fields]")?.classList.toggle("hidden", fixed);
    row.querySelector("[data-trade-fixed-fields]")?.classList.toggle("hidden", !fixed);
  }

  async #addDroppedItem(event) {
    event.preventDefault();
    this.#cancelScheduledAutoSave();
    event.currentTarget?.classList.remove("drag-over");
    const dropData = TextEditor.getDragEventData(event);
    const uuid = String(dropData?.uuid ?? "").trim();
    if (!uuid) return;
    const item = await fromUuid(uuid);
    if (!item || item.documentName !== "Item") {
      ui.notifications.warn("Перетащите сюда предмет.");
      return;
    }
    const primaryCurrencyKey = getCurrencySettings().find(currency => currency.primaryTrade)?.key ?? getCurrencySettings().at(0)?.key ?? "";
    const draft = this.#getCurrentDraft();
    if (draft.itemOverrides.some(entry => entry.itemUuid === item.uuid || (entry.itemId && entry.itemId === item.id))) {
      ui.notifications.warn("Для этого предмета уже задано переопределение.");
      return;
    }
    draft.itemOverrides.push({
      id: foundry.utils.randomID(),
      itemUuid: item.uuid,
      itemId: item.id,
      name: item.name,
      img: item.img,
      mode: "percent",
      sell: { percent: 0, direction: "increase" },
      buy: { percent: 0, direction: "decrease" },
      fixedSell: { value: 0, currencyKey: primaryCurrencyKey },
      fixedBuy: { value: 0, currencyKey: primaryCurrencyKey }
    });
    await this.#saveDraft(draft);
    return this.render();
  }

  #getCurrentDraft() {
    const primaryCurrencyKey = getCurrencySettings().find(currency => currency.primaryTrade)?.key ?? getCurrencySettings().at(0)?.key ?? "";
    const hasForm = Boolean(this.form);
    const data = hasForm ? foundry.utils.expandObject(new FormDataExtended(this.form).object).trade ?? {} : {};
    const actorTrade = this.actor.system.trade ?? {};
    return {
      infiniteInventory: hasForm ? Boolean(data.infiniteInventory) : Boolean(actorTrade.infiniteInventory),
      sell: normalizeAdjustment(data.sell ?? actorTrade.sell, "increase"),
      buy: normalizeAdjustment(data.buy ?? actorTrade.buy, "decrease"),
      categoryOverrides: normalizeCategoryOverrides(data.categoryOverrides ?? actorTrade.categoryOverrides),
      itemOverrides: normalizeItemOverrides(data.itemOverrides ?? actorTrade.itemOverrides, primaryCurrencyKey)
    };
  }

  async #saveDraft(draft = {}) {
    const sell = normalizeAdjustment(draft.sell, "increase");
    return this.actor.update({
      "system.trade.infiniteInventory": Boolean(draft.infiniteInventory),
      "system.trade.markupPercent": adjustmentToSignedPercent(sell),
      "system.trade.sell": sell,
      "system.trade.buy": normalizeAdjustment(draft.buy, "decrease"),
      "system.trade.categoryOverrides": normalizeCategoryOverrides(draft.categoryOverrides),
      "system.trade.itemOverrides": draft.itemOverrides
    });
  }

  #scheduleAutoSave() {
    this.#cancelScheduledAutoSave();
    this._autoSaveTimer = setTimeout(() => {
      this._autoSaveTimer = null;
      void this.#saveCurrentForm();
    }, 250);
  }

  #cancelScheduledAutoSave() {
    if (this._autoSaveTimer === null) return;
    clearTimeout(this._autoSaveTimer);
    this._autoSaveTimer = null;
  }

  async #saveCurrentForm() {
    this.#cancelScheduledAutoSave();
    if (!this.form) return;
    await this.#saveDraft(this.#getCurrentDraft());
  }
}

function normalizeAdjustment(value = {}, fallbackDirection = "increase") {
  const direction = TRADE_DIRECTIONS.has(value?.direction) ? value.direction : fallbackDirection;
  return {
    percent: Math.max(0, Math.abs(toInteger(value?.percent))),
    direction
  };
}

function normalizeCategoryOverrides(value = []) {
  return normalizeIndexedCollection(value).map(entry => ({
    id: String(entry?.id ?? "").trim() || foundry.utils.randomID(),
    category: String(entry?.category ?? "").trim(),
    sell: normalizeAdjustment(entry?.sell, "increase"),
    buy: normalizeAdjustment(entry?.buy, "decrease")
  }));
}

function normalizeItemOverrides(value = [], primaryCurrencyKey = "") {
  return normalizeIndexedCollection(value).map(entry => ({
    id: String(entry?.id ?? "").trim() || foundry.utils.randomID(),
    itemUuid: String(entry?.itemUuid ?? "").trim(),
    itemId: String(entry?.itemId ?? "").trim(),
    name: String(entry?.name ?? "").trim(),
    img: String(entry?.img ?? "").trim(),
    mode: TRADE_OVERRIDE_MODES.has(entry?.mode) ? entry.mode : "percent",
    sell: normalizeAdjustment(entry?.sell, "increase"),
    buy: normalizeAdjustment(entry?.buy, "decrease"),
    fixedSell: normalizeFixedPrice(entry?.fixedSell, primaryCurrencyKey),
    fixedBuy: normalizeFixedPrice(entry?.fixedBuy, primaryCurrencyKey)
  }));
}

function normalizeFixedPrice(value = {}, primaryCurrencyKey = "") {
  return {
    value: Math.max(0, toInteger(value?.value)),
    currencyKey: String(value?.currencyKey ?? primaryCurrencyKey).trim() || primaryCurrencyKey
  };
}

function normalizeIndexedCollection(value = []) {
  if (Array.isArray(value)) return value.filter(entry => entry && typeof entry === "object");
  if (!value || typeof value !== "object") return [];
  return Object.keys(value)
    .filter(key => !key.startsWith("-="))
    .sort((left, right) => Number(left) - Number(right))
    .map(key => value[key])
    .filter(entry => entry && typeof entry === "object");
}

function adjustmentToSignedPercent(adjustment = {}) {
  const percent = Math.max(0, Math.abs(toInteger(adjustment.percent)));
  return adjustment.direction === "decrease" ? -percent : percent;
}
