import { TEMPLATES } from "../constants.mjs";
import { validateFormula } from "../formulas/index.mjs";
import {
  getCharacteristicSettings,
  getCreatureOptions,
  getDamageTypeSettings,
  getSkillSettings,
  setCreatureOptions
} from "../settings/accessors.mjs";
import {
  createDefaultInventorySize,
  createDefaultRaceBaseParameters,
  createRaceDefaults
} from "../settings/creature-options.mjs";
import { format, localize } from "../utils/i18n.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { FalloutMaWFormApplicationV2, getExpandedFormData } from "./base-form-application-v2.mjs";
import { activateFormulaAutocomplete } from "./formula-autocomplete.mjs";

const { DialogV2 } = foundry.applications.api;
const { FormDataExtended } = foundry.applications.ux;

export class CreatureOptionsConfig extends FalloutMaWFormApplicationV2 {
  #editorMode = "type";

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
      createEquipmentSlot: this.#onCreateEquipmentSlot,
      deleteEquipmentSlot: this.#onDeleteEquipmentSlot,
      createWeaponSet: this.#onCreateWeaponSet,
      deleteWeaponSet: this.#onDeleteWeaponSet,
      createWeaponSlot: this.#onCreateWeaponSlot,
      deleteWeaponSlot: this.#onDeleteWeaponSlot,
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
    const selectedType = this.creatureOptions.types.find(type => type.id === this.activeTypeId) ?? this.creatureOptions.types[0] ?? null;
    const racesForType = selectedType ? this.creatureOptions.races.filter(race => race.typeId === selectedType.id) : [];
    const selectedRace = racesForType.find(race => race.id === this.activeRaceId) ?? racesForType[0] ?? null;

    this.activeTypeId = selectedType?.id ?? "";
    this.activeRaceId = selectedRace?.id ?? "";

    return {
      ...(await super._prepareContext(options)),
      creatureOptions: this.creatureOptions,
      editingType: Boolean(selectedType) && (!selectedRace || (this.#editorMode === "type")),
      editingRace: Boolean(selectedRace) && (this.#editorMode === "race"),
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
      inventorySize: selectedRace?.inventorySize ?? createDefaultInventorySize(),
      damageTypes: damageTypes.map(damageType => ({
        ...damageType,
        formula: String(selectedRace?.damageResistances?.[damageType.key] ?? "0")
      }))
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    activateFormulaAutocomplete(this.element, {
      characteristics: getCharacteristicSettings(),
      skills: getSkillSettings()
    });
  }

  async _processFormData(_event, _form, formData) {
    const expanded = getExpandedFormData(formData);
    this.#updateActiveType(expanded);
    this.#updateActiveRace(expanded);
    this.#validateRaceFormulas();
    return this.#saveAndRender(localize("FALLOUTMAW.Messages.CreatureOptionsSaved"));
  }

  static #onSelectType(event, target) {
    event.preventDefault();
    this.#updateFromCurrentForm();
    this.activeTypeId = target.dataset.id ?? "";
    this.activeRaceId = this.creatureOptions.races.find(race => race.typeId === this.activeTypeId)?.id ?? "";
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

  get #activeRace() {
    return this.creatureOptions.races.find(entry => entry.id === this.activeRaceId);
  }

  #updateFromCurrentForm() {
    if (!this.form) return;
    const formData = new FormDataExtended(this.form).object;
    const expanded = foundry.utils.expandObject(formData);
    this.#updateActiveType(expanded);
    this.#updateActiveRace(expanded);
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
      ).trim() || createDefaultRaceBaseParameters().loadFormula
    };
    race.limbs = this.#readLimbsFromForm();
    race.equipmentSlots = this.#readEquipmentSlotsFromForm();
    race.weaponSets = this.#readWeaponSetsFromForm();
    race.inventorySize = {
      columns: Math.max(1, toInteger(formData.race?.inventorySize?.columns ?? createDefaultInventorySize().columns)),
      rows: Math.max(1, toInteger(formData.race?.inventorySize?.rows ?? createDefaultInventorySize().rows))
    };
    race.damageResistances = Object.fromEntries(
      getDamageTypeSettings().map(damageType => [
        damageType.key,
        String(formData.race?.damageResistances?.[damageType.key] ?? "0").trim() || "0"
      ])
    );
    race.progression = {
      skillPointsPerLevel: toInteger(formData.race?.progression?.skillPointsPerLevel),
      researchPointsPerLevel: toInteger(formData.race?.progression?.researchPointsPerLevel)
    };
  }

  #readLimbsFromForm() {
    const rows = Array.from(this.form?.querySelectorAll("[data-limb-row]") ?? []);
    return rows.map(row => ({
      key: row.querySelector("[data-field='key']")?.value?.trim() ?? "",
      label: row.querySelector("[data-field='label']")?.value?.trim() || localize("FALLOUTMAW.Common.Untitled"),
      stateMax: Math.max(0, toInteger(row.querySelector("[data-field='stateMax']")?.value))
    })).filter(limb => limb.key);
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

  #validateRaceFormulas() {
    const characteristics = getCharacteristicSettings();
    const skills = getSkillSettings();
    const damageTypes = getDamageTypeSettings();

    for (const race of this.creatureOptions.races) {
      for (const damageType of damageTypes) {
        const formula = race.damageResistances?.[damageType.key] ?? "0";
        try {
          validateFormula(formula, { allowSkills: true, characteristics, skills });
        } catch (error) {
          const label = `${race.name || race.id} / ${damageType.label || damageType.key}`;
          ui.notifications.error(`${label}: ${error.message}`);
          throw error;
        }
      }

      const loadFormula = race.baseParameters?.loadFormula ?? createDefaultRaceBaseParameters().loadFormula;
      try {
        validateFormula(loadFormula, { allowSkills: true, characteristics, skills });
      } catch (error) {
        ui.notifications.error(`${race.name || race.id} / ${localize("FALLOUTMAW.Common.Load")}: ${error.message}`);
        throw error;
      }
    }
  }

  async #saveAndRender(message) {
    await setCreatureOptions(this.creatureOptions);
    this.creatureOptions = getCreatureOptions();
    ui.notifications.info(message);
    return this.forceRender();
  }
}

function getUniqueId(baseId, existingIds) {
  const used = new Set(existingIds);
  if (!used.has(baseId)) return baseId;

  let index = 2;
  while (used.has(`${baseId}${index}`)) index += 1;
  return `${baseId}${index}`;
}
