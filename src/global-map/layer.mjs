import {
  DEFAULT_LOCATION,
  DEFAULT_LOCATION_EXIT,
  DEFAULT_TERRAIN,
  DEFAULT_TRANSITION,
  GLOBAL_MAP_LAYER,
  GLOBAL_MAP_ROLES
} from "./constants.mjs";
import {
  assertSupportedGrid,
  cellKey,
  getCellPath,
  getBoundaryBounds,
  getCellCluster,
  getCellVertices,
  getCellsBoundaryLoops,
  getLocationCells,
  locationContainsPoint,
  parseCellKey,
  pointToCell,
  snapPoint
} from "./geometry.mjs";
import {
  GlobalMapSceneSettings,
  TransitionEntryEditor,
  LocationEditor,
  LocationExitEditor,
  TerrainEditor,
  TransitionEditor
} from "./editors.mjs";
import { getGlobalMapFlag, getSceneState, saveCollectionEntry, updateSceneState } from "./storage.mjs";

const InteractionLayer = foundry.canvas.layers.InteractionLayer;

export class FalloutMaWGlobalMapLayer extends InteractionLayer {
  mode = "select";
  editor = null;
  dragPreviewLocation = null;
  brushStroke = null;
  brushPreviewCells = [];
  arrivalSelection = null;
  pendingAreaOverwrites = {
    terrains: new Map(),
    transitions: new Map(),
    locationExitZones: new Map()
  };

  static get layerOptions() {
    return foundry.utils.mergeObject(super.layerOptions, {
      name: GLOBAL_MAP_LAYER,
      zIndex: 250
    });
  }

  static prepareSceneControls() {
    if (!game.user?.isGM || !getGlobalMapFlag(canvas?.scene)) return null;
    const isLocationScene = getGlobalMapFlag(canvas.scene)?.role === GLOBAL_MAP_ROLES.LOCATION_SCENE;
    return {
      name: "falloutMaWGlobalMap",
      order: 9,
      title: "Глобальная карта",
      layer: GLOBAL_MAP_LAYER,
      icon: "fa-solid fa-map-location-dot",
      visible: true,
      onChange: (_event, active) => {
        if (active) canvas[GLOBAL_MAP_LAYER]?.activate();
      },
      onToolChange: (_event, tool, active) => {
        if (active && !tool.button && !tool.toggle) canvas[GLOBAL_MAP_LAYER]?.setMode(tool.name);
      },
      tools: {
        select: tool("select", 1, "Просмотр", "fa-solid fa-arrow-pointer"),
        locationPlace: tool("locationPlace", 2, "Создать локацию", "fa-solid fa-location-dot"),
        locationEdit: tool("locationEdit", 3, "Редактировать локацию", "fa-solid fa-pen-to-square"),
        terrainDraw: tool("terrainDraw", 4, "Новая местность", "fa-solid fa-mountain"),
        terrainEdit: tool("terrainEdit", 5, "Редактировать местность", "fa-solid fa-paintbrush"),
        transitionDraw: tool("transitionDraw", 6, "Новая зона перехода", "fa-solid fa-route"),
        transitionEdit: tool("transitionEdit", 7, "Редактировать переход", "fa-solid fa-signs-post"),
        ...(isLocationScene ? {
          locationExitDraw: tool("locationExitDraw", 9, "Новая зона выхода", "fa-solid fa-person-walking-arrow-right"),
          locationExitEdit: tool("locationExitEdit", 10, "Редактировать зону выхода", "fa-solid fa-pen-ruler")
        } : {}),
        settings: {
          name: "settings",
          order: 11,
          title: "Настройки карты",
          icon: "fa-solid fa-gear",
          button: true,
          onChange: () => new GlobalMapSceneSettings(canvas.scene).render(true)
        }
      },
      activeTool: "select"
    };
  }

  async _draw() {
    this.eventMode = "passive";
    this.container = this.addChild(new PIXI.Container());
    this.container.sortableChildren = true;
    await this.refresh();
  }

