import { requestSkillCheck } from "../rolls/skill-check.mjs";
import { SYSTEM_ID } from "../constants.mjs";
import { estimateDamageApplication, requestDamageApplications } from "./damage-hub.mjs";
import { ITEM_FUNCTIONS, hasItemFunction } from "../utils/item-functions.mjs";
import { toInteger } from "../utils/numbers.mjs";

const WEAPON_ATTACK_SOCKET = `system.${SYSTEM_ID}`;
const WEAPON_ATTACK_SOCKET_SCOPE = "weaponAttackPreview";
const PREVIEW_BROADCAST_INTERVAL_MS = 16;
const PREVIEW_POSITION_EPSILON = 0.5;
const PREVIEW_ANGLE_EPSILON = 0.002;
const remoteAttackPreviews = new Map();
let activeAttack = null;

export function registerWeaponAttackSocket() {
  game.socket.on(WEAPON_ATTACK_SOCKET, handleWeaponAttackSocketMessage);
  Hooks.on("canvasReady", clearRemoteAttackPreviews);
}

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
    this.attackId = foundry.utils.randomID();
    this.lastPreviewBroadcastAt = 0;
    this.lastBroadcastPreviewState = null;
    this.events = {
      move: event => this.onMove(event),
      confirm: event => this.onConfirm(event),
      cancel: event => this.onCancel(event)
    };
  }

  activate() {
    this.container.eventMode = "none";
    getAttackPreviewLayer().addChild(this.container);
    canvas.stage.on("mousemove", this.events.move);
    canvas.stage.on("mousedown", this.events.confirm);
    canvas.app.view.oncontextmenu = this.events.cancel;
  }

  destroy() {
    canvas.stage.off("mousemove", this.events.move);
    canvas.stage.off("mousedown", this.events.confirm);
    if (canvas.app?.view?.oncontextmenu === this.events.cancel) canvas.app.view.oncontextmenu = null;
    broadcastAttackPreview({
      action: "clearPreview",
      attackId: this.attackId
    });
    this.container.destroy({ children: true });
  }

  onMove(event) {
    if (this.processing) return;
    event.stopPropagation();
    this.pointer = event.data.getLocalPosition(getAttackPreviewLayer());
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
    const attackCount = getActionAttackCount(this.weapon, this.actionKey);
    if (!hasRequiredWeaponResources(this.weapon, attackCount)) return;

    this.processing = true;
    this.refresh(true);
    const damageRequests = [];
    let attempted = false;
    for (let attackIndex = 0; attackIndex < attackCount; attackIndex += 1) {
      const result = await this.resolveAttackTrajectory();
      damageRequests.push(...result.damageRequests);
      attempted ||= result.attempted;
    }

    if (attempted) await spendWeaponResources(this.weapon, attackCount);
    if (damageRequests.length) {
      await applyQueuedDamageRequests(damageRequests);
    }
    this.processing = false;
    this.refresh(true);
  }

  async resolveAttackTrajectory() {
    const damageRequests = [];
    if (!this.targets.length) return { attempted: true, damageRequests };

    const trajectory = buildAttackTrajectory(this.token, this.geometry, this.targets);
    const targets = getTrajectoryTargets(this.token, trajectory);
    const baseDamage = getWeaponDamage(this.weapon);
    const penetrationPower = getWeaponPenetrationPower(this.weapon);
    const penetrationThreshold = Math.ceil(baseDamage * 0.5);
    let penetrationsUsed = 0;
    let attempted = true;

    for (const target of targets) {
      const damageAmount = getPenetratedDamageAmount(baseDamage, penetrationsUsed);
      if (damageAmount <= 0) break;
      const request = await this.resolveAttackAgainstTarget(target, {
        damageAmount,
        difficultyBonus: penetrationsUsed * 20,
        penetrationStep: penetrationsUsed
      });
      if (!request) break;

      damageRequests.push(request);
      if (penetrationsUsed >= penetrationPower) break;

      const estimate = estimateDamageApplication(request);
      if (estimate.healthDamage < penetrationThreshold) break;
      penetrationsUsed += 1;
    }

    return { attempted, damageRequests };
  }

  async resolveAttackAgainstTarget(target, { damageAmount = 0, difficultyBonus = 0, penetrationStep = 0 } = {}) {
    if (isDeadTarget(target)) return null;
    const limbKey = selectRandomLimbKey(target.actor);
    const outcome = await requestSkillCheck({
      actor: this.token.actor,
      skillKey: String(this.weapon.system?.functions?.weapon?.skillKey ?? ""),
      data: {
        difficulty: getDodgeDifficulty(target.actor) + difficultyBonus,
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
      amount: damageAmount,
      damageTypeKey: String(this.weapon.system?.functions?.weapon?.damageTypeKey ?? ""),
      scope: "healthAndLimb",
      source: {
        weaponUuid: this.weapon.uuid,
        actionKey: this.actionKey,
        attackerUuid: this.token.actor.uuid,
        tokenId: this.token.id,
        penetrationStep
      }
    };
  }

  refresh(forceBroadcast = false) {
    this.shape.clear();
    this.targetMarkers.clear();
    if (!this.pointer) return;

    const origin = getTokenCenter(this.token);
    this.geometry = getAttackGeometry(this.weapon, origin, this.pointer);
    drawAttackShape(this.shape, this.geometry, this.processing);
    this.targets = getPotentialTargets(this.token, this.geometry);
    drawTargetMarkers(this.targetMarkers, this.targets);
    this.broadcastPreview(forceBroadcast);
  }

  broadcastPreview(force = false) {
    const now = performance.now();
    if (!force && now - this.lastPreviewBroadcastAt < PREVIEW_BROADCAST_INTERVAL_MS) return;
    const previewState = {
      geometry: serializeGeometry(this.geometry),
      targetMarkers: this.targets.map(getTargetMarkerPosition),
      processing: this.processing
    };
    if (!force && isSamePreviewState(previewState, this.lastBroadcastPreviewState)) return;
    this.lastPreviewBroadcastAt = now;
    this.lastBroadcastPreviewState = previewState;
    broadcastAttackPreview({
      action: "updatePreview",
      attackId: this.attackId,
      sceneId: canvas.scene?.id ?? "",
      ...previewState
    });
  }
}

function hasWeaponAction(weapon, actionKey) {
  return Boolean(weapon.system?.functions?.weapon?.availableActions?.[actionKey]);
}

function broadcastAttackPreview(payload = {}) {
  game.socket.emit(WEAPON_ATTACK_SOCKET, {
    scope: WEAPON_ATTACK_SOCKET_SCOPE,
    ...payload,
    senderUserId: game.user?.id ?? ""
  });
}

function handleWeaponAttackSocketMessage(payload = {}) {
  if (!payload || payload.scope !== WEAPON_ATTACK_SOCKET_SCOPE || payload.senderUserId === game.user?.id) return;
  if (payload.action === "clearPreview") {
    removeRemoteAttackPreview(payload.attackId);
    return;
  }
  if (payload.action !== "updatePreview") return;
  if (payload.sceneId !== canvas.scene?.id) {
    removeRemoteAttackPreview(payload.attackId);
    return;
  }
  updateRemoteAttackPreview(payload);
}

function updateRemoteAttackPreview(payload = {}) {
  const attackId = String(payload.attackId ?? "");
  const geometry = deserializeGeometry(payload.geometry);
  if (!attackId || !geometry) return;

  let preview = remoteAttackPreviews.get(attackId);
  if (!preview) {
    preview = {
      container: new PIXI.Container(),
      shape: new PIXI.Graphics(),
      targetMarkers: new PIXI.Graphics()
    };
    preview.container.eventMode = "none";
    preview.container.addChild(preview.shape, preview.targetMarkers);
    getAttackPreviewLayer().addChild(preview.container);
    remoteAttackPreviews.set(attackId, preview);
  }

  preview.shape.clear();
  preview.targetMarkers.clear();
  drawAttackShape(preview.shape, geometry, Boolean(payload.processing));
  drawTargetMarkerPositions(preview.targetMarkers, payload.targetMarkers ?? []);
}

function removeRemoteAttackPreview(attackId = "") {
  const preview = remoteAttackPreviews.get(String(attackId));
  if (!preview) return;
  preview.container.destroy({ children: true });
  remoteAttackPreviews.delete(String(attackId));
}

function clearRemoteAttackPreviews() {
  for (const attackId of Array.from(remoteAttackPreviews.keys())) removeRemoteAttackPreview(attackId);
}

function serializeGeometry(geometry) {
  if (!geometry) return null;
  return {
    origin: serializePoint(geometry.origin),
    end: serializePoint(geometry.end),
    angle: Number(geometry.angle) || 0,
    distance: Number(geometry.distance) || 0,
    halfAngle: Number(geometry.halfAngle) || 0
  };
}

function deserializeGeometry(geometry) {
  if (!geometry?.origin || !geometry?.end) return null;
  return {
    origin: deserializePoint(geometry.origin),
    end: deserializePoint(geometry.end),
    angle: Number(geometry.angle) || 0,
    distance: Number(geometry.distance) || 0,
    halfAngle: Number(geometry.halfAngle) || 0
  };
}

function serializePoint(point) {
  return {
    x: Number(point?.x) || 0,
    y: Number(point?.y) || 0
  };
}

function deserializePoint(point) {
  return {
    x: Number(point?.x) || 0,
    y: Number(point?.y) || 0
  };
}

function isSamePreviewState(current, previous) {
  if (!current || !previous) return false;
  if (Boolean(current.processing) !== Boolean(previous.processing)) return false;
  if (!isSameGeometry(current.geometry, previous.geometry)) return false;
  return isSameMarkerList(current.targetMarkers, previous.targetMarkers);
}

function isSameGeometry(current, previous) {
  if (!current || !previous) return false;
  return isSamePoint(current.origin, previous.origin)
    && isSamePoint(current.end, previous.end)
    && Math.abs((Number(current.angle) || 0) - (Number(previous.angle) || 0)) <= PREVIEW_ANGLE_EPSILON
    && Math.abs((Number(current.distance) || 0) - (Number(previous.distance) || 0)) <= PREVIEW_POSITION_EPSILON
    && Math.abs((Number(current.halfAngle) || 0) - (Number(previous.halfAngle) || 0)) <= PREVIEW_ANGLE_EPSILON;
}

function isSameMarkerList(current = [], previous = []) {
  if (current.length !== previous.length) return false;
  return current.every((marker, index) => isSamePoint(marker, previous[index]));
}

function isSamePoint(current, previous) {
  if (!current || !previous) return false;
  return Math.abs((Number(current.x) || 0) - (Number(previous.x) || 0)) <= PREVIEW_POSITION_EPSILON
    && Math.abs((Number(current.y) || 0) - (Number(previous.y) || 0)) <= PREVIEW_POSITION_EPSILON;
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
    if (isDeadTarget(target)) return false;
    return Boolean(getVisibleTokenAttackPoint(attackerToken, target, geometry));
  }).sort((left, right) => getTargetDistance(left, geometry) - getTargetDistance(right, geometry));
}

