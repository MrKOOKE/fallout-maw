import { createSkillCheckBatchCollector, requestSkillCheck } from "../rolls/skill-check.mjs";
import { SYSTEM_ID } from "../constants.mjs";
import { playWeaponAttackAnimations } from "./attack-animations.mjs";
import { estimateDamageApplication, requestDamageApplications } from "./damage-hub.mjs";
import { ITEM_FUNCTIONS, hasItemFunction } from "../utils/item-functions.mjs";
import { toInteger } from "../utils/numbers.mjs";

const WEAPON_ATTACK_SOCKET = `system.${SYSTEM_ID}`;
const WEAPON_ATTACK_SOCKET_SCOPE = "weaponAttackPreview";
const PREVIEW_BROADCAST_INTERVAL_MS = 16;
const PREVIEW_POSITION_EPSILON = 0.5;
const PREVIEW_ANGLE_EPSILON = 0.002;
const AIMED_TARGET_BLOCKER_BONUS_STEP = 20;
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
    this.aimedShot = isAimedShotAction(weapon, actionKey);
    this.aimedMode = "aim";
    this.hoveredTarget = null;
    this.selectedTarget = null;
    this.hoveredLimbKey = "";
    this.lockedGeometry = null;
    this.limbMenu = null;
    this.suppressNextContextMenu = false;
    this.attackId = foundry.utils.randomID();
    this.lastPreviewBroadcastAt = 0;
    this.lastBroadcastPreviewState = null;
    this.events = {
      move: event => this.onMove(event),
      confirm: event => this.onConfirm(event),
      cancel: event => this.onCancel(event),
      pointerDown: event => this.onPointerDown(event),
      tick: () => this.onTick()
    };
  }

  activate() {
    this.container.eventMode = "none";
    getAttackPreviewLayer().addChild(this.container);
    canvas.stage.on("mousemove", this.events.move);
    document.addEventListener("pointerdown", this.events.pointerDown, { capture: true });
    if (this.aimedShot) canvas.app.ticker.add(this.events.tick);
    canvas.app.view.oncontextmenu = this.events.cancel;
  }

  destroy() {
    canvas.stage.off("mousemove", this.events.move);
    document.removeEventListener("pointerdown", this.events.pointerDown, { capture: true });
    canvas.app?.ticker?.remove?.(this.events.tick);
    if (canvas.app?.view?.oncontextmenu === this.events.cancel) canvas.app.view.oncontextmenu = null;
    this.removeLimbMenu();
    broadcastAttackPreview({
      action: "clearPreview",
      attackId: this.attackId
    });
    this.container.destroy({ children: true });
  }

  onMove(event) {
    if (this.processing) return;
    event.stopPropagation();
    if (this.aimedShot && this.aimedMode === "limb") {
      this.refreshAimedLimbMenu();
      return;
    }
    this.pointer = event.data.getLocalPosition(getAttackPreviewLayer());
    this.refresh();
  }

  onPointerDown(event) {
    if (![0, 2].includes(event.button) || this.processing) return;
    if (this.handleLimbMenuPointerDown(event)) return;
    if (!isCanvasViewEvent(event)) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    event.cancelBubble = true;
    this.updatePointerFromClientEvent(event);
    if (event.button === 2) {
      this.suppressNextContextMenu = true;
      if (this.aimedShot && this.aimedMode === "limb") {
        this.unlockAimedTarget();
        return false;
      }
      cancelWeaponAttack();
      return false;
    }
    return this.onConfirm(event);
  }

  handleLimbMenuPointerDown(event) {
    if (!this.limbMenu?.contains(event.target)) return false;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();

    if (event.button === 2) {
      this.onCancel(event);
      return true;
    }

    const button = event.target?.closest?.("[data-limb-key]");
    if (!button || this.aimedMode !== "limb") return true;
    void this.performAimedAttack(button.dataset.limbKey ?? "");
    return true;
  }

  onCancel(event) {
    event?.preventDefault?.();
    if (this.suppressNextContextMenu) {
      this.suppressNextContextMenu = false;
      return false;
    }
    if (this.aimedShot && this.aimedMode === "limb") {
      this.unlockAimedTarget();
      return false;
    }
    cancelWeaponAttack();
    return false;
  }

  onTick() {
    if (!this.aimedShot || this.processing) return;
    if (!this.hoveredTarget && !this.selectedTarget) return;
    this.targetMarkers.clear();
    drawTargetMarkers(this.targetMarkers, this.targets, this.getFocusedTarget(), performance.now());
  }

  async onConfirm(event) {
    if (event.button !== 0 || this.processing) return;
    event.stopPropagation?.();
    event.preventDefault?.();
    this.updatePointerFromClientEvent(event);
    if (this.aimedShot) return this.onAimedConfirm();
    if (!this.pointer) return;
    const attackCount = getActionAttackCount(this.weapon, this.actionKey);
    if (!hasRequiredWeaponResources(this.weapon, attackCount)) return;

    this.processing = true;
    this.refresh(true);
    const trajectories = [];
    const damageRequests = [];
    const forceBatchCheckMessage = attackCount > 1;
    const collectCheckMessages = forceBatchCheckMessage || getWeaponPenetrationPower(this.weapon) > 0;
    const checkBatch = collectCheckMessages
      ? createSkillCheckBatchCollector({
        requester: "weaponAttack",
        title: this.weapon.name
      })
      : null;
    let attempted = false;
    for (let attackIndex = 0; attackIndex < attackCount; attackIndex += 1) {
      const result = await this.resolveAttackTrajectory({ checkBatch });
      if (result.trajectory) trajectories.push(result.trajectory);
      damageRequests.push(...result.damageRequests);
      attempted ||= result.attempted;
    }

    if (attempted) await spendWeaponResources(this.weapon, attackCount);
    await checkBatch?.publish({ forceBatch: forceBatchCheckMessage });
    if (attempted) {
      await playWeaponAttackAnimations({
        weapon: this.weapon,
        trajectories,
        delayMs: getWeaponAttackAnimationDelay(this.weapon)
      });
    }
    if (damageRequests.length) {
      await applyQueuedDamageRequests(damageRequests);
    }
    this.processing = false;
    this.refresh(true);
  }

  onAimedConfirm() {
    if (this.aimedMode !== "aim" || !this.hoveredTarget || !this.geometry) return undefined;
    const attackCount = getActionAttackCount(this.weapon, this.actionKey);
    if (!hasRequiredWeaponResources(this.weapon, attackCount)) return undefined;

    this.selectedTarget = this.hoveredTarget;
    this.lockedGeometry = serializeGeometry(this.geometry);
    this.aimedMode = "limb";
    this.refresh(true);
    this.refreshAimedLimbMenu();
    return undefined;
  }

  async performAimedAttack(limbKey) {
    if (this.processing || this.aimedMode !== "limb" || !this.selectedTarget) return;
    const attackCount = getActionAttackCount(this.weapon, this.actionKey);
    if (!hasRequiredWeaponResources(this.weapon, attackCount)) return;

    this.processing = true;
    this.removeLimbMenu();
    this.refresh(true);

    const target = this.selectedTarget;
    const geometry = deserializeGeometry(this.lockedGeometry) ?? this.geometry;
    const trajectory = buildTrajectoryThroughPoint(this.token, geometry, getTokenCenter(target));
    const blockerCount = getAimedTargetBlockers(this.token, target, trajectory).length;
    const result = await this.resolveAimedAttackTrajectory(target, trajectory, limbKey, {
      blockerBonus: getAimedTargetBlockerBonus(blockerCount)
    });

    await spendWeaponResources(this.weapon, attackCount);
    await result.checkBatch?.publish({ forceBatch: false });
    await playWeaponAttackAnimations({
      weapon: this.weapon,
      trajectories: [result.trajectory],
      delayMs: getWeaponAttackAnimationDelay(this.weapon)
    });
    if (result.damageRequests.length) await applyQueuedDamageRequests(result.damageRequests);

    this.processing = false;
    if (isDeadTarget(target)) this.unlockAimedTarget();
    this.refresh(true);
  }

  async resolveAimedAttackTrajectory(selectedTarget, trajectory, limbKey, { blockerBonus = 0 } = {}) {
    const damageRequests = [];
    const baseDamage = getWeaponDamage(this.weapon);
    const penetrationPower = getWeaponPenetrationPower(this.weapon);
    const penetrationThreshold = Math.ceil(baseDamage * 0.5);
    const checkBatch = penetrationPower > 0
      ? createSkillCheckBatchCollector({
        requester: "weaponAttack",
        title: this.weapon.name
      })
      : null;
    const targets = getTrajectoryTargetEntries(this.token, trajectory);
    const selectedEntry = targets.find(entry => entry.target === selectedTarget)
      ?? { target: selectedTarget, hit: getTokenTrajectoryHit(selectedTarget, trajectory) };
    const subsequentTargets = targets.filter(entry => (
      entry.target !== selectedTarget
      && (!selectedEntry.hit || entry.hit.distance > selectedEntry.hit.distance + 0.5)
    ));

    let penetrationsUsed = 0;
    let finalAnimationPoint = null;
    let hasSuccessfulHit = false;

    const firstRequest = await this.resolveAimedAttackAgainstTarget(selectedTarget, {
      limbKey,
      damageAmount: baseDamage,
      difficultyBonus: blockerBonus,
      penetrationStep: 0,
      checkBatch
    });
    if (!firstRequest) {
      updateTrajectoryEnd(trajectory, selectMissPointNearTarget(this.token, selectedTarget, trajectory));
      return { damageRequests, trajectory, checkBatch };
    }

    damageRequests.push(firstRequest);
    hasSuccessfulHit = true;
    finalAnimationPoint = selectPointOnTrajectoryPastTarget(selectedTarget, trajectory);

    if (penetrationsUsed < penetrationPower) {
      const estimate = estimateDamageApplication(firstRequest);
      if (estimate.healthDamage >= penetrationThreshold) penetrationsUsed += 1;
    }

    for (const entry of subsequentTargets) {
      if (penetrationsUsed <= 0 || penetrationsUsed > penetrationPower) break;
      const damageAmount = getPenetratedDamageAmount(baseDamage, penetrationsUsed);
      if (damageAmount <= 0) break;

      const request = await this.resolveAttackAgainstTarget(entry.target, {
        damageAmount,
        difficultyBonus: penetrationsUsed * 20,
        penetrationStep: penetrationsUsed,
        checkBatch
      });
      if (!request) {
        finalAnimationPoint = hasSuccessfulHit
          ? selectPointOnTrajectoryPastTarget(entry.target, trajectory)
          : selectMissPointNearTarget(this.token, entry.target, trajectory);
        break;
      }

      damageRequests.push(request);
      hasSuccessfulHit = true;
      finalAnimationPoint = selectPointOnTrajectoryPastTarget(entry.target, trajectory);
      if (penetrationsUsed >= penetrationPower) break;

      const estimate = estimateDamageApplication(request);
      if (estimate.healthDamage < penetrationThreshold) break;
      penetrationsUsed += 1;
    }

    if (finalAnimationPoint) {
      if (hasSuccessfulHit) updateTrajectoryDistanceEnd(trajectory, finalAnimationPoint);
      else updateTrajectoryEnd(trajectory, finalAnimationPoint);
    }
    return { damageRequests, trajectory, checkBatch };
  }

  async resolveAttackTrajectory({ checkBatch = null } = {}) {
    const damageRequests = [];
    const trajectory = buildAttackTrajectory(this.token, this.geometry, this.targets);
    if (!this.targets.length) return { attempted: true, damageRequests, trajectory };

    const targets = getTrajectoryTargetEntries(this.token, trajectory);
    const baseDamage = getWeaponDamage(this.weapon);
    const penetrationPower = getWeaponPenetrationPower(this.weapon);
    const penetrationThreshold = Math.ceil(baseDamage * 0.5);
    let penetrationsUsed = 0;
    let attempted = true;
    let finalAnimationPoint = null;
    let hasSuccessfulHit = false;

    for (const entry of targets) {
      const damageAmount = getPenetratedDamageAmount(baseDamage, penetrationsUsed);
      if (damageAmount <= 0) break;
      const request = await this.resolveAttackAgainstTarget(entry.target, {
        damageAmount,
        difficultyBonus: penetrationsUsed * 20,
        penetrationStep: penetrationsUsed,
        checkBatch
      });
      if (!request) {
        finalAnimationPoint = hasSuccessfulHit
          ? selectPointOnTrajectoryPastTarget(entry.target, trajectory)
          : selectMissPointNearTarget(this.token, entry.target, trajectory);
        break;
      }

      damageRequests.push(request);
      hasSuccessfulHit = true;
      finalAnimationPoint = selectPointOnTrajectoryPastTarget(entry.target, trajectory);
      if (penetrationsUsed >= penetrationPower) break;

      const estimate = estimateDamageApplication(request);
      if (estimate.healthDamage < penetrationThreshold) break;
      penetrationsUsed += 1;
    }

    if (finalAnimationPoint) {
      if (hasSuccessfulHit) updateTrajectoryDistanceEnd(trajectory, finalAnimationPoint);
      else updateTrajectoryEnd(trajectory, finalAnimationPoint);
    }
    return { attempted, damageRequests, trajectory };
  }

  async resolveAttackAgainstTarget(target, { damageAmount = 0, difficultyBonus = 0, penetrationStep = 0, checkBatch = null } = {}) {
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
      createMessage: !checkBatch,
      prompt: false,
      requester: "weaponAttack"
    });
    checkBatch?.add(outcome);
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

  async resolveAimedAttackAgainstTarget(target, { limbKey = "", damageAmount = 0, difficultyBonus = 0, penetrationStep = 0, checkBatch = null } = {}) {
    if (isDeadTarget(target)) return null;
    const outcome = await requestSkillCheck({
      actor: this.token.actor,
      skillKey: String(this.weapon.system?.functions?.weapon?.skillKey ?? ""),
      data: {
        difficulty: getAimedAttackDifficulty(target.actor, limbKey, difficultyBonus),
        situationalModifier: toInteger(this.weapon.system?.functions?.weapon?.accuracyBonus)
      },
      animate: false,
      createMessage: !checkBatch,
      prompt: false,
      requester: "weaponAttack"
    });
    checkBatch?.add(outcome);
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
    if (!this.pointer && !this.lockedGeometry) return;

    const origin = getTokenCenter(this.token);
    this.geometry = this.aimedShot && this.aimedMode === "limb"
      ? deserializeGeometry(this.lockedGeometry)
      : getAttackGeometry(this.weapon, this.token, origin, this.pointer);
    if (!this.geometry) return;
    drawAttackShape(this.shape, this.geometry, this.processing || (this.aimedShot && this.aimedMode === "limb"));
    this.targets = getPotentialTargets(this.token, this.geometry);
    this.hoveredTarget = this.aimedShot && this.aimedMode === "aim"
      ? getAimedTargetUnderPointer(this.pointer, this.targets)
      : this.selectedTarget;
    drawTargetMarkers(this.targetMarkers, this.targets, this.getFocusedTarget(), performance.now());
    if (this.aimedShot) this.refreshAimedLimbMenu();
    this.broadcastPreview(forceBroadcast);
  }

  getFocusedTarget() {
    return this.selectedTarget ?? this.hoveredTarget;
  }

  updatePointerFromClientEvent(event) {
    if (!Number.isFinite(Number(event?.clientX)) || !Number.isFinite(Number(event?.clientY))) return;
    this.pointer = canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
    if (!this.processing && !(this.aimedShot && this.aimedMode === "limb")) this.refresh();
  }

  unlockAimedTarget() {
    this.aimedMode = "aim";
    this.selectedTarget = null;
    this.hoveredLimbKey = "";
    this.lockedGeometry = null;
    this.removeLimbMenu();
    this.refresh(true);
  }

  refreshAimedLimbMenu() {
    if (!this.aimedShot || this.processing) return;
    const target = this.getFocusedTarget();
    if (!target) {
      this.removeLimbMenu();
      return;
    }

    const rows = this.prepareAimedLimbRows(target);
    if (!rows.length) {
      this.removeLimbMenu();
      return;
    }

    if (!this.limbMenu) this.createLimbMenu();
    this.limbMenu.dataset.mode = this.aimedMode;
    this.limbMenu.innerHTML = rows.map(row => `
      <button type="button" data-limb-key="${escapeHtml(row.key)}" class="${row.key === this.hoveredLimbKey ? "hover" : ""}">
        <span>${escapeHtml(row.label)}</span>
        <strong class="${getAimedChanceClass(row.chance)}">${row.chance}%</strong>
      </button>
    `).join("");
    this.positionLimbMenu(target);
    this.updateLimbMenuHover();
  }

  createLimbMenu() {
    this.limbMenu = document.createElement("div");
    this.limbMenu.className = "fallout-maw-aimed-limb-menu";
    this.limbMenu.addEventListener("contextmenu", event => {
      event.preventDefault();
      event.stopPropagation();
    });
    this.limbMenu.addEventListener("pointerover", event => {
      const button = event.target?.closest?.("[data-limb-key]");
      if (!button) return;
      this.hoveredLimbKey = button.dataset.limbKey ?? "";
      this.updateLimbMenuHover();
    });
    this.limbMenu.addEventListener("pointerout", event => {
      if (this.limbMenu?.contains(event.relatedTarget)) return;
      this.hoveredLimbKey = "";
      this.updateLimbMenuHover();
    });
    document.body.append(this.limbMenu);
  }

  updateLimbMenuHover() {
    for (const button of this.limbMenu?.querySelectorAll("[data-limb-key]") ?? []) {
      button.classList.toggle("hover", button.dataset.limbKey === this.hoveredLimbKey);
    }
  }

  removeLimbMenu() {
    this.limbMenu?.remove();
    this.limbMenu = null;
  }

  positionLimbMenu(target) {
    if (!this.limbMenu) return;
    const topLeft = canvas.clientCoordinatesFromCanvas({ x: target.x, y: target.y });
    const bottomRight = canvas.clientCoordinatesFromCanvas({ x: target.x + target.w, y: target.y + target.h });
    const rect = this.limbMenu.getBoundingClientRect();
    const margin = 8;
    const left = Math.max(margin, Math.min(window.innerWidth - rect.width - margin, topLeft.x - rect.width - 10));
    const top = Math.max(margin, Math.min(window.innerHeight - rect.height - margin, (topLeft.y + bottomRight.y - rect.height) / 2));
    this.limbMenu.style.left = `${Math.round(left)}px`;
    this.limbMenu.style.top = `${Math.round(top)}px`;
  }

  prepareAimedLimbRows(target) {
    const trajectory = this.geometry ? buildTrajectoryThroughPoint(this.token, this.geometry, getTokenCenter(target)) : null;
    const blockerCount = trajectory ? getAimedTargetBlockers(this.token, target, trajectory).length : 0;
    const blockerBonus = getAimedTargetBlockerBonus(blockerCount);
    return Object.entries(target.actor?.system?.limbs ?? {})
      .filter(([_key, limb]) => limb && typeof limb === "object")
      .map(([key, limb]) => ({
        key,
        label: String(limb.label ?? key),
        chance: getAimedAttackHitChance(this.token.actor, this.weapon, target.actor, key, blockerBonus)
      }));
  }

  broadcastPreview(force = false) {
    const now = performance.now();
    if (!force && now - this.lastPreviewBroadcastAt < PREVIEW_BROADCAST_INTERVAL_MS) return;
    const previewState = {
      geometry: serializeGeometry(this.geometry),
      targetMarkers: this.targets.map(getTargetMarkerPosition),
      focusedTargetMarker: this.getFocusedTarget() ? getTargetCenterMarkerPosition(this.getFocusedTarget()) : null,
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
  drawTargetMarkerPositions(preview.targetMarkers, payload.targetMarkers ?? [], payload.focusedTargetMarker ?? null);
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
    halfAngle: Number(geometry.halfAngle) || 0,
    shapePoints: Array.isArray(geometry.shapePoints) ? geometry.shapePoints.map(serializePoint) : []
  };
}

