import { createRaceDefaults, getCharacteristicSettings, getCreatureOptions, setCreatureOptions } from "../settings.mjs";

export class CreatureOptionsConfig extends FormApplication {
  constructor(object = {}, options = {}) {
    super(object, options);
    this.creatureOptions = getCreatureOptions();
    this.activeKind = this.creatureOptions.races.length ? "race" : "type";
    this.activeId = this.creatureOptions.races[0]?.id || this.creatureOptions.types[0]?.id || null;
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "fallout-maw-creature-options",
      title: "Типы и расы существ",
      template: "systems/fallout-maw/templates/settings/creature-options-config.hbs",
      classes: ["fallout-maw", "creature-options-config"],
      width: 980,
      height: "auto",
      resizable: true,
      closeOnSubmit: false
    });
  }

  getData(options = {}) {
    const data = super.getData(options);
    const characteristicSettings = getCharacteristicSettings();
    const typeOptions = this.creatureOptions.types.map(type => ({ value: type.id, label: type.name }));
    const selectedType = this.activeKind === "type"
      ? this.creatureOptions.types.find(type => type.id === this.activeId)
      : null;
    const selectedRace = this.activeKind === "race"
      ? this.creatureOptions.races.find(race => race.id === this.activeId)
      : null;

    return {
      ...data,
      types: this.creatureOptions.types.map(type => ({
        ...type,
        active: this.activeKind === "type" && this.activeId === type.id
      })),
      races: this.creatureOptions.races.map(race => ({
        ...race,
        active: this.activeKind === "race" && this.activeId === race.id,
        typeName: this.creatureOptions.types.find(type => type.id === race.typeId)?.name || "Без типа"
      })),
      typeOptions,
      activeId: this.activeId,
      selectedType,
      selectedRace,
      characteristics: characteristicSettings.map(characteristic => ({
        ...characteristic,
        value: selectedRace?.characteristics?.[characteristic.key] ?? 0
      }))
    };
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.find("[data-action='select']").on("click", this.#onSelect.bind(this));
    html.find("[data-action='create-type']").on("click", this.#onCreateType.bind(this));
    html.find("[data-action='create-race']").on("click", this.#onCreateRace.bind(this));
  }

  async _updateObject(_event, formData) {
    if (this.activeKind === "type") this.#updateActiveType(formData);
    if (this.activeKind === "race") this.#updateActiveRace(formData);
    await this.#saveAndRender();
  }

  #onSelect(event) {
    event.preventDefault();
    this.activeKind = event.currentTarget.dataset.kind;
    this.activeId = event.currentTarget.dataset.id;
    this.render(true);
  }

  async #onCreateType(event) {
    event.preventDefault();
    const type = {
      id: foundry.utils.randomID(16),
      name: this.#getUniqueName("Новый тип", this.creatureOptions.types)
    };
    this.creatureOptions.types.push(type);
    this.activeKind = "type";
    this.activeId = type.id;
    await this.#saveAndRender();
  }

  async #onCreateRace(event) {
    event.preventDefault();
    if (!this.creatureOptions.types.length) {
      ui.notifications.warn("Сначала создайте тип существа.");
      return;
    }

    const defaults = createRaceDefaults();
    const selectedRace = this.creatureOptions.races.find(race => race.id === this.activeId);
    const race = {
      id: foundry.utils.randomID(16),
      typeId: this.activeKind === "type" ? this.activeId : selectedRace?.typeId || this.creatureOptions.types[0].id,
      name: this.#getUniqueName("Новая раса", this.creatureOptions.races),
      ...defaults
    };

    this.creatureOptions.races.push(race);
    this.activeKind = "race";
    this.activeId = race.id;
    await this.#saveAndRender();
  }

  #updateActiveType(formData) {
    const type = this.creatureOptions.types.find(type => type.id === this.activeId);
    if (!type) return;
    type.name = String(formData.name || "").trim() || "Без названия";
  }

  #updateActiveRace(formData) {
    const race = this.creatureOptions.races.find(race => race.id === this.activeId);
    if (!race) return;

    race.name = String(formData.name || "").trim() || "Без названия";
    race.typeId = formData.typeId || this.creatureOptions.types[0]?.id || "";
    race.characteristics = Object.fromEntries(getCharacteristicSettings().map(characteristic => [
      characteristic.key,
      this.#toInteger(formData[`characteristics.${characteristic.key}`])
    ]));
    race.progression = {
      skillPointsPerLevel: this.#toInteger(formData["progression.skillPointsPerLevel"]),
      researchPointsPerLevel: this.#toInteger(formData["progression.researchPointsPerLevel"])
    };
  }

  async #saveAndRender() {
    await setCreatureOptions(this.creatureOptions);
    this.creatureOptions = getCreatureOptions();
    this.render(true);
  }

  #getUniqueName(baseName, collection) {
    const names = new Set(collection.map(entry => entry.name));
    if (!names.has(baseName)) return baseName;
    let index = 2;
    while (names.has(`${baseName} ${index}`)) index += 1;
    return `${baseName} ${index}`;
  }

  #toInteger(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.trunc(number) : 0;
  }
}
