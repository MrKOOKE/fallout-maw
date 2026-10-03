import { SYSTEM_ID } from "../constants.mjs";

export function getTokenRotationSpeedMultiplier(document) {
  const value = Number(document?.getFlag?.(SYSTEM_ID, "rotationSpeedMultiplier") ?? document?.flags?.[SYSTEM_ID]?.rotationSpeedMultiplier);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

export function getTokenMovementAutoRotateOverride(document) {
  const value = document?.getFlag?.(SYSTEM_ID, "movementAutoRotate") ?? document?.flags?.[SYSTEM_ID]?.movementAutoRotate;
  if (value === "on" || value === true) return true;
  if (value === "off" || value === false) return false;
  return undefined;
}

/** Keep Foundry's movement, constraints and rotation math; override its one input. */
export function applyTokenMovementAutoRotateOverride(document, options = {}) {
  const override = getTokenMovementAutoRotateOverride(document);
  if (override === undefined || options.isUndo || options.isPaste) return options;
  const instruction = options.movement?.[document.id];
  const method = instruction?.method ?? options.method;
  if (!["keyboard", "dragging"].includes(method)) return options;
  options.movement ??= {};
  options.movement[document.id] = { ...instruction, autoRotate: override };
  return options;
}
