import { TEMPLATES } from "../constants.mjs";
import { IDENTIFIER_PATTERN, validateFormula } from "../formulas/index.mjs";
import {
  getAbilityCatalog,
  getCharacteristicSettings,
  getCreatureOptions,
  getDamageTypeSettings,
  getNeedSettings,
  getProficiencySettings,
  getResourceSettings,
  getSkillSettings,
  setCreatureOptions
} from "../settings/accessors.mjs";
import {
  createDefaultInventorySize,
  createDefaultRaceBaseParameters,
  createDefaultRegeneration,
  createRaceDefaults,
  DEFAULT_BLEEDING_RESISTANCE_FORMULA,
  DEFAULT_REGENERATION_FORMULA
} from "../settings/creature-options.mjs";
import { format, localize } from "../utils/i18n.mjs";
import { LOCKED_FEATURES_CATEGORY_ID } from "../settings/abilities.mjs";
import {
  createDefaultNaturalItemSetEntry,
  createDefaultNaturalFeatureEntry,
  createDefaultNaturalWeaponEntry,
  createNaturalFeatureEntryFromCatalogAbility,
  normalizeNaturalRaceItemData,
  NATURAL_RACE_ITEM_KINDS
} from "../races/natural-items.mjs";
import { buildActionCostEffectKeyTokens, buildCombatEffectKeyTokens, buildDamageMitigationEffectKeyTokens } from "../utils/effect-key-tokens.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { FalloutMaWFormApplicationV2, getExpandedFormData } from "./base-form-application-v2.mjs";
import { activateEffectKeyAutocomplete, createEffectKeyToken } from "./effect-key-autocomplete.mjs";
import { activateFormulaAutocomplete } from "./formula-autocomplete.mjs";
import { LimbSilhouetteConfig } from "./limb-silhouette-config.mjs";
import { NeedAdvancedSettingsConfig } from "./need-settings-config.mjs";

const { DialogV2 } = foundry.applications.api;
const { FormDataExtended } = foundry.applications.ux;
const CREATURE_SECTION_KEYS = Object.freeze(["type", "race", "base", "development", "regeneration", "limbs", "equipment", "natural", "inventory", "resistances", "needs"]);

export class CreatureOptionsConfig extends FalloutMaWFormApplicationV2 {
  #editorMode = "type";
  #expandedSections = new Set();

  constructor(options = {}) {
    super(options);
    this.creatureOptions = getCreatureOptions();
    this.activeTypeId = this.creatureOptions.types[0]?.id ?? "";
    this.activeRaceId = this.creatureOptions.races.find(race => race.typeId === this.activeTypeId)?.id ?? "";
    this.#editorMode = this.activeRaceId ? "race" : "type";
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-creature-options",
    classes: ["fallout-maw", "fallout-maw-config-form", "fallout-maw-creature-options", "creature-options-config"],
    position: {
      width: 980,
      height: "auto"
    },
    window: {
      resizable: true
    },
    actions: {
      selectType: this.#onSelectType,
      selectRace: this.#onSelectRace,
      createType: this.#onCreateType,
      createRace: this.#onCreateRace,
      createLimb: this.#onCreateLimb,
      deleteLimb: this.#onDeleteLimb,
      openLimbSettings: this.#onOpenLimbSettings,
      configureLimbSilhouette: this.#onConfigureLimbSilhouette,
      createEquipmentSlot: this.#onCreateEquipmentSlot,
      deleteEquipmentSlot: this.#onDeleteEquipmentSlot,
      createWeaponSet: this.#onCreateWeaponSet,
      deleteWeaponSet: this.#onDeleteWeaponSet,
      createWeaponSlot: this.#onCreateWeaponSlot,
      deleteWeaponSlot: this.#onDeleteWeaponSlot,
      createNaturalSet: this.#onCreateNaturalSet,
      createNaturalWeapon: this.#onCreateNaturalWeapon,
      editNaturalWeapon: this.#onEditNaturalWeapon,
      deleteNaturalWeapon: this.#onDeleteNaturalWeapon,
      addNaturalFeature: this.#onAddNaturalFeature,
      editNaturalFeature: this.#onEditNaturalFeature,
      deleteNaturalFeature: this.#onDeleteNaturalFeature,
      createRaceNeed: this.#onCreateRaceNeed,
      deleteRaceNeed: this.#onDeleteRaceNeed,
      openRaceNeedSettings: this.#onOpenRaceNeedSettings,
      deleteType: this.#onDeleteType,
      deleteRace: this.#onDeleteRace
    }
  };

  static PARTS = {
    form: {
      template: TEMPLATES.settings.creatureOptions
    }
  };

  get title() {
    return localize("FALLOUTMAW.Settings.CreatureOptions.Title");
  }

