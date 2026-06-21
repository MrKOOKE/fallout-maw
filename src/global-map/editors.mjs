import { FalloutMaWFormApplicationV2, getExpandedFormData } from "../apps/base-form-application-v2.mjs";
import {
  DEFAULT_LOCATION,
  DEFAULT_LOCATION_EXIT,
  DEFAULT_TERRAIN,
  DEFAULT_TRANSITION
} from "./constants.mjs";
import { deleteCollectionEntry, getGlobalMapFlag, getSceneState, saveCollectionEntry, updateSceneState } from "./storage.mjs";
import {
  deleteLocationTree,
  ensureLocationStructure,
  getOrCreateGlobalMap,
  validateGlobalMapStructure
} from "./structure.mjs";
import { queueGlobalMapApplicationPosition } from "./window-position.mjs";
import { resetCellFog } from "./fog.mjs";

const TEMPLATE_ROOT = "systems/fallout-maw/templates/global-map";

class GlobalMapEditorBase extends FalloutMaWFormApplicationV2 {
  #initialPositionApplied = false;

  constructor(scene, data, options = {}) {
    super(options);
    this.scene = scene;
    this.data = foundry.utils.deepClone(data);
  }

  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    classes: [...super.DEFAULT_OPTIONS.classes, "standard-form", "fallout-maw-global-map-editor"],
    position: { width: 440, height: "auto" },
    actions: {
      delete: GlobalMapEditorBase.#onDelete
    },
    form: {
      handler: GlobalMapEditorBase.handleFormSubmit,
      submitOnChange: false,
      closeOnSubmit: true
    }
  };

  static async #onDelete(_event, target) {
    await this._deleteEntry(target);
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.form?.addEventListener("input", () => this.#syncLivePreview());
    this.form?.addEventListener("change", () => this.#syncLivePreview());
    if (this.#initialPositionApplied) return;
    this.#initialPositionApplied = true;
    queueGlobalMapApplicationPosition(this);
  }

  _applyLiveValues(_values) {}

  _refreshLivePreview() {
    void canvas.falloutMaWGlobalMap?.refresh?.();
  }

  _onClose(options) {
    super._onClose(options);
    const layer = canvas.falloutMaWGlobalMap;
    if (layer?.editor === this) {
      layer.editor = null;
      layer.clearPendingAreaOverwrites?.();
    }
    void layer?.refresh?.();
  }

  async _deleteEntry() {}

  #syncLivePreview() {
    if (!this.form) return;
    const formData = new foundry.applications.ux.FormDataExtended(this.form);
    this._applyLiveValues(getExpandedFormData(formData));
    this._refreshLivePreview();
  }
}

export class LocationEditor extends GlobalMapEditorBase {
  #dragDrop = null;

