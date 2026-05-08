import { requestSkillCheck } from "../rolls/skill-check.mjs";
import { requestDamageApplication } from "./damage-hub.mjs";
import { ITEM_FUNCTIONS, hasItemFunction } from "../utils/item-functions.mjs";
import { toInteger } from "../utils/numbers.mjs";

let activeAttack = null;
const BURST_ATTACK_INTERVAL_MS = 200;

export function cancelWeaponAttack() {
  activeAttack?.destroy();
  activeAttack = null;
}

export function startWeaponAttack({ token = null, weapon = null, actionKey = "" } = {}) {
  if (!token?.actor || !weapon || !hasItemFunction(weapon, ITEM_FUNCTIONS.weapon)) return undefined;
  if (!hasWeaponAction(weapon, actionKey)) return undefined;
  if (!hasRequiredWeaponResources(weapon, getActionAttackCount(weapon, actionKey))) return undefined;

  cancelWeaponAttack();
  activeAttack = new WeaponAttackController(token, weapon, actionKey);
  activeAttack.activate();
  return activeAttack;
}

class WeaponAttackController {
  constructor(token, weapon, actionKey) {
    this.token = token;
    this.weapon = weapon;
    this.actionKey = actionKey;
    this.container = new PIXI.Container();
    this.shape = new PIXI.Graphics();
    this.targetMarkers = new PIXI.Graphics();
    this.container.addChild(this.shape, this.targetMarkers);
    this.targets = [];
    this.geometry = null;
    this.pointer = null;
    this.processing = false;
    this.events = {
      move: event => this.onMove(event),
      confirm: event => this.onConfirm(event),
      cancel: event => this.onCancel(event)
    };
  }

  activate() {
    this.container.eventMode = "none";
    canvas.controls._rulerPaths.addChild(this.container);
    canvas.stage.on("mousemove", this.events.move);
    canvas.stage.on("mousedown", this.events.confirm);
    canvas.app.view.oncontextmenu = this.events.cancel;
  }

  destroy() {
    canvas.stage.off("mousemove", this.events.move);
    canvas.stage.off("mousedown", this.events.confirm);
    if (canvas.app?.view?.oncontextmenu === this.events.cancel) canvas.app.view.oncontextmenu = null;
    this.container.destroy({ children: true });
  }

  onMove(event) {
    if (this.processing) return;
    event.stopPropagation();
    this.pointer = event.data.getLocalPosition(canvas.controls._rulerPaths);
    this.refresh();
  }

  onCancel(event) {
    event?.preventDefault?.();
    cancelWeaponAttack();
    return false;
  }

  async onConfirm(event) {
    if (event.button !== 0 || this.processing) return;
    event.stopPropagation();
    event.preventDefault();
    if (!this.pointer) return;
    if (!this.targets.length) return;
    const attackCount = getActionAttackCount(this.weapon, this.actionKey);
    if (!hasRequiredWeaponResources(this.weapon, attackCount)) return;

    this.processing = true;
    const damageRequests = [];
    let attempted = false;
    for (let attackIndex = 0; attackIndex < attackCount; attackIndex += 1) {
      const selectedTargets = selectTargetsForAttack(this.targets, this.geometry, this.weapon);
      for (const target of selectedTargets) {
        const request = await this.resolveAttackAgainstTarget(target);
        if (request) damageRequests.push(request);
        attempted = true;
      }
      if (attackIndex < attackCount - 1) await wait(BURST_ATTACK_INTERVAL_MS);
    }

    if (attempted) await spendWeaponResources(this.weapon, attackCount);
    if (damageRequests.length) {
      await applyQueuedDamageRequests(damageRequests);
    }
    this.processing = false;
    this.refresh();
  }

  async resolveAttackAgainstTarget(target) {
    if (isDeadTarget(target)) return null;
    const limbKey = selectRandomLimbKey(target.actor);
    const outcome = await requestSkillCheck({
      actor: this.token.actor,
      skillKey: String(this.weapon.system?.functions?.weapon?.skillKey ?? ""),
      data: {
        difficulty: getDodgeDifficulty(target.actor),
        situationalModifier: toInteger(this.weapon.system?.functions?.weapon?.accuracyBonus)
      },
      animate: false,
      createMessage: true,
      prompt: false,
      requester: "weaponAttack"
    });
    if (!isSuccessfulAttack(outcome)) return null;
    return {
      actor: target.actor,
      limbKey,
      amount: toInteger(this.weapon.system?.functions?.weapon?.damage),
      damageTypeKey: String(this.weapon.system?.functions?.weapon?.damageTypeKey ?? ""),
      scope: "healthAndLimb",
      source: {
        weaponUuid: this.weapon.uuid,
        actionKey: this.actionKey,
        attackerUuid: this.token.actor.uuid,
        tokenId: this.token.id
      }
    };
  }