function getVisibleTokenAttackPoint(attackerToken, target, geometry) {
  return getVisibleTokenAttackPoints(attackerToken, target, geometry).at(0) ?? null;
}

function getVisibleTokenAttackPoints(attackerToken, target, geometry) {
  return getTokenAttackSamplePoints(target).filter(point => (
    pointInAttackCone(point, geometry)
    && hasLineOfSight(attackerToken, point, geometry.origin)
  ));
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
    const marker = getTargetMarkerPosition(target);
    graphics.drawCircle(marker.x, marker.y, 7);
  }
  graphics.endFill();
}

function drawTargetMarkerPositions(graphics, markers = []) {
  graphics.beginFill(0xff1f1f, 0.95);
  graphics.lineStyle(1, 0x350000, 0.9);
  for (const marker of markers) {
    graphics.drawCircle(Number(marker.x) || 0, Number(marker.y) || 0, 7);
  }
  graphics.endFill();
}

function getTargetMarkerPosition(target) {
  const center = getTokenCenter(target);
  return {
    x: center.x,
    y: target.y + target.h + 8
  };
}

function buildAttackTrajectory(attackerToken, coneGeometry, targets = []) {
  const aimPoint = selectTrajectoryAimPoint(attackerToken, coneGeometry, targets);
  if (aimPoint) return buildTrajectoryThroughPoint(coneGeometry, aimPoint);
  return buildRandomTrajectory(coneGeometry);
}

