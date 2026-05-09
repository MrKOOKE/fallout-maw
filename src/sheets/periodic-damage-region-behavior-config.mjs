import { getDamageTypeSettings } from "../settings/accessors.mjs";
import { toInteger } from "../utils/numbers.mjs";

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

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const source = this.document.toObject();
    const system = source.system ?? {};
    const damageTypes = getDamageTypeSettings();
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
    const damageTypes = getDamageTypeSettings();
    const entries = this.#getFormDamageEntries();
    entries.push({
      damageTypeKey: damageTypes[0]?.key ?? "",
      amount: 0
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
    const damageTypes = getDamageTypeSettings();
    container.innerHTML = entries.length
      ? entries.map((entry, index) => renderDamageEntryRow(entry, index, damageTypes)).join("")
      : `<p class="fallout-maw-empty-list">${escapeHtml(game.i18n.localize("FALLOUTMAW.RegionBehavior.PeriodicDamage.NoDamageEntries"))}</p>`;
  }
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
      amount: Math.max(0, toInteger(entry?.amount))
    }))
    .filter(entry => entry.damageTypeKey || entry.amount > 0);
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
      <input type="number" name="system.damageEntries.${index}.amount" value="${Math.max(0, toInteger(entry?.amount))}" min="0" step="1">
      <button type="button" data-action="deleteDamageEntry" title="${escapeHtml(game.i18n.localize("FALLOUTMAW.Common.Delete"))}"><i class="fa-solid fa-trash"></i></button>
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
