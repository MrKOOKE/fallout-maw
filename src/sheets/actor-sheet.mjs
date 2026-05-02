import { FALLOUT_MAW } from "../config/system-config.mjs";
import { TEMPLATES } from "../constants.mjs";
import {
  getCharacteristicSettings,
  getCreatureOptions,
  getDamageTypeSettings,
  getSkillSettings
} from "../settings/accessors.mjs";
import { toInteger } from "../utils/numbers.mjs";

const { ActorSheetV2 } = foundry.applications.sheets;
const { HandlebarsApplicationMixin } = foundry.applications.api;

export class FalloutMaWActorSheet extends HandlebarsApplicationMixin(ActorSheetV2) {
  #freeEdit = false;

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
      toggleFreeEdit: this.#onToggleFreeEdit
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
    const skillSettings = getSkillSettings();
    const typeId = actor.system?.creature?.typeId;
    const raceId = actor.system?.creature?.raceId;
    const sourceSystem = actor.system?._source ?? actor.system;

    return foundry.utils.mergeObject(context, {
      actor,
      system: actor.system,
      sourceSystem,
      config: FALLOUT_MAW,
      owner: actor.isOwner,
      editable: this.isEditable,
      freeEdit: this.#freeEdit,
      editLockAttribute: this.#freeEdit ? "" : "disabled",
      creatureTypeName: creatureOptions.types.find(type => type.id === typeId)?.name || "",
      creatureRaceName: creatureOptions.races.find(race => race.id === raceId)?.name || "",
      creatureTypes: creatureOptions.types.map(type => ({ ...type, selected: type.id === typeId })),
      creatureRaces: creatureOptions.races.map(race => ({ ...race, selected: race.id === raceId })),
      characteristics: characteristicSettings.map(characteristic => ({
        ...characteristic,
        value: toInteger(sourceSystem.characteristics?.[characteristic.key])
      })),
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
        value: toInteger(actor.system.damageResistances?.[damageType.key])
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
