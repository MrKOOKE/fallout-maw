import { getConstructVisualRuntimeConfig, getConstructVisualRuntimeRevision, resolveConstructVisualLayers } from "../utils/construct-visual-model.mjs";
import { getConstructMovementEnergyState, getConstructSystemState } from "../utils/construct-systems.mjs";
import { resolveConstructVisualAnchors } from "../utils/construct-visual-model.mjs";
import { resolveConstructJointRotations, getConstructJointRotationAnchors } from "../utils/construct-joint-rotations.mjs";
import { planRotationSector, rotationDelta, rotationSectorBounds } from "../utils/construct-rotation-cost.mjs";
import { usesFootprintRouteRotation } from "../utils/token-footprint-route.mjs";
import { getActorActiveCombat } from "../combat/combat-membership.mjs";
import { getResourceLimitState } from "../combat/resource-limits.mjs";
import { prepareActorResourceSpend, runOneTimeResourceMutation } from "../combat/one-time-resources.mjs";
import { registerActorTurnStartPreparedHandler } from "../combat/turn-events.mjs";
import { INVENTORY_RENDER_PARTS_OPTION } from "../inventory/constants.mjs";

const SYSTEM = "fallout-maw", FLAG = "constructRotationBudget";
const EMPTY_FLAG = Object.freeze({});
let isOwnTurn = (actor, combat) => combat?.combatant?.actor?.uuid === actor?.uuid;
let getPartRotations = doc => resolveConstructJointRotations(doc.actor, doc.getFlag?.(SYSTEM, "constructVisualState") ?? {});
const contexts = new WeakMap(), progress = new WeakMap(), initialPoses = new WeakMap();
let combatRevision = 0;
const tokenKey = doc => `${doc?.parent?.id ?? "prototype"}_${doc?.id ?? "prototype"}`;
const readFlag = actor => actor?.getFlag?.(SYSTEM, FLAG) ?? actor?.flags?.[SYSTEM]?.[FLAG] ?? EMPTY_FLAG;

export function getConstructRotationAngle(doc, slotId = "hull") {
  if (slotId === "hull") return Number(doc._source?.rotation ?? doc.rotation) || 0;
  return resolveConstructVisualLayers(doc.actor, { rotations: getPartRotations(doc) })
    .find(part => part.slotId === slotId)?.rotation ?? 0;
}

function getRotationMountAngle(doc, slotId) {
  if (slotId === "hull") return 0;
  const part = getConstructVisualRuntimeConfig(doc.actor).parts.find(row => row.slotId === slotId);
  return resolveConstructVisualAnchors(doc.actor, { rotations: getPartRotations(doc) })
    .find(anchor => anchor.id === part?.anchorId)?.rotation ?? 0;
}

