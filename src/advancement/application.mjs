import {
  calculateRemainingDevelopmentPoints,
  calculateSpentCharacteristicPoints,
  calculateSpentSignatureSkillPoints,
  calculateSpentSkillPoints,
  cloneActorDevelopment
} from "./index.mjs";
import { FALLOUT_MAW } from "../config/system-config.mjs";
import {
  getCharacteristicSettings,
  getCreatureOptions,
  getAbilityCatalog,
  getLevelSettings,
  getSkillAdvancementSettings,
  getSkillSettings
} from "../settings/accessors.mjs";
import { actorHasAbility, completeAbilityResearch, findCatalogAbility, grantCatalogAbility } from "../abilities/purchase.mjs";
import { formatResearchValue } from "../research/storage.mjs";
import { getLevelThreshold } from "../settings/levels.mjs";
import { TEMPLATES } from "../constants.mjs";
import { localize } from "../utils/i18n.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { FalloutMaWFormApplicationV2 } from "../apps/base-form-application-v2.mjs";

const { DialogV2 } = foundry.applications.api;
const ADVANCEMENT_COMMIT_FLAG = "advancementCommit";

export class AdvancementApplication extends FalloutMaWFormApplicationV2 {
  #activeEffectHooks = [];
  #actorUpdateHookId = null;
  #draft = null;
  #experienceSyncTimer = null;
  #floor = null;
  #page = "development";
  #repeatState = null;
  #suppressNextRepeatClick = false;
  #snapshot = null;

