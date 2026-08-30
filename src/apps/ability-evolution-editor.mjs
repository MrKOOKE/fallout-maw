import { TEMPLATES } from "../constants.mjs";
import {
  ABILITY_EVOLUTION_ZOOM_MAX,
  ABILITY_EVOLUTION_ZOOM_MIN,
  createDefaultAbilityEvolution,
  findAbilityInEvolutionFamily,
  normalizeAbilityEntry,
  normalizeAbilityEvolutionViewport
} from "../settings/abilities.mjs";
import { createAbilityCatalogCopy } from "../utils/ability-catalog-copy.mjs";
import {
  clampGraphViewportToVisibleNode,
  readGraphViewportMetrics
} from "../utils/graph-viewport.mjs";
import { FalloutMaWFormApplicationV2 } from "./base-form-application-v2.mjs";

const { DialogV2 } = foundry.applications.api;
const NODE_WIDTH = 190;
const NODE_HEIGHT = 82;
const SIBLING_X_GAP = 230;
const CHILD_Y_GAP = 150;
const GRID_SIZE = 24;
const MAJOR_GRID_SIZE = 120;

export class AbilityEvolutionEditor extends FalloutMaWFormApplicationV2 {
  #selectedId;
  #childEditors = new Set();
  #closing = false;
  #closeSavePromise = null;
  #pointerState = null;
  #suppressSelectClick = false;
  #viewportResizeObserver = null;
  #viewportMetrics = null;
  #nodeById = new Map();
  #nodeElements = new Map();
  #linkElements = new Map();
  #linksByNodeId = new Map();

  constructor(host, categoryId, rootAbilityId, options = {}) {
    super(options);
    this.host = host;
    this.categoryId = categoryId;
    this.rootAbilityId = rootAbilityId;
    this.rootAbility = normalizeAbilityEntry(host.getAbility(categoryId, rootAbilityId));
    this.#selectedId = this.rootAbility.id;
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-ability-evolution-editor",
    classes: ["fallout-maw", "fallout-maw-config-form", "ability-evolution-editor"],
    position: { width: 1040, height: 760 },
    window: { resizable: true },
    actions: {
      selectEvolutionNode: this.#onSelectNode,
      addEvolutionNode: this.#onAddNode,
      editEvolutionNode: this.#onEditNode,
      deleteEvolutionNode: this.#onDeleteNode,
      resetEvolutionView: this.#onResetView
    }
  };

  static PARTS = {
    form: { template: TEMPLATES.settings.abilityEvolutionEditor }
  };

  get title() {
    return `Эволюция: ${this.rootAbility.name}`;
  }

  get evolution() {
    return this.rootAbility.system.evolution;
  }

  getAbility(_categoryId, abilityId) {
    return findAbilityInEvolutionFamily(this.rootAbility, abilityId)?.ability ?? null;
  }

  releaseChildEditor(editor) {
    this.#childEditors.delete(editor);
  }

