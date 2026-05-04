import { TEMPLATES } from "../constants.mjs";
import { cloneActorDevelopment, normalizeActorDevelopment } from "../advancement/index.mjs";
import { clampPreparedResource } from "../data/models/resources.mjs";
import { evaluateFormula, getSkillValues } from "../formulas/index.mjs";
import {
  getResearchById,
  normalizeResearchCollection,
  prepareResearchForStorage
} from "../research/storage.mjs";
import {
  getCharacteristicSettings,
  getCreatureOptions,
  getCurrencySettings,
  getLevelSettings,
  getSkillSettings
} from "../settings/accessors.mjs";
import { getLevelThreshold } from "../settings/levels.mjs";
import { getItemContainerParentId } from "../utils/inventory-containers.mjs";

export class FalloutMaWActor extends Actor {
  static async createDialog(data = {}, createOptions = {}, dialogOptions = {}, renderOptions = {}) {
    const creatureOptions = getCreatureOptions();
    const selectedCreatureType = foundry.utils.getProperty(data, "system.creature.typeId") || "";
    const selectedCreatureRace = foundry.utils.getProperty(data, "system.creature.raceId") || "";
    const priorRender = dialogOptions.render;

    return super.createDialog(
      data,
      createOptions,
      {
        ...dialogOptions,
        template: TEMPLATES.actorCreateDialog,
        position: foundry.utils.mergeObject({ width: 430 }, dialogOptions.position ?? {}, { inplace: false }),
        context: {
          ...(dialogOptions.context ?? {}),
          selectedCreatureType,
          creatureTypes: creatureOptions.types.map(type => ({ value: type.id, label: type.name })),
          creatureRaces: creatureOptions.races.map(race => ({ ...race, selected: race.id === selectedCreatureRace }))
        },
        render: (event, dialog) => {
          priorRender?.(event, dialog);
          this.#activateCreatureCreateDialog(dialog);
        }
      },
      renderOptions
    );
  }

  async _preCreate(data, options, user) {
    if ((await super._preCreate(data, options, user)) === false) return false;
    if (!["character", "npc"].includes(this.type)) return undefined;

    this.#applyCreatureRaceDefaults();
    this.#applyNewActorResourceDefaults();
    return undefined;
  }

  async _preUpdate(changes, options, user) {
    if ((await super._preUpdate(changes, options, user)) === false) return false;
    if (!["character", "npc"].includes(this.type)) return undefined;
    syncTrackedResourceValueUpdates(this, changes);
    return undefined;
  }

  prepareDerivedData() {
    super.prepareDerivedData();
    const resources = this.system?.resources;
    if (resources) {
      for (const resource of Object.values(resources)) clampPreparedResource(resource);
    }

    const needs = this.system?.needs;
    if (needs) {
      for (const need of Object.values(needs)) clampPreparedResource(need);
    }

    const proficiencies = this.system?.proficiencies;
    if (proficiencies) {
      for (const proficiency of Object.values(proficiencies)) clampPreparedResource(proficiency);
    }

    const limbs = this.system?.limbs;
    if (limbs) {
      for (const limb of Object.values(limbs)) clampPreparedResource(limb);
    }

    this.#prepareLoadData();
  }

  get health() {
    return this.system?.resources?.health;
  }

  getDevelopment() {
    return normalizeActorDevelopment(this.system?.development, getCharacteristicSettings(), getSkillSettings());
  }

  prepareDevelopmentResetData({
    level = this.system?.attributes?.level,
    experience = this.system?.development?.experience
  } = {}) {
    const characteristicSettings = getCharacteristicSettings();
    const skillSettings = getSkillSettings();
    const race = getCreatureOptions().races.find(entry => entry.id === this.system?.creature?.raceId);
    const normalizedLevel = Math.max(1, toInteger(level));
    const skillPointsPerLevel = Math.max(0, toInteger(race?.progression?.skillPointsPerLevel ?? this.system?.progression?.skillPointsPerLevel));
    const researchPointsPerLevel = Math.max(0, toInteger(race?.progression?.researchPointsPerLevel ?? this.system?.progression?.researchPointsPerLevel));

    const characteristics = Object.fromEntries(
      characteristicSettings.map(characteristic => [
        characteristic.key,
        toInteger(race?.characteristics?.[characteristic.key] ?? this.system?.characteristics?.[characteristic.key])
      ])
    );

    const development = cloneActorDevelopment({}, characteristicSettings, skillSettings);
    development.initialized = true;
    development.experience = Math.max(0, toInteger(experience));
    development.points.characteristics = Math.max(0, toInteger(race?.baseParameters?.characteristicDistributionPoints));
    development.points.signatureSkills = Math.max(0, toInteger(race?.baseParameters?.signatureSkillPoints));
    development.points.traits = Math.max(0, toInteger(race?.baseParameters?.traitPoints));
    development.points.proficiencies = Math.max(0, toInteger(race?.baseParameters?.proficiencyPoints));
    development.points.skills = skillPointsPerLevel * Math.max(0, normalizedLevel - 1);
    development.points.researches = researchPointsPerLevel * Math.max(0, normalizedLevel - 1);

    return { characteristics, development };
  }