  constructor(actor, options = {}) {
    super(options);
    this.actor = actor;
    this.#actorUpdateHookId = Hooks.on("updateActor", (updatedActor, changes) => this.#onActorUpdated(updatedActor, changes));
    this.#activeEffectHooks = [
      { event: "createActiveEffect", id: Hooks.on("createActiveEffect", effect => this.#onActiveEffectChanged(effect)) },
      { event: "updateActiveEffect", id: Hooks.on("updateActiveEffect", effect => this.#onActiveEffectChanged(effect)) },
      { event: "deleteActiveEffect", id: Hooks.on("deleteActiveEffect", effect => this.#onActiveEffectChanged(effect)) }
    ];
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-advancement",
    classes: ["fallout-maw", "fallout-maw-config-form", "fallout-maw-advancement-app"],
    position: {
      width: 820,
      height: "auto"
    },
    window: {
      resizable: true
    },
    actions: {
      decreaseCharacteristic: this.#onDecreaseCharacteristic,
      increaseCharacteristic: this.#onIncreaseCharacteristic,
      decreaseSkill: this.#onDecreaseSkill,
      increaseSkill: this.#onIncreaseSkill,
      nextPage: this.#onNextPage,
      previousPage: this.#onPreviousPage,
      spendAbilityResearch: this.#onSpendAbilityResearch,
      startAbilityResearch: this.#onStartAbilityResearch,
      completeAbilityResearch: this.#onCompleteAbilityResearch,
      levelUp: this.#onLevelUp,
      resetDevelopment: this.#onResetDevelopment,
      toggleSignatureSkill: this.#onToggleSignatureSkill
    }
  };

  static PARTS = {
    form: {
      template: TEMPLATES.advancement.dialog
    }
  };

  get title() {
    return this.actor?.name || localize("FALLOUTMAW.Advancement.Title");
  }

  async _prepareContext(options) {
    await this.#ensureDraft();

    const characteristicSettings = getCharacteristicSettings();
    const skillSettings = getSkillSettings();
    const skillAdvancementSettings = getSkillAdvancementSettings(characteristicSettings, skillSettings);
    const skillDevelopmentLimit = Math.max(0, toInteger(skillAdvancementSettings.developmentLimit));
    const levelSettings = getLevelSettings();
    const creatureOptions = getCreatureOptions();
    const race = creatureOptions.races.find(entry => entry.id === this.actor.system?.creature?.raceId) ?? null;
    const remaining = calculateRemainingDevelopmentPoints(this.#draft.development);
    const floorCharacteristicSpent = calculateSpentCharacteristicPoints(this.#floor.development);
    const floorSkillSpent = calculateSpentSkillPoints(this.#floor.development);
    const floorSignatureSpent = calculateSpentSignatureSkillPoints(this.#floor.development);
    const maxLevel = levelSettings[levelSettings.length - 1]?.level ?? 100;
    const liveCharacteristics = this.actor.system?.characteristics ?? this.#draft.characteristics;
    const liveSkills = this.actor.system?.skills ?? {};
    const currentThreshold = this.#draft.level <= 1
      ? 0
      : getLevelThreshold(levelSettings, Math.max(0, this.#draft.level - 1));
    const nextThreshold = this.#draft.level >= maxLevel
      ? currentThreshold
      : getLevelThreshold(levelSettings, Math.max(1, this.#draft.level));
    const currentExperience = Math.max(0, toInteger(this.#draft.development.experience));
    const experienceRange = Math.max(1, nextThreshold - currentThreshold);
    const experiencePercent = this.#draft.level >= maxLevel
      ? 100
      : Math.max(0, Math.min(100, ((currentExperience - currentThreshold) / experienceRange) * 100));
    const canLevelUp = (this.#draft.level < maxLevel) && (currentExperience >= nextThreshold);

    return {
      ...(await super._prepareContext(options)),
      actor: this.actor,
      raceName: race?.name || "\u2014",
      level: this.#draft.level,
      canLevelUp,
      experienceBarStyle: `width: ${experiencePercent.toFixed(2)}%;`,
      experienceCurrent: currentExperience,
      experienceNext: nextThreshold,
      skillPointsPerLevel: Math.max(0, toInteger(this.actor.system?.progression?.skillPointsPerLevel)),
      characteristicPointsDisplay: `${remaining.characteristics} / ${Math.max(remaining.characteristics, toInteger(this.#draft.development.points.characteristics) - floorCharacteristicSpent)}`,
      skillPointsDisplay: `${remaining.skills} / ${Math.max(remaining.skills, toInteger(this.#draft.development.points.skills) - floorSkillSpent)}`,
      signatureSkillPointsDisplay: `${remaining.signatureSkills} / ${Math.max(remaining.signatureSkills, toInteger(this.#draft.development.points.signatureSkills) - floorSignatureSpent)}`,
      researchPointsDisplay: `${remaining.researches} / ${Math.max(remaining.researches, toInteger(this.#draft.development.points.researches))}`,
      page: this.#page,
      isDevelopmentPage: this.#page === "development",
      isAbilitiesPage: this.#page === "abilities",
      characteristics: characteristicSettings.map(characteristic => {
        const floorPoints = toInteger(this.#floor.development.characteristics?.[characteristic.key]);
        const currentPoints = toInteger(this.#draft.development.characteristics?.[characteristic.key]);
        return {
          ...characteristic,
          value: toInteger(liveCharacteristics?.[characteristic.key]),
          canIncrease: remaining.characteristics > 0,
          canDecrease: currentPoints > floorPoints
        };
      }),
      skills: skillSettings.map(skill => {
        const floorSkill = this.#floor.development.skills?.[skill.key] ?? {};
        const currentSkill = this.#draft.development.skills?.[skill.key] ?? {};
        const canUnsetSignature = currentSkill.signature && !floorSkill.signature;
        return {
          ...skill,
          value: toInteger(liveSkills?.[skill.key]?.value),
          signature: Boolean(currentSkill.signature),
          canIncrease: remaining.skills > 0 && toInteger(liveSkills?.[skill.key]?.value) < skillDevelopmentLimit,
          canDecrease: toInteger(currentSkill.points) > toInteger(floorSkill.points),
          canToggleSignature: Boolean(currentSkill.signature)
            ? canUnsetSignature
            : (remaining.signatureSkills > 0)
        };
      }),
      abilityCategories: this.#prepareAbilityCategories(remaining.researches, skillSettings)
    };
  }

  async _processFormData(_event, _form, _formData) {
    await this.#saveDraft();
    return this.forceRender();
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.#activateRepeatButtons();
  }

  async _preClose(options) {
    window.clearTimeout(this.#experienceSyncTimer);
    this.#stopRepeat();
    this.#syncDraftFromForm();
    await this.#saveDraft({ notify: false });
    if (this.#actorUpdateHookId !== null) {
      Hooks.off("updateActor", this.#actorUpdateHookId);
      this.#actorUpdateHookId = null;
    }
    for (const hook of this.#activeEffectHooks) Hooks.off(hook.event, hook.id);
    this.#activeEffectHooks = [];
    await super._preClose(options);
  }

  static async #onIncreaseCharacteristic(event, target) {
    event.preventDefault();
    const key = target.dataset.characteristicKey ?? "";
    if (!key) return;
    if (!(await this.#changeCharacteristic(key, 1))) return;
    return this.forceRender();
  }

  static async #onDecreaseCharacteristic(event, target) {
    event.preventDefault();
    const key = target.dataset.characteristicKey ?? "";
    if (!key) return;
    if (!(await this.#changeCharacteristic(key, -1))) return;
    return this.forceRender();
  }

  static async #onIncreaseSkill(event, target) {
    event.preventDefault();
    const key = target.dataset.skillKey ?? "";
    if (!key) return;
    if (!(await this.#changeSkill(key, 1))) return;
    return this.forceRender();
  }

  static async #onDecreaseSkill(event, target) {
    event.preventDefault();
    const key = target.dataset.skillKey ?? "";
    if (!key) return;
    if (!(await this.#changeSkill(key, -1))) return;
    return this.forceRender();
  }

  static async #onToggleSignatureSkill(event, target) {
    event.preventDefault();
    await this.#ensureDraft();
    this.#syncDraftFromForm();

    const key = target.dataset.skillKey ?? "";
    if (!key) return;

    const currentValue = Boolean(this.#draft.development.skills[key]?.signature);
    if (currentValue) {
      if (this.#floor.development.skills[key]?.signature) return;
      this.#draft.development.skills[key].signature = false;
      await this.#applyDraftToActor();
      return this.forceRender();
    }

    const remaining = calculateRemainingDevelopmentPoints(this.#draft.development);
    if (remaining.signatureSkills < 1) return;

    this.#draft.development.skills[key].signature = true;
    await this.#applyDraftToActor();
    return this.forceRender();
  }

  static async #onLevelUp(event) {
    event.preventDefault();
    await this.#ensureDraft();
    this.#syncDraftFromForm();

    const levelSettings = getLevelSettings();
    const maxLevel = levelSettings[levelSettings.length - 1]?.level ?? 100;
    if (this.#draft.level >= maxLevel) return;

    const nextThreshold = getLevelThreshold(levelSettings, this.#draft.level);
    if (toInteger(this.#draft.development.experience) < nextThreshold) return;

    this.#draft.level += 1;
    this.#draft.development.points.skills += Math.max(0, toInteger(this.actor.system?.progression?.skillPointsPerLevel));
    this.#draft.development.points.researches += Math.max(0, toInteger(this.actor.system?.progression?.researchPointsPerLevel));
    await this.#applyDraftToActor();
    return this.forceRender();
  }

  static async #onResetDevelopment(event) {
    event.preventDefault();
    const confirmed = await DialogV2.confirm({
      window: {
        title: localize("FALLOUTMAW.Advancement.Reset")
      },
      content: `<p>${localize("FALLOUTMAW.Advancement.ResetConfirm")}</p>`
    });
    if (!confirmed) return;

    await this.#ensureDraft();
    this.#syncDraftFromForm();

    const resetData = this.actor.prepareDevelopmentResetData({
      level: 1,
      experience: 0
    });

    this.#draft.level = 1;
    this.#draft.characteristics = foundry.utils.deepClone(resetData.characteristics);
    this.#draft.development = foundry.utils.deepClone(resetData.development);
    await this.#applyDraftToActor();
    return this.forceRender();
  }

  async #ensureDraft() {
    if (this.#draft) return;

    const characteristicSettings = getCharacteristicSettings();
    const skillSettings = getSkillSettings();
    const development = await this.actor.ensureDevelopmentInitialized();
    const normalized = cloneActorDevelopment(development, characteristicSettings, skillSettings);
    const currentState = {
      level: Math.max(1, toInteger(this.actor.system?.attributes?.level)),
      characteristics: Object.fromEntries(
        characteristicSettings.map(characteristic => [characteristic.key, toInteger(this.actor.system?._source?.characteristics?.[characteristic.key] ?? this.actor.system?.characteristics?.[characteristic.key])])
      ),
      development: cloneActorDevelopment(normalized, characteristicSettings, skillSettings)
    };
    const committed = this.#readCommittedState(characteristicSettings, skillSettings) ?? currentState;

    this.#snapshot = foundry.utils.deepClone(committed);
    this.#draft = foundry.utils.deepClone(currentState);
    this.#floor = foundry.utils.deepClone(committed);
  }

  #activateRepeatButtons() {
    for (const button of this.element?.querySelectorAll?.("[data-repeat-action]") ?? []) {
      button.addEventListener("click", event => this.#onRepeatButtonClick(event));
      button.addEventListener("pointerdown", event => this.#onRepeatButtonPointerDown(event));
      button.addEventListener("pointerup", () => this.#stopRepeat());
      button.addEventListener("pointercancel", () => this.#stopRepeat());
    }
  }

  #syncDraftFromForm() {
    return undefined;
  }

  async #changeCharacteristic(key, delta) {
    await this.#ensureDraft();
    this.#syncDraftFromForm();

    if (delta > 0) {
      const remaining = calculateRemainingDevelopmentPoints(this.#draft.development);
      if (remaining.characteristics < 1) return false;

      this.#draft.development.characteristics[key] = toInteger(this.#draft.development.characteristics[key]) + 1;
      await this.#applyDraftToActor();
      return true;
    }

    const currentPoints = toInteger(this.#draft.development.characteristics[key]);
    const minimumPoints = toInteger(this.#floor.development.characteristics[key]);
    if (currentPoints <= minimumPoints) return false;

    this.#draft.development.characteristics[key] = currentPoints - 1;
    await this.#applyDraftToActor();
    return true;
  }

  async #changeSkill(key, delta) {
    await this.#ensureDraft();
    this.#syncDraftFromForm();

    if (delta > 0) {
      const remaining = calculateRemainingDevelopmentPoints(this.#draft.development);
      if (remaining.skills < 1) return false;
      if (toInteger(this.actor.system?.skills?.[key]?.value) >= this.#getSkillDevelopmentLimit()) return false;

      this.#draft.development.skills[key].points = toInteger(this.#draft.development.skills[key]?.points) + 1;
      await this.#applyDraftToActor();
      return true;
    }

    const currentPoints = toInteger(this.#draft.development.skills[key]?.points);
    const minimumPoints = toInteger(this.#floor.development.skills[key]?.points);
    if (currentPoints <= minimumPoints) return false;

    this.#draft.development.skills[key].points = currentPoints - 1;
    await this.#applyDraftToActor();
    return true;
  }

  static #onNextPage(event) {
    event.preventDefault();
    this.#page = "abilities";
    return this.forceRender();
  }

  static #onPreviousPage(event) {
    event.preventDefault();
    this.#page = "development";
    return this.forceRender();
  }

  static async #onSpendAbilityResearch(event, target) {
    event.preventDefault();
    await this.#ensureDraft();
    this.#syncDraftFromForm();

    const sourceId = target.closest("[data-ability-source-id]")?.dataset.abilitySourceId ?? "";
    const entry = findCatalogAbility(sourceId);
    if (!entry || actorHasAbility(this.actor, sourceId)) return this.forceRender();
    if (entry.ability.system?.acquisition?.onlyManual) return this.forceRender();

    const remaining = calculateRemainingDevelopmentPoints(this.#draft.development);
    const cost = Math.max(0, toInteger(entry.ability.system?.cost));
    if (cost <= 0) {
      await grantCatalogAbility(this.actor, sourceId);
      return this.forceRender();
    }
    if (remaining.researches <= 0) return this.forceRender();

    const current = toInteger(this.#draft.development.abilityResearches?.[sourceId]);
    const research = this.#getAbilityResearch(sourceId);
    const currentProgress = Math.max(current, Number(research?.progress) || 0);
    const investment = Math.min(remaining.researches, Math.max(0, cost - currentProgress));
    if (investment <= 0) return this.forceRender();

    this.#draft.development.abilityResearches[sourceId] = current + investment;
    await this.#applyDraftToActor();

    if (research) {
      await this.actor.updateResearch(research.id, {
        progress: Math.min(cost, Number(research.progress) + investment),
        target: cost
      });
    } else if (!entry.ability.system?.acquisition?.onlyFree && currentProgress + investment < cost) {
      await this.actor.createResearch(this.#createAbilityResearchData(entry, currentProgress + investment));
    }

    if (currentProgress + investment >= cost) {
      await grantCatalogAbility(this.actor, sourceId);
      if (research) await this.actor.deleteResearch(research.id);
    }

    this.#syncDraftFromActor();
    return this.forceRender();
  }

  static async #onStartAbilityResearch(event, target) {
    event.preventDefault();
    await this.#ensureDraft();
    this.#syncDraftFromForm();

    const sourceId = target.closest("[data-ability-source-id]")?.dataset.abilitySourceId ?? "";
    const entry = findCatalogAbility(sourceId);
    if (!entry || actorHasAbility(this.actor, sourceId)) return this.forceRender();
    if (entry.ability.system?.acquisition?.onlyFree) return this.forceRender();
    if (this.#getAbilityResearch(sourceId)) return this.forceRender();

    const cost = Math.max(1, toInteger(entry.ability.system?.cost));
    const progress = Math.min(cost, toInteger(this.#draft.development.abilityResearches?.[sourceId]));
    await this.actor.createResearch(this.#createAbilityResearchData(entry, progress));
    return this.forceRender();
  }

  static async #onCompleteAbilityResearch(event, target) {
    event.preventDefault();
    const researchId = target.closest("[data-ability-source-id]")?.dataset.researchId ?? "";
    if (!researchId) return undefined;
    await completeAbilityResearch(this.actor, researchId);
    return this.forceRender();
  }

  #getSkillDevelopmentLimit() {
    const characteristicSettings = getCharacteristicSettings();
    const skillSettings = getSkillSettings();
    return Math.max(0, toInteger(getSkillAdvancementSettings(characteristicSettings, skillSettings).developmentLimit));
  }

  #prepareAbilityCategories(availableResearchPoints = 0, skillSettings = []) {
    const catalog = getAbilityCatalog();
    return (catalog.categories ?? []).map(category => ({
      ...category,
      abilities: (category.abilities ?? []).map(ability => this.#prepareAbilityEntry(category, ability, availableResearchPoints, skillSettings))
    }));
  }

  #prepareAbilityEntry(category, ability, availableResearchPoints = 0, skillSettings = []) {
    const sourceId = String(ability?.id ?? "");
    const cost = Math.max(0, toInteger(ability?.system?.cost));
    const spent = toInteger(this.#draft.development?.abilityResearches?.[sourceId]);
    const research = this.#getAbilityResearch(sourceId);
    const progress = Math.min(cost, Math.max(spent, Number(research?.progress) || 0));
    const remainingCost = Math.max(0, cost - progress);
    const owned = actorHasAbility(this.actor, sourceId);
    const onlyFree = Boolean(ability?.system?.acquisition?.onlyFree);
    const onlyManual = Boolean(ability?.system?.acquisition?.onlyManual);
    const completed = cost <= 0 || progress >= cost;
    const skillLabel = skillSettings.find(skill => skill.key === ability?.system?.acquisition?.skillKey)?.label ?? skillSettings[0]?.label ?? "";
    return {
      ...ability,
      sourceId,
      categoryId: category.id,
      cost,
      progress,
      progressLabel: `${formatResearchValue(progress)} / ${formatResearchValue(cost)}`,
      progressPercent: cost > 0 ? Math.min(100, (progress / cost) * 100).toFixed(2) : "100",
      remainingCost,
      owned,
      onlyFree,
      onlyManual,
      canSpendFree: !owned && !onlyManual && ((cost <= 0) || (remainingCost > 0 && availableResearchPoints > 0)),
      freeSpendAmount: Math.min(availableResearchPoints, remainingCost),
      canStartManual: !owned && !onlyFree && !research && !completed,
      canComplete: !owned && Boolean(research) && completed,
      researchId: research?.id ?? "",
      researchActive: Boolean(research),
      acquisitionLabel: onlyFree ? "Только свободные ОИ" : onlyManual ? "Только ручное исследование" : "Свободные ОИ или ручное исследование",
      manualLabel: skillLabel ? `${skillLabel}, сложность ${toInteger(ability?.system?.acquisition?.difficulty ?? 60)}` : ""
    };
  }

  #getAbilityResearch(sourceId = "") {
    return (this.actor.system?.researches ?? []).find(research => research.type === "ability" && research.sourceId === sourceId) ?? null;
  }

  #createAbilityResearchData(entry, progress = 0) {
    const ability = entry.ability;
    const skillSettings = getSkillSettings();
    const skillKey = String(ability.system?.acquisition?.skillKey || skillSettings[0]?.key || "");
    const target = Math.max(1, toInteger(ability.system?.cost));
    return {
      name: ability.name,
      skillKey,
      progress: Math.min(Math.max(0, Number(progress) || 0), target),
      target,
      difficulty: Math.max(0, toInteger(ability.system?.acquisition?.difficulty ?? 60)),
      type: "ability",
      sourceId: ability.id,
      sourceCategoryId: entry.category.id
    };
  }

  async #applyRepeatAction(action, key) {
    if (action === "increaseCharacteristic") return this.#changeCharacteristic(key, 1);
    if (action === "decreaseCharacteristic") return this.#changeCharacteristic(key, -1);
    if (action === "increaseSkill") return this.#changeSkill(key, 1);
    if (action === "decreaseSkill") return this.#changeSkill(key, -1);
    return false;
  }

  async #onRepeatButtonClick(event) {
    event.preventDefault();
    event.stopPropagation();

    if (this.#suppressNextRepeatClick) {
      this.#suppressNextRepeatClick = false;
      return;
    }
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement) || target.hasAttribute("disabled")) return;

    const action = target.dataset.repeatAction ?? "";
    const key = target.dataset.characteristicKey ?? target.dataset.skillKey ?? "";
    if (!action || !key) return;

    if (!(await this.#applyRepeatAction(action, key))) return;
    return this.forceRender();
  }

  async #onRepeatButtonPointerDown(event) {
    if (event.button !== 0) return;

    event.preventDefault();
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement) || target.hasAttribute("disabled")) return;

    const action = target.dataset.repeatAction ?? "";
    const key = target.dataset.characteristicKey ?? target.dataset.skillKey ?? "";
    if (!action || !key) return;

    this.#stopRepeat();
    const controller = new AbortController();
    const state = {
      action,
      key,
      controller,
      hasRepeated: false,
      timer: window.setTimeout(() => this.#runRepeatTick(state), 300)
    };

    this.#repeatState = state;
    window.addEventListener("pointerup", () => this.#stopRepeat(), { signal: controller.signal });
    window.addEventListener("pointercancel", () => this.#stopRepeat(), { signal: controller.signal });
    window.addEventListener("blur", () => this.#stopRepeat(), { signal: controller.signal });
  }

  async #runRepeatTick(state) {
    if (this.#repeatState !== state) return;
    if (!(await this.#applyRepeatAction(state.action, state.key))) {
      this.#stopRepeat();
      return;
    }

    state.hasRepeated = true;
    this.#suppressNextRepeatClick = true;
    await this.forceRender();
    if (this.#repeatState !== state) return;
    state.timer = window.setTimeout(() => this.#runRepeatTick(state), 70);
  }

  #stopRepeat() {
    if (!this.#repeatState) return;
    window.clearTimeout(this.#repeatState.timer);
    this.#repeatState.controller.abort();
    this.#repeatState = null;
  }

  async #onActorUpdated(updatedActor, changes) {
    if (updatedActor?.id !== this.actor?.id) return;
    if (!this.rendered) return;

    const affectsDraft = [
      "system.attributes.level",
      "system.characteristics",
      "system.development",
      "system.creature.raceId",
      "system.progression",
      "name"
    ].some(path => foundry.utils.hasProperty(changes, path));

    if (affectsDraft && this.#draft) this.#syncDraftFromActor();
    await this.forceRender();
  }

  async #onActiveEffectChanged(effect) {
    if (effect?.parent?.id !== this.actor?.id) return;
    if (!this.rendered) return;
    await this.forceRender();
  }

  async #saveDraft({ notify = true } = {}) {
    if (!this.#draft) return false;

    this.#syncDraftFromForm();
    if (!this.#hasDraftChanges()) return false;

    await this.actor.setFlag(FALLOUT_MAW.id, ADVANCEMENT_COMMIT_FLAG, {
      level: this.#draft.level,
      characteristics: foundry.utils.deepClone(this.#draft.characteristics),
      development: foundry.utils.deepClone(this.#draft.development)
    });

    this.#snapshot = foundry.utils.deepClone(this.#draft);
    this.#floor = foundry.utils.deepClone(this.#draft);
    if (notify) ui.notifications.info(localize("FALLOUTMAW.Messages.AdvancementSaved"));
    return true;
  }

  async #applyDraftToActor() {
    await this.actor.update({
      "system.attributes.level": this.#draft.level,
      "system.characteristics": foundry.utils.deepClone(this.#draft.characteristics),
      "system.development": foundry.utils.deepClone(this.#draft.development)
    });
  }

  #syncDraftFromActor() {
    const characteristicSettings = getCharacteristicSettings();
    const skillSettings = getSkillSettings();
    const development = cloneActorDevelopment(this.actor.getDevelopment(), characteristicSettings, skillSettings);

    this.#draft = {
      level: Math.max(1, toInteger(this.actor.system?.attributes?.level)),
      characteristics: Object.fromEntries(
        characteristicSettings.map(characteristic => [
          characteristic.key,
          toInteger(this.actor.system?._source?.characteristics?.[characteristic.key] ?? this.actor.system?.characteristics?.[characteristic.key])
        ])
      ),
      development
    };
  }

  #readCommittedState(characteristicSettings, skillSettings) {
    const committed = this.actor.getFlag(FALLOUT_MAW.id, ADVANCEMENT_COMMIT_FLAG);
    if (!committed || (typeof committed !== "object")) return null;

    return {
      level: Math.max(1, toInteger(committed.level)),
      characteristics: Object.fromEntries(
        characteristicSettings.map(characteristic => [characteristic.key, toInteger(committed.characteristics?.[characteristic.key])])
      ),
      development: cloneActorDevelopment(committed.development, characteristicSettings, skillSettings)
    };
  }

  #hasDraftChanges() {
    return JSON.stringify(this.#draft) !== JSON.stringify(this.#snapshot);
  }
}
