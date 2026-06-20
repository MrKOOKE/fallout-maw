import { FalloutMaWFormApplicationV2, getExpandedFormData } from "../apps/base-form-application-v2.mjs";
import { DEFAULT_LOCATION, DEFAULT_TERRAIN, DEFAULT_TRANSITION } from "./constants.mjs";
import { deleteCollectionEntry, getGlobalMapFlag, getSceneState, saveCollectionEntry, updateSceneState } from "./storage.mjs";
import {
  createZoneScene,
  deleteLocationTree,
  ensureLocationStructure,
  getOrCreateGlobalMap,
  validateGlobalMapStructure
} from "./structure.mjs";

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
    window: { title: "Локация", resizable: true }
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

export class TransitionEditor extends GlobalMapEditorBase {
  constructor(scene, data, options = {}) {
    super(scene, { ...DEFAULT_TRANSITION, ...data }, options);
    this.isNew = Boolean(options.isNew);
  }

  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    id: "fallout-maw-transition-editor",
    window: { title: "Зона перехода", resizable: true }
  };

  static PARTS = {
    form: { template: `${TEMPLATE_ROOT}/transition-editor.hbs` }
  };

  async _prepareContext() {
    const currentMapId = getGlobalMapFlag(this.scene)?.mapId;
    return {
      transition: this.data,
      canDelete: !this.isNew,
      sceneOptions: (game.scenes?.contents ?? [])
        .filter(scene => getGlobalMapFlag(scene)?.mapId === currentMapId && scene.id !== this.scene.id)
        .map(scene => ({ id: scene.id, name: scene.name }))
    };
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
      mapImage: String(values.mapImage ?? "").trim()
    };
    if (!transition.cells.length) {
      ui.notifications.warn("Нарисуйте хотя бы одну клетку перехода.");
      return;
    }
    if (!transition.targetSceneId && transition.mapImage) {
      const target = await createZoneScene(this.scene, transition);
      transition.targetSceneId = target.id;
      transition.targetOwned = true;
    }
    if (!transition.targetSceneId) {
      ui.notifications.warn("Выберите целевую сцену или укажите фон для новой сцены.");
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
      mapImage: String(transition.mapImage ?? "")
    });
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

export class GlobalMapSceneSettings extends GlobalMapEditorBase {
  constructor(scene, options = {}) {
    super(scene, getSceneState(scene).fog, options);
  }

  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    id: "fallout-maw-global-map-scene-settings",
    window: { title: "Настройки глобальной карты", resizable: false },
    actions: {}
  };

  static PARTS = {
    form: { template: `${TEMPLATE_ROOT}/scene-settings.hbs` }
  };

  async _prepareContext() {
    return { fog: this.data };
  }

  async _processFormData(_event, _form, formData) {
    const values = getExpandedFormData(formData).fog ?? {};
    await updateSceneState(this.scene, state => {
      state.fog = {
        mode: values.mode === "cells" ? "cells" : "native",
        cellRadius: Math.max(1, Math.round(Number(values.cellRadius) || 2))
      };
      return state;
    });
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

function queueGlobalMapApplicationPosition(application) {
  const view = application.element?.ownerDocument?.defaultView ?? globalThis;
  view.requestAnimationFrame?.(() => positionGlobalMapApplication(application))
    ?? positionGlobalMapApplication(application);
}

function positionGlobalMapApplication(application) {
  const element = application.element;
  if (!element) return;
  const document = element.ownerDocument;
  const sidebar = document.querySelector("#sidebar");
  const viewportWidth = document.defaultView?.innerWidth ?? document.documentElement.clientWidth;
  const sidebarLeft = sidebar?.getBoundingClientRect().left;
  const rightBoundary = Number.isFinite(sidebarLeft) && sidebarLeft > 0 ? sidebarLeft : viewportWidth;
  const width = element.getBoundingClientRect().width
    || Number(application.position?.width)
    || Number(application.options?.position?.width)
    || 440;
  const left = Math.max(8, Math.round(rightBoundary - width - 12));
  application.setPosition({
    left,
    top: 16
  });
}

function readCheckboxValue(value) {
  const resolved = Array.isArray(value) ? value.at(-1) : value;
  return resolved === true || resolved === "true" || resolved === "on" || resolved === 1 || resolved === "1";
}