  constructor(scene, data, options = {}) {
    super(scene, { ...DEFAULT_LOCATION, ...data }, options);
    this.isNew = Boolean(options.isNew);
  }

  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    id: "fallout-maw-location-editor",
    window: { title: "Локация", resizable: true },
    actions: {
      ...super.DEFAULT_OPTIONS.actions,
      configureExitZones: LocationEditor.#configureExitZones
    }
  };

  static PARTS = {
    form: { template: `${TEMPLATE_ROOT}/location-editor.hbs` }
  };

  get _dragDrop() {
    return this.#dragDrop ??= new foundry.applications.ux.DragDrop.implementation({
      dragSelector: null,
      dropSelector: "[data-global-map-location-scene-drop]",
      permissions: {
        drop: () => game.user?.isGM === true
      },
      callbacks: {
        drop: this.#onDropExistingScene.bind(this)
      }
    });
  }

  async _prepareContext() {
    const linkedScene = this.data.linkedSceneId ? game.scenes?.get(this.data.linkedSceneId) : null;
    return {
      location: this.data,
      isNew: this.isNew,
      canDelete: !this.isNew,
      canConnectExistingScene: !linkedScene,
      canConfigureExitZones: Boolean(linkedScene),
      linkedSceneName: linkedScene?.name ?? ""
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this._dragDrop.bind(this.element);
  }

  async _processFormData(_event, _form, formData) {
    const values = getExpandedFormData(formData).location ?? {};
    const existingSceneId = String(values.existingSceneId ?? "").trim() || null;
    const location = {
      ...this.data,
      ...values,
      id: this.data.id || foundry.utils.randomID(),
      name: String(values.name || DEFAULT_LOCATION.name).trim(),
      x: Number(this.data.x) || 0,
      y: Number(this.data.y) || 0,
      size: Math.max(1, Math.round(Number(values.size) || 1)),
      strokeWidth: Math.max(1, Number(values.strokeWidth) || 3),
      fontSize: Math.max(8, Number(values.fontSize) || 28),
      alwaysDiscovered: readCheckboxValue(values.alwaysDiscovered),
      mapImage: "",
      image: String(values.image ?? "").trim()
    };
    delete location.radius;
    delete location.existingSceneId;
    const structure = await ensureLocationStructure(this.scene, location, {
      existingSceneId,
      createScene: false
    });
    if (structure.scene) {
      location.linkedSceneId = structure.scene.id;
      location.linkedSceneOwned = Boolean(getGlobalMapFlag(structure.scene)?.owned);
    }
    await saveCollectionEntry(this.scene, "locations", location);
    this.data = location;
    canvas.falloutMaWGlobalMap?.refresh?.();
  }

  async #onDropExistingScene(event) {
    event.preventDefault();
    const dropzone = event.target?.closest?.("[data-global-map-location-scene-drop]");
    if (!dropzone) return;
    const scene = await getSceneFromDropEvent(event);
    if (!scene) {
      ui.notifications.warn("Перетащите сюда сцену из списка сцен.");
      return;
    }
    if (getGlobalMapFlag(scene)) {
      ui.notifications.warn("Эта сцена уже встроена в глобальную карту.");
      return;
    }
    const input = this.form?.querySelector("[name='location.existingSceneId']");
    if (input) input.value = scene.id;
    const name = dropzone.querySelector("[data-global-map-location-scene-name]");
    if (name) name.textContent = scene.name;
    dropzone.classList.add("has-scene");
  }

  static async #configureExitZones() {
    const target = this.data.linkedSceneId ? game.scenes?.get(this.data.linkedSceneId) : null;
    if (!target) {
      ui.notifications.warn("Сначала подключите сцену к локации.");
      return;
    }
    await target.view();
    const layer = canvas.falloutMaWGlobalMap;
    if (!layer) return;
    layer.activate();
    const hasZones = getSceneState(target).locationExitZones.length > 0;
    await layer.setMode(hasZones ? "locationExitEdit" : "locationExitDraw");
  }

  _applyLiveValues(values) {
    const location = values.location ?? {};
    Object.assign(this.data, {
      name: String(location.name ?? this.data.name),
      size: Math.max(1, Math.round(Number(location.size) || 1)),
      image: String(location.image ?? ""),
      mapImage: "",
      strokeColor: String(location.strokeColor || "#ffffff"),
      strokeWidth: Math.max(1, Number(location.strokeWidth) || 3),
      textColor: String(location.textColor || "#ffffff"),
      fontSize: Math.max(8, Number(location.fontSize) || 28),
      alwaysDiscovered: readCheckboxValue(location.alwaysDiscovered)
    });
  }

  async _deleteEntry() {
    if (this.isNew) return this.close();
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Удалить локацию?" },
      content: `<p>Удалить локацию <strong>${foundry.utils.escapeHTML(this.data.name)}</strong> и её системные сцены?</p>`
    });
    if (!confirmed) return;
    await deleteLocationTree(this.scene, this.data.id);
    await this.close();
    canvas.falloutMaWGlobalMap?.refresh?.();
  }
}

async function getSceneFromDropEvent(event) {
  const data = getDropEventData(event);
  const document = data.uuid ? await fromUuid(String(data.uuid)) : null;
  if (document?.documentName === "Scene") return document;
  const id = String(data.id ?? data._id ?? data.sceneId ?? "").trim();
  if (data.type === "Scene" && id) return game.scenes?.get(id) ?? null;
  return null;
}

function getDropEventData(event) {
  try {
    return TextEditor.getDragEventData(event) ?? {};
  } catch (_error) {
    // Fallback below.
  }
  for (const type of ["application/json", "text/plain"]) {
    try {
      const raw = event.dataTransfer?.getData(type);
      if (raw) return JSON.parse(raw);
    } catch (_error) {
      // Continue with the next payload type.
    }
  }
  return {};
}

