import {
  calculateSkillPointMultiplier,
  calculatePureSkillDevelopmentValue,
  calculateRemainingDevelopmentPoints,
  cloneActorDevelopment,
  FIXED_SIGNATURE_SKILL_MULTIPLIER,
  getSkillPointMultiplierBreakdown,
  resolveSkillAdvancementMultiplierChanges
} from "./index.mjs";
import { FALLOUT_MAW } from "../config/system-config.mjs";
import {
  getCharacteristicSettings,
  getCreatureRaceSummaries,
  getAbilityCatalog,
  getLevelSettings,
  getPreparedRuntimeSettings,
  getProficiencySettings,
  getSkillAdvancementSettings,
  getSkillDevelopmentCostSettings,
  getSkillSettings
} from "../settings/accessors.mjs";
import { evaluateFormula, evaluateSkillFormulas } from "../formulas/index.mjs";
import {
  DEFAULT_PROFICIENCY_POINTS_PER_LEVEL_FORMULA,
  DEFAULT_RESEARCH_POINTS_PER_LEVEL_FORMULA,
  DEFAULT_SKILL_POINTS_PER_LEVEL_FORMULA
} from "../config/defaults.mjs";
import {
  actorHasAbility,
  completeAbilityResearch,
  findCatalogAbility,
  grantCatalogAbility,
  hasUnsafeAbilityEvolutionAcquisitionChanges
} from "../abilities/purchase.mjs";
import { getSkillAdvancementMultiplierChanges } from "../abilities/evaluation.mjs";
import {
  applyAdvancementPureCharacteristic,
  collectAdvancementPureValueProjection
} from "./pure-value-effects.mjs";
import { formatResearchValue } from "../research/storage.mjs";
import {
  ABILITY_ACQUISITION_ABILITY_MODES,
  ABILITY_ACQUISITION_CONDITION_TYPES,
  abilityHasEvolutions,
  getAbilityEvolutionFamilyIds,
  getAbilitySourceId,
  LOCKED_FEATURES_CATEGORY_ID,
  prepareAbilityItemData
} from "../settings/abilities.mjs";
import { getLevelThreshold } from "../settings/levels.mjs";
import {
  getNextSkillDevelopmentCostThreshold,
  getSkillDevelopmentCostForValue
} from "../settings/skill-development-costs.mjs";
import { TEMPLATES } from "../constants.mjs";
import { localize } from "../utils/i18n.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { applySkillBonusPercent } from "../utils/skill-value.mjs";
import { escapeHtml } from "../utils/dom.mjs";
import { prepareIndicatorEntry as prepareDisplayIndicatorEntry } from "../utils/actor-display-data.mjs";
import { getOverlayBaseZIndex } from "../utils/overlay-layer.mjs";
import {
  clampGraphViewportToVisibleNode,
  createGraphSegmentViewport,
  readGraphViewportMetrics
} from "../utils/graph-viewport.mjs";
import { FalloutMaWFormApplicationV2 } from "../apps/base-form-application-v2.mjs";
import { calculateLevelHealthBonus, usesIndependentHealthModel } from "../combat/independent-health.mjs";

const { DialogV2 } = foundry.applications.api;
const TextEditor = foundry.applications.ux.TextEditor.implementation;
const ADVANCEMENT_COMMIT_FLAG = "advancementCommit";
const ADVANCEMENT_UPDATE_SOURCE_OPTION = "falloutMawAdvancementApplicationId";
const ADVANCEMENT_PAGES = ["development", "abilities", "proficiencies"];
const ADVANCEMENT_PAGES_WITHOUT_PROFICIENCIES = ["development", "abilities"];
const REPEAT_INITIAL_DELAY_MS = 180;
const REPEAT_INTERVAL_MS = 45;
const ABILITY_EVOLUTION_NODE_WIDTH = 184;
const ABILITY_EVOLUTION_NODE_HEIGHT = 76;
const ABILITY_EVOLUTION_ZOOM_MIN = 0.35;
const ABILITY_EVOLUTION_ZOOM_MAX = 2.25;
const ABILITY_EVOLUTION_GRID_SIZE = 22;
const ABILITY_EVOLUTION_MAJOR_GRID_SIZE = 110;
export class AdvancementApplication extends FalloutMaWFormApplicationV2 {
  #activeEffectHooks = [];
  #abilityById = new Map();
  #abilityEntriesById = new Map();
  #abilityEvolutionAnimatedFamilySourceId = "";
  #abilityEvolutionAbortController = null;
  #abilityEvolutionCompletedIds = new Set();
  #abilityEvolutionGraph = { links: [], nodes: [] };
  #abilityEvolutionLayer = null;
  #abilityEvolutionPreparationContext = null;
  #abilityEvolutionViewportMetrics = null;
  #abilityEvolutionViewports = new Map();
  #abilityRequirementContext = null;
  #abilityRequirementRowsById = new Map();
  #abilityTooltipHTMLCache = new Map();
  #advancementPureValues = null;
  #actorUpdateHookId = null;
  #abilityTooltipAnchor = null;
  #abilityTooltipDocument = null;
  #abilityTooltipDocumentAbortController = null;
  #abilityTooltipElement = null;
  #abilityTooltipPinned = false;
  #abilityTooltipTimer = null;
  #abilityTooltipTimerView = null;
  #draft = null;
  #experienceSyncTimer = null;
  #expandedAbilityCategories = new Set();
  #floor = null;
  #gmMode = false;
  #isClosing = false;
  #page = "development";
  #repeatCommitPromise = Promise.resolve();
  #repeatCommitTimer = null;
  #repeatClickSuppression = null;
  #researchPointSessionSpent = 0;
  #repeatState = null;
  #selectedAbilitySourceId = "";
  #selectedAbilityFamilySourceId = "";
  #skillPointSessionSpent = 0;
  #skillUpgradeCostLedger = new Map();
  #skillCostTooltipAnchor = null;
  #skillCostTooltipElement = null;
  #skillCostTooltipRestoreKey = "";
  #skillCostTooltipTimer = null;
  #skillAdvancementMultiplierSource = null;
  #skillAdvancementMultiplierChanges = null;
  #snapshot = null;

