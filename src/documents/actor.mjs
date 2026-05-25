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
  getDamageTypeSettings,
  getLevelSettings,
  getSkillSettings
} from "../settings/accessors.mjs";
import { getLevelThreshold } from "../settings/levels.mjs";
import { getItemActorLoadWeight, getItemContainerParentId } from "../utils/inventory-containers.mjs";
import { handleActorDamageUpdate, prepareActorDamageUpdate, requestDamageApplication } from "../combat/damage-hub.mjs";
import { migrateActorData } from "../migrations/documents.mjs";

export class FalloutMaWActor extends Actor {
  static migrateData(source) {
    source = super.migrateData(source);
    return migrateActorData(source);
  }

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
          activateCreatureCreateDialog(dialog);
        }
      },
      renderOptions
    );
  }

  async _preCreate(data, options, user) {
    if ((await super._preCreate(data, options, user)) === false) return false;
    if (!["character", "npc"].includes(this.type)) return undefined;

    applyCreatureRaceDefaults(this);
    applyNewActorResourceDefaults(this);
    return undefined;
  }

  async _preUpdate(changes, options, user) {
    if ((await super._preUpdate(changes, options, user)) === false) return false;
    if (!["character", "npc"].includes(this.type)) return undefined;
    prepareActorDamageUpdate(this, changes, options);
    syncTrackedResourceValueUpdates(this, changes);
    return undefined;
  }

  _onUpdate(changes, options, userId) {
    super._onUpdate(changes, options, userId);
    if (!["character", "npc"].includes(this.type)) return;
    handleActorDamageUpdate(this, changes, options);
  }

  prepareDerivedData() {
    super.prepareDerivedData();
    if (this.system?.attributes) {
      this.system.attributes.initiative = toInteger(this.system?.characteristics?.perception);
    }

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

    prepareActorLoadData(this);
  }

  applyActiveEffects(phase) {
    const ActiveEffect = getDocumentClass("ActiveEffect");
    if (typeof phase !== "string") {
      phase = this._completedActiveEffectPhases?.has("initial") ? "final" : "initial";
      console.warn('Actor#applyActiveEffects must be called with a string phase identifier, with "initial" as the first phase.');
    } else if (!(phase in ActiveEffect.CHANGE_PHASES)) {
      console.error(`"${phase}" is not a registered ActiveEffect application phase.`);
      return;
    }
    this._completedActiveEffectPhases ??= new Set();
    if (this._completedActiveEffectPhases.has(phase)) {
      console.error(`ActiveEffect application phase "${phase}" has already completed and cannot be run again.`);
      return;
    }
    this._completedActiveEffectPhases.add(phase);

    const changes = [];
    const tokenChanges = [];
    for (const effect of this.allApplicableEffects()) {
      if (!effect.active) continue;
      for (const change of effect.system.changes) {
        if ((change.key === "") || (change.phase !== phase)) continue;
        for (const expandedChange of expandAllLimbEffectChange(this, change)) {
          const copy = foundry.utils.deepClone(expandedChange);
          copy.effect = effect;
          if (copy.key?.startsWith("token.")) {
            copy.key = copy.key.slice(6);
            tokenChanges.push(copy);
          } else {
            changes.push(copy);
          }
        }
      }
      if (phase === "initial") {
        for (const statusId of effect.statuses) this.statuses.add(statusId);
      }
    }
    changes.sort((a, b) => a.priority - b.priority);
    ActiveEffect._shimChanges(changes);
    this.tokenActiveEffectChanges[phase] = tokenChanges;

    const overrides = {};
    const replacementData = this.getRollData();
    for (const change of changes) {
      const result = ActiveEffect.applyChange(this, change, { replacementData });
      if (foundry.utils.isPlainObject(result)) Object.assign(overrides, result);
    }

    foundry.utils.mergeObject(this.overrides, foundry.utils.expandObject(overrides));
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

  getDamageDefense(damageTypeKey, limbKey = "") {
    const resolvedLimbKey = limbKey || Object.keys(this.system?.limbs ?? {})[0] || "";
    return Math.floor(Number(this.system?.damageDefenses?.[resolvedLimbKey]?.[damageTypeKey]) || 0);
  }

  getDamageResistance(damageTypeKey, limbKey = "") {
    const resolvedLimbKey = limbKey || Object.keys(this.system?.limbs ?? {})[0] || "";
    return Math.floor(Number(this.system?.damageResistances?.[resolvedLimbKey]?.[damageTypeKey]) || 0);
  }

  async applyDamage(amount = 0, { damageTypeKey = "", limbKey = "" } = {}) {
    await requestDamageApplication({
      actor: this,
      amount,
      damageTypeKey,
      limbKey,
      mode: "damage",
      scope: limbKey ? "healthAndLimb" : "health",
      source: {
        legacyActorApplyDamage: true
      }
    });
    return this;
  }

}

