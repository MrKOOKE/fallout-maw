import { appendGrappleFollowMovement } from "../combat/active-actions.mjs";

export class FalloutMaWTokenLayer extends foundry.canvas.layers.TokenLayer {
  /** @override */
  _prepareKeyboardMovementUpdates(objects, dx, dy, dz) {
    const [updates, options = {}] = super._prepareKeyboardMovementUpdates(objects, dx, dy, dz);
    const movement = options.movement;
    if (!Array.isArray(updates) || !movement || typeof movement !== "object") return [updates, options];

    for (const object of objects) {
      const instruction = movement[object.id];
      if (!instruction?.waypoints?.length) continue;
      const path = [getTokenMovementOrigin(object.document), ...instruction.waypoints];
      if (!appendGrappleFollowMovement(updates, movement, object, path, options)) return [[], {}];
    }
    return [updates, options];
  }
}

function getTokenMovementOrigin(tokenDocument) {
  return {
    x: Number(tokenDocument?._source?.x ?? tokenDocument?.x) || 0,
    y: Number(tokenDocument?._source?.y ?? tokenDocument?.y) || 0,
    elevation: Number(tokenDocument?._source?.elevation ?? tokenDocument?.elevation) || 0,
    width: tokenDocument?._source?.width ?? tokenDocument?.width,
    height: tokenDocument?._source?.height ?? tokenDocument?.height,
    depth: tokenDocument?._source?.depth ?? tokenDocument?.depth,
    shape: tokenDocument?._source?.shape ?? tokenDocument?.shape,
    level: tokenDocument?._source?.level ?? tokenDocument?.level
  };
}