  async ensureDevelopmentInitialized() {
    const development = this.getDevelopment();
    if (development.initialized) return development;

    const initialized = this.prepareDevelopmentResetData({
      level: this.system?.attributes?.level,
      experience: development.experience
    }).development;

    await this.update({ "system.development": initialized });
    return initialized;
  }

  canLevelUp(level = this.system?.attributes?.level, experience = this.system?.development?.experience) {
    const normalizedLevel = Math.max(1, toInteger(level));
    const nextThreshold = getLevelThreshold(getLevelSettings(), normalizedLevel);
    if (!nextThreshold) return false;
    return Math.max(0, toInteger(experience)) >= nextThreshold;
  }

  getResearch(researchId = "") {
    return getResearchById(this.system?.researches, researchId);
  }

  async createResearch(data = {}) {
    const researches = normalizeResearchCollection(foundry.utils.deepClone(this.system?.researches ?? []));
    researches.push(prepareResearchForStorage(data));
    return this.update({ "system.researches": researches });
  }

  async updateResearch(researchId = "", data = {}) {
    const researches = normalizeResearchCollection(foundry.utils.deepClone(this.system?.researches ?? []));
    const index = researches.findIndex(research => research.id === researchId);
    if (index < 0) return this;

    researches[index] = prepareResearchForStorage({
      ...researches[index],
      ...data,
      id: researches[index].id
    }, {
      generateId: false
    });

    return this.update({ "system.researches": researches });
  }

  async deleteResearch(researchId = "") {
    const researches = normalizeResearchCollection(foundry.utils.deepClone(this.system?.researches ?? []));
    const nextResearches = researches.filter(research => research.id !== researchId);
    if (nextResearches.length === researches.length) return this;
    return this.update({ "system.researches": nextResearches });
  }

  getDamageResistance(damageTypeKey, limbKey = "") {
    const resolvedLimbKey = limbKey || Object.keys(this.system?.limbs ?? {})[0] || "";
    return Math.floor(Number(this.system?.damageResistances?.[resolvedLimbKey]?.[damageTypeKey]) || 0);
  }

  getDamageDefense(damageTypeKey, limbKey = "") {
    const resolvedLimbKey = limbKey || Object.keys(this.system?.limbs ?? {})[0] || "";
    return Math.floor(Number(this.system?.damageDefenses?.[resolvedLimbKey]?.[damageTypeKey]) || 0);
  }

  getDamageReduction(damageTypeKey, limbKey = "") {
    const resolvedLimbKey = limbKey || Object.keys(this.system?.limbs ?? {})[0] || "";
    return Math.floor(Number(this.system?.damageReductions?.[resolvedLimbKey]?.[damageTypeKey]) || 0);
  }

  async applyDamage(amount = 0, { damageTypeKey = "", limbKey = "" } = {}) {
    const incomingDamage = Math.max(0, Math.floor(Number(amount) || 0));
    if (!this.health || (incomingDamage === 0)) return this;

    const resistance = damageTypeKey ? this.getDamageResistance(damageTypeKey, limbKey) : 0;
    const defense = damageTypeKey ? Math.min(100, this.getDamageDefense(damageTypeKey, limbKey)) : 0;
    const reduction = damageTypeKey ? this.getDamageReduction(damageTypeKey, limbKey) : 0;
    const defendedDamage = Math.floor(incomingDamage * (1 - (defense / 100)));
    const damage = Math.max(0, defendedDamage - resistance - reduction);
    if (damage === 0) return this;

    const nextValue = Math.max(this.health.min, this.health.value - damage);
    const updateData = { "system.resources.health.value": nextValue };

    if (limbKey && this.system?.limbs?.[limbKey]) {
      const limb = this.system.limbs[limbKey];
      updateData[`system.limbs.${limbKey}.value`] = Math.max(Number(limb.min) || 0, (Number(limb.value) || 0) - damage);
    }

    return this.update(updateData);
  }

  #applyCreatureRaceDefaults() {
    const creatureOptions = getCreatureOptions();
    const creature = this.system?.creature;
    const race = creatureOptions.races.find(entry => entry.id === creature?.raceId);
    const typeId = race?.typeId || creature?.typeId || "";

    if (!race && !typeId) return;

    const system = { creature: { typeId, raceId: race?.id || "" } };
    if (race) {
      system.characteristics = { ...race.characteristics };
      system.progression = { ...race.progression };
    }