export function getConstructRotationState(doc, slotId = "hull") {
  const revision = getConstructVisualRuntimeRevision(), flag = readFlag(doc?.actor);
  const anchorRotation = getRotationMountAngle(doc, slotId);
  const signature = [revision, combatRevision, flag, doc?._source?.rotation,
    doc?.getFlag?.(SYSTEM, "constructVisualState"), anchorRotation];
  const cached = contexts.get(doc)?.get(slotId);
  if (revision !== null && cached && signature.every((value, i) => value === cached.signature[i])) return withProgress(doc, slotId, cached.context);
  const combat = getActorActiveCombat(doc?.actor);
  const actor = doc?.actor, config = getConstructVisualRuntimeConfig(actor);
  const part = slotId === "hull" ? null : config.parts.find(row => row.slotId === slotId && row.rotates);
  const profile = slotId === "hull" ? config.hullRotationCost : part?.rotationCost;
  const saved = flag.combatId === combat?.id ? flag.tokens?.[tokenKey(doc)]?.[slotId] : null;
  const hasPaidSector = Boolean(combat && saved && saved.turnId === flag.turnId && saved.min !== null && saved.min !== undefined);
  const limits = getResourceLimitState(actor).resources;
  const drive = slotId === "hull" ? getConstructMovementEnergyState(actor, { resourceLimits: limits }) : null;
  const costs = new Map(drive?.costs ?? []);
  let powered = actor?.type !== "construct" || slotId === "hull"
    ? !drive || drive.operational && (drive.budget > 0 || hasPaidSector) : Boolean(part);
  for (const id of part?.rotationSystemIds ?? []) {
    const system = getConstructSystemState(actor, id);
    powered &&= Boolean(system?.operational && (system.available > 0 || hasPaidSector));
    if (system) costs.set(system.system.resourceKey, (costs.get(system.system.resourceKey) ?? 0) + Math.max(1, Number(system.system.energyPerMovementPoint) || 1));
  }
  const angle = getConstructRotationAngle(doc, slotId);
  const turnId = flag.combatId === combat?.id && flag.turnId
    ? flag.turnId : `${combat?.id}:${combat?.round}:${combat?.turn}`;
  let initial = initialPoses.get(doc)?.get(slotId);
  if (!initial || initial.turnId !== turnId) {
    initial = { angle, turnId, anchorRotation };
    let map = initialPoses.get(doc); if (!map) initialPoses.set(doc, map = new Map());
    map.set(slotId, initial);
  }
  const state = saved && saved.turnId === flag.turnId ? { ...saved }
    : { origin: combat ? initial.angle : angle, last: angle, min: null, max: null };
  if (slotId !== "hull") {
    const storedReference = getConstructJointRotationAnchors(actor, doc.getFlag?.(SYSTEM, "constructVisualState") ?? {})[slotId];
    const reference = state.anchorRotation ?? (saved ? storedReference ?? initial.anchorRotation : initial.anchorRotation);
    const carried = rotationDelta(reference, anchorRotation);
    state.origin += carried;
    state.last += carried;
    state.anchorRotation = anchorRotation;
  }
  // The centered cone shown at turn start is free. Only its extensions are paid.
  // Existing ledgers retain their angle reference until the next turn.
  state.offset ??= state.min === null || state.min === undefined
    ? slotId === "hull" ? 0 : -(Number(profile?.degrees) || 30) / 2 : 0;
  if (slotId !== "hull" && (state.min === null || state.min === undefined)) state.min = state.max = 0;
  const pose = progress.get(doc)?.get(slotId);
  state.last = pose && pose.turnId === turnId
    ? pose.last + (slotId === "hull" ? 0 : rotationDelta(pose.anchorRotation ?? anchorRotation, anchorRotation))
    : state.last + rotationDelta(state.last, angle);
  const mp = actor?.system?.resources?.movementPoints ?? {};
  let budget = !combat ? Infinity : isOwnTurn(actor, combat)
    ? Math.max(0, (Number(mp.value) || 0) - (Number(mp.min) || 0) + (Number(mp.once) || 0) - (limits.movementPoints?.amount ?? 0)) : 0;
  for (const [key, rate] of costs) {
    const resource = actor?.system?.resources?.[key];
    budget = Math.min(budget, Math.floor(Math.max(0, (Number(resource?.value) || 0) - (Number(resource?.min) || 0)
      + (Number(resource?.once) || 0) - (limits[key]?.amount ?? 0)) / rate));
  }
  const context = { profile: profile ?? { points: 0, degrees: 15 }, part, powered, combat, state, costs,
    budget: powered ? budget : 0, flag, turnId, anchorRotation };
  let map = contexts.get(doc); if (!map) contexts.set(doc, map = new Map());
  map.set(slotId, { signature, context });
  return withProgress(doc, slotId, context);
}

function withProgress(doc, slotId, context) {
  const pose = progress.get(doc)?.get(slotId);
  const carried = slotId === "hull" ? 0 : rotationDelta(pose?.anchorRotation ?? context.anchorRotation, context.anchorRotation);
  return pose && pose.turnId === context.turnId ? { ...context, state: { ...context.state, last: pose.last + carried } } : context;
}

export function getConstructRotationPrice(doc, slotId, target) {
  const context = getConstructRotationState(doc, slotId);
  return context.combat ? planRotationSector(context.state, target, context.profile).cost : 0;
}

export function recordConstructRotationProgress(doc, slotId, angle) {
  const context = getConstructRotationState(doc, slotId);
  let map = progress.get(doc); if (!map) progress.set(doc, map = new Map());
  map.set(slotId, { last: context.state.last + rotationDelta(context.state.last, angle), turnId: context.turnId,
    anchorRotation: context.anchorRotation });
}

/** Pure preview of the same ledger used by the authority. Hull yaw never enters a part's ledger. */
export function planConstructRotation(doc, slotId, target, { budget, state } = {}) {
  const context = getConstructRotationState(doc, slotId);
  const current = state ?? context.state;
  if (!context.powered) return { ...context, state: current, rotation: current.last, cost: 0, reached: false };
  if (!context.combat || !context.profile.points) return { ...context, state: { ...current, last: target }, rotation: target, cost: 0, reached: true };
  const plan = planRotationSector(current, target, context.profile, budget ?? context.budget);
  if (slotId !== "hull") plan.state.anchorRotation = context.anchorRotation;
  return { ...context, ...plan };
}