export class TerrainEditor extends GlobalMapEditorBase {
  constructor(scene, data, options = {}) {
    super(scene, { ...DEFAULT_TERRAIN, ...data }, options);
    this.isNew = Boolean(options.isNew);
  }

  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    id: "fallout-maw-terrain-editor",
    window: { title: "Местность", resizable: true }
  };

  static PARTS = {
    form: { template: `${TEMPLATE_ROOT}/terrain-editor.hbs` }
  };

  async _prepareContext() {
    return { terrain: this.data, canDelete: !this.isNew };
  }

  async _processFormData(_event, _form, formData) {
    const values = getExpandedFormData(formData).terrain ?? {};
    const terrain = {
      ...this.data,
      ...values,
      id: this.data.id || foundry.utils.randomID(),
      name: String(values.name || DEFAULT_TERRAIN.name).trim(),
      difficulty: Number(values.difficulty) || 0,
      cellAreaKm: Math.max(0.01, Number(values.cellAreaKm) || 5),
      brushRadius: Math.max(1, Math.round(Number(values.brushRadius) || 1)),
      cells: Array.from(new Set(this.data.cells ?? []))
    };
    if (!terrain.cells.length) {
      ui.notifications.warn("Нарисуйте хотя бы одну клетку местности.");
      return;
    }
    await canvas.falloutMaWGlobalMap?.applyPendingAreaOverwrites?.("terrains", terrain.id);
    await saveCollectionEntry(this.scene, "terrains", terrain);
    this.data = terrain;
    canvas.falloutMaWGlobalMap?.refresh?.();
  }

  _applyLiveValues(values) {
    const terrain = values.terrain ?? {};
    Object.assign(this.data, {
      name: String(terrain.name ?? this.data.name),
      color: String(terrain.color || "#4a90d9"),
      difficulty: Number(terrain.difficulty) || 0,
      cellAreaKm: Math.max(0.01, Number(terrain.cellAreaKm) || 5),
      brushRadius: Math.max(1, Math.round(Number(terrain.brushRadius) || 1))
    });
  }

  async _deleteEntry() {
    if (!this.data.id) return this.close();
    await deleteCollectionEntry(this.scene, "terrains", this.data.id);
    await this.close();
    canvas.falloutMaWGlobalMap?.refresh?.();
  }
}

export class LocationExitEditor extends GlobalMapEditorBase {
  constructor(scene, data, options = {}) {
    super(scene, { ...DEFAULT_LOCATION_EXIT, ...data }, options);
    this.isNew = Boolean(options.isNew);
  }

  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    id: "fallout-maw-location-exit-editor",
    window: { title: "Зона выхода", resizable: true }
  };

  static PARTS = {
    form: { template: `${TEMPLATE_ROOT}/location-exit-editor.hbs` }
  };

  async _prepareContext() {
    return { exit: this.data, canDelete: !this.isNew };
  }

  async _processFormData(_event, _form, formData) {
    const values = getExpandedFormData(formData).exit ?? {};
    const exit = {
      ...this.data,
      ...values,
      id: this.data.id || foundry.utils.randomID(),
      name: String(values.name || DEFAULT_LOCATION_EXIT.name).trim(),
      color: String(values.color || DEFAULT_LOCATION_EXIT.color),
      brushRadius: Math.max(1, Math.round(Number(values.brushRadius) || 1)),
      alwaysDiscovered: readCheckboxValue(values.alwaysDiscovered),
      cells: Array.from(new Set(this.data.cells ?? []))
    };
    if (!exit.cells.length) {
      ui.notifications.warn("Нарисуйте хотя бы одну клетку зоны выхода.");
      return;
    }
    await canvas.falloutMaWGlobalMap?.applyPendingAreaOverwrites?.("locationExitZones", exit.id);
    await saveCollectionEntry(this.scene, "locationExitZones", exit);
    this.data = exit;
    canvas.falloutMaWGlobalMap?.refresh?.();
  }

  _applyLiveValues(values) {
    const exit = values.exit ?? {};
    Object.assign(this.data, {
      name: String(exit.name ?? this.data.name),
      color: String(exit.color || DEFAULT_LOCATION_EXIT.color),
      brushRadius: Math.max(1, Math.round(Number(exit.brushRadius) || 1)),
      alwaysDiscovered: readCheckboxValue(exit.alwaysDiscovered)
    });
  }

  async _deleteEntry() {
    if (!this.data.id) return this.close();
    const assemblyIds = getSceneState(this.scene).travelAssemblies
      .filter(entry => entry.exitZoneId === this.data.id)
      .map(entry => entry.id);
    for (const assemblyId of assemblyIds) {
      await game.falloutMaW?.globalMap?.cancelTravelAssembly?.(assemblyId, this.scene.id);
    }
    await updateSceneState(this.scene, state => {
      state.locationExitZones = state.locationExitZones.filter(entry => entry.id !== this.data.id);
      state.discoveredExitZoneIds = state.discoveredExitZoneIds.filter(id => id !== this.data.id);
      return state;
    });
    await this.close();
    canvas.falloutMaWGlobalMap?.refresh?.();
  }
}