  async saveAbility(_categoryId, ability) {
    const normalized = normalizeAbilityEntry(ability);
    if (normalized.id === this.rootAbility.id) {
      this.rootAbility = normalized;
    } else {
      const found = findAbilityInEvolutionFamily(this.rootAbility, normalized.id);
      const node = found?.ownerAbility?.system?.evolution?.nodes
        ?.find(entry => entry.id === normalized.id);
      if (!node) return null;
      node.ability = normalized;
      this.rootAbility = normalizeAbilityEntry(this.rootAbility);
    }
    if (!this.#closing) await this.render();
    return findAbilityInEvolutionFamily(this.rootAbility, normalized.id)?.ability ?? null;
  }

  async _prepareContext(options) {
    const nodeById = new Map([
      [this.rootAbility.id, { id: this.rootAbility.id, x: 0, y: 0, ability: this.rootAbility, isRoot: true }],
      ...this.evolution.nodes.map(node => [node.id, { ...node, isRoot: false }])
    ]);
    const nodes = Array.from(nodeById.values()).map(node => ({
      ...node,
      selected: node.id === this.#selectedId,
      childCount: this.evolution.links.filter(link => link.fromId === node.id).length
    }));
    const links = this.evolution.links.map(link => {
      const source = nodeById.get(link.fromId);
      const target = nodeById.get(link.toId);
      return source && target ? {
        ...link,
        path: buildLinkPath(source, target)
      } : null;
    }).filter(Boolean);
    const selected = nodeById.get(this.#selectedId) ?? nodeById.get(this.rootAbility.id);
    return {
      ...(await super._prepareContext(options)),
      rootAbility: this.rootAbility,
      nodes,
      links,
      viewport: this.evolution.viewport,
      canEditSelected: Boolean(selected && !selected.isRoot),
      canDeleteSelected: Boolean(selected && !selected.isRoot)
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const viewport = this.element?.querySelector?.("[data-evolution-viewport]");
    if (!viewport) return;
    viewport.addEventListener("wheel", event => this.#onWheel(event), { passive: false });
    viewport.addEventListener("pointerdown", event => this.#onPointerDown(event));
    viewport.addEventListener("pointermove", event => this.#onPointerMove(event));
    viewport.addEventListener("pointerup", event => this.#onPointerUp(event));
    viewport.addEventListener("pointercancel", event => this.#onPointerUp(event));
    viewport.addEventListener("contextmenu", event => event.preventDefault());
    this.#nodeById = new Map([
      [this.rootAbility.id, { id: this.rootAbility.id, x: 0, y: 0, ability: this.rootAbility }],
      ...this.evolution.nodes.map(node => [node.id, node])
    ]);
    this.#nodeElements = new Map(Array.from(
      viewport.querySelectorAll("[data-evolution-node]"),
      node => [node.dataset.nodeId, node]
    ));
    this.#linkElements = new Map(Array.from(
      viewport.querySelectorAll("[data-evolution-link-id]"),
      path => [path.dataset.evolutionLinkId, path]
    ));
    this.#linksByNodeId = new Map();
    for (const link of this.evolution.links) {
      for (const nodeId of [link.fromId, link.toId]) {
        const links = this.#linksByNodeId.get(nodeId) ?? [];
        links.push(link);
        this.#linksByNodeId.set(nodeId, links);
      }
    }
    this.#nodeElements.forEach(node => {
      node.addEventListener("dblclick", event => {
        event.preventDefault();
        event.stopPropagation();
        void this.#openNodeEditor(node.dataset.nodeId);
      });
    });
    this.#viewportMetrics = readGraphViewportMetrics(viewport);
    this.#applyViewportTransform();
    this.#viewportResizeObserver?.disconnect();
    const view = viewport.ownerDocument?.defaultView ?? globalThis.window;
    if (typeof view.ResizeObserver === "function") {
      this.#viewportResizeObserver = new view.ResizeObserver(() => {
        this.#viewportMetrics = readGraphViewportMetrics(viewport);
        this.#applyViewportTransform();
      });
      this.#viewportResizeObserver.observe(viewport);
    }
  }

  _processFormData() {
    return this.rootAbility;
  }

  close(options = {}) {
    if (!this.#closeSavePromise) {
      this.#closing = true;
      this.#closeSavePromise = this.#saveAndClose(options);
    }
    return this.#closeSavePromise;
  }

  async #saveAndClose(options) {
    await this.#closeChildEditors();
    this.host.syncAbilityDraft?.();
    const hostRoot = this.host.getAbility(this.categoryId, this.rootAbility.id) ?? this.rootAbility;
    this.rootAbility = normalizeAbilityEntry({
      ...hostRoot,
      system: {
        ...(hostRoot.system ?? {}),
        evolution: this.rootAbility.system.evolution
      }
    });
    const saved = await this.host.saveAbility(this.categoryId, this.rootAbility);
    if (saved) this.rootAbility = normalizeAbilityEntry(saved);
    this.#viewportResizeObserver?.disconnect();
    this.#viewportResizeObserver = null;
    this.#viewportMetrics = null;
    try {
      return await super.close(options);
    } finally {
      this.host.releaseChildEditor?.(this);
    }
  }

  async #closeChildEditors() {
    for (const editor of [...this.#childEditors]) {
      await editor.close();
      this.#childEditors.delete(editor);
    }
  }

  static #onSelectNode(event, target) {
    event.preventDefault();
    if (this.#suppressSelectClick) return undefined;
    this.#selectedId = target.dataset.nodeId || this.rootAbility.id;
    return this.render();
  }

  static #onAddNode(event) {
    event.preventDefault();
    const parentId = this.#selectedId || this.rootAbility.id;
    const parentNode = parentId === this.rootAbility.id
      ? { x: 0, y: 0, ability: this.rootAbility }
      : this.evolution.nodes.find(node => node.id === parentId);
    if (!parentNode) return undefined;
    const siblings = this.evolution.links.filter(link => link.fromId === parentId);
    const id = createUniqueNodeId(this.rootAbility);
    const node = {
      id,
      x: snapToGrid(parentNode.x + getSiblingXOffset(siblings.length)),
      y: snapToGrid(parentNode.y + CHILD_Y_GAP),
      ability: normalizeAbilityEntry(createAbilityCatalogCopy({
        ...parentNode.ability,
        system: {
          ...(parentNode.ability.system ?? {}),
          evolution: createDefaultAbilityEvolution()
        }
      }, {
        id,
        existingNames: [
          this.rootAbility.name,
          ...this.evolution.nodes.map(entry => entry.ability.name)
        ]
      }))
    };
    this.evolution.nodes.push(node);
    this.evolution.links.push({
      id: foundry.utils.randomID(),
      fromId: parentId,
      toId: id
    });
    this.rootAbility = normalizeAbilityEntry(this.rootAbility);
    this.#selectedId = id;
    return this.render().then(() => this.#openNodeEditor(id));
  }

  static #onEditNode(event) {
    event.preventDefault();
    return this.#openNodeEditor(this.#selectedId);
  }

  static async #onDeleteNode(event) {
    event.preventDefault();
    const selectedId = this.#selectedId;
    if (!selectedId || selectedId === this.rootAbility.id) return undefined;
    const selected = this.evolution.nodes.find(node => node.id === selectedId);
    if (!selected) return undefined;
    const confirmed = await DialogV2.confirm({
      window: { title: "Удалить эволюцию" },
      content: `<p>Удалить «${foundry.utils.escapeHTML(selected.ability.name)}» и все следующие узлы этой ветки?</p>`,
      yes: { label: "Удалить" },
      no: { label: "Отмена" }
    });
    if (!confirmed) return undefined;
    const removedIds = collectDescendantIds(this.evolution, selectedId);
    this.evolution.nodes = this.evolution.nodes.filter(node => !removedIds.has(node.id));
    this.evolution.links = this.evolution.links.filter(link => (
      !removedIds.has(link.fromId) && !removedIds.has(link.toId)
    ));
    this.#selectedId = this.rootAbility.id;
    this.rootAbility = normalizeAbilityEntry(this.rootAbility);
    return this.render();
  }

  static #onResetView(event) {
    event.preventDefault();
    this.evolution.viewport = { x: 0, y: 0, zoom: 1 };
    this.#applyViewportTransform();
  }

  async #openNodeEditor(nodeId) {
    const abilityId = String(nodeId ?? "").trim() || this.rootAbility.id;
    if (abilityId === this.rootAbility.id) return undefined;
    await this.#closeChildEditors();
    const { AbilityCatalogItemEditor } = await import("./ability-catalog-item-editor.mjs");
    const editor = new AbilityCatalogItemEditor(this, this.categoryId, abilityId, {
      id: `fallout-maw-evolution-node-editor-${abilityId}`,
      isEvolutionNode: true,
      position: {
        top: (this.position.top ?? 40) + 28,
        left: (this.position.left ?? 40) + 28
      }
    });
    this.#childEditors.add(editor);
    try {
      return await this.renderChild(editor);
    } catch (error) {
      this.#childEditors.delete(editor);
      throw error;
    }
  }

  #onWheel(event) {
    event.preventDefault();
    const viewportElement = event.currentTarget;
    const metrics = readGraphViewportMetrics(viewportElement);
    this.#viewportMetrics = metrics;
    const current = this.evolution.viewport;
    const nextZoom = Math.max(
      ABILITY_EVOLUTION_ZOOM_MIN,
      Math.min(ABILITY_EVOLUTION_ZOOM_MAX, current.zoom * (event.deltaY < 0 ? 1.1 : 0.9))
    );
    if (nextZoom === current.zoom) return;
    const originX = ((event.clientX - metrics.left) / metrics.scaleX) - (metrics.width / 2);
    const originY = ((event.clientY - metrics.top) / metrics.scaleY) - (metrics.height / 2);
    const scale = nextZoom / current.zoom;
    this.evolution.viewport = normalizeAbilityEvolutionViewport({
      x: originX - ((originX - current.x) * scale),
      y: originY - ((originY - current.y) * scale),
      zoom: nextZoom
    });
    this.#applyViewportTransform();
    if (this.#pointerState?.mode === "pan") {
      this.#pointerState.startClientX = event.clientX;
      this.#pointerState.startClientY = event.clientY;
      this.#pointerState.startX = this.evolution.viewport.x;
      this.#pointerState.startY = this.evolution.viewport.y;
      this.#pointerState.screenScaleX = metrics.scaleX;
      this.#pointerState.screenScaleY = metrics.scaleY;
    }
  }

  #onPointerDown(event) {
    const viewport = event.currentTarget;
    const nodeElement = event.target.closest?.("[data-evolution-node]");
    const nodeId = nodeElement?.dataset.nodeId ?? "";
    const draggableNode = nodeId && nodeId !== this.rootAbility.id ? this.#nodeById.get(nodeId) : null;
    const dragNode = event.button === 0 && draggableNode;
    const panCamera = event.button === 2;
    if (!dragNode && !panCamera) return;
    if (panCamera) event.preventDefault();
    const metrics = readGraphViewportMetrics(viewport);
    this.#viewportMetrics = metrics;
    const captureElement = dragNode ? nodeElement : viewport;
    this.#pointerState = {
      pointerId: event.pointerId,
      mode: dragNode ? "node" : "pan",
      nodeId,
      captureElement,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: dragNode?.x ?? this.evolution.viewport.x,
      startY: dragNode?.y ?? this.evolution.viewport.y,
      screenScaleX: metrics.scaleX,
      screenScaleY: metrics.scaleY,
      moved: false
    };
    captureElement?.setPointerCapture?.(event.pointerId);
    viewport.classList.add(dragNode ? "dragging-node" : "panning");
  }

  #onPointerMove(event) {
    const state = this.#pointerState;
    if (!state || state.pointerId !== event.pointerId) return;
    event.preventDefault();
    const samples = event.getCoalescedEvents?.();
    const pointer = samples?.length ? samples[samples.length - 1] : event;
    const screenDx = pointer.clientX - state.startClientX;
    const screenDy = pointer.clientY - state.startClientY;
    if (!state.moved && Math.hypot(screenDx, screenDy) < 3) return;
    state.moved = true;
    const dx = screenDx / state.screenScaleX;
    const dy = screenDy / state.screenScaleY;
    if (state.mode === "pan") {
      this.evolution.viewport.x = state.startX + dx;
      this.evolution.viewport.y = state.startY + dy;
      this.#applyViewportTransform();
      return;
    }
    const node = this.#nodeById.get(state.nodeId);
    if (!node) return;
    const x = state.startX + (dx / this.evolution.viewport.zoom);
    const y = state.startY + (dy / this.evolution.viewport.zoom);
    const nextX = pointer.shiftKey ? x : snapToGrid(x);
    const nextY = pointer.shiftKey ? y : snapToGrid(y);
    if (node.x === nextX && node.y === nextY) return;
    node.x = nextX;
    node.y = nextY;
    this.#drawNode(node.id);
  }

  #onPointerUp(event) {
    const state = this.#pointerState;
    if (!state || state.pointerId !== event.pointerId) return;
    if (event.type === "pointerup") this.#onPointerMove(event);
    state.captureElement?.releasePointerCapture?.(event.pointerId);
    event.currentTarget.classList.remove("panning", "dragging-node");
    this.#pointerState = null;
    if (state.mode === "node" && state.moved) {
      this.#suppressSelectClick = true;
      const view = event.currentTarget?.ownerDocument?.defaultView ?? globalThis.window;
      view.setTimeout(() => {
        this.#suppressSelectClick = false;
      }, 0);
      this.#applyViewportTransform();
    }
  }

  #applyViewportTransform() {
    const stage = this.element?.querySelector?.("[data-evolution-stage]");
    const viewport = this.element?.querySelector?.("[data-evolution-viewport]");
    if (!stage || !viewport) return;
    const metrics = this.#viewportMetrics ?? readGraphViewportMetrics(viewport);
    this.#viewportMetrics = metrics;
    const constrained = clampGraphViewportToVisibleNode(this.evolution.viewport, {
      height: metrics.height,
      nodeHeight: NODE_HEIGHT,
      nodeWidth: NODE_WIDTH,
      nodes: this.#nodeById.values(),
      originX: metrics.width / 2,
      originY: metrics.height / 2,
      width: metrics.width
    });
    this.evolution.viewport = constrained;
    const { x, y, zoom } = constrained;
    const view = stage.ownerDocument?.defaultView ?? globalThis.window;
    const offsetX = snapToDevicePixel((metrics.width / 2) + x, view);
    const offsetY = snapToDevicePixel((metrics.height / 2) + y, view);
    stage.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${zoom})`;
    viewport.style.backgroundPosition = [
      `${offsetX}px ${offsetY}px`,
      `${offsetX}px ${offsetY}px`,
      `${offsetX}px ${offsetY}px`
    ].join(", ");
    viewport.style.backgroundSize = [
      `${GRID_SIZE * zoom}px ${GRID_SIZE * zoom}px`,
      `${MAJOR_GRID_SIZE * zoom}px ${MAJOR_GRID_SIZE * zoom}px`,
      `${MAJOR_GRID_SIZE * zoom}px ${MAJOR_GRID_SIZE * zoom}px`
    ].join(", ");
    const zoomLabel = this.element?.querySelector?.("[data-evolution-zoom-label]");
    if (zoomLabel) zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  }

  #drawNode(nodeId) {
    const node = this.#nodeById.get(nodeId);
    const element = this.#nodeElements.get(nodeId);
    if (!node || !element) return;
    element.style.left = `${node.x}px`;
    element.style.top = `${node.y}px`;
    for (const link of this.#linksByNodeId.get(nodeId) ?? []) {
      const path = this.#linkElements.get(link.id);
      const source = this.#nodeById.get(link.fromId);
      const target = this.#nodeById.get(link.toId);
      if (path && source && target) path.setAttribute("d", buildLinkPath(source, target));
    }
  }
}

function buildLinkPath(source, target) {
  const startX = Number(source.x) + (NODE_WIDTH / 2);
  const startY = Number(source.y) + NODE_HEIGHT;
  const endX = Number(target.x) + (NODE_WIDTH / 2);
  const endY = Number(target.y);
  const direction = endY >= startY ? 1 : -1;
  const handle = Math.max(24, Math.abs(endY - startY) * 0.45);
  return `M ${startX} ${startY} C ${startX} ${startY + (direction * handle)}, ${endX} ${endY - (direction * handle)}, ${endX} ${endY}`;
}

function getSiblingXOffset(index = 0) {
  const normalizedIndex = Math.max(0, Number(index) || 0);
  if (!normalizedIndex) return 0;
  const distance = Math.ceil(normalizedIndex / 2) * SIBLING_X_GAP;
  return normalizedIndex % 2 === 1 ? -distance : distance;
}

function createUniqueNodeId(rootAbility) {
  const occupied = new Set();
  const visit = ability => {
    if (ability?.id) occupied.add(ability.id);
    for (const node of ability?.system?.evolution?.nodes ?? []) visit(node.ability);
  };
  visit(rootAbility);
  let id = foundry.utils.randomID();
  let suffix = 2;
  while (occupied.has(id)) id = `evolution-${suffix++}`;
  return id;
}

function collectDescendantIds(evolution, sourceId) {
  const removed = new Set([sourceId]);
  const pending = [sourceId];
  while (pending.length) {
    const parentId = pending.pop();
    for (const link of evolution.links) {
      if (link.fromId !== parentId || removed.has(link.toId)) continue;
      removed.add(link.toId);
      pending.push(link.toId);
    }
  }
  return removed;
}

function snapToDevicePixel(value, view = globalThis.window) {
  const ratio = Math.max(1, Number(view?.devicePixelRatio) || 1);
  return Math.round((Number(value) || 0) * ratio) / ratio;
}

function snapToGrid(value, size = GRID_SIZE) {
  return Math.round((Number(value) || 0) / size) * size;
}
