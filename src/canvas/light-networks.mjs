import { SYSTEM_ID, TEMPLATES } from "../constants.mjs";

const CoreAmbientLightConfig = foundry.applications.sheets.AmbientLightConfig;
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const { FormDataExtended } = foundry.applications.ux;

const LIGHT_NETWORK_FLAG = "lightNetwork";
const LIGHT_NETWORK_INTERACTION_FLAG = "lightNetworkInteraction";
const LIGHT_NETWORK_SOCKET = `system.${SYSTEM_ID}`;
const LIGHT_NETWORK_SOCKET_SCOPE = "fallout-maw.lightNetworks";
const DEFAULT_INTERACTION_IMAGE = "icons/svg/light.svg";
const DEFAULT_INTERACTION_SCALE = 0.5;
const PLACEMENT_PREVIEW_BORDER_COLOR = 0xf0cf55;
const PLACEMENT_PREVIEW_FILL_COLOR = 0xf0cf55;
const NETWORK_BASIC_TEMPLATE = `systems/${SYSTEM_ID}/templates/scene/parts/light-network-basic.hbs`;
const LIGHT_BASIC_TEMPLATE = `systems/${SYSTEM_ID}/templates/scene/parts/light-basic-network.hbs`;
const TRIMMED_EMPTY_NETWORK_LABEL = "Индивидуальная сеть";
const BLOCKED_PLACEMENT_EVENTS = Object.freeze([
  "pointermove",
  "pointerdown",
  "mousedown",
  "pointerup",
  "mouseup",
  "click",
  "dblclick",
  "auxclick",
  "contextmenu"
]);

let activePlacement = null;
let doubleClickRegistered = false;
let socketRegistered = false;
let networkTilePatchRegistered = false;

export class AmbientLightConfig extends CoreAmbientLightConfig {
  static PARTS = {
    ...super.PARTS,
    basic: {
      template: LIGHT_BASIC_TEMPLATE
    }
  };

  static DEFAULT_OPTIONS = foundry.utils.mergeObject(super.DEFAULT_OPTIONS, {
    actions: {
      openLightNetworkConfig: AmbientLightConfig.#onOpenLightNetworkConfig
    }
  }, { inplace: false });

  static #onOpenLightNetworkConfig(event) {
    event.preventDefault();
    if (!this.document?.collection?.has(this.document.id)) {
      ui.notifications.warn("Сначала сохраните источник света, затем настройте сеть.");
      return undefined;
    }
    this.renderChild(new FalloutMaWLightNetworkConfig({
      document: this.document,
      position: {
        top: this.position.top + 24,
        left: this.position.left + 24
      }
    }));
    return true;
  }
}

class FalloutMaWLightNetworkConfig extends AmbientLightConfig {
  #pendingNetworkData = null;

  static PARTS = {
    ...super.PARTS,
    basic: {
      template: NETWORK_BASIC_TEMPLATE
    }
  };

  static DEFAULT_OPTIONS = foundry.utils.mergeObject(super.DEFAULT_OPTIONS, {
    id: "fallout-maw-light-network-config-{id}",
    classes: ["ambient-light-config", "fallout-maw-light-network-config"],
    position: { width: 600 },
    sheetConfig: false,
    ownershipConfig: false,
    preview: false,
    form: {
      closeOnSubmit: true
    },
    actions: {
      placeNetworkInteraction: FalloutMaWLightNetworkConfig.#onPlaceNetworkInteraction
    }
  }, { inplace: false });

  get title() {
    return `Сеть света: ${this.document?.name || "Источник света"}`;
  }

  async _initializePreview() {
    const network = getLightNetworkData(this.document);
    const data = network.onData ?? extractAmbientLightState(this.document);
    this._preview = this.document.clone(data);
    this._preview._destroyed = true;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    return {
      ...context,
      network: getLightNetworkData(this.document)
    };
  }

  _processFormData(event, form, formData) {
    const expanded = foundry.utils.expandObject(formData.object);
    this.#pendingNetworkData = normalizeNetworkMetadata(expanded.network ?? getLightNetworkData(this.document));
    delete expanded.network;
    return expanded;
  }