  async refresh() {
    if (!this.container || !canvas?.scene) return;
    for (const child of this.container.removeChildren()) child.destroy?.({ children: true });
    const state = getSceneState(canvas.scene);
    this.#drawTerrains(state.terrains);
    this.#drawTransitions(state.transitions, state.discoveredTransitionIds);
    this.#drawIncomingTransitionZones();
    this.#drawLocationExitZones(state.locationExitZones, state.discoveredExitZoneIds);
    this.#drawLocations(state.locations, state.discoveredLocationIds);
    this.#drawWorkingData();
  }

  async setMode(mode) {
    this.mode = mode || "select";
    await this.editor?.close?.();
    this.editor = null;
    if (this.mode === "terrainDraw") {
      if (!assertSupportedGrid()) return this.setMode("select");
      this.editor = new TerrainEditor(canvas.scene, {
        ...DEFAULT_TERRAIN,
        id: foundry.utils.randomID(),
        cells: []
      }, { isNew: true });
      this.editor.render(true);
    } else if (this.mode === "transitionDraw") {
      if (!assertSupportedGrid()) return this.setMode("select");
      this.editor = new TransitionEditor(canvas.scene, {
        ...DEFAULT_TRANSITION,
        id: foundry.utils.randomID(),
        cells: []
      }, { isNew: true });
      this.editor.render(true);
    } else if (this.mode === "locationExitDraw") {
      if (!assertSupportedGrid()) return this.setMode("select");
      if (getGlobalMapFlag(canvas.scene)?.role !== GLOBAL_MAP_ROLES.LOCATION_SCENE) {
        ui.notifications.warn("Зоны выхода создаются только на сцене локации.");
        return this.setMode("select");
      }
      this.editor = new LocationExitEditor(canvas.scene, {
        ...DEFAULT_LOCATION_EXIT,
        id: foundry.utils.randomID(),
        cells: []
      }, { isNew: true });
      this.editor.render(true);
    }
    await this.refresh();
  }

  async startArrivalSelection(payload) {
    if (!payload?.groupId || payload.targetSceneId !== canvas.scene?.id) return false;
    this.arrivalSelection = foundry.utils.deepClone(payload);
    this.mode = "arrivalSelect";
    this.activate();
    await this.refresh();
    return true;
  }

  async clearArrivalSelection(groupId = null) {
    if (groupId && this.arrivalSelection?.groupId !== groupId) return;
    this.arrivalSelection = null;
    if (this.mode === "arrivalSelect") this.mode = "select";
    await this.refresh();
  }

  async startEntryDrawingFor(sourceSceneId, transitionId) {
    if (!assertSupportedGrid()) return;
    const sourceScene = game.scenes?.get(sourceSceneId);
    const transition = sourceScene
      ? getSceneState(sourceScene).transitions.find(entry => entry.id === transitionId)
      : null;
    if (!sourceScene || !transition || transition.targetSceneId !== canvas.scene?.id) {
      ui.notifications.warn("Переход для этой сцены не найден.");
      return;
    }
    await this.editor?.close?.();
    this.mode = "entryDraw";
    this.editor = new TransitionEntryEditor(sourceScene, {
      ...transition,
      entryColor: transition.entryColor
        || (transition.entryCells?.length ? transition.color : DEFAULT_LOCATION_EXIT.color)
    });
    this.editor.render(true);
    await this.refresh();
  }