  async _prepareContext(options) {
    const characteristics = getCharacteristicSettings();
    const damageTypes = getDamageTypeSettings();
    const configurableDamageTypes = getConfigurableDamageTypes(damageTypes);
    const selectedType = this.creatureOptions.types.find(type => type.id === this.activeTypeId) ?? this.creatureOptions.types[0] ?? null;
    const racesForType = selectedType ? this.creatureOptions.races.filter(race => race.typeId === selectedType.id) : [];
    const selectedRace = this.#editorMode === "race"
      ? (racesForType.find(race => race.id === this.activeRaceId) ?? racesForType[0] ?? null)
      : null;

    this.activeTypeId = selectedType?.id ?? "";
    this.activeRaceId = selectedRace?.id ?? "";

    return {
      ...(await super._prepareContext(options)),
      creatureOptions: this.creatureOptions,
      editingType: Boolean(selectedType) && (!selectedRace || (this.#editorMode === "type")),
      editingRace: Boolean(selectedRace) && (this.#editorMode === "race"),
      sections: Object.fromEntries(CREATURE_SECTION_KEYS.map(key => [key, this.#getSectionState(key)])),
      selectedType,
      selectedRace,
      typeOptions: this.creatureOptions.types.map(type => ({ ...type, selected: type.id === this.activeTypeId })),
      raceOptions: racesForType.map(race => ({ ...race, selected: race.id === this.activeRaceId })),
      raceGroups: this.creatureOptions.types
        .map(type => ({
          ...type,
          races: this.creatureOptions.races
            .filter(race => race.typeId === type.id)
            .map(race => ({ ...race, selected: race.id === this.activeRaceId }))
        }))
        .filter(group => group.races.length),
      characteristics: characteristics.map(characteristic => ({
        ...characteristic,
        value: toInteger(selectedRace?.characteristics?.[characteristic.key])
      })),
      baseParameters: selectedRace?.baseParameters ?? createDefaultRaceBaseParameters(),
      limbs: selectedRace?.limbs ?? [],
      hasLimbSilhouette: Boolean(selectedRace?.limbSilhouette),
      equipmentSlots: selectedRace?.equipmentSlots ?? [],
      weaponSets: (selectedRace?.weaponSets ?? []).map(set => ({
        ...set,
        slots: (set.slots ?? []).map(slot => ({
          ...slot,
          limbOptions: (selectedRace?.limbs ?? []).map(limb => ({
            ...limb,
            selected: limb.key === slot.limbKey
          }))
        }))
      })),
      naturalItemSets: (selectedRace?.naturalItemSets ?? []).map(set => prepareNaturalItemSetRow(set)),
      inventorySize: selectedRace?.inventorySize ?? createDefaultInventorySize(),
      regeneration: selectedRace?.regeneration ?? createDefaultRegeneration(),
      resistanceDamageTypes: configurableDamageTypes.map(damageType => ({
        ...damageType,
        formula: String(selectedRace?.damageResistances?.[damageType.key] ?? "0")
      })),
      bleedingResistanceFormula: String(selectedRace?.bleedingResistanceFormula ?? DEFAULT_BLEEDING_RESISTANCE_FORMULA),
      needSettings: selectedRace?.needSettings ?? []
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    activateFormulaAutocomplete(this.element, {
      characteristics: getCharacteristicSettings(),
      skills: getSkillSettings()
    });
    this.#activateCollapsibleSections();
  }

  async _processFormData(_event, _form, formData) {
    const expanded = getExpandedFormData(formData);
    if (this.#editorMode === "type") this.#updateActiveType(expanded);
    if (this.#editorMode === "race") this.#updateActiveRace(expanded);
    this.#validateRaceFormulas();
    return this.#saveAndRender(localize("FALLOUTMAW.Messages.CreatureOptionsSaved"));
  }

  static #onSelectType(event, target) {
    event.preventDefault();
    this.#updateFromCurrentForm();
    this.activeTypeId = target.dataset.id ?? "";
    this.activeRaceId = "";
    this.#editorMode = "type";
    return this.forceRender();
  }

  static #onSelectRace(event, target) {
    event.preventDefault();
    this.#updateFromCurrentForm();
    const raceId = target.dataset.id ?? "";
    const race = this.creatureOptions.races.find(entry => entry.id === raceId);
    if (!race) return undefined;
    this.activeTypeId = race.typeId;
    this.activeRaceId = race.id;
    this.#editorMode = "race";
    return this.forceRender();
  }

  static #onCreateType(event) {
    event.preventDefault();
    this.#updateFromCurrentForm();

    const id = getUniqueId("newType", this.creatureOptions.types.map(type => type.id));
    this.creatureOptions.types.push({ id, name: localize("FALLOUTMAW.Settings.CreatureOptions.NewType") });
    this.activeTypeId = id;
    this.activeRaceId = "";
    this.#editorMode = "type";
    return this.forceRender();
  }

  static #onCreateRace(event) {
    event.preventDefault();
    this.#updateFromCurrentForm();

    const typeId = this.activeTypeId || this.creatureOptions.types[0]?.id;
    if (!typeId) {
      ui.notifications.warn(localize("FALLOUTMAW.Messages.CreateTypeFirst"));
      return undefined;
    }

    const id = getUniqueId("newRace", this.creatureOptions.races.map(race => race.id));
    this.creatureOptions.races.push({
      id,
      typeId,
      name: localize("FALLOUTMAW.Settings.CreatureOptions.NewRace"),
      ...createRaceDefaults(getCharacteristicSettings(), getDamageTypeSettings())
    });
    this.activeTypeId = typeId;
    this.activeRaceId = id;
    this.#editorMode = "race";
    return this.forceRender();
  }

  static async #onDeleteType(event, target) {
    event.preventDefault();
    const typeId = target.dataset.id;
    if (!typeId) return undefined;

    const confirmed = await DialogV2.confirm({
      window: { title: localize("FALLOUTMAW.Settings.CreatureOptions.DeleteType") },
      content: `<p>${format("FALLOUTMAW.Settings.CreatureOptions.DeleteTypeConfirm", { id: typeId })}</p>`,
      rejectClose: false,
      modal: true
    });
    if (!confirmed) return undefined;

    this.creatureOptions.types = this.creatureOptions.types.filter(type => type.id !== typeId);
    this.creatureOptions.races = this.creatureOptions.races.filter(race => race.typeId !== typeId);
    this.activeTypeId = this.creatureOptions.types[0]?.id ?? "";
    this.activeRaceId = this.creatureOptions.races.find(race => race.typeId === this.activeTypeId)?.id ?? "";
    this.#editorMode = this.activeRaceId ? "race" : "type";
    return this.#saveAndRender(localize("FALLOUTMAW.Messages.CreatureOptionsSaved"));
  }

  static async #onDeleteRace(event, target) {
    event.preventDefault();
    const raceId = target.dataset.id;
    if (!raceId) return undefined;

    const confirmed = await DialogV2.confirm({
      window: { title: localize("FALLOUTMAW.Settings.CreatureOptions.DeleteRace") },
      content: `<p>${format("FALLOUTMAW.Settings.CreatureOptions.DeleteRaceConfirm", { id: raceId })}</p>`,
      rejectClose: false,
      modal: true
    });
    if (!confirmed) return undefined;

    const race = this.creatureOptions.races.find(entry => entry.id === raceId);
    this.creatureOptions.races = this.creatureOptions.races.filter(entry => entry.id !== raceId);
    this.activeTypeId = race?.typeId ?? this.activeTypeId;
    this.activeRaceId = this.creatureOptions.races.find(entry => entry.typeId === race?.typeId)?.id ?? "";
    this.#editorMode = this.activeRaceId ? "race" : "type";
    return this.#saveAndRender(localize("FALLOUTMAW.Messages.CreatureOptionsSaved"));
  }

  static #onCreateEquipmentSlot(event) {
    event.preventDefault();
    this.#updateFromCurrentForm();
    const race = this.#activeRace;
    if (!race) return undefined;
    const id = getUniqueId("equipmentSlot", (race.equipmentSlots ?? []).map(slot => slot.key));
    race.equipmentSlots ??= [];
    race.equipmentSlots.push({ key: id, label: localize("FALLOUTMAW.Settings.CreatureOptions.NewEquipmentSlot") });
    return this.forceRender();
  }

  static #onCreateLimb(event) {
    event.preventDefault();
    this.#updateFromCurrentForm();
    const race = this.#activeRace;
    if (!race) return undefined;
    const id = getUniqueId("limb", (race.limbs ?? []).map(limb => limb.key));
    race.limbs ??= [];
    race.limbs.push({
      key: id,
      label: "Новая конечность",
      stateMax: "100 + con * 5",
      damageMultiplier: 1,
      aimedDifficultyPercent: 0,
      critical: false,
      lossEffects: []
    });
    return this.forceRender();
  }

  static #onDeleteLimb(event, target) {
    event.preventDefault();
    const key = target.closest("[data-limb-row]")?.querySelector("[data-field='key']")?.value?.trim()
      || target.dataset.key
      || "";
    this.#updateFromCurrentForm();
    const race = this.#activeRace;
    if (!race) return undefined;
    race.limbs = (race.limbs ?? []).filter(limb => limb.key !== key);
    if (race.limbSilhouette) {
      race.limbSilhouette.parts = (race.limbSilhouette.parts ?? []).filter(part => part.limbKey !== key);
    }
    return this.forceRender();
  }