  async _processSubmitData(event, form, submitData, options = {}) {
    const network = {
      ...getLightNetworkData(this.document),
      ...this.#pendingNetworkData,
      onData: extractAmbientLightState(submitData)
    };
    await this.document.update({
      [`flags.${SYSTEM_ID}.${LIGHT_NETWORK_FLAG}`]: network
    }, options);
    if (network.active) {
      await applyLightNetworkState({
        sceneId: this.document.parent?.id ?? canvas.scene?.id ?? "",
        networkName: network.name,
        sourceLightUuid: this.document.uuid,
        enabled: true
      });
    }
  }

  static async #onPlaceNetworkInteraction(event) {
    event.preventDefault();
    if (!canvas?.ready || !canvas.scene) {
      ui.notifications.warn("Сцена не готова для размещения источника взаимодействия.");
      return false;
    }
    const formData = new FormDataExtended(this.form);
    const submitData = this._prepareSubmitData(event, this.form, formData);
    await this._processSubmitData(event, this.form, submitData, { render: false });
    const network = getLightNetworkData(this.document);
    const parent = this.parent;
    await this.close();
    await parent?.close?.();
    return startLightNetworkInteractionPlacement({
      sourceLight: this.document,
      networkName: network.name,
      image: network.interactionImage,
      scale: network.interactionScale,
      parentConfig: parent,
      networkConfig: this
    });
  }
}

class LightNetworkInteractionDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  #tile = null;

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-light-network-interaction-{id}",
    classes: ["fallout-maw", "fallout-maw-light-network-interaction-dialog"],
    position: {
      width: 360,
      height: "auto"
    },
    window: {
      resizable: false
    },
    actions: {
      toggleNetwork: LightNetworkInteractionDialog.#onToggleNetwork,
      deleteInteraction: LightNetworkInteractionDialog.#onDeleteInteraction
    }
  };

  static PARTS = {
    body: {
      template: TEMPLATES.lightNetworkInteractionDialog
    }
  };

  constructor({ tile } = {}) {
    super();
    this.#tile = tile;
  }

  get title() {
    const interaction = getLightNetworkInteractionFlag(this.#tile);
    return `Сеть: ${getNetworkDisplayName(interaction?.networkName)}`;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const interaction = getLightNetworkInteractionFlag(this.#tile);
    return {
      ...context,
      networkLabel: getNetworkDisplayName(interaction?.networkName),
      enabled: isLightNetworkEnabled({
        scene: this.#tile?.parent ?? canvas.scene,
        networkName: interaction?.networkName,
        sourceLightUuid: interaction?.sourceLightUuid
      }),
      canDelete: shouldShowGmInteractionDelete()
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.element?.querySelector("[data-action='toggleNetwork']")?.addEventListener("keydown", event => {
      if (!["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      event.currentTarget.click();
    });
  }

  static async #onToggleNetwork(event) {
    event.preventDefault();
    const interaction = getLightNetworkInteractionFlag(this.#tile);
    if (!interaction) return false;
    const enabled = !isLightNetworkEnabled({
      scene: this.#tile?.parent ?? canvas.scene,
      networkName: interaction.networkName,
      sourceLightUuid: interaction.sourceLightUuid
    });
    await requestLightNetworkState({
      sceneId: this.#tile?.parent?.id ?? canvas.scene?.id ?? "",
      networkName: interaction.networkName,
      sourceLightUuid: interaction.sourceLightUuid,
      enabled
    });
    await this.render({ force: true });
    return true;
  }

  static async #onDeleteInteraction(event) {
    event.preventDefault();
    if (!shouldShowGmInteractionDelete() || !this.#tile) return false;
    await this.#tile.delete();
    await this.close();
    refreshLightNetworkInteractionTileVisibility();
    return true;
  }
}

export function registerLightNetworkHooks() {
  patchLightNetworkInteractionTileVisibility();
  Hooks.on("canvasReady", () => {
    patchLightNetworkInteractionTileVisibility();
    registerLightNetworkDoubleClickListener();
    refreshLightNetworkInteractionTileVisibility();
  });
  Hooks.on("controlToken", refreshLightNetworkInteractionTileVisibility);
  Hooks.on("sightRefresh", refreshLightNetworkInteractionTileVisibility);
  Hooks.on("visibilityRefresh", refreshLightNetworkInteractionTileVisibility);
  Hooks.on("createTile", tile => {
    if (isLightNetworkInteractionTileDocument(tile)) refreshLightNetworkInteractionTileVisibility();
  });
  Hooks.on("updateTile", tile => {
    if (isLightNetworkInteractionTileDocument(tile)) refreshLightNetworkInteractionTileVisibility();
  });
  Hooks.on("deleteTile", tile => {
    if (isLightNetworkInteractionTileDocument(tile)) refreshLightNetworkInteractionTileVisibility();
  });
  Hooks.on("canvasTearDown", () => {
    cancelLightNetworkInteractionPlacement();
    doubleClickRegistered = false;
  });
}

export function registerLightNetworkSocket() {
  if (socketRegistered) return;
  game.socket.on(LIGHT_NETWORK_SOCKET, handleLightNetworkSocketMessage);
  socketRegistered = true;
}

function registerLightNetworkDoubleClickListener() {
  const view = canvas?.app?.view;
  if (doubleClickRegistered || !view) return;
  view.addEventListener("dblclick", onLightNetworkCanvasDoubleClick, { capture: true });
  doubleClickRegistered = true;
}

function onLightNetworkCanvasDoubleClick(event) {
  const tile = getLightNetworkInteractionTileAtEvent(event);
  if (!tile) return;
  event.preventDefault?.();
  event.stopPropagation?.();
  event.stopImmediatePropagation?.();
  new LightNetworkInteractionDialog({ tile }).render({ force: true });
}

async function startLightNetworkInteractionPlacement({ sourceLight, networkName = "", image = "", scale = DEFAULT_INTERACTION_SCALE, parentConfig = null, networkConfig = null } = {}) {
  if (!game.user?.isGM) {
    ui.notifications.warn("Размещать источник взаимодействия сети может только GM.");
    return false;
  }
  if (!sourceLight?.uuid || !canvas?.ready || !canvas.scene) {
    ui.notifications.warn("Сцена не готова для размещения источника взаимодействия.");
    return false;
  }
  cancelLightNetworkInteractionPlacement();
  activePlacement = {
    sourceLightUuid: sourceLight.uuid,
    networkName: normalizeNetworkName(networkName),
    image: normalizeInteractionImage(image),
    scale: normalizeInteractionScale(scale),
    parentConfig,
    networkConfig,
    inputShield: createPlacementInputShield()
  };
  await createLightNetworkPlacementPreview(activePlacement);
  bindPlacementInput(activePlacement);
  window.addEventListener("keydown", onPlacementKeyDown, { capture: true });
  ui.notifications.info("Выберите место для источника взаимодействия сети. Esc/ПКМ отменяет.");
  return true;
}

function cancelLightNetworkInteractionPlacement({ notify = false, reopen = false } = {}) {
  if (!activePlacement) return;
  const placement = activePlacement;
  activePlacement = null;
  unbindPlacementInput(placement);
  window.removeEventListener("keydown", onPlacementKeyDown, { capture: true });
  destroyLightNetworkPlacementPreview(placement);
  placement.inputShield?.remove?.();
  if (notify) ui.notifications.info("Размещение источника взаимодействия сети отменено.");
  if (reopen) void reopenLightNetworkConfigWindows(placement);
}

function bindPlacementInput(placement) {
  const targets = [canvas?.app?.view, placement.inputShield].filter(Boolean);
  for (const target of targets) {
    for (const type of BLOCKED_PLACEMENT_EVENTS) {
      target.addEventListener(type, onPlacementCanvasEvent, true);
    }
  }
  placement.targets = targets;
}

function unbindPlacementInput(placement) {
  for (const target of placement?.targets ?? []) {
    for (const type of BLOCKED_PLACEMENT_EVENTS) {
      target.removeEventListener(type, onPlacementCanvasEvent, true);
    }
  }
  placement.targets = [];
}

function createPlacementInputShield() {
  const shield = document.createElement("div");
  Object.assign(shield.style, {
    position: "fixed",
    inset: "0",
    zIndex: "100000",
    background: "transparent",
    cursor: "crosshair",
    pointerEvents: "auto"
  });
  document.body.appendChild(shield);
  return shield;
}

function onPlacementCanvasEvent(event) {
  if (!activePlacement) return;
  event.preventDefault?.();
  event.stopPropagation?.();
  event.stopImmediatePropagation?.();
  if (event.type === "contextmenu" || event.type === "auxclick" || event.button === 2) {
    cancelLightNetworkInteractionPlacement({ notify: true, reopen: true });
    return;
  }
  if (event.type === "pointermove") {
    const point = canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
    updateLightNetworkPlacementPreview(activePlacement, point);
    return;
  }
  if (!["pointerdown", "mousedown"].includes(event.type) || event.button !== 0) return;
  void finishLightNetworkInteractionPlacement(event);
}

function onPlacementKeyDown(event) {
  if (!activePlacement) return;
  event.preventDefault?.();
  event.stopPropagation?.();
  event.stopImmediatePropagation?.();
  if (event.key === "Escape") cancelLightNetworkInteractionPlacement({ notify: true, reopen: true });
}

async function finishLightNetworkInteractionPlacement(event) {
  const placement = activePlacement;
  if (!placement || !canvas?.scene) return;
  const point = canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
  const size = getSceneGridSize(canvas.scene);
  const center = getSnappedTileCenter(point, canvas.scene, size, size);
  cancelLightNetworkInteractionPlacement();
  await canvas.scene.createEmbeddedDocuments("Tile", [{
    name: `Сеть: ${getNetworkDisplayName(placement.networkName)}`,
    x: Math.round(center.x),
    y: Math.round(center.y),
    width: size,
    height: size,
    elevation: 0,
    texture: {
      src: placement.image,
      anchorX: 0.5,
      anchorY: 0.5,
      fit: "contain",
      scaleX: placement.scale,
      scaleY: placement.scale
    },
    sort: getNextTileSort(canvas.scene),
    hidden: false,
    locked: true,
    flags: {
      [SYSTEM_ID]: {
        [LIGHT_NETWORK_INTERACTION_FLAG]: {
          networkName: placement.networkName,
          sourceLightUuid: placement.sourceLightUuid,
          image: placement.image,
          scale: placement.scale
        }
      }
    }
  }]);
}

async function reopenLightNetworkConfigWindows(placement) {
  const parent = placement?.parentConfig;
  const network = placement?.networkConfig;
  if (!parent || !network) return;
  await parent.render({ force: true });
  await parent.renderChild(network);
}

async function createLightNetworkPlacementPreview(placement) {
  const layer = canvas?.stage;
  if (!layer || !placement) return;
  const container = new PIXI.Container();
  container.eventMode = "none";
  const graphics = new PIXI.Graphics();
  container.addChild(graphics);
  let sprite = null;
  try {
    const texture = await foundry.canvas.loadTexture(placement.image);
    if (texture?.valid) {
      sprite = new PIXI.Sprite(texture);
      sprite.alpha = 0.55;
      container.addChild(sprite);
    }
  } catch (error) {
    console.warn(`${SYSTEM_ID} | Light network placement preview texture failed to load: ${placement.image}`, error);
  }
  layer.addChild(container);
  placement.preview = { container, graphics, sprite };
}

function updateLightNetworkPlacementPreview(placement, point) {
  const preview = placement?.preview;
  if (!preview?.container || !canvas?.scene) return;
  const size = getSceneGridSize(canvas.scene);
  const center = getSnappedTileCenter(point, canvas.scene, size, size);
  const rect = {
    x: Math.round(center.x - (size / 2)),
    y: Math.round(center.y - (size / 2)),
    width: size,
    height: size
  };
  preview.container.position.set(rect.x, rect.y);
  preview.graphics.clear()
    .lineStyle(3, PLACEMENT_PREVIEW_BORDER_COLOR, 0.95)
    .beginFill(PLACEMENT_PREVIEW_FILL_COLOR, 0.12)
    .drawRect(0, 0, rect.width, rect.height)
    .endFill();
  if (preview.sprite) fitSpriteIntoRect(preview.sprite, rect.width, rect.height, placement.scale);
}

function destroyLightNetworkPlacementPreview(placement) {
  const preview = placement?.preview;
  if (!preview?.container) return;
  preview.container.destroy({ children: true, texture: false, baseTexture: false });
  placement.preview = null;
}

async function requestLightNetworkState({ sceneId = "", networkName = "", sourceLightUuid = "", enabled = false } = {}) {
  const request = {
    sceneId,
    networkName: normalizeNetworkName(networkName),
    sourceLightUuid: String(sourceLightUuid ?? ""),
    enabled: Boolean(enabled)
  };
  if (game.user?.isActiveGM) return applyLightNetworkState(request);
  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("Нет активного GM для переключения сети света.");
    return false;
  }
  game.socket.emit(LIGHT_NETWORK_SOCKET, {
    scope: LIGHT_NETWORK_SOCKET_SCOPE,
    action: "setLightNetworkState",
    gmUserId: gm.id,
    request
  });
  return true;
}

async function handleLightNetworkSocketMessage(message = {}) {
  if (message?.scope !== LIGHT_NETWORK_SOCKET_SCOPE) return;
  if (message.gmUserId && message.gmUserId !== game.user?.id) return;
  if (!game.user?.isActiveGM) return;
  if (message.action === "setLightNetworkState") await applyLightNetworkState(message.request);
}

async function applyLightNetworkState({ sceneId = "", networkName = "", sourceLightUuid = "", enabled = false } = {}) {
  const scene = game.scenes?.get(sceneId) ?? canvas.scene;
  if (!scene) return false;
  const lights = getMatchingNetworkLights(scene, {
    networkName: normalizeNetworkName(networkName),
    sourceLightUuid
  });
  if (!lights.length) {
    ui.notifications.warn("Не найдены источники света для этой сети.");
    return false;
  }

  const updates = [];
  for (const light of lights) {
    const network = getLightNetworkData(light);
    if (enabled) {
      const baseData = network.active && network.baseData
        ? network.baseData
        : extractAmbientLightState(light);
      updates.push({
        _id: light.id,
        ...getLightNetworkStateUpdateData(network.onData ?? light),
        [`flags.${SYSTEM_ID}.${LIGHT_NETWORK_FLAG}.active`]: true,
        [`flags.${SYSTEM_ID}.${LIGHT_NETWORK_FLAG}.baseData`]: baseData
      });
    } else {
      const restoreData = network.baseData ? getLightNetworkStateUpdateData(network.baseData) : {};
      updates.push({
        _id: light.id,
        ...restoreData,
        [`flags.${SYSTEM_ID}.${LIGHT_NETWORK_FLAG}.active`]: false,
        [`flags.${SYSTEM_ID}.${LIGHT_NETWORK_FLAG}.baseData`]: null
      });
    }
  }
  await scene.updateEmbeddedDocuments("AmbientLight", updates);
  return true;
}

function getMatchingNetworkLights(scene, { networkName = "", sourceLightUuid = "" } = {}) {
  const normalizedName = normalizeNetworkName(networkName);
  const lights = scene?.lights?.contents ?? [];
  if (!normalizedName) {
    return lights.filter(light => light.uuid === sourceLightUuid);
  }
  return lights.filter(light => normalizeNetworkName(getLightNetworkData(light).name) === normalizedName);
}

function isLightNetworkEnabled({ scene = canvas.scene, networkName = "", sourceLightUuid = "" } = {}) {
  return getMatchingNetworkLights(scene, { networkName, sourceLightUuid })
    .some(light => getLightNetworkData(light).active);
}

function getLightNetworkInteractionTileAtEvent(event) {
  if (!Number.isFinite(Number(event?.clientX)) || !Number.isFinite(Number(event?.clientY))) return null;
  const point = canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
  return (canvas.scene?.tiles?.contents ?? [])
    .filter(tile => getLightNetworkInteractionFlag(tile) && isLightNetworkInteractionVisibleForCurrentViewer(tile) && isPointInsideTile(tile, point))
    .sort((left, right) => (Number(right.sort) || 0) - (Number(left.sort) || 0))
    .at(0) ?? null;
}

function patchLightNetworkInteractionTileVisibility() {
  if (networkTilePatchRegistered) return;
  const TileClass = CONFIG.Tile?.objectClass;
  if (!TileClass?.prototype) return;
  const originalRefreshVisibility = TileClass.prototype._refreshVisibility;
  const originalCanView = TileClass.prototype._canView;
  const originalCanHover = TileClass.prototype._canHover;

  TileClass.prototype._refreshVisibility = function(...args) {
    const result = originalRefreshVisibility?.apply(this, args);
    if (isLightNetworkInteractionTileDocument(this.document) && !isLightNetworkInteractionVisibleForCurrentViewer(this.document)) {
      this.visible = false;
      if (this.mesh) this.mesh.visible = false;
      if (this.bg) this.bg.visible = false;
      if (this.controls) this.controls.visible = false;
    }
    return result;
  };

  TileClass.prototype._canView = function(user, event) {
    if (isLightNetworkInteractionTileDocument(this.document) && !isLightNetworkInteractionVisibleForCurrentViewer(this.document)) return false;
    return originalCanView.call(this, user, event);
  };

  TileClass.prototype._canHover = function(user, event) {
    if (isLightNetworkInteractionTileDocument(this.document) && !isLightNetworkInteractionVisibleForCurrentViewer(this.document)) return false;
    return originalCanHover.call(this, user, event);
  };

  networkTilePatchRegistered = true;
}

function refreshLightNetworkInteractionTileVisibility() {
  for (const tile of canvas?.tiles?.placeables ?? []) {
    if (!isLightNetworkInteractionTileDocument(tile.document)) continue;
    tile.renderFlags?.set?.({ refreshVisibility: true, refreshState: true });
  }
}

function isLightNetworkInteractionVisibleForCurrentViewer(tileDocument) {
  if (!isLightNetworkInteractionTileDocument(tileDocument)) return true;
  const controlled = (canvas?.tokens?.controlled ?? []).filter(token => token?.actor);
  if (game.user?.isGM && !controlled.length) return true;
  if (!getLightNetworkCurrentViewerActors().length) return false;
  return isLightNetworkInteractionInCurrentVision(tileDocument);
}

function getLightNetworkCurrentViewerActors() {
  const controlled = (canvas?.tokens?.controlled ?? [])
    .map(token => token?.actor)
    .filter(Boolean);
  if (controlled.length) return controlled;
  return [game.user?.character].filter(Boolean);
}

function isLightNetworkInteractionInCurrentVision(tileDocument) {
  if (!canvas?.visibility || !canvas?.ready) return false;
  if (!canvas.visibility.tokenVision) return true;
  const points = getTileVisibilityTestPoints(tileDocument);
  const object = tileDocument?.object ?? tileDocument?.document?.object ?? null;
  return canvas.visibility.testVisibility(points, { tolerance: 0, object });
}

function getTileVisibilityTestPoints(tileDocument) {
  const rect = getTileRectangle(tileDocument);
  const elevation = Number(tileDocument?.elevation ?? tileDocument?.document?.elevation) || 0;
  const insetX = Math.min(rect.width / 4, Math.max(1, rect.width / 2));
  const insetY = Math.min(rect.height / 4, Math.max(1, rect.height / 2));
  return [
    { x: rect.x + (rect.width / 2), y: rect.y + (rect.height / 2), elevation },
    { x: rect.x + insetX, y: rect.y + insetY, elevation },
    { x: rect.x + rect.width - insetX, y: rect.y + insetY, elevation },
    { x: rect.x + rect.width - insetX, y: rect.y + rect.height - insetY, elevation },
    { x: rect.x + insetX, y: rect.y + rect.height - insetY, elevation }
  ];
}

function isPointInsideTile(tile, point) {
  const { x: left, y: top } = getTileTopLeft(tile);
  const { width, height } = getTileEffectiveDimensions(tile);
  return point.x >= left && point.x <= left + width && point.y >= top && point.y <= top + height;
}

function getTileTopLeft(tile) {
  const { width, height } = getTileEffectiveDimensions(tile);
  const texture = tile?.texture ?? tile?.document?.texture ?? {};
  const anchorX = Number.isFinite(Number(texture.anchorX)) ? Number(texture.anchorX) : 0.5;
  const anchorY = Number.isFinite(Number(texture.anchorY)) ? Number(texture.anchorY) : 0.5;
  return {
    x: (Number(tile?.x) || 0) - (anchorX * width),
    y: (Number(tile?.y) || 0) - (anchorY * height)
  };
}

function getTileRectangle(tile) {
  const topLeft = getTileTopLeft(tile);
  const dimensions = getTileEffectiveDimensions(tile);
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: dimensions.width,
    height: dimensions.height
  };
}

function fitSpriteIntoRect(sprite, width, height, imageScale = DEFAULT_INTERACTION_SCALE) {
  const textureWidth = Math.max(1, Number(sprite.texture?.width) || 1);
  const textureHeight = Math.max(1, Number(sprite.texture?.height) || 1);
  const scale = Math.min(width / textureWidth, height / textureHeight) * normalizeInteractionScale(imageScale);
  sprite.anchor.set(0.5, 0.5);
  sprite.scale.set(scale, scale);
  sprite.position.set(width / 2, height / 2);
}

function getTileEffectiveDimensions(tile) {
  return {
    width: Math.abs(Number(tile?.width) || 0),
    height: Math.abs(Number(tile?.height) || 0)
  };
}

function getSnappedTileCenter(point, scene, width, height) {
  const size = getSceneGridSize(scene);
  const source = { x: Number(point?.x) || 0, y: Number(point?.y) || 0 };
  if (canvas.scene?.id === scene?.id && canvas.grid && !canvas.grid.isGridless && canvas.grid.isSquare) {
    const modes = CONST.GRID_SNAPPING_MODES;
    const modeX = getTileCenterSnapMode(width, size, modes);
    const modeY = getTileCenterSnapMode(height, size, modes);
    if (canvas.grid.getSnappedPoint) {
      if (modeX === modeY) return canvas.grid.getSnappedPoint(source, { mode: modeX, resolution: 1 });
      return {
        x: canvas.grid.getSnappedPoint(source, { mode: modeX, resolution: 1 }).x,
        y: canvas.grid.getSnappedPoint(source, { mode: modeY, resolution: 1 }).y
      };
    }
  }
  return {
    x: snapTileCenterCoordinate(source.x, size, width),
    y: snapTileCenterCoordinate(source.y, size, height)
  };
}

function getTileCenterSnapMode(length, gridSize, modes) {
  const cells = Math.max(1, Math.round((Number(length) || gridSize) / gridSize));
  return cells % 2 === 0 ? modes.VERTEX : modes.CENTER;
}

function snapTileCenterCoordinate(value, gridSize, length) {
  const cells = Math.max(1, Math.round((Number(length) || gridSize) / gridSize));
  if (cells % 2 === 0) return Math.round((Number(value) || 0) / gridSize) * gridSize;
  return (Math.round(((Number(value) || 0) - (gridSize / 2)) / gridSize) * gridSize) + (gridSize / 2);
}

function getSceneGridSize(scene) {
  return Math.max(1, Number(scene?.grid?.size ?? canvas?.grid?.size ?? 100) || 100);
}

function getNextTileSort(scene) {
  return Math.max(0, ...(scene?.tiles?.contents ?? []).map(tile => Number(tile.sort) || 0)) + 1;
}

function getLightNetworkStateUpdateData(source) {
  const state = extractAmbientLightState(source);
  delete state.name;
  delete state.x;
  delete state.y;
  delete state.elevation;
  delete state.levels;
  delete state.rotation;
  return state;
}

function getLightNetworkData(light) {
  const stored = foundry.utils.deepClone(light?.getFlag?.(SYSTEM_ID, LIGHT_NETWORK_FLAG) ?? {});
  const fallback = extractAmbientLightState(light);
  return {
    name: normalizeNetworkName(stored.name),
    interactionImage: normalizeInteractionImage(stored.interactionImage),
    interactionScale: normalizeInteractionScale(stored.interactionScale),
    onData: stored.onData ? extractAmbientLightState(stored.onData) : fallback,
    active: Boolean(stored.active),
    baseData: stored.baseData ? extractAmbientLightState(stored.baseData) : null
  };
}

function getLightNetworkInteractionFlag(tile) {
  const stored = tile?.getFlag?.(SYSTEM_ID, LIGHT_NETWORK_INTERACTION_FLAG);
  if (!stored) return null;
  return {
    networkName: normalizeNetworkName(stored.networkName),
    sourceLightUuid: String(stored.sourceLightUuid ?? ""),
    image: normalizeInteractionImage(stored.image),
    scale: normalizeInteractionScale(stored.scale)
  };
}

function isLightNetworkInteractionTileDocument(tileDocument) {
  return Boolean(tileDocument?.getFlag?.(SYSTEM_ID, LIGHT_NETWORK_INTERACTION_FLAG));
}

function shouldShowGmInteractionDelete() {
  return Boolean(game.user?.isGM && !(canvas?.tokens?.controlled ?? []).length);
}

function normalizeNetworkMetadata(data = {}) {
  return {
    name: normalizeNetworkName(data.name),
    interactionImage: normalizeInteractionImage(data.interactionImage),
    interactionScale: normalizeInteractionScale(data.interactionScale)
  };
}

function normalizeNetworkName(value = "") {
  return String(value ?? "").trim();
}

function normalizeInteractionImage(value = "") {
  return String(value ?? "").trim() || DEFAULT_INTERACTION_IMAGE;
}

function normalizeInteractionScale(value = DEFAULT_INTERACTION_SCALE) {
  const scale = Number(value);
  return Number.isFinite(scale) && scale >= 0 ? scale : DEFAULT_INTERACTION_SCALE;
}

function getNetworkDisplayName(name = "") {
  return normalizeNetworkName(name) || TRIMMED_EMPTY_NETWORK_LABEL;
}

function extractAmbientLightState(source) {
  const raw = source?._source ?? source?.toObject?.() ?? source ?? {};
  const config = foundry.utils.deepClone(raw.config ?? {});
  return {
    name: String(raw.name ?? ""),
    x: Math.round(Number(raw.x) || 0),
    y: Math.round(Number(raw.y) || 0),
    elevation: Number(raw.elevation) || 0,
    levels: Array.from(raw.levels ?? []),
    rotation: Number(raw.rotation) || 0,
    walls: raw.walls !== false,
    vision: Boolean(raw.vision),
    config: {
      negative: Boolean(config.negative),
      priority: Math.max(0, Number(config.priority) || 0),
      alpha: Number.isFinite(Number(config.alpha)) ? Number(config.alpha) : 0.5,
      angle: Number.isFinite(Number(config.angle)) ? Number(config.angle) : 360,
      bright: Math.max(0, Number(config.bright) || 0),
      color: config.color ?? null,
      coloration: Number.isFinite(Number(config.coloration)) ? Number(config.coloration) : 1,
      dim: Math.max(0, Number(config.dim) || 0),
      attenuation: Number.isFinite(Number(config.attenuation)) ? Number(config.attenuation) : 0.5,
      luminosity: Number.isFinite(Number(config.luminosity)) ? Number(config.luminosity) : 0.5,
      saturation: Number.isFinite(Number(config.saturation)) ? Number(config.saturation) : 0,
      contrast: Number.isFinite(Number(config.contrast)) ? Number(config.contrast) : 0,
      shadows: Number.isFinite(Number(config.shadows)) ? Number(config.shadows) : 0,
      animation: {
        type: config.animation?.type || null,
        speed: Number.isFinite(Number(config.animation?.speed)) ? Number(config.animation.speed) : 5,
        intensity: Number.isFinite(Number(config.animation?.intensity)) ? Number(config.animation.intensity) : 5,
        reverse: Boolean(config.animation?.reverse)
      },
      darkness: {
        min: Number.isFinite(Number(config.darkness?.min)) ? Number(config.darkness.min) : 0,
        max: Number.isFinite(Number(config.darkness?.max)) ? Number(config.darkness.max) : 1
      }
    }
  };
}

function getResponsibleGM() {
  return game.users?.find(user => user.active && user.isGM) ?? null;
}
