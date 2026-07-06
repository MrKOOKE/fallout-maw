import { getDamageTypeSettings } from "../settings/accessors.mjs";
import { activateFormulaAutocomplete } from "../apps/formula-autocomplete.mjs";
import { getCharacteristicSettings, getSkillSettings } from "../settings/accessors.mjs";
import { isFormulaTextConfigured } from "../utils/actor-formulas.mjs";
import { toInteger } from "../utils/numbers.mjs";
import {
  preserveTextSelectionBeforePartSync,
  restoreTextSelectionAfterPartSync
} from "../utils/application-focus-state.mjs";

export class PeriodicDamageRegionBehaviorConfig extends foundry.applications.sheets.RegionBehaviorConfig {
  static DEFAULT_OPTIONS = foundry.utils.mergeObject(super.DEFAULT_OPTIONS, {
    classes: ["region-behavior-config", "fallout-maw-periodic-damage-region-config"],
    position: { width: 660 },
    actions: {
      addDamageEntry: this.#onAddDamageEntry,
      deleteDamageEntry: this.#onDeleteDamageEntry
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

  _preSyncPartState(partId, newElement, priorElement, state) {
    super._preSyncPartState(partId, newElement, priorElement, state);
    preserveTextSelectionBeforePartSync(priorElement, state);
  }

  _syncPartState(partId, newElement, priorElement, state) {
    super._syncPartState(partId, newElement, priorElement, state);
    restoreTextSelectionAfterPartSync(newElement, state);
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const source = this.document.toObject();
    const system = source.system ?? {};
    const damageTypes = getConfigurableDamageTypes(getDamageTypeSettings());
    const damageEntries = normalizeDamageEntries(system.damageEntries);

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

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