export class TransitionEditor extends GlobalMapEditorBase {
  #dragDrop = null;

  constructor(scene, data, options = {}) {
    super(scene, { ...DEFAULT_TRANSITION, ...data }, options);
    this.isNew = Boolean(options.isNew);
  }

  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    id: "fallout-maw-transition-editor",
    window: { title: "Зона перехода", resizable: true },
    actions: {
      ...super.DEFAULT_OPTIONS.actions,
      configureEntryZone: TransitionEditor.#configureEntryZone
    }
  };

  static PARTS = {
    form: { template: `${TEMPLATE_ROOT}/transition-editor.hbs` }
  };

  get _dragDrop() {
    return this.#dragDrop ??= new foundry.applications.ux.DragDrop.implementation({
      dragSelector: null,
      dropSelector: "[data-global-map-transition-scene-drop]",
      permissions: {
        drop: () => game.user?.isGM === true
      },
      callbacks: {
        drop: this.#onDropTargetScene.bind(this)
      }
    });
  }

  async _prepareContext() {
    const targetScene = this.data.targetSceneId ? game.scenes?.get(this.data.targetSceneId) : null;
    return {
      transition: this.data,
      canDelete: !this.isNew,
      canConfigureEntry: !this.isNew && Boolean(targetScene),
      targetSceneName: targetScene?.name ?? ""
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this._dragDrop.bind(this.element);
  }

  async _processFormData(_event, _form, formData) {
    const values = getExpandedFormData(formData).transition ?? {};
    const transition = {
      ...this.data,
      ...values,
      id: this.data.id || foundry.utils.randomID(),
      name: String(values.name || DEFAULT_TRANSITION.name).trim(),
      hidden: readCheckboxValue(values.hidden),
      brushRadius: Math.max(1, Math.round(Number(values.brushRadius) || 1)),
      cells: Array.from(new Set(this.data.cells ?? [])),
      entryCells: Array.from(new Set(this.data.entryCells ?? [])),
      targetSceneId: String(values.targetSceneId ?? "").trim() || null,
      mapImage: ""
    };
    if (!transition.cells.length) {
      ui.notifications.warn("Нарисуйте хотя бы одну клетку перехода.");
      return;
    }
    if (!transition.targetSceneId) {
      ui.notifications.warn("Перетащите целевую сцену в поле перехода.");
      return;
    }
    await canvas.falloutMaWGlobalMap?.applyPendingAreaOverwrites?.("transitions", transition.id);
    await saveCollectionEntry(this.scene, "transitions", transition);
    this.data = transition;
    canvas.falloutMaWGlobalMap?.refresh?.();
  }

  _applyLiveValues(values) {
    const transition = values.transition ?? {};
    Object.assign(this.data, {
      name: String(transition.name ?? this.data.name),
      color: String(transition.color || "#7c4dff"),
      hidden: readCheckboxValue(transition.hidden),
      brushRadius: Math.max(1, Math.round(Number(transition.brushRadius) || 1)),
      targetSceneId: String(transition.targetSceneId ?? "").trim() || null,
      mapImage: ""
    });
  }

  async #onDropTargetScene(event) {
    event.preventDefault();
    const dropzone = event.target?.closest?.("[data-global-map-transition-scene-drop]");
    if (!dropzone) return;
    const scene = await getSceneFromDropEvent(event);
    if (!scene) {
      ui.notifications.warn("Перетащите сюда сцену из списка сцен.");
      return;
    }
    if (scene.id === this.scene.id) {
      ui.notifications.warn("Переход не может вести в ту же сцену.");
      return;
    }
    const input = this.form?.querySelector("[name='transition.targetSceneId']");
    if (input) input.value = scene.id;
    const name = dropzone.querySelector("[data-global-map-transition-scene-name]");
    if (name) name.textContent = scene.name;
    dropzone.classList.add("has-scene");
    if (this.data.targetSceneId !== scene.id) this.data.targetOwned = false;
    this.data.targetSceneId = scene.id;
    this.data.mapImage = "";
  }

  static async #configureEntryZone() {
    const target = this.data.targetSceneId ? game.scenes?.get(this.data.targetSceneId) : null;
    if (this.isNew || !target) {
      ui.notifications.warn("Сначала сохраните переход и назначьте целевую сцену.");
      return;
    }
    const stored = getSceneState(this.scene).transitions.find(entry => entry.id === this.data.id);
    if (!stored) {
      ui.notifications.warn("Сначала сохраните переход.");
      return;
    }
    const sourceSceneId = this.scene.id;
    const transitionId = stored.id;
    await this.close();
    await target.view();
    const layer = canvas.falloutMaWGlobalMap;
    layer?.activate?.();
    await layer?.startEntryDrawingFor?.(sourceSceneId, transitionId);
  }

  async _deleteEntry() {
    if (!this.data.id) return this.close();
    if (this.data.targetOwned && this.data.targetSceneId) {
      const target = game.scenes?.get(this.data.targetSceneId);
      await target?.delete?.({ falloutMaWGlobalMapBypass: true });
    }
    await deleteCollectionEntry(this.scene, "transitions", this.data.id);
    await this.close();
    canvas.falloutMaWGlobalMap?.refresh?.();
  }
}