function selectTrajectoryAimPoint(attackerToken, geometry, targets = []) {
  const candidates = (targets ?? [])
    .map(target => ({
      target,
      points: getVisibleTokenAttackPoints(attackerToken, target, geometry)
    }))
    .filter(candidate => candidate.points.length > 0);
  if (!candidates.length) return null;
  const candidate = candidates[Math.floor(Math.random() * candidates.length)];
  return candidate.points[Math.floor(Math.random() * candidate.points.length)];
}

function buildTrajectoryThroughPoint(geometry, point) {
  const angle = Math.atan2(point.y - geometry.origin.y, point.x - geometry.origin.x);
  return buildTrajectoryByAngle(geometry, angle);
}

function buildRandomTrajectory(geometry) {
  const spread = geometry.halfAngle > 0
    ? -geometry.halfAngle + (Math.random() * geometry.halfAngle * 2)
    : 0;
  return buildTrajectoryByAngle(geometry, geometry.angle + spread);
}

function buildTrajectoryByAngle(geometry, angle) {
  return {
    origin: geometry.origin,
    angle,
    distance: geometry.distance,
    halfAngle: 0,
    end: {
      x: geometry.origin.x + (Math.cos(angle) * geometry.distance),
      y: geometry.origin.y + (Math.sin(angle) * geometry.distance)
    }
  };
}