  refresh() {
    this.shape.clear();
    this.targetMarkers.clear();
    if (!this.pointer) return;

    const origin = getTokenCenter(this.token);
    this.geometry = getAttackGeometry(this.weapon, origin, this.pointer);
    drawAttackShape(this.shape, this.geometry, this.processing);
    this.targets = getPotentialTargets(this.token, this.geometry);
    drawTargetMarkers(this.targetMarkers, this.targets);
  }
}

function hasWeaponAction(weapon, actionKey) {
  return Boolean(weapon.system?.functions?.weapon?.availableActions?.[actionKey]);
}

function getActionAttackCount(weapon, actionKey) {
  if (actionKey !== "burst") return 1;
  return Math.max(1, toInteger(weapon.system?.functions?.weapon?.burst?.count));
}

function hasRequiredWeaponResources(weapon, multiplier = 1) {
  const costs = weapon.system?.functions?.weapon?.resourceCosts ?? [];
  for (const cost of costs) {
    const amount = Math.max(0, toInteger(cost.amount) * Math.max(1, toInteger(multiplier)));
    if (!amount) continue;
    if (cost.type === "magazine" && toInteger(weapon.system?.functions?.weapon?.magazine?.value) < amount) return false;
    if (cost.type === "condition" && toInteger(weapon.system?.functions?.condition?.value) < amount) return false;
  }
  return true;
}

async function spendWeaponResources(weapon, multiplier = 1) {
  const updateData = {};
  for (const cost of weapon.system?.functions?.weapon?.resourceCosts ?? []) {
    const amount = Math.max(0, toInteger(cost.amount) * Math.max(1, toInteger(multiplier)));
    if (!amount) continue;
    if (cost.type === "magazine") {
      const current = toInteger(weapon.system?.functions?.weapon?.magazine?.value);
      updateData["system.functions.weapon.magazine.value"] = Math.max(0, current - amount);
    } else if (cost.type === "condition") {
      const current = toInteger(weapon.system?.functions?.condition?.value);
      updateData["system.functions.condition.value"] = Math.max(0, current - amount);
    }
  }
  if (Object.keys(updateData).length) await weapon.update(updateData);
}

function getAttackGeometry(weapon, origin, pointer) {
  const maxDistancePixels = metersToPixels(Number(weapon.system?.functions?.weapon?.maxRangeMeters) || 0);
  const dx = pointer.x - origin.x;
  const dy = pointer.y - origin.y;
  const angle = Math.atan2(dy, dx);
  const distance = Math.max(1, maxDistancePixels);
  const halfAngle = Math.max(0, (Number(weapon.system?.functions?.weapon?.attackConeDegrees) || 0) * (Math.PI / 180) / 2);
  const end = {
    x: origin.x + (Math.cos(angle) * distance),
    y: origin.y + (Math.sin(angle) * distance)
  };
  return { origin, angle, distance, halfAngle, end };
}

function metersToPixels(meters) {
  const gridDistance = Math.max(0.0001, Number(canvas.scene?.grid?.distance ?? canvas.grid?.distance) || 1);
  const gridSize = Math.max(1, Number(canvas.grid?.size) || 100);
  return Math.max(0, meters) * (gridSize / gridDistance);
}

function drawAttackShape(graphics, geometry, locked) {
  const color = locked ? 0xffd166 : 0xff3b3b;
  const alpha = locked ? 0.24 : 0.18;
  const points = buildConePoints(geometry);
  graphics.lineStyle(2, color, 0.9);
  graphics.beginFill(color, alpha);
  if (points.length >= 6) graphics.drawPolygon(points);
  else graphics.moveTo(geometry.origin.x, geometry.origin.y).lineTo(geometry.end.x, geometry.end.y);
  graphics.endFill();
}

