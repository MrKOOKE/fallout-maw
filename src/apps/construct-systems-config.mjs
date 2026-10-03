import { FalloutMaWFormApplicationV2 } from "./base-form-application-v2.mjs";
import { getConstructSystems, getConstructSystemState } from "../utils/construct-systems.mjs";
import { getResourceSettings } from "../settings/accessors.mjs";
import { getDroppedWorldItems } from "../utils/document-drop.mjs";
import { resolveWorldItemSync } from "../utils/world-items.mjs";

const soundLabels = { start: "Запуск", stop: "Остановка", idle: "Работа на месте", move: "Движение", rotate: "Вращение башни" };

export class ConstructSystemsConfig extends FalloutMaWFormApplicationV2 {
  #systems;
  #selected = "";
  #events;
  #preview;
  #previewGeneration = 0;
  constructor(actor, options = {}) {
    super(options); this.actor = actor; this.#systems = foundry.utils.deepClone(getConstructSystems(actor)); this.#selected = this.#systems[0]?.id ?? "";
  }
  static DEFAULT_OPTIONS = { ...FalloutMaWFormApplicationV2.DEFAULT_OPTIONS, id: "fallout-maw-construct-systems",
    classes: ["fallout-maw", "fallout-maw-config-form", "construct-systems-config"], position: { width: 820, height: 740 },
    actions: { addSystem: this.#addSystem, selectSystem: this.#selectSystem, removeSystem: this.#removeSystem,
      addRecovery: this.#addRecovery, removeRecovery: this.#removeRecovery, removeResource: this.#removeResource,
      browseSystemSound: this.#browseSound, previewSystemSound: this.#previewSound } };
  static PARTS = { body: { template: "systems/fallout-maw/templates/actor/construct-systems-config.hbs" } };
  get title() { return `Системы: ${this.actor.name}`; }
  async _prepareContext(options) {
    const selected = this.#current();
    const state = selected && getConstructSystemState(this.actor, selected);
    return { ...await super._prepareContext(options), systems: this.#systems.map(row => ({ ...row, selected: row.id === this.#selected })),
      selected: selected && { ...selected, capacity: state.capacity, movementPoints: state.movementPoints,
        soundEdgePercent: Math.round((selected.soundEdgeVolume ?? 0.25) * 100),
        parts: state.contributions.map(row => ({ name: row.item.name, capacity: row.capacity, movementPoints: row.movementPoints,
          provider: row.activationProvider, broken: row.broken })),
        resourceChoices: getResourceSettings().filter(row => !["movementPoints", "actionPoints", "reactionPoints", "health", "consciousness"].includes(row.key))
          .map(row => ({ ...row, selected: row.key === selected.resourceKey })),
        recoveryRows: selected.recoveryMethods.map((row, index) => ({ ...row, index, all: row.mode === "all", percent: row.recoveryMode !== "amount",
          resources: row.resources.map((entry, resourceIndex) => ({ ...entry, resourceIndex, name: resolveWorldItemSync(entry.uuid)?.name || "Предмет не найден",
            img: resolveWorldItemSync(entry.uuid)?.img || "icons/svg/item-bag.svg" })) })),
        soundRows: Object.entries(soundLabels).map(([key, label]) => ({ key, label, pathsText: (selected.sounds?.[key]?.paths ?? []).join("\n"),
          volume: selected.sounds?.[key]?.volume ?? 0.5,
          volumePercent: Math.round((selected.sounds?.[key]?.volume ?? 0.5) * 100) })) } };
  }
  async _onRender(context, options) {
    await super._onRender(context, options);
    this.#events?.abort(); this.#events = new AbortController(); const optionsEvents = { signal: this.#events.signal };
    this.element.addEventListener("change", event => { const input = event.target.closest("[data-system-field]");
      if (!input || !this.#current()) return;
      foundry.utils.setProperty(this.#current(), input.dataset.systemField, input.dataset.paths !== undefined ? input.value.split(/\r?\n/).map(row => row.trim()).filter(Boolean)
        : input.type === "checkbox" ? input.checked : input.dataset.percent !== undefined ? Number(input.value) / 100
          : input.type === "number" || input.type === "range" ? Number(input.value) : input.value);
    }, optionsEvents);
    this.element.addEventListener("input", event => {
      const input = event.target.closest("[data-sound-volume]");
      if (input) input.parentElement.querySelector("output").textContent = `${Math.round(Number(input.value) * 100)}%`;
    }, optionsEvents);
    for (const zone of this.element.querySelectorAll("[data-system-recovery-drop]")) {
      zone.addEventListener("dragover", event => { event.preventDefault(); event.dataTransfer.dropEffect = "link"; }, optionsEvents);
      zone.addEventListener("drop", async event => {
        event.preventDefault(); const items = await getDroppedWorldItems(event);
        const method = this.#current()?.recoveryMethods[Number(zone.dataset.systemRecoveryDrop)];
        if (!method) return;
        for (const item of items.filter(row => row.type === "gear")) if (!method.resources.some(row => row.uuid === item.uuid)) method.resources.push({ uuid: item.uuid, quantity: 1 });
        this.render();
      }, optionsEvents);
    }
  }
  #current() { return this.#systems.find(row => row.id === this.#selected); }
  async _processFormData() {
    if (!this.actor.isOwner) return;
    const ids = this.#systems.map(row => row.id);
    if (ids.some(id => !/^[\w-]+$/.test(id)) || new Set(ids).size !== ids.length) {
      ui.notifications.warn("Ключи систем должны быть уникальны и содержать буквы, цифры, дефис или подчёркивание."); return;
    }
    const systems = this.#systems.map(row => ({ ...row, active: getConstructSystems(this.actor).find(current => current.id === row.id)?.active ?? false }));
    await this.actor.update({ "system.constructSystems": systems });
    ui.notifications.info("Настройки систем сохранены.");
  }
  static #addSystem(event) {
    event.preventDefault(); const id = this.#systems.some(row => row.id === "drive") ? foundry.utils.randomID() : "drive";
    this.#systems.push({ id, name: "Энергосистема", enabled: true, resourceKey: "power", requiresActivation: true, active: false,
      movement: true, energyPerMovementPoint: 1, soundRadius: 30, soundEdgeVolume: 0.25, soundWalls: true,
      soundFadeIn: 180, soundFadeOut: 300, soundResumeWindow: 250,
      recoveryMethods: [], sounds: {} }); this.#selected = id; this.render();
  }
  static #selectSystem(event, target) { event.preventDefault(); this.#selected = target.dataset.systemId; this.render(); }
  static #removeSystem(event) { event.preventDefault(); this.#systems = this.#systems.filter(row => row.id !== this.#selected); this.#selected = this.#systems[0]?.id ?? ""; this.render(); }
  static #addRecovery(event) { event.preventDefault(); this.#current()?.recoveryMethods.push({ type: "resources", mode: "one", recoveryMode: "percent", recovery: 10, resources: [] }); this.render(); }
  static #removeRecovery(event, target) { event.preventDefault(); this.#current()?.recoveryMethods.splice(Number(target.dataset.index), 1); this.render(); }
  static #removeResource(event, target) { event.preventDefault(); this.#current()?.recoveryMethods[Number(target.dataset.method)]?.resources.splice(Number(target.dataset.index), 1); this.render(); }
  static #browseSound(event, target) {
    event.preventDefault(); const key = target.dataset.sound;
    new foundry.applications.apps.FilePicker.implementation({ type: "audio", callback: path => {
      const system = this.#current(); system.sounds[key] ??= { paths: [], volume: 0.5 }; system.sounds[key].paths.push(path); this.render();
    } }).browse();
  }
  static #previewSound(event, target) {
    event.preventDefault(); const config = this.#current()?.sounds?.[target.dataset.sound];
    const generation = ++this.#previewGeneration;
    void this.#preview?.stop();
    if (!config?.paths?.length) return;
    const sound = new foundry.audio.Sound(config.paths[0], { context: game.audio.environment }); this.#preview = sound;
    void sound.load().then(() => generation === this.#previewGeneration && sound.play({ volume: config.volume })).catch(error => console.warn("Предпросмотр звука", error));
  }
  async _onClose(options) {
    ++this.#previewGeneration; this.#events?.abort(); void this.#preview?.stop();
    return super._onClose(options);
  }
}