const DAMAGE_MITIGATION_EFFECT_KEY_PATTERN = /^system\.(damageDefenses|damageResistances)\.([^.]+)\.([^.]+)$/;
const ALL_LIMB_SELECTORS = new Set(["all", "allLimbs", "*"]);
const ALL_DAMAGE_TYPE_SELECTORS = new Set(["all", "allDamageTypes", "*"]);

function expandAllLimbEffectChange(actor, change = {}) {
  const match = String(change.key ?? "").trim().match(DAMAGE_MITIGATION_EFFECT_KEY_PATTERN);
  if (!match) return [change];
  const [, mitigationKey, limbSelector, damageTypeSelector] = match;
  if (!ALL_LIMB_SELECTORS.has(limbSelector) && !ALL_DAMAGE_TYPE_SELECTORS.has(damageTypeSelector)) return [change];

  const limbKeys = ALL_LIMB_SELECTORS.has(limbSelector)
    ? Object.keys(actor.system?.limbs ?? {})
    : [limbSelector];
  const damageTypeKeys = ALL_DAMAGE_TYPE_SELECTORS.has(damageTypeSelector)
    ? getDamageTypeSettings().map(damageType => damageType.key).filter(Boolean)
    : [damageTypeSelector];

  return limbKeys.flatMap(limbKey => damageTypeKeys.map(damageTypeKey => ({
    ...change,
    key: `system.${mitigationKey}.${limbKey}.${damageTypeKey}`
  })));
}

function applyCreatureRaceDefaults(actor) {
  const creatureOptions = getCreatureOptions();
  const creature = actor.system?.creature;
  const race = creatureOptions.races.find(entry => entry.id === creature?.raceId);
  const typeId = race?.typeId || creature?.typeId || "";

  if (!race && !typeId) return;

  const system = { creature: { typeId, raceId: race?.id || "" } };
  if (race) {
    system.characteristics = { ...race.characteristics };
    system.progression = { ...race.progression };
  }

  actor.updateSource({ system });
}

function applyNewActorResourceDefaults(actor) {
  actor.system?.prepareDerivedData?.();

  actor.updateSource({
    system: {
      currencies: initializeCurrencyMap(getCurrencySettings()),
      resources: maximizeResourceMap(actor.system?.resources),
      needs: minimizeResourceMap(actor.system?.needs),
      researches: normalizeResearchCollection(actor.system?.researches),
      proficiencies: initializeProficiencyMap(actor.system?.proficiencies),
      limbs: maximizeResourceMap(actor.system?.limbs)
    }
  });
}

function prepareActorLoadData(actor) {
  const race = getCreatureOptions().races.find(entry => entry.id === actor.system?.creature?.raceId);
  const characteristics = actor.system?.characteristics ?? {};
  const skills = getSkillValues(actor.system?.skills ?? {});
  const max = race?.baseParameters?.loadFormula
    ? Math.max(0, evaluateFormula(race.baseParameters.loadFormula, {
      characteristicSettings: getCharacteristicSettings(),
      skillSettings: getSkillSettings(),
      characteristics,
      skills
    }))
    : 0;
  const limitPercent = Math.max(0, Number(race?.baseParameters?.loadLimitPercent) || 0);
  const limit = max > 0 && limitPercent > 0
    ? Number(((max * limitPercent) / 100).toFixed(1))
    : 0;
  const value = Number(
    actor.items.reduce((total, item) => (
      getItemContainerParentId(item)
        ? total
        : total + (Number(getItemActorLoadWeight(item, actor.items)) || 0)
    ), 0).toFixed(1)
  );
  actor.system.load = { min: 0, spent: 0, bonus: 0, value, max, limit, limitPercent };
}

function activateCreatureCreateDialog(dialog) {
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

function maximizeResourceMap(resources = {}) {
  return Object.fromEntries(
    Object.entries(resources ?? {}).map(([key, resource]) => {
      const min = Number(resource?.min) || 0;
      const bonus = toInteger(resource?.bonus);
      const max = Number(resource?.max) || min;
      return [key, { ...resource, min, bonus, spent: 0, value: max, max }];
    })
  );
}

function minimizeResourceMap(resources = {}) {
  return Object.fromEntries(
    Object.entries(resources ?? {}).map(([key, resource]) => {
      const min = Number(resource?.min) || 0;
      const bonus = toInteger(resource?.bonus);
      const max = Math.max(min, Number(resource?.max) || min);
      return [key, { ...resource, min, bonus, value: min, max }];
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
  for (const resourceKey of Object.keys(actor.system?.resources ?? {})) {
    if (resourceKey === "health") continue;
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

