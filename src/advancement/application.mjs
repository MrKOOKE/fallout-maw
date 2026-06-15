import {
  calculateSkillPointMultiplier,
  calculatePureSkillDevelopmentValue,
  calculateRemainingDevelopmentPoints,
  cloneActorDevelopment
} from "./index.mjs";
import { FALLOUT_MAW } from "../config/system-config.mjs";
import {
  getCharacteristicSettings,
  getCreatureOptions,
  getAbilityCatalog,
  getLevelSettings,
  getSkillAdvancementSettings,
  getSkillDevelopmentCostSettings,
  getSkillSettings
} from "../settings/accessors.mjs";
import { evaluateFormula } from "../formulas/index.mjs";
import {
  DEFAULT_RESEARCH_POINTS_PER_LEVEL_FORMULA,
  DEFAULT_SKILL_POINTS_PER_LEVEL_FORMULA
} from "../config/defaults.mjs";
import { actorHasAbility, completeAbilityResearch, findCatalogAbility, grantCatalogAbility } from "../abilities/purchase.mjs";
import { getAbilitySkillAdvancementBaseBonuses } from "../abilities/evaluation.mjs";
import { formatResearchValue } from "../research/storage.mjs";
import { ABILITY_ACQUISITION_CONDITION_TYPES, LOCKED_FEATURES_CATEGORY_ID, prepareAbilityItemData } from "../settings/abilities.mjs";
import { getLevelThreshold } from "../settings/levels.mjs";
import {
  getNextSkillDevelopmentCostThreshold,
  getSkillDevelopmentCostForValue
} from "../settings/skill-development-costs.mjs";
import { TEMPLATES } from "../constants.mjs";
import { localize } from "../utils/i18n.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { escapeHtml } from "../utils/dom.mjs";
import { FalloutMaWFormApplicationV2 } from "../apps/base-form-application-v2.mjs";

const { DialogV2 } = foundry.applications.api;
const TextEditor = foundry.applications.ux.TextEditor.implementation;
const ADVANCEMENT_COMMIT_FLAG = "advancementCommit";