    this.updateSource({ system });
  }

  #applyNewActorResourceDefaults() {
    this.system?.prepareDerivedData?.();

    this.updateSource({
      system: {
        currencies: initializeCurrencyMap(getCurrencySettings()),
        resources: maximizeResourceMap(this.system?.resources),
        needs: maximizeResourceMap(this.system?.needs),
        researches: normalizeResearchCollection(this.system?.researches),
        proficiencies: initializeProficiencyMap(this.system?.proficiencies),
        limbs: maximizeResourceMap(this.system?.limbs)
      }
    });
  }

  #prepareLoadData() {
    const race = getCreatureOptions().races.find(entry => entry.id === this.system?.creature?.raceId);
    const characteristics = this.system?.characteristics ?? {};
    const skills = getSkillValues(this.system?.skills ?? {});
    const max = race?.baseParameters?.loadFormula
      ? Math.max(0, evaluateFormula(race.baseParameters.loadFormula, {
        characteristicSettings: getCharacteristicSettings(),
        skillSettings: getSkillSettings(),
        characteristics,
        skills
      }))
      : 0;
    const value = Number(
      this.items.reduce((total, item) => (
        getItemContainerParentId(item)
          ? total
          : total + (Number(item.totalWeight) || 0)
      ), 0).toFixed(1)
    );
    this.system.load = { min: 0, spent: 0, bonus: 0, value, max };
  }

  static #activateCreatureCreateDialog(dialog) {
    const root = dialog.element instanceof HTMLElement ? dialog.element : dialog.element?.[0] ?? dialog.element;
    const typeSelect = root?.querySelector("[data-creature-type-select]");
    const raceSelect = root?.querySelector("[data-creature-race-select]");
    if (!typeSelect || !raceSelect) return;

    const updateRaceOptions = () => {
      const typeId = typeSelect.value;
      let selectedAvailable = false;

      for (const option of raceSelect.options) {
        const optionTypeId = option.dataset.typeId;
        const visible = !option.value || (typeId && optionTypeId === typeId);
        option.hidden = !visible;
        option.disabled = !visible;
        if (visible && option.selected) selectedAvailable = true;
      }

      if (!selectedAvailable) raceSelect.value = "";
    };

    raceSelect.addEventListener("change", event => {
      const selected = event.currentTarget.selectedOptions[0];
      if (selected?.dataset.typeId) typeSelect.value = selected.dataset.typeId;
      updateRaceOptions();
    });
    typeSelect.addEventListener("change", updateRaceOptions);
    updateRaceOptions();
  }
}

function maximizeResourceMap(resources = {}) {
  return Object.fromEntries(
    Object.entries(resources ?? {}).map(([key, resource]) => {
      const min = Number(resource?.min) || 0;
      const bonus = toInteger(resource?.bonus);
      const max = Number(resource?.max) || min;
      return [key, { ...resource, min, bonus, value: max, max }];
    })
  );
}

function initializeCurrencyMap(currencies = []) {
  return Object.fromEntries(currencies.map(currency => [currency.key, 0]));
}

function initializeProficiencyMap(proficiencies = {}) {
  return Object.fromEntries(
    Object.entries(proficiencies ?? {}).map(([key, proficiency]) => [
      key,
      { ...proficiency, min: 0, spent: 0, bonus: toInteger(proficiency?.bonus), value: 0 }
    ])
  );
}

function syncTrackedResourceValueUpdates(actor, changes) {
  for (const resourceKey of TRACKED_RESOURCE_KEYS) {
    const currentResource = actor.system?.resources?.[resourceKey];
    if (!currentResource) continue;
    foundry.utils.setProperty(
      changes,
      `system.resources.${resourceKey}.spent`,
      Math.max(0, toInteger(currentResource?.max) - toInteger(currentResource?.value))
    );

    const valuePath = `system.resources.${resourceKey}.value`;
    if (!hasUpdatePath(changes, valuePath)) continue;

    const min = Math.max(0, getUpdatedResourceBound(changes, resourceKey, "min", actor.system?.resources?.[resourceKey]?.min));
    const max = Math.max(min, getUpdatedResourceBound(changes, resourceKey, "max", actor.system?.resources?.[resourceKey]?.max));
    const nextValue = Math.min(
      Math.max(getUpdatedResourceBound(changes, resourceKey, "value", actor.system?.resources?.[resourceKey]?.value), min),
      max
    );

    foundry.utils.setProperty(changes, `system.resources.${resourceKey}.spent`, Math.max(0, max - nextValue));
  }
}

function getUpdatedResourceBound(changes, resourceKey, field, fallback) {
  const path = `system.resources.${resourceKey}.${field}`;
  const value = getUpdatePath(changes, path);
  return toInteger(value ?? fallback);
}

function hasUpdatePath(object, path) {
  return foundry.utils.hasProperty(object, path) || Object.hasOwn(object, path);
}

function getUpdatePath(object, path) {
  if (foundry.utils.hasProperty(object, path)) return foundry.utils.getProperty(object, path);
  return object[path];
}

function toInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

const TRACKED_RESOURCE_KEYS = ["dodge", "actionPoints", "movementPoints"];
