import { activateEffectKeyAutocomplete, createEffectKeyToken } from "./effect-key-autocomplete.mjs";
import { FalloutMaWFormApplicationV2 } from "./base-form-application-v2.mjs";
import { TEMPLATES } from "../constants.mjs";
import {
  getCharacteristicSettings,
  getCreatureOptions,
  getDamageTypeSettings,
  getNeedSettings,
  getProficiencySettings,
  getResourceSettings,
  getSkillSettings,
  getTraumaSettings,
  resetTraumaSettings,
  setTraumaSettings
} from "../settings/accessors.mjs";
import {
  createDefaultTraumaProfile,
  createDefaultTraumaStage,
  getUniqueLimbSets,
  normalizeTraumaSettings
} from "../settings/traumas.mjs";

export class TraumaSettingsConfig extends FalloutMaWFormApplicationV2 {
  constructor(options = {}) {
    super(options);
    this.creatureOptions = getCreatureOptions();
    this.damageTypes = getDamageTypeSettings();
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
    actions: {
      openGroup: this.#onOpenGroup,
      resetDefaults: this.#onResetDefaults
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
    const limbSets = getUniqueLimbSets(this.creatureOptions);
    return {
      ...(await super._prepareContext(options)),
      groups: limbSets.map(group => ({
        ...group,
        limbsLabel: group.limbs.map(limb => `${limb.label} (${limb.stateMax})`).join(", "),
        traumaStagesCount: countTraumaStages(this.settings.groups?.[group.id])
      })),
      hasGroups: limbSets.length > 0
    };
  }

  async _processFormData(_event, _form, _formData) {
    return undefined;
  }

  static #onOpenGroup(event, target) {
    event.preventDefault();
    const groupId = target.closest("[data-trauma-group]")?.dataset.traumaGroup ?? "";
    if (!groupId) return undefined;
    return new TraumaGroupSettingsConfig({ groupId }).render({ force: true });
  }

  static async #onResetDefaults(event) {
    event.preventDefault();
    await resetTraumaSettings();
    this.settings = getTraumaSettings(this.creatureOptions, this.damageTypes);
    return this.forceRender();
  }
}

export class TraumaGroupSettingsConfig extends FalloutMaWFormApplicationV2 {
  constructor(options = {}) {
    super(options);
    this.groupId = String(options.groupId ?? "");
    this.creatureOptions = getCreatureOptions();
    this.damageTypes = getDamageTypeSettings();
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
    actions: {
      createStage: this.#onCreateStage,
      deleteStage: this.#onDeleteStage,
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
    const group = this.#getGroup();
    return group?.raceNames ? `Настройка травм: ${group.raceNames}` : "Настройка травм";
  }

  async _prepareContext(options) {
    const group = this.#getGroup();
    const skillSettings = getSkillSettings();
    return {
      ...(await super._prepareContext(options)),
      group: group ? {
        ...group,
        limbsLabel: group.limbs.map(limb => `${limb.label} (${limb.stateMax})`).join(", "),
        limbs: group.limbs.map(limb => {
          const config = this.settings.groups?.[group.id]?.limbs?.[limb.key] ?? createEmptyLimbConfig(limb);
          return {
            ...limb,
            stages: config.stages.map(stage => ({
              ...stage,
              profiles: this.damageTypes.map(damageType => ({
                ...createDefaultTraumaProfile(damageType, stage.thresholdPercent),
                ...(stage.profiles?.[damageType.key] ?? {}),
                damageTypeKey: damageType.key,
                damageTypeLabel: damageType.label,
                healingToolClassChoices: buildHealingToolClassChoices(stage.profiles?.[damageType.key]?.healingToolClass ?? "D"),
                healingSkillChoices: buildHealingSkillChoices(stage.profiles?.[damageType.key]?.healingSkillKey ?? "doctor", skillSettings),
                effects: (stage.profiles?.[damageType.key]?.effects ?? []).map((effect, index) => prepareEffectRow(effect, index))
              }))
            }))
          };
        })
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
    const group = this.#readGroupFromForm();
    if (group.id) current.groups[group.id] = group.config;
    this.settings = await setTraumaSettings(current, this.creatureOptions, this.damageTypes);
    ui.notifications.info("Настройка травм сохранена.");
    return this.forceRender();
  }

  static #onCreateStage(event, target) {
    event.preventDefault();
    this.#syncCurrentGroupFromForm();
    const ids = getLimbIds(target);
    const limb = this.settings.groups?.[ids.groupId]?.limbs?.[ids.limbKey];
    if (!limb) return undefined;
    limb.stages.push(createDefaultTraumaStage(limb.stages.length, this.damageTypes));
    return this.forceRender();
  }

  static #onDeleteStage(event, target) {
    event.preventDefault();
    this.#syncCurrentGroupFromForm();
    const ids = getLimbIds(target);
    const limb = this.settings.groups?.[ids.groupId]?.limbs?.[ids.limbKey];
    if (!limb || !ids.stageId) return undefined;
    limb.stages = limb.stages.filter(stage => stage.id !== ids.stageId);
    return this.forceRender();
  }

  static #onAddEffect(event, target) {
    event.preventDefault();
    this.#syncCurrentGroupFromForm();
    const ids = getLimbIds(target);
    const effects = this.settings.groups?.[ids.groupId]?.limbs?.[ids.limbKey]?.stages
      ?.find(stage => stage.id === ids.stageId)
      ?.profiles?.[ids.damageTypeKey]?.effects;
    effects?.push({ key: "", type: "add", value: "0", phase: "initial", priority: null });
    return this.forceRender();
  }

