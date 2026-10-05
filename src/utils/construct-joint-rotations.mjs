import { getConstructVisualRuntimeConfig, resolveConstructVisualAnchors, resolveConstructVisualLayers } from "./construct-visual-model.mjs";

/** Legacy saved angles keep their pose; subsequent parent motion carries the joint. */
export function getConstructJointRotationAnchors(actor, state = {}) {
  const references = { ...(state.rotationAnchors ?? {}) };
  const config = getConstructVisualRuntimeConfig(actor);
  const missing = config.parts.filter(part => part.rotates && state.rotations?.[part.slotId] !== undefined
    && (references[part.slotId] === null || references[part.slotId] === undefined || !Number.isFinite(Number(references[part.slotId]))));
  if (!missing.length) return references;
  const anchors = resolveConstructVisualAnchors(actor, { rotations: state.rotations ?? {}, rotationAnchors: references });
  for (const part of missing) references[part.slotId] = anchors.find(anchor => anchor.id === part.anchorId)?.rotation ?? 0;
  return references;
}

export function resolveConstructJointRotations(actor, state = {}, overrides = {}) {
  const rotations = state.rotations ?? {};
  if (!Object.keys(rotations).length && !Object.keys(overrides).length) return {};
  const layers = resolveConstructVisualLayers(actor, { rotations, rotationAnchors: getConstructJointRotationAnchors(actor, state),
    rotationOverrides: overrides });
  const result = { ...rotations, ...overrides };
  for (const part of layers) if (part.rotates && Object.hasOwn(result, part.slotId)) result[part.slotId] = part.rotation;
  return result;
}

/** Store the reached body angle together with the mount angle at this instant. */
export function prepareConstructJointRotationState(actor, state, slotId, rotation, currentRotations = {}) {
  const references = getConstructJointRotationAnchors(actor, state);
  const part = getConstructVisualRuntimeConfig(actor).parts.find(row => row.slotId === slotId);
  const anchors = resolveConstructVisualAnchors(actor, { rotations: currentRotations });
  return { ...state, rotations: { ...(state.rotations ?? {}), [slotId]: rotation }, rotationAnchors: {
    ...references, [slotId]: anchors.find(anchor => anchor.id === part?.anchorId)?.rotation ?? 0
  } };
}
