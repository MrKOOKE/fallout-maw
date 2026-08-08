import { getDamageTypeSettings } from "../settings/accessors.mjs";
import { activateFormulaAutocomplete } from "../apps/formula-autocomplete.mjs";
import { getCharacteristicSettings, getSkillSettings } from "../settings/accessors.mjs";
import { isFormulaTextConfigured } from "../utils/actor-formulas.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { normalizeRegionSpecialProperties } from "../utils/region-special-properties.mjs";

export class PeriodicDamageRegionBehaviorConfig extends foundry.applications.sheets.RegionBehaviorConfig {
  static DEFAULT_OPTIONS = foundry.utils.mergeObject(super.DEFAULT_OPTIONS, {
    classes: ["region-behavior-config", "fallout-maw-periodic-damage-region-config"],
    position: { width: 660 },
    actions: {
      addDamageEntry: this.#onAddDamageEntry,
      deleteDamageEntry: this.#onDeleteDamageEntry,
      addRegionSpecialProperty: this.#onAddRegionSpecialProperty,
      deleteRegionSpecialProperty: this.#onDeleteRegionSpecialProperty
    }
  }, { inplace: false });

  static PARTS = {
    form: {
      template: "systems/fallout-maw/templates/region-behavior/periodic-damage-config.hbs",
      scrollable: [""]
    },
    footer: {
      template: "templates/generic/form-footer.hbs"
    }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const source = this.document.toObject();
    const system = source.system ?? {};
    const damageTypes = getConfigurableDamageTypes(getDamageTypeSettings());
    const damageEntries = normalizeDamageEntries(system.damageEntries);
    const regionSpecialProperties = normalizeRegionSpecialProperties(system.regionSpecialProperties);

    return {
      ...context,
      source,
      behavior: this.document,
      system,
      damageEntries: damageEntries.map((entry, index) => ({
        ...entry,
        index,
        damageTypeChoices: buildDamageTypeChoices(damageTypes, entry.damageTypeKey)
      })),
      regionSpecialProperties: regionSpecialProperties.map((property, index) => ({ ...property, index })),
      buttons: this._getButtons()
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    activateFormulaAutocomplete(this.element, {
      characteristics: getCharacteristicSettings(),
      skills: getSkillSettings()
    });
  }

  _processFormData(_event, _form, formData) {
    const data = foundry.utils.expandObject(formData.object ?? {});
    const system = data.system ?? {};
    system.damageEntries = normalizeDamageEntries(system.damageEntries);
    system.regionSpecialProperties = normalizeRegionSpecialProperties(system.regionSpecialProperties);
    system.intervalSeconds = Math.max(1, toInteger(system.intervalSeconds) || 6);
    system.delaySeconds = Math.max(0, toInteger(system.delaySeconds));
    system.durationSeconds = Math.max(0, toInteger(system.durationSeconds));
    system.radiusDeltaMeters = Number(system.radiusDeltaMeters) || 0;
    system.deleteRegionWhenExpired = Boolean(system.deleteRegionWhenExpired);
    data.system = system;
    data.disabled = Boolean(data.disabled);
    return data;
  }

  static async #onAddDamageEntry(event) {
    event.preventDefault();
    const damageTypes = getConfigurableDamageTypes(getDamageTypeSettings());
    const entries = this.#getFormDamageEntries();
    entries.push({
      damageTypeKey: damageTypes[0]?.key ?? "",
      amount: "0"
    });
    this.#renderDamageEntries(entries);
  }

