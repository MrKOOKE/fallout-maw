import { TEMPLATES, SYSTEM_ID } from "../constants.mjs";
import { DROPPED_ITEMS_ACTOR_FLAG } from "../items/dropped-items.mjs";
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
  getProficiencySettings,
  getSkillSettings
} from "../settings/accessors.mjs";
import { applyTokenPrototypeDefaults } from "../settings/token-prototype-defaults.mjs";
import { getLevelThreshold } from "../settings/levels.mjs";
import {
  DEFAULT_PROFICIENCY_POINTS_PER_LEVEL_FORMULA,
  DEFAULT_RESEARCH_POINTS_PER_LEVEL_FORMULA,
  DEFAULT_SKILL_POINTS_PER_LEVEL_FORMULA
} from "../config/defaults.mjs";
import { getItemActorLoadWeight, getItemContainerParentId } from "../utils/inventory-containers.mjs";
import {
  getConditionFunction,
  getProsthesisFunction,
  hasItemFunction,
  ITEM_FUNCTIONS
} from "../utils/item-functions.mjs";
import { isNaturalRaceItem } from "../races/natural-items.mjs";
import { clampActorLimbValuesToCurrentCaps, handleActorDamageUpdate, prepareActorDamageUpdate, requestDamageApplication } from "../combat/damage-hub.mjs";
import { migrateActorData } from "../migrations/documents.mjs";
import {
  expandActorEffectChangeKeys,
  getActorSuppressedTraumaDiseaseIds,
  isActorTraumaDiseaseEffectSuppressed,
  prepareActorEffectChangeForApplication
} from "../utils/active-effect-changes.mjs";
const actorLoadPreparationCache = new WeakMap();
const INITIALIZE_ACTOR_DEFAULTS_OPTION = "falloutMawInitializeActorDefaults";

export class FalloutMaWActor extends Actor {
  static migrateData(source) {
    source = super.migrateData(source);
    return migrateActorData(source);
  }

