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
    if (!damageEntries.length) {
      damageEntries.push({
        damageTypeKey: String(system.damageTypeKey ?? damageTypes[0]?.key ?? "").trim(),
        amount: Math.max(0, toInteger(system.damage))
      });
    }

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
    system.damage = Math.max(0, toInteger(system.damage));
    system.damageTypeKey = String(system.damageTypeKey ?? "").trim();
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
    const data = this.#getSubmittedData();
    const damageTypes = getDamageTypeSettings();
    data.system.damageEntries.push({
      damageTypeKey: damageTypes[0]?.key ?? "",
      amount: 0
    });
    await this.document.update(data);
    return this.render({ force: true });
  }

  static async #onDeleteDamageEntry(event) {
    event.preventDefault();
    const data = this.#getSubmittedData();
    const row = event.target.closest("[data-damage-entry-index]");
    const index = Number(row?.dataset.damageEntryIndex);
    if (Number.isInteger(index) && index >= 0) data.system.damageEntries.splice(index, 1);
    await this.document.update(data);
    return this.render({ force: true });
  }

  #getSubmittedData() {
    const formData = new foundry.applications.ux.FormDataExtended(this.form);
    return this._processFormData(null, this.form, formData);
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