  async _onClickLeft(event) {
    if (!canvas?.scene) return;
    const point = event.getLocalPosition?.(this) ?? event.global;
    if (this.arrivalSelection) return this.#selectArrivalZoneAt(point);
    if (!game.user?.isGM) return;
    if (this.mode === "locationPlace") return this.#placeLocation(point);
    if (this.mode === "locationEdit") return this.#editLocationAt(point);
    if (this.#isPaintMode()) return this.#paintWorkingCells(point, event);
    if (this.mode === "terrainEdit") return this.#editAreaAt("terrain", point);
    if (this.mode === "transitionEdit") return this.#editAreaAt("transition", point);
    if (this.mode === "locationExitEdit") return this.#editAreaAt("locationExit", point);
  }

  _canDragLeftStart(_user, event) {
    if (this.#isPaintMode()) return Boolean(this.editor?.data && assertSupportedGrid());
    if (this.mode !== "locationEdit") return false;
    const point = event.interactionData?.origin ?? event.getLocalPosition?.(this);
    return Boolean(this.#findLocationAt(point));
  }

  _onDragLeftStart(event) {
    if (this.#isPaintMode()) {
      this.brushStroke = {
        remove: this.#shouldRemoveCells(event),
        overwrite: this.#shouldOverwriteCells(event),
        lastCell: null,
        lastKey: null
      };
      const point = event.interactionData?.origin ?? event.getLocalPosition?.(this);
      void this.#paintWorkingCells(point, event);
      return true;
    }
    const point = event.interactionData?.origin ?? event.getLocalPosition?.(this);
    const location = this.#findLocationAt(point);
    if (!location) return false;
    event.interactionData.globalMapLocation = foundry.utils.deepClone(location);
    this.dragPreviewLocation = foundry.utils.deepClone(location);
    void this.refresh();
    return true;
  }

  _onDragLeftMove(event) {
    if (this.brushStroke) {
      const point = event.interactionData?.destination ?? event.getLocalPosition?.(this);
      void this.#paintWorkingCells(point, event);
      return true;
    }
    const location = event.interactionData?.globalMapLocation;
    const destination = event.interactionData?.destination;
    if (!location || !destination) return false;
    const position = snapPoint(canvas.scene, destination);
    this.dragPreviewLocation = { ...location, x: position.x, y: position.y };
    void this.refresh();
    return true;
  }

  async _onDragLeftDrop(event) {
    if (this.brushStroke) {
      this.brushStroke = null;
      this.brushPreviewCells = [];
      await this.refresh();
      return;
    }
    const preview = this.dragPreviewLocation;
    if (!preview) return;
    this.dragPreviewLocation = null;
    const stored = getSceneState(canvas.scene).locations.find(location => location.id === preview.id);
    if (stored) {
      await saveCollectionEntry(canvas.scene, "locations", {
        ...stored,
        x: preview.x,
        y: preview.y
      });
    }
    if (this.editor instanceof LocationEditor && this.editor.data.id === preview.id) {
      this.editor.data.x = preview.x;
      this.editor.data.y = preview.y;
    }
    await this.refresh();
  }

  _onDragLeftCancel() {
    this.brushStroke = null;
    this.brushPreviewCells = [];
    this.dragPreviewLocation = null;
    void this.refresh();
  }

  async applyPendingAreaOverwrites(collection, activeId) {
    const pending = this.pendingAreaOverwrites?.[collection];
    if (!pending?.size) return;
    const cuts = new Map(Array.from(pending.entries(), ([id, cells]) => [id, new Set(cells)]));
    await updateSceneState(canvas.scene, state => {
      state[collection] = (state[collection] ?? []).map(entry => {
        const remove = cuts.get(entry.id);
        if (!remove?.size || entry.id === activeId) return entry;
        return {
          ...entry,
          cells: (entry.cells ?? []).filter(key => !remove.has(key))
        };
      });
      return state;
    });
    pending.clear();
  }

  clearPendingAreaOverwrites(collection = null) {
    if (collection) this.pendingAreaOverwrites?.[collection]?.clear();
    else {
      this.pendingAreaOverwrites?.terrains?.clear();
      this.pendingAreaOverwrites?.transitions?.clear();
      this.pendingAreaOverwrites?.locationExitZones?.clear();
    }
  }

  async #placeLocation(point) {
    if (!assertSupportedGrid()) return;
    const position = snapPoint(canvas.scene, point);
    const location = {
      ...DEFAULT_LOCATION,
      id: foundry.utils.randomID(),
      x: position.x,
      y: position.y
    };
    await this.editor?.close?.();
    this.editor = new LocationEditor(canvas.scene, location, { isNew: true });
    this.editor.render(true);
    await this.refresh();
  }

  async #editLocationAt(point) {
    const location = this.#findLocationAt(point);
    if (!location) return;
    await this.editor?.close?.();
    this.editor = new LocationEditor(canvas.scene, location, { isNew: false });
    this.editor.render(true);
  }

  #findLocationAt(point) {
    return [...this.#getRenderableLocations()].reverse()
      .find(location => locationContainsPoint(canvas.scene, location, point)) ?? null;
  }

  async #selectArrivalZoneAt(point) {
    if (!this.arrivalSelection) return false;
    const key = cellKey(pointToCell(canvas.scene, point));
    const zone = [...getSceneState(canvas.scene).locationExitZones]
      .reverse()
      .find(entry => entry.cells?.includes(key));
    if (!zone) return false;
    const selection = foundry.utils.deepClone(this.arrivalSelection);
    await this.clearArrivalSelection(selection.groupId);
    const submitted = await game.falloutMaW?.globalMap?.selectArrivalZone?.({
      originSceneId: selection.originSceneId,
      tokenId: selection.tokenId,
      exitZoneId: zone.id
    });
    if (submitted === false) await this.startArrivalSelection(selection);
    return submitted;
  }