  static #onOpenLimbSettings(event, target) {
    event.preventDefault();
    const rows = Array.from(this.form?.querySelectorAll("[data-limb-row]") ?? []);
    const index = rows.indexOf(target.closest("[data-limb-row]"));
    this.#updateFromCurrentForm();
    const race = this.#activeRace;
    const limb = race?.limbs?.[index];
    if (!limb) return undefined;

    return new LimbSettingsConfig({
      limb,
      onSave: settings => {
        this.#updateFromCurrentForm();
        const activeRace = this.#activeRace;
        if (!activeRace?.limbs?.[index]) return;
        Object.assign(activeRace.limbs[index], settings);
        this.forceRender();
      }
    }).render({ force: true });
  }

  static #onConfigureLimbSilhouette(event) {
    event.preventDefault();
    this.#updateFromCurrentForm();
    const race = this.#activeRace;
    if (!race) return undefined;
    if (!(race.limbs ?? []).length) {
      ui.notifications.warn("Сначала добавьте хотя бы одну конечность.");
      return undefined;
    }

    const app = new LimbSilhouetteConfig({
      race,
      onSave: async silhouette => {
        race.limbSilhouette = silhouette;
        await this.#saveAndRender(localize("FALLOUTMAW.Messages.CreatureOptionsSaved"));
      }
    });
    return app.render({ force: true });
  }

  static #onDeleteEquipmentSlot(event, target) {
    event.preventDefault();
    this.#updateFromCurrentForm();
    const race = this.#activeRace;
    if (!race) return undefined;
    const key = target.dataset.key ?? "";
    race.equipmentSlots = (race.equipmentSlots ?? []).filter(slot => slot.key !== key);
    return this.forceRender();
  }

  static #onCreateWeaponSet(event) {
    event.preventDefault();
    this.#updateFromCurrentForm();
    const race = this.#activeRace;
    if (!race) return undefined;
    const id = getUniqueId("weaponSet", (race.weaponSets ?? []).map(set => set.key));
    race.weaponSets ??= [];
    race.weaponSets.push({
      key: id,
      label: localize("FALLOUTMAW.Settings.CreatureOptions.NewWeaponSet"),
      slots: []
    });
    return this.forceRender();
  }

  static #onDeleteWeaponSet(event, target) {
    event.preventDefault();
    this.#updateFromCurrentForm();
    const race = this.#activeRace;
    if (!race) return undefined;
    const key = target.dataset.key ?? "";
    race.weaponSets = (race.weaponSets ?? []).filter(set => set.key !== key);
    return this.forceRender();
  }

  static #onCreateWeaponSlot(event, target) {
    event.preventDefault();
    this.#updateFromCurrentForm();
    const race = this.#activeRace;
    if (!race) return undefined;
    const setKey = target.dataset.setKey ?? "";
    const weaponSet = (race.weaponSets ?? []).find(set => set.key === setKey);
    if (!weaponSet) return undefined;
    weaponSet.slots ??= [];
    const id = getUniqueId("weaponSlot", weaponSet.slots.map(slot => slot.key));
    weaponSet.slots.push({
      key: id,
      limbKey: race.limbs?.[0]?.key ?? ""
    });
    return this.forceRender();
  }

  static #onDeleteWeaponSlot(event, target) {
    event.preventDefault();
    this.#updateFromCurrentForm();
    const race = this.#activeRace;
    if (!race) return undefined;
    const setKey = target.dataset.setKey ?? "";
    const slotKey = target.dataset.slotKey ?? "";
    const weaponSet = (race.weaponSets ?? []).find(set => set.key === setKey);
    if (!weaponSet) return undefined;
    weaponSet.slots = (weaponSet.slots ?? []).filter(slot => slot.key !== slotKey);
    return this.forceRender();
  }

  static #onCreateNaturalSet(event) {
    event.preventDefault();
    this.#updateFromCurrentForm();
    const race = this.#activeRace;
    if (!race) return undefined;
    race.naturalItemSets ??= [];
    race.naturalItemSets.push(createDefaultNaturalItemSetEntry(race.naturalItemSets.map(set => set.id)));
    return this.forceRender();
  }

  static async #onCreateNaturalWeapon(event, target) {
    event.preventDefault();
    this.#updateFromCurrentForm();
    const naturalSet = this.#getNaturalSetFromTarget(target);
    if (!naturalSet) return undefined;
    naturalSet.naturalWeapons ??= [];
    const entry = createDefaultNaturalWeaponEntry();
    naturalSet.naturalWeapons.push(entry);
    await this.forceRender();
    return this.#openNaturalItemEditor(entry, NATURAL_RACE_ITEM_KINDS.weapon);
  }

  static #onEditNaturalWeapon(event, target) {
    event.preventDefault();
    this.#updateFromCurrentForm();
    const entry = this.#getNaturalItemEntryFromTarget(target, "naturalWeapons", "[data-natural-weapon-row]");
    if (!entry) return undefined;
    return this.#openNaturalItemEditor(entry, NATURAL_RACE_ITEM_KINDS.weapon);
  }

  static #onDeleteNaturalWeapon(event, target) {
    event.preventDefault();
    this.#updateFromCurrentForm();
    const naturalSet = this.#getNaturalSetFromTarget(target);
    if (!naturalSet) return undefined;
    const id = target.closest("[data-natural-weapon-row]")?.dataset.naturalItemId ?? "";
    naturalSet.naturalWeapons = (naturalSet.naturalWeapons ?? []).filter(entry => entry.id !== id);
    return this.forceRender();
  }

  static async #onAddNaturalFeature(event, target) {
    event.preventDefault();
    this.#updateFromCurrentForm();
    const naturalSet = this.#getNaturalSetFromTarget(target);
    if (!naturalSet) return undefined;
    naturalSet.naturalFeatures ??= [];
    const entry = await this.#chooseNaturalFeatureEntry();
    if (!entry) return undefined;
    naturalSet.naturalFeatures.push(entry);
    return this.forceRender();
  }

  static #onEditNaturalFeature(event, target) {
    event.preventDefault();
    this.#updateFromCurrentForm();
    const entry = this.#getNaturalItemEntryFromTarget(target, "naturalFeatures", "[data-natural-feature-row]");
    if (!entry) return undefined;
    return this.#openNaturalItemEditor(entry, NATURAL_RACE_ITEM_KINDS.feature);
  }

  static #onDeleteNaturalFeature(event, target) {
    event.preventDefault();
    this.#updateFromCurrentForm();
    const naturalSet = this.#getNaturalSetFromTarget(target);
    if (!naturalSet) return undefined;
    const id = target.closest("[data-natural-feature-row]")?.dataset.naturalItemId ?? "";
    naturalSet.naturalFeatures = (naturalSet.naturalFeatures ?? []).filter(entry => entry.id !== id);
    return this.forceRender();
  }

  static #onCreateRaceNeed(event) {
    event.preventDefault();
    this.#updateFromCurrentForm();
    const race = this.#activeRace;
    if (!race) return undefined;
    const key = getUniqueId("newNeed", (race.needSettings ?? []).map(need => need.key));
    const abbr = getUniqueId("new", (race.needSettings ?? []).map(need => need.abbr));
    race.needSettings ??= [];
    race.needSettings.push({
      key,
      abbr,
      label: "Новая потребность",
      formula: "0",
      color: "#8f8456",
      settings: { accumulation: { perHour: 10 }, thresholds: [], diseases: [] }
    });
    return this.forceRender();
  }

  static #onDeleteRaceNeed(event, target) {
    event.preventDefault();
    const row = target.closest("[data-race-need-row]");
    const rows = Array.from(this.form?.querySelectorAll("[data-race-need-row]") ?? []);
    const index = rows.indexOf(row);
    this.#updateFromCurrentForm();
    const race = this.#activeRace;
    if (!race || index < 0) return undefined;
    race.needSettings.splice(index, 1);
    return this.forceRender();
  }

  static #onOpenRaceNeedSettings(event, target) {
    event.preventDefault();
    const row = target.closest("[data-race-need-row]");
    const rows = Array.from(this.form?.querySelectorAll("[data-race-need-row]") ?? []);
    const index = rows.indexOf(row);
    this.#updateFromCurrentForm();
    const race = this.#activeRace;
    const need = race?.needSettings?.[index];
    if (!need) return undefined;

    return new NeedAdvancedSettingsConfig({
      need,
      onSave: settings => {
        this.#updateFromCurrentForm();
        const activeRace = this.#activeRace;
        if (!activeRace?.needSettings?.[index]) return;
        activeRace.needSettings[index].settings = settings;
        this.forceRender();
      }
    }).render({ force: true });
  }

  #getNaturalItemEntryFromTarget(target, property, selector) {
    const naturalSet = this.#getNaturalSetFromTarget(target);
    const id = target.closest(selector)?.dataset.naturalItemId ?? "";
    return (naturalSet?.[property] ?? []).find(entry => entry.id === id) ?? null;
  }

  #getNaturalSetFromTarget(target) {
    const setId = target.closest("[data-natural-set-row]")?.dataset.naturalSetId ?? "";
    const race = this.#activeRace;
    return (race?.naturalItemSets ?? []).find(set => set.id === setId) ?? null;
  }

  async #chooseNaturalFeatureEntry() {
    const catalog = getAbilityCatalog();
    const features = catalog.categories
      .find(category => category.id === LOCKED_FEATURES_CATEGORY_ID)
      ?.abilities ?? [];
    if (!features.length) return createDefaultNaturalFeatureEntry();

    const options = features
      .map(feature => `<option value="${escapeAttribute(feature.id)}">${escapeHTML(feature.name)}</option>`)
      .join("");
    const result = await DialogV2.input({
      window: { title: localize("FALLOUTMAW.Settings.CreatureOptions.AddNaturalFeature") },
      content: `
        <label class="fallout-maw-stacked-field">
          <span>${localize("FALLOUTMAW.Settings.CreatureOptions.NaturalFeatures")}</span>
          <select name="featureId">${options}</select>
        </label>
      `,
      ok: {
        label: localize("FALLOUTMAW.Common.Add"),
        icon: "fa-solid fa-plus",
        callback: (_event, button) => new FormDataExtended(button.form).object
      },
      buttons: [{
        action: "new",
        label: localize("FALLOUTMAW.Common.Create"),
        icon: "fa-solid fa-file-circle-plus"
      }, {
        action: "cancel",
        label: localize("FALLOUTMAW.Common.Cancel")
      }],
      rejectClose: false,
      position: { width: 420 }
    });

    if (!result || result === "cancel") return null;
    if (result === "new") return createDefaultNaturalFeatureEntry();
    const feature = features.find(entry => entry.id === String(result.featureId ?? ""));
    return feature ? createNaturalFeatureEntryFromCatalogAbility(feature) : null;
  }

  #openNaturalItemEditor(entry, kind) {
    if (!entry) return undefined;
    const ItemClass = getDocumentClass("Item");
    const itemData = normalizeNaturalRaceItemData(entry.item, kind, entry.id);
    itemData._id = entry.id;
    const item = new ItemClass(itemData);
    const persist = () => {
      entry.item = normalizeNaturalRaceItemData(item.toObject(), kind, entry.id);
    };
    item.update = async changes => {
      item.updateSource(changes ?? {});
      persist();
      item.sheet?.render({ force: true });
      return item;
    };
    const sheet = item.sheet;
    if (sheet) {
      sheet._processSubmitData = async (_event, _form, submitData) => {
        item.updateSource(submitData ?? {});
        persist();
        await sheet.render({ force: true });
      };
    }
    sheet?.render(true);
    persist();
    return sheet;
  }

  get #activeRace() {
    return this.creatureOptions.races.find(entry => entry.id === this.activeRaceId);
  }

  #updateFromCurrentForm() {
    if (!this.form) return;
    const formData = new FormDataExtended(this.form).object;
    const expanded = foundry.utils.expandObject(formData);
    if (this.#editorMode === "type") this.#updateActiveType(expanded);
    if (this.#editorMode === "race") this.#updateActiveRace(expanded);
  }

  #updateActiveType(formData) {
    const type = this.creatureOptions.types.find(entry => entry.id === this.activeTypeId);
    if (!type) return;
    type.name = String(formData.type?.name ?? type.name ?? "").trim() || localize("FALLOUTMAW.Common.Untitled");
  }

  #updateActiveRace(formData) {
    const race = this.creatureOptions.races.find(entry => entry.id === this.activeRaceId);
    if (!race) return;

    race.name = String(formData.race?.name ?? race.name ?? "").trim() || localize("FALLOUTMAW.Common.Untitled");
    const nextTypeId = String(formData.race?.typeId ?? race.typeId ?? "");
    if (this.creatureOptions.types.some(type => type.id === nextTypeId)) race.typeId = nextTypeId;
    this.activeTypeId = race.typeId;
    race.characteristics = Object.fromEntries(
      getCharacteristicSettings().map(characteristic => [
        characteristic.key,
        toInteger(formData.race?.characteristics?.[characteristic.key])
      ])
    );
    race.baseParameters = {
      characteristicDistributionPoints: toInteger(formData.race?.baseParameters?.characteristicDistributionPoints),
      signatureSkillPoints: toInteger(formData.race?.baseParameters?.signatureSkillPoints),
      traitPoints: toInteger(formData.race?.baseParameters?.traitPoints),
      proficiencyPoints: toInteger(formData.race?.baseParameters?.proficiencyPoints),
      loadFormula: String(
        formData.race?.baseParameters?.loadFormula ?? createDefaultRaceBaseParameters().loadFormula
      ).trim() || createDefaultRaceBaseParameters().loadFormula,
      loadLimitPercent: Math.max(0, toInteger(
        formData.race?.baseParameters?.loadLimitPercent ?? createDefaultRaceBaseParameters().loadLimitPercent
      ))
    };
    race.limbs = this.#readLimbsFromForm();
    race.equipmentSlots = this.#readEquipmentSlotsFromForm();
    race.weaponSets = this.#readWeaponSetsFromForm();
    race.naturalItemSets = this.#readNaturalItemSetsFromForm();
    delete race.naturalWeapons;
    delete race.naturalFeatures;
    race.inventorySize = {
      columns: Math.max(1, toInteger(formData.race?.inventorySize?.columns ?? createDefaultInventorySize().columns)),
      rows: Math.max(1, toInteger(formData.race?.inventorySize?.rows ?? createDefaultInventorySize().rows))
    };
    race.regeneration = {
      formula: String(formData.race?.regeneration?.formula ?? DEFAULT_REGENERATION_FORMULA).trim() || DEFAULT_REGENERATION_FORMULA
    };
    race.bleedingResistanceFormula = String(formData.race?.bleedingResistanceFormula ?? DEFAULT_BLEEDING_RESISTANCE_FORMULA).trim()
      || DEFAULT_BLEEDING_RESISTANCE_FORMULA;
    const configurableDamageTypes = getConfigurableDamageTypes(getDamageTypeSettings());
    race.damageResistances = Object.fromEntries(
      configurableDamageTypes.map(damageType => [
        damageType.key,
        String(formData.race?.damageResistances?.[damageType.key] ?? "0").trim() || "0"
      ])
    );
    race.needSettings = this.#readRaceNeedsFromForm();
    race.progression = {
      skillPointsPerLevel: String(formData.race?.progression?.skillPointsPerLevel ?? "10 + int").trim() || "10 + int",
      researchPointsPerLevel: String(formData.race?.progression?.researchPointsPerLevel ?? "1000").trim() || "1000"
    };
  }

  #readLimbsFromForm() {
    const rows = Array.from(this.form?.querySelectorAll("[data-limb-row]") ?? []);
    const currentLimbs = this.#activeRace?.limbs ?? [];
    return rows.map((row, index) => {
      const key = row.querySelector("[data-field='key']")?.value?.trim() ?? "";
      const existing = currentLimbs.find(limb => limb.key === key) ?? currentLimbs[index] ?? {};
      return {
        key,
        label: row.querySelector("[data-field='label']")?.value?.trim() || localize("FALLOUTMAW.Common.Untitled"),
        stateMax: String(existing.stateMax ?? "100").trim() || "100",
        damageMultiplier: toDecimal(existing.damageMultiplier, 1),
        aimedDifficultyPercent: toInteger(existing.aimedDifficultyPercent),
        critical: parseBoolean(existing.critical),
        lossEffects: normalizeLimbLossEffects(existing.lossEffects)
      };
    }).filter(limb => limb.key);
  }

  #readEquipmentSlotsFromForm() {
    const rows = Array.from(this.form?.querySelectorAll("[data-equipment-slot-row]") ?? []);
    return rows.map(row => ({
      key: row.querySelector("[data-field='key']")?.value?.trim() ?? "",
      label: row.querySelector("[data-field='label']")?.value?.trim() || localize("FALLOUTMAW.Common.Untitled")
    })).filter(slot => slot.key);
  }

  #readWeaponSetsFromForm() {
    const setRows = Array.from(this.form?.querySelectorAll("[data-weapon-set-row]") ?? []);
    return setRows.map(setRow => {
      const key = setRow.querySelector("[data-field='key']")?.value?.trim() ?? "";
      const slots = Array.from(setRow.querySelectorAll("[data-weapon-slot-row]")).map(slotRow => ({
        key: slotRow.querySelector("[data-field='key']")?.value?.trim() ?? "",
        limbKey: slotRow.querySelector("[data-field='limbKey']")?.value?.trim() ?? ""
      })).filter(slot => slot.key);

      return {
        key,
        label: setRow.querySelector("[data-field='label']")?.value?.trim() || localize("FALLOUTMAW.Common.Untitled"),
        slots
      };
    }).filter(set => set.key);
  }

  #readNaturalItemSetsFromForm() {
    const rows = Array.from(this.form?.querySelectorAll("[data-natural-set-row]") ?? []);
    const current = this.#activeRace?.naturalItemSets ?? [];
    return rows
      .map((row, index) => {
        const id = String(row.dataset.naturalSetId ?? "").trim();
        const existing = current.find(set => set.id === id) ?? current[index] ?? {};
        if (!id || !existing) return null;
        return {
          id,
          label: row.querySelector("[data-field='label']")?.value?.trim() || localize("FALLOUTMAW.Settings.CreatureOptions.DefaultNaturalSet"),
          naturalWeapons: this.#readNaturalRaceItemsFromSet(row, existing, "naturalWeapons", "[data-natural-weapon-row]", NATURAL_RACE_ITEM_KINDS.weapon),
          naturalFeatures: this.#readNaturalRaceItemsFromSet(row, existing, "naturalFeatures", "[data-natural-feature-row]", NATURAL_RACE_ITEM_KINDS.feature)
        };
      })
      .filter(Boolean);
  }

  #readNaturalRaceItemsFromSet(setRow, naturalSet, property, selector, kind) {
    const rows = Array.from(setRow?.querySelectorAll(selector) ?? []);
    const current = naturalSet?.[property] ?? [];
    return rows
      .map(row => {
        const id = String(row.dataset.naturalItemId ?? "").trim();
        const existing = current.find(entry => entry.id === id);
        if (!existing) return null;
        return {
          id,
          item: normalizeNaturalRaceItemData(existing.item, kind, id)
        };
      })
      .filter(Boolean);
  }

  #readRaceNeedsFromForm() {
    const rows = Array.from(this.form?.querySelectorAll("[data-race-need-row]") ?? []);
    const race = this.#activeRace;
    return rows.map((row, index) => {
      const key = row.querySelector("[data-field='key']")?.value?.trim() ?? "";
      const existing = race?.needSettings?.find(need => need.key === key)?.settings
        ?? race?.needSettings?.[index]?.settings
        ?? {};
      return {
        abbr: row.querySelector("[data-field='abbr']")?.value?.trim() ?? "",
        key,
        label: row.querySelector("[data-field='label']")?.value?.trim() ?? "",
        color: row.querySelector("[data-field='color']")?.value?.trim() ?? "#8f8456",
        formula: row.querySelector("[data-field='formula']")?.value?.trim() || "0",
        settings: foundry.utils.deepClone(existing)
      };
    }).filter(need => need.key);
  }

  #validateRaceFormulas() {
    const characteristics = getCharacteristicSettings();
    const skills = getSkillSettings();
    const damageTypes = getConfigurableDamageTypes(getDamageTypeSettings());
    for (const race of this.creatureOptions.races) {
      try {
        validateFormula(race.bleedingResistanceFormula ?? DEFAULT_BLEEDING_RESISTANCE_FORMULA, { allowSkills: true, characteristics, skills });
      } catch (error) {
        ui.notifications.error(`${race.name || race.id} / Сопротивление кровотечению: ${error.message}`);
        throw error;
      }
      for (const damageType of damageTypes) {
        const formula = race.damageResistances?.[damageType.key] ?? "0";
        try {
          validateFormula(formula, { allowSkills: true, characteristics, skills });
        } catch (error) {
          const label = `${race.name || race.id} / ${game.i18n.localize("FALLOUTMAW.Common.DamageResistances")} / ${damageType.label || damageType.key}`;
          ui.notifications.error(`${label}: ${error.message}`);
          throw error;
        }
      }

      try {
        validateFormula(race.regeneration?.formula ?? DEFAULT_REGENERATION_FORMULA, { allowSkills: true, characteristics, skills });
      } catch (error) {
        ui.notifications.error(`${race.name || race.id} / Регенерация: ${error.message}`);
        throw error;
      }

      const loadFormula = race.baseParameters?.loadFormula ?? createDefaultRaceBaseParameters().loadFormula;
      try {
        validateFormula(loadFormula, { allowSkills: true, characteristics, skills });
      } catch (error) {
        ui.notifications.error(`${race.name || race.id} / ${localize("FALLOUTMAW.Common.Load")}: ${error.message}`);
        throw error;
      }

      for (const [key, label] of [
        ["skillPointsPerLevel", localize("FALLOUTMAW.Settings.CreatureOptions.SkillPointsPerLevel")],
        ["researchPointsPerLevel", localize("FALLOUTMAW.Settings.CreatureOptions.ResearchPointsPerLevel")]
      ]) {
        try {
          validateFormula(race.progression?.[key] ?? "0", { characteristics });
        } catch (error) {
          ui.notifications.error(`${race.name || race.id} / ${label}: ${error.message}`);
          throw error;
        }
      }

      for (const limb of race.limbs ?? []) {
        try {
          validateFormula(limb.stateMax ?? "100", { allowSkills: true, characteristics, skills });
        } catch (error) {
          ui.notifications.error(`${race.name || race.id} / ${limb.label || limb.key}: ${error.message}`);
          throw error;
        }
      }

      const usedNeedKeys = new Set();
      const usedNeedAbbrs = new Set();
      for (const [index, need] of (race.needSettings ?? []).entries()) {
        const key = String(need.key ?? "").trim();
        const abbr = String(need.abbr ?? "").trim();
        if (!IDENTIFIER_PATTERN.test(key) || usedNeedKeys.has(key)) {
          const message = `${race.name || race.id} / потребность ${index + 1}: ключ некорректный или повторяется`;
          ui.notifications.error(message);
          throw new Error(message);
        }
        if (!IDENTIFIER_PATTERN.test(abbr) || usedNeedAbbrs.has(abbr)) {
          const message = `${race.name || race.id} / потребность ${index + 1}: код некорректный или повторяется`;
          ui.notifications.error(message);
          throw new Error(message);
        }
        usedNeedKeys.add(key);
        usedNeedAbbrs.add(abbr);
        try {
          validateFormula(need.formula ?? "0", { allowSkills: true, characteristics, skills });
        } catch (error) {
          ui.notifications.error(`${race.name || race.id} / ${need.label || key}: ${error.message}`);
          throw error;
        }
      }
    }
  }

  async #saveAndRender(message) {
    await setCreatureOptions(this.creatureOptions);
    this.creatureOptions = getCreatureOptions();
    ui.notifications.info(message);
    return this.forceRender();
  }

  #activateCollapsibleSections() {
    for (const button of this.element?.querySelectorAll("[data-creature-section-toggle]") ?? []) {
      button.addEventListener("click", event => {
        event.preventDefault();
        const section = button.closest("[data-creature-section]");
        if (!section) return;
        const collapsed = section.classList.toggle("collapsed");
        const key = String(section.dataset.creatureSection ?? "");
        if (key) {
          if (collapsed) this.#expandedSections.delete(key);
          else this.#expandedSections.add(key);
        }
        button.setAttribute("aria-expanded", String(!collapsed));
        const icon = button.querySelector("i");
        icon?.classList.toggle("fa-chevron-right", collapsed);
        icon?.classList.toggle("fa-chevron-down", !collapsed);
      });
    }
  }

  #getSectionState(key) {
    const expanded = this.#expandedSections.has(key);
    return {
      expanded,
      ariaExpanded: String(expanded),
      cssClass: expanded ? "" : "collapsed",
      iconClass: expanded ? "fa-chevron-down" : "fa-chevron-right"
    };
  }
}

