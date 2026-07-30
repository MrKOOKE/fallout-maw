import { activateEffectKeyAutocomplete, createEffectKeyToken } from "./effect-key-autocomplete.mjs";
import { FalloutMaWFormApplicationV2 } from "./base-form-application-v2.mjs";
import { TEMPLATES } from "../constants.mjs";
import {
  getCharacteristicSettings,
  getCreatureOptions,
  getDamageTypeSettings,
  getNeedSettings,
  getProficiencySettings,
  getSkillSettings,
  getTraumaSettings,
  setTraumaSettings
} from "../settings/accessors.mjs";
import {
  createDefaultTraumaProfile,
  getTraumaDamageTypes,
  getUniqueTraumaLimbs,
  normalizeTraumaSettings
} from "../settings/traumas.mjs";
import { buildNeedChangeModifierEffectKeyTokens } from "../needs/need-change-effect-key-tokens.mjs";
import { buildActionCostEffectKeyTokens, buildAllSkillsAdvantageEffectKeyToken, buildAllSkillsBonusPercentEffectKeyToken, buildAllSkillsDisadvantageEffectKeyToken, buildAllSkillsEffectKeyToken, buildCombatEffectKeyTokens, buildDamageBarrierEffectKeyTokens, buildDamageMitigationEffectKeyTokens, buildInitiativeBonusEffectKeyToken, buildLimbMaxBonusEffectKeyTokens, buildResourceBonusEffectKeyTokens, buildSkillAdvancementMultiplierEffectKeyTokens, buildSkillBonusPercentEffectKeyTokens, buildWeaponSwitchCostEffectKeyToken } from "../utils/effect-key-tokens.mjs";
import { buildStealthAttackBonusEffectKeyTokens } from "../utils/effect-key-tokens.mjs";

export class TraumaSettingsConfig extends FalloutMaWFormApplicationV2 {
  constructor(options = {}) {
    super(options);
    this.creatureOptions = getCreatureOptions();
    this.damageTypes = getTraumaDamageTypes(getDamageTypeSettings());
    this.settings = getTraumaSettings(this.creatureOptions, this.damageTypes);
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-trauma-settings",
    classes: ["fallout-maw", "fallout-maw-config-form", "fallout-maw-trauma-settings"],
    position: {
      width: 900,
      height: "auto"
    },
    window: {
      resizable: true
    },
    form: {
      closeOnSubmit: true
    },
    actions: {
      openLimb: this.#onOpenLimb
    }
  };

  static PARTS = {
    form: {
      template: TEMPLATES.settings.traumaSettings
    }
  };

  get title() {
    return "Настройка травм";
  }

  async _prepareContext(options) {
    const limbs = getUniqueTraumaLimbs(this.creatureOptions);
    return {
      ...(await super._prepareContext(options)),
      limbs,
      hasLimbs: limbs.length > 0
    };
  }

  async _processFormData(_event, _form, _formData) {
    return undefined;
  }

  static #onOpenLimb(event, target) {
    event.preventDefault();
    const limbKey = target.closest("[data-trauma-limb]")?.dataset.traumaLimb ?? "";
    if (!limbKey) return undefined;
    return new TraumaLimbSettingsConfig({
      limbKey,
      onSave: () => {
        this.creatureOptions = getCreatureOptions();
        this.damageTypes = getTraumaDamageTypes(getDamageTypeSettings());
        this.settings = getTraumaSettings(this.creatureOptions, this.damageTypes);
        this.forceRender();
      }
    }).render({ force: true });
  }
}

export class TraumaLimbSettingsConfig extends FalloutMaWFormApplicationV2 {
  constructor(options = {}) {
    super(options);
    this.limbKey = String(options.limbKey ?? "");
    this.onSave = options.onSave ?? null;
    this.creatureOptions = getCreatureOptions();
    this.damageTypes = getTraumaDamageTypes(getDamageTypeSettings());
    this.settings = getTraumaSettings(this.creatureOptions, this.damageTypes);
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-trauma-group-settings",
    classes: ["fallout-maw", "fallout-maw-config-form", "fallout-maw-trauma-settings"],
    position: {
      width: 1080,
      height: 820
    },
    window: {
      resizable: true
    },
    form: {
      closeOnSubmit: true
    },
    actions: {
      addThreshold: this.#onAddThreshold,
      deleteThreshold: this.#onDeleteThreshold,
      browseTraumaImage: this.#onBrowseTraumaImage,
      addEffect: this.#onAddEffect,
      deleteEffect: this.#onDeleteEffect
    }
  };

  static PARTS = {
    form: {
      template: TEMPLATES.settings.traumaGroupSettings
    }
  };