export class AdvancementApplication extends FalloutMaWFormApplicationV2 {
  #activeEffectHooks = [];
  #actorUpdateHookId = null;
  #abilityTooltipAnchor = null;
  #abilityTooltipDocumentAbortController = null;
  #abilityTooltipElement = null;
  #abilityTooltipPinned = false;
  #abilityTooltipTimer = null;
  #draft = null;
  #experienceSyncTimer = null;
  #expandedAbilityCategories = new Set();
  #floor = null;
  #gmMode = false;
  #isClosing = false;
  #page = "development";
  #researchPointSessionSpent = 0;
  #repeatState = null;
  #selectedAbilitySourceId = "";
  #skillCostTooltipAnchor = null;
  #skillCostTooltipElement = null;
  #skillCostTooltipTimer = null;
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
      grantAbility: this.#onGrantAbility,
      increaseSkill: this.#onIncreaseSkill,
      nextPage: this.#onNextPage,
      previousPage: this.#onPreviousPage,
      selectAbility: this.#onSelectAbility,
      spendAbilityResearch: this.#onSpendAbilityResearch,
      startAbilityResearch: this.#onStartAbilityResearch,
      levelUp: this.#onLevelUp,
      purchaseTraitAbility: this.#onPurchaseTraitAbility,
      resetDevelopment: this.#onResetDevelopment,
      toggleAbilityCategory: this.#onToggleAbilityCategory,
      toggleGMMode: this.#onToggleGMMode,
      toggleSignatureSkill: this.#onToggleSignatureSkill
    }
  };

  static PARTS = {
    form: {
      template: TEMPLATES.advancement.dialog
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

    const characteristicSettings = getCharacteristicSettings();
    const skillSettings = getSkillSettings();
    const skillAdvancementSettings = getSkillAdvancementSettings(characteristicSettings, skillSettings);
    const skillAdvancementBaseBonuses = getAbilitySkillAdvancementBaseBonuses(this.actor, skillSettings);
    const skillDevelopmentCostSettings = getSkillDevelopmentCostSettings();
    const skillDevelopmentLimit = Math.max(0, toInteger(skillAdvancementSettings.developmentLimit));
    const levelSettings = getLevelSettings();
    const creatureOptions = getCreatureOptions();
    const race = creatureOptions.races.find(entry => entry.id === this.actor.system?.creature?.raceId) ?? null;
    const remaining = calculateRemainingDevelopmentPoints(this.#draft.development);
    const maxLevel = levelSettings[levelSettings.length - 1]?.level ?? 100;
    const liveCharacteristics = this.actor.system?.characteristics ?? this.#draft.characteristics;
    const cleanCharacteristics = this.#getCleanCharacteristics(characteristicSettings);
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
    const canLevelUp = (this.#draft.level < maxLevel) && (this.#gmMode || (currentExperience >= nextThreshold));
    const abilityRequirementContext = this.#getAbilityRequirementContext({
      characteristicSettings,
      skillSettings,
      skillAdvancementSettings,
      characteristics: cleanCharacteristics,
      baseBonuses: skillAdvancementBaseBonuses
    });
    const abilityCategories = await this.#prepareAbilityCategories(remaining, skillSettings, abilityRequirementContext);
    const selectedAbility = this.#prepareSelectedAbility(abilityCategories);
    const pointDisplays = this.#preparePointDisplays(remaining);

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
      skillPointsPerLevel: evaluateProgressionFormula(
        this.actor.system?.progression?.skillPointsPerLevel,
        liveCharacteristics,
        characteristicSettings,
        DEFAULT_SKILL_POINTS_PER_LEVEL_FORMULA
      ),
      researchPointsPerLevel: evaluateProgressionFormula(
        this.actor.system?.progression?.researchPointsPerLevel,
        liveCharacteristics,
        characteristicSettings,
        DEFAULT_RESEARCH_POINTS_PER_LEVEL_FORMULA
      ),
      characteristicPointsDisplay: pointDisplays.characteristics,
      skillPointsDisplay: pointDisplays.skills,
      signatureSkillPointsDisplay: pointDisplays.signatureSkills,
      traitPointsDisplay: pointDisplays.traits,
      researchPointsDisplay: pointDisplays.researches,
      page: this.#page,
      isDevelopmentPage: this.#page === "development",
      isAbilitiesPage: this.#page === "abilities",
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
        const canUnsetSignature = currentSkill.signature && !floorSkill.signature;
        const pureValue = this.#getPureSkillValue(skill.key, {
          characteristicSettings,
          skillSettings,
          skillAdvancementSettings,
          characteristics: cleanCharacteristics,
          baseBonuses: skillAdvancementBaseBonuses
        });
        const cost = getSkillDevelopmentCostForValue(pureValue, skillDevelopmentCostSettings);
        const nextThreshold = getNextSkillDevelopmentCostThreshold(pureValue, skillDevelopmentCostSettings);
        const totalValue = toInteger(liveSkills?.[skill.key]?.value);
        const signature = Boolean(currentSkill.signature);
        const skillGain = calculateSkillDevelopmentGain({
          skill,
          characteristics: cleanCharacteristics,
          advancementSettings: skillAdvancementSettings,
          baseBonuses: skillAdvancementBaseBonuses,
          signature
        });
        const multiplierLabel = formatSkillDevelopmentMultiplier({
          skill,
          characteristics: cleanCharacteristics,
          characteristicSettings,
          advancementSettings: skillAdvancementSettings,
          baseBonuses: skillAdvancementBaseBonuses,
          signature
        });
        return {
          ...skill,
          value: totalValue,
          signature,
          canIncrease: this.#gmMode || (remaining.skills >= cost && totalValue < skillDevelopmentLimit),
          canDecrease: this.#gmMode ? totalValue > 0 : toInteger(currentSkill.points) > toInteger(floorSkill.points),
          canToggleSignature: Boolean(currentSkill.signature)
            ? (this.#gmMode || canUnsetSignature)
            : (this.#gmMode || remaining.signatureSkills > 0),
          cost,
          pureValue,
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
      }),
      abilityCategories,
      selectedAbility
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
    this.#activateAbilitySearch();
    this.#activateAbilityDescriptionTooltips();
    this.#activateSkillCostTooltips();
  }

  #syncPageClass() {
    this.element?.classList.toggle("fallout-maw-advancement-page-abilities", this.#page === "abilities");
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
    this.#abilityTooltipDocumentAbortController = null;
    this.#stopRepeat();
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

    const currentValue = Boolean(this.#draft.development.skills[key]?.signature);
    if (this.#gmMode) {
      this.#draft.development.skills[key].signature = !currentValue;
      await this.#applyDraftToActor();
      return this.forceRender();
    }

    if (currentValue) {
      if (this.#floor.development.skills[key]?.signature) return;
      this.#draft.development.skills[key].signature = false;
      this.#draft.development.points.signatureSkills = Math.max(0, toInteger(this.#draft.development.points.signatureSkills)) + 1;
      await this.#applyDraftToActor();
      return this.forceRender();
    }

    const available = Math.max(0, toInteger(this.#draft.development.points.signatureSkills));
    if (available < 1) return;

    this.#draft.development.skills[key].signature = true;
    this.#draft.development.points.signatureSkills = available - 1;
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
    if (this.#gmMode) {
      await this.#applyDraftToActor();
      return this.forceRender();
    }

    this.#draft.development.points.skills += evaluateProgressionFormula(
      this.actor.system?.progression?.skillPointsPerLevel,
      this.actor.system?.characteristics,
      getCharacteristicSettings(),
      DEFAULT_SKILL_POINTS_PER_LEVEL_FORMULA
    );
    this.#draft.development.points.researches += evaluateProgressionFormula(
      this.actor.system?.progression?.researchPointsPerLevel,
      this.actor.system?.characteristics,
      getCharacteristicSettings(),
      DEFAULT_RESEARCH_POINTS_PER_LEVEL_FORMULA
    );
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
    this.#researchPointSessionSpent = 0;
    const abilityItemIds = this.actor.items
      .filter(item => item.type === "ability")
      .map(item => item.id);
    if (abilityItemIds.length) await this.actor.deleteEmbeddedDocuments("Item", abilityItemIds);
    await this.#applyDraftToActor({
      "system.proficiencies": foundry.utils.deepClone(resetData.proficiencies)
    });
    await this.actor.setFlag(FALLOUT_MAW.id, ADVANCEMENT_COMMIT_FLAG, {
      level: this.#draft.level,
      characteristics: foundry.utils.deepClone(this.#draft.characteristics),
      development: foundry.utils.deepClone(this.#draft.development)
    });
    this.#snapshot = foundry.utils.deepClone(this.#draft);
    this.#floor = foundry.utils.deepClone(this.#draft);
    this.#researchPointSessionSpent = 0;
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
    if (!root || root.dataset.abilityDescriptionTooltipsBound === "true") return;
    root.dataset.abilityDescriptionTooltipsBound = "true";
    root.addEventListener("pointerover", event => this.#onAbilityDescriptionPointerOver(event));
    root.addEventListener("pointerout", event => this.#onAbilityDescriptionPointerOut(event));
    root.addEventListener("auxclick", event => this.#onAbilityDescriptionAuxClick(event));

    this.#abilityTooltipDocumentAbortController?.abort();
    this.#abilityTooltipDocumentAbortController = new AbortController();
    document.addEventListener("pointerdown", event => this.#onAbilityDescriptionDocumentPointerDown(event), {
      capture: true,
      signal: this.#abilityTooltipDocumentAbortController.signal
    });
  }

  #onAbilityDescriptionPointerOver(event) {
    if (this.#abilityTooltipPinned) return;
    const anchor = event.target?.closest?.("[data-ability-description-tooltip]");
    if (!anchor || anchor.contains(event.relatedTarget)) return;
    const html = String(anchor.dataset.abilityDescriptionTooltip ?? "").trim();
    if (!html) return;

    this.#clearAbilityDescriptionTooltip();
    this.#abilityTooltipAnchor = anchor;
    this.#abilityTooltipTimer = window.setTimeout(() => this.#showAbilityDescriptionTooltip(anchor, html), 500);
  }

  #onAbilityDescriptionPointerOut(event) {
    const anchor = event.target?.closest?.("[data-ability-description-tooltip]");
    if (!anchor || anchor.contains(event.relatedTarget)) return;
    if (this.#abilityTooltipPinned) return;
    if (this.#abilityTooltipElement?.contains(event.relatedTarget)) return;
    this.#clearAbilityDescriptionTooltip();
  }

  #onAbilityDescriptionAuxClick(event) {
    if (event.button !== 1) return;
    const anchor = event.target?.closest?.("[data-ability-description-tooltip]");
    if (!anchor) return;

    event.preventDefault();
    event.stopPropagation();
    const html = String(anchor.dataset.abilityDescriptionTooltip ?? "").trim();
    if (!html) return;

    if (this.#abilityTooltipPinned && this.#abilityTooltipAnchor === anchor) {
      this.#clearAbilityDescriptionTooltip();
      return;
    }

    this.#clearAbilityDescriptionTooltip();
    this.#abilityTooltipAnchor = anchor;
    this.#showAbilityDescriptionTooltip(anchor, html, { pinned: true });
  }

  #onAbilityDescriptionDocumentPointerDown(event) {
    if (!this.#abilityTooltipElement) return;
    if (event.target?.closest?.("[data-ability-description-tooltip]")) return;
    if (this.#abilityTooltipElement.contains(event.target)) return;
    this.#clearAbilityDescriptionTooltip();
  }

  #showAbilityDescriptionTooltip(anchor, html, { pinned = false } = {}) {
    if (this.#abilityTooltipTimer) {
      window.clearTimeout(this.#abilityTooltipTimer);
      this.#abilityTooltipTimer = null;
    }
    if (!anchor?.isConnected || this.#abilityTooltipAnchor !== anchor) return;

    const tooltip = document.createElement("aside");
    tooltip.className = "fallout-maw-inventory-tooltip fallout-maw-ability-description-tooltip";
    tooltip.classList.toggle("pinned", pinned);
    tooltip.style.pointerEvents = "auto";
    tooltip.innerHTML = `<div class="content">${html}</div>`;
    tooltip.addEventListener("pointerleave", event => {
      if (this.#abilityTooltipAnchor?.contains(event.relatedTarget)) return;
      this.#clearAbilityDescriptionTooltip();
    });
    document.body.append(tooltip);
    this.#abilityTooltipElement = tooltip;
    this.#abilityTooltipPinned = pinned;
    positionAbilityDescriptionTooltip(tooltip, anchor);
    requestAnimationFrame(() => positionAbilityDescriptionTooltip(tooltip, anchor));
  }

  #clearAbilityDescriptionTooltip() {
    if (this.#abilityTooltipTimer) {
      window.clearTimeout(this.#abilityTooltipTimer);
      this.#abilityTooltipTimer = null;
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
    const html = String(anchor.dataset.skillCostTooltip ?? "").trim();
    if (!html) return;

    this.#clearSkillCostTooltip();
    this.#skillCostTooltipAnchor = anchor;
    this.#skillCostTooltipTimer = window.setTimeout(() => this.#showSkillCostTooltip(anchor, html), 250);
  }

  #onSkillCostPointerOut(event) {
    const anchor = event.target?.closest?.("[data-skill-cost-tooltip]");
    if (!anchor || anchor.contains(event.relatedTarget)) return;
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
    positionAbilityDescriptionTooltip(tooltip, anchor);
    requestAnimationFrame(() => positionAbilityDescriptionTooltip(tooltip, anchor));
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

  #syncDraftFromForm() {
    return undefined;
  }

  static #onToggleGMMode(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return undefined;
    this.#gmMode = !this.#gmMode;
    this.#stopRepeat();
    return this.forceRender();
  }

  async #changeCharacteristic(key, delta) {
    await this.#ensureDraft();
    this.#syncDraftFromForm();

    if (this.#gmMode) {
      if (delta < 0 && toInteger(this.actor.system?.characteristics?.[key]) <= 0) return false;
      this.#draft.characteristics[key] = toInteger(this.#draft.characteristics[key]) + delta;
      await this.#applyDraftToActor();
      return true;
    }

    if (delta > 0) {
      const available = Math.max(0, toInteger(this.#draft.development.points.characteristics));
      if (available < 1) return false;

      this.#draft.development.characteristics[key] = toInteger(this.#draft.development.characteristics[key]) + 1;
      this.#draft.development.points.characteristics = available - 1;
      await this.#applyDraftToActor();
      return true;
    }

    const currentPoints = toInteger(this.#draft.development.characteristics[key]);
    const minimumPoints = toInteger(this.#floor.development.characteristics[key]);
    if (currentPoints <= minimumPoints) return false;

    this.#draft.development.characteristics[key] = currentPoints - 1;
    this.#draft.development.points.characteristics = Math.max(0, toInteger(this.#draft.development.points.characteristics)) + 1;
    await this.#applyDraftToActor();
    return true;
  }

  async #changeSkill(key, delta) {
    await this.#ensureDraft();
    this.#syncDraftFromForm();

    if (this.#gmMode) {
      if (delta < 0 && toInteger(this.actor.system?.skills?.[key]?.value) <= 0) return false;
      const sourceBonus = toInteger(
        this.actor.system?._source?.skills?.[key]?.bonus
        ?? this.actor.system?.skills?.[key]?.bonus
      );
      await this.actor.update({ [`system.skills.${key}.bonus`]: sourceBonus + delta });
      return true;
    }

    if (delta > 0) {
      const available = Math.max(0, toInteger(this.#draft.development.points.skills));
      const cost = this.#getSkillUpgradeCost(key);
      if (available < cost) return false;
      if (toInteger(this.actor.system?.skills?.[key]?.value) >= this.#getSkillDevelopmentLimit()) return false;

      this.#draft.development.skills[key].points = toInteger(this.#draft.development.skills[key]?.points) + 1;
      this.#draft.development.points.skills = available - cost;
      await this.#applyDraftToActor();
      return true;
    }

    const currentPoints = toInteger(this.#draft.development.skills[key]?.points);
    const minimumPoints = toInteger(this.#floor.development.skills[key]?.points);
    if (currentPoints <= minimumPoints) return false;

    this.#draft.development.skills[key].points = currentPoints - 1;
    this.#draft.development.points.skills = Math.max(0, toInteger(this.#draft.development.points.skills)) + this.#getSkillRefundCost(key, currentPoints - 1);
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

  static #onToggleAbilityCategory(event, target) {
    event.preventDefault();
    const categoryId = target.dataset.categoryId ?? "";
    if (!categoryId) return undefined;
    if (this.#expandedAbilityCategories.has(categoryId)) this.#expandedAbilityCategories.delete(categoryId);
    else this.#expandedAbilityCategories.add(categoryId);
    return this.forceRender();
  }

  static #onSelectAbility(event, target) {
    event.preventDefault();
    const sourceId = target.dataset.abilitySourceId ?? "";
    if (!sourceId) return undefined;
    this.#selectedAbilitySourceId = sourceId;
    return this.forceRender();
  }

  static async #onSpendAbilityResearch(event, target) {
    event.preventDefault();
    await this.#ensureDraft();
    this.#syncDraftFromForm();

    const sourceId = target.closest("[data-ability-source-id]")?.dataset.abilitySourceId ?? "";
    const entry = findCatalogAbility(sourceId);
    if (!entry || actorHasAbility(this.actor, sourceId)) return this.forceRender();
    if (!abilityAcquisitionRequirementsMet(this.actor, entry.ability, this.#getAbilityRequirementContext())) return this.forceRender();
    if (entry.ability.system?.acquisition?.onlyManual) return this.forceRender();
    const research = this.#getAbilityResearch(sourceId);
    if (!research) return this.forceRender();

    const targetValue = Math.max(1, Number(research.target) || toInteger(entry.ability.system?.cost) || 1);
    const currentProgress = Math.max(0, Number(research.progress) || 0);
    if (currentProgress >= targetValue) {
      await completeAbilityResearch(this.actor, research.id);
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
    });

    if (nextProgress >= targetValue) await completeAbilityResearch(this.actor, research.id);
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
    if (!abilityAcquisitionRequirementsMet(this.actor, entry.ability, this.#getAbilityRequirementContext())) return this.forceRender();
    if (this.#getAbilityResearch(sourceId)) return this.forceRender();

    await this.actor.createResearch(this.#createAbilityResearchData(entry));
    return this.forceRender();
  }

  static async #onPurchaseTraitAbility(event, target) {
    event.preventDefault();
    await this.#ensureDraft();
    this.#syncDraftFromForm();

    const sourceId = target.closest("[data-ability-source-id]")?.dataset.abilitySourceId ?? "";
    const entry = findCatalogAbility(sourceId);
    if (!entry || entry.category?.id !== LOCKED_FEATURES_CATEGORY_ID || actorHasAbility(this.actor, sourceId)) return this.forceRender();
    if (!abilityAcquisitionRequirementsMet(this.actor, entry.ability, this.#getAbilityRequirementContext())) return this.forceRender();

    const available = Math.max(0, toInteger(this.#draft.development.points.traits));
    if (available < 1) return this.forceRender();

    this.#draft.development.traits ??= {};
    this.#draft.development.traits[sourceId] = true;
    this.#draft.development.points.traits = available - 1;
    await this.#applyDraftToActor();
    await grantCatalogAbility(this.actor, sourceId);
    this.#syncDraftFromActor();
    return this.forceRender();
  }

  static async #onGrantAbility(event, target) {
    event.preventDefault();
    if (!game.user?.isGM || !this.#gmMode) return this.forceRender();

    const sourceId = target.closest("[data-ability-source-id]")?.dataset.abilitySourceId ?? "";
    const entry = findCatalogAbility(sourceId);
    if (!entry || actorHasAbility(this.actor, sourceId)) return this.forceRender();

    const granted = await grantCatalogAbility(this.actor, sourceId);
    if (granted) {
      const research = this.#getAbilityResearch(sourceId);
      if (research) await this.actor.deleteResearch(research.id);
      this.#selectedAbilitySourceId = "";
      this.#syncDraftFromActor();
    }
    return this.forceRender();
  }

  #getSkillDevelopmentLimit() {
    const characteristicSettings = getCharacteristicSettings();
    const skillSettings = getSkillSettings();
    return Math.max(0, toInteger(getSkillAdvancementSettings(characteristicSettings, skillSettings).developmentLimit));
  }

  #preparePointDisplays(remaining = {}) {
    return {
      characteristics: this.#formatSessionPointDisplay(remaining.characteristics, this.#getCharacteristicSessionSpent()),
      signatureSkills: this.#formatSessionPointDisplay(remaining.signatureSkills, this.#getSignatureSkillSessionSpent()),
      skills: this.#formatSessionPointDisplay(remaining.skills, this.#getSkillSessionSpent()),
      traits: this.#formatSessionPointDisplay(remaining.traits, this.#getTraitSessionSpent()),
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
    return Object.entries(this.#draft?.development?.skills ?? {}).reduce((total, [key, value]) => {
      const floorValue = toInteger(this.#floor?.development?.skills?.[key]?.points);
      const currentValue = toInteger(value?.points);
      if (currentValue <= floorValue) return total;

      const development = foundry.utils.deepClone(this.#draft.development);
      let spent = 0;
      for (let points = floorValue; points < currentValue; points += 1) {
        development.skills[key] = {
          ...(development.skills?.[key] ?? {}),
          points
        };
        spent += this.#getSkillUpgradeCost(key, development);
      }
      return total + spent;
    }, 0);
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
    return Object.fromEntries(
      characteristicSettings.map(characteristic => [
        characteristic.key,
        toInteger(this.#draft?.characteristics?.[characteristic.key])
          + toInteger(development?.characteristics?.[characteristic.key])
      ])
    );
  }

  #getAbilityRequirementContext({
    characteristicSettings = getCharacteristicSettings(),
    skillSettings = getSkillSettings(),
    skillAdvancementSettings = getSkillAdvancementSettings(characteristicSettings, skillSettings),
    development = this.#draft?.development ?? this.actor.system?.development ?? {},
    characteristics = this.#getCleanCharacteristics(characteristicSettings, development),
    baseBonuses = getAbilitySkillAdvancementBaseBonuses(this.actor, skillSettings)
  } = {}) {
    const skills = Object.fromEntries(
      skillSettings.map(skill => [
        skill.key,
        this.#getPureSkillValue(skill.key, {
          characteristicSettings,
          skillSettings,
          skillAdvancementSettings,
          development,
          characteristics,
          baseBonuses
        })
      ])
    );
    return { characteristics, skills };
  }

  #getPureSkillValue(key, {
    characteristicSettings = getCharacteristicSettings(),
    skillSettings = getSkillSettings(),
    skillAdvancementSettings = getSkillAdvancementSettings(characteristicSettings, skillSettings),
    development = this.#draft?.development ?? this.actor.system?.development ?? {},
    characteristics = this.#getCleanCharacteristics(characteristicSettings, development),
    baseBonuses = getAbilitySkillAdvancementBaseBonuses(this.actor, skillSettings)
  } = {}) {
    return calculatePureSkillDevelopmentValue(
      key,
      skillSettings,
      characteristicSettings,
      characteristics,
      skillAdvancementSettings,
      development,
      baseBonuses
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

  async #prepareAbilityCategories(remaining = {}, skillSettings = [], requirementContext = {}) {
    const catalog = getAbilityCatalog();
    return Promise.all((catalog.categories ?? []).map(async category => {
      const isFeatures = category.id === LOCKED_FEATURES_CATEGORY_ID;
      const traitTotal = isFeatures ? this.#getTraitSessionTotal(remaining.traits) : 0;
      const traitRemaining = Math.max(0, toInteger(remaining.traits));
      const abilities = await Promise.all((category.abilities ?? [])
        .filter(ability => ability?.visible !== false)
        .filter(ability => !actorHasAbility(this.actor, String(ability?.id ?? "")))
        .map(ability => this.#prepareAbilityEntry(category, ability, remaining, skillSettings, requirementContext)));
      return {
        ...category,
        displayName: isFeatures
          ? (this.#gmMode ? "Особенности" : `Особенности (Доступно ${traitRemaining}/${traitTotal})`)
          : category.name,
        traitAvailabilityClass: isFeatures ? (this.#gmMode || traitRemaining > 0 ? "trait-available" : "trait-empty") : "",
        expanded: this.#expandedAbilityCategories.has(String(category.id ?? "")),
        abilities: abilities.sort(compareAbilityAvailability)
      };
    }));
  }

  #prepareSelectedAbility(categories = []) {
    if (!this.#selectedAbilitySourceId) return null;
    const selected = categories.flatMap(category => category.abilities ?? []).find(ability => ability.sourceId === this.#selectedAbilitySourceId) ?? null;
    if (!selected) {
      this.#selectedAbilitySourceId = "";
      return null;
    }
    return selected;
  }

  #getTraitSessionTotal(traitRemaining = 0) {
    return Math.max(0, toInteger(traitRemaining)) + this.#getTraitSessionSpent();
  }

  async #prepareAbilityEntry(category, ability, remaining = {}, skillSettings = [], requirementContext = {}) {
    const sourceId = String(ability?.id ?? "");
    const isFeature = category.id === LOCKED_FEATURES_CATEGORY_ID;
    const cost = Math.max(0, toInteger(ability?.system?.cost));
    const research = this.#getAbilityResearch(sourceId);
    const target = Math.max(1, Number(research?.target) || cost || 1);
    const progress = research ? Math.min(target, Math.max(0, Number(research.progress) || 0)) : 0;
    const remainingCost = Math.max(0, target - progress);
    const owned = actorHasAbility(this.actor, sourceId);
    const onlyFree = Boolean(ability?.system?.acquisition?.onlyFree);
    const onlyManual = Boolean(ability?.system?.acquisition?.onlyManual);
    const completed = Boolean(research) && progress >= target;
    const skillLabel = skillSettings.find(skill => skill.key === ability?.system?.acquisition?.skillKey)?.label ?? skillSettings[0]?.label ?? "";
    const requirementRows = getAbilityAcquisitionRequirementRows(this.actor, ability, requirementContext);
    const requirementsMet = requirementRows.every(requirement => requirement.met);
    const acquisitionAvailable = this.#gmMode || requirementsMet;
    const requirementLabel = getAbilityAcquisitionRequirementLabel(requirementRows);
    const descriptionTooltipHTML = await renderAbilityDescriptionTooltipHTML(ability, {
      actor: this.actor,
      requirementRows
    });
    return {
      ...ability,
      sourceId,
      categoryId: category.id,
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
      descriptionTooltipHTML,
      canPurchaseTrait: isFeature && !owned && acquisitionAvailable && toInteger(remaining.traits) > 0,
      canSpendFree: !isFeature && !owned && acquisitionAvailable && Boolean(research) && !onlyManual && (completed || (remainingCost > 0 && toInteger(remaining.researches) > 0)),
      canSelectRewardChanges: completed,
      freeSpendAmount: Math.min(toInteger(remaining.researches), remainingCost),
      canStartManual: !isFeature && !owned && acquisitionAvailable && !research,
      researchId: research?.id ?? "",
      researchActive: Boolean(research),
      selected: sourceId === this.#selectedAbilitySourceId,
      statusLabel: owned ? "Изучено" : !acquisitionAvailable ? "Недоступно" : research ? "Исследуется" : "Не изучено",
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
    const itemData = prepareAbilityItemData(ability, { categoryId: entry.category.id });
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
    if (!(target instanceof HTMLElement) || target.hasAttribute("disabled") || target.getAttribute("aria-disabled") === "true") return;

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
    if (!(target instanceof HTMLElement) || target.hasAttribute("disabled") || target.getAttribute("aria-disabled") === "true") return;

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
    if (this.#isClosing) return;
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
    if (this.#isClosing) return;
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
    this.#researchPointSessionSpent = 0;
    if (notify) ui.notifications.info(localize("FALLOUTMAW.Messages.AdvancementSaved"));
    return true;
  }

  async #applyDraftToActor(updateData = {}) {
    await this.actor.update({
      "system.attributes.level": this.#draft.level,
      "system.characteristics": foundry.utils.deepClone(this.#draft.characteristics),
      "system.development": foundry.utils.deepClone(this.#draft.development),
      ...updateData
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

function abilityAcquisitionRequirementsMet(actor, ability = {}, context = {}) {
  return getAbilityAcquisitionRequirementRows(actor, ability, context).every(requirement => requirement.met);
}

function getAbilityAcquisitionRequirementRows(actor, ability = {}, context = {}) {
  const rows = [];
  const races = getCreatureOptions().races ?? [];
  const characteristics = getCharacteristicSettings();
  const skills = getSkillSettings();
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
    }
  }
  return rows;
}

function getAbilityAcquisitionRequirementLabel(requirementRows = []) {
  return requirementRows.map(requirement => requirement.summary).join("; ");
}

function compareAbilityAvailability(left, right) {
  if (left?.acquisitionAvailable === right?.acquisitionAvailable) return 0;
  return left?.acquisitionAvailable ? -1 : 1;
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
        <div class="function-row">
          <span>Множитель</span>
          <strong>${escapeHtml(multiplierLabel)}</strong>
        </div>
        ${nextThresholdSection}
      </div>
    </section>
  `;
}

function formatSkillDevelopmentMultiplier({
  skill = {},
  characteristics = {},
  characteristicSettings = [],
  advancementSettings = {},
  baseBonuses = {},
  signature = false
} = {}) {
  const entry = advancementSettings?.entries?.[skill.key] ?? {};
  const base = (Number(entry.base) || 0) + (Number(baseBonuses?.[skill.key]) || 0);
  const parts = [`База: ${formatCompactDecimal(base)}`];

  for (const [characteristicKey, coefficient] of Object.entries(entry.characteristics ?? {})) {
    const value = (Number(characteristics?.[characteristicKey]) || 0) * (Number(coefficient) || 0);
    if (!value) continue;
    const label = characteristicSettings.find(characteristic => characteristic.key === characteristicKey)?.label ?? characteristicKey;
    parts.push(`${label}: ${formatCompactDecimal(value)}`);
  }

  if (!signature) return `(${parts.join(", ")})`;

  const signatureMultiplier = Number(advancementSettings?.signatureMultiplier) || 0;
  return `(${parts.join(", ")})*${formatCompactDecimal(signatureMultiplier)}`;
}

function calculateSkillDevelopmentGain({
  skill = {},
  characteristics = {},
  advancementSettings = {},
  baseBonuses = {},
  signature = false
} = {}) {
  const baseMultiplier = calculateSkillPointMultiplier(skill.key, characteristics, advancementSettings, baseBonuses);
  if (!signature) return baseMultiplier;

  const signatureMultiplier = Number(advancementSettings?.signatureMultiplier) || 0;
  return baseMultiplier * signatureMultiplier;
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
  const value = requirement.type === ABILITY_ACQUISITION_CONDITION_TYPES.race
    ? `${requirement.currentLabel} / ${requirement.targetLabel}`
    : `${requirement.current} / ${requirement.required}`;
  return `
    <div class="function-row fallout-maw-advancement-tooltip-requirement ${stateClass}">
      <span>${escapeHtml(`${requirement.label}: ${requirement.targetLabel}`)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function positionAbilityDescriptionTooltip(element, anchor) {
  if (!element || !anchor?.isConnected) return;
  const margin = 8;
  const gap = 12;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const anchorRect = anchor.getBoundingClientRect();
  let tooltipRect = element.getBoundingClientRect();

  let left = anchorRect.left - tooltipRect.width - gap;
  let direction = "left";
  if (left < margin) {
    left = anchorRect.right + gap;
    direction = "right";
  }
  if ((left + tooltipRect.width) > (viewportWidth - margin)) {
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