class LimbSettingsConfig extends FalloutMaWFormApplicationV2 {
  constructor({ limb = {}, onSave = null } = {}) {
    super();
    this.limb = normalizeLimbSettings(limb);
    this.onSave = onSave;
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-limb-settings",
    classes: ["fallout-maw", "fallout-maw-config-form", "limb-settings-config"],
    position: {
      width: 520,
      height: "auto"
    },
    window: {
      resizable: true
    },
    form: {
      handler: FalloutMaWFormApplicationV2.handleFormSubmit,
      submitOnChange: false,
      closeOnSubmit: true
    },
    actions: {
      addLossEffect: this.#onAddLossEffect,
      deleteLossEffect: this.#onDeleteLossEffect
    }
  };

  static PARTS = {
    form: {
      template: TEMPLATES.settings.limbSettings
    }
  };

  get title() {
    return `Доп. настройки конечности: ${this.limb.label || this.limb.key}`;
  }

  async _prepareContext(options) {
    return {
      ...(await super._prepareContext(options)),
      limb: {
        ...this.limb,
        lossEffects: normalizeLimbLossEffects(this.limb.lossEffects).map((effect, index) => prepareLimbLossEffectRow(effect, index))
      }
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    activateEffectKeyAutocomplete(this.element, buildEffectKeyTokens());
    activateFormulaAutocomplete(this.element, {
      characteristics: getCharacteristicSettings(),
      skills: getSkillSettings()
    });
  }

  async _processFormData(_event, _form, formData) {
    const data = getExpandedFormData(formData);
    this.onSave?.(normalizeLimbSettings({
      ...this.limb,
      ...(data.limb ?? {}),
      lossEffects: this.#readLossEffectsFromForm()
    }));
  }

  static #onAddLossEffect(event) {
    event.preventDefault();
    this.#syncFromForm();
    if (this.limb.critical) return this.forceRender();
    this.limb.lossEffects.push({ key: "", type: "add", value: "0", phase: "initial", priority: null });
    return this.forceRender();
  }