  constructor(actor, options = {}) {
    super(options);
    this.actor = actor;
    this.#actorUpdateHookId = Hooks.on(
      "updateActor",
      (updatedActor, changes, updateOptions) => this.#onActorUpdated(updatedActor, changes, updateOptions)
    );
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
      grantAbility: this.#onGrantAbility,
      increaseSkill: this.#onIncreaseSkill,
      nextPage: this.#onNextPage,
      previousPage: this.#onPreviousPage,
      selectAbility: this.#onSelectAbility,
      spendAbilityResearch: this.#onSpendAbilityResearch,
      startAbilityResearch: this.#onStartAbilityResearch,
      levelUp: this.#onLevelUp,
      purchaseTraitAbility: this.#onPurchaseTraitAbility,
      closeAbilityEvolution: this.#onCloseAbilityEvolution,
      resetAbilityEvolutionView: this.#onResetAbilityEvolutionView,
      selectAbilityEvolutionNode: this.#onSelectAbilityEvolutionNode,
      resetDevelopment: this.#onResetDevelopment,
      toggleAbilityCategory: this.#onToggleAbilityCategory,
      toggleGMMode: this.#onToggleGMMode,
      toggleSignatureSkill: this.#onToggleSignatureSkill
    }
  };

  static PARTS = {
    page: {
      template: TEMPLATES.advancement.development
    },
    navigation: {
      template: TEMPLATES.advancement.navigation
    }
  };

  static get scrollPreservationSelectors() {
    return [
      ...super.scrollPreservationSelectors,
      ".fallout-maw-advancement-talents-list"
    ];
  }

  get title() {
    return this.actor?.name || localize("FALLOUTMAW.Advancement.Title");
  }

  render(options = {}) {
    this.#skillCostTooltipRestoreKey = (this.#skillCostTooltipElement || this.#skillCostTooltipTimer)
      ? String(this.#skillCostTooltipAnchor?.dataset?.skillKey ?? "")
      : "";
    return super.render(options);
  }

  _configureRenderOptions(options) {
    options.parts ??= ["page", "navigation"];
    super._configureRenderOptions(options);
  }

  _configureRenderParts(options) {
    const parts = super._configureRenderParts(options);
    parts.page.template = TEMPLATES.advancement[this.#page];
    parts.page.templates = this.#page === "abilities"
      ? [
          TEMPLATES.advancement.abilityDetails,
          TEMPLATES.advancement.abilityEvolutionPanel
        ]
      : [];
    return parts;
  }

  _getFrameButtons(options) {
    const buttons = super._getFrameButtons(options);
    if (game.user?.isGM) {
      buttons.push({
        action: "toggleGMMode",
        icon: "fallout-maw-advancement-gm-toggle",
        label: "ГМ режим"
      });
    }
    return buttons;
  }

  async _prepareContext(options) {
    await this.#ensureDraft();
    if (this.#page === "abilities") return this.#prepareAbilitiesPageContext(options);
    if (this.#page === "proficiencies") return this.#prepareProficienciesPageContext(options);

    const characteristicSettings = getCharacteristicSettings();
    const skillSettings = getSkillSettings();
    const skillAdvancementSettings = getSkillAdvancementSettings(characteristicSettings, skillSettings);
    this.#advancementPureValues ??= collectAdvancementPureValueProjection(
      this.actor,
      characteristicSettings,
      skillSettings
    );
    this.#skillAdvancementMultiplierSource ??= getSkillAdvancementMultiplierChanges(this.actor, skillSettings);
    const skillDevelopmentCostSettings = getSkillDevelopmentCostSettings();
    const skillDevelopmentLimit = Math.max(0, toInteger(skillAdvancementSettings.developmentLimit));
    const levelSettings = getLevelSettings();
    const race = getCreatureRaceSummaries()
      .find(entry => entry.id === this.actor.system?.creature?.raceId) ?? null;
    const remaining = calculateRemainingDevelopmentPoints(this.#draft.development);
    const maxLevel = levelSettings[levelSettings.length - 1]?.level ?? 100;
    const liveCharacteristics = this.actor.system?.characteristics ?? this.#draft.characteristics;
    const cleanCharacteristics = this.#getCleanCharacteristics(characteristicSettings);
    const skillAdvancementMultiplierChanges = this.#getSkillAdvancementMultiplierChanges(skillSettings, {
      characteristicSettings,
      skillAdvancementSettings,
      characteristics: cleanCharacteristics
    });
    const signatureSkillsDisabled = skillAdvancementMultiplierChanges.signatureSkillsDisabled === true;
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
    const canLevelUp = (this.#draft.level < maxLevel) && (this.#gmMode || (currentExperience >= nextThreshold));
    const pointDisplays = this.#preparePointDisplays(remaining);
    const pageIndex = this.#getPageIndex();
    const raceHealthEnabled = usesIndependentHealthModel(this.actor, getPreparedRuntimeSettings());
    const hasProficiencies = getProficiencySettings().length > 0;

    return {
      ...(await super._prepareContext(options)),
      actor: this.actor,
      isGMMode: this.#gmMode,
      raceName: race?.name || "\u2014",
      level: this.#draft.level,
      canLevelUp,
      experienceBarStyle: `width: ${experiencePercent.toFixed(2)}%;`,
      experienceCurrent: currentExperience,
      experienceNext: nextThreshold,
      raceHealthEnabled,
      healthFromLevel: raceHealthEnabled
        ? calculateLevelHealthBonus(
          this.actor.system?.progression?.healthPerLevel,
          cleanCharacteristics,
          characteristicSettings,
          this.#draft.level
        )
        : 0,
      skillPointsPerLevel: evaluateProgressionFormula(
        this.actor.system?.progression?.skillPointsPerLevel,
        cleanCharacteristics,
        characteristicSettings,
        DEFAULT_SKILL_POINTS_PER_LEVEL_FORMULA
      ),
      researchPointsPerLevel: evaluateProgressionFormula(
        this.actor.system?.progression?.researchPointsPerLevel,
        cleanCharacteristics,
        characteristicSettings,
        DEFAULT_RESEARCH_POINTS_PER_LEVEL_FORMULA
      ),
      proficiencyPointsPerLevel: hasProficiencies
        ? evaluateProgressionFormula(
          this.actor.system?.progression?.proficiencyPointsPerLevel,
          cleanCharacteristics,
          characteristicSettings,
          DEFAULT_PROFICIENCY_POINTS_PER_LEVEL_FORMULA
        )
        : 0,
      characteristicPointsDisplay: pointDisplays.characteristics,
      skillPointsDisplay: pointDisplays.skills,
      signatureSkillPointsDisplay: signatureSkillsDisabled ? "Недоступно" : pointDisplays.signatureSkills,
      signatureSkillsDisabled,
      traitPointsDisplay: pointDisplays.traits,
      researchPointsDisplay: pointDisplays.researches,
      proficiencyPointsDisplay: pointDisplays.proficiencies,
      hasProficiencies,
      page: this.#page,
      isDevelopmentPage: this.#page === "development",
      isProficienciesPage: this.#page === "proficiencies",
      isAbilitiesPage: this.#page === "abilities",
      isFirstPage: pageIndex <= 0,
      isLastPage: pageIndex >= (this.#getPages().length - 1),
      characteristics: characteristicSettings.map(characteristic => {
        const floorPoints = toInteger(this.#floor.development.characteristics?.[characteristic.key]);
        const currentPoints = toInteger(this.#draft.development.characteristics?.[characteristic.key]);
        return {
          ...characteristic,
          value: toInteger(liveCharacteristics?.[characteristic.key]),
          canIncrease: this.#gmMode || remaining.characteristics > 0,
          canDecrease: this.#gmMode ? toInteger(liveCharacteristics?.[characteristic.key]) > 0 : currentPoints > floorPoints
        };
      }),
      skills: skillSettings.map(skill => {
        const floorSkill = this.#floor.development.skills?.[skill.key] ?? {};
        const currentSkill = this.#draft.development.skills?.[skill.key] ?? {};
        const storedSignature = Boolean(currentSkill.signature);
        const canUnsetSignature = storedSignature && !floorSkill.signature;
        const pureValue = this.#getPureSkillValue(skill.key, {
          characteristicSettings,
          skillSettings,
          skillAdvancementSettings,
          characteristics: cleanCharacteristics,
          multiplierChanges: skillAdvancementMultiplierChanges
        });
        const cost = getSkillDevelopmentCostForValue(pureValue, skillDevelopmentCostSettings);
        const nextThreshold = getNextSkillDevelopmentCostThreshold(pureValue, skillDevelopmentCostSettings);
        const totalValue = this.#getPreviewSkillValue(skill.key, {
          characteristicSettings,
          skillSettings,
          skillAdvancementSettings,
          characteristics: cleanCharacteristics,
          multiplierChanges: skillAdvancementMultiplierChanges,
          pureValue
        });
        const signature = storedSignature && !signatureSkillsDisabled;
        const skillGain = calculateSkillDevelopmentGain({
          skill,
          characteristics: cleanCharacteristics,
          advancementSettings: skillAdvancementSettings,
          multiplierChanges: skillAdvancementMultiplierChanges,
          signature
        });
        const multiplierLabel = formatSkillDevelopmentMultiplier({
          skill,
          characteristics: cleanCharacteristics,
          characteristicSettings,
          advancementSettings: skillAdvancementSettings,
          multiplierChanges: skillAdvancementMultiplierChanges,
          signature
        });
        const versatileDevelopment = skillAdvancementMultiplierChanges.versatileDevelopment;
        const versatileDevelopmentState = getVersatileDevelopmentButtonState(versatileDevelopment, skill.key);
        return {
          ...skill,
          value: totalValue,
          signature,
          canIncrease: this.#gmMode
            ? pureValue < skillDevelopmentLimit
            : remaining.skills >= cost && pureValue < skillDevelopmentLimit,
          canDecrease: this.#gmMode
            ? toInteger(currentSkill.points) > 0
            : toInteger(currentSkill.points) > toInteger(floorSkill.points),
          canToggleSignature: !signatureSkillsDisabled && (storedSignature
            ? (this.#gmMode || canUnsetSignature)
            : (this.#gmMode || remaining.signatureSkills > 0)),
          cost,
          pureValue,
          versatileDevelopmentState,
          tooltipHTML: this.#gmMode ? "" : renderSkillCostTooltipHTML({
            skill,
            totalValue,
            pureValue,
            investedPoints: toInteger(currentSkill.points),
            cost,
            gain: skillGain,
            multiplierLabel,
            nextThreshold,
            remainingSkillPoints: remaining.skills
          })
        };
      })
    };
  }

  async #prepareProficienciesPageContext(options) {
    const remaining = calculateRemainingDevelopmentPoints(this.#draft.development);
    const pointDisplays = this.#preparePointDisplays(remaining);
    const pageIndex = this.#getPageIndex();
    return {
      ...(await super._prepareContext(options)),
      actor: this.actor,
      isGMMode: this.#gmMode,
      page: this.#page,
      isDevelopmentPage: false,
      isProficienciesPage: true,
      isAbilitiesPage: false,
      isFirstPage: pageIndex <= 0,
      isLastPage: pageIndex >= (this.#getPages().length - 1),
      proficiencyPointsDisplay: pointDisplays.proficiencies,
      proficiencies: getProficiencySettings().map(proficiency => this.#prepareProficiencyEntry(proficiency, remaining))
    };
  }

  async #prepareAbilitiesPageContext(options) {
    const characteristicSettings = getCharacteristicSettings();
    const skillSettings = getSkillSettings();
    const skillAdvancementSettings = getSkillAdvancementSettings(characteristicSettings, skillSettings);
    this.#advancementPureValues ??= collectAdvancementPureValueProjection(this.actor, characteristicSettings, skillSettings);
    this.#skillAdvancementMultiplierSource ??= getSkillAdvancementMultiplierChanges(this.actor, skillSettings);
    const remaining = calculateRemainingDevelopmentPoints(this.#draft.development);
    const characteristics = this.#getCleanCharacteristics(characteristicSettings);
    const multiplierChanges = this.#getSkillAdvancementMultiplierChanges(skillSettings, {
      characteristicSettings,
      skillAdvancementSettings,
      characteristics
    });
    const requirementContext = this.#getAbilityRequirementContext({
      characteristicSettings,
      skillSettings,
      skillAdvancementSettings,
      characteristics,
      multiplierChanges
    });
    const abilityCategories = this.#prepareAbilityCategories(remaining, skillSettings, requirementContext, {
      characteristicSettings,
      races: getCreatureRaceSummaries()
    });
    const pointDisplays = this.#preparePointDisplays(remaining);
    const pageIndex = this.#getPageIndex();
    const abilityEvolutionPanel = this.#prepareAbilityEvolutionPanel();
    return {
      ...(await super._prepareContext(options)),
      actor: this.actor,
      isGMMode: this.#gmMode,
      page: this.#page,
      isDevelopmentPage: false,
      isProficienciesPage: false,
      isAbilitiesPage: true,
      isFirstPage: pageIndex <= 0,
      isLastPage: pageIndex >= (this.#getPages().length - 1),
      traitPointsDisplay: pointDisplays.traits,
      researchPointsDisplay: pointDisplays.researches,
      abilityCategories,
      selectedAbility: this.#prepareSelectedAbility(),
      abilityEvolutionPanel
    };
  }

  async _processFormData(_event, _form, _formData) {
    await this.#saveDraft();
    return this.forceRender();
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.#syncPageClass();
    this.#syncGMModeFrame();
    this.#clearAbilityDescriptionTooltip();
    this.#activateRepeatButtons();
    this.#activateProficiencySliders();
    this.#activateAbilitySearch();
    this.#activateAbilityDescriptionTooltips();
    this.#mountAbilityEvolutionLayer();
    this.#activateSkillCostTooltips();
    this.#restoreSkillCostTooltip();
  }

  #syncPageClass() {
    this.element?.classList.toggle("fallout-maw-advancement-page-abilities", this.#page === "abilities");
    this.element?.classList.toggle("fallout-maw-advancement-page-proficiencies", this.#page === "proficiencies");
  }

  #syncGMModeFrame() {
    const enabled = Boolean(game.user?.isGM && this.#gmMode);
    this.element?.classList.toggle("fallout-maw-advancement-gm-mode", enabled);
    const toggle = this.element?.querySelector?.('[data-action="toggleGMMode"]');
    toggle?.classList.toggle("active", enabled);
    toggle?.setAttribute("aria-pressed", String(enabled));
  }

  async _preClose(options) {
    this.#isClosing = true;
    window.clearTimeout(this.#experienceSyncTimer);
    this.#clearAbilityDescriptionTooltip();
    this.#clearSkillCostTooltip();
    this.#abilityTooltipDocumentAbortController?.abort();
    this.#abilityTooltipDocument = null;
    this.#abilityTooltipDocumentAbortController = null;
    this.#removeAbilityEvolutionLayer();
    await this.#stopRepeat({ flush: true });
    if (this.#actorUpdateHookId !== null) {
      Hooks.off("updateActor", this.#actorUpdateHookId);
      this.#actorUpdateHookId = null;
    }
    for (const hook of this.#activeEffectHooks) Hooks.off(hook.event, hook.id);
    this.#activeEffectHooks = [];
    this.#syncDraftFromForm();
    await this.#saveDraft({ notify: false });
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
    if (this.#getSkillAdvancementMultiplierChanges().signatureSkillsDisabled === true) {
      return this.forceRender();
    }

    const currentValue = Boolean(this.#draft.development.skills[key]?.signature);
    if (this.#gmMode) {
      this.#draft.development.skills[key].signature = !currentValue;
      this.#invalidateSkillAdvancementMultiplierChanges();
      await this.#applyDraftToActor();
      return this.forceRender();
    }

    if (currentValue) {
      if (this.#floor.development.skills[key]?.signature) return;
      this.#draft.development.skills[key].signature = false;
      this.#draft.development.points.signatureSkills = Math.max(0, toInteger(this.#draft.development.points.signatureSkills)) + 1;
      this.#invalidateSkillAdvancementMultiplierChanges();
      await this.#applyDraftToActor();
      return this.forceRender();
    }

    const available = Math.max(0, toInteger(this.#draft.development.points.signatureSkills));
    if (available < 1) return;

    this.#draft.development.skills[key].signature = true;
    this.#draft.development.points.signatureSkills = available - 1;
    this.#invalidateSkillAdvancementMultiplierChanges();
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
    if (!this.#gmMode && toInteger(this.#draft.development.experience) < nextThreshold) return;

    this.#draft.level += 1;
    const raceHealthEnabled = usesIndependentHealthModel(this.actor, getPreparedRuntimeSettings());
    const characteristicSettings = raceHealthEnabled || !this.#gmMode ? getCharacteristicSettings() : [];
    const cleanCharacteristics = characteristicSettings.length
      ? this.#getCleanCharacteristics(characteristicSettings)
      : {};
    if (raceHealthEnabled) {
      this.#draft.development.health = calculateLevelHealthBonus(
        this.actor.system?.progression?.healthPerLevel,
        cleanCharacteristics,
        characteristicSettings,
        this.#draft.level
      );
      this.#draft.development.healthInitialized = true;
    }
    if (this.#gmMode) {
      await this.#applyDraftToActor();
      return this.forceRender();
    }

    this.#draft.development.points.skills += evaluateProgressionFormula(
      this.actor.system?.progression?.skillPointsPerLevel,
      cleanCharacteristics,
      characteristicSettings,
      DEFAULT_SKILL_POINTS_PER_LEVEL_FORMULA
    );
    this.#draft.development.points.researches += evaluateProgressionFormula(
      this.actor.system?.progression?.researchPointsPerLevel,
      cleanCharacteristics,
      characteristicSettings,
      DEFAULT_RESEARCH_POINTS_PER_LEVEL_FORMULA
    );
    if (getProficiencySettings().length) {
      this.#draft.development.points.proficiencies += evaluateProgressionFormula(
        this.actor.system?.progression?.proficiencyPointsPerLevel,
        cleanCharacteristics,
        characteristicSettings,
        DEFAULT_PROFICIENCY_POINTS_PER_LEVEL_FORMULA
      );
    }
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

    const currentExperience = Math.max(0, toInteger(this.#draft.development?.experience));
    const resetData = this.actor.prepareDevelopmentResetData({
      level: 1,
      experience: currentExperience
    });

    this.#draft.level = 1;
    this.#draft.characteristics = foundry.utils.deepClone(resetData.characteristics);
    this.#draft.proficiencies = this.#getProficiencyValuesFromResourceMap(resetData.proficiencies, getProficiencySettings());
    this.#draft.development = foundry.utils.deepClone(resetData.development);
    this.#researchPointSessionSpent = 0;
    const abilityItemIds = this.actor.items
      .filter(item => item.type === "ability")
      .map(item => item.id);
    if (abilityItemIds.length) await this.actor.deleteEmbeddedDocuments("Item", abilityItemIds);
    await this.#applyDraftToActor();
    await this.actor.setFlag(FALLOUT_MAW.id, ADVANCEMENT_COMMIT_FLAG, {
      level: this.#draft.level,
      characteristics: foundry.utils.deepClone(this.#draft.characteristics),
      proficiencies: foundry.utils.deepClone(this.#draft.proficiencies),
      development: foundry.utils.deepClone(this.#draft.development)
    });
    this.#snapshot = foundry.utils.deepClone(this.#draft);
    this.#floor = foundry.utils.deepClone(this.#draft);
    this.#resetSkillUpgradeCostLedger();
    this.#researchPointSessionSpent = 0;
    return this.forceRender();
  }

  async #ensureDraft() {
    if (this.#draft) return;

    const characteristicSettings = getCharacteristicSettings();
    const proficiencySettings = getProficiencySettings();
    const skillSettings = getSkillSettings();
    const development = await this.actor.ensureDevelopmentInitialized();
    const normalized = cloneActorDevelopment(development, characteristicSettings, skillSettings, proficiencySettings);
    const currentState = {
      level: Math.max(1, toInteger(this.actor.system?.attributes?.level)),
      characteristics: Object.fromEntries(
        characteristicSettings.map(characteristic => [characteristic.key, toInteger(this.actor.system?._source?.characteristics?.[characteristic.key] ?? this.actor.system?.characteristics?.[characteristic.key])])
      ),
      proficiencies: this.#getActorProficiencyValues(proficiencySettings),
      development: cloneActorDevelopment(normalized, characteristicSettings, skillSettings, proficiencySettings)
    };
    const committed = this.#readCommittedState(characteristicSettings, skillSettings, proficiencySettings) ?? currentState;

    this.#snapshot = foundry.utils.deepClone(committed);
    this.#draft = foundry.utils.deepClone(currentState);
    this.#floor = foundry.utils.deepClone(committed);
    this.#rebuildSkillUpgradeCostLedger();
  }

  #activateRepeatButtons() {
    for (const button of this.element?.querySelectorAll?.("[data-repeat-action]") ?? []) {
      button.addEventListener("click", event => this.#onRepeatButtonClick(event));
      button.addEventListener("pointerdown", event => this.#onRepeatButtonPointerDown(event));
    }
  }

  #activateProficiencySliders() {
    for (const input of this.element?.querySelectorAll?.("[data-proficiency-slider]") ?? []) {
      input.addEventListener("input", event => {
        void this.#onProficiencySliderInput(event);
      });
      input.addEventListener("change", event => {
        void this.#onProficiencySliderInput(event, { flush: true });
      });
    }
  }

  async #onProficiencySliderInput(event, { flush = false } = {}) {
    const target = event.currentTarget;
    if (!(target instanceof HTMLInputElement)) return;

    await this.#ensureDraft();
    const key = target.dataset.proficiencyKey ?? "";
    if (!key) return;

    const changed = this.#setProficiencyValue(key, target.value);
    this.#refreshProficiencyPreview(key);
    if (!changed) return;

    this.#scheduleRepeatCommit();
    if (flush) await this.#flushRepeatCommit();
  }

  #activateAbilitySearch() {
    const input = this.element?.querySelector?.("[data-ability-search]");
    if (!(input instanceof HTMLInputElement)) return;

    input.addEventListener("input", () => {
      const query = input.value.trim().toLocaleLowerCase();
      for (const category of this.element.querySelectorAll("[data-ability-category]")) {
        let visibleCount = 0;
        category.classList.toggle("searching", Boolean(query));
        for (const entry of category.querySelectorAll("[data-ability-entry]")) {
          const searchText = entry.dataset.abilitySearchText?.toLocaleLowerCase() ?? "";
          const visible = !query || searchText.includes(query);
          entry.hidden = !visible;
          if (visible) visibleCount += 1;
        }
        category.hidden = query ? visibleCount === 0 : false;
      }
    });
  }

  #activateAbilityDescriptionTooltips() {
    const root = this.element;
    if (!root) return;
    this.#bindAbilityDescriptionTooltipEvents(root);
    this.#bindAbilityDescriptionTooltipDocument(root.ownerDocument ?? globalThis.document);
  }

  #bindAbilityDescriptionTooltipDocument(ownerDocument) {
    if (!ownerDocument || (this.#abilityTooltipDocument === ownerDocument
      && this.#abilityTooltipDocumentAbortController)) return;
    const view = ownerDocument?.defaultView ?? globalThis.window;
    this.#abilityTooltipDocumentAbortController?.abort();
    this.#abilityTooltipDocument = ownerDocument;
    this.#abilityTooltipDocumentAbortController = new view.AbortController();
    ownerDocument.addEventListener("pointerdown", event => this.#onAbilityDescriptionDocumentPointerDown(event), {
      capture: true,
      signal: this.#abilityTooltipDocumentAbortController.signal
    });
  }

  #bindAbilityDescriptionTooltipEvents(root, { signal } = {}) {
    if (!root || root.dataset.abilityDescriptionTooltipsBound === "true") return;
    root.dataset.abilityDescriptionTooltipsBound = "true";
    const eventOptions = signal ? { signal } : undefined;
    const captureOptions = signal ? { capture: true, signal } : { capture: true };
    root.addEventListener("pointerdown", event => this.#onAbilityDescriptionMiddlePointerDown(event), captureOptions);
    root.addEventListener("mousedown", event => this.#onAbilityDescriptionMiddlePointerDown(event), captureOptions);
    root.addEventListener("pointerover", event => this.#onAbilityDescriptionPointerOver(event), eventOptions);
    root.addEventListener("pointerout", event => this.#onAbilityDescriptionPointerOut(event), eventOptions);
    root.addEventListener("auxclick", event => this.#onAbilityDescriptionAuxClick(event), eventOptions);
  }

  #onAbilityDescriptionMiddlePointerDown(event) {
    if (event.button !== 1) return;
    const anchor = event.target?.closest?.("[data-ability-description-source-id]");
    const insideTooltip = this.#abilityTooltipElement?.contains(event.target);
    if (!anchor && !insideTooltip) return;
    event.preventDefault();
  }

  #onAbilityDescriptionPointerOver(event) {
    if (this.#abilityTooltipPinned) return;
    const anchor = event.target?.closest?.("[data-ability-description-source-id]");
    if (!anchor || anchor.contains(event.relatedTarget)) return;

    this.#clearAbilityDescriptionTooltip();
    this.#abilityTooltipAnchor = anchor;
    const view = anchor.ownerDocument?.defaultView ?? globalThis.window;
    this.#abilityTooltipTimerView = view;
    this.#abilityTooltipTimer = view.setTimeout(() => {
      this.#abilityTooltipTimer = null;
      this.#abilityTooltipTimerView = null;
      void this.#showAbilityDescriptionTooltip(anchor);
    }, 500);
  }

  #onAbilityDescriptionPointerOut(event) {
    const anchor = event.target?.closest?.("[data-ability-description-source-id]");
    if (!anchor || anchor.contains(event.relatedTarget)) return;
    if (this.#abilityTooltipPinned) return;
    if (this.#abilityTooltipElement?.contains(event.relatedTarget)) return;
    this.#clearAbilityDescriptionTooltip();
  }

  #onAbilityDescriptionAuxClick(event) {
    if (event.button !== 1) return;
    const anchor = event.target?.closest?.("[data-ability-description-source-id]");
    if (!anchor) return;

    event.preventDefault();
    event.stopPropagation();
    if (this.#abilityTooltipPinned && this.#abilityTooltipAnchor === anchor) {
      this.#clearAbilityDescriptionTooltip();
      return;
    }

    this.#clearAbilityDescriptionTooltip();
    this.#abilityTooltipAnchor = anchor;
    void this.#showAbilityDescriptionTooltip(anchor, { pinned: true });
  }

  #onAbilityDescriptionDocumentPointerDown(event) {
    if (!this.#abilityTooltipElement) return;
    const anchor = event.target?.closest?.("[data-ability-description-source-id]");
    const insideTooltip = this.#abilityTooltipElement.contains(event.target);
    if (event.button === 1 && (anchor || insideTooltip)) event.preventDefault();
    if (anchor) return;
    if (insideTooltip) return;
    this.#clearAbilityDescriptionTooltip();
  }

  async #showAbilityDescriptionTooltip(anchor, { pinned = false } = {}) {
    if (this.#abilityTooltipTimer) {
      this.#abilityTooltipTimerView?.clearTimeout(this.#abilityTooltipTimer);
      this.#abilityTooltipTimer = null;
      this.#abilityTooltipTimerView = null;
    }
    if (!anchor?.isConnected || this.#abilityTooltipAnchor !== anchor) return;

    const sourceId = String(anchor.dataset.abilityDescriptionSourceId ?? "");
    const descriptionMode = String(anchor.dataset.abilityDescriptionMode ?? "full");
    const source = this.#abilityById.get(sourceId);
    if (!source) return;
    const cacheKey = `${descriptionMode}\u0000${sourceId}`;
    let html = this.#abilityTooltipHTMLCache.get(cacheKey);
    if (html === undefined) {
      const summary = String(source.ability?.evolutionSummary ?? "").trim();
      const tooltipAbility = descriptionMode === "evolution-summary" && summary
        ? { ...source.ability, description: summary }
        : source.ability;
      html = await renderAbilityDescriptionTooltipHTML(tooltipAbility, {
        actor: this.actor,
        requirementRows: this.#abilityRequirementRowsById.get(sourceId) ?? []
      });
      this.#abilityTooltipHTMLCache.set(cacheKey, html);
    }
    if (!html || !anchor.isConnected || this.#abilityTooltipAnchor !== anchor) return;

    const ownerDocument = anchor.ownerDocument ?? globalThis.document;
    const view = ownerDocument?.defaultView ?? globalThis.window;
    this.#bindAbilityDescriptionTooltipDocument(ownerDocument);
    const tooltip = ownerDocument.createElement("aside");
    tooltip.className = "fallout-maw-inventory-tooltip fallout-maw-ability-description-tooltip";
    tooltip.classList.toggle("pinned", pinned);
    tooltip.style.pointerEvents = "auto";
    tooltip.innerHTML = `<div class="content fallout-maw-ability-tooltip-content">${html}</div>`;
    const preventMiddleAutoscroll = event => {
      if (event.button !== 1) return;
      event.preventDefault();
    };
    tooltip.addEventListener("pointerdown", preventMiddleAutoscroll, { capture: true });
    tooltip.addEventListener("mousedown", preventMiddleAutoscroll, { capture: true });
    tooltip.addEventListener("pointerleave", event => {
      if (this.#abilityTooltipAnchor?.contains(event.relatedTarget)) return;
      this.#clearAbilityDescriptionTooltip();
    });
    (ownerDocument.body ?? ownerDocument.documentElement).append(tooltip);
    this.#abilityTooltipElement = tooltip;
    this.#abilityTooltipPinned = pinned;
    this.#positionAdvancementTooltip(tooltip, anchor);
    view.requestAnimationFrame(() => this.#positionAdvancementTooltip(tooltip, anchor));
  }

  #clearAbilityDescriptionTooltip() {
    if (this.#abilityTooltipTimer) {
      this.#abilityTooltipTimerView?.clearTimeout(this.#abilityTooltipTimer);
      this.#abilityTooltipTimer = null;
      this.#abilityTooltipTimerView = null;
    }
    this.#abilityTooltipElement?.remove();
    this.#abilityTooltipElement = null;
    this.#abilityTooltipAnchor = null;
    this.#abilityTooltipPinned = false;
  }

  #activateSkillCostTooltips() {
    const root = this.element;
    if (!root || root.dataset.skillCostTooltipsBound === "true") return;
    root.dataset.skillCostTooltipsBound = "true";
    root.addEventListener("pointerover", event => this.#onSkillCostPointerOver(event));
    root.addEventListener("pointerout", event => this.#onSkillCostPointerOut(event));
  }

  #onSkillCostPointerOver(event) {
    const anchor = event.target?.closest?.("[data-skill-cost-tooltip]");
    if (!anchor || anchor.contains(event.relatedTarget)) return;
    const key = String(anchor.dataset.skillKey ?? "");
    if (key) this.#refreshSkillCostPreview(key);
    const html = String(anchor.dataset.skillCostTooltip ?? "").trim();
    if (!html) return;

    this.#clearSkillCostTooltip();
    this.#skillCostTooltipAnchor = anchor;
    this.#skillCostTooltipTimer = window.setTimeout(() => this.#showSkillCostTooltip(anchor, html), 250);
  }

  #onSkillCostPointerOut(event) {
    const anchor = event.target?.closest?.("[data-skill-cost-tooltip]");
    if (!anchor || anchor.contains(event.relatedTarget)) return;
    if (this.#skillCostTooltipRestoreKey === anchor.dataset.skillKey) return;
    if (this.#skillCostTooltipElement?.contains(event.relatedTarget)) return;
    this.#clearSkillCostTooltip();
  }

  #showSkillCostTooltip(anchor, html) {
    if (this.#skillCostTooltipTimer) {
      window.clearTimeout(this.#skillCostTooltipTimer);
      this.#skillCostTooltipTimer = null;
    }
    if (!anchor?.isConnected || this.#skillCostTooltipAnchor !== anchor) return;

    const tooltip = document.createElement("aside");
    tooltip.className = "fallout-maw-inventory-tooltip fallout-maw-skill-cost-tooltip";
    tooltip.innerHTML = `<div class="content">${html}</div>`;
    tooltip.addEventListener("pointerleave", event => {
      if (this.#skillCostTooltipAnchor?.contains(event.relatedTarget)) return;
      this.#clearSkillCostTooltip();
    });
    document.body.append(tooltip);
    this.#skillCostTooltipElement = tooltip;
    this.#positionAdvancementTooltip(tooltip, anchor);
    requestAnimationFrame(() => this.#positionAdvancementTooltip(tooltip, anchor));
  }

  #clearSkillCostTooltip() {
    if (this.#skillCostTooltipTimer) {
      window.clearTimeout(this.#skillCostTooltipTimer);
      this.#skillCostTooltipTimer = null;
    }
    this.#skillCostTooltipElement?.remove();
    this.#skillCostTooltipElement = null;
    this.#skillCostTooltipAnchor = null;
  }

  #restoreSkillCostTooltip() {
    const key = this.#skillCostTooltipRestoreKey;
    this.#skillCostTooltipRestoreKey = "";
    if (!key || this.#gmMode) return;

    const anchor = this.element?.querySelector?.(
      `[data-repeat-action="increaseSkill"][data-skill-key="${CSS.escape(key)}"][data-skill-cost-tooltip]`
    );
    const html = String(anchor?.dataset?.skillCostTooltip ?? "").trim();
    if (!anchor || !html) {
      this.#clearSkillCostTooltip();
      return;
    }

    this.#skillCostTooltipAnchor = anchor;
    if (!this.#skillCostTooltipElement) {
      this.#showSkillCostTooltip(anchor, html);
      return;
    }

    this.#skillCostTooltipElement.innerHTML = `<div class="content">${html}</div>`;
    this.#positionAdvancementTooltip(this.#skillCostTooltipElement, anchor);
    requestAnimationFrame(() => this.#positionAdvancementTooltip(this.#skillCostTooltipElement, anchor));
  }

  #positionAdvancementTooltip(tooltip, anchor) {
    positionAbilityDescriptionTooltip(tooltip, anchor, {
      layerElement: this.element
    });
  }

  #syncDraftFromForm() {
    for (const input of this.form?.querySelectorAll?.("[data-proficiency-slider]") ?? []) {
      if (!(input instanceof HTMLInputElement)) continue;
      const key = input.dataset.proficiencyKey ?? "";
      if (!key) continue;
      this.#setProficiencyValue(key, input.value);
    }
    return undefined;
  }

  static async #onToggleGMMode(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return undefined;
    await this.#stopRepeat({ flush: true });
    this.#gmMode = !this.#gmMode;
    return this.forceRender();
  }

  async #changeCharacteristic(key, delta, { persist = true } = {}) {
    await this.#ensureDraft();
    this.#syncDraftFromForm();

    if (this.#gmMode) {
      if (delta < 0 && this.#getPreviewCharacteristicValue(key) <= 0) return false;
      this.#draft.characteristics[key] = toInteger(this.#draft.characteristics[key]) + delta;
      this.#invalidateSkillAdvancementMultiplierChanges();
      this.#refreshHealthDevelopment();
      if (persist) await this.#applyDraftToActor();
      return true;
    }

    if (delta > 0) {
      const available = Math.max(0, toInteger(this.#draft.development.points.characteristics));
      if (available < 1) return false;

      this.#draft.development.characteristics[key] = toInteger(this.#draft.development.characteristics[key]) + 1;
      this.#draft.development.points.characteristics = available - 1;
      this.#invalidateSkillAdvancementMultiplierChanges();
      this.#refreshHealthDevelopment();
      if (persist) await this.#applyDraftToActor();
      return true;
    }

    const currentPoints = toInteger(this.#draft.development.characteristics[key]);
    const minimumPoints = toInteger(this.#floor.development.characteristics[key]);
    if (currentPoints <= minimumPoints) return false;

    this.#draft.development.characteristics[key] = currentPoints - 1;
    this.#draft.development.points.characteristics = Math.max(0, toInteger(this.#draft.development.points.characteristics)) + 1;
    this.#invalidateSkillAdvancementMultiplierChanges();
    this.#refreshHealthDevelopment();
    if (persist) await this.#applyDraftToActor();
    return true;
  }

  #refreshHealthDevelopment() {
    if (!usesIndependentHealthModel(this.actor, getPreparedRuntimeSettings())) return;
    const characteristicSettings = getCharacteristicSettings();
    this.#draft.development.health = calculateLevelHealthBonus(
      this.actor.system?.progression?.healthPerLevel,
      this.#getCleanCharacteristics(characteristicSettings),
      characteristicSettings,
      this.#draft.level
    );
    this.#draft.development.healthInitialized = true;
  }

  async #changeSkill(key, delta, { persist = true } = {}) {
    await this.#ensureDraft();
    this.#syncDraftFromForm();

    if (this.#gmMode) {
      const currentPoints = toInteger(this.#draft.development.skills[key]?.points);
      if (delta < 0 && currentPoints <= 0) return false;
      if (delta > 0 && this.#getPreviewSkillPureValue(key) >= this.#getSkillDevelopmentLimit()) return false;
      this.#draft.development.skills[key].points = currentPoints + delta;
      this.#invalidateSkillAdvancementMultiplierChanges();
      if (persist) await this.#applyDraftToActor();
      return true;
    }

    if (delta > 0) {
      const available = Math.max(0, toInteger(this.#draft.development.points.skills));
      const cost = this.#getSkillUpgradeCost(key);
      if (available < cost) return false;
      if (this.#getPureSkillValue(key) >= this.#getSkillDevelopmentLimit()) return false;

      this.#draft.development.skills[key].points = toInteger(this.#draft.development.skills[key]?.points) + 1;
      this.#draft.development.points.skills = available - cost;
      this.#recordSkillUpgradeCost(key, cost);
      this.#invalidateSkillAdvancementMultiplierChanges();
      if (persist) await this.#applyDraftToActor();
      return true;
    }

    const currentPoints = toInteger(this.#draft.development.skills[key]?.points);
    const minimumPoints = toInteger(this.#floor.development.skills[key]?.points);
    if (currentPoints <= minimumPoints) return false;

    this.#draft.development.skills[key].points = currentPoints - 1;
    this.#invalidateSkillAdvancementMultiplierChanges();
    const recordedCost = this.#takeSkillUpgradeCost(key);
    const refund = recordedCost ?? this.#getSkillRefundCost(key, currentPoints - 1);
    this.#draft.development.points.skills = Math.max(0, toInteger(this.#draft.development.points.skills)) + refund;
    if (persist) await this.#applyDraftToActor();
    return true;
  }

  async #goToPageOffset(offset) {
    await this.#stopRepeat({ flush: true });
    this.#syncDraftFromForm();
    const currentIndex = this.#getPageIndex();
    const pages = this.#getPages();
    const nextIndex = Math.max(0, Math.min(pages.length - 1, currentIndex + offset));
    this.#page = pages[nextIndex];
    return this.forceRender();
  }

  #getPageIndex() {
    const index = this.#getPages().indexOf(this.#page);
    return index >= 0 ? index : 0;
  }

  #getPages() {
    return getProficiencySettings().length
      ? ADVANCEMENT_PAGES
      : ADVANCEMENT_PAGES_WITHOUT_PROFICIENCIES;
  }

  static #onNextPage(event) {
    event.preventDefault();
    return this.#goToPageOffset(1);
  }

  static #onPreviousPage(event) {
    event.preventDefault();
    return this.#goToPageOffset(-1);
  }

  static #onToggleAbilityCategory(event, target) {
    event.preventDefault();
    const categoryId = target.dataset.categoryId ?? "";
    if (!categoryId) return undefined;
    if (this.#expandedAbilityCategories.has(categoryId)) this.#expandedAbilityCategories.delete(categoryId);
    else this.#expandedAbilityCategories.add(categoryId);
    const expanded = this.#expandedAbilityCategories.has(categoryId);
    target.closest("[data-ability-category]")?.classList.toggle("collapsed", !expanded);
    const icon = target.querySelector(".fallout-maw-advancement-collapse-icon");
    if (icon) icon.textContent = expanded ? "▼" : "▶";
    return undefined;
  }

  static async #onSelectAbility(event, target) {
    event.preventDefault();
    const sourceId = target.dataset.abilitySourceId ?? "";
    if (!sourceId) return undefined;
    const familySourceId = target.dataset.abilityFamilySourceId || sourceId;
    if (familySourceId !== this.#selectedAbilityFamilySourceId) {
      this.#abilityEvolutionViewports.delete(familySourceId);
    }
    this.#selectedAbilityFamilySourceId = familySourceId;
    this.#selectedAbilitySourceId = sourceId;
    for (const entry of this.element?.querySelectorAll?.("[data-ability-entry]") ?? []) {
      entry.classList.toggle("selected", entry.dataset.abilityFamilySourceId === familySourceId);
    }
    return this.#renderAbilityDetails(sourceId);
  }

  static async #onSelectAbilityEvolutionNode(event, target) {
    event.preventDefault();
    const sourceId = String(target.dataset.abilitySourceId ?? "");
    if (!sourceId || !this.#selectedAbilityFamilySourceId) return undefined;
    this.#selectedAbilitySourceId = sourceId;
    return this.#renderAbilityDetails(sourceId, { refreshEvolutionGraph: false });
  }

  static async #onCloseAbilityEvolution(event) {
    event.preventDefault();
    this.#abilityEvolutionViewports.delete(this.#selectedAbilityFamilySourceId);
    this.#abilityEvolutionAnimatedFamilySourceId = "";
    this.#selectedAbilityFamilySourceId = "";
    this.#removeAbilityEvolutionLayer();
  }

  static #onResetAbilityEvolutionView(event) {
    event.preventDefault();
    const familySourceId = this.#selectedAbilityFamilySourceId;
    if (!familySourceId) return undefined;
    const state = this.#createAbilityEvolutionFocusViewport();
    this.#applyAbilityEvolutionViewport(state);
    return undefined;
  }

  async #renderAbilityDetails(sourceId = this.#selectedAbilitySourceId, { refreshEvolutionGraph = true } = {}) {
    const selectionKey = `${this.#selectedAbilityFamilySourceId}\u0000${sourceId}`;
    const abilityEvolutionPanel = refreshEvolutionGraph ? this.#prepareAbilityEvolutionPanel() : null;
    const abilityEvolutionSelection = refreshEvolutionGraph
      ? {
          selectedAbility: abilityEvolutionPanel?.selectedAbility ?? null
        }
      : this.#prepareAbilityEvolutionSelection();
    const selectedAbility = abilityEvolutionSelection.selectedAbility
      ?? this.#abilityEntriesById.get(sourceId)
      ?? null;
    const remaining = calculateRemainingDevelopmentPoints(this.#draft?.development);
    const pointDisplays = this.#preparePointDisplays(remaining);
    const [detailsHTML, evolutionHTML] = await Promise.all([
      foundry.applications.handlebars.renderTemplate(TEMPLATES.advancement.abilityDetails, {
        isGMMode: this.#gmMode,
        researchPointsDisplay: pointDisplays.researches,
        selectedAbility,
        traitPointsDisplay: pointDisplays.traits
      }),
      refreshEvolutionGraph
        ? foundry.applications.handlebars.renderTemplate(TEMPLATES.advancement.abilityEvolutionPanel, {
            abilityEvolutionPanel
          })
        : ""
    ]);
    if (selectionKey !== `${this.#selectedAbilityFamilySourceId}\u0000${this.#selectedAbilitySourceId}`) return;
    const current = this.element?.querySelector?.("[data-ability-details-region]");
    if (current) {
      const ownerDocument = this.element?.ownerDocument ?? globalThis.document;
      const template = ownerDocument.createElement("template");
      template.innerHTML = detailsHTML.trim();
      const replacement = template.content.firstElementChild;
      if (replacement) current.replaceWith(replacement);
    }
    if (refreshEvolutionGraph) this.#replaceAbilityEvolutionLayer(evolutionHTML);
    else this.#syncAbilityEvolutionNodeSelection(sourceId);
  }

  #syncAbilityEvolutionNodeSelection(sourceId = "") {
    const layer = this.#abilityEvolutionLayer;
    if (!layer?.isConnected) return;
    for (const node of layer.querySelectorAll("[data-ability-evolution-node]")) {
      const selected = node.dataset.abilitySourceId === sourceId;
      node.classList.toggle("selected", selected);
      node.setAttribute("aria-pressed", String(selected));
    }
  }

  #replaceAbilityEvolutionLayer(html = "") {
    const ownerDocument = this.element?.ownerDocument ?? globalThis.document;
    const view = ownerDocument?.defaultView ?? globalThis.window;
    const template = ownerDocument.createElement("template");
    template.innerHTML = String(html ?? "").trim();
    const layer = template.content.firstElementChild;
    if (!(layer instanceof view.HTMLElement) || layer.dataset.abilityEvolutionOpen !== "true") {
      this.#abilityEvolutionAnimatedFamilySourceId = "";
      this.#removeAbilityEvolutionLayer();
      return;
    }
    this.#adoptAbilityEvolutionLayer(layer);
  }

  #mountAbilityEvolutionLayer() {
    const nextLayer = this.element?.querySelector?.(".window-content [data-ability-evolution-layer]");
    const ownerDocument = this.element?.ownerDocument ?? globalThis.document;
    const view = ownerDocument?.defaultView ?? globalThis.window;
    if (!(nextLayer instanceof view.HTMLElement) || nextLayer.dataset.abilityEvolutionOpen !== "true") {
      nextLayer?.remove?.();
      this.#abilityEvolutionAnimatedFamilySourceId = "";
      this.#removeAbilityEvolutionLayer();
      return;
    }
    this.#adoptAbilityEvolutionLayer(nextLayer);
  }

  #adoptAbilityEvolutionLayer(nextLayer) {
    const currentLayer = this.#abilityEvolutionLayer;
    if (currentLayer?.isConnected
      && this.#canReconcileAbilityEvolutionLayers(currentLayer, nextLayer)) {
      this.#reconcileAbilityEvolutionLayer(currentLayer, nextLayer);
      nextLayer.remove();
      return;
    }

    this.#removeAbilityEvolutionLayer();
    const nextFamilySourceId = String(nextLayer.dataset.abilityFamilySourceId ?? "");
    if (nextFamilySourceId !== this.#abilityEvolutionAnimatedFamilySourceId) {
      nextLayer.classList.add("opening");
      this.#abilityEvolutionAnimatedFamilySourceId = nextFamilySourceId;
    }
    this.element.append(nextLayer);
    this.#activateAbilityEvolutionLayer(nextLayer);
  }

  #canReconcileAbilityEvolutionLayers(currentLayer, nextLayer) {
    if (currentLayer.dataset.abilityFamilySourceId !== nextLayer.dataset.abilityFamilySourceId) return false;
    return getAbilityEvolutionGraphFingerprint(currentLayer) === getAbilityEvolutionGraphFingerprint(nextLayer);
  }

  #reconcileAbilityEvolutionLayer(currentLayer, nextLayer) {
    const currentNodes = new Map(Array.from(currentLayer.querySelectorAll("[data-ability-evolution-node]"))
      .map(node => [node.dataset.abilitySourceId, node]));
    for (const nextNode of nextLayer.querySelectorAll("[data-ability-evolution-node]")) {
      const currentNode = currentNodes.get(nextNode.dataset.abilitySourceId);
      if (!currentNode) continue;
      currentNode.className = nextNode.className;
      currentNode.setAttribute("aria-pressed", nextNode.getAttribute("aria-pressed") ?? "false");
      currentNode.dataset.currentOwned = nextNode.dataset.currentOwned ?? "false";
      if (nextNode.hasAttribute("data-ability-description-source-id")) {
        currentNode.dataset.abilityDescriptionSourceId = nextNode.dataset.abilityDescriptionSourceId;
        currentNode.dataset.abilityDescriptionMode = nextNode.dataset.abilityDescriptionMode ?? "full";
      } else {
        delete currentNode.dataset.abilityDescriptionSourceId;
        delete currentNode.dataset.abilityDescriptionMode;
      }
      const currentStatus = currentNode.querySelector("small");
      const nextStatus = nextNode.querySelector("small");
      if (currentStatus && nextStatus) currentStatus.textContent = nextStatus.textContent;
    }

    const currentLinks = new Map(Array.from(currentLayer.querySelectorAll("[data-ability-evolution-link-id]"))
      .map(link => [link.dataset.abilityEvolutionLinkId, link]));
    for (const nextLink of nextLayer.querySelectorAll("[data-ability-evolution-link-id]")) {
      const currentLink = currentLinks.get(nextLink.dataset.abilityEvolutionLinkId);
      if (currentLink) currentLink.setAttribute("class", nextLink.getAttribute("class") ?? "");
    }

    this.#abilityEvolutionGraph = collectRenderedAbilityEvolutionGraph(currentLayer);
  }

  #activateAbilityEvolutionLayer(layer) {
    this.#abilityEvolutionLayer = layer;
    layer.dataset.abilityEvolutionOwner = this.id;
    const view = layer.ownerDocument?.defaultView ?? globalThis.window;
    this.#abilityEvolutionAbortController = new view.AbortController();
    const { signal } = this.#abilityEvolutionAbortController;
    const viewport = layer.querySelector("[data-ability-evolution-viewport]");
    const familySourceId = String(layer.dataset.abilityFamilySourceId ?? "");
    if (!(viewport instanceof view.HTMLElement)) return;
    this.#abilityEvolutionGraph = collectRenderedAbilityEvolutionGraph(layer);
    this.#abilityEvolutionViewportMetrics = readGraphViewportMetrics(viewport);
    const initialState = this.#abilityEvolutionViewports.get(familySourceId)
      ?? this.#createAbilityEvolutionFocusViewport();
    this.#applyAbilityEvolutionViewport(initialState);
    layer.querySelector(".fallout-maw-advancement-evolution-panel")?.addEventListener("animationend", () => {
      layer.classList.remove("opening");
    }, { once: true, signal });
    view.setTimeout(() => layer.classList.remove("opening"), 240);
    if (typeof view.ResizeObserver === "function") {
      const resizeObserver = new view.ResizeObserver(() => {
        this.#abilityEvolutionViewportMetrics = readGraphViewportMetrics(viewport);
        const state = this.#abilityEvolutionViewports.get(familySourceId) ?? initialState;
        this.#applyAbilityEvolutionViewport(state);
      });
      resizeObserver.observe(viewport);
      signal.addEventListener("abort", () => resizeObserver.disconnect(), { once: true });
    }

    let panState = null;
    viewport.addEventListener("wheel", event => {
      event.preventDefault();
      const state = this.#abilityEvolutionViewports.get(familySourceId) ?? initialState;
      const metrics = readGraphViewportMetrics(viewport);
      this.#abilityEvolutionViewportMetrics = metrics;
      const localX = (event.clientX - metrics.left) / metrics.scaleX;
      const localY = (event.clientY - metrics.top) / metrics.scaleY;
      const worldX = (localX - state.x) / state.zoom;
      const worldY = (localY - state.y) / state.zoom;
      const zoom = clampAbilityEvolutionZoom(state.zoom * Math.exp(-event.deltaY * 0.0015));
      const nextState = {
        x: localX - (worldX * zoom),
        y: localY - (worldY * zoom),
        zoom
      };
      this.#applyAbilityEvolutionViewport(nextState);
      if (panState) {
        const applied = this.#abilityEvolutionViewports.get(familySourceId) ?? nextState;
        panState.startX = event.clientX;
        panState.startY = event.clientY;
        panState.originX = applied.x;
        panState.originY = applied.y;
        panState.screenScaleX = metrics.scaleX;
        panState.screenScaleY = metrics.scaleY;
      }
    }, { passive: false, signal });

    viewport.addEventListener("pointerdown", event => {
      if (event.button !== 2) return;
      event.preventDefault();
      this.#clearAbilityDescriptionTooltip();
      const state = this.#abilityEvolutionViewports.get(familySourceId) ?? initialState;
      const metrics = readGraphViewportMetrics(viewport);
      this.#abilityEvolutionViewportMetrics = metrics;
      panState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: state.x,
        originY: state.y,
        screenScaleX: metrics.scaleX,
        screenScaleY: metrics.scaleY
      };
      viewport.classList.add("panning");
      viewport.setPointerCapture?.(event.pointerId);
    }, { signal });
    viewport.addEventListener("contextmenu", event => event.preventDefault(), { signal });

    viewport.addEventListener("pointermove", event => {
      if (!panState || panState.pointerId !== event.pointerId) return;
      event.preventDefault();
      const samples = event.getCoalescedEvents?.();
      const pointer = samples?.length ? samples[samples.length - 1] : event;
      const current = this.#abilityEvolutionViewports.get(familySourceId) ?? initialState;
      const nextState = {
        x: panState.originX + ((pointer.clientX - panState.startX) / panState.screenScaleX),
        y: panState.originY + ((pointer.clientY - panState.startY) / panState.screenScaleY),
        zoom: current.zoom
      };
      this.#applyAbilityEvolutionViewport(nextState);
    }, { signal });

    const stopPan = event => {
      if (!panState || panState.pointerId !== event.pointerId) return;
      if (event.type === "pointerup") {
        const current = this.#abilityEvolutionViewports.get(familySourceId) ?? initialState;
        this.#applyAbilityEvolutionViewport({
          x: panState.originX + ((event.clientX - panState.startX) / panState.screenScaleX),
          y: panState.originY + ((event.clientY - panState.startY) / panState.screenScaleY),
          zoom: current.zoom
        });
      }
      viewport.releasePointerCapture?.(event.pointerId);
      viewport.classList.remove("panning");
      panState = null;
    };
    viewport.addEventListener("pointerup", stopPan, { signal });
    viewport.addEventListener("pointercancel", stopPan, { signal });
  }

  #applyAbilityEvolutionViewport(state = {}) {
    const layer = this.#abilityEvolutionLayer;
    const stage = layer?.querySelector?.("[data-ability-evolution-stage]");
    const view = layer?.ownerDocument?.defaultView ?? globalThis.window;
    const viewport = layer?.querySelector?.("[data-ability-evolution-viewport]");
    if (!(stage instanceof view.HTMLElement) || !(viewport instanceof view.HTMLElement)) return;
    const metrics = this.#abilityEvolutionViewportMetrics ?? readGraphViewportMetrics(viewport);
    this.#abilityEvolutionViewportMetrics = metrics;
    const constrained = clampGraphViewportToVisibleNode({
      x: Number(state.x) || 0,
      y: Number(state.y) || 0,
      zoom: clampAbilityEvolutionZoom(state.zoom)
    }, {
      height: metrics.height,
      nodeHeight: ABILITY_EVOLUTION_NODE_HEIGHT,
      nodeWidth: ABILITY_EVOLUTION_NODE_WIDTH,
      nodes: this.#abilityEvolutionGraph.nodes,
      width: metrics.width
    });
    const x = snapToDevicePixel(constrained.x, view);
    const y = snapToDevicePixel(constrained.y, view);
    const zoom = constrained.zoom;
    const familySourceId = String(layer.dataset.abilityFamilySourceId ?? "");
    if (familySourceId) this.#abilityEvolutionViewports.set(familySourceId, { x, y, zoom });
    stage.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    viewport.style.backgroundPosition = [
      `${x}px ${y}px`,
      `${x}px ${y}px`,
      `${x}px ${y}px`
    ].join(", ");
    viewport.style.backgroundSize = [
      `${ABILITY_EVOLUTION_GRID_SIZE * zoom}px ${ABILITY_EVOLUTION_GRID_SIZE * zoom}px`,
      `${ABILITY_EVOLUTION_MAJOR_GRID_SIZE * zoom}px ${ABILITY_EVOLUTION_MAJOR_GRID_SIZE * zoom}px`,
      `${ABILITY_EVOLUTION_MAJOR_GRID_SIZE * zoom}px ${ABILITY_EVOLUTION_MAJOR_GRID_SIZE * zoom}px`
    ].join(", ");
    const label = layer.querySelector("[data-ability-evolution-zoom]");
    if (label) label.textContent = `${Math.round(zoom * 100)}%`;
  }

  #createAbilityEvolutionFocusViewport() {
    const viewport = this.#abilityEvolutionLayer?.querySelector?.("[data-ability-evolution-viewport]");
    const metrics = this.#abilityEvolutionViewportMetrics ?? readGraphViewportMetrics(viewport);
    this.#abilityEvolutionViewportMetrics = metrics;
    return createGraphSegmentViewport({
      focusNodeIds: this.#abilityEvolutionGraph.nodes
        .filter(node => node.currentOwned)
        .map(node => node.id),
      height: metrics.height,
      links: this.#abilityEvolutionGraph.links,
      maxZoom: 0.9,
      minZoom: ABILITY_EVOLUTION_ZOOM_MIN,
      nodeHeight: ABILITY_EVOLUTION_NODE_HEIGHT,
      nodeWidth: ABILITY_EVOLUTION_NODE_WIDTH,
      nodes: this.#abilityEvolutionGraph.nodes,
      padding: 28,
      width: metrics.width
    });
  }

  #removeAbilityEvolutionLayer() {
    const layer = this.#abilityEvolutionLayer;
    if (layer?.contains(this.#abilityTooltipAnchor)) this.#clearAbilityDescriptionTooltip();
    this.#abilityEvolutionAbortController?.abort();
    this.#abilityEvolutionAbortController = null;
    layer?.remove();
    this.#abilityEvolutionGraph = { links: [], nodes: [] };
    this.#abilityEvolutionLayer = null;
    this.#abilityEvolutionViewportMetrics = null;
  }

  static async #onSpendAbilityResearch(event, target) {
    event.preventDefault();
    await this.#ensureDraft();
    this.#syncDraftFromForm();

    const sourceId = target.closest("[data-ability-source-id]")?.dataset.abilitySourceId ?? "";
    const entry = this.#abilityById.get(sourceId) ?? findCatalogAbility(sourceId);
    if (!entry || actorHasAbility(this.actor, sourceId)) return this.forceRender();
    if (this.#abilityEntriesById.get(sourceId)?.evolutionAvailable === false) return this.forceRender();
    if (hasUnsafeAbilityEvolutionAcquisitionChanges(this.actor, entry.ability, entry.incomingSourceIds)) return this.forceRender();
    if (!abilityAcquisitionRequirementsMet(this.actor, entry.ability, this.#getAbilityRequirementContext())) return this.forceRender();
    if (entry.ability.system?.acquisition?.onlyManual) return this.forceRender();
    const research = this.#getAbilityResearch(sourceId);
    if (!research) return this.forceRender();

    const targetValue = Math.max(1, Number(research.target) || toInteger(entry.ability.system?.cost) || 1);
    const currentProgress = Math.max(0, Number(research.progress) || 0);
    if (currentProgress >= targetValue) {
      await completeAbilityResearch(this.actor, research.id, {
        progressSource: "advancementResearchInvestment"
      });
      this.#syncDraftFromActor();
      return this.forceRender();
    }

    const available = Math.max(0, toInteger(this.#draft.development.points.researches));
    if (available <= 0) return this.forceRender();

    const investment = Math.min(available, Math.max(0, targetValue - currentProgress));
    if (investment <= 0) return this.forceRender();

    this.#draft.development.points.researches = available - investment;
    await this.#applyDraftToActor();
    this.#researchPointSessionSpent += investment;

    const nextProgress = Math.min(targetValue, currentProgress + investment);
    await this.actor.updateResearch(research.id, {
      progress: nextProgress,
      target: targetValue,
      freeSpent: Math.max(0, Number(research.freeSpent) || 0) + investment
    }, {
      progressSource: "advancementResearchInvestment",
      gain: investment
    });

    if (nextProgress >= targetValue) {
      await completeAbilityResearch(this.actor, research.id, {
        progressSource: "advancementResearchInvestment"
      });
    }
    this.#syncDraftFromActor();
    return this.forceRender();
  }

  static async #onStartAbilityResearch(event, target) {
    event.preventDefault();
    await this.#ensureDraft();
    this.#syncDraftFromForm();

    const sourceId = target.closest("[data-ability-source-id]")?.dataset.abilitySourceId ?? "";
    const entry = this.#abilityById.get(sourceId) ?? findCatalogAbility(sourceId);
    if (!entry || actorHasAbility(this.actor, sourceId)) return this.forceRender();
    if (this.#abilityEntriesById.get(sourceId)?.evolutionAvailable === false) return this.forceRender();
    if (hasUnsafeAbilityEvolutionAcquisitionChanges(this.actor, entry.ability, entry.incomingSourceIds)) return this.forceRender();
    if (!abilityAcquisitionRequirementsMet(this.actor, entry.ability, this.#getAbilityRequirementContext())) return this.forceRender();
    if (this.#getAbilityResearch(sourceId)) return this.forceRender();

    await this.actor.createResearch(this.#createAbilityResearchData(entry), {
      progressSource: "advancementManualResearch"
    });
    return this.forceRender();
  }

  static async #onPurchaseTraitAbility(event, target) {
    event.preventDefault();
    await this.#ensureDraft();
    this.#syncDraftFromForm();

    const sourceId = target.closest("[data-ability-source-id]")?.dataset.abilitySourceId ?? "";
    const entry = this.#abilityById.get(sourceId) ?? findCatalogAbility(sourceId);
    if (!entry || entry.category?.id !== LOCKED_FEATURES_CATEGORY_ID || actorHasAbility(this.actor, sourceId)) return this.forceRender();
    if (this.#abilityEntriesById.get(sourceId)?.evolutionAvailable === false) return this.forceRender();
    if (hasUnsafeAbilityEvolutionAcquisitionChanges(this.actor, entry.ability, entry.incomingSourceIds)) return this.forceRender();
    if (!abilityAcquisitionRequirementsMet(this.actor, entry.ability, this.#getAbilityRequirementContext())) return this.forceRender();

    const available = Math.max(0, toInteger(this.#draft.development.points.traits));
    if (available < 1) return this.forceRender();

    this.#draft.development.traits ??= {};
    const hadTraitState = Object.hasOwn(this.#draft.development.traits, sourceId);
    const previousTraitState = this.#draft.development.traits[sourceId];
    this.#draft.development.traits[sourceId] = true;
    this.#draft.development.points.traits = available - 1;
    await this.#applyDraftToActor();

    const granted = await grantCatalogAbility(this.actor, sourceId);
    if (!granted) {
      if (hadTraitState) this.#draft.development.traits[sourceId] = previousTraitState;
      else delete this.#draft.development.traits[sourceId];
      this.#draft.development.points.traits = available;
      await this.#applyDraftToActor();
      this.#syncDraftFromActor();
      return this.forceRender();
    }

    this.#syncDraftFromActor();
    return this.forceRender();
  }

  static async #onGrantAbility(event, target) {
    event.preventDefault();
    if (!game.user?.isGM || !this.#gmMode) return this.forceRender();

    const sourceId = target.closest("[data-ability-source-id]")?.dataset.abilitySourceId ?? "";
    const entry = this.#abilityById.get(sourceId) ?? findCatalogAbility(sourceId);
    if (!entry || actorHasAbility(this.actor, sourceId)) return this.forceRender();
    if (this.#abilityEntriesById.get(sourceId)?.evolutionAvailable === false) return this.forceRender();
    if (hasUnsafeAbilityEvolutionAcquisitionChanges(this.actor, entry.ability, entry.incomingSourceIds)) return this.forceRender();

    const granted = await grantCatalogAbility(this.actor, sourceId);
    if (granted) {
      const research = this.#getAbilityResearch(sourceId);
      if (research) {
        await this.actor.deleteResearch(research.id, {
          progressSource: "advancementAbilityGrant",
          reason: "abilityGranted"
        });
      }
      if (!abilityHasEvolutions(entry.rootAbility ?? entry.ability)) {
        this.#selectedAbilitySourceId = "";
        this.#selectedAbilityFamilySourceId = "";
      }
      this.#syncDraftFromActor();
    }
    return this.forceRender();
  }

  #getSkillAdvancementMultiplierChanges(skillSettings = getSkillSettings(), {
    characteristicSettings = getCharacteristicSettings(),
    skillAdvancementSettings = getSkillAdvancementSettings(characteristicSettings, skillSettings),
    development = this.#draft?.development ?? this.actor.system?.development ?? {},
    characteristics = this.#getCleanCharacteristics(characteristicSettings, development)
  } = {}) {
    const usesCurrentDraft = development === this.#draft?.development;
    if (usesCurrentDraft && this.#skillAdvancementMultiplierChanges) {
      return this.#skillAdvancementMultiplierChanges;
    }

    this.#skillAdvancementMultiplierSource ??= getSkillAdvancementMultiplierChanges(this.actor, skillSettings);
    const skillBases = evaluateSkillFormulas(skillSettings, characteristicSettings, characteristics);
    const pureValueProjection = this.#getAdvancementPureValues(characteristicSettings, skillSettings);
    for (const [skillKey, bonus] of Object.entries(pureValueProjection.skillBonusDeltas ?? {})) {
      skillBases[skillKey] = toInteger(skillBases[skillKey]) + toInteger(bonus);
    }
    const resolved = resolveSkillAdvancementMultiplierChanges(
      skillSettings,
      characteristics,
      skillAdvancementSettings,
      development,
      skillBases,
      this.#skillAdvancementMultiplierSource
    );
    if (usesCurrentDraft) this.#skillAdvancementMultiplierChanges = resolved;
    return resolved;
  }

  #invalidateSkillAdvancementMultiplierChanges() {
    this.#skillAdvancementMultiplierChanges = null;
  }

  #getSkillDevelopmentLimit() {
    const characteristicSettings = getCharacteristicSettings();
    const skillSettings = getSkillSettings();
    return Math.max(0, toInteger(getSkillAdvancementSettings(characteristicSettings, skillSettings).developmentLimit));
  }

  #getPreviewCharacteristicValue(key) {
    const sourceValue = toInteger(
      this.actor.system?._source?.characteristics?.[key]
      ?? this.actor.system?.characteristics?.[key]
    );
    const liveValue = toInteger(this.actor.system?.characteristics?.[key]);
    const liveDevelopment = toInteger(this.actor.system?.development?.characteristics?.[key]);
    const draftSource = toInteger(this.#draft?.characteristics?.[key]);
    const draftDevelopment = toInteger(this.#draft?.development?.characteristics?.[key]);
    return liveValue + (draftSource - sourceValue) + (draftDevelopment - liveDevelopment);
  }

  #getPreviewSkillValue(key, {
    characteristicSettings = getCharacteristicSettings(),
    skillSettings = getSkillSettings(),
    skillAdvancementSettings = getSkillAdvancementSettings(characteristicSettings, skillSettings),
    characteristics = this.#getCleanCharacteristics(characteristicSettings),
    multiplierChanges = null,
    pureValue = null
  } = {}) {
    const resolvedMultiplierChanges = multiplierChanges ?? this.#getSkillAdvancementMultiplierChanges(skillSettings, {
      characteristicSettings,
      skillAdvancementSettings,
      characteristics
    });
    const resolvedPureValue = pureValue === null
      ? this.#getPureSkillValue(key, {
        characteristicSettings,
        skillSettings,
        skillAdvancementSettings,
        characteristics,
        multiplierChanges: resolvedMultiplierChanges
      })
      : toInteger(pureValue);
    const externalFlatValue = this.#getLiveSkillFlatValueOffset(key);
    const limit = Math.max(0, toInteger(skillAdvancementSettings.developmentLimit));
    const limitedPureValue = Math.min(limit, Math.max(0, resolvedPureValue));
    const flatValue = skillAdvancementSettings?.developmentLimitPureOnly !== false
      ? Math.max(0, limitedPureValue + externalFlatValue)
      : Math.max(0, Math.min(limit, resolvedPureValue + externalFlatValue));
    return applySkillBonusPercent(
      flatValue,
      this.actor.system?.skills?.[key]?.bonusPercent,
      {
        min: 0,
        max: limit,
        capResult: skillAdvancementSettings?.developmentLimitPureOnly === false
      }
    );
  }

  #getLiveSkillFlatValueOffset(key) {
    const liveSkill = this.actor.system?.skills?.[key] ?? {};
    const pureBonus = toInteger(this.#getAdvancementPureValues().skillBonusDeltas?.[key]);
    const livePureValue = Number.isFinite(Number(liveSkill.pureValue))
      ? Math.max(0, toInteger(liveSkill.pureValue))
      : Math.max(
        0,
        toInteger(liveSkill.base) + toInteger(liveSkill.developmentBonus) + pureBonus
      );
    const rawFlatValue = toInteger(liveSkill.base)
      + toInteger(liveSkill.developmentBonus)
      + toInteger(liveSkill.bonus)
      + toInteger(liveSkill.abilityBonus);
    return rawFlatValue - livePureValue;
  }

  #getPreviewSkillPureValue(key) {
    const characteristicSettings = getCharacteristicSettings();
    const skillSettings = getSkillSettings();
    const advancementSettings = getSkillAdvancementSettings(characteristicSettings, skillSettings);
    const characteristics = this.#getCleanCharacteristics(characteristicSettings);
    const multiplierChanges = this.#getSkillAdvancementMultiplierChanges(skillSettings);
    return this.#getPureSkillValue(key, {
      characteristicSettings,
      skillSettings,
      skillAdvancementSettings: advancementSettings,
      characteristics,
      multiplierChanges
    });
  }

  #prepareProficiencyEntry(proficiency, remaining = calculateRemainingDevelopmentPoints(this.#draft?.development)) {
    const key = String(proficiency?.key ?? "");
    const max = this.#getProficiencyMaximum(proficiency);
    const floorValue = Math.min(max, Math.max(0, toInteger(this.#floor?.proficiencies?.[key])));
    const value = Math.min(max, Math.max(0, toInteger(this.#draft?.proficiencies?.[key])));
    const baseValue = value >= floorValue ? floorValue : value;
    const baseEntry = prepareDisplayIndicatorEntry({
      ...proficiency,
      color: "#b08a4a",
      data: {
        min: 0,
        value: baseValue,
        max
      }
    });
    const floorPercent = max > 0 ? Math.max(0, Math.min(100, (floorValue / max) * 100)) : 0;
    const valuePercent = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
    const phantomWidth = Math.max(0, valuePercent - floorPercent);
    const sliderMin = 0;
    const sliderMax = max;
    const canMove = this.#gmMode
      ? max > 0
      : value > floorValue || (Math.max(0, toInteger(remaining.proficiencies)) > 0 && floorValue < max);

    return {
      ...baseEntry,
      value,
      floorValue,
      max,
      sliderMin,
      sliderMax,
      sliderDisabled: !canMove,
      hasPhantom: phantomWidth > 0,
      phantomStyle: `left: ${floorPercent.toFixed(2)}%; width: ${phantomWidth.toFixed(2)}%;`
    };
  }

  #setProficiencyValue(key, rawValue) {
    if (!this.#draft) return false;

    const proficiency = getProficiencySettings().find(entry => entry.key === key);
    if (!proficiency) return false;

    const max = this.#getProficiencyMaximum(proficiency);
    const currentValue = Math.min(max, Math.max(0, toInteger(this.#draft.proficiencies?.[key])));
    const floorValue = this.#gmMode ? 0 : Math.min(max, Math.max(0, toInteger(this.#floor?.proficiencies?.[key])));
    const requestedValue = Math.min(max, Math.max(floorValue, toInteger(rawValue)));
    const available = Math.max(0, toInteger(this.#draft.development?.points?.proficiencies));
    const nextValue = this.#gmMode
      ? requestedValue
      : requestedValue > currentValue
        ? currentValue + Math.min(requestedValue - currentValue, available)
        : requestedValue;
    const delta = nextValue - currentValue;

    this.#draft.proficiencies ??= {};
    this.#draft.development.proficiencies ??= {};
    this.#draft.proficiencies[key] = nextValue;
    if (!delta) return false;

    const floorPoints = this.#gmMode ? 0 : toInteger(this.#floor?.development?.proficiencies?.[key]);
    this.#draft.development.proficiencies[key] = Math.max(
      floorPoints,
      toInteger(this.#draft.development.proficiencies?.[key]) + delta
    );

    if (!this.#gmMode) {
      this.#draft.development.points.proficiencies = Math.max(0, available - delta);
    }

    return true;
  }

  #refreshProficiencyPreview(key) {
    const proficiency = getProficiencySettings().find(entry => entry.key === key);
    if (!proficiency) return;

    const remaining = calculateRemainingDevelopmentPoints(this.#draft?.development);
    const entry = this.#prepareProficiencyEntry(proficiency, remaining);
    const row = this.element?.querySelector?.(`[data-advancement-proficiency-row="${CSS.escape(key)}"]`);
    if (!row) return;

    const valueElement = row.querySelector("[data-proficiency-value]");
    if (valueElement) valueElement.textContent = `${entry.value} / ${entry.max}`;

    const meter = row.querySelector("[data-proficiency-meter]");
    if (meter instanceof HTMLElement) {
      meter.setAttribute("style", entry.meterStyle);
      meter.setAttribute("aria-valuenow", String(entry.value));
      meter.setAttribute("aria-valuemax", String(entry.max));
    }

    const fill = row.querySelector("[data-proficiency-fill]");
    if (fill instanceof HTMLElement) fill.setAttribute("style", entry.fillStyle);

    const phantom = row.querySelector("[data-proficiency-phantom]");
    if (phantom instanceof HTMLElement) {
      phantom.hidden = !entry.hasPhantom;
      phantom.setAttribute("style", entry.phantomStyle);
    }

    const slider = row.querySelector("[data-proficiency-slider]");
    if (slider instanceof HTMLInputElement) {
      slider.min = String(entry.sliderMin);
      slider.max = String(entry.sliderMax);
      slider.value = String(entry.value);
      slider.disabled = entry.sliderDisabled;
    }

    this.#refreshProficiencySliderLimits(remaining);
    this.#refreshPointDisplays(remaining);
  }

  #refreshProficiencySliderLimits(remaining = calculateRemainingDevelopmentPoints(this.#draft?.development)) {
    for (const proficiency of getProficiencySettings()) {
      const entry = this.#prepareProficiencyEntry(proficiency, remaining);
      const slider = this.element?.querySelector?.(
        `[data-proficiency-slider][data-proficiency-key="${CSS.escape(proficiency.key)}"]`
      );
      if (!(slider instanceof HTMLInputElement)) continue;
      slider.min = String(entry.sliderMin);
      slider.max = String(entry.sliderMax);
      slider.disabled = entry.sliderDisabled;
    }
  }

  #refreshPointDisplays(remaining = calculateRemainingDevelopmentPoints(this.#draft?.development)) {
    const pointDisplays = this.#preparePointDisplays(remaining);
    for (const [pointType, display] of Object.entries(pointDisplays)) {
      const element = this.element?.querySelector?.(
        `[data-advancement-point-display="${CSS.escape(pointType)}"]`
      );
      if (element) element.textContent = display;
    }
  }

  #getActorProficiencyValues(proficiencySettings = getProficiencySettings()) {
    return this.#getProficiencyValuesFromResourceMap(
      this.actor.system?._source?.proficiencies ?? this.actor.system?.proficiencies,
      proficiencySettings
    );
  }

  #getCommittedProficiencyValues(committed = {}, proficiencySettings = getProficiencySettings()) {
    if (committed?.proficiencies && typeof committed.proficiencies === "object") {
      return Object.fromEntries(
        proficiencySettings.map(proficiency => {
          const max = this.#getProficiencyMaximum(proficiency);
          const value = toInteger(committed.proficiencies?.[proficiency.key]);
          return [proficiency.key, Math.min(max, Math.max(0, value))];
        })
      );
    }
    return this.#getActorProficiencyValues(proficiencySettings);
  }

  #getProficiencyValuesFromResourceMap(proficiencies = {}, proficiencySettings = getProficiencySettings()) {
    return Object.fromEntries(
      proficiencySettings.map(proficiency => {
        const max = this.#getProficiencyMaximum(proficiency);
        const value = toInteger(proficiencies?.[proficiency.key]?.value);
        return [proficiency.key, Math.min(max, Math.max(0, value))];
      })
    );
  }

  #getProficiencyMaximum(proficiency) {
    const key = String(proficiency?.key ?? "");
    const live = this.actor.system?.proficiencies?.[key] ?? {};
    const source = this.actor.system?._source?.proficiencies?.[key] ?? {};
    const bonus = toInteger(live.bonus ?? source.bonus);
    const settingMax = Math.max(0, toInteger(proficiency?.max));
    return Math.max(0, toInteger(live.max ?? source.max ?? settingMax + bonus));
  }

  #getProficiencyActorUpdateData() {
    return Object.fromEntries(
      Object.entries(this.#draft?.proficiencies ?? {}).map(([key, value]) => [
        `system.proficiencies.${key}.value`,
        Math.max(0, toInteger(value))
      ])
    );
  }

  #preparePointDisplays(remaining = {}) {
    return {
      characteristics: this.#formatSessionPointDisplay(remaining.characteristics, this.#getCharacteristicSessionSpent()),
      signatureSkills: this.#formatSessionPointDisplay(remaining.signatureSkills, this.#getSignatureSkillSessionSpent()),
      skills: this.#formatSessionPointDisplay(remaining.skills, this.#getSkillSessionSpent()),
      traits: this.#formatSessionPointDisplay(remaining.traits, this.#getTraitSessionSpent()),
      proficiencies: this.#formatSessionPointDisplay(remaining.proficiencies, this.#getProficiencySessionSpent()),
      researches: this.#formatSessionPointDisplay(remaining.researches, this.#researchPointSessionSpent)
    };
  }

  #formatSessionPointDisplay(remainingValue = 0, sessionSpent = 0) {
    const remaining = Math.max(0, toInteger(remainingValue));
    const total = remaining + Math.max(0, toInteger(sessionSpent));
    return `${remaining} / ${Math.max(remaining, total)}`;
  }

  #getCharacteristicSessionSpent() {
    return Object.entries(this.#draft?.development?.characteristics ?? {}).reduce((total, [key, value]) => {
      const floorValue = toInteger(this.#floor?.development?.characteristics?.[key]);
      return total + Math.max(0, toInteger(value) - floorValue);
    }, 0);
  }

  #getSkillSessionSpent() {
    return Math.max(0, this.#skillPointSessionSpent);
  }

  #recordSkillUpgradeCost(key, cost) {
    const normalizedCost = Math.max(0, toInteger(cost));
    const ledger = this.#skillUpgradeCostLedger.get(key) ?? [];
    ledger.push(normalizedCost);
    this.#skillUpgradeCostLedger.set(key, ledger);
    this.#skillPointSessionSpent += normalizedCost;
  }

  #takeSkillUpgradeCost(key) {
    const ledger = this.#skillUpgradeCostLedger.get(key);
    if (!ledger?.length) return null;
    const cost = Math.max(0, toInteger(ledger.pop()));
    if (!ledger.length) this.#skillUpgradeCostLedger.delete(key);
    this.#skillPointSessionSpent = Math.max(0, this.#skillPointSessionSpent - cost);
    return cost;
  }

  #resetSkillUpgradeCostLedger() {
    this.#skillUpgradeCostLedger.clear();
    this.#skillPointSessionSpent = 0;
  }

  #rebuildSkillUpgradeCostLedger() {
    this.#resetSkillUpgradeCostLedger();
    const development = foundry.utils.deepClone(this.#floor?.development ?? this.#draft?.development ?? {});
    for (const skill of getSkillSettings()) {
      const key = String(skill?.key ?? "");
      const floorPoints = Math.max(0, toInteger(development.skills?.[key]?.points));
      const currentPoints = Math.max(floorPoints, toInteger(this.#draft?.development?.skills?.[key]?.points));
      for (let points = floorPoints; points < currentPoints; points += 1) {
        development.skills[key] = { ...(development.skills?.[key] ?? {}), points };
        this.#recordSkillUpgradeCost(key, this.#getSkillUpgradeCost(key, development));
        development.skills[key].points = points + 1;
      }
    }
  }

  #getSkillUpgradeCost(key, development = this.#draft?.development) {
    return getSkillDevelopmentCostForValue(this.#getPureSkillValue(key, { development }), getSkillDevelopmentCostSettings());
  }

  #getSkillRefundCost(key, previousPoints) {
    const development = foundry.utils.deepClone(this.#draft.development);
    development.skills[key] = {
      ...(development.skills?.[key] ?? {}),
      points: previousPoints
    };
    return this.#getSkillUpgradeCost(key, development);
  }

  #getCleanCharacteristics(characteristicSettings = getCharacteristicSettings(), development = this.#draft?.development) {
    const pureValueProjection = this.#getAdvancementPureValues(characteristicSettings);
    return Object.fromEntries(
      characteristicSettings.map(characteristic => [
        characteristic.key,
        applyAdvancementPureCharacteristic(
          pureValueProjection,
          characteristic.key,
          this.#draft?.characteristics?.[characteristic.key]
        )
          + toInteger(development?.characteristics?.[characteristic.key])
      ])
    );
  }

  #getAdvancementPureValues(
    characteristicSettings = getCharacteristicSettings(),
    skillSettings = getSkillSettings()
  ) {
    this.#advancementPureValues ??= collectAdvancementPureValueProjection(
      this.actor,
      characteristicSettings,
      skillSettings
    );
    return this.#advancementPureValues;
  }

  #getAbilityRequirementContext({
    characteristicSettings = getCharacteristicSettings(),
    skillSettings = getSkillSettings(),
    skillAdvancementSettings = getSkillAdvancementSettings(characteristicSettings, skillSettings),
    development = this.#draft?.development ?? this.actor.system?.development ?? {},
    characteristics = this.#getCleanCharacteristics(characteristicSettings, development),
    multiplierChanges = null
  } = {}) {
    const resolvedMultiplierChanges = multiplierChanges ?? this.#getSkillAdvancementMultiplierChanges(skillSettings, {
      characteristicSettings,
      skillAdvancementSettings,
      development,
      characteristics
    });
    const skills = Object.fromEntries(
      skillSettings.map(skill => [
        skill.key,
        this.#getPureSkillValue(skill.key, {
          characteristicSettings,
          skillSettings,
          skillAdvancementSettings,
          development,
          characteristics,
          multiplierChanges: resolvedMultiplierChanges
        })
      ])
    );
    return { ...this.#abilityRequirementContext, characteristics, skills };
  }

  #getPureSkillValue(key, {
    characteristicSettings = getCharacteristicSettings(),
    skillSettings = getSkillSettings(),
    skillAdvancementSettings = getSkillAdvancementSettings(characteristicSettings, skillSettings),
    development = this.#draft?.development ?? this.actor.system?.development ?? {},
    characteristics = this.#getCleanCharacteristics(characteristicSettings, development),
    multiplierChanges = null
  } = {}) {
    const resolvedMultiplierChanges = multiplierChanges ?? this.#getSkillAdvancementMultiplierChanges(skillSettings, {
      characteristicSettings,
      skillAdvancementSettings,
      development,
      characteristics
    });
    return calculatePureSkillDevelopmentValue(
      key,
      skillSettings,
      characteristicSettings,
      characteristics,
      skillAdvancementSettings,
      development,
      resolvedMultiplierChanges
    );
  }

  #getSignatureSkillSessionSpent() {
    return Object.entries(this.#draft?.development?.skills ?? {}).reduce((total, [key, value]) => {
      const floorValue = Boolean(this.#floor?.development?.skills?.[key]?.signature);
      return total + (value?.signature && !floorValue ? 1 : 0);
    }, 0);
  }

  #getTraitSessionSpent() {
    const floorTraits = this.#floor?.development?.traits ?? {};
    return Object.entries(this.#draft?.development?.traits ?? {})
      .reduce((total, [key, selected]) => total + (selected && !floorTraits[key] ? 1 : 0), 0);
  }

  #getProficiencySessionSpent() {
    return Object.entries(this.#draft?.proficiencies ?? {}).reduce((total, [key, value]) => {
      const floorValue = toInteger(this.#floor?.proficiencies?.[key]);
      return total + Math.max(0, toInteger(value) - floorValue);
    }, 0);
  }

  #prepareAbilityCategories(remaining = {}, skillSettings = [], requirementContext = {}, {
    characteristicSettings = [],
    races = []
  } = {}) {
    const catalog = getAbilityCatalog();
    const currentOwnedAbilityIds = new Set(this.actor.items
      .filter(item => item.type === "ability")
      .map(item => getAbilitySourceId(item))
      .filter(Boolean));
    const researchBySourceId = new Map((this.actor.system?.researches ?? [])
      .filter(research => research.type === "ability" && research.sourceId)
      .map(research => [research.sourceId, research]));
    const skillByKey = new Map(skillSettings.map(skill => [skill.key, skill]));
    this.#abilityById = new Map();
    for (const category of catalog.categories ?? []) {
      for (const ability of category.abilities ?? []) {
        indexAbilityEvolutionFamily(ability, category, this.#abilityById);
      }
    }
    const requirementOwnedAbilityIds = collectOwnedAbilityLineageIds(currentOwnedAbilityIds, this.#abilityById);
    const ownedFamilyRootIds = new Set([...currentOwnedAbilityIds]
      .map(sourceId => String(this.#abilityById.get(sourceId)?.rootAbility?.id ?? "").trim())
      .filter(Boolean));
    const currentOwnedSourceIdByFamily = new Map();
    for (const sourceId of currentOwnedAbilityIds) {
      const indexed = this.#abilityById.get(sourceId);
      const familySourceId = String(indexed?.rootAbility?.id ?? "").trim();
      if (!familySourceId) continue;
      const previousSourceId = currentOwnedSourceIdByFamily.get(familySourceId);
      const previousDepth = this.#abilityById.get(previousSourceId)?.ancestorSourceIds?.length ?? -1;
      const currentDepth = indexed?.ancestorSourceIds?.length ?? 0;
      if (!previousSourceId || currentDepth > previousDepth) {
        currentOwnedSourceIdByFamily.set(familySourceId, sourceId);
      }
    }
    this.#abilityEntriesById.clear();
    this.#abilityRequirementRowsById.clear();
    this.#abilityTooltipHTMLCache.clear();
    this.#abilityRequirementContext = {
      ...requirementContext,
      abilityById: this.#abilityById,
      characteristicSettings,
      ownedAbilityIds: requirementOwnedAbilityIds,
      races,
      skillSettings
    };
    this.#abilityEvolutionPreparationContext = {
      currentOwnedAbilityIds,
      remaining,
      researchBySourceId,
      requirementContext: this.#abilityRequirementContext,
      skillByKey
    };

    return (catalog.categories ?? []).map(category => {
      const isFeatures = category.id === LOCKED_FEATURES_CATEGORY_ID;
      const traitTotal = isFeatures ? this.#getTraitSessionTotal(remaining.traits) : 0;
      const traitRemaining = Math.max(0, toInteger(remaining.traits));
      const abilities = (category.abilities ?? [])
        .filter(ability => ability?.visible !== false)
        .map(ability => {
          const familySourceId = String(ability?.id ?? "");
          const familyOwned = ownedFamilyRootIds.has(familySourceId);
          if (familyOwned && !abilityHasEvolutions(ability)) return null;
          const rootEntry = this.#prepareAbilityEntry(category, ability, remaining, {
            familyOwned,
            familyHasEvolution: abilityHasEvolutions(ability),
            familySourceId,
            ownedOverride: familyOwned,
            ownedAbilityIds: currentOwnedAbilityIds,
            researchBySourceId,
            requirementContext: this.#abilityRequirementContext,
            skillByKey
          });
          const currentOwnedSourceId = currentOwnedSourceIdByFamily.get(familySourceId);
          const currentOwnedEntry = this.#abilityById.get(currentOwnedSourceId);
          if (!familyOwned || !currentOwnedEntry || currentOwnedSourceId === familySourceId) return rootEntry;
          return this.#prepareAbilityEntry(category, currentOwnedEntry.ability, remaining, {
            evolutionParentIds: currentOwnedEntry.incomingSourceIds,
            familyOwned: true,
            familyHasEvolution: true,
            familySourceId,
            isEvolution: true,
            ownedAbilityIds: currentOwnedAbilityIds,
            researchBySourceId,
            requirementContext: this.#abilityRequirementContext,
            skillByKey
          });
        })
        .filter(Boolean);
      return {
        ...category,
        displayName: isFeatures
          ? (this.#gmMode ? "Особенности" : `Особенности (Доступно ${traitRemaining}/${traitTotal})`)
          : category.name,
        traitAvailabilityClass: isFeatures ? (this.#gmMode || traitRemaining > 0 ? "trait-available" : "trait-empty") : "",
        expanded: this.#expandedAbilityCategories.has(String(category.id ?? "")),
        abilities: abilities.sort(compareAbilityAvailability)
      };
    });
  }

  #prepareSelectedAbility() {
    if (!this.#selectedAbilitySourceId) return null;
    const selected = this.#abilityEntriesById.get(this.#selectedAbilitySourceId) ?? null;
    if (!selected) {
      this.#selectedAbilitySourceId = "";
      this.#selectedAbilityFamilySourceId = "";
      return null;
    }
    return selected;
  }

  #prepareAbilityEvolutionPanel() {
    this.#abilityEvolutionCompletedIds = new Set();
    const familySourceId = this.#selectedAbilityFamilySourceId;
    const familyEntry = this.#abilityById.get(familySourceId);
    const rootAbility = familyEntry?.rootAbility ?? familyEntry?.ability;
    if (!familySourceId || !familyEntry || !abilityHasEvolutions(rootAbility)) return null;

    this.#prepareAbilityEvolutionFamilyEntries(rootAbility, familyEntry.category);
    const familyIds = getAbilityEvolutionFamilyIds(rootAbility);
    if (!familyIds.has(this.#selectedAbilitySourceId)) this.#selectedAbilitySourceId = rootAbility.id;
    const graph = collectAbilityEvolutionGraph(rootAbility);
    const currentOwnedIds = this.#abilityEvolutionPreparationContext?.currentOwnedAbilityIds ?? new Set();
    const completedIds = collectCompletedEvolutionIds(graph.links, currentOwnedIds);
    this.#abilityEvolutionCompletedIds = completedIds;
    const { selectedAbility: selectedAbilityView } = this.#prepareAbilityEvolutionSelection();
    const nodeViews = graph.nodes.map(node => {
      const entry = this.#abilityEntriesById.get(node.ability.id) ?? null;
      const currentOwned = currentOwnedIds.has(node.ability.id);
      const completed = completedIds.has(node.ability.id);
      return {
        ...node,
        acquisitionAvailable: entry?.acquisitionAvailable !== false,
        completed,
        currentOwned,
        hasDescriptionTooltip: entry?.hasDescriptionTooltip === true
          || Boolean(String(node.ability?.evolutionSummary ?? "").trim()),
        researchActive: entry?.researchActive === true,
        selected: node.ability.id === this.#selectedAbilitySourceId,
        stateClass: currentOwned
          ? "current"
          : completed
            ? "completed"
            : entry?.acquisitionAvailable === false
              ? "locked"
              : entry?.researchActive
                ? "research-active"
                : "available",
        tooltipMode: entry?.isEvolution ? "evolution-summary" : "full",
        style: `left:${node.x}px;top:${node.y}px`
      };
    });
    const positionById = new Map(graph.nodes.map(node => [node.ability.id, node]));
    const linkViews = graph.links.flatMap(link => {
      const from = positionById.get(link.fromId);
      const to = positionById.get(link.toId);
      if (!from || !to) return [];
      const startX = from.x + (ABILITY_EVOLUTION_NODE_WIDTH / 2);
      const startY = from.y + ABILITY_EVOLUTION_NODE_HEIGHT;
      const endX = to.x + (ABILITY_EVOLUTION_NODE_WIDTH / 2);
      const endY = to.y;
      const direction = endY >= startY ? 1 : -1;
      const bend = Math.max(24, Math.abs(endY - startY) * 0.45);
      return [{
        ...link,
        completed: completedIds.has(link.fromId) && completedIds.has(link.toId),
        path: `M ${startX} ${startY} C ${startX} ${startY + (direction * bend)}, ${endX} ${endY - (direction * bend)}, ${endX} ${endY}`
      }];
    });
    return {
      familySourceId,
      links: linkViews,
      nodes: nodeViews,
      rootAbility,
      selectedAbility: selectedAbilityView
    };
  }

  #prepareAbilityEvolutionSelection() {
    const selectedAbility = this.#abilityEntriesById.get(this.#selectedAbilitySourceId) ?? null;
    const selectedAbilityView = selectedAbility
      && this.#abilityEvolutionCompletedIds.has(selectedAbility.sourceId)
      && !selectedAbility.currentOwned
      ? { ...selectedAbility, statusLabel: "Пройдено" }
      : selectedAbility;
    return {
      selectedAbility: selectedAbilityView
    };
  }

  #prepareAbilityEvolutionFamilyEntries(rootAbility, category) {
    const context = this.#abilityEvolutionPreparationContext;
    if (!context) return;
    for (const sourceId of getAbilityEvolutionFamilyIds(rootAbility, { includeRoot: false })) {
      const catalogEntry = this.#abilityById.get(sourceId);
      if (!catalogEntry) continue;
      this.#prepareAbilityEntry(category, catalogEntry.ability, context.remaining, {
        evolutionParentIds: catalogEntry.incomingSourceIds,
        familySourceId: rootAbility.id,
        isEvolution: true,
        ownedAbilityIds: context.currentOwnedAbilityIds,
        researchBySourceId: context.researchBySourceId,
        requirementContext: context.requirementContext,
        skillByKey: context.skillByKey
      });
    }
  }

  #getTraitSessionTotal(traitRemaining = 0) {
    return Math.max(0, toInteger(traitRemaining)) + this.#getTraitSessionSpent();
  }

  #prepareAbilityEntry(category, ability, remaining = {}, {
    evolutionParentIds = [],
    familyOwned = false,
    familyHasEvolution = null,
    familySourceId = "",
    isEvolution = false,
    ownedOverride = null,
    ownedAbilityIds = new Set(),
    researchBySourceId = new Map(),
    requirementContext = {},
    skillByKey = new Map()
  } = {}) {
    const sourceId = String(ability?.id ?? "");
    const resolvedFamilySourceId = String(familySourceId || sourceId);
    const isFeature = category.id === LOCKED_FEATURES_CATEGORY_ID;
    const cost = Math.max(0, toInteger(ability?.system?.cost));
    const research = researchBySourceId.get(sourceId) ?? null;
    const target = Math.max(1, Number(research?.target) || cost || 1);
    const progress = research ? Math.min(target, Math.max(0, Number(research.progress) || 0)) : 0;
    const remainingCost = Math.max(0, target - progress);
    const currentOwned = ownedAbilityIds.has(sourceId);
    const owned = ownedOverride == null ? currentOwned : Boolean(ownedOverride);
    const onlyFree = Boolean(ability?.system?.acquisition?.onlyFree);
    const onlyManual = Boolean(ability?.system?.acquisition?.onlyManual);
    const completed = Boolean(research) && progress >= target;
    const skillLabel = skillByKey.get(ability?.system?.acquisition?.skillKey)?.label
      ?? skillByKey.values().next().value?.label
      ?? "";
    const requirementRows = getAbilityAcquisitionRequirementRows(this.actor, ability, requirementContext);
    const requirementsMet = requirementRows.every(requirement => requirement.met);
    const evolutionAvailable = !isEvolution || evolutionParentIds.some(parentId => ownedAbilityIds.has(parentId));
    const evolutionAcquisitionBlocked = !owned
      && isEvolution
      && evolutionAvailable
      && hasUnsafeAbilityEvolutionAcquisitionChanges(this.actor, ability, evolutionParentIds);
    const acquisitionAvailable = owned || (
      evolutionAvailable
      && !evolutionAcquisitionBlocked
      && (this.#gmMode || requirementsMet)
    );
    const requirementLabel = getAbilityAcquisitionRequirementLabel(requirementRows);
    this.#abilityRequirementRowsById.set(sourceId, requirementRows);
    const entry = {
      ...ability,
      sourceId,
      categoryId: category.id,
      currentOwned,
      evolutionAcquisitionBlocked,
      evolutionAvailable,
      evolutionLocked: !evolutionAvailable,
      evolutionParentIds,
      familyOwned,
      familySourceId: resolvedFamilySourceId,
      hasEvolution: familyHasEvolution == null ? abilityHasEvolutions(ability) : Boolean(familyHasEvolution),
      isEvolution,
      isFeature,
      cost,
      progress,
      progressLabel: `${formatResearchValue(progress)} / ${formatResearchValue(target)}`,
      progressPercent: target > 0 ? Math.min(100, (progress / target) * 100).toFixed(2) : "100",
      remainingCost,
      owned,
      onlyFree,
      onlyManual,
      acquisitionAvailable,
      requirementLabel,
      hasDescriptionTooltip: Boolean(String(ability?.description ?? "").trim() || requirementRows.length),
      canPurchaseTrait: isFeature && !owned && acquisitionAvailable && toInteger(remaining.traits) > 0,
      canGrant: !owned && evolutionAvailable && !evolutionAcquisitionBlocked,
      canSpendFree: !isFeature && !owned && acquisitionAvailable && Boolean(research) && !onlyManual && (completed || (remainingCost > 0 && toInteger(remaining.researches) > 0)),
      canSelectRewardChanges: completed,
      freeSpendAmount: Math.min(toInteger(remaining.researches), remainingCost),
      canStartManual: !isFeature && !owned && acquisitionAvailable && !research,
      researchId: research?.id ?? "",
      researchActive: Boolean(research),
      selected: resolvedFamilySourceId === this.#selectedAbilityFamilySourceId
        || sourceId === this.#selectedAbilitySourceId,
      statusLabel: currentOwned
        ? "Текущая версия"
        : familyOwned
          ? "Эволюция активна"
          : evolutionAcquisitionBlocked
            ? "Недоступно: изменения при приобретении"
            : !evolutionAvailable
              ? "Нужна предыдущая эволюция"
              : !acquisitionAvailable
                ? "Недоступно"
                : research
                  ? "Исследуется"
                  : "Не изучено",
      acquisitionLabel: onlyFree ? "Только свободные ОИ" : onlyManual ? "Только ручное исследование" : "Свободные ОИ или ручное исследование",
      manualLabel: skillLabel ? `${skillLabel}, сложность ${toInteger(ability?.system?.acquisition?.difficulty ?? 60)}` : ""
    };
    this.#abilityEntriesById.set(sourceId, entry);
    return entry;
  }

  #getAbilityResearch(sourceId = "") {
    return (this.actor.system?.researches ?? []).find(research => research.type === "ability" && research.sourceId === sourceId) ?? null;
  }

  #createAbilityResearchData(entry, progress = 0) {
    const ability = entry.ability;
    const skillSettings = getSkillSettings();
    const skillKey = String(ability.system?.acquisition?.skillKey || skillSettings[0]?.key || "");
    const target = Math.max(1, toInteger(ability.system?.cost));
    const rootSourceId = String(entry.rootAbility?.id ?? "");
    const itemData = prepareAbilityItemData(ability, {
      categoryId: entry.category.id,
      evolutionRootId: rootSourceId && rootSourceId !== ability.id ? rootSourceId : "",
      evolutionParentIds: entry.incomingSourceIds ?? [],
      evolutionAncestorIds: entry.ancestorSourceIds ?? []
    });
    const initialProgress = toInteger(ability.system?.cost) <= 0 ? target : progress;
    return {
      name: ability.name,
      skillKey,
      progress: Math.min(Math.max(0, Number(initialProgress) || 0), target),
      target,
      difficulty: Math.max(0, toInteger(ability.system?.acquisition?.difficulty ?? 60)),
      type: "ability",
      sourceId: ability.id,
      sourceCategoryId: entry.category.id,
      freeSpent: 0,
      rewards: [
        {
          type: "item",
          name: itemData.name,
          img: itemData.img,
          quantity: 1,
          itemData
        }
      ]
    };
  }

  async #applyRepeatAction(action, key, { persist = true } = {}) {
    if (action === "increaseCharacteristic") return this.#changeCharacteristic(key, 1, { persist });
    if (action === "decreaseCharacteristic") return this.#changeCharacteristic(key, -1, { persist });
    if (action === "increaseSkill") return this.#changeSkill(key, 1, { persist });
    if (action === "decreaseSkill") return this.#changeSkill(key, -1, { persist });
    return false;
  }

  async #onRepeatButtonClick(event) {
    event.preventDefault();
    event.stopPropagation();

    if (this.#repeatClickSuppression?.target === event.currentTarget) {
      this.#repeatClickSuppression = null;
      return;
    }
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement) || target.hasAttribute("disabled") || target.getAttribute("aria-disabled") === "true") return;

    const action = target.dataset.repeatAction ?? "";
    const key = target.dataset.characteristicKey ?? target.dataset.skillKey ?? "";
    if (!action || !key) return;

    if (!(await this.#applyRepeatAction(action, key, { persist: false }))) return;
    this.#refreshRepeatPreview(action, key);
    this.#scheduleRepeatCommit();
  }

  async #onRepeatButtonPointerDown(event) {
    if (event.button !== 0) return;

    event.preventDefault();
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement) || target.hasAttribute("disabled") || target.getAttribute("aria-disabled") === "true") return;

    const action = target.dataset.repeatAction ?? "";
    const key = target.dataset.characteristicKey ?? target.dataset.skillKey ?? "";
    if (!action || !key) return;

    void this.#stopRepeat();
    const clickSuppression = { target };
    this.#repeatClickSuppression = clickSuppression;
    const controller = new AbortController();
    const state = {
      action,
      key,
      controller,
      dirty: false,
      pending: null,
      stopping: false,
      stopPromise: null,
      timer: null
    };

    this.#repeatState = state;
    window.addEventListener("pointerup", () => {
      void this.#stopRepeat();
      window.setTimeout(() => {
        if (this.#repeatClickSuppression === clickSuppression) this.#repeatClickSuppression = null;
      }, 0);
    }, { signal: controller.signal });
    window.addEventListener("pointercancel", () => {
      if (this.#repeatClickSuppression === clickSuppression) this.#repeatClickSuppression = null;
      void this.#stopRepeat();
    }, { signal: controller.signal });
    window.addEventListener("blur", () => {
      if (this.#repeatClickSuppression === clickSuppression) this.#repeatClickSuppression = null;
      void this.#stopRepeat();
    }, { signal: controller.signal });

    state.pending = this.#runRepeatStep(state);
    if (!(await state.pending) || state.stopping || this.#repeatState !== state) return;
    state.timer = window.setTimeout(() => this.#runRepeatTick(state), REPEAT_INITIAL_DELAY_MS);
  }

  async #runRepeatTick(state) {
    if (this.#repeatState !== state || state.stopping) return;
    state.pending = this.#runRepeatStep(state);
    if (!(await state.pending)) {
      void this.#stopRepeat();
      return;
    }

    if (this.#repeatState !== state || state.stopping) return;
    state.timer = window.setTimeout(() => this.#runRepeatTick(state), REPEAT_INTERVAL_MS);
  }

  async #runRepeatStep(state) {
    if (this.#repeatState !== state || state.stopping) return false;
    const changed = await this.#applyRepeatAction(state.action, state.key, { persist: false });
    if (!changed) return false;

    state.dirty = true;
    if (!state.stopping && this.#repeatState === state) this.#refreshRepeatPreview(state.action, state.key);
    return true;
  }

  async #stopRepeat({ flush = false } = {}) {
    const state = this.#repeatState;
    if (!state) {
      if (flush) await this.#flushRepeatCommit();
      return false;
    }
    if (state.stopPromise) return state.stopPromise;

    state.stopping = true;
    window.clearTimeout(state.timer);
    state.controller.abort();
    if (this.#repeatState === state) this.#repeatState = null;
    state.stopPromise = (async () => {
      await state.pending;
      if (state.dirty) {
        this.#scheduleRepeatCommit();
        if (flush) await this.#flushRepeatCommit();
      }
      return state.dirty;
    })();
    return state.stopPromise;
  }

  #refreshRepeatPreview(action, key) {
    const isSkill = action.endsWith("Skill");
    const multiplierChanges = this.#getSkillAdvancementMultiplierChanges();
    const refreshAllSkills = !isSkill || Boolean(multiplierChanges.versatileDevelopment?.active);
    if (isSkill && !refreshAllSkills) {
      const valueElement = this.element?.querySelector?.(
        `[data-advancement-skill-value="${CSS.escape(key)}"]`
      );
      if (valueElement) valueElement.textContent = String(this.#getPreviewSkillValue(key));
    } else if (!isSkill) {
      const valueElement = this.element?.querySelector?.(
        `[data-advancement-characteristic-value="${CSS.escape(key)}"]`
      );
      if (valueElement) valueElement.textContent = String(this.#getPreviewCharacteristicValue(key));
    }
    if (refreshAllSkills) {
      for (const skill of getSkillSettings()) {
        const skillValueElement = this.element?.querySelector?.(
          `[data-advancement-skill-value="${CSS.escape(skill.key)}"]`
        );
        if (skillValueElement) skillValueElement.textContent = String(this.#getPreviewSkillValue(skill.key));
      }
    }

    const remaining = calculateRemainingDevelopmentPoints(this.#draft?.development);
    const pointDisplays = this.#preparePointDisplays(remaining);
    for (const [pointType, display] of Object.entries(pointDisplays)) {
      const element = this.element?.querySelector?.(
        `[data-advancement-point-display="${CSS.escape(pointType)}"]`
      );
      if (element) element.textContent = display;
    }

    this.#refreshRepeatControlStates(remaining);
    if (isSkill) this.#refreshSkillCostPreview(key, remaining);
    else {
      const activeSkillKey = String(this.#skillCostTooltipAnchor?.dataset?.skillKey ?? "");
      if (activeSkillKey) this.#refreshSkillCostPreview(activeSkillKey, remaining);
    }
  }

  #refreshRepeatControlStates(remaining = calculateRemainingDevelopmentPoints(this.#draft?.development)) {
    for (const characteristic of getCharacteristicSettings()) {
      const escapedKey = CSS.escape(characteristic.key);
      const increase = this.element?.querySelector?.(
        `[data-repeat-action="increaseCharacteristic"][data-characteristic-key="${escapedKey}"]`
      );
      const decrease = this.element?.querySelector?.(
        `[data-repeat-action="decreaseCharacteristic"][data-characteristic-key="${escapedKey}"]`
      );
      const currentPoints = toInteger(this.#draft?.development?.characteristics?.[characteristic.key]);
      const floorPoints = toInteger(this.#floor?.development?.characteristics?.[characteristic.key]);
      increase?.toggleAttribute("disabled", !this.#gmMode && remaining.characteristics <= 0);
      decrease?.toggleAttribute(
        "disabled",
        this.#gmMode
          ? this.#getPreviewCharacteristicValue(characteristic.key) <= 0
          : currentPoints <= floorPoints
      );
    }

    const developmentLimit = this.#getSkillDevelopmentLimit();
    const multiplierChanges = this.#getSkillAdvancementMultiplierChanges();
    const versatileDevelopment = multiplierChanges.versatileDevelopment;
    const developmentCostSettings = getSkillDevelopmentCostSettings();
    for (const skill of getSkillSettings()) {
      const escapedKey = CSS.escape(skill.key);
      const increase = this.element?.querySelector?.(
        `[data-repeat-action="increaseSkill"][data-skill-key="${escapedKey}"]`
      );
      const decrease = this.element?.querySelector?.(
        `[data-repeat-action="decreaseSkill"][data-skill-key="${escapedKey}"]`
      );
      const currentPoints = toInteger(this.#draft?.development?.skills?.[skill.key]?.points);
      const floorPoints = toInteger(this.#floor?.development?.skills?.[skill.key]?.points);
      const pureValue = this.#getPreviewSkillPureValue(skill.key);
      const cost = getSkillDevelopmentCostForValue(pureValue, developmentCostSettings);
      const canIncrease = this.#gmMode
        ? pureValue < developmentLimit
        : remaining.skills >= cost
          && pureValue < developmentLimit;
      increase?.setAttribute("aria-disabled", String(!canIncrease));
      if (increase) {
        increase.dataset.versatileDevelopmentState = getVersatileDevelopmentButtonState(
          versatileDevelopment,
          skill.key
        );
      }
      decrease?.toggleAttribute(
        "disabled",
        this.#gmMode ? currentPoints <= 0 : currentPoints <= floorPoints
      );
    }
  }

  #refreshSkillCostPreview(key, remaining = calculateRemainingDevelopmentPoints(this.#draft?.development)) {
    const anchor = this.element?.querySelector?.(
      `[data-repeat-action="increaseSkill"][data-skill-key="${CSS.escape(key)}"]`
    );
    if (!anchor) return;

    if (this.#gmMode) {
      anchor.dataset.skillCostTooltip = "";
      anchor.setAttribute(
        "aria-disabled",
        String(this.#getPreviewSkillPureValue(key) >= this.#getSkillDevelopmentLimit())
      );
      return;
    }

    const characteristicSettings = getCharacteristicSettings();
    const skillSettings = getSkillSettings();
    const skill = skillSettings.find(entry => entry.key === key);
    if (!skill) return;

    const advancementSettings = getSkillAdvancementSettings(characteristicSettings, skillSettings);
    const characteristics = this.#getCleanCharacteristics(characteristicSettings);
    const multiplierChanges = this.#getSkillAdvancementMultiplierChanges(skillSettings);
    const developmentCostSettings = getSkillDevelopmentCostSettings();
    const pureValue = this.#getPureSkillValue(key, {
      characteristicSettings,
      skillSettings,
      skillAdvancementSettings: advancementSettings,
      characteristics,
      multiplierChanges
    });
    const cost = getSkillDevelopmentCostForValue(pureValue, developmentCostSettings);
    const totalValue = this.#getPreviewSkillValue(key);
    const currentSkill = this.#draft.development.skills?.[key] ?? {};
    const signature = Boolean(currentSkill.signature) && multiplierChanges.signatureSkillsDisabled !== true;
    const html = renderSkillCostTooltipHTML({
      skill,
      totalValue,
      pureValue,
      investedPoints: toInteger(currentSkill.points),
      cost,
      gain: calculateSkillDevelopmentGain({
        skill,
        characteristics,
        advancementSettings,
        multiplierChanges,
        signature
      }),
      multiplierLabel: advancementSettings.mode === "fixed"
        ? ""
        : formatSkillDevelopmentMultiplier({
          skill,
          characteristics,
          characteristicSettings,
          advancementSettings,
          multiplierChanges,
          signature
        }),
      nextThreshold: getNextSkillDevelopmentCostThreshold(pureValue, developmentCostSettings),
      remainingSkillPoints: remaining.skills
    });

    anchor.dataset.skillCostTooltip = html;
    anchor.setAttribute(
      "aria-disabled",
      String(!(remaining.skills >= cost && pureValue < this.#getSkillDevelopmentLimit()))
    );
    if (this.#skillCostTooltipAnchor?.dataset?.skillKey !== key || !this.#skillCostTooltipElement) return;

    this.#skillCostTooltipAnchor = anchor;
    this.#skillCostTooltipElement.innerHTML = `<div class="content">${html}</div>`;
    this.#positionAdvancementTooltip(this.#skillCostTooltipElement, anchor);
  }

  async #onActorUpdated(updatedActor, changes, updateOptions = {}) {
    if (this.#isClosing) return;
    if (updatedActor?.id !== this.actor?.id) return;
    if (updateOptions?.[ADVANCEMENT_UPDATE_SOURCE_OPTION] === this.id) return;
    if (!this.rendered) return;

    const affectsDraft = [
      "system.attributes.level",
      "system.characteristics",
      "system.development",
      "system.proficiencies",
      "system.creature.raceId",
      "system.progression",
      "name"
    ].some(path => foundry.utils.hasProperty(changes, path));
    const affectsResearch = foundry.utils.hasProperty(changes, "system.researches");
    if (!affectsDraft && !affectsResearch) return;

    this.#invalidateActorDerivedCaches();
    if (affectsDraft && this.#draft) this.#syncDraftFromActor();
    await this.forceRender();
  }

  async #onActiveEffectChanged(effect) {
    if (this.#isClosing) return;
    if (effect?.parent?.id !== this.actor?.id) return;
    if (!this.rendered) return;
    this.#invalidateActorDerivedCaches();
    await this.forceRender();
  }

  #invalidateActorDerivedCaches() {
    this.#advancementPureValues = null;
    this.#skillAdvancementMultiplierSource = null;
    this.#skillAdvancementMultiplierChanges = null;
    this.#abilityTooltipHTMLCache.clear();
  }

  async #saveDraft({ notify = true } = {}) {
    if (!this.#draft) return false;

    this.#syncDraftFromForm();
    await this.#flushRepeatCommit();
    if (!this.#hasDraftChanges()) return false;

    await this.#applyDraftToActor();
    await this.actor.setFlag(FALLOUT_MAW.id, ADVANCEMENT_COMMIT_FLAG, {
      level: this.#draft.level,
      characteristics: foundry.utils.deepClone(this.#draft.characteristics),
      proficiencies: foundry.utils.deepClone(this.#draft.proficiencies),
      development: foundry.utils.deepClone(this.#draft.development)
    });

    this.#snapshot = foundry.utils.deepClone(this.#draft);
    this.#floor = foundry.utils.deepClone(this.#draft);
    this.#resetSkillUpgradeCostLedger();
    this.#researchPointSessionSpent = 0;
    if (notify) ui.notifications.info(localize("FALLOUTMAW.Messages.AdvancementSaved"));
    return true;
  }

  async #applyDraftToActor(updateData = {}) {
    window.clearTimeout(this.#repeatCommitTimer);
    this.#repeatCommitTimer = null;
    const actorUpdate = {
      "system.attributes.level": this.#draft.level,
      "system.characteristics": foundry.utils.deepClone(this.#draft.characteristics),
      "system.development": foundry.utils.deepClone(this.#draft.development),
      ...this.#getProficiencyActorUpdateData(),
      ...updateData
    };
    const commit = this.#repeatCommitPromise
      .catch(error => {
        console.error(`${FALLOUT_MAW.id} | Failed to commit advancement repeat update`, error);
      })
      .then(() => this.actor.update(actorUpdate, {
        render: false,
        [ADVANCEMENT_UPDATE_SOURCE_OPTION]: this.id
      }));
    this.#repeatCommitPromise = commit;
    return commit;
  }

  #scheduleRepeatCommit() {
    window.clearTimeout(this.#repeatCommitTimer);
    this.#repeatCommitTimer = window.setTimeout(() => {
      this.#repeatCommitTimer = null;
      void this.#applyDraftToActor();
    }, 60);
  }

  async #flushRepeatCommit() {
    if (this.#repeatCommitTimer) {
      window.clearTimeout(this.#repeatCommitTimer);
      this.#repeatCommitTimer = null;
      await this.#applyDraftToActor();
      return;
    }
    await this.#repeatCommitPromise;
  }

  #syncDraftFromActor() {
    this.#invalidateActorDerivedCaches();
    const characteristicSettings = getCharacteristicSettings();
    const skillSettings = getSkillSettings();
    const proficiencySettings = getProficiencySettings();
    const development = cloneActorDevelopment(this.actor.getDevelopment(), characteristicSettings, skillSettings, proficiencySettings);

    this.#draft = {
      level: Math.max(1, toInteger(this.actor.system?.attributes?.level)),
      characteristics: Object.fromEntries(
        characteristicSettings.map(characteristic => [
          characteristic.key,
          toInteger(this.actor.system?._source?.characteristics?.[characteristic.key] ?? this.actor.system?.characteristics?.[characteristic.key])
        ])
      ),
      proficiencies: this.#getActorProficiencyValues(proficiencySettings),
      development
    };
  }

  #readCommittedState(characteristicSettings, skillSettings, proficiencySettings = getProficiencySettings()) {
    const committed = this.actor.getFlag(FALLOUT_MAW.id, ADVANCEMENT_COMMIT_FLAG);
    if (!committed || (typeof committed !== "object")) return null;

    return {
      level: Math.max(1, toInteger(committed.level)),
      characteristics: Object.fromEntries(
        characteristicSettings.map(characteristic => [characteristic.key, toInteger(committed.characteristics?.[characteristic.key])])
      ),
      proficiencies: this.#getCommittedProficiencyValues(committed, proficiencySettings),
      development: cloneActorDevelopment(committed.development, characteristicSettings, skillSettings, proficiencySettings)
    };
  }

  #hasDraftChanges() {
    return JSON.stringify(this.#draft) !== JSON.stringify(this.#snapshot);
  }
}

function indexAbilityEvolutionFamily(
  ability,
  category,
  index,
  { ancestorSourceIds = [], rootAbility = ability, parentAbility = null, ownerAbility = null } = {}
) {
  const sourceId = String(ability?.id ?? "").trim();
  if (!sourceId || index.has(sourceId)) return;
  const ownerEvolution = ownerAbility?.system?.evolution;
  const incomingSourceIds = ownerEvolution
    ? (ownerEvolution.links ?? [])
      .filter(link => String(link?.toId ?? "") === sourceId)
      .map(link => String(link?.fromId ?? "").trim())
      .filter(Boolean)
    : [];
  index.set(sourceId, {
    ability,
    ancestorSourceIds,
    category,
    incomingSourceIds,
    ownerAbility,
    parentAbility,
    rootAbility
  });
  for (const node of ability?.system?.evolution?.nodes ?? []) {
    const localAncestorSourceIds = getLocalEvolutionAncestorSourceIds(ability, node?.id ?? node?.ability?.id);
    indexAbilityEvolutionFamily(node?.ability, category, index, {
      ancestorSourceIds: Array.from(new Set([...ancestorSourceIds, ...localAncestorSourceIds])),
      rootAbility,
      parentAbility: ability,
      ownerAbility: ability
    });
  }
}

function getLocalEvolutionAncestorSourceIds(ownerAbility = {}, nodeId = "") {
  const rootId = String(ownerAbility?.id ?? "").trim();
  const links = ownerAbility?.system?.evolution?.links ?? [];
  const ancestors = [];
  const visited = new Set([String(nodeId ?? "").trim()]);
  let currentId = String(nodeId ?? "").trim();
  while (currentId) {
    const incoming = links.find(link => String(link?.toId ?? "") === currentId);
    const parentId = String(incoming?.fromId ?? "").trim();
    if (!parentId || visited.has(parentId)) break;
    ancestors.unshift(parentId);
    if (parentId === rootId) break;
    visited.add(parentId);
    currentId = parentId;
  }
  return ancestors;
}

function collectOwnedAbilityLineageIds(currentOwnedIds = new Set(), abilityById = new Map()) {
  const result = new Set(currentOwnedIds);
  const pending = [...currentOwnedIds];
  while (pending.length) {
    const sourceId = pending.pop();
    const entry = abilityById.get(sourceId);
    const predecessors = [
      ...(entry?.incomingSourceIds ?? []),
      String(entry?.rootAbility?.id ?? "").trim()
    ];
    for (const predecessorId of predecessors) {
      if (!predecessorId || result.has(predecessorId)) continue;
      result.add(predecessorId);
      pending.push(predecessorId);
    }
  }
  return result;
}

function collectAbilityEvolutionGraph(rootAbility = {}) {
  const nodes = [];
  const links = [];
  const nodeIds = new Set();
  const linkIds = new Set();
  const visit = (ability, originX = 0, originY = 0) => {
    const sourceId = String(ability?.id ?? "").trim();
    if (!sourceId || nodeIds.has(sourceId)) return;
    nodeIds.add(sourceId);
    nodes.push({ ability, x: originX, y: originY });
    const evolution = ability?.system?.evolution ?? {};
    const positions = new Map([[sourceId, { x: originX, y: originY }]]);
    for (const node of evolution.nodes ?? []) {
      const nodeSourceId = String(node?.ability?.id ?? node?.id ?? "").trim();
      if (!nodeSourceId) continue;
      positions.set(nodeSourceId, {
        x: originX + (Number(node?.x) || 0),
        y: originY + (Number(node?.y) || 0)
      });
    }
    for (const link of evolution.links ?? []) {
      const fromId = String(link?.fromId ?? "").trim();
      const toId = String(link?.toId ?? "").trim();
      if (!positions.has(fromId) || !positions.has(toId)) continue;
      // Link ids are local to each nested evolution graph. Qualify them by the
      // owning ability before flattening so identical generated ids at deeper
      // matryoshka levels cannot hide edges from the panel or completion walk.
      const localId = String(link?.id ?? `${fromId}:${toId}`);
      const id = `${sourceId}::${localId}`;
      if (linkIds.has(id)) continue;
      linkIds.add(id);
      links.push({ id, fromId, toId });
    }
    for (const node of evolution.nodes ?? []) {
      const nodeSourceId = String(node?.ability?.id ?? node?.id ?? "").trim();
      const position = positions.get(nodeSourceId);
      if (!position) continue;
      visit(node?.ability, position.x, position.y);
    }
  };
  visit(rootAbility);
  return { links, nodes };
}

function collectCompletedEvolutionIds(links = [], currentOwnedIds = new Set()) {
  const incomingById = new Map();
  const graphIds = new Set();
  for (const link of links) {
    graphIds.add(link.fromId);
    graphIds.add(link.toId);
    const incoming = incomingById.get(link.toId) ?? [];
    incoming.push(link.fromId);
    incomingById.set(link.toId, incoming);
  }
  const completed = new Set([...currentOwnedIds].filter(sourceId => graphIds.has(sourceId)));
  const pending = [...completed];
  while (pending.length) {
    const sourceId = pending.pop();
    for (const predecessorId of incomingById.get(sourceId) ?? []) {
      if (completed.has(predecessorId)) continue;
      completed.add(predecessorId);
      pending.push(predecessorId);
    }
  }
  return completed;
}

function collectRenderedAbilityEvolutionGraph(layer) {
  if (!layer) return { links: [], nodes: [] };
  const nodes = Array.from(layer.querySelectorAll("[data-ability-evolution-node]"), node => ({
    currentOwned: node.dataset.currentOwned === "true",
    id: String(node.dataset.abilitySourceId ?? ""),
    x: Number(node.dataset.nodeX) || 0,
    y: Number(node.dataset.nodeY) || 0
  })).filter(node => node.id);
  const links = Array.from(layer.querySelectorAll("[data-ability-evolution-link-id]"), link => ({
    fromId: String(link.dataset.fromId ?? ""),
    toId: String(link.dataset.toId ?? "")
  })).filter(link => link.fromId && link.toId);
  return { links, nodes };
}

function getAbilityEvolutionGraphFingerprint(layer) {
  if (!layer) return "";
  const nodes = Array.from(layer.querySelectorAll("[data-ability-evolution-node]"), node => [
    node.dataset.abilitySourceId ?? "",
    node.getAttribute("style") ?? "",
    node.querySelector("img")?.getAttribute("src") ?? "",
    node.querySelector("strong")?.textContent ?? ""
  ].join("\u0001")).join("\u0002");
  const links = Array.from(layer.querySelectorAll("[data-ability-evolution-link-id]"), link => [
    link.dataset.abilityEvolutionLinkId ?? "",
    link.getAttribute("d") ?? ""
  ].join("\u0001")).join("\u0002");
  return `${nodes}\u0003${links}`;
}

function clampAbilityEvolutionZoom(value) {
  const zoom = Number(value);
  return Math.max(
    ABILITY_EVOLUTION_ZOOM_MIN,
    Math.min(ABILITY_EVOLUTION_ZOOM_MAX, Number.isFinite(zoom) ? zoom : 1)
  );
}

function snapToDevicePixel(value, view = globalThis.window) {
  const ratio = Math.max(1, Number(view?.devicePixelRatio) || 1);
  return Math.round((Number(value) || 0) * ratio) / ratio;
}

function abilityAcquisitionRequirementsMet(actor, ability = {}, context = {}) {
  return getAbilityAcquisitionRequirementRows(actor, ability, context).every(requirement => requirement.met);
}

function getAbilityAcquisitionRequirementRows(actor, ability = {}, context = {}) {
  const rows = [];
  const races = context.races ?? getCreatureRaceSummaries();
  const characteristics = context.characteristicSettings ?? getCharacteristicSettings();
  const skills = context.skillSettings ?? getSkillSettings();
  const requirementCharacteristics = context?.characteristics ?? actor?.system?.characteristics ?? {};
  const requirementSkills = context?.skills ?? {};
  for (const requirement of ability.system?.acquisitionRequirements ?? []) {
    if (requirement?.type === ABILITY_ACQUISITION_CONDITION_TYPES.race) {
      const raceId = String(requirement.raceId ?? "").trim();
      if (!raceId) continue;
      const currentRaceId = String(actor?.system?.creature?.raceId ?? "");
      const race = races.find(entry => entry.id === raceId);
      const currentRace = races.find(entry => entry.id === currentRaceId);
      rows.push({
        type: requirement.type,
        label: "Раса",
        targetLabel: race?.name || raceId,
        currentLabel: currentRace?.name || currentRaceId || "Нет",
        required: raceId,
        current: currentRaceId,
        met: currentRaceId === raceId,
        summary: `${race?.name || raceId}: ${currentRace?.name || currentRaceId || "Нет"}`
      });
      continue;
    }

    if (requirement?.type === ABILITY_ACQUISITION_CONDITION_TYPES.characteristic) {
      const key = String(requirement.characteristicKey ?? requirement.key ?? "").trim();
      const required = Math.max(0, toInteger(requirement.value ?? requirement.minimum));
      if (!key || required <= 0) continue;
      const characteristic = characteristics.find(entry => entry.key === key);
      const current = toInteger(requirementCharacteristics?.[key]);
      rows.push({
        type: requirement.type,
        label: "Характеристика",
        targetLabel: characteristic?.label || key,
        current,
        required,
        met: current >= required,
        summary: `${characteristic?.label || key}: ${current} / ${required}`
      });
      continue;
    }

    if (requirement?.type === ABILITY_ACQUISITION_CONDITION_TYPES.skill) {
      const key = String(requirement.skillKey ?? requirement.key ?? "").trim();
      const required = Math.max(0, toInteger(requirement.value ?? requirement.minimum));
      if (!key || required <= 0) continue;
      const skill = skills.find(entry => entry.key === key);
      const current = Object.prototype.hasOwnProperty.call(requirementSkills, key)
        ? toInteger(requirementSkills?.[key])
        : toInteger(actor?.system?.skills?.[key]?.value);
      rows.push({
        type: requirement.type,
        label: "Навык",
        targetLabel: skill?.label || key,
        current,
        required,
        met: current >= required,
        summary: `${skill?.label || key}: ${current} / ${required}`
      });
      continue;
    }

    if (requirement?.type === ABILITY_ACQUISITION_CONDITION_TYPES.ability) {
      const mode = String(requirement.mode ?? ABILITY_ACQUISITION_ABILITY_MODES.present).trim()
        === ABILITY_ACQUISITION_ABILITY_MODES.absent
        ? ABILITY_ACQUISITION_ABILITY_MODES.absent
        : ABILITY_ACQUISITION_ABILITY_MODES.present;
      const abilityIds = (requirement.abilityIds ?? [])
        .map(id => String(id ?? "").trim())
        .filter(Boolean);
      if (!abilityIds.length) continue;
      const requiresPresence = mode === ABILITY_ACQUISITION_ABILITY_MODES.present;
      for (const abilityId of abilityIds) {
        const catalogEntry = context.abilityById?.get(abilityId) ?? findCatalogAbility(abilityId);
        const abilityName = catalogEntry?.ability?.name || abilityId;
        const hasAbility = context.ownedAbilityIds instanceof Set
          ? context.ownedAbilityIds.has(abilityId)
          : actorHasAbility(actor, abilityId);
        const met = requiresPresence ? hasAbility : !hasAbility;
        const currentLabel = hasAbility ? "Есть" : "Нет";
        const requiredLabel = requiresPresence ? "Есть" : "Нет";
        rows.push({
          type: requirement.type,
          mode,
          label: requiresPresence ? "Наличие способности" : "Отсутствие способности",
          targetLabel: abilityName,
          currentLabel,
          requiredLabel,
          current: currentLabel,
          required: requiredLabel,
          met,
          summary: requiresPresence
            ? `Нужна: ${abilityName} (${currentLabel})`
            : `Исключает: ${abilityName} (${currentLabel})`
        });
      }
    }
  }
  return rows;
}

function getAbilityAcquisitionRequirementLabel(requirementRows = []) {
  return requirementRows.map(requirement => requirement.summary).join("; ");
}

function compareAbilityAvailability(left, right) {
  if (left?.acquisitionAvailable !== right?.acquisitionAvailable) {
    return left?.acquisitionAvailable ? -1 : 1;
  }
  return String(left?.name ?? "").localeCompare(String(right?.name ?? ""), "ru", {
    sensitivity: "base",
    numeric: true
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

async function renderAbilityDescriptionTooltipHTML(ability = {}, { actor = null, requirementRows = [] } = {}) {
  const descriptionSource = String(ability?.description ?? "").trim();
  const descriptionHTML = descriptionSource
    ? await TextEditor.enrichHTML(descriptionSource, {
      secrets: actor?.isOwner ?? true,
      relativeTo: actor,
      rollData: actor?.getRollData?.() ?? {}
    })
    : "";
  const titleSection = `
    <section class="function-section single-value fallout-maw-ability-tooltip-title">
      <h4>Название</h4>
      <strong>${escapeHtml(ability?.name ?? "")}</strong>
    </section>
  `;
  const requirementSection = requirementRows.length
    ? `
      <section class="function-section fallout-maw-advancement-tooltip-requirements">
        <h4>Требования</h4>
        <div class="function-grid">
          ${requirementRows.map(renderAbilityRequirementTooltipRow).join("")}
        </div>
      </section>
    `
    : "";
  const descriptionSection = descriptionHTML
    ? `
      <section class="function-section fallout-maw-ability-tooltip-description">
        <h4>Описание</h4>
        <div class="description">${descriptionHTML}</div>
      </section>
    `
    : "";
  return `${titleSection}${requirementSection}${descriptionSection}`;
}

function renderSkillCostTooltipHTML({
  skill = {},
  totalValue = 0,
  pureValue = 0,
  investedPoints = 0,
  cost = 1,
  gain = 0,
  multiplierLabel = "",
  nextThreshold = null,
  remainingSkillPoints = 0
} = {}) {
  const canPay = toInteger(remainingSkillPoints) >= toInteger(cost);
  const paymentClass = canPay ? "met" : "unmet";
  const multiplierSection = multiplierLabel
    ? `
        <div class="function-row">
          <span>Множитель</span>
          <strong class="fallout-maw-skill-cost-tooltip-multiplier">${escapeHtml(multiplierLabel)}</strong>
        </div>
      `
    : "";
  const nextThresholdSection = nextThreshold
    ? `
      <div class="function-row">
        <span>Следующий порог</span>
        <strong>от ${escapeHtml(nextThreshold.threshold)}: ${escapeHtml(nextThreshold.cost)} очк.</strong>
      </div>
      <div class="function-row">
        <span>До порога</span>
        <strong>${escapeHtml(nextThreshold.remaining)}</strong>
      </div>
    `
    : `
      <div class="function-row">
        <span>Следующий порог</span>
        <strong>нет</strong>
      </div>
    `;

  return `
    <section class="function-section single-value fallout-maw-skill-cost-tooltip-title">
      <h4>Навык</h4>
      <strong>${escapeHtml(skill.label || skill.key || "")}</strong>
    </section>
    <section class="function-section fallout-maw-skill-cost-tooltip-values">
      <h4>Развитие</h4>
      <div class="function-grid">
        <div class="function-row fallout-maw-advancement-tooltip-requirement ${paymentClass}">
          <span>Стоимость</span>
          <strong>${escapeHtml(cost)} очк.</strong>
        </div>
        <div class="function-row">
          <span>Чистое значение</span>
          <strong>${escapeHtml(pureValue)}</strong>
        </div>
        <div class="function-row">
          <span>Общее значение</span>
          <strong>${escapeHtml(totalValue)}</strong>
        </div>
        <div class="function-row">
          <span>Вложено</span>
          <strong>${escapeHtml(investedPoints)}</strong>
        </div>
        <div class="function-row">
          <span>Прирост</span>
          <strong>+${escapeHtml(formatFixedDecimal(gain, 1))}</strong>
        </div>
        ${multiplierSection}
        ${nextThresholdSection}
      </div>
    </section>
  `;
}

function getVersatileDevelopmentButtonState(versatileDevelopment = {}, skillKey = "") {
  if (!versatileDevelopment?.active) return "";
  const state = versatileDevelopment.statesBySkill?.[skillKey];
  if (state?.willLoseBonusOnNextIncrease) return "transition";
  return state?.eligible ? "eligible" : "ineligible";
}

function formatSkillDevelopmentMultiplier({
  skill = {},
  characteristics = {},
  characteristicSettings = [],
  advancementSettings = {},
  multiplierChanges = {},
  signature = false
} = {}) {
  const effectiveSignature = Boolean(signature) && multiplierChanges?.signatureSkillsDisabled !== true;
  const breakdown = getSkillPointMultiplierBreakdown(
    skill.key,
    characteristics,
    advancementSettings,
    multiplierChanges,
    { signature: effectiveSignature }
  );
  const characteristicLabels = new Map(
    characteristicSettings.map(characteristic => [characteristic.key, characteristic.label || characteristic.key])
  );
  const displayParts = combineSkillMultiplierEffectParts(breakdown.parts);
  const parts = displayParts.map(part => {
    if (part.kind === "characteristic") {
      const label = characteristicLabels.get(part.characteristicKey) ?? part.characteristicKey;
      return `${label}: ${formatCompactDecimal(part.amount)}`;
    }
    if (part.kind === "effect") return `${part.label}: ${formatSkillMultiplierOperation(part.operation, part.amount)}`;
    return `${part.label}: ${formatCompactDecimal(part.amount)}`;
  });
  if (effectiveSignature) {
    const signatureMultiplier = advancementSettings?.mode === "fixed"
      ? FIXED_SIGNATURE_SKILL_MULTIPLIER
      : Number(advancementSettings?.signatureMultiplier) || 0;
    parts.push(`Коронный навык: ×${formatCompactDecimal(signatureMultiplier)}`);
  }
  return parts.join("\n");
}

function combineSkillMultiplierEffectParts(parts = []) {
  const combined = [];
  const additiveBySource = new Map();

  for (const part of parts) {
    const additive = part?.kind === "effect" && ["add", "subtract"].includes(part?.operation);
    const sourceUuid = String(part?.sourceUuid ?? "").trim();
    if (!additive || !sourceUuid) {
      combined.push(part);
      continue;
    }

    const signedAmount = part.operation === "subtract"
      ? -(Number(part.amount) || 0)
      : Number(part.amount) || 0;
    const existingIndex = additiveBySource.get(sourceUuid);
    if (existingIndex === undefined) {
      additiveBySource.set(sourceUuid, combined.length);
      combined.push({ ...part, operation: "add", amount: signedAmount });
      continue;
    }

    const existing = combined[existingIndex];
    combined[existingIndex] = {
      ...existing,
      amount: (Number(existing?.amount) || 0) + signedAmount
    };
  }

  return combined;
}

function calculateSkillDevelopmentGain({
  skill = {},
  characteristics = {},
  advancementSettings = {},
  multiplierChanges = {},
  signature = false
} = {}) {
  const effectiveSignature = Boolean(signature) && multiplierChanges?.signatureSkillsDisabled !== true;
  const baseMultiplier = calculateSkillPointMultiplier(
    skill.key,
    characteristics,
    advancementSettings,
    multiplierChanges,
    { signature: effectiveSignature }
  );
  if (!effectiveSignature) return baseMultiplier;

  const signatureMultiplier = advancementSettings?.mode === "fixed"
    ? FIXED_SIGNATURE_SKILL_MULTIPLIER
    : Number(advancementSettings?.signatureMultiplier) || 0;
  return baseMultiplier * signatureMultiplier;
}

function formatSkillMultiplierOperation(operation = "add", value = 0) {
  const formatted = formatCompactDecimal(value);
  if (operation === "multiply") return `×${formatted}`;
  if (operation === "subtract") return `−${formatCompactDecimal(Math.abs(Number(value) || 0))}`;
  if (operation === "override") return `=${formatted}`;
  if (operation === "upgrade") return `не менее ${formatted}`;
  if (operation === "downgrade") return `не более ${formatted}`;
  return `${Number(value) >= 0 ? "+" : "−"}${formatCompactDecimal(Math.abs(Number(value) || 0))}`;
}

function formatFixedDecimal(value, digits = 1) {
  const number = Number(value);
  const safe = Number.isFinite(number) ? number : 0;
  return safe.toFixed(digits).replace(".", ",");
}

function formatCompactDecimal(value, digits = 2) {
  const number = Number(value);
  const safe = Number.isFinite(number) ? number : 0;
  return safe.toFixed(digits).replace(".", ",").replace(/0+$/u, "").replace(/,$/u, "");
}

function renderAbilityRequirementTooltipRow(requirement) {
  const stateClass = requirement.met ? "met" : "unmet";
  let value;
  if (requirement.type === ABILITY_ACQUISITION_CONDITION_TYPES.race) {
    value = `${requirement.targetLabel}: сейчас ${requirement.currentLabel}`;
  } else if (requirement.type === ABILITY_ACQUISITION_CONDITION_TYPES.ability) {
    value = requirement.targetLabel;
  } else {
    value = `${requirement.targetLabel}: ${requirement.current} / ${requirement.required}`;
  }
  return `
    <div class="function-row fallout-maw-advancement-tooltip-requirement ${stateClass}">
      <span>${escapeHtml(requirement.label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function positionAbilityDescriptionTooltip(element, anchor, { layerElement = null } = {}) {
  if (!element || !anchor?.isConnected) return;
  const ownerDocument = element.ownerDocument ?? anchor.ownerDocument ?? globalThis.document;
  const view = ownerDocument?.defaultView ?? globalThis.window;
  const margin = 8;
  const gap = 12;
  const viewportWidth = view.innerWidth || ownerDocument?.documentElement?.clientWidth || 0;
  const viewportHeight = view.innerHeight || ownerDocument?.documentElement?.clientHeight || 0;
  syncTooltipLayerWithApplication(element, layerElement);
  const anchorRect = anchor.getBoundingClientRect();
  let tooltipRect = element.getBoundingClientRect();

  const leftCandidate = anchorRect.left - tooltipRect.width - gap;
  const rightCandidate = anchorRect.right + gap;
  const preferRight = element.classList.contains("fallout-maw-skill-cost-tooltip");
  let left = preferRight ? rightCandidate : leftCandidate;
  let direction = preferRight ? "right" : "left";
  if (preferRight && (left + tooltipRect.width) > (viewportWidth - margin)) {
    left = leftCandidate;
    direction = "left";
  } else if (!preferRight && left < margin) {
    left = rightCandidate;
    direction = "right";
  }
  if (left < margin || (left + tooltipRect.width) > (viewportWidth - margin)) {
    left = Math.max(margin, viewportWidth - tooltipRect.width - margin);
    direction = "clamped";
  }

  let top = anchorRect.top + ((anchorRect.height - tooltipRect.height) / 2);
  if (top < margin) top = margin;
  if ((top + tooltipRect.height) > (viewportHeight - margin)) {
    top = Math.max(margin, viewportHeight - tooltipRect.height - margin);
  }

  element.dataset.tooltipDirection = direction;
  element.style.left = `${Math.round(left)}px`;
  element.style.top = `${Math.round(top)}px`;
  element.style.setProperty("--fallout-maw-tooltip-max-height", `${Math.max(160, viewportHeight - (margin * 2))}px`);

  tooltipRect = element.getBoundingClientRect();
  if ((tooltipRect.top + tooltipRect.height) > (viewportHeight - margin)) {
    element.style.top = `${Math.round(Math.max(margin, viewportHeight - tooltipRect.height - margin))}px`;
  }
}

function syncTooltipLayerWithApplication(element, applicationElement) {
  if (!element || !applicationElement?.isConnected) return;
  element.style.zIndex = String(getOverlayBaseZIndex(applicationElement) + 2);
}