function getTrajectoryTargets(attackerToken, trajectory) {
  return (canvas.tokens?.placeables ?? [])
    .filter(target => target !== attackerToken && target.actor && target.visible && !isDeadTarget(target))
    .map(target => ({ target, hit: getTokenTrajectoryHit(target, trajectory) }))
    .filter(entry => entry.hit && hasLineOfSight(attackerToken, entry.hit.point, trajectory.origin))
    .sort((left, right) => left.hit.distance - right.hit.distance)
    .map(entry => entry.target);
}

function getWeaponDamage(weapon) {
  return Math.max(0, toInteger(weapon.system?.functions?.weapon?.damage));
}

function getWeaponPenetrationPower(weapon) {
  return Math.max(0, toInteger(weapon.system?.functions?.weapon?.penetration));
}

function getPenetratedDamageAmount(baseDamage, penetrationsUsed) {
  return Math.max(0, Math.round(Math.max(0, Number(baseDamage) || 0) * Math.max(0, 1 - (penetrationsUsed * 0.1))));
}

function getTargetDistance(target, geometry) {
  const distances = getTokenAttackSamplePoints(target)
    .filter(point => pointInAttackCone(point, geometry))
    .map(point => Math.hypot(point.x - geometry.origin.x, point.y - geometry.origin.y));
  if (distances.length) return Math.min(...distances);
  const center = getTokenCenter(target);
  return Math.hypot(center.x - geometry.origin.x, center.y - geometry.origin.y);
}

function getTokenTrajectoryHit(token, trajectory) {
  const bounds = getTokenBounds(token);
  const direction = {
    x: Math.cos(trajectory.angle),
    y: Math.sin(trajectory.angle)
  };
  const range = rayRectangleIntersection(trajectory.origin, direction, bounds, trajectory.distance);
  if (!range) return null;
  return {
    distance: range.entry,
    point: {
      x: trajectory.origin.x + (direction.x * range.entry),
      y: trajectory.origin.y + (direction.y * range.entry)
    }
  };
}

function getTokenBounds(token) {
  return {
    left: token.x,
    right: token.x + token.w,
    top: token.y,
    bottom: token.y + token.h
  };
}

function rayRectangleIntersection(origin, direction, bounds, maxDistance) {
  let entry = 0;
  let exit = maxDistance;

  const xRange = getAxisIntersectionRange(origin.x, direction.x, bounds.left, bounds.right);
  if (!xRange) return null;
  entry = Math.max(entry, xRange.entry);
  exit = Math.min(exit, xRange.exit);
  if (entry > exit) return null;

  const yRange = getAxisIntersectionRange(origin.y, direction.y, bounds.top, bounds.bottom);
  if (!yRange) return null;
  entry = Math.max(entry, yRange.entry);
  exit = Math.min(exit, yRange.exit);
  if (entry > exit) return null;

  return { entry, exit };
}

function getAxisIntersectionRange(origin, direction, min, max) {
  if (Math.abs(direction) < 0.000001) {
    return origin >= min && origin <= max
      ? { entry: Number.NEGATIVE_INFINITY, exit: Number.POSITIVE_INFINITY }
      : null;
  }
  const first = (min - origin) / direction;
  const second = (max - origin) / direction;
  return {
    entry: Math.min(first, second),
    exit: Math.max(first, second)
  };
}

async function applyQueuedDamageRequests(requests = []) {
  return requestDamageApplications(requests.filter(request => !isDeadActor(request.actor)));
}

function getTokenCenter(token) {
  return token.center ?? {
    x: token.x + (token.w / 2),
    y: token.y + (token.h / 2)
  };
}

function getTokenAttackSamplePoints(token) {
  const left = token.x;
  const right = token.x + token.w;
  const top = token.y;
  const bottom = token.y + token.h;
  const points = [];
  const steps = 4;
  for (let xIndex = 0; xIndex <= steps; xIndex += 1) {
    for (let yIndex = 0; yIndex <= steps; yIndex += 1) {
      points.push({
        x: left + ((right - left) * xIndex / steps),
        y: top + ((bottom - top) * yIndex / steps)
      });
    }
  }
  return points;
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

function getAttackPreviewLayer() {
  return canvas.controls._rulerPaths;
}