  static #onDeleteLossEffect(event, target) {
    event.preventDefault();
    this.#syncFromForm();
    const index = Number(target.closest("[data-limb-loss-effect]")?.dataset.limbLossEffect) || 0;
    this.limb.lossEffects.splice(index, 1);
    return this.forceRender();
  }

  #syncFromForm() {
    if (!this.form) return;
    const formData = new FormDataExtended(this.form);
    const data = getExpandedFormData(formData);
    this.limb = normalizeLimbSettings({
      ...this.limb,
      ...(data.limb ?? {}),
      lossEffects: this.#readLossEffectsFromForm()
    });
  }

  #readLossEffectsFromForm() {
    return Array.from(this.form?.querySelectorAll("[data-limb-loss-effect]") ?? [])
      .map(row => ({
        key: row.querySelector("[data-limb-loss-effect-key]")?.value?.trim() ?? "",
        type: row.querySelector("[data-limb-loss-effect-type]")?.value ?? "add",
        value: row.querySelector("[data-limb-loss-effect-value]")?.value ?? "0",
        phase: "initial",
        priority: row.querySelector("[data-limb-loss-effect-priority]")?.value ?? null
      }))
      .filter(effect => effect.key);
  }
}

function normalizeLimbSettings(limb = {}) {
  const critical = parseBoolean(limb?.critical);
  return {
    key: String(limb?.key ?? "").trim(),
    label: String(limb?.label ?? limb?.name ?? limb?.key ?? "").trim(),
    stateMax: String(limb?.stateMax ?? "100").trim() || "100",
    damageMultiplier: toDecimal(limb?.damageMultiplier, 1),
    aimedDifficultyPercent: toInteger(limb?.aimedDifficultyPercent),
    critical,
    lossEffects: critical ? [] : normalizeLimbLossEffects(limb?.lossEffects)
  };
}