  static async #onDeleteDamageEntry(event) {
    event.preventDefault();
    const entries = this.#getFormDamageEntries();
    const row = event.target.closest("[data-damage-entry-index]");
    const index = Number(row?.dataset.damageEntryIndex);
    if (Number.isInteger(index) && index >= 0) entries.splice(index, 1);
    this.#renderDamageEntries(entries);
  }

  static async #onAddRegionSpecialProperty(event) {
    event.preventDefault();
    const current = normalizeRegionSpecialProperties(this.#getFormRegionSpecialProperties());
    if (!current.length) current.push({ type: "smoke", smoke: { thickness: "1", densityPercent: "50" } });
    this.#renderRegionSpecialProperties(current);
  }

  static async #onDeleteRegionSpecialProperty(event) {
    event.preventDefault();
    const row = event.target.closest("[data-region-special-property-index]");
    const index = Number(row?.dataset.regionSpecialPropertyIndex);
    const current = normalizeRegionSpecialProperties(this.#getFormRegionSpecialProperties());
    if (Number.isInteger(index) && index >= 0) current.splice(index, 1);
    this.#renderRegionSpecialProperties(current);
  }

  #getFormDamageEntries() {
    const formData = new foundry.applications.ux.FormDataExtended(this.form);
    const data = foundry.utils.expandObject(formData.object ?? {});
    return normalizeDamageEntries(data.system?.damageEntries);
  }

  #renderDamageEntries(entries = []) {
    const container = this.form?.querySelector(".fallout-maw-damage-entry-list");
    if (!container) return;
    const damageTypes = getConfigurableDamageTypes(getDamageTypeSettings());
    container.innerHTML = entries.length
      ? entries.map((entry, index) => renderDamageEntryRow(entry, index, damageTypes)).join("")
      : `<p class="fallout-maw-empty-list">${escapeHtml(game.i18n.localize("FALLOUTMAW.RegionBehavior.PeriodicDamage.NoDamageEntries"))}</p>`;
    activateFormulaAutocomplete(container, {
      characteristics: getCharacteristicSettings(),
      skills: getSkillSettings()
    });
  }

  #getFormRegionSpecialProperties() {
    const formData = new foundry.applications.ux.FormDataExtended(this.form);
    const data = foundry.utils.expandObject(formData.object ?? {});
    return data.system?.regionSpecialProperties;
  }

  #renderRegionSpecialProperties(properties = []) {
    const container = this.form?.querySelector(".fallout-maw-region-special-property-list");
    if (!container) return;
    container.innerHTML = properties.length
      ? properties.map((property, index) => renderRegionSpecialPropertyRow(property, index)).join("")
      : `<p class="fallout-maw-empty-list">${escapeHtml(game.i18n.localize("FALLOUTMAW.RegionBehavior.PeriodicDamage.NoSpecialProperties"))}</p>`;
  }
}

function getConfigurableDamageTypes(damageTypes = []) {
  return damageTypes.filter(damageType => !damageType?.locked && !damageType?.system);
}

function buildDamageTypeChoices(damageTypes = [], selected = "") {
  return damageTypes.map(damageType => ({
    value: damageType.key,
    label: damageType.label,
    selected: damageType.key === selected
  }));
}

function normalizeDamageEntries(entries = []) {
  const values = Array.isArray(entries) ? entries : Object.values(entries ?? {});
  return values
    .map(entry => ({
      damageTypeKey: String(entry?.damageTypeKey ?? "").trim(),
      amount: normalizeDamageFormula(entry?.amount)
    }))
    .filter(entry => entry.damageTypeKey || isFormulaTextConfigured(entry.amount));
}

function renderDamageEntryRow(entry, index, damageTypes = []) {
  const selected = String(entry?.damageTypeKey ?? "").trim();
  const options = damageTypes.map(damageType => {
    const value = String(damageType.key ?? "");
    const label = String(damageType.label ?? value);
    return `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`;
  }).join("");
  return `
    <div class="fallout-maw-settings-row" data-damage-entry-index="${index}">
      <select name="system.damageEntries.${index}.damageTypeKey">${options}</select>
      <input type="text" name="system.damageEntries.${index}.amount" value="${escapeHtml(normalizeDamageFormula(entry?.amount))}" data-formula-autocomplete="all">
      <button type="button" class="fallout-maw-icon-delete-button" data-action="deleteDamageEntry" title="${escapeHtml(game.i18n.localize("FALLOUTMAW.Common.Delete"))}"><i class="fa-solid fa-trash"></i></button>
    </div>
  `;
}

function normalizeDamageFormula(value) {
  return String(value ?? "0").trim() || "0";
}

function renderRegionSpecialPropertyRow(property, index) {
  return `
    <div class="fallout-maw-settings-row fallout-maw-region-special-property-row" data-region-special-property-index="${index}">
      <span>${escapeHtml(game.i18n.localize("FALLOUTMAW.RegionBehavior.PeriodicDamage.Smoke"))}</span>
      <label><span>${escapeHtml(game.i18n.localize("FALLOUTMAW.RegionBehavior.PeriodicDamage.SmokeThickness"))}</span><input type="number" min="0" max="1" step="0.01" name="system.regionSpecialProperties.${index}.smoke.thickness" value="${escapeHtml(property.smoke?.thickness ?? "1")}"></label>
      <label><span>${escapeHtml(game.i18n.localize("FALLOUTMAW.RegionBehavior.PeriodicDamage.SmokeDensity"))}</span><input type="number" min="0" max="100" step="1" name="system.regionSpecialProperties.${index}.smoke.densityPercent" value="${escapeHtml(property.smoke?.densityPercent ?? "50")}"></label>
      <button type="button" class="fallout-maw-icon-delete-button" data-action="deleteRegionSpecialProperty" title="${escapeHtml(game.i18n.localize("FALLOUTMAW.Common.Delete"))}"><i class="fa-solid fa-trash"></i></button>
    </div>
  `;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