function buildConePoints({ origin, angle, distance, halfAngle }) {
  if (halfAngle <= 0) return [];
  const points = [origin.x, origin.y];
  const segments = 24;
  for (let index = 0; index <= segments; index += 1) {
    const step = -halfAngle + ((halfAngle * 2 * index) / segments);
    points.push(
      origin.x + (Math.cos(angle + step) * distance),
      origin.y + (Math.sin(angle + step) * distance)
    );
  }
  return points;
}

function getPotentialTargets(attackerToken, geometry) {
  return (canvas.tokens?.placeables ?? []).filter(target => {
    if (target === attackerToken || !target.actor || !target.visible) return false;
    const center = getTokenCenter(target);
    if (isDeadTarget(target)) return false;
    if (!pointInAttackCone(center, geometry)) return false;
    return hasLineOfSight(attackerToken, center, geometry.origin);
  }).sort((left, right) => getTargetDistance(left, geometry) - getTargetDistance(right, geometry));
}

function hasLineOfSight(attackerToken, destination, origin) {
  return !attackerToken.checkCollision(destination, {
    origin,
    type: "sight",
    mode: "any"
  });
}

function pointInAttackCone(point, { origin, angle, distance, halfAngle }) {
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  const range = Math.hypot(dx, dy);
  if (range > distance) return false;
  if (halfAngle <= 0) return Math.abs(normalizeAngle(Math.atan2(dy, dx) - angle)) < 0.025;
  return Math.abs(normalizeAngle(Math.atan2(dy, dx) - angle)) <= halfAngle;
}

function drawTargetMarkers(graphics, targets) {
  graphics.beginFill(0xff1f1f, 0.95);
  graphics.lineStyle(1, 0x350000, 0.9);
  for (const target of targets) {
    const center = getTokenCenter(target);
    graphics.drawCircle(center.x, target.y + target.h + 8, 7);
  }
  graphics.endFill();
}

function selectTargetsForAttack(targets, geometry, weapon) {
  const livingTargets = (targets ?? []).filter(target => !isDeadTarget(target));
  if (!livingTargets.length) return [];
  const primary = livingTargets[Math.floor(Math.random() * livingTargets.length)];
  const primaryDistance = getTargetDistance(primary, geometry);
  const targetCount = getWeaponPenetrationTargetCount(weapon);
  return livingTargets
    .filter(target => getTargetDistance(target, geometry) >= primaryDistance)
    .sort((left, right) => getTargetDistance(left, geometry) - getTargetDistance(right, geometry))
    .slice(0, targetCount);
}

function getWeaponPenetrationTargetCount(weapon) {
  return Math.max(1, toInteger(weapon.system?.functions?.weapon?.penetration));
}

function getTargetDistance(target, geometry) {
  const center = getTokenCenter(target);
  return Math.hypot(center.x - geometry.origin.x, center.y - geometry.origin.y);
}

async function applyQueuedDamageRequests(requests = []) {
  for (const request of requests) {
    if (isDeadActor(request.actor)) continue;
    await requestDamageApplication(request);
  }
}

function getTokenCenter(token) {
  return token.center ?? {
    x: token.x + (token.w / 2),
    y: token.y + (token.h / 2)
  };
}

function selectRandomLimbKey(actor) {
  const keys = Object.entries(actor.system?.limbs ?? {})
    .filter(([_key, limb]) => limb && typeof limb === "object")
    .map(([key]) => key);
  return keys[Math.floor(Math.random() * keys.length)] ?? "";
}

function getDodgeDifficulty(actor) {
  return toInteger(actor.system?.resources?.dodge?.value);
}

function isDeadTarget(token) {
  if (!token?.actor) return true;
  const defeatedStatus = CONFIG.specialStatusEffects.DEFEATED;
  return isDeadActor(token.actor)
    || (defeatedStatus && token.document?.hasStatusEffect?.(defeatedStatus))
    || token.document?.hasStatusEffect?.("dead");
}

function isDeadActor(actor) {
  if (!actor) return true;
  const health = actor.system?.resources?.health;
  if (health && toInteger(health.value) <= toInteger(health.min)) return true;
  const defeatedStatus = CONFIG.specialStatusEffects.DEFEATED;
  return Boolean((defeatedStatus && actor.statuses?.has(defeatedStatus)) || actor.statuses?.has("dead"));
}

function isSuccessfulAttack(outcome) {
  return ["success", "criticalSuccess"].includes(String(outcome?.result?.key ?? ""));
}

function normalizeAngle(angle) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function wait(ms) {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}