  #getRenderableLocations() {
    const locations = new Map(getSceneState(canvas.scene).locations.map(location => [location.id, location]));
    if (this.editor instanceof LocationEditor && this.editor.data?.id) {
      locations.set(this.editor.data.id, this.editor.data);
    }
    return Array.from(locations.values());
  }

  async #editAreaAt(kind, point) {
    if (!assertSupportedGrid()) return;
    const key = cellKey(pointToCell(canvas.scene, point));
    const state = getSceneState(canvas.scene);
    const collection = kind === "terrain"
      ? state.terrains
      : kind === "transition"
        ? state.transitions
        : state.locationExitZones;
    const entry = [...collection].reverse().find(candidate => candidate.cells?.includes(key));
    if (!entry) return;
    await this.editor?.close?.();
    this.editor = kind === "terrain"
      ? new TerrainEditor(canvas.scene, entry, { isNew: false })
      : kind === "transition"
        ? new TransitionEditor(canvas.scene, entry, { isNew: false })
        : new LocationExitEditor(canvas.scene, entry, { isNew: false });
    this.editor.render(true);
  }

  async #paintWorkingCells(point, event) {
    if (!this.editor?.data || !assertSupportedGrid()) return;
    const center = pointToCell(canvas.scene, point);
    if (!center) return;
    const radius = Math.max(1, Number(this.editor.data.brushRadius) || 1);
    const centerKey = cellKey(center);
    if (this.brushStroke?.lastKey === centerKey) return;
    const centers = this.brushStroke?.lastCell
      ? getCellPath(canvas.scene, this.brushStroke.lastCell, center)
      : [center];
    const property = this.mode === "entryDraw" ? "entryCells" : "cells";
    const collection = this.#getPaintCollection(property);
    const cells = new Set(this.editor.data[property] ?? []);
    const remove = this.brushStroke?.remove ?? this.#shouldRemoveCells(event);
    const overwrite = this.brushStroke?.overwrite ?? this.#shouldOverwriteCells(event);
    for (const pathCell of centers) {
      const keys = getCellCluster(canvas.scene, pathCell, radius).map(cellKey);
      for (const key of keys) {
        if (remove) {
          cells.delete(key);
          continue;
        }
        const owner = collection ? this.#findAreaOwner(collection, key, this.editor.data.id) : null;
        if (owner && !overwrite) continue;
        if (owner && overwrite) this.#recordPendingAreaOverwrite(collection, owner.id, key);
        cells.add(key);
      }
    }
    this.brushPreviewCells = getCellCluster(canvas.scene, center, radius);
    if (this.brushStroke) {
      this.brushStroke.lastCell = center;
      this.brushStroke.lastKey = centerKey;
    }
    this.editor.data[property] = Array.from(cells);
    await this.refresh();
  }

  #isPaintMode() {
    return ["terrainDraw", "transitionDraw", "entryDraw", "locationExitDraw"].includes(this.mode)
      || (this.mode === "terrainEdit" && this.editor instanceof TerrainEditor)
      || (this.mode === "transitionEdit" && this.editor instanceof TransitionEditor)
      || (this.mode === "locationExitEdit" && this.editor instanceof LocationExitEditor);
  }

  #shouldRemoveCells(event) {
    const native = event?.nativeEvent ?? event?.data?.originalEvent;
    return Boolean(native?.shiftKey ?? event?.shiftKey);
  }

  #shouldOverwriteCells(event) {
    const native = event?.nativeEvent ?? event?.data?.originalEvent;
    return Boolean(native?.ctrlKey ?? event?.ctrlKey);
  }

  #getPaintCollection(property) {
    if (property !== "cells") return null;
    if (this.editor instanceof TerrainEditor) return "terrains";
    if (this.editor instanceof TransitionEditor) return "transitions";
    if (this.editor instanceof LocationExitEditor) return "locationExitZones";
    return null;
  }

  #findAreaOwner(collection, key, activeId) {
    const pending = this.pendingAreaOverwrites?.[collection];
    const entries = getSceneState(canvas.scene)[collection] ?? [];
    return [...entries].reverse().find(entry => {
      if (!entry?.id || entry.id === activeId) return false;
      if (pending?.get(entry.id)?.has(key)) return false;
      return (entry.cells ?? []).includes(key);
    }) ?? null;
  }

  #recordPendingAreaOverwrite(collection, id, key) {
    const pending = this.pendingAreaOverwrites?.[collection];
    if (!pending || !id || !key) return;
    if (!pending.has(id)) pending.set(id, new Set());
    pending.get(id).add(key);
  }

  #drawLocations(locations, discoveredIds) {
    const renderedLocations = new Map(locations.map(location => [location.id, location]));
    if (this.editor instanceof LocationEditor && this.editor.data?.id) {
      renderedLocations.set(this.editor.data.id, this.editor.data);
    }
    const discovered = new Set(discoveredIds ?? []);
    for (const location of renderedLocations.values()) {
      if (!game.user.isGM && !location.alwaysDiscovered && !discovered.has(location.id)) continue;
      const cells = getLocationCells(canvas.scene, location);
      const graphic = new PIXI.LegacyGraphics();
      graphic.zIndex = 30;
      const isEditMode = this.mode === "locationEdit";
      const isActive = this.editor instanceof LocationEditor && this.editor.data.id === location.id;
      const lineColor = isEditMode ? "#39ff88" : location.strokeColor;
      const lineWidth = isEditMode ? Math.max(3, Number(location.strokeWidth) || 3) : location.strokeWidth;
      drawCellBoundary(graphic, cells, lineColor, lineWidth, isActive ? 1 : 0.9);
      this.container.addChild(graphic);
      const bounds = getBoundaryBounds(getCellsBoundaryLoops(canvas.scene, cells));
      const text = new PIXI.Text(location.name ?? "", {
        fill: location.textColor || "#ffffff",
        fontSize: Math.max(8, Number(location.fontSize) || 28),
        stroke: "#000000",
        strokeThickness: 4,
        align: "center"
      });
      text.anchor.set(0.5);
      text.position.set(
        bounds ? (bounds.minX + bounds.maxX) / 2 : location.x,
        bounds ? bounds.minY - Math.max(8, Number(location.fontSize) * 0.7) : location.y
      );
      text.zIndex = 31;
      this.container.addChild(text);
    }
    if (this.dragPreviewLocation) this.#drawLocationGhost(this.dragPreviewLocation);
  }

  #drawLocationGhost(location) {
    const cells = getLocationCells(canvas.scene, location);
    const graphic = new PIXI.LegacyGraphics();
    graphic.zIndex = 90;
    graphic.alpha = 0.65;
    drawCellBoundary(graphic, cells, "#39ff88", 5, 1);
    this.container.addChild(graphic);
  }

  #drawTerrains(terrains) {
    const activeTerrainId = this.editor instanceof TerrainEditor ? this.editor.data?.id : null;
    const pending = this.pendingAreaOverwrites.terrains;
    for (const terrain of terrains) {
      if (terrain.id === activeTerrainId) continue;
      const graphic = new PIXI.LegacyGraphics();
      graphic.zIndex = 10;
      const cuts = pending.get(terrain.id);
      const cells = (terrain.cells ?? []).filter(key => !cuts?.has(key)).map(parseCellKey).filter(Boolean);
      drawCellArea(graphic, cells, terrain.color, terrain.color, 0.24, 2);
      this.container.addChild(graphic);
    }
  }

  #drawTransitions(transitions, discoveredIds) {
    const discovered = new Set(discoveredIds ?? []);
    const activeTransitionId = this.editor instanceof TransitionEditor && this.mode !== "entryDraw" ? this.editor.data?.id : null;
    const pending = this.pendingAreaOverwrites.transitions;
    for (const transition of transitions) {
      if (transition.id === activeTransitionId) continue;
      if (!game.user.isGM && (transition.hidden || !discovered.has(transition.id))) continue;
      const graphic = new PIXI.LegacyGraphics();
      graphic.zIndex = 20;
      const cuts = pending.get(transition.id);
      const cells = (transition.cells ?? []).filter(key => !cuts?.has(key)).map(parseCellKey).filter(Boolean);
      const isEditMode = this.mode === "transitionEdit";
      const lineColor = isEditMode ? "#39ff88" : transition.color;
      drawCellArea(graphic, cells, lineColor, transition.color, 0.28, isEditMode ? 4 : 3);
      this.container.addChild(graphic);
    }
  }

  #drawLocationExitZones(exits, discoveredIds) {
    const discovered = new Set(discoveredIds ?? []);
    const activeId = this.editor instanceof LocationExitEditor ? this.editor.data?.id : null;
    const pending = this.pendingAreaOverwrites.locationExitZones;
    for (const exit of exits) {
      if (exit.id === activeId) continue;
      if (!this.arrivalSelection && !game.user.isGM && !exit.alwaysDiscovered && !discovered.has(exit.id)) continue;
      const graphic = new PIXI.LegacyGraphics();
      graphic.zIndex = this.arrivalSelection ? 120 : 24;
      const cuts = pending.get(exit.id);
      const cells = (exit.cells ?? []).filter(key => !cuts?.has(key)).map(parseCellKey).filter(Boolean);
      const color = this.arrivalSelection ? "#39ff88" : (exit.color || DEFAULT_LOCATION_EXIT.color);
      drawCellArea(graphic, cells, color, color, this.arrivalSelection ? 0.32 : 0.2, this.arrivalSelection ? 5 : 3);
      this.container.addChild(graphic);
    }
  }

  #drawIncomingTransitionZones() {
    const targetSceneId = canvas.scene?.id;
    if (!targetSceneId) return;
    const activeSourceSceneId = this.mode === "entryDraw" && this.editor instanceof TransitionEntryEditor
      ? this.editor.scene?.id
      : null;
    const activeTransitionId = activeSourceSceneId ? this.editor.data?.id : null;
    for (const sourceScene of game.scenes?.contents ?? []) {
      for (const transition of getSceneState(sourceScene).transitions) {
        if (transition.targetSceneId !== targetSceneId || !transition.entryCells?.length) continue;
        if (!game.user.isGM && transition.hidden) continue;
        if (sourceScene.id === activeSourceSceneId && transition.id === activeTransitionId) continue;
        const cells = transition.entryCells.map(parseCellKey).filter(Boolean);
        if (!cells.length) continue;
        const graphic = new PIXI.LegacyGraphics();
        graphic.zIndex = 23;
        const color = transition.entryColor || transition.color || DEFAULT_LOCATION_EXIT.color;
        drawCellArea(graphic, cells, color, color, 0.2, 3);
        this.container.addChild(graphic);
      }
    }
  }

  #drawWorkingData() {
    const workingCells = this.mode === "entryDraw" ? this.editor?.data?.entryCells : this.editor?.data?.cells;
    if (!workingCells?.length && !this.brushPreviewCells.length) return;
    const color = this.mode === "entryDraw"
      ? (this.editor?.data?.entryColor || this.editor?.data?.color || DEFAULT_LOCATION_EXIT.color)
      : this.editor instanceof LocationExitEditor
      ? (this.editor.data?.color || DEFAULT_LOCATION_EXIT.color)
      : (this.editor?.data?.color ?? "#ffffff");
    const lineColor = this.mode === "transitionEdit" && this.editor instanceof TransitionEditor
      ? "#39ff88"
      : color;
    if (workingCells?.length) {
      const graphic = new PIXI.LegacyGraphics();
      graphic.zIndex = 100;
      const cells = workingCells.map(parseCellKey).filter(Boolean);
      drawCellArea(graphic, cells, lineColor, color, 0.38, 4);
      this.container.addChild(graphic);
    }
    if (this.brushPreviewCells.length) {
      const brush = new PIXI.LegacyGraphics();
      brush.zIndex = 101;
      drawCellBoundary(brush, this.brushPreviewCells, lineColor, 2, 0.9);
      this.container.addChild(brush);
    }
  }
}

