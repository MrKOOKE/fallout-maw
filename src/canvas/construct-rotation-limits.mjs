import { getConstructRotationBoundaries } from "../constructs/rotation-actions.mjs";
import { canUserControlConstruct } from "../utils/construct-crew.mjs";

export function getConstructRotationGuideBounds(context, slotId) {
  const halfWidth = slotId === "hull" ? context.profile.degrees : context.profile.degrees / 2;
  return context.bounds.min === context.bounds.max
    ? { min: context.state.origin - halfWidth, max: context.state.origin + halfWidth } : context.bounds;
}

/** Retained world-space rays and upright text aligned with each boundary. */
export class ConstructRotationLimitsPreview {
  graphics = null;
  labels = [];
  signature = "";

  update(doc, slotId, { origin, toWorldAngle = angle => angle + 180, parent = globalThis.canvas?.controls } = {}) {
    const context = getConstructRotationBoundaries(doc, slotId);
    if (!context || !parent || !origin || !globalThis.PIXI) { this.destroy(); return; }
    const bounds = getConstructRotationGuideBounds(context, slotId);
    if (bounds.max - bounds.min >= 360) { this.destroy(); return; }
    const radius = Math.max(Number(doc.object?.w) || 100, Number(doc.object?.h) || 100) * 1.15;
    const angles = [bounds.min, bounds.max].map(toWorldAngle);
    const signature = [origin.x, origin.y, ...angles, radius, context.profile.points, context.powered].join("|");
    if (signature === this.signature && this.graphics?.parent === parent) return;
    this.signature = signature;
    if (!this.graphics || this.graphics.destroyed) {
      this.graphics = new PIXI.Graphics(); this.graphics.eventMode = "none";
      this.graphics.name = "fallout-maw.rotationCostLimits";
      this.labels = [0, 1].map(() => {
        const text = new PIXI.Text("", { fontFamily: "Arial", fontSize: 16, fill: 0xffd584, stroke: 0x151515, strokeThickness: 3 });
        text.eventMode = "none"; text.anchor.set(0.5, 1.25); this.graphics.addChild(text); return text;
      });
    }
    if (this.graphics.parent !== parent) parent.addChild(this.graphics);
    this.graphics.clear(); this.graphics.lineStyle(1.5, context.powered ? 0xffcb69 : 0x999999, 0.8);
    angles.forEach((angle, i) => {
      const radians = (angle - 90) * Math.PI / 180, dx = Math.cos(radians), dy = Math.sin(radians);
      this.graphics.moveTo(origin.x, origin.y); this.graphics.lineTo(origin.x + dx * radius, origin.y + dy * radius);
      const label = this.labels[i]; label.text = `${context.profile.points} ОП`;
      label.position.set(origin.x + dx * radius * 0.8, origin.y + dy * radius * 0.8);
      label.rotation = Math.atan2(dy, dx);
      if (Math.cos(label.rotation) < 0) label.rotation += Math.PI;
    });
  }

  destroy() {
    this.graphics?.parent?.removeChild(this.graphics);
    this.graphics?.destroy({ children: true });
    this.graphics = null; this.labels = []; this.signature = "";
  }
}

let registered = false;
const previews = new Map();
let getSelectedContext = () => null, getAimingSlot = () => "", getPartPose = () => null;

/** Only the currently operated mechanism owns the guides, including for the GM. */
export function refreshConstructRotationLimits(token) {
  let slotId = "";
  if (token?.controlled && !token.isPreview && token.actor?.type === "construct") {
    const aiming = getAimingSlot(token), context = getSelectedContext(token.document, game.user);
    if (aiming && canUserControlConstruct(token.actor, game.user, "aim", { partSlotId: aiming })) slotId = aiming;
    else if (context) {
      const functions = context.seat.functions;
      if (context.available !== false) {
        if (functions.includes("rotate") && context.seat.role === "driver") slotId = "hull";
        else if (functions.includes("aim") && context.partSlotId) slotId = context.partSlotId;
        else if (functions.includes("rotate")) slotId = "hull";
      }
    } else if (canUserControlConstruct(token.actor, game.user, "rotate")) slotId = "hull";
  }
  if (!slotId) { previews.get(token)?.destroy(); previews.delete(token); return; }
  let preview = previews.get(token);
  if (!preview) previews.set(token, preview = new ConstructRotationLimitsPreview());
  const pose = slotId === "hull" ? { origin: token.center } : getPartPose(token, slotId);
  if (!pose) { preview.destroy(); return; }
  preview.update(token.document, slotId, pose);
}

export function registerConstructRotationLimits(options = {}) {
  if (options.getSelectedContext) getSelectedContext = options.getSelectedContext;
  if (options.getAimingSlot) getAimingSlot = options.getAimingSlot;
  if (options.getPartPose) getPartPose = options.getPartPose;
  if (registered) return; registered = true;
  for (const hook of ["refreshToken", "controlToken", "updateToken", "falloutMawConstructCrewSelection"])
    Hooks.on(hook, token => refreshConstructRotationLimits(token.object ?? token));
  for (const hook of ["updateActor", "updateCombat"]) Hooks.on(hook, () => {
    for (const token of new Set([...previews.keys(), ...globalThis.canvas?.tokens?.controlled ?? []])) refreshConstructRotationLimits(token);
  });
  Hooks.on("destroyToken", token => { previews.get(token)?.destroy(); previews.delete(token); });
  Hooks.on("canvasTearDown", () => { for (const preview of previews.values()) preview.destroy(); previews.clear(); });
}
