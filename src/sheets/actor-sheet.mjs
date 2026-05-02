import { FALLOUT_MAW } from "../config/system-config.mjs";
import { TEMPLATES } from "../constants.mjs";
import {
  getCharacteristicSettings,
  getCreatureOptions,
  getDamageTypeSettings,
  getNeedSettings,
  getResourceSettings,
  getSkillSettings
} from "../settings/accessors.mjs";
import { toInteger } from "../utils/numbers.mjs";

const { ActorSheetV2 } = foundry.applications.sheets;
const { HandlebarsApplicationMixin } = foundry.applications.api;

export class FalloutMaWActorSheet extends HandlebarsApplicationMixin(ActorSheetV2) {
  #freeEdit = false;
  #activeLimbKey = "";

  static DEFAULT_OPTIONS = {
    classes: ["fallout-maw", "fallout-maw-sheet", "fallout-maw-actor-sheet", "sheet", "actor"],
    position: {
      width: 760,
      height: 820
    },
    form: {
      submitOnChange: true
    },
    window: {
      resizable: true
    },
    actions: {
      toggleFreeEdit: this.#onToggleFreeEdit,
      selectLimb: this.#onSelectLimb
    }
  };

  static PARTS = {
    header: {
      template: TEMPLATES.actorSheet.header
    },
    tabs: {
      template: TEMPLATES.actorSheet.tabs
    },
    inventory: {
      template: TEMPLATES.actorSheet.inventory
    },
    indicators: {
      template: TEMPLATES.actorSheet.indicators
    },
    identity: {
      template: TEMPLATES.actorSheet.identity
    }
  };

  static TABS = {
    primary: {
      tabs: [
        { id: "inventory", group: "primary", label: "FALLOUTMAW.Tabs.InventoryEquipment" },
        { id: "indicators", group: "primary", label: "FALLOUTMAW.Tabs.Indicators" },
        { id: "identity", group: "primary", label: "FALLOUTMAW.Tabs.IdentityData" }
      ],
      initial: "inventory"
    }
  };

  get actor() {
    return this.document;
  }

  async _prepareContext(options) {
    this.actor.prepareData();

    const context = await super._prepareContext(options);
    const actor = this.actor;
    const creatureOptions = getCreatureOptions();
    const characteristicSettings = getCharacteristicSettings();
    const damageTypeSettings = getDamageTypeSettings();
    const resourceSettings = getResourceSettings();
    const needSettings = getNeedSettings();
    const skillSettings = getSkillSettings();
    const typeId = actor.system?.creature?.typeId;
    const raceId = actor.system?.creature?.raceId;
    const sourceSystem = actor.system?._source ?? actor.system;
    const limbEntries = Object.entries(actor.system?.limbs ?? {});
    const activeLimbKey = limbEntries.some(([key]) => key === this.#activeLimbKey)
      ? this.#activeLimbKey
      : (limbEntries[0]?.[0] ?? "");
    const limbs = limbEntries.map(([key, limb]) => ({
      key,
      label: String(limb?.label ?? key),
      value: toInteger(limb?.value),
      max: toInteger(limb?.max),
      active: key === activeLimbKey
    }));

    this.#activeLimbKey = activeLimbKey;

    return foundry.utils.mergeObject(context, {
      actor,
      system: actor.system,
      sourceSystem,
      config: FALLOUT_MAW,
      owner: actor.isOwner,
      editable: this.isEditable,
      freeEdit: this.#freeEdit,
      editLockAttribute: this.#freeEdit ? "" : "disabled",
      load: {
        value: formatWeight(actor.system.load?.value),
        max: formatWeight(actor.system.load?.max)
      },
      creatureTypeName: creatureOptions.types.find(type => type.id === typeId)?.name || "",
      creatureRaceName: creatureOptions.races.find(race => race.id === raceId)?.name || "",
      creatureTypes: creatureOptions.types.map(type => ({ ...type, selected: type.id === typeId })),
      creatureRaces: creatureOptions.races.map(race => ({ ...race, selected: race.id === raceId })),
      characteristics: characteristicSettings.map(characteristic => ({
        ...characteristic,
        value: toInteger(sourceSystem.characteristics?.[characteristic.key])
      })),
      resources: resourceSettings.map(resource => ({
        ...resource,
        value: toInteger(actor.system.resources?.[resource.key]?.value),
        max: toInteger(actor.system.resources?.[resource.key]?.max)
      })),
      needs: needSettings.map(need => ({
        ...need,
        value: toInteger(actor.system.needs?.[need.key]?.value),
        max: toInteger(actor.system.needs?.[need.key]?.max)
      })),
      limbs,
      activeLimb: limbs.find(limb => limb.active) ?? null,
      skills: skillSettings.map(skill => {
        const current = actor.system.skills?.[skill.key] ?? {};
        const source = sourceSystem.skills?.[skill.key] ?? {};
        return {
          ...skill,
          base: toInteger(current.base),
          bonus: toInteger(source.bonus),
          value: toInteger(current.value)
        };
      }),
      damageResistances: damageTypeSettings.map(damageType => ({
        ...damageType,
        value: toInteger(actor.system.damageResistances?.[activeLimbKey]?.[damageType.key])
      }))
    }, { inplace: false });
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.#activateCreatureSelectors();
  }

  static #onToggleFreeEdit(event) {
    event.preventDefault();
    this.#freeEdit = !this.#freeEdit;
    return this.render({ force: true });
  }

  static #onSelectLimb(event, target) {
    event.preventDefault();
    const limbKey = target.dataset.limbKey ?? "";
    if (!limbKey || (limbKey === this.#activeLimbKey)) return undefined;
    this.#activeLimbKey = limbKey;
    return this.render({ parts: ["indicators"] });
  }

  #activateCreatureSelectors() {
    const root = this.element;
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

function formatWeight(value) {
  const numeric = Number(value) || 0;
  if (Number.isInteger(numeric)) return String(numeric);
  return numeric.toFixed(1).replace(/\.0$/, "");
}
