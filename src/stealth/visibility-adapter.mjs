import { areActorsStealthAlliesCached } from "./observers.mjs";
import { getStealthStatusId, isActorStealthed } from "./rules.mjs";

const patchedModes = new Map();

/**
 * Isolate the Foundry V14 protected-method compatibility patch from domain
 * logic. A separate detection mode cannot provide unconditional ally sight
 * without being persisted onto every TokenDocument, so the existing behavior
 * remains wrapped here behind a reversible, idempotent adapter.
 */
export function registerStealthAllyVisibilityPatch() {
  const modes = globalThis.CONFIG?.Canvas?.detectionModes;
  patchDetectionMode(modes?.basicSight);
  patchDetectionMode(modes?.lightPerception);
}

export function unregisterStealthAllyVisibilityPatch() {
  for (const [mode, originalCanDetect] of patchedModes) {
    Object.defineProperty(mode, "_canDetect", {
      value: originalCanDetect,
      configurable: true,
      writable: true
    });
  }
  patchedModes.clear();
}

export function refreshStealthedTokenVisibility() {
  for (const token of globalThis.canvas?.tokens?.placeables ?? []) {
    if (token?.actor && isActorStealthed(token.actor)) {
      token.renderFlags?.set?.({ refreshVisibility: true });
    }
  }
}

function patchDetectionMode(mode) {
  if (!mode || patchedModes.has(mode)) return;
  const originalCanDetect = mode._canDetect;
  if (typeof originalCanDetect !== "function") return;
  patchedModes.set(mode, originalCanDetect);

  Object.defineProperty(mode, "_canDetect", {
    value(visionSource, target, level) {
      if (originalCanDetect.call(this, visionSource, target, level)) return true;
      return canVisionSourceDetectStealthedAlly(visionSource, target, this);
    },
    configurable: true,
    writable: true
  });
}

export function canVisionSourceDetectStealthedAlly(visionSource, target, mode) {
  const targetDocument = target?.document;
  const targetActor = target?.actor ?? targetDocument?.actor;
  const sourceDocument = visionSource?.object?.document;
  const sourceActor = visionSource?.object?.actor ?? sourceDocument?.actor;
  if (!targetDocument || !targetActor || !sourceDocument || !sourceActor) return false;

  const invisible = getStealthStatusId();
  if (!targetDocument.hasStatusEffect?.(invisible) || !isActorStealthed(targetActor)) return false;

  const burrow = globalThis.CONFIG?.specialStatusEffects?.BURROW;
  const blind = globalThis.CONFIG?.specialStatusEffects?.BLIND;
  if (burrow && (targetDocument.hasStatusEffect?.(burrow) || sourceDocument.hasStatusEffect?.(burrow))) return false;
  if (blind && sourceDocument.hasStatusEffect?.(blind)) return false;
  if (mode?.walls && visionSource?.blinded?.darkness) return false;

  if (sourceActor.uuid === targetActor.uuid) return true;
  return areActorsStealthAlliesCached(targetActor, sourceActor);
}