  static #onDeleteEffect(event, target) {
    event.preventDefault();
    this.#syncCurrentGroupFromForm();
    const ids = getLimbIds(target);
    const index = Number(target.closest("[data-trauma-effect]")?.dataset.traumaEffect) || 0;
    const effects = this.settings.groups?.[ids.groupId]?.limbs?.[ids.limbKey]?.stages
      ?.find(stage => stage.id === ids.stageId)
      ?.profiles?.[ids.damageTypeKey]?.effects;
    effects?.splice(index, 1);
    return this.forceRender();
  }

  #syncCurrentGroupFromForm() {
    const current = normalizeTraumaSettings(this.settings, this.creatureOptions, this.damageTypes);
    const group = this.#readGroupFromForm();
    if (group.id) current.groups[group.id] = group.config;
    this.settings = current;
  }

  #readGroupFromForm() {
    const groupElement = this.form?.querySelector("[data-trauma-group]");
    const groupId = groupElement?.dataset.traumaGroup ?? this.groupId;
    const limbs = {};
    for (const limbElement of groupElement?.querySelectorAll(".fallout-maw-trauma-limb") ?? []) {
      const limbKey = limbElement.dataset.traumaLimb ?? "";
      if (!limbKey) continue;
      limbs[limbKey] = {
        label: limbElement.querySelector("[data-trauma-limb-label]")?.textContent?.trim() ?? "",
        stateMax: Number(limbElement.dataset.traumaLimbStateMax) || 0,
        stages: Array.from(limbElement.querySelectorAll(".fallout-maw-trauma-stage")).map(stageElement => {
          const stageId = stageElement.dataset.traumaStage || foundry.utils.randomID();
          const thresholdPercent = Number(stageElement.querySelector("[data-trauma-stage-threshold]")?.value) || 0;
          return {
            id: stageId,
            thresholdPercent,
            profiles: Object.fromEntries(Array.from(stageElement.querySelectorAll("[data-trauma-profile]")).map(profileElement => {
              const damageTypeKey = profileElement.dataset.traumaProfile ?? "";
              return [damageTypeKey, {
                name: profileElement.querySelector("[data-trauma-profile-name]")?.value ?? "",
                img: profileElement.querySelector("[data-trauma-profile-img]")?.value ?? "",
                healingDifficulty: profileElement.querySelector("[data-trauma-profile-healing-difficulty]")?.value ?? "60",
                healingToolClass: profileElement.querySelector("[data-trauma-profile-healing-tool-class]")?.value ?? "D",
                healingProgress: profileElement.querySelector("[data-trauma-profile-healing-progress]")?.value ?? "100",
                healingSkillKey: profileElement.querySelector("[data-trauma-profile-healing-skill]")?.value ?? "doctor",
                effects: Array.from(profileElement.querySelectorAll("[data-trauma-effect]")).map(effectElement => ({
                  key: effectElement.querySelector("[data-trauma-effect-key]")?.value ?? "",
                  type: effectElement.querySelector("[data-trauma-effect-type]")?.value ?? "add",
                  value: effectElement.querySelector("[data-trauma-effect-value]")?.value ?? "0",
                  priority: effectElement.querySelector("[data-trauma-effect-priority]")?.value ?? "",
                  phase: "initial"
                }))
              }];
            }))
          };
        })
      };
    }
    return { id: groupId, config: { limbs } };
  }

  #getGroup() {
    return getUniqueLimbSets(this.creatureOptions).find(group => group.id === this.groupId) ?? null;
  }
}

function getLimbIds(target) {
  return {
    groupId: target.closest("[data-trauma-group]")?.dataset.traumaGroup ?? "",
    limbKey: target.closest("[data-trauma-limb]")?.dataset.traumaLimb ?? "",
    stageId: target.closest("[data-trauma-stage]")?.dataset.traumaStage ?? "",
    damageTypeKey: target.closest("[data-trauma-profile]")?.dataset.traumaProfile ?? ""
  };
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
    overrideSelected: String(effect?.type ?? "") === "override",
    priority: effect?.priority ?? ""
  };
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

function countTraumaStages(group = {}) {
  return Object.values(group?.limbs ?? {}).reduce((total, limb) => total + (limb?.stages?.length ?? 0), 0);
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
    ...getResourceSettings().map(entry => createEffectKeyToken({
      code: entry.abbr || entry.key,
      key: entry.key,
      label: entry.label,
      path: `system.resources.${entry.key}.bonus`,
      group: "Ресурсы"
    })),
    ...getNeedSettings().map(entry => createEffectKeyToken({
      code: entry.abbr || entry.key,
      key: entry.key,
      label: entry.label,
      path: `system.needs.${entry.key}.bonus`,
      group: "Потребности"
    })),
    ...getProficiencySettings().map(entry => createEffectKeyToken({
      code: entry.abbr || entry.key,
      key: entry.key,
      label: entry.label,
      path: `system.proficiencies.${entry.key}.bonus`,
      group: "Владения"
    }))
  ].filter(Boolean);
}