function tool(name, order, title, icon) {
  return { name, order, title, icon, interaction: true, control: true };
}

function drawCell(graphic, cell, lineColor, fillColor, alpha = 0.2, width = 2) {
  const vertices = getCellVertices(canvas.scene, cell);
  if (vertices.length < 3) return;
  const line = PIXI.Color.shared.setValue(lineColor || "#ffffff").toNumber();
  const fill = PIXI.Color.shared.setValue(fillColor || "#ffffff").toNumber();
  graphic.lineStyle({ width, color: line, alpha: 0.9 });
  graphic.beginFill(fill, alpha);
  graphic.moveTo(vertices[0].x, vertices[0].y);
  for (const vertex of vertices.slice(1)) graphic.lineTo(vertex.x, vertex.y);
  graphic.closePath();
  graphic.endFill();
}

function drawCellArea(graphic, cells, lineColor, fillColor, alpha = 0.2, width = 2) {
  const fill = PIXI.Color.shared.setValue(fillColor || "#ffffff").toNumber();
  for (const cell of cells) {
    const vertices = getCellVertices(canvas.scene, cell);
    if (vertices.length < 3) continue;
    graphic.lineStyle({ width: 0, alpha: 0 });
    graphic.beginFill(fill, alpha);
    graphic.moveTo(vertices[0].x, vertices[0].y);
    for (const vertex of vertices.slice(1)) graphic.lineTo(vertex.x, vertex.y);
    graphic.closePath();
    graphic.endFill();
  }
  drawCellBoundary(graphic, cells, lineColor, width, 0.95);
}

function drawCellBoundary(graphic, cells, lineColor, width = 3, alpha = 1) {
  const line = PIXI.Color.shared.setValue(lineColor || "#ffffff").toNumber();
  graphic.lineStyle({ width: Math.max(1, Number(width) || 1), color: line, alpha });
  for (const loop of getCellsBoundaryLoops(canvas.scene, cells)) {
    if (loop.length < 2) continue;
    graphic.moveTo(loop[0].x, loop[0].y);
    for (const point of loop.slice(1)) graphic.lineTo(point.x, point.y);
    graphic.closePath();
  }
}
