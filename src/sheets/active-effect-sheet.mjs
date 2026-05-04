import { activateEffectKeyAutocomplete, createEffectKeyToken } from "../apps/effect-key-autocomplete.mjs";
import { TEMPLATES } from "../constants.mjs";
import {
  getCharacteristicSettings,
  getNeedSettings,
  getProficiencySettings,
  getResourceSettings,
  getSkillSettings
} from "../settings/accessors.mjs";

const { ActiveEffectConfig } = foundry.applications.sheets;
const FormDataExtended = foundry.applications.ux.FormDataExtended;

export class FalloutMaWActiveEffectSheet extends ActiveEffectConfig {
  static DEFAULT_OPTIONS = foundry.utils.mergeObject(super.DEFAULT_OPTIONS, {
    classes: ["fallout-maw", "fallout-maw-sheet", "fallout-maw-active-effect-sheet", "active-effect-config"],
    position: {
      width: 760,
      height: 620
    },
    form: {
      closeOnSubmit: true
    },
    window: {
      resizable: true
    },
    actions: {
      addChange: this.#onAddChange,
      deleteChange: this.#onDeleteChange
    }
  }, { inplace: false });

  static PARTS = {
    body: {
      template: TEMPLATES.activeEffectSheet,
      scrollable: [".fallout-maw-active-effect-body"]
    }
  };

  static TABS = {
    primary: {
      tabs: [
        { id: "main", group: "primary", label: "FALLOUTMAW.Effects.MainTab" },
        { id: "effects", group: "primary", label: "FALLOUTMAW.Effects.EffectsTab" }
      ],
      initial: "main"
    }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const source = this.document.toObject();
    const changes = foundry.utils.deepClone(this.document.system?.changes ?? source.system?.changes ?? source.changes ?? []);

    return foundry.utils.mergeObject(context, {
      effect: this.document,
      source,
      editable: this.isEditable,
      kindChoices: buildKindChoices(this.document.getFlag("fallout-maw", "kind") || getEffectKind(this.document)),
      durationUnitChoices: buildDurationUnitChoices(source.duration?.units ?? ""),
      expiryChoices: buildExpiryChoices(source.duration?.expiry ?? ""),
      changeTypeChoices: buildChangeTypeChoices(),
      changes: changes.map((change, index) => prepareChangeContext(change, index))
    }, { inplace: false });
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    activateEffectKeyAutocomplete(this.element, buildEffectKeyTokens());
  }

  static async #onAddChange() {
    const changes = this.#getSubmittedChanges();
    changes.push({ key: "", type: "add", value: "0", phase: "initial", priority: null });
    return this.submit({ updateData: { system: { changes } } });
  }

  static async #onDeleteChange(event) {
    const changes = this.#getSubmittedChanges();
    const row = event.target.closest("[data-change-index]");
    const index = Number(row?.dataset.changeIndex) || 0;
    changes.splice(index, 1);
    return this.submit({ updateData: { system: { changes } } });
  }

  #getSubmittedChanges() {
    const formData = new FormDataExtended(this.form);
    const submitData = this._processFormData(null, this.form, formData);
    return Object.values(submitData.system?.changes ?? {});
  }
}

function prepareChangeContext(change, index) {
  const type = String(change?.type || "add");
  const phase = String(change?.phase || "initial");
  return {
    index,
    key: String(change?.key ?? ""),
    type,
    phase,
    value: stringifyChangeValue(change?.value),
    priority: change?.priority ?? "",
    priorityPlaceholder: ActiveEffect.CHANGE_TYPES[type]?.defaultPriority ?? "",
    paths: {
      key: `system.changes.${index}.key`,
      type: `system.changes.${index}.type`,
      phase: `system.changes.${index}.phase`,
      value: `system.changes.${index}.value`,
      priority: `system.changes.${index}.priority`
    },
    typeChoices: buildChangeTypeChoices(type)
  };
}

