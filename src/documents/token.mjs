import { isPhantomEntity } from "../abilities/phantom-entity.mjs";
import { COMBAT_MOVEMENT_RESOURCE_UPDATE_OPTION } from "../constants.mjs";
import { cloneTokenPreview } from "./token-clone-initialization.mjs";
import { createTokenSourceSerializer } from "./token-source-serialization.mjs";

const serializeTokenSource = createTokenSourceSerializer(TokenDocument);

/**
 * Token document behavior owned by the system.
 *
 * Phantom entities are real TokenDocuments and still provide vision, but they
 * are deliberately absent from Region membership. Foundry dispatches Region
 * enter/exit behavior from that membership, including while a token is being
 * deleted. Letting a damage-destroyed phantom participate there would run
 * ordinary actor mechanics against a synthetic actor during its teardown.
 */
export class FalloutMaWTokenDocument extends TokenDocument {
  _onRelatedUpdate(update = {}, operation = {}) {
    if (!operation?.[COMBAT_MOVEMENT_RESOURCE_UPDATE_OPTION]) {
      return super._onRelatedUpdate(update, operation);
    }
    refreshCombatMovementTokenState(this, update, operation);
  }

  toObject(source = true) {
    if (this.constructor !== FalloutMaWTokenDocument) return super.toObject(source);
    return serializeTokenSource(this, source, () => super.toObject(source));
  }

  clone(data = {}, context = {}) {
    return cloneTokenPreview(this, data, context, options => super.clone(data, options));
  }

  prepareBaseData() {
    super.prepareBaseData();
    if (!isPhantomEntity(this) || !this.regions?.size) return;
    for (const region of this.regions) region.tokens?.delete?.(this);
    this.regions.clear();
  }

  _identifyRegions(changes = {}) {
    if (isPhantomEntity(this)) return [];
    return super._identifyRegions(changes);
  }
}

/**
 * Foundry's default related-Actor refresh redraws token effects, animates both
 * bars, and renders the whole Combat Tracker after every ActorDelta update.
 * A movement-resource transaction changes none of those unless a token bar or
 * the tracked combat resource is explicitly bound to ОП/ОД/ОР.
 */
function refreshCombatMovementTokenState(tokenDocument, update, operation) {
  const changedPaths = getActorUpdatePaths(update);
  const changedBars = getChangedTokenBars(tokenDocument, changedPaths);
  if (changedBars.length) refreshChangedTokenBars(tokenDocument, changedBars);

  const combatant = tokenDocument.combatant;
  const trackedResource = String(game.combat?.settings?.resource ?? "").trim();
  const isActorUpdate = [tokenDocument, null, undefined].includes(operation.parent);
  if (
    combatant
    && isActorUpdate
    && trackedResource
    && actorUpdateTouchesPath(changedPaths, normalizeActorSystemPath(trackedResource))
  ) {
    combatant.updateResource();
    ui.combat.render();
  }
}

function getActorUpdatePaths(update) {
  const updates = Array.isArray(update) ? update : [update];
  const paths = new Set();
  for (const entry of updates) {
    if (!entry || typeof entry !== "object") continue;
    for (const path of Object.keys(foundry.utils.flattenObject(entry))) paths.add(path);
  }
  return paths;
}

function getChangedTokenBars(tokenDocument, changedPaths) {
  const changed = [];
  for (const key of ["bar1", "bar2"]) {
    const attribute = String(tokenDocument[key]?.attribute ?? "").trim();
    if (attribute && actorUpdateTouchesPath(changedPaths, normalizeActorSystemPath(attribute))) changed.push(key);
  }
  return changed;
}

function refreshChangedTokenBars(tokenDocument, changedBars) {
  tokenDocument._prepareBars();
  if (!tokenDocument.parent?.isView || !tokenDocument.object) return;

  if (tokenDocument.object.hasActiveHUD) canvas.tokens.hud.render();
  const attributes = Object.fromEntries(changedBars.map(key => [key, tokenDocument[key]]));
  const name = `${tokenDocument.object.objectId}.animateBars`;
  const easing = foundry.canvas.animation.CanvasAnimation.easeInOutCosine;
  tokenDocument.object.animate(attributes, { name, easing });

  for (const app of foundry.applications.sheets.TokenConfig.instances()) {
    app._preview?.updateSource({ delta: tokenDocument.toObject().delta }, { diff: false, recursive: false });
    app._preview?.object?.renderFlags.set({ refreshBars: true });
  }
}

function normalizeActorSystemPath(path) {
  const normalized = String(path ?? "").trim();
  return normalized.startsWith("system.") ? normalized : `system.${normalized}`;
}

function actorUpdateTouchesPath(changedPaths, targetPath) {
  if (!targetPath || targetPath === "system.") return false;
  for (const changedPath of changedPaths) {
    if (
      changedPath === targetPath
      || changedPath.startsWith(`${targetPath}.`)
      || targetPath.startsWith(`${changedPath}.`)
    ) return true;
  }
  return false;
}
