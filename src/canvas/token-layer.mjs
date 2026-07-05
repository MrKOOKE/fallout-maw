import {
  appendGrappleFollowMovement,
  commitGrappleFollowOrchestrations,
  GRAPPLE_FOLLOW_ORCHESTRATION_OPTION
} from "../combat/active-actions.mjs";

export class FalloutMaWTokenLayer extends foundry.canvas.layers.TokenLayer {
  /** @override */
  async moveMany({ dx = 0, dy = 0, dz = 0, rotate = false, ids, includeLocked = false } = {}) {
    if (rotate || game.user?.isGM) return super.moveMany({ dx, dy, dz, rotate, ids, includeLocked });

    if (![-1, 0, 1].includes(dx) || ![-1, 0, 1].includes(dy) || ![-1, 0, 1].includes(dz)) {
      return super.moveMany({ dx, dy, dz, rotate, ids, includeLocked });
    }
    if (!dx && !dy && !dz) return [];
    if (game.paused && !game.user.isGM) {
      ui.notifications.warn("GAME.PausedWarning", { localize: true });
      return [];
    }

    const objects = this._getMovableObjects(ids, includeLocked);
    if (!objects.length) return objects;

    this.hud?.close();
    const [updateData, updateOptions = {}] = this._prepareKeyboardMovementUpdates(objects, dx, dy, dz);
    const orchestrations = updateOptions[GRAPPLE_FOLLOW_ORCHESTRATION_OPTION];
    if (orchestrations?.length) {
      const ok = await commitGrappleFollowOrchestrations(orchestrations);
      return ok ? objects : [];
    }

    await canvas.scene.updateEmbeddedDocuments(this.constructor.documentName, updateData, updateOptions);
    return objects;
  }

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