export function isConstructRotationPaid(doc, slotId, target) {
  return planConstructRotation(doc, slotId, target, { budget: 0 }).reached;
}

export function getConstructRotationBoundaries(doc, slotId) {
  const context = getConstructRotationState(doc, slotId);
  if (!context.combat || !context.profile.points) return null;
  return { ...context, bounds: rotationSectorBounds(context.state, context.profile)
    ?? { min: context.state.origin, max: context.state.origin } };
}

/** Buy only sectors that will actually be entered. No Actor write within a paid interval. */
export async function purchaseConstructRotation(doc, slotId, target, { path = null, notify = true } = {}) {
  if (!Number.isFinite(target)) throw new Error("Недопустимый угол поворота.");
  const result = await runOneTimeResourceMutation(doc.actor, async () => {
    let plan = planConstructRotation(doc, slotId, target);
    if (path && plan.combat && plan.profile.points) {
      let state = getConstructRotationState(doc, slotId).state, total = 0;
      for (const angle of getRouteAngles(doc, path)) {
        const step = planConstructRotation(doc, slotId, angle, { state, budget: plan.budget - total });
        if (!step.reached) throw new Error("Не хватает ОП или энергии для поворотов на маршруте.");
        state = step.state; total += step.cost;
      }
      plan = { ...plan, state, cost: total, rotation: state.last, reached: true };
    }
    if (!plan.powered) throw new Error("Поворот недоступен: включите требуемую систему и пополните энергию.");
    if (!plan.combat || !plan.profile.points) return plan;
    if (!plan.cost) return plan;
    const mp = prepareActorResourceSpend(doc.actor, "movementPoints", plan.cost, { available: plan.budget });
    const energy = Array.from(plan.costs, ([key, rate]) => prepareActorResourceSpend(doc.actor, key, plan.cost * rate));
    if (!mp || energy.some(row => !row)) throw new Error("Не хватает ОП или энергии для поворота.");
    const flag = plan.flag, key = tokenKey(doc), turnId = flag.combatId === plan.combat.id ? flag.turnId : `${plan.combat.id}:initial`;
    const ledger = { ...flag, combatId: plan.combat.id, turnId, tokens: { ...flag.tokens,
      [key]: { ...flag.tokens?.[key], [slotId]: { ...plan.state, turnId } } } };
    const plans = [mp, ...energy], updates = Object.assign({}, ...plans.map(row => row.updates), {
      [`flags.${SYSTEM}.${FLAG}.combatId`]: plan.combat.id,
      [`flags.${SYSTEM}.${FLAG}.turnId`]: turnId,
      [`flags.${SYSTEM}.${FLAG}.tokens.${key}.${slotId}`]: ledger.tokens[key][slotId]
    });
    const updated = await doc.actor.update(updates, { falloutMawReactionResourceUpdate: true,
      [INVENTORY_RENDER_PARTS_OPTION]: ["indicators"] });
    if (!updated || plans.some(row => Number(doc.actor.system.resources[row.resourceKey].value) !== row.next
      || Number(doc.actor.system.resources[row.resourceKey].once || 0) !== row.onceBefore - row.onceSpent))
      throw new Error("Оплата поворота отменена.");
    return { ...plan, receipt: { tokenUuid: doc.uuid, actorUuid: doc.actor.uuid, slotId, before: flag,
      after: ledger, resources: Object.fromEntries(plans.map(row => [row.resourceKey, row.amount])),
      once: Object.fromEntries(plans.map(row => [row.resourceKey, row.onceSpent])) } };
  });
  if (result.receipt && notify) await notifyConstructRotationSpent(doc.actor, result.receipt);
  return result;
}

export async function notifyConstructRotationSpent(actor, receipt) {
  const { notifyCombatResourcesSpent } = await import("../combat/resource-spending.mjs");
  await notifyCombatResourcesSpent(actor, receipt.resources, { type: "rotation", slotId: receipt.slotId });
}

