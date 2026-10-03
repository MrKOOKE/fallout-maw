import { localize } from "../utils/i18n.mjs";

export function notifyAimActivationRequired(gate) {
  if (gate.waiting) globalThis.ui?.notifications?.info?.(localize("FALLOUTMAW.AimActivationPrompt",
    "Наведите курсор на зеленую область для разблокировки прицеливания"));
}

export function buildAimActivationArea(sector) {
  if (!sector) return null;
  const radius = Number(sector.radius ?? sector.seedDistance ?? 200);
  const width = sector.maxRotation - sector.minRotation;
  if (!(radius > 0) || !Number.isFinite(radius) || !(width > 0) || width >= 360) return null;
  const points = [sector.origin.x, sector.origin.y];
  const steps = Math.max(1, Math.ceil(width / 3));
  for (let index = 0; index <= steps; index++) {
    const angle = (sector.rotation + sector.minRotation + width * index / steps) * Math.PI / 180;
    points.push(sector.origin.x + Math.sin(angle) * radius, sector.origin.y - Math.cos(angle) * radius);
  }
  return points;
}

/** One passive, retained wedge; no listeners, document writes or world scans. */
export class AimActivationPreview {
  graphics = null;
  signature = "";

  update(gate, parent, { visible = true } = {}) {
    const sector = visible ? gate.getWaitingSector() : null;
    if (!sector || !parent) { this.clear(); return; }
    const signature = [sector.origin.x, sector.origin.y, sector.rotation, sector.minRotation,
      sector.maxRotation, sector.radius, sector.seedDistance].join("|");
    if (signature === this.signature && this.graphics?.parent === parent && this.graphics.visible) return;
    const points = buildAimActivationArea(sector);
    if (!points || !globalThis.PIXI) { this.clear(); return; }
    if (!this.graphics || this.graphics.destroyed) {
      this.graphics = new PIXI.Graphics();
      this.graphics.name = "fallout-maw.aimActivation";
      this.graphics.eventMode = "none";
      this.graphics.interactive = false;
    }
    if (this.graphics.parent !== parent) parent.addChildAt(this.graphics, 0);
    this.graphics.clear();
    this.graphics.lineStyle(1.5, 0x68ed8a, 0.85);
    this.graphics.beginFill(0x68ed8a, 0.2);
    this.graphics.drawPolygon(points);
    this.graphics.endFill();
    this.graphics.visible = true;
    this.signature = signature;
  }

  clear() {
    if (this.graphics?.visible && !this.graphics.destroyed) this.graphics.clear();
    if (this.graphics && !this.graphics.destroyed) this.graphics.visible = false;
    this.signature = "";
  }

  destroy() {
    this.graphics?.parent?.removeChild(this.graphics);
    this.graphics?.destroy();
    this.graphics = null;
    this.signature = "";
  }
}
