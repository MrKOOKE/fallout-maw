import { DEFAULT_LOCATION, DEFAULT_TERRAIN, DEFAULT_TRANSITION, GLOBAL_MAP_LAYER } from "./constants.mjs";
import {
  assertSupportedGrid,
  cellKey,
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
import { GlobalMapSceneSettings, LocationEditor, TerrainEditor, TransitionEditor } from "./editors.mjs";
import { getGlobalMapFlag, getSceneState, saveCollectionEntry } from "./storage.mjs";

const InteractionLayer = foundry.canvas.layers.InteractionLayer;

export class FalloutMaWGlobalMapLayer extends InteractionLayer {
  mode = "select";
  editor = null;
  dragPreviewLocation = null;

  static get layerOptions() {
    return foundry.utils.mergeObject(super.layerOptions, {
      name: GLOBAL_MAP_LAYER,
      zIndex: 250
    });
  }

  static prepareSceneControls() {
    if (!game.user?.isGM || !getGlobalMapFlag(canvas?.scene)) return null;
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
        entryDraw: {
          name: "entryDraw",
          order: 8,
          title: "Нарисовать область входа",
          icon: "fa-solid fa-right-to-bracket",
          button: true,
          onChange: () => canvas[GLOBAL_MAP_LAYER]?.startEntryDrawing?.()
        },
        settings: {
          name: "settings",
          order: 9,
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
    }
    await this.refresh();
  }

  async startEntryDrawing() {
    if (!assertSupportedGrid()) return;
    const candidates = [];
    for (const scene of game.scenes?.contents ?? []) {
      for (const transition of getSceneState(scene).transitions) {
        if (transition.targetSceneId === canvas.scene?.id) candidates.push({ scene, transition });
      }
    }
    if (!candidates.length) {
      ui.notifications.warn("На эту сцену не ведёт ни один переход.");
      return;
    }
    const result = await foundry.applications.api.DialogV2.input({
      window: { title: "Область входа" },
      content: `
        <label>Переход
          <select name="candidate">
            ${candidates.map((entry, index) => `<option value="${index}">${foundry.utils.escapeHTML(entry.scene.name)} → ${foundry.utils.escapeHTML(entry.transition.name)}</option>`).join("")}
          </select>
        </label>
      `,
      ok: {
        label: "Редактировать",
        callback: (_event, button) => new foundry.applications.ux.FormDataExtended(button.form).object
      },
      rejectClose: false
    });
    if (!result) return;
    const selected = candidates[Math.max(0, Number(result.candidate) || 0)];
    if (!selected) return;
    await this.editor?.close?.();
    this.mode = "entryDraw";
    this.editor = new TransitionEditor(selected.scene, selected.transition, { isNew: false });
    this.editor.render(true);
    await this.refresh();
  }

  async _onClickLeft(event) {
    if (!game.user?.isGM || !canvas?.scene) return;
    const point = event.getLocalPosition?.(this) ?? event.global;
    if (this.mode === "locationPlace") return this.#placeLocation(point);
    if (this.mode === "locationEdit") return this.#editLocationAt(point);
    if (["terrainDraw", "transitionDraw", "entryDraw"].includes(this.mode)) return this.#paintWorkingCells(point, event);
    if (this.mode === "terrainEdit") return this.#editAreaAt("terrain", point);
    if (this.mode === "transitionEdit") return this.#editAreaAt("transition", point);
  }

  _canDragLeftStart(_user, event) {
    if (this.mode !== "locationEdit") return false;
    const point = event.interactionData?.origin ?? event.getLocalPosition?.(this);
    return Boolean(this.#findLocationAt(point));
  }

  _onDragLeftStart(event) {
    const point = event.interactionData?.origin ?? event.getLocalPosition?.(this);
    const location = this.#findLocationAt(point);
    if (!location) return false;
    event.interactionData.globalMapLocation = foundry.utils.deepClone(location);
    this.dragPreviewLocation = foundry.utils.deepClone(location);
    void this.refresh();
    return true;
  }

  _onDragLeftMove(event) {
    const location = event.interactionData?.globalMapLocation;
    const destination = event.interactionData?.destination;
    if (!location || !destination) return false;
    const position = snapPoint(canvas.scene, destination);
    this.dragPreviewLocation = { ...location, x: position.x, y: position.y };
    void this.refresh();
    return true;
  }

  async _onDragLeftDrop(event) {
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
    this.dragPreviewLocation = null;
    void this.refresh();
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
    const collection = kind === "terrain" ? state.terrains : state.transitions;
    const entry = [...collection].reverse().find(candidate => candidate.cells?.includes(key));
    if (!entry) return;
    await this.editor?.close?.();
    this.editor = kind === "terrain"
      ? new TerrainEditor(canvas.scene, entry, { isNew: false })
      : new TransitionEditor(canvas.scene, entry, { isNew: false });
    this.editor.render(true);
  }

  async #paintWorkingCells(point, event) {
    if (!this.editor?.data || !assertSupportedGrid()) return;
    const center = pointToCell(canvas.scene, point);
    if (!center) return;
    const radius = Math.max(1, Number(this.editor.data.brushRadius) || 1);
    const keys = getCellCluster(canvas.scene, center, radius).map(cellKey);
    const property = this.mode === "entryDraw" ? "entryCells" : "cells";
    const cells = new Set(this.editor.data[property] ?? []);
    const remove = Boolean(event.nativeEvent?.shiftKey ?? event.shiftKey);
    for (const key of keys) remove ? cells.delete(key) : cells.add(key);
    this.editor.data[property] = Array.from(cells);
    await this.refresh();
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
    for (const terrain of terrains) {
      const graphic = new PIXI.LegacyGraphics();
      graphic.zIndex = 10;
      for (const key of terrain.cells ?? []) {
        const cell = parseCellKey(key);
        if (cell) drawCell(graphic, cell, terrain.color, terrain.color, 0.2, 2);
      }
      this.container.addChild(graphic);
    }
  }

  #drawTransitions(transitions, discoveredIds) {
    const discovered = new Set(discoveredIds ?? []);
    for (const transition of transitions) {
      if (!game.user.isGM && (transition.hidden || !discovered.has(transition.id))) continue;
      const graphic = new PIXI.LegacyGraphics();
      graphic.zIndex = 20;
      for (const key of transition.cells ?? []) {
        const cell = parseCellKey(key);
        if (cell) drawCell(graphic, cell, transition.color, transition.color, 0.28, 3);
      }
      this.container.addChild(graphic);
    }
  }

  #drawWorkingData() {
    const workingCells = this.mode === "entryDraw" ? this.editor?.data?.entryCells : this.editor?.data?.cells;
    if (!workingCells?.length) return;
    const color = this.editor.data.color ?? "#ffffff";
    const graphic = new PIXI.LegacyGraphics();
    graphic.zIndex = 100;
    for (const key of workingCells) {
      const cell = parseCellKey(key);
      if (cell) drawCell(graphic, cell, color, color, 0.38, 4);
    }
    this.container.addChild(graphic);
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