function deserializeGeometry(geometry) {
  if (!geometry?.origin || !geometry?.end) return null;
  return {
    origin: deserializePoint(geometry.origin),
    end: deserializePoint(geometry.end),
    angle: Number(geometry.angle) || 0,
    distance: Number(geometry.distance) || 0,
    halfAngle: Number(geometry.halfAngle) || 0,
    shapePoints: Array.isArray(geometry.shapePoints) ? geometry.shapePoints.map(deserializePoint) : []
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
  return isSameMarkerList(current.targetMarkers, previous.targetMarkers)
    && isSameNullablePoint(current.focusedTargetMarker, previous.focusedTargetMarker);
}

function isSameGeometry(current, previous) {
  if (!current || !previous) return false;
  return isSamePoint(current.origin, previous.origin)
    && isSamePoint(current.end, previous.end)
    && Math.abs((Number(current.angle) || 0) - (Number(previous.angle) || 0)) <= PREVIEW_ANGLE_EPSILON
    && Math.abs((Number(current.distance) || 0) - (Number(previous.distance) || 0)) <= PREVIEW_POSITION_EPSILON
    && Math.abs((Number(current.halfAngle) || 0) - (Number(previous.halfAngle) || 0)) <= PREVIEW_ANGLE_EPSILON
    && isSamePointList(current.shapePoints, previous.shapePoints);
}

function isSameMarkerList(current = [], previous = []) {
  if (current.length !== previous.length) return false;
  return current.every((marker, index) => isSamePoint(marker, previous[index]));
}

function isSamePointList(current = [], previous = []) {
  if (current.length !== previous.length) return false;
  return current.every((point, index) => isSamePoint(point, previous[index]));
}

function isSamePoint(current, previous) {
  if (!current || !previous) return false;
  return Math.abs((Number(current.x) || 0) - (Number(previous.x) || 0)) <= PREVIEW_POSITION_EPSILON
    && Math.abs((Number(current.y) || 0) - (Number(previous.y) || 0)) <= PREVIEW_POSITION_EPSILON;
}

function isSameNullablePoint(current, previous) {
  if (!current && !previous) return true;
  if (!current || !previous) return false;
  return isSamePoint(current, previous);
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

function getAttackGeometry(weapon, attackerToken, origin, pointer) {
  const maxDistancePixels = metersToPixels(Number(weapon.system?.functions?.weapon?.maxRangeMeters) || 0);
  const dx = pointer.x - origin.x;
  const dy = pointer.y - origin.y;
  const angle = Math.atan2(dy, dx);
  const distance = Math.max(1, maxDistancePixels);
  const halfAngle = Math.max(0, (Number(weapon.system?.functions?.weapon?.attackConeDegrees) || 0) * (Math.PI / 180) / 2);
  const end = getWallClippedEndpoint(attackerToken, origin, angle, distance).point;
  const shapePoints = buildClippedConePoints(attackerToken, { origin, angle, distance, halfAngle });
  return { origin, angle, distance, halfAngle, end, shapePoints };
}

function metersToPixels(meters) {
  const gridDistance = Math.max(0.0001, Number(canvas.scene?.grid?.distance ?? canvas.grid?.distance) || 1);
  const gridSize = Math.max(1, Number(canvas.grid?.size) || 100);
  return Math.max(0, meters) * (gridSize / gridDistance);
}

function drawAttackShape(graphics, geometry, locked) {
  const color = locked ? 0xffd166 : 0xff3b3b;
  const alpha = locked ? 0.24 : 0.18;
  const points = Array.isArray(geometry.shapePoints) && geometry.shapePoints.length
    ? geometry.shapePoints.flatMap(point => [point.x, point.y])
    : buildConePoints(geometry);
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

function buildClippedConePoints(attackerToken, { origin, angle, distance, halfAngle }) {
  if (halfAngle <= 0) return [];
  const points = [origin];
  const segments = 24;
  for (let index = 0; index <= segments; index += 1) {
    const step = -halfAngle + ((halfAngle * 2 * index) / segments);
    points.push(getWallClippedEndpoint(attackerToken, origin, angle + step, distance).point);
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

function getWallClippedEndpoint(attackerToken, origin, angle, distance) {
  const maxDistance = Math.max(1, Number(distance) || 1);
  const destination = {
    x: origin.x + (Math.cos(angle) * maxDistance),
    y: origin.y + (Math.sin(angle) * maxDistance)
  };
  const collision = attackerToken?.checkCollision?.(destination, {
    origin,
    type: "sight",
    mode: "closest"
  });
  const point = collision
    ? { x: Number(collision.x) || destination.x, y: Number(collision.y) || destination.y }
    : destination;
  return {
    point,
    distance: Math.max(1, Math.hypot(point.x - origin.x, point.y - origin.y))
  };
}

function pointInAttackCone(point, { origin, angle, distance, halfAngle }) {
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  const range = Math.hypot(dx, dy);
  if (range > distance) return false;
  if (halfAngle <= 0) return Math.abs(normalizeAngle(Math.atan2(dy, dx) - angle)) < 0.025;
  return Math.abs(normalizeAngle(Math.atan2(dy, dx) - angle)) <= halfAngle;
}

function drawTargetMarkers(graphics, targets, focusedTarget = null, time = performance.now()) {
  graphics.beginFill(0xff1f1f, 0.95);
  graphics.lineStyle(1, 0x350000, 0.9);
  for (const target of targets) {
    const marker = getTargetMarkerPosition(target);
    graphics.drawCircle(marker.x, marker.y, 7);
  }
  graphics.endFill();
  if (focusedTarget) drawFocusedTargetMarker(graphics, getTargetCenterMarkerPosition(focusedTarget), time);
}

function drawTargetMarkerPositions(graphics, markers = [], focusedMarker = null) {
  graphics.beginFill(0xff1f1f, 0.95);
  graphics.lineStyle(1, 0x350000, 0.9);
  for (const marker of markers) {
    graphics.drawCircle(Number(marker.x) || 0, Number(marker.y) || 0, 7);
  }
  graphics.endFill();
  if (focusedMarker) drawFocusedTargetMarker(graphics, focusedMarker, performance.now());
}

function getTargetMarkerPosition(target) {
  const center = getTokenCenter(target);
  return {
    x: center.x,
    y: target.y + target.h + 8
  };
}

function getTargetCenterMarkerPosition(target) {
  return getTokenCenter(target);
}

function drawFocusedTargetMarker(graphics, marker, time = performance.now()) {
  const pulse = (Math.sin((Number(time) || 0) / 420) + 1) / 2;
  const radius = 10 + (pulse * 5);
  const alpha = 0.35 + (pulse * 0.35);
  graphics.lineStyle(3, 0x39ff88, alpha);
  graphics.beginFill(0x39ff88, 0.12 + (pulse * 0.1));
  graphics.drawCircle(Number(marker.x) || 0, Number(marker.y) || 0, radius);
  graphics.endFill();
  graphics.lineStyle(1, 0xd9ffe8, 0.85);
  graphics.drawCircle(Number(marker.x) || 0, Number(marker.y) || 0, 4);
}

function buildAttackTrajectory(attackerToken, coneGeometry, targets = []) {
  const aimPoint = selectTrajectoryAimPoint(attackerToken, coneGeometry, targets);
  if (aimPoint) return buildTrajectoryThroughPoint(attackerToken, coneGeometry, aimPoint);
  return buildRandomTrajectory(attackerToken, coneGeometry);
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

function buildTrajectoryThroughPoint(attackerToken, geometry, point) {
  const angle = Math.atan2(point.y - geometry.origin.y, point.x - geometry.origin.x);
  return buildTrajectoryByAngle(attackerToken, geometry, angle);
}

function buildRandomTrajectory(attackerToken, geometry) {
  const spread = geometry.halfAngle > 0
    ? -geometry.halfAngle + (Math.random() * geometry.halfAngle * 2)
    : 0;
  return buildTrajectoryByAngle(attackerToken, geometry, geometry.angle + spread);
}

function buildTrajectoryByAngle(attackerToken, geometry, angle) {
  const clipped = getWallClippedEndpoint(attackerToken, geometry.origin, angle, geometry.distance);
  return {
    origin: geometry.origin,
    angle,
    distance: clipped.distance,
    halfAngle: 0,
    end: clipped.point
  };
}

function getTrajectoryTargetEntries(attackerToken, trajectory) {
  return (canvas.tokens?.placeables ?? [])
    .filter(target => target !== attackerToken && target.actor && target.visible && !isDeadTarget(target))
    .map(target => ({ target, hit: getTokenTrajectoryHit(target, trajectory) }))
    .filter(entry => entry.hit && hasLineOfSight(attackerToken, entry.hit.point, trajectory.origin))
    .sort((left, right) => left.hit.distance - right.hit.distance);
}

function updateTrajectoryEnd(trajectory, point) {
  const dx = point.x - trajectory.origin.x;
  const dy = point.y - trajectory.origin.y;
  trajectory.end = { x: point.x, y: point.y };
  trajectory.angle = Math.atan2(dy, dx);
  trajectory.distance = Math.max(1, Math.hypot(dx, dy));
}

function updateTrajectoryDistanceEnd(trajectory, point) {
  const distance = Math.max(1, getProjectedDistanceOnTrajectory(point, trajectory));
  trajectory.distance = distance;
  trajectory.end = getPointOnTrajectory(trajectory, distance);
}

function selectMissPointNearTarget(attackerToken, target, trajectory) {
  const gridSize = Math.max(1, Number(canvas.grid?.size) || 100);
  const offsets = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0], [1, 0],
    [-1, 1], [0, 1], [1, 1]
  ];
  const offset = offsets[Math.floor(Math.random() * offsets.length)];
  const center = getTokenCenter(target);
  const missPoint = {
    x: center.x + (offset[0] * gridSize) + ((Math.random() - 0.5) * gridSize * 0.8),
    y: center.y + (offset[1] * gridSize) + ((Math.random() - 0.5) * gridSize * 0.8)
  };
  const angle = Math.atan2(missPoint.y - trajectory.origin.y, missPoint.x - trajectory.origin.x);
  const maxDistance = Math.min(trajectory.distance, Math.hypot(missPoint.x - trajectory.origin.x, missPoint.y - trajectory.origin.y));
  return getWallClippedEndpoint(attackerToken, trajectory.origin, angle, maxDistance).point;
}

function selectPointOnTrajectoryPastTarget(target, trajectory) {
  const hit = getTokenTrajectoryHit(target, trajectory);
  const gridSize = Math.max(1, Number(canvas.grid?.size) || 100);
  const targetDepth = Math.max(target.w ?? 0, target.h ?? 0, gridSize * 0.35);
  const distance = hit
    ? Math.min(trajectory.distance, hit.distance + targetDepth)
    : Math.min(trajectory.distance, getProjectedDistanceOnTrajectory(getTokenCenter(target), trajectory));
  return getPointOnTrajectory(trajectory, distance);
}

function getProjectedDistanceOnTrajectory(point, trajectory) {
  const dx = point.x - trajectory.origin.x;
  const dy = point.y - trajectory.origin.y;
  return Math.max(1, (dx * Math.cos(trajectory.angle)) + (dy * Math.sin(trajectory.angle)));
}

function getPointOnTrajectory(trajectory, distance) {
  return {
    x: trajectory.origin.x + (Math.cos(trajectory.angle) * distance),
    y: trajectory.origin.y + (Math.sin(trajectory.angle) * distance)
  };
}

function getWeaponDamage(weapon) {
  return Math.max(0, toInteger(weapon.system?.functions?.weapon?.damage));
}

function getWeaponPenetrationPower(weapon) {
  return Math.max(0, toInteger(weapon.system?.functions?.weapon?.penetration));
}

function getWeaponAttackAnimationDelay(weapon) {
  return Math.max(0, toInteger(weapon.system?.functions?.weapon?.attackAnimationDelayMs));
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

function isAimedShotAction(weapon, actionKey) {
  return actionKey === "aimedShot" && Boolean(weapon.system?.functions?.weapon?.availableActions?.aimedShot);
}

function getAimedTargetUnderPointer(pointer, targets = []) {
  if (!pointer) return null;
  return targets.find(target => {
    const bounds = getTokenBounds(target);
    return pointer.x >= bounds.left
      && pointer.x <= bounds.right
      && pointer.y >= bounds.top
      && pointer.y <= bounds.bottom;
  }) ?? null;
}

function getAimedAttackDifficulty(targetActor, limbKey = "", blockerBonus = 0) {
  const dodge = getDodgeDifficulty(targetActor);
  const limbPercent = toInteger(targetActor.system?.limbs?.[limbKey]?.aimedDifficultyPercent);
  return dodge + Math.round(dodge * (limbPercent / 100)) + Math.max(0, toInteger(blockerBonus));
}

function getAimedAttackHitChance(attackerActor, weapon, targetActor, limbKey = "", blockerBonus = 0) {
  const skillKey = String(weapon.system?.functions?.weapon?.skillKey ?? "");
  const finalSkillValue = toInteger(attackerActor.system?.skills?.[skillKey]?.value)
    + toInteger(weapon.system?.functions?.weapon?.accuracyBonus);
  const difficulty = getAimedAttackDifficulty(targetActor, limbKey, blockerBonus);
  if ((difficulty - finalSkillValue) >= 100) return 0;

  const gambling = toInteger(attackerActor.system?.skills?.gambling?.value);
  const criticalFailureMaximum = clamp(5, 0, 100);
  const criticalSuccessMinimum = Math.ceil(101 - clamp(4 + (gambling / 20), 0, 100));
  let successes = 0;
  for (let roll = 1; roll <= 100; roll += 1) {
    if (criticalFailureMaximum > 0 && roll <= criticalFailureMaximum) continue;
    if (criticalSuccessMinimum <= 100 && roll >= criticalSuccessMinimum) {
      successes += 1;
      continue;
    }
    if (finalSkillValue + roll >= difficulty) successes += 1;
  }
  return clamp(successes, 0, 100);
}

function getAimedChanceClass(chance) {
  const value = toInteger(chance);
  if (value >= 80) return "chance-high";
  if (value >= 30) return "chance-medium";
  return "chance-low";
}

function getAimedTargetBlockers(attackerToken, selectedTarget, trajectory) {
  const selectedHit = getTokenTrajectoryHit(selectedTarget, trajectory);
  if (!selectedHit) return [];
  return getTrajectoryTargetEntries(attackerToken, trajectory)
    .filter(entry => entry.target !== selectedTarget && entry.hit.distance < selectedHit.distance - 0.5);
}

function getAimedTargetBlockerBonus(blockerCount) {
  const count = Math.max(0, toInteger(blockerCount));
  return (count * (count + 1) / 2) * AIMED_TARGET_BLOCKER_BONUS_STEP;
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

function clamp(value, min, max) {
  return Math.min(Math.max(Number(value) || 0, min), max);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[character]));
}

function isCanvasViewEvent(event) {
  const view = canvas.app?.view;
  if (!view) return false;
  if (event.target === view) return true;
  return Array.from(event.composedPath?.() ?? []).includes(view);
}

function getAttackPreviewLayer() {
  return canvas.controls._rulerPaths;
}
