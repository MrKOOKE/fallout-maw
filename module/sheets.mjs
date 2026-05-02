import { FALLOUT_MAW } from "./config.mjs";
import { getCharacteristicSettings, getCreatureOptions, getDamageTypeSettings, getSkillSettings } from "./settings.mjs";

export class FalloutMaWActorSheet extends ActorSheet {
  constructor(...args) {
    super(...args);
    this.freeEdit = false;
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ["fallout-maw", "sheet", "actor"],
      template: "systems/fallout-maw/templates/actor/actor-sheet.hbs",
      width: 720,
      height: 780,
      resizable: true
    });
  }

  getData(options = {}) {
    this.actor.prepareData();
    const data = super.getData(options);
    const creatureOptions = getCreatureOptions();
    const characteristicSettings = getCharacteristicSettings();
    const damageTypeSettings = getDamageTypeSettings();
    const skillSettings = getSkillSettings();
    const typeId = data.actor.system?.creature?.typeId;
    const raceId = data.actor.system?.creature?.raceId;
    const sourceSystem = data.actor.system._source ?? data.actor.system;

    data.system = data.actor.system;
    data.sourceSystem = sourceSystem;
    data.config = FALLOUT_MAW;
    data.freeEdit = this.freeEdit;
    data.editLockAttribute = this.freeEdit ? "" : "disabled";
    data.creatureTypeName = creatureOptions.types.find(type => type.id === typeId)?.name || "";
    data.creatureRaceName = creatureOptions.races.find(race => race.id === raceId)?.name || "";
    data.creatureTypes = creatureOptions.types.map(type => ({ value: type.id, label: type.name }));
    data.creatureRaces = creatureOptions.races.map(race => ({
      ...race,
      selected: race.id === raceId
    }));
    data.characteristics = characteristicSettings.map(characteristic => ({
      ...characteristic,
      value: sourceSystem.characteristics?.[characteristic.key] ?? 0
    }));
    data.skills = skillSettings.map(skill => ({
      ...skill,
      value: data.actor.system.skills?.[skill.key]?.value ?? 0
    }));
    data.damageResistances = damageTypeSettings.map(damageType => ({
      ...damageType,
      value: data.actor.system.damageResistances?.[damageType.key] ?? 0
    }));
    return data;
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.find("[data-action='toggle-free-edit']").on("click", event => {
      event.preventDefault();
      this.freeEdit = !this.freeEdit;
      this.render(true);
    });
    this.#activateCreatureSelectors(html);
  }

  #activateCreatureSelectors(html) {
    const typeSelect = html[0]?.querySelector("[data-creature-type-select]");
    const raceSelect = html[0]?.querySelector("[data-creature-race-select]");
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

export function registerSystemSheets() {
  foundry.applications.apps.DocumentSheetConfig.registerSheet(Actor, FALLOUT_MAW.id, FalloutMaWActorSheet, {
    label: "Fallout-MaW",
    types: FALLOUT_MAW.actorTypes,
    makeDefault: true
  });
}