/** Native update cancellation must not consume resources or unlock angles. */
export async function refundConstructRotation(receipt) {
  if (!receipt) return;
  const actor = await globalThis.fromUuid?.(receipt.actorUuid);
  if (!actor) return;
  await runOneTimeResourceMutation(actor, async () => {
    const updates = {};
    for (const [key, amount] of Object.entries(receipt.resources)) {
      const resource = actor.system.resources[key], once = receipt.once[key] || 0;
      const value = Math.min(Number(resource.max), Number(resource.value) + amount - once);
      updates[`system.resources.${key}.value`] = value;
      updates[`system.resources.${key}.spent`] = Math.max(0, Number(resource.max) - value);
      updates[`system.resources.${key}.once`] = (Number(resource.once) || 0) + once;
    }
    const doc = await globalThis.fromUuid?.(receipt.tokenUuid);
    const flag = readFlag(actor), key = tokenKey(doc);
    const restoreSector = sameRotationSector(flag.tokens?.[key]?.[receipt.slotId], receipt.after.tokens?.[key]?.[receipt.slotId]);
    if (restoreSector)
      updates[`flags.${SYSTEM}.${FLAG}.tokens.${key}.${receipt.slotId}`] = receipt.before.tokens?.[key]?.[receipt.slotId]
        ?? { origin: receipt.after.tokens[key][receipt.slotId].origin, last: receipt.after.tokens[key][receipt.slotId].origin, min: null, max: null, turnId: flag.turnId };
    const updated = await actor.update(updates, { falloutMawReactionResourceUpdate: true,
      [INVENTORY_RENDER_PARTS_OPTION]: ["indicators"] });
    if (updated && restoreSector && doc) progress.get(doc)?.delete(receipt.slotId);
  });
}

function sameRotationSector(left, right) {
  if (!left || !right) return left === right;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every(key => Object.hasOwn(right, key) && left[key] === right[key]);
}

export function getConstructRouteRotationCost(doc, path = [], { unlimited = true, autoRotate = usesFootprintRouteRotation(doc) } = {}) {
  if (!autoRotate || path.length < 2 || doc.actor?.type !== "construct") return 0;
  const context = getConstructRotationState(doc, "hull");
  if (!context.combat || !context.profile.points) return 0;
  const budget = unlimited ? Infinity : context.budget;
  let state = context.state, total = 0;
  for (const angle of getRouteAngles(doc, path)) {
    const plan = planRotationSector(state, angle, context.profile, budget - total);
    total += plan.cost; state = plan.state;
  }
  return total;
}

function getRouteAngles(doc, path) {
  const result = [];
  for (let start = 0; start < path.length - 1;) {
    let end = start + 1;
    while (end < path.length - 1 && path[end].intermediate) end++;
    const from = doc.getCenterPoint(path[start]), to = doc.getCenterPoint(path[end]);
    if (!globalThis.CONFIG?.Token?.movement?.actions?.[path[end].action]?.teleport && Math.hypot(to.x - from.x, to.y - from.y) > 1e-6)
      result.push(((Math.atan2(to.y - from.y, to.x - from.x) * 180 / Math.PI - 90) % 360 + 360) % 360);
    start = end;
  }
  return result;
}

let registered = false;
export function registerConstructRotationTurns({ ownTurn, partRotations } = {}) {
  if (ownTurn) isOwnTurn = ownTurn;
  if (partRotations) getPartRotations = partRotations;
  if (registered) return;
  registered = true;
  for (const hook of ["updateCombat", "createCombat", "deleteCombat", "updateCombatant", "createCombatant", "deleteCombatant"])
    globalThis.Hooks?.on?.(hook, () => { combatRevision++; });
  registerActorTurnStartPreparedHandler(({ actor, combat }) => prepareConstructRotationTurn(actor, combat));
}

export async function prepareConstructRotationTurn(actor, combat) {
    if (!globalThis.game?.user?.isGM || actor?.type !== "construct") return;
    const turnId = `${combat.id}:${combat.round}:${combat.turn}`;
    const tokens = {};
    for (const doc of actor.getActiveTokens?.(false, true) ?? []) {
      const slots = ["hull", ...getConstructVisualRuntimeConfig(actor).parts.filter(row => row.rotates).map(row => row.slotId)];
      tokens[tokenKey(doc)] = Object.fromEntries(slots.map(slot => {
        const angle = getConstructRotationAngle(doc, slot);
        return [slot, { origin: angle, last: angle, min: null, max: null, turnId,
          ...(slot === "hull" ? {} : { anchorRotation: getRotationMountAngle(doc, slot) }) }];
      }));
    }
    const ledger = { combatId: combat.id, turnId, tokens };
    const replacement = globalThis.foundry?.data?.operators?.ForcedReplacement?.create?.(ledger) ?? ledger;
    await actor.update({ [`flags.${SYSTEM}.${FLAG}`]: replacement }, { [INVENTORY_RENDER_PARTS_OPTION]: ["indicators"] });
    for (const doc of actor.getActiveTokens?.(false, true) ?? []) progress.delete(doc);
}
