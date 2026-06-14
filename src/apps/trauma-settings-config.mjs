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
  getTraumaDamageTypes,
  getUniqueLimbSets,
  normalizeTraumaSettings
} from "../settings/traumas.mjs";
import { buildActionCostEffectKeyTokens, buildAllSkillsEffectKeyToken, buildCombatEffectKeyTokens, buildDamageMitigationEffectKeyTokens, buildWeaponSwitchCostEffectKeyToken } from "../utils/effect-key-tokens.mjs";

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
        limbsLabel: group.limbs.map(limb => limb.label).join(", "),
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
  #expandedSections = new Set();

  constructor(options = {}) {
    super(options);
    this.groupId = String(options.groupId ?? "");
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
    const group = this.#getGroup();
    return group?.raceNames ? `Настройка травм: ${group.raceNames}` : "Настройка травм";
  }

  async _prepareContext(options) {
    const group = this.#getGroup();
    const skillSettings = getSkillSettings();
    const groupConfig = group ? this.settings.groups?.[group.id] : null;
    return {
      ...(await super._prepareContext(options)),
      group: group ? {
        ...group,
        limbsLabel: group.limbs.map(limb => limb.label).join(", "),
        thresholds: prepareTraumaThresholds(groupConfig?.thresholds ?? []),
        limbs: group.limbs.map(limb => {
          const config = groupConfig?.limbs?.[limb.key] ?? createEmptyLimbConfig(limb);
          return {
            ...limb,
            collapse: this.#getCollapseState(`limb:${limb.key}`),
            damageTypeGroups: this.damageTypes.map(damageType => ({
              ...damageType,
              traumaProfiles: prepareDamageTypeTraumaProfiles(config.stages, damageType, skillSettings)
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
    this.#activateCollapsibleSections();
  }

  async _processFormData(_event, _form, _formData) {
    const current = getTraumaSettings(this.creatureOptions, this.damageTypes);
    const group = this.#readGroupFromForm();
    if (group.id) current.groups[group.id] = group.config;
    this.settings = await setTraumaSettings(current, this.creatureOptions, this.damageTypes);
    ui.notifications.info("Настройка травм сохранена.");
    return this.forceRender();
  }

  static #onAddThreshold(event, target) {
    event.preventDefault();
    this.#syncCurrentGroupFromForm();
    const groupId = target.closest("[data-trauma-group]")?.dataset.traumaGroup ?? this.groupId;
    const group = this.settings.groups?.[groupId];
    if (!group) return undefined;

    const thresholdPercent = getAvailableThresholdPercent(group.thresholds ?? []);
    const threshold = {
      id: foundry.utils.randomID(),
      thresholdPercent
    };
    group.thresholds ??= [];
    group.thresholds.push(threshold);
    for (const limb of Object.values(group.limbs ?? {})) {
      limb.stages ??= [];
      limb.stages.push(createStageForThreshold(threshold, this.damageTypes));
    }
    return this.forceRender();
  }

  static #onDeleteThreshold(event, target) {
    event.preventDefault();
    this.#syncCurrentGroupFromForm();
    const groupId = target.closest("[data-trauma-group]")?.dataset.traumaGroup ?? this.groupId;
    const thresholdId = target.closest("[data-trauma-threshold-row]")?.dataset.traumaStage ?? "";
    const group = this.settings.groups?.[groupId];
    if (!group || !thresholdId) return undefined;
    group.thresholds = (group.thresholds ?? []).filter(threshold => threshold.id !== thresholdId);
    for (const limb of Object.values(group.limbs ?? {})) {
      limb.stages = (limb.stages ?? []).filter(stage => stage.id !== thresholdId);
    }
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
    const thresholds = readThresholdsFromForm(groupElement);
    const limbs = {};
    for (const limbElement of groupElement?.querySelectorAll(".fallout-maw-trauma-limb") ?? []) {
      const limbKey = limbElement.dataset.traumaLimb ?? "";
      if (!limbKey) continue;
      const stages = thresholds.map(threshold => ({
        id: threshold.id,
        thresholdPercent: threshold.thresholdPercent,
        profiles: {}
      }));
      const stagesById = new Map(stages.map(stage => [stage.id, stage]));

      for (const stageElement of limbElement.querySelectorAll(".fallout-maw-trauma-profile")) {
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

      limbs[limbKey] = {
        label: limbElement.querySelector("[data-trauma-limb-label]")?.textContent?.trim() ?? "",
        stateMax: String(limbElement.dataset.traumaLimbStateMax ?? "0").trim() || "0",
        stages
      };
    }
    return { id: groupId, config: { thresholds, limbs } };
  }

  #getGroup() {
    return getUniqueLimbSets(this.creatureOptions).find(group => group.id === this.groupId) ?? null;
  }

  #activateCollapsibleSections() {
    for (const button of this.element?.querySelectorAll("[data-trauma-section-toggle]") ?? []) {
      button.addEventListener("click", event => {
        event.preventDefault();
        const section = button.closest("[data-trauma-collapse-section]");
        if (!section) return;
        const key = String(section.dataset.traumaCollapseSection ?? "");
        const collapsed = section.classList.toggle("collapsed");
        if (key) {
          if (collapsed) this.#expandedSections.delete(key);
          else this.#expandedSections.add(key);
        }
        button.setAttribute("aria-expanded", String(!collapsed));
        const icon = button.querySelector("i");
        icon?.classList.toggle("fa-chevron-right", collapsed);
        icon?.classList.toggle("fa-chevron-down", !collapsed);
      });
    }
  }

  #getCollapseState(key) {
    const expanded = this.#expandedSections.has(key);
    return {
      cssClass: expanded ? "" : "collapsed",
      ariaExpanded: String(expanded),
      iconClass: expanded ? "fa-chevron-down" : "fa-chevron-right"
    };
  }
}

function getLimbIds(target) {
  return {
    groupId: target.closest("[data-trauma-group]")?.dataset.traumaGroup ?? "",
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

function countTraumaStages(group = {}) {
  return group?.thresholds?.length ?? 0;
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
    buildAllSkillsEffectKeyToken(),
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
    })),
    ...buildDamageMitigationEffectKeyTokens(),
    createEffectKeyToken({ code: "blind", key: "blind", label: "Слепота", path: "status.blind", group: "Статусы" }),
    createEffectKeyToken({ code: "moveCost", key: "movement", label: "Стоимость перемещения", path: "system.costs.movement", group: "Стоимость" }),
    createEffectKeyToken({ code: "actionCost", key: "action", label: "Стоимость действий", path: "system.costs.action", group: "Стоимость" }),
    buildWeaponSwitchCostEffectKeyToken(),
    ...buildActionCostEffectKeyTokens(),
    ...buildCombatEffectKeyTokens()
  ].filter(Boolean);
}
