import {
  calculateRemainingDevelopmentPoints,
  calculateSpentCharacteristicPoints,
  calculateSpentSignatureSkillPoints,
  calculateSpentSkillPoints,
  calculateSkillDevelopmentBonuses,
  cloneActorDevelopment
} from "./index.mjs";
import { evaluateSkillFormulas } from "../formulas/index.mjs";
import {
  getCharacteristicSettings,
  getLevelSettings,
  getSkillAdvancementSettings,
  getSkillSettings
} from "../settings/accessors.mjs";
import { getLevelThreshold } from "../settings/levels.mjs";
import { TEMPLATES } from "../constants.mjs";
import { localize } from "../utils/i18n.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { FalloutMaWFormApplicationV2 } from "../apps/base-form-application-v2.mjs";

const { DialogV2 } = foundry.applications.api;

export class AdvancementApplication extends FalloutMaWFormApplicationV2 {
  #draft = null;
  #floor = null;
  #snapshot = null;

  constructor(actor, options = {}) {
    super(options);
    this.actor = actor;
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-advancement",
    classes: ["fallout-maw", "fallout-maw-config-form", "fallout-maw-advancement-app"],
    position: {
      width: 820,
      height: 860
    },
    window: {
      resizable: true
    },
    actions: {
      decreaseCharacteristic: this.#onDecreaseCharacteristic,
      increaseCharacteristic: this.#onIncreaseCharacteristic,
      decreaseSkill: this.#onDecreaseSkill,
      increaseSkill: this.#onIncreaseSkill,
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
    return localize("FALLOUTMAW.Advancement.Title");
  }

  async _prepareContext(options) {
    await this.#ensureDraft();

    const characteristicSettings = getCharacteristicSettings();
    const skillSettings = getSkillSettings();
    const skillAdvancementSettings = getSkillAdvancementSettings(characteristicSettings, skillSettings);
    const levelSettings = getLevelSettings();
    const remaining = calculateRemainingDevelopmentPoints(this.#draft.development);
    const spentCharacteristicPoints = calculateSpentCharacteristicPoints(this.#draft.development);
    const spentSkillPoints = calculateSpentSkillPoints(this.#draft.development);
    const spentSignatureSkillPoints = calculateSpentSignatureSkillPoints(this.#draft.development);
    const skillBases = evaluateSkillFormulas(skillSettings, characteristicSettings, this.#draft.characteristics);
    const skillBonuses = calculateSkillDevelopmentBonuses(
      skillSettings,
      this.#draft.characteristics,
      skillAdvancementSettings,
      this.#draft.development
    );
    const maxLevel = levelSettings[levelSettings.length - 1]?.level ?? 100;
    const currentThreshold = getLevelThreshold(levelSettings, Math.max(0, this.#draft.level - 1));
    const nextThreshold = this.#draft.level >= maxLevel
      ? currentThreshold
      : getLevelThreshold(levelSettings, this.#draft.level);
    const currentExperience = Math.max(0, toInteger(this.#draft.development.experience));
    const experienceRange = Math.max(1, nextThreshold - currentThreshold);
    const experiencePercent = this.#draft.level >= maxLevel
      ? 100
      : Math.max(0, Math.min(100, ((currentExperience - currentThreshold) / experienceRange) * 100));
    const canLevelUp = (this.#draft.level < maxLevel) && (currentExperience >= nextThreshold);

    return {
      ...(await super._prepareContext(options)),
      actor: this.actor,
      level: this.#draft.level,
      experience: currentExperience,
      canLevelUp,
      experienceBarStyle: `width: ${experiencePercent.toFixed(2)}%;`,
      experienceCurrent: currentExperience,
      experienceFloor: currentThreshold,
      experienceNext: nextThreshold,
      characteristicPointsDisplay: `${spentCharacteristicPoints} / ${Math.max(spentCharacteristicPoints, toInteger(this.#draft.development.points.characteristics))}`,
      skillPointsDisplay: `${spentSkillPoints} / ${Math.max(spentSkillPoints, toInteger(this.#draft.development.points.skills))}`,
      signatureSkillPointsDisplay: `${spentSignatureSkillPoints} / ${Math.max(spentSignatureSkillPoints, toInteger(this.#draft.development.points.signatureSkills))}`,
      characteristics: characteristicSettings.map(characteristic => {
        const floorPoints = toInteger(this.#floor.development.characteristics?.[characteristic.key]);
        const currentPoints = toInteger(this.#draft.development.characteristics?.[characteristic.key]);
        return {
          ...characteristic,
          value: toInteger(this.#draft.characteristics?.[characteristic.key]),
          canIncrease: remaining.characteristics > 0,
          canDecrease: currentPoints > floorPoints
        };
      }),
      skills: skillSettings.map(skill => {
        const floorSkill = this.#floor.development.skills?.[skill.key] ?? {};
        const currentSkill = this.#draft.development.skills?.[skill.key] ?? {};
        const value = toInteger(skillBases?.[skill.key]) + toInteger(skillBonuses?.[skill.key]);
        const canUnsetSignature = currentSkill.signature && !floorSkill.signature;
        return {
          ...skill,
          value,
          signature: Boolean(currentSkill.signature),
          canIncrease: remaining.skills > 0,
          canDecrease: toInteger(currentSkill.points) > toInteger(floorSkill.points),
          canToggleSignature: Boolean(currentSkill.signature)
            ? canUnsetSignature
            : (remaining.signatureSkills > 0)
        };
      })
    };
  }

  async _processFormData(_event, _form, _formData) {
    await this.#saveDraft();
    return this.forceRender();
  }

  async _preClose(options) {
    await super._preClose(options);
    await this.#saveDraft({ notify: false });
  }

  static async #onIncreaseCharacteristic(event, target) {
    event.preventDefault();
    await this.#ensureDraft();
    this.#syncDraftFromForm();

    const key = target.dataset.characteristicKey ?? "";
    if (!key) return;

    const remaining = calculateRemainingDevelopmentPoints(this.#draft.development);
    if (remaining.characteristics < 1) return;

    this.#draft.development.characteristics[key] = toInteger(this.#draft.development.characteristics[key]) + 1;
    this.#draft.characteristics[key] = toInteger(this.#draft.characteristics[key]) + 1;
    return this.forceRender();
  }

  static async #onDecreaseCharacteristic(event, target) {
    event.preventDefault();
    await this.#ensureDraft();
    this.#syncDraftFromForm();

    const key = target.dataset.characteristicKey ?? "";
    if (!key) return;

    const currentPoints = toInteger(this.#draft.development.characteristics[key]);
    const minimumPoints = toInteger(this.#floor.development.characteristics[key]);
    if (currentPoints <= minimumPoints) return;

    this.#draft.development.characteristics[key] = currentPoints - 1;
    this.#draft.characteristics[key] = Math.max(0, toInteger(this.#draft.characteristics[key]) - 1);
    return this.forceRender();
  }

  static async #onIncreaseSkill(event, target) {
    event.preventDefault();
    await this.#ensureDraft();
    this.#syncDraftFromForm();

    const key = target.dataset.skillKey ?? "";
    if (!key) return;

    const remaining = calculateRemainingDevelopmentPoints(this.#draft.development);
    if (remaining.skills < 1) return;

    this.#draft.development.skills[key].points = toInteger(this.#draft.development.skills[key]?.points) + 1;
    return this.forceRender();
  }

  static async #onDecreaseSkill(event, target) {
    event.preventDefault();
    await this.#ensureDraft();
    this.#syncDraftFromForm();

    const key = target.dataset.skillKey ?? "";
    if (!key) return;

    const currentPoints = toInteger(this.#draft.development.skills[key]?.points);
    const minimumPoints = toInteger(this.#floor.development.skills[key]?.points);
    if (currentPoints <= minimumPoints) return;

    this.#draft.development.skills[key].points = currentPoints - 1;
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
      return this.forceRender();
    }

    const remaining = calculateRemainingDevelopmentPoints(this.#draft.development);
    if (remaining.signatureSkills < 1) return;

    this.#draft.development.skills[key].signature = true;
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
      level: this.#draft.level,
      experience: this.#draft.development.experience
    });

    this.#draft.characteristics = foundry.utils.deepClone(resetData.characteristics);
    this.#draft.development = foundry.utils.deepClone(resetData.development);
    this.#floor = foundry.utils.deepClone({
      level: this.#draft.level,
      characteristics: this.#draft.characteristics,
      development: this.#draft.development
    });
    return this.forceRender();
  }

  async #ensureDraft() {
    if (this.#draft) return;

    const characteristicSettings = getCharacteristicSettings();
    const skillSettings = getSkillSettings();
    const development = await this.actor.ensureDevelopmentInitialized();
    const normalized = cloneActorDevelopment(development, characteristicSettings, skillSettings);

    this.#snapshot = {
      level: Math.max(1, toInteger(this.actor.system?.attributes?.level)),
      characteristics: Object.fromEntries(
        characteristicSettings.map(characteristic => [characteristic.key, toInteger(this.actor.system?.characteristics?.[characteristic.key])])
      ),
      development: cloneActorDevelopment(normalized, characteristicSettings, skillSettings)
    };
    this.#draft = foundry.utils.deepClone(this.#snapshot);
    this.#floor = foundry.utils.deepClone(this.#snapshot);
  }

  #syncDraftFromForm() {
    const experienceInput = this.form?.querySelector("[name='experience']");
    if (experienceInput) this.#draft.development.experience = Math.max(0, toInteger(experienceInput.value));
  }

  async #saveDraft({ notify = true } = {}) {
    if (!this.#draft) return false;

    this.#syncDraftFromForm();
    if (!this.#hasDraftChanges()) return false;

    await this.actor.update({
      "system.attributes.level": this.#draft.level,
      "system.characteristics": this.#draft.characteristics,
      "system.development": this.#draft.development
    });

    this.#snapshot = foundry.utils.deepClone(this.#draft);
    this.#floor = foundry.utils.deepClone(this.#draft);
    if (notify) ui.notifications.info(localize("FALLOUTMAW.Messages.AdvancementSaved"));
    return true;
  }

  #hasDraftChanges() {
    return JSON.stringify(this.#draft) !== JSON.stringify(this.#snapshot);
  }
}