function stringifyChangeValue(value) {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function buildKindChoices(selected) {
  return [
    { value: "temporary", label: game.i18n.localize("FALLOUTMAW.Effects.KindTemporary"), selected: selected === "temporary" },
    { value: "active", label: game.i18n.localize("FALLOUTMAW.Effects.KindActive"), selected: selected === "active" },
    { value: "passive", label: game.i18n.localize("FALLOUTMAW.Effects.KindPassive"), selected: selected === "passive" }
  ];
}

function buildDurationUnitChoices(selected) {
  return [
    { value: "", label: "", selected: selected === "" },
    { value: "rounds", label: game.i18n.localize("FALLOUTMAW.Effects.DurationUnits.Rounds"), selected: selected === "rounds" },
    { value: "turns", label: game.i18n.localize("FALLOUTMAW.Effects.DurationUnits.Turns"), selected: selected === "turns" },
    { value: "seconds", label: game.i18n.localize("FALLOUTMAW.Effects.DurationUnits.Seconds"), selected: selected === "seconds" },
    { value: "minutes", label: game.i18n.localize("FALLOUTMAW.Effects.DurationUnits.Minutes"), selected: selected === "minutes" },
    { value: "hours", label: game.i18n.localize("FALLOUTMAW.Effects.DurationUnits.Hours"), selected: selected === "hours" },
    { value: "days", label: game.i18n.localize("FALLOUTMAW.Effects.DurationUnits.Days"), selected: selected === "days" }
  ];
}

function buildExpiryChoices(selected) {
  return [
    { value: "", label: "", selected: selected === "" },
    { value: "turnStart", label: game.i18n.localize("FALLOUTMAW.Effects.ExpiryEvents.TurnStart"), selected: selected === "turnStart" },
    { value: "turnEnd", label: game.i18n.localize("FALLOUTMAW.Effects.ExpiryEvents.TurnEnd"), selected: selected === "turnEnd" }
  ];
}

function buildChangeTypeChoices(selected = "") {
  return [
    { value: "add", label: game.i18n.localize("FALLOUTMAW.Effects.ChangeAdd"), selected: selected === "add" },
    { value: "override", label: game.i18n.localize("FALLOUTMAW.Effects.ChangeOverride"), selected: selected === "override" }
  ];
}

function getEffectKind(effect) {
  if (effect.disabled) return "active";
  if (effect.isTemporary) return "temporary";
  return "active";
}

function buildEffectKeyTokens() {
  return [
    ...getCharacteristicSettings().map(entry => createEffectKeyToken({
      code: entry.abbr || entry.key,
      key: entry.key,
      label: entry.label,
      path: `system.characteristics.${entry.key}`,
      group: game.i18n.localize("FALLOUTMAW.Common.Characteristics")
    })),
    ...getSkillSettings().map(entry => createEffectKeyToken({
      code: entry.abbr || entry.key,
      key: entry.key,
      label: entry.label,
      path: `system.skills.${entry.key}.bonus`,
      group: game.i18n.localize("FALLOUTMAW.Common.Skills")
    })),
    ...getResourceSettings().map(entry => createEffectKeyToken({
      code: entry.abbr || entry.key,
      key: entry.key,
      label: entry.label,
      path: `system.resources.${entry.key}.bonus`,
      group: game.i18n.localize("FALLOUTMAW.Common.Resources")
    })),
    ...getNeedSettings().map(entry => createEffectKeyToken({
      code: entry.abbr || entry.key,
      key: entry.key,
      label: entry.label,
      path: `system.needs.${entry.key}.bonus`,
      group: game.i18n.localize("FALLOUTMAW.Common.Needs")
    })),
    ...getProficiencySettings().map(entry => createEffectKeyToken({
      code: entry.abbr || entry.key,
      key: entry.key,
      label: entry.label,
      path: `system.proficiencies.${entry.key}.bonus`,
      group: game.i18n.localize("FALLOUTMAW.Common.Proficiencies")
    }))
  ].filter(Boolean);
}