  static async createDialog(data = {}, createOptions = {}, dialogOptions = {}, renderOptions = {}) {
    const creatureOptions = getCreatureOptions();
    const creatureSelection = resolveCreatureSelection(
      creatureOptions,
      foundry.utils.getProperty(data, "system.creature.typeId") || "",
      foundry.utils.getProperty(data, "system.creature.raceId") || "",
      foundry.utils.getProperty(data, "system.creature.subtypeId") || ""
    );
    const priorRender = dialogOptions.render;

    return super.createDialog(
      data,
      {
        ...createOptions,
        [INITIALIZE_ACTOR_DEFAULTS_OPTION]: true
      },
      {
        ...dialogOptions,
        template: TEMPLATES.actorCreateDialog,
        position: foundry.utils.mergeObject({ width: 430 }, dialogOptions.position ?? {}, { inplace: false }),
        context: {
          ...(dialogOptions.context ?? {}),
          selectedCreatureType: creatureSelection.typeId,
          selectedCreatureRace: creatureSelection.raceId,
          selectedCreatureSubtype: creatureSelection.subtypeId,
          creatureTypes: creatureOptions.types.map(type => ({ value: type.id, label: type.name, selected: type.id === creatureSelection.typeId })),
          creatureRaces: creatureOptions.races.map(race => ({ ...race, selected: race.id === creatureSelection.raceId })),
          creatureSubtypes: buildCreatureSubtypeOptions(creatureOptions.races, creatureSelection.raceId, creatureSelection.subtypeId)
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
    if (foundry.utils.getProperty(data, `flags.${SYSTEM_ID}.${DROPPED_ITEMS_ACTOR_FLAG}`)) return undefined;
    if (!["character", "construct"].includes(this.type)) return undefined;

    await applyTokenPrototypeDefaults(this, data, options);
    if (options?.[INITIALIZE_ACTOR_DEFAULTS_OPTION]) {
      if (this.type === "character") applyCreatureRaceDefaults(this);
      else clearCreatureSelection(this);
      applyNewActorResourceDefaults(this);
    }
    return undefined;
  }

  async _preUpdate(changes, options, user) {
    if ((await super._preUpdate(changes, options, user)) === false) return false;
    if (!["character", "construct"].includes(this.type)) return undefined;
    await prepareActorDamageUpdate(this, changes, options);
    syncTrackedResourceValueUpdates(this, changes);
    return undefined;
  }

  _onUpdate(changes, options, userId) {
    super._onUpdate(changes, options, userId);
    if (!["character", "construct"].includes(this.type)) return;
    if (this.type === "construct") void syncConstructPartConditionDamage(this, changes);
    handleActorDamageUpdate(this, changes, options);
  }

  prepareDerivedData() {
    super.prepareDerivedData();
    if (this.system?.attributes) {
      this.system.attributes.initiativeBonus = toInteger(this.system.attributes.initiativeBonus);
      this.system.attributes.initiative = toInteger(this.system?.characteristics?.perception) + this.system.attributes.initiativeBonus;
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
      clampActorLimbValuesToCurrentCaps(this);
    }

    prepareIntegratedProsthesisHealth(this);
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
    const suppressedTraumaDiseaseIds = getActorSuppressedTraumaDiseaseIds(this);
    for (const effect of this.allApplicableEffects()) {
      if (!effect.active) continue;
      if (isActorTraumaDiseaseEffectSuppressed(this, effect, suppressedTraumaDiseaseIds)) continue;
      for (const change of effect.system.changes) {
        if ((change.key === "") || (change.phase !== phase)) continue;
        const copy = foundry.utils.deepClone(change);
        copy.effect = effect;
        if (copy.key?.startsWith("token.")) {
          copy.key = copy.key.slice(6);
          tokenChanges.push(copy);
        } else {
          changes.push(...expandActorEffectChangeKeys(this, copy));
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
      const preparedChange = prepareActorEffectChangeForApplication(this, change, {
        stage: phase === "initial" ? "initial-active-effect" : "prepared"
      });
      if (!preparedChange) continue;
      const result = ActiveEffect.applyChange(this, preparedChange, { replacementData });
      if (foundry.utils.isPlainObject(result)) Object.assign(overrides, result);
    }

    foundry.utils.mergeObject(this.overrides, foundry.utils.expandObject(overrides));
  }

  get health() {
    return this.system?.resources?.health;
  }

  getDevelopment() {
    return normalizeActorDevelopment(this.system?.development, getCharacteristicSettings(), getSkillSettings(), getProficiencySettings());
  }

  prepareDevelopmentResetData({
    level = this.system?.attributes?.level,
    experience = this.system?.development?.experience
  } = {}) {
    const characteristicSettings = getCharacteristicSettings();
    const skillSettings = getSkillSettings();
    const race = getCreatureOptions().races.find(entry => entry.id === this.system?.creature?.raceId);
    const normalizedLevel = Math.max(1, toInteger(level));

    const characteristics = Object.fromEntries(
      characteristicSettings.map(characteristic => [
        characteristic.key,
        toInteger(race?.characteristics?.[characteristic.key] ?? this.system?.characteristics?.[characteristic.key])
      ])
    );
    const skillPointsPerLevel = evaluateProgressionFormula(
      race?.progression?.skillPointsPerLevel ?? this.system?.progression?.skillPointsPerLevel,
      characteristics,
      characteristicSettings,
      DEFAULT_SKILL_POINTS_PER_LEVEL_FORMULA
    );
    const researchPointsPerLevel = evaluateProgressionFormula(
      race?.progression?.researchPointsPerLevel ?? this.system?.progression?.researchPointsPerLevel,
      characteristics,
      characteristicSettings,
      DEFAULT_RESEARCH_POINTS_PER_LEVEL_FORMULA
    );
    const proficiencyPointsPerLevel = evaluateProgressionFormula(
      race?.progression?.proficiencyPointsPerLevel ?? this.system?.progression?.proficiencyPointsPerLevel,
      characteristics,
      characteristicSettings,
      DEFAULT_PROFICIENCY_POINTS_PER_LEVEL_FORMULA
    );

    const development = cloneActorDevelopment({}, characteristicSettings, skillSettings, getProficiencySettings());
    development.initialized = true;
    development.experience = Math.max(0, toInteger(experience));
    development.points.characteristics = Math.max(0, toInteger(race?.baseParameters?.characteristicDistributionPoints));
    development.points.signatureSkills = Math.max(0, toInteger(race?.baseParameters?.signatureSkillPoints));
    development.points.traits = Math.max(0, toInteger(race?.baseParameters?.traitPoints));
    development.points.skills = skillPointsPerLevel * Math.max(0, normalizedLevel - 1);
    development.points.researches = researchPointsPerLevel * Math.max(0, normalizedLevel - 1);
    development.points.proficiencies = Math.max(0, toInteger(race?.baseParameters?.proficiencyPoints))
      + (proficiencyPointsPerLevel * Math.max(0, normalizedLevel - 1));

    const proficiencies = resetProficiencyMap(this.system?.proficiencies, getProficiencySettings());

    return { characteristics, development, proficiencies };
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

function applyCreatureRaceDefaults(actor) {
  const creatureOptions = getCreatureOptions();
  const creature = actor.system?.creature;
  const selection = resolveCreatureSelection(creatureOptions, creature?.typeId, creature?.raceId, creature?.subtypeId);
  const race = creatureOptions.races.find(entry => entry.id === selection.raceId);
  const typeId = selection.typeId;

  if (!race && !typeId) return;

  const system = { creature: { typeId, raceId: race?.id || "", subtypeId: selection.subtypeId } };
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
  const bonus = Math.trunc(Number(actor.system?.load?.bonus) || 0);
  const signature = getActorLoadPreparationSignature(actor, race, characteristics, skills, bonus);
  const cached = actorLoadPreparationCache.get(actor);
  if (cached?.signature === signature) {
    actor.system.load = { ...cached.load };
    return;
  }

  const baseMax = race?.baseParameters?.loadFormula
    ? Math.max(0, evaluateFormula(race.baseParameters.loadFormula, {
      characteristicSettings: getCharacteristicSettings(),
      skillSettings: getSkillSettings(),
      characteristics,
      skills
    }))
    : 0;
  const max = Math.max(0, baseMax + bonus);
  const limitPercent = Math.max(0, Number(race?.baseParameters?.loadLimitPercent) || 0);
  const limit = max > 0 && limitPercent > 0
    ? Number(((max * limitPercent) / 100).toFixed(1))
    : 0;
  const itemList = actor.items;
  const loadWeightMemo = new Map();
  const value = Number(
    actor.items.reduce((total, item) => (
      isNaturalRaceItem(item) || getItemContainerParentId(item) || String(item.system?.placement?.mode ?? "") === ITEM_FUNCTIONS.constructPart
        ? total
        : total + (Number(getItemActorLoadWeight(item, itemList, loadWeightMemo)) || 0)
    ), 0).toFixed(1)
  );
  const load = { min: 0, spent: 0, bonus, value, max, limit, limitPercent };
  actor.system.load = load;
  actorLoadPreparationCache.set(actor, {
    signature,
    load: { ...load }
  });
}

function getActorLoadPreparationSignature(actor, race, characteristics = {}, skills = {}, bonus = 0) {
  const actorSignature = JSON.stringify({
    raceId: race?.id ?? "",
    loadFormula: race?.baseParameters?.loadFormula ?? "",
    loadLimitPercent: race?.baseParameters?.loadLimitPercent ?? 0,
    bonus,
    characteristics,
    skills
  });
  const itemSignature = actor.items.map(item => {
    const system = item.system ?? {};
    const placement = system.placement ?? {};
    const container = system.functions?.container ?? {};
    return [
      item.id,
      item.type,
      Number(system.quantity) || 0,
      Number(system.weight) || 0,
      getItemContainerParentId(item),
      String(placement.mode ?? ""),
      Boolean(system.equipped) ? 1 : 0,
      Number(container.loadReduction) || 0,
      isNaturalRaceItem(item) ? 1 : 0
    ].join(":");
  }).join("|");
  return `${actorSignature}#${itemSignature}`;
}

function clearCreatureSelection(actor) {
  actor.updateSource({
    system: {
      creature: {
        typeId: "",
        raceId: "",
        subtypeId: ""
      }
    }
  });
}

function evaluateProgressionFormula(formula, characteristics, characteristicSettings, fallback = "0") {
  try {
    return Math.max(0, evaluateFormula(String(formula ?? fallback).trim() || fallback, {
      characteristicSettings,
      characteristics
    }));
  } catch (error) {
    console.warn(`Fallout MaW | Progression formula error: ${error.message}`);
    return Math.max(0, toInteger(fallback));
  }
}

function activateCreatureCreateDialog(dialog) {
  const root = dialog.element instanceof HTMLElement ? dialog.element : dialog.element?.[0] ?? dialog.element;
  const actorTypeSelect = root?.querySelector('select[name="type"]');
  const baseFieldset = root?.querySelector("[data-character-base-fieldset]");
  const typeSelect = root?.querySelector("[data-creature-type-select]");
  const raceSelect = root?.querySelector("[data-creature-race-select]");
  const subtypeSelect = root?.querySelector("[data-creature-subtype-select]");
  const syncCharacterBaseVisibility = () => {
    const isCharacter = String(actorTypeSelect?.value ?? "character") === "character";
    if (baseFieldset) baseFieldset.hidden = !isCharacter;
    if (!isCharacter) {
      if (typeSelect) typeSelect.value = "";
      if (raceSelect) raceSelect.value = "";
      if (subtypeSelect) subtypeSelect.value = "";
    }
  };
  actorTypeSelect?.addEventListener("change", syncCharacterBaseVisibility);
  syncCharacterBaseVisibility();
  if (!typeSelect || !raceSelect) return;

  const selectFirstVisible = select => {
    const option = Array.from(select.options).find(entry => entry.value && !entry.hidden && !entry.disabled);
    select.value = option?.value ?? "";
  };

  const updateSubtypeOptions = () => {
    if (!subtypeSelect) return;
    const raceId = raceSelect.value;
    let selectedAvailable = false;
    for (const option of subtypeSelect.options) {
      const optionRaceId = option.dataset.raceId;
      const visible = !option.value || (raceId && optionRaceId === raceId);
      option.hidden = !visible;
      option.disabled = !visible;
      if (visible && option.selected && option.value) selectedAvailable = true;
    }
    if (!selectedAvailable) selectFirstVisible(subtypeSelect);
  };

  const updateRaceOptions = ({ selectDefault = false } = {}) => {
    const typeId = typeSelect.value;
    let selectedAvailable = false;

    for (const option of raceSelect.options) {
      const optionTypeId = option.dataset.typeId;
      const visible = !option.value || (typeId && optionTypeId === typeId);
      option.hidden = !visible;
      option.disabled = !visible;
      if (visible && option.selected && option.value) selectedAvailable = true;
    }

    if (selectDefault || !selectedAvailable) selectFirstVisible(raceSelect);
    updateSubtypeOptions();
  };

  raceSelect.addEventListener("change", event => {
    const selected = event.currentTarget.selectedOptions[0];
    if (selected?.dataset.typeId) typeSelect.value = selected.dataset.typeId;
    updateRaceOptions();
    updateSubtypeOptions();
  });
  typeSelect.addEventListener("change", () => updateRaceOptions({ selectDefault: true }));
  updateRaceOptions();
  updateSubtypeOptions();
}

function resolveCreatureSelection(creatureOptions, typeId = "", raceId = "", subtypeId = "") {
  const types = creatureOptions?.types ?? [];
  const races = creatureOptions?.races ?? [];
  const requestedTypeId = String(typeId ?? "");
  const requestedRaceId = String(raceId ?? "");
  const requestedTypeValid = types.some(type => type.id === requestedTypeId);
  const requestedRace = races.find(entry => entry.id === requestedRaceId) ?? null;
  const initialTypeId = requestedTypeValid ? requestedTypeId : (requestedRace?.typeId ?? types[0]?.id ?? "");
  const race = (requestedRace && (!requestedTypeValid || requestedRace.typeId === initialTypeId) ? requestedRace : null)
    ?? races.find(entry => !initialTypeId || entry.typeId === initialTypeId)
    ?? races[0]
    ?? null;
  const resolvedTypeId = race?.typeId || initialTypeId;
  const subtypes = race?.naturalItemSets ?? [];
  const resolvedSubtypeId = subtypes.some(entry => entry.id === subtypeId) ? String(subtypeId) : (subtypes[0]?.id ?? "");
  return {
    typeId: resolvedTypeId,
    raceId: race?.id ?? "",
    subtypeId: resolvedSubtypeId
  };
}

function buildCreatureSubtypeOptions(races = [], selectedRaceId = "", selectedSubtypeId = "") {
  return races.flatMap(race => (race.naturalItemSets ?? []).map(set => ({
    id: set.id,
    raceId: race.id,
    label: set.label,
    selected: race.id === selectedRaceId && set.id === selectedSubtypeId
  })));
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

function resetProficiencyMap(proficiencies = {}, proficiencySettings = []) {
  return Object.fromEntries(
    proficiencySettings.map(proficiency => {
      const current = proficiencies?.[proficiency.key];
      const min = 0;
      const bonus = current && typeof current === "object" ? toInteger(current.bonus) : 0;
      const max = Math.max(min, toInteger(proficiency.max) + bonus);
      return [proficiency.key, { min, spent: 0, bonus, value: 0, max }];
    })
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

function prepareIntegratedProsthesisHealth(actor) {
  const health = actor?.system?.resources?.health;
  if (!health) return;

  let value = 0;
  let max = 0;
  for (const [limbKey, limb] of Object.entries(actor.system?.limbs ?? {})) {
    const prosthesis = getInstalledActorProsthesis(actor, limbKey);
    if (prosthesis) {
      const contribution = getIntegratedProsthesisHealth(prosthesis, limb);
      value += contribution.value;
      max += contribution.max;
      continue;
    }
    if (Boolean(limb?.missing)) continue;
    value += Math.max(0, toInteger(limb?.value));
    max += Math.max(0, toInteger(limb?.max));
  }

  const min = Math.max(0, toInteger(health.min));
  health.max = Math.max(min, max);
  health.value = Math.min(Math.max(value, min), health.max);
  health.spent = Math.max(0, health.max - health.value);
}

async function syncConstructPartConditionDamage(actor, changes = {}) {
  const updates = [];
  for (const [path, value] of Object.entries(foundry.utils.flattenObject(changes ?? {}))) {
    const match = path.match(/^system\.limbs\.constructPart[:.]([^.]+)\.value$/);
    if (!match) continue;
    const item = actor.items?.get(match[1]);
    if (!item || item.type !== "gear") continue;
    if (!hasItemFunction(item, ITEM_FUNCTIONS.constructPart) || !hasItemFunction(item, ITEM_FUNCTIONS.condition)) continue;
    const condition = getConditionFunction(item);
    const max = Math.max(0, toInteger(condition.max));
    const nextValue = Math.max(0, Math.min(max, toInteger(value)));
    if (nextValue === toInteger(condition.value)) continue;
    updates.push({
      _id: item.id,
      "system.functions.condition.value": nextValue
    });
  }
  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates, { falloutMawConstructPartConditionSync: true });
}

function getIntegratedProsthesisHealth(prosthesis, limb = {}) {
  if (!prosthesis) return { value: 0, max: 0 };
  const integration = Math.max(0, Math.min(100, toInteger(getProsthesisFunction(prosthesis).integrationPercent)));
  if (integration <= 0) return { value: 0, max: 0 };

  if (!hasItemFunction(prosthesis, ITEM_FUNCTIONS.condition)) {
    const max = toIntegratedHealthValue(Math.max(0, toInteger(limb?.max)), integration);
    return { value: max, max };
  }

  const condition = getConditionFunction(prosthesis);
  const conditionMax = Math.max(0, toInteger(condition.max));
  const conditionValue = Math.min(Math.max(0, toInteger(condition.value)), conditionMax);
  return {
    value: toIntegratedHealthValue(conditionValue, integration),
    max: toIntegratedHealthValue(conditionMax, integration)
  };
}

function toIntegratedHealthValue(value = 0, integration = 0) {
  return Math.max(0, Math.round((Math.max(0, toInteger(value)) * Math.max(0, Math.min(100, toInteger(integration)))) / 100));
}

function getInstalledActorProsthesis(actor, limbKey = "") {
  const key = String(limbKey ?? "").trim();
  if (!key) return null;
  return Array.from(actor?.items ?? []).find(item => (
    item?.type === "gear"
    && item.system?.equipped
    && hasItemFunction(item, ITEM_FUNCTIONS.prosthesis)
    && String(item.system?.placement?.mode ?? "") === "prosthesis"
    && String(item.system?.placement?.limbKey ?? "") === key
  )) ?? null;
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