  get title() {
    const limb = this.#getLimb();
    return limb?.label ? `Настройка травм: ${limb.label}` : "Настройка травм";
  }

  async _prepareContext(options) {
    const limb = this.#getLimb();
    const skillSettings = getSkillSettings();
    const config = limb ? this.settings.limbs?.[limb.key] ?? createEmptyLimbConfig(limb) : null;
    return {
      ...(await super._prepareContext(options)),
      limb: limb ? {
        ...limb,
        thresholds: prepareTraumaThresholds(config?.thresholds ?? []),
        damageTypeGroups: this.damageTypes.map(damageType => ({
          ...damageType,
          traumaProfiles: prepareDamageTypeTraumaProfiles(config?.stages, damageType, skillSettings)
        }))
      } : null,
      damageTypes: this.damageTypes
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    activateEffectKeyAutocomplete(this.element, buildEffectKeyTokens());
  }

  async _processFormData(_event, _form, _formData) {
    const current = getTraumaSettings(this.creatureOptions, this.damageTypes);
    const limb = this.#readLimbFromForm();
    if (limb.key) current.limbs[limb.key] = limb.config;
    this.settings = await setTraumaSettings(current, this.creatureOptions, this.damageTypes);
    ui.notifications.info("Настройка травм сохранена.");
    this.onSave?.(this.settings);
    return this.forceRender();
  }

  static #onAddThreshold(event, target) {
    event.preventDefault();
    this.#syncCurrentLimbFromForm();
    const limbKey = target.closest("[data-trauma-limb]")?.dataset.traumaLimb ?? this.limbKey;
    const limb = this.settings.limbs?.[limbKey];
    if (!limb) return undefined;

    const thresholdPercent = getAvailableThresholdPercent(limb.thresholds ?? []);
    const threshold = {
      id: foundry.utils.randomID(),
      thresholdPercent
    };
    limb.thresholds ??= [];
    limb.thresholds.push(threshold);
    limb.stages ??= [];
    limb.stages.push(createStageForThreshold(threshold, this.damageTypes));
    return this.forceRender();
  }

