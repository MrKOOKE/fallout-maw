import { TEMPLATES } from "../constants.mjs";
import { getCreatureOptions } from "../settings/accessors.mjs";
import { clampNumber } from "../utils/numbers.mjs";
import { clampPreparedResource } from "../data/models/resources.mjs";

export class FalloutMaWActor extends Actor {
  static async createDialog(data = {}, createOptions = {}, dialogOptions = {}, renderOptions = {}) {
    const creatureOptions = getCreatureOptions();
    const selectedCreatureType = foundry.utils.getProperty(data, "system.creature.typeId") || "";
    const selectedCreatureRace = foundry.utils.getProperty(data, "system.creature.raceId") || "";
    const priorRender = dialogOptions.render;

    return super.createDialog(
      data,
      createOptions,
      {
        ...dialogOptions,
        template: TEMPLATES.actorCreateDialog,
        position: foundry.utils.mergeObject({ width: 430 }, dialogOptions.position ?? {}, { inplace: false }),
        context: {
          ...(dialogOptions.context ?? {}),
          selectedCreatureType,
          creatureTypes: creatureOptions.types.map(type => ({ value: type.id, label: type.name })),
          creatureRaces: creatureOptions.races.map(race => ({ ...race, selected: race.id === selectedCreatureRace }))
        },
        render: (event, dialog) => {
          priorRender?.(event, dialog);
          this.#activateCreatureCreateDialog(dialog);
        }
      },
      renderOptions
    );
  }

  async _preCreate(data, options, user) {
    if ((await super._preCreate(data, options, user)) === false) return false;
    if (!["character", "npc"].includes(this.type)) return undefined;

    this.#applyCreatureRaceDefaults();
    this.#applyNewActorResourceDefaults();
    return undefined;
  }

  prepareDerivedData() {
    super.prepareDerivedData();
    const resources = this.system?.resources;
    if (resources) {
      for (const resource of Object.values(resources)) clampPreparedResource(resource);
    }

    const needs = this.system?.needs;
    if (needs) {
      for (const need of Object.values(needs)) clampPreparedResource(need);
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
    const race = creatureOptions.races.find(entry => entry.id === creature?.raceId);
    const typeId = race?.typeId || creature?.typeId || "";

    if (!race && !typeId) return;

    const system = { creature: { typeId, raceId: race?.id || "" } };
    if (race) {
      system.characteristics = { ...race.characteristics };
      system.progression = { ...race.progression };
    }

    this.updateSource({ system });
  }

  #applyNewActorResourceDefaults() {
    this.system?.prepareDerivedData?.();

    this.updateSource({
      system: {
        resources: maximizeResourceMap(this.system?.resources),
        needs: maximizeResourceMap(this.system?.needs)
      }
    });
  }

  static #activateCreatureCreateDialog(dialog) {
    const root = dialog.element instanceof HTMLElement ? dialog.element : dialog.element?.[0] ?? dialog.element;
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

function maximizeResourceMap(resources = {}) {
  return Object.fromEntries(
    Object.entries(resources ?? {}).map(([key, resource]) => {
      const min = Number(resource?.min) || 0;
      const max = Number(resource?.max) || min;
      return [key, { min, value: max, max }];
    })
  );
}