export class TransitionEntryEditor extends GlobalMapEditorBase {
  constructor(scene, data, options = {}) {
    super(scene, { ...DEFAULT_TRANSITION, ...data }, options);
  }

  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    id: "fallout-maw-transition-entry-editor",
    window: { title: "Зона выхода перехода", resizable: true },
    actions: {
      ...super.DEFAULT_OPTIONS.actions,
      clear: TransitionEntryEditor.#clear
    }
  };

  static PARTS = {
    form: { template: `${TEMPLATE_ROOT}/transition-entry-editor.hbs` }
  };

  async _prepareContext() {
    return { entry: this.data, hasCells: Boolean(this.data.entryCells?.length) };
  }

  async _processFormData(_event, _form, formData) {
    const values = getExpandedFormData(formData).entry ?? {};
    const stored = getSceneState(this.scene).transitions.find(entry => entry.id === this.data.id);
    if (!stored) return ui.notifications.warn("Исходный переход не найден.");
    const transition = {
      ...stored,
      entryColor: String(values.color || this.data.entryColor || stored.color || DEFAULT_LOCATION_EXIT.color),
      brushRadius: Math.max(1, Math.round(Number(values.brushRadius) || 1)),
      entryCells: Array.from(new Set(this.data.entryCells ?? []))
    };
    if (!transition.entryCells.length) {
      ui.notifications.warn("Нарисуйте хотя бы одну клетку зоны выхода.");
      return;
    }
    await saveCollectionEntry(this.scene, "transitions", transition);
    this.data = transition;
    canvas.falloutMaWGlobalMap?.refresh?.();
  }

  _applyLiveValues(values) {
    const entry = values.entry ?? {};
    Object.assign(this.data, {
      entryColor: String(entry.color || this.data.color || DEFAULT_LOCATION_EXIT.color),
      brushRadius: Math.max(1, Math.round(Number(entry.brushRadius) || 1))
    });
  }

  static async #clear() {
    const stored = getSceneState(this.scene).transitions.find(entry => entry.id === this.data.id);
    if (!stored) return;
    await saveCollectionEntry(this.scene, "transitions", { ...stored, entryCells: [] });
    this.data.entryCells = [];
    await this.close();
    canvas.falloutMaWGlobalMap?.refresh?.();
  }
}