  static #onDeleteThreshold(event, target) {
    event.preventDefault();
    this.#syncCurrentLimbFromForm();
    const limbKey = target.closest("[data-trauma-limb]")?.dataset.traumaLimb ?? this.limbKey;
    const thresholdId = target.closest("[data-trauma-threshold-row]")?.dataset.traumaStage ?? "";
    const limb = this.settings.limbs?.[limbKey];
    if (!limb || !thresholdId) return undefined;
    limb.thresholds = (limb.thresholds ?? []).filter(threshold => threshold.id !== thresholdId);
    limb.stages = (limb.stages ?? []).filter(stage => stage.id !== thresholdId);
    return this.forceRender();
  }

  static async #onBrowseTraumaImage(event, target) {
    event.preventDefault();
    const profile = target.closest("[data-trauma-profile]");
    const input = profile?.querySelector("[data-trauma-profile-img]");
    if (!input) return undefined;

    const picker = new foundry.applications.apps.FilePicker.implementation({
      type: "image",
      current: input.value ?? "",
      callback: path => {
        input.value = path;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });

    await picker.browse(undefined, { render: false });
    return picker.render({ force: true });
  }

  static #onAddEffect(event, target) {
    event.preventDefault();
    this.#syncCurrentLimbFromForm();
    const ids = getLimbIds(target);
    const effects = this.settings.limbs?.[ids.limbKey]?.stages
      ?.find(stage => stage.id === ids.stageId)
      ?.profiles?.[ids.damageTypeKey]?.effects;
    effects?.push({ key: "", type: "add", value: "0", phase: "initial", priority: null });
    return this.forceRender();
  }

  static #onDeleteEffect(event, target) {
    event.preventDefault();
    this.#syncCurrentLimbFromForm();
    const ids = getLimbIds(target);
    const index = Number(target.closest("[data-trauma-effect]")?.dataset.traumaEffect) || 0;
    const effects = this.settings.limbs?.[ids.limbKey]?.stages
      ?.find(stage => stage.id === ids.stageId)
      ?.profiles?.[ids.damageTypeKey]?.effects;
    effects?.splice(index, 1);
    return this.forceRender();
  }

  #syncCurrentLimbFromForm() {
    const current = normalizeTraumaSettings(this.settings, this.creatureOptions, this.damageTypes);
    const limb = this.#readLimbFromForm();
    if (limb.key) current.limbs[limb.key] = limb.config;
    this.settings = current;
  }

  #readLimbFromForm() {
    const limbElement = this.form?.querySelector("[data-trauma-limb]");
    const limbKey = limbElement?.dataset.traumaLimb ?? this.limbKey;
    const thresholds = readThresholdsFromForm(limbElement);
    const stages = thresholds.map(threshold => ({
      id: threshold.id,
      thresholdPercent: threshold.thresholdPercent,
      profiles: {}
    }));
    const stagesById = new Map(stages.map(stage => [stage.id, stage]));

    for (const stageElement of limbElement?.querySelectorAll(".fallout-maw-trauma-profile") ?? []) {
      const stageId = stageElement.dataset.traumaStage || "";
      const damageTypeKey = stageElement.dataset.traumaProfile ?? "";
      const stage = stagesById.get(stageId);
      if (!stage || !damageTypeKey) continue;
      stage.profiles[damageTypeKey] = {
        name: stageElement.querySelector("[data-trauma-profile-name]")?.value ?? "",
        img: stageElement.querySelector("[data-trauma-profile-img]")?.value ?? "",
        healingDifficulty: stageElement.querySelector("[data-trauma-profile-healing-difficulty]")?.value ?? "60",
        healingToolClass: stageElement.querySelector("[data-trauma-profile-healing-tool-class]")?.value ?? "D",
        healingProgress: stageElement.querySelector("[data-trauma-profile-healing-progress]")?.value ?? "100",
        healingSkillKey: stageElement.querySelector("[data-trauma-profile-healing-skill]")?.value ?? "doctor",
        effects: Array.from(stageElement.querySelectorAll("[data-trauma-effect]")).map(effectElement => ({
          key: effectElement.querySelector("[data-trauma-effect-key]")?.value ?? "",
          type: effectElement.querySelector("[data-trauma-effect-type]")?.value ?? "add",
          value: effectElement.querySelector("[data-trauma-effect-value]")?.value ?? "0",
          priority: effectElement.querySelector("[data-trauma-effect-priority]")?.value ?? "",
          phase: "initial"
        }))
      };
    }

    return {
      key: limbKey,
      config: {
        label: limbElement?.querySelector("[data-trauma-limb-label]")?.textContent?.trim() ?? "",
        stateMax: String(limbElement?.dataset.traumaLimbStateMax ?? "0").trim() || "0",
        thresholds,
        stages
      }
    };
  }

  #getLimb() {
    return getUniqueTraumaLimbs(this.creatureOptions)
      .find(limb => limb.key === this.limbKey) ?? null;
  }
}

function getLimbIds(target) {
  return {
    limbKey: target.closest("[data-trauma-limb]")?.dataset.traumaLimb ?? "",
    stageId: target.closest("[data-trauma-stage]")?.dataset.traumaStage ?? "",
    damageTypeKey: target.closest("[data-trauma-profile]")?.dataset.traumaProfile
      ?? target.closest("[data-trauma-damage-type]")?.dataset.traumaDamageType
      ?? ""
  };
}

function readThresholdsFromForm(groupElement) {
  return Array.from(groupElement?.querySelectorAll("[data-trauma-threshold-row]") ?? [])
    .map((row, index) => ({
      id: String(row.dataset.traumaStage || `threshold-${index + 1}`),
      thresholdPercent: Math.max(0, Math.min(100, Number(row.querySelector("[data-trauma-threshold-percent]")?.value) || 0))
    }))
    .sort((left, right) => right.thresholdPercent - left.thresholdPercent);
}

function prepareTraumaThresholds(thresholds = []) {
  return (thresholds ?? [])
    .map(threshold => ({
      id: threshold.id,
      thresholdPercent: threshold.thresholdPercent
    }))
    .sort((left, right) => right.thresholdPercent - left.thresholdPercent);
}

function createStageForThreshold(threshold = {}, damageTypes = []) {
  return {
    id: threshold.id || foundry.utils.randomID(),
    thresholdPercent: Math.max(0, Math.min(100, Number(threshold.thresholdPercent) || 0)),
    profiles: Object.fromEntries(damageTypes.map(damageType => [
      damageType.key,
      createDefaultTraumaProfile(damageType, threshold.thresholdPercent)
    ]))
  };
}

function getAvailableThresholdPercent(thresholds = []) {
  const used = new Set((thresholds ?? []).map(threshold => Number(threshold.thresholdPercent) || 0));
  for (const candidate of [50, 40, 30, 20, 10, 75, 25, 100]) {
    if (!used.has(candidate)) return candidate;
  }
  for (let candidate = 99; candidate >= 0; candidate -= 1) {
    if (!used.has(candidate)) return candidate;
  }
  return 0;
}