function normalizeLimbLossEffects(value = []) {
  const effects = Array.isArray(value) ? value : Object.values(value ?? {});
  return effects
    .map(effect => ({
      key: String(effect?.key ?? "").trim(),
      type: ["add", "multiply", "override"].includes(String(effect?.type ?? "")) ? String(effect.type) : "add",
      value: String(effect?.value ?? "0"),
      phase: String(effect?.phase || "initial"),
      priority: effect?.priority === "" || effect?.priority === null || effect?.priority === undefined
        ? null
        : toInteger(effect.priority)
    }))
    .filter(effect => effect.key);
}

function prepareLimbLossEffectRow(effect = {}, index = 0) {
  const type = String(effect?.type ?? "add");
  return {
    ...effect,
    index,
    addSelected: type === "add",
    multiplySelected: type === "multiply",
    overrideSelected: type === "override",
    priority: effect?.priority ?? ""
  };
}

function buildEffectKeyTokens() {
  return [
    ...getCharacteristicSettings().map(entry => createEffectKeyToken({ code: entry.abbr || entry.key, key: entry.key, label: entry.label, path: `system.characteristics.${entry.key}`, group: "Характеристики" })),
    ...getSkillSettings().map(entry => createEffectKeyToken({ code: entry.abbr || entry.key, key: entry.key, label: entry.label, path: `system.skills.${entry.key}.bonus`, group: "Навыки" })),
    ...getResourceSettings().map(entry => createEffectKeyToken({ code: entry.abbr || entry.key, key: entry.key, label: entry.label, path: `system.resources.${entry.key}.bonus`, group: "Ресурсы" })),
    ...getNeedSettings().map(entry => createEffectKeyToken({ code: entry.abbr || entry.key, key: entry.key, label: entry.label, path: `system.needs.${entry.key}.bonus`, group: "Потребности" })),
    ...getProficiencySettings().map(entry => createEffectKeyToken({ code: entry.abbr || entry.key, key: entry.key, label: entry.label, path: `system.proficiencies.${entry.key}.bonus`, group: "Владения" })),
    ...buildDamageMitigationEffectKeyTokens(),
    createEffectKeyToken({ code: "blind", key: "blind", label: "Слепота", path: "status.blind", group: "Статусы" }),
    createEffectKeyToken({ code: "moveCost", key: "movement", label: "Стоимость перемещения", path: "system.costs.movement", group: "Стоимость" }),
    createEffectKeyToken({ code: "actionCost", key: "action", label: "Стоимость действий", path: "system.costs.action", group: "Стоимость" }),
    ...buildActionCostEffectKeyTokens(),
    ...buildCombatEffectKeyTokens()
  ].filter(Boolean);
}

function getUniqueId(baseId, existingIds) {
  const used = new Set(existingIds);
  if (!used.has(baseId)) return baseId;

  let index = 2;
  while (used.has(`${baseId}${index}`)) index += 1;
  return `${baseId}${index}`;
}

function prepareNaturalItemSetRow(set = {}) {
  return {
    ...set,
    naturalWeapons: (set.naturalWeapons ?? []).map(entry => prepareNaturalItemRow(entry)),
    naturalFeatures: (set.naturalFeatures ?? []).map(entry => prepareNaturalItemRow(entry))
  };
}

function prepareNaturalItemRow(entry = {}) {
  return {
    ...entry,
    name: entry.item?.name || localize("FALLOUTMAW.Common.Untitled"),
    img: entry.item?.img || "icons/svg/item-bag.svg"
  };
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[char]);
}

function escapeAttribute(value) {
  return escapeHTML(value);
}

function toDecimal(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (Array.isArray(value)) return value.some(entry => parseBoolean(entry, false));
  if (typeof value === "boolean") return value;
  return ["true", "1", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function getConfigurableDamageTypes(damageTypes = []) {
  return damageTypes.filter(damageType => !damageType?.locked && !damageType?.system);
}