export class GlobalMapSceneSettings extends GlobalMapEditorBase {
  constructor(scene, options = {}) {
    super(scene, getSceneState(scene).fog, options);
  }

  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    id: "fallout-maw-global-map-scene-settings",
    window: { title: "Настройки глобальной карты", resizable: false },
    actions: {
      resetCellFog: GlobalMapSceneSettings.#resetCellFog
    }
  };

  static PARTS = {
    form: { template: `${TEMPLATE_ROOT}/scene-settings.hbs` }
  };

  async _prepareContext() {
    return {
      fog: this.data,
      isCellMode: this.data.mode === "cells"
    };
  }

  async _processFormData(_event, _form, formData) {
    const values = getExpandedFormData(formData).fog ?? {};
    const mode = values.mode === "cells" ? "cells" : "native";
    const current = getSceneState(this.scene).fog;
    let nativeMode = current.nativeMode;
    if (mode === "cells" && this.scene.fog.mode !== CONST.FOG_EXPLORATION_MODES.DISABLED) {
      nativeMode = this.scene.fog.mode;
    }
    await updateSceneState(this.scene, state => {
      state.fog = {
        ...state.fog,
        mode,
        cellRadius: Math.max(1, Math.round(Number(values.cellRadius) || 2)),
        nativeMode
      };
      return state;
    });
    const desiredNativeMode = mode === "cells"
      ? CONST.FOG_EXPLORATION_MODES.DISABLED
      : (Number.isInteger(nativeMode) ? nativeMode : CONST.FOG_EXPLORATION_MODES.INDIVIDUAL);
    if (this.scene.fog.mode !== desiredNativeMode) {
      await this.scene.update({ "fog.mode": desiredNativeMode });
    }
    if (this.scene.id === canvas.scene?.id) {
      canvas.perception?.initialize?.();
      canvas.perception?.update?.({ refreshVision: true });
    }
  }

  static async #resetCellFog() {
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Сбросить клеточный туман?" },
      content: "<p>Удалить всю общую разведку клеток, а также обнаруженные локации и переходы этой сцены?</p>",
      yes: { label: "Сбросить" },
      no: { label: "Отмена" }
    });
    if (!confirmed) return;
    await resetCellFog(this.scene);
    this.data = getSceneState(this.scene).fog;
    this.render();
  }
}

export class GlobalMapManager extends FalloutMaWFormApplicationV2 {
  #initialPositionApplied = false;

  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    id: "fallout-maw-global-map-manager",
    classes: [...super.DEFAULT_OPTIONS.classes, "standard-form", "fallout-maw-global-map-editor"],
    position: { width: 460, height: "auto" },
    window: { title: "Глобальная карта", resizable: false },
    actions: {
      open: GlobalMapManager.#open,
      validate: GlobalMapManager.#validate
    }
  };

  static PARTS = {
    form: { template: `${TEMPLATE_ROOT}/manager.hbs` }
  };

  async _prepareContext() {
    const root = game.falloutMaW?.globalMap?.getRootScene?.() ?? null;
    const validation = root ? validateGlobalMapStructure() : { valid: false, issues: [] };
    return {
      hasMap: Boolean(root),
      rootName: root?.name ?? "",
      valid: validation.valid,
      issues: validation.issues
    };
  }

  async _processFormData() {}

  async _onRender(context, options) {
    await super._onRender(context, options);
    if (this.#initialPositionApplied) return;
    this.#initialPositionApplied = true;
    queueGlobalMapApplicationPosition(this);
  }

  static async #open() {
    const root = await getOrCreateGlobalMap();
    if (root && canvas.scene?.id !== root.id) await root.view();
    this.render();
  }

  static #validate() {
    const result = validateGlobalMapStructure();
    if (result.valid) ui.notifications.info("Структура глобальной карты корректна.");
    else ui.notifications.warn(result.issues.join(" "));
    this.render();
  }
}

function readCheckboxValue(value) {
  const resolved = Array.isArray(value) ? value.at(-1) : value;
  return resolved === true || resolved === "true" || resolved === "on" || resolved === 1 || resolved === "1";
}
