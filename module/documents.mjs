import { getCreatureOptions } from "./settings.mjs";

function clampNumber(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export class FalloutMaWActor extends Actor {
  static async createDialog(data = {}, createOptions = {}, dialogOptions = {}, renderOptions = {}) {
    const creatureOptions = getCreatureOptions();
    const selectedCreatureType = foundry.utils.getProperty(data, "system.creature.typeId") || "";
    const selectedCreatureRace = foundry.utils.getProperty(data, "system.creature.raceId") || "";
    const priorRender = dialogOptions.render;

    return super.createDialog(data, createOptions, {
      ...dialogOptions,
      template: "systems/fallout-maw/templates/actor/actor-create-dialog.hbs",
      position: foundry.utils.mergeObject({ width: 430 }, dialogOptions.position ?? {}, { inplace: false }),
      context: {
        ...(dialogOptions.context ?? {}),
        selectedCreatureType,
        creatureTypes: creatureOptions.types.map(type => ({ value: type.id, label: type.name })),
        creatureRaces: creatureOptions.races.map(race => ({
          ...race,
          selected: race.id === selectedCreatureRace
        }))
      },
      render: (event, dialog) => {
        priorRender?.(event, dialog);
        this.#activateCreatureCreateDialog(dialog);
      }
    }, renderOptions);
  }

  async _preCreate(data, options, user) {
    if ((await super._preCreate(data, options, user)) === false) return false;
    if (!["character", "npc"].includes(this.type)) return;
    this.#applyCreatureRaceDefaults();
    this.#applyNewActorResourceDefaults();
  }

  prepareDerivedData() {
    super.prepareDerivedData();

    const resources = this.system?.resources;
    if (!resources) return;

    for (const resource of Object.values(resources)) {
      const min = Number(resource.min) || 0;
      const max = Math.max(Number(resource.max) || min, min);
      resource.max = max;
      resource.value = clampNumber(Number(resource.value) || min, min, max);
    }
  }

  get health() {
    return this.system?.resources?.health;
  }

  async applyDamage(amount = 0) {
    const damage = Math.max(0, Math.floor(Number(amount) || 0));
    if (!this.health || damage === 0) return this;

    const nextValue = Math.max(this.health.min, this.health.value - damage);
    return this.update({ "system.resources.health.value": nextValue });
  }

  #applyCreatureRaceDefaults() {
    const creatureOptions = getCreatureOptions();
    const creature = this.system?.creature;
    const race = creatureOptions.races.find(race => race.id === creature?.raceId);
    const typeId = race?.typeId || creature?.typeId || "";

    if (!race && !typeId) return;

    const system = {
      creature: {
        typeId,
        raceId: race?.id || ""
      }
    };

    if (race) {
      system.characteristics = { ...race.characteristics };
      system.progression = { ...race.progression };
    }

    this.updateSource({ system });
  }

  #applyNewActorResourceDefaults() {
    this.system?.prepareDerivedData?.();
    const actionPoints = Number(this.system?.resources?.actionPoints?.max) || 0;
    const movementPoints = Number(this.system?.resources?.movementPoints?.max) || 0;

    this.updateSource({
      system: {
        resources: {
          actionPoints: { value: actionPoints, max: actionPoints },
          movementPoints: { value: movementPoints, max: movementPoints }
        }
      }
    });
  }

  static #activateCreatureCreateDialog(dialog) {
    const typeSelect = dialog.element.querySelector("[data-creature-type-select]");
    const raceSelect = dialog.element.querySelector("[data-creature-race-select]");
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

export class FalloutMaWItem extends Item {
  get isEquipped() {
    return Boolean(this.system?.equipped);
  }

  get totalWeight() {
    return (Number(this.system?.quantity) || 0) * (Number(this.system?.weight) || 0);
  }
}
