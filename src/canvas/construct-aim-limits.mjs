import { getConstructWeaponAimOrigin, getConstructWeaponAimSector } from "./construct-visuals.mjs";
import { getConstructAimLimitsEnabled } from "../settings/accessors.mjs";

const EDGE_COLOR = 0xe85b55;
const EDGE_ALPHA = 0.65;

/** Screen-up weapon sectors use clockwise degrees. Edges share the real attack
 * origin and stop at the weapon/port range or the scene boundary.
 */
export function buildConstructAimLimitsGeometry({ origin, sector, rangeProfile = {}, sceneRect, pixelsPerMeter = 1 } = {}) {
  const rotation = Number(sector?.rotation);
  const min = Number(sector?.minRotation), max = Number(sector?.maxRotation);
  if (!sector || ![origin?.x, origin?.y, rotation, min, max].every(Number.isFinite)
    || max < min || max - min >= 360) return null;
  const caps = [];
  if (rangeProfile.maxRangeUnlimited !== true && Number.isFinite(Number(rangeProfile.maxRangeMeters))) {
    caps.push(Math.max(0, Number(rangeProfile.maxRangeMeters)));
  }
  if (sector.maxRangeMeters !== null && sector.maxRangeMeters !== undefined && Number.isFinite(Number(sector.maxRangeMeters))) {
    caps.push(Math.max(0, Number(sector.maxRangeMeters)));
  }
  const bounds = validBounds(sceneRect);
  const extent = caps.length ? Math.min(...caps) * Math.max(0, Number(pixelsPerMeter) || 0)
    : bounds ? Math.max(...[bounds.x, bounds.x + bounds.width].flatMap(x =>
      [bounds.y, bounds.y + bounds.height].map(y => Math.hypot(x - origin.x, y - origin.y)))) : 0;
  if (!(extent > 0)) return null;
  const edges = [min, max].map(offset => {
    const angle = (rotation + offset) * Math.PI / 180;
    const dx = Math.sin(angle), dy = -Math.cos(angle);
    const distance = bounds ? raySceneExtent(origin, dx, dy, bounds, extent) : extent;
    return { x: origin.x + dx * distance, y: origin.y + dy * distance };
  });
  return { origin: { x: origin.x, y: origin.y }, edges };
}

/** A single retained graphics object. A stable pose neither redraws the GPU
 * geometry nor asks the attack controller to rebuild its preview.
 */
export class ConstructAimLimitsPreview {
  graphics = null;
  geometry = null;
  poseSignature = "";
  drawSignature = "";

  attach(controller) {
    if (controller?.headlessExecution || controller?.token?.actor?.type !== "construct" || !controller?.container) return;
    if (!this.graphics || this.graphics.destroyed) {
      this.graphics = new PIXI.Graphics();
      this.graphics.name = "fallout-maw.constructAimLimits";
      this.graphics.eventMode = "none";
      this.graphics.interactive = false;
      this.graphics.visible = false;
    }
    if (this.graphics.parent !== controller.container) controller.container.addChildAt(this.graphics, 0);
  }

  update(controller) {
    if (controller?.destroyed || controller?.headlessExecution || controller?.previewSuppressed
      || controller?.token?.actor?.type !== "construct") {
      this.clear();
      return false;
    }
    if (controller.processing || controller.isInteractionLocked?.()) return false;
    const sector = getConstructWeaponAimSector(controller.token, controller.weapon, controller.weaponFunctionId);
    const origin = sector?.origin
      ?? getConstructWeaponAimOrigin(controller.token, controller.weapon, controller.weaponFunctionId)
      ?? controller.getAttackOrigin?.();
    const sceneRect = globalThis.canvas?.dimensions?.sceneRect ?? globalThis.canvas?.scene?.dimensions?.sceneRect;
    const pixelsPerMeter = Math.max(1, Number(globalThis.canvas?.grid?.size) || 100)
      / Math.max(0.0001, Number(globalThis.canvas?.scene?.grid?.distance ?? globalThis.canvas?.grid?.distance) || 1);
    const range = controller.rangeProfile ?? {};
    const pose = [origin?.x, origin?.y, sector?.rotation, sector?.minRotation, sector?.maxRotation,
      sector?.maxRangeMeters, range.maxRangeMeters, range.maxRangeUnlimited === true,
      sceneRect?.x, sceneRect?.y, sceneRect?.width, sceneRect?.height, pixelsPerMeter].join("|");
    const changed = pose !== this.poseSignature;
    this.poseSignature = pose;
    const enabled = getConstructAimLimitsEnabled();
    const draw = `${enabled}:${pose}`;
    if (draw === this.drawSignature) return changed;
    this.drawSignature = draw;
    this.geometry = enabled ? buildConstructAimLimitsGeometry({ origin, sector, rangeProfile: range, sceneRect, pixelsPerMeter }) : null;
    if (!this.geometry) {
      if (this.graphics?.visible) this.graphics.clear();
      if (this.graphics) this.graphics.visible = false;
      return changed;
    }
    this.attach(controller);
    if (!this.graphics || this.graphics.destroyed) return changed;
    this.graphics.clear();
    this.graphics.lineStyle(1.5, EDGE_COLOR, EDGE_ALPHA);
    for (const edge of this.geometry.edges) {
      this.graphics.moveTo(this.geometry.origin.x, this.geometry.origin.y);
      this.graphics.lineTo(edge.x, edge.y);
    }
    this.graphics.visible = true;
    return changed;
  }

  clear() {
    if (this.graphics?.visible && !this.graphics.destroyed) this.graphics.clear();
    if (this.graphics && !this.graphics.destroyed) this.graphics.visible = false;
    this.geometry = null;
    this.poseSignature = "";
    this.drawSignature = "";
  }

  destroy() {
    this.clear();
    if (this.graphics && !this.graphics.destroyed) {
      this.graphics.parent?.removeChild(this.graphics);
      this.graphics.destroy();
    }
    this.graphics = null;
  }
}

function validBounds(rect) {
  return [rect?.x, rect?.y, rect?.width, rect?.height].every(Number.isFinite)
    && rect.width > 0 && rect.height > 0 ? rect : null;
}

function raySceneExtent(origin, dx, dy, rect, extent) {
  let near = 0, far = extent;
  for (const [position, direction, min, max] of [[origin.x, dx, rect.x, rect.x + rect.width],
    [origin.y, dy, rect.y, rect.y + rect.height]]) {
    if (Math.abs(direction) < 1e-12) {
      if (position < min || position > max) return 0;
      continue;
    }
    const first = (min - position) / direction, second = (max - position) / direction;
    near = Math.max(near, Math.min(first, second));
    far = Math.min(far, Math.max(first, second));
    if (far < near) return 0;
  }
  return Math.max(0, far);
}