function createEmptyLimbConfig(limb) {
  return {
    label: limb.label,
    stateMax: limb.stateMax,
    stages: []
  };
}

function prepareEffectRow(effect, index) {
  return {
    ...effect,
    index,
    addSelected: String(effect?.type ?? "add") === "add",
    multiplySelected: String(effect?.type ?? "") === "multiply",
    overrideSelected: String(effect?.type ?? "") === "override",
    priority: effect?.priority ?? ""
  };
}

function prepareDamageTypeTraumaProfiles(stages = [], damageType = {}, skillSettings = []) {
  return stages
    .map(stage => {
      const profile = stage.profiles?.[damageType.key] ?? createDefaultTraumaProfile(damageType, stage.thresholdPercent);
      const effects = profile?.effects?.length
        ? profile.effects
        : [{ key: "", type: "add", value: "0", phase: "initial", priority: null }];
      return {
        ...createDefaultTraumaProfile(damageType, stage.thresholdPercent),
        ...profile,
        id: stage.id,
        thresholdPercent: stage.thresholdPercent,
        damageTypeKey: damageType.key,
        damageTypeLabel: damageType.label,
        healingToolClassChoices: buildHealingToolClassChoices(profile?.healingToolClass ?? "D"),
        healingSkillChoices: buildHealingSkillChoices(profile?.healingSkillKey ?? "doctor", skillSettings),
        effects: effects.map((effect, index) => prepareEffectRow(effect, index))
      };
    })
    .sort((left, right) => right.thresholdPercent - left.thresholdPercent);
}

function buildHealingToolClassChoices(selected = "D") {
  const normalized = String(selected || "D").trim().toUpperCase();
  return ["D", "C", "B", "A", "S"].map(value => ({
    value,
    label: value,
    selected: value === normalized
  }));
}

function buildHealingSkillChoices(selected = "doctor", skills = []) {
  const normalized = String(selected || "doctor");
  return skills.map(skill => ({
    key: skill.key,
    label: skill.label,
    selected: skill.key === normalized
  }));
}

function buildEffectKeyTokens() {
  return [
    ...getCharacteristicSettings().map(entry => createEffectKeyToken({
      code: entry.abbr || entry.key,
      key: entry.key,
      label: entry.label,
      path: `system.characteristics.${entry.key}`,
      group: "Характеристики"
    })),
    ...getSkillSettings().map(entry => createEffectKeyToken({
      code: entry.abbr || entry.key,
      key: entry.key,
      label: entry.label,
      path: `system.skills.${entry.key}.bonus`,
      group: "Навыки"
    })),
    ...buildSkillBonusPercentEffectKeyTokens(),
    buildAllSkillsEffectKeyToken(),
    buildAllSkillsBonusPercentEffectKeyToken(),
    buildAllSkillsAdvantageEffectKeyToken(),
    buildAllSkillsDisadvantageEffectKeyToken(),
    ...buildSkillAdvancementMultiplierEffectKeyTokens(),
    buildInitiativeBonusEffectKeyToken(),
    ...buildResourceBonusEffectKeyTokens("Ресурсы"),
    ...getNeedSettings().map(entry => createEffectKeyToken({
      code: entry.abbr || entry.key,
      key: entry.key,
      label: entry.label,
      path: `system.needs.${entry.key}.bonus`,
      group: "Потребности"
    })),
    ...buildNeedChangeModifierEffectKeyTokens(getNeedSettings(), { group: "Потребности" }),
    ...getProficiencySettings().map(entry => createEffectKeyToken({
      code: entry.abbr || entry.key,
      key: entry.key,
      label: entry.label,
      path: `system.proficiencies.${entry.key}.bonus`,
      group: "Владения"
    })),
    ...buildDamageMitigationEffectKeyTokens(),
    ...buildDamageBarrierEffectKeyTokens(),
    ...buildLimbMaxBonusEffectKeyTokens(),
    createEffectKeyToken({ code: "blind", key: "blind", label: "Слепота", path: "status.blind", group: "Статусы" }),
    createEffectKeyToken({ code: "moveCost", key: "movement", label: "Стоимость перемещения", path: "system.costs.movement", group: "Стоимость" }),
    createEffectKeyToken({ code: "actionCost", key: "action", label: "Стоимость действий", path: "system.costs.action", group: "Стоимость" }),
    buildWeaponSwitchCostEffectKeyToken(),
    ...buildActionCostEffectKeyTokens(),
    ...buildCombatEffectKeyTokens(),
    ...buildStealthAttackBonusEffectKeyTokens()
  ].filter(Boolean);
}
