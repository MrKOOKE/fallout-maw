import {
  getConstructCompartmentContents, getConstructInteriorConfig,
  getConstructPartContainmentPath
} from "../utils/construct-interior.mjs";
import {
  getConstructPartLimbKey, getConstructPartSlotIdFromLimbKey,
  getInstalledConstructPartForSlot
} from "../utils/construct-parts.mjs";
import { getConditionFunction, isItemBrokenByCondition } from "../utils/item-functions.mjs";
import { getConstructCrewSeats } from "../utils/construct-crew.mjs";
import { getRandomLimbWeight, selectRandomWeightedLimbKey } from "../utils/limb-randomization.mjs";
import { getConstructFiringPortWorldTransform } from "../canvas/construct-firing-ports.mjs";
import { isConstructFiringPortPointInSector } from "../utils/construct-firing-port-model.mjs";

const MAX_INTERIOR_LAYERS = 64;

export function getConstructDamagePacketId(request = {}) {
  return String(request.source?.damagePacketId ?? "").trim()
    || String(request.source?.conditionWearPacketId ?? "").trim();
}

/** The descriptor identifies a live target, never a caller-supplied armor path. */
export function resolveConstructInteriorAttackTarget(actor, request = {}) {
  if (actor?.type !== "construct") return null;
  const descriptor = request.source?.constructInteriorTarget;
  const requestedSlot = getConstructPartSlotIdFromLimbKey(request.limbKey);
  if (!descriptor && !requestedSlot) return null;
  let slotId = requestedSlot, passenger = null;
  if (descriptor) {
    if (descriptor.kind === "part") {
      slotId = canonicalSlot(descriptor.slotId);
      if (!getInstalledConstructPartForSlot(actor, slotId)) return { invalid: true, reason: "missingPart" };
    } else if (descriptor.kind === "passenger") {
      for (const row of getConstructInteriorConfig(actor).parts) {
        const found = getConstructCompartmentContents(actor, row.slotId).passengers.find(entry =>
          entry.id === String(descriptor.passengerId ?? "")
          && (!descriptor.actorUuid || !resolvePassengerActorSync(entry)
            || resolvePassengerActorSync(entry).uuid === descriptor.actorUuid));
        if (found) { slotId = row.slotId; passenger = found; break; }
      }
      if (!passenger) return { invalid: true, reason: "missingPassenger" };
    } else return { invalid: true, reason: "invalidTargetKind" };
  }
  const path = getConstructPartContainmentPath(actor, slotId);
  if (!path.length || path.length > MAX_INTERIOR_LAYERS) return { invalid: true, reason: "invalidPath" };
  const shellSlotId = path.find(id => getInstalledConstructPartForSlot(actor, id));
  if (!shellSlotId) return { invalid: true, reason: "missingShell" };
  if (descriptor && (canonicalSlot(descriptor.shellSlotId) !== shellSlotId || requestedSlot !== shellSlotId))
    return { invalid: true, reason: "changedShell" };
  return { path, shellSlotId, slotId, passenger, descriptor: descriptor ?? null };
}

export function shouldRouteConstructInteriorAttack(actor, request = {}) {
  if (actor?.type !== "construct" || ["healing", "heal"].includes(request.mode)
    || request.scope === "itemCondition" || request.applyMitigation === false) return false;
  if (isConstructExteriorWeaponDamage(actor, request)) return true;
  const target = resolveConstructInteriorAttackTarget(actor, request);
  if (!target) return false;
  if (target.invalid || target.descriptor || target.path.length > 1) return true;
  if (isItemBrokenByCondition(getInstalledConstructPartForSlot(actor, target.slotId))) return true;
  const contents = getConstructCompartmentContents(actor, target.slotId);
  return contents.parts.length > 0 || contents.passengers.length > 0;
}

export function isConstructExteriorWeaponDamage(actor, request = {}) {
  if (actor?.type !== "construct" || ["healing", "heal"].includes(request.mode)
    || request.scope === "itemCondition" || request.applyMitigation === false || !(request.amount > 0)
    || request.source?.constructInteriorTarget) return false;
  if (getConstructPartSlotIdFromLimbKey(request.limbKey) && request.scope !== "health") return false;
  const weapon = request.source?.weaponData;
  return request.source?.weaponAttackDamage === true
    || Boolean(weapon && typeof weapon === "object" && !Array.isArray(weapon) && Object.keys(weapon).length);
}

/** This is the existing through-hit threshold: use applied part damage and the
 * mitigation's remaining penetration, with the weapon's native step budget. */
export function doesConstructLayerPenetrate(result, maximum, source = {}, { destroyed = false } = {}) {
  if (!result || result.cancelled || result.failed || result.lethalDamagePrevented
    || result.finalHealthDamagePrevented > 0 || !(Number(result.amountAfterBarrier) > 0)) return false;
  if (destroyed) return true;
  if (Math.max(0, integer(source.penetrationStep)) >= Math.max(0, integer(source.penetrationPower))) return false;
  const partDamage = Math.max(0, Number(result.partDamage ?? result.limbDelta ?? result.itemConditionDelta) || 0);
  if (!(maximum > 0) || !(partDamage > 0)) return false;
  const requiredPercent = Math.max(0, 50 - Math.max(0, integer(result.penetrationRemainder)));
  return partDamage >= Math.ceil(maximum * requiredPercent / 100);
}

export function getConstructLayerContinuation(result, { maximum = 0, source = {}, baseAmount = 0,
  destroyed = false, protectionOnly = false } = {}) {
  const amount = Math.max(0, integer(result?.amountAfterBarrier));
  const stopped = !result || result.cancelled || result.failed || result.lethalDamagePrevented
    || result.finalHealthDamagePrevented > 0 || !amount;
  if (stopped || !protectionOnly && !destroyed && !doesConstructLayerPenetrate(result, maximum, source))
    return { allowed: false, amount: 0, source };
  const step = Math.max(0, integer(source.penetrationStep));
  const next = { ...source, penetrationPower: Math.max(0, integer(result.penetrationRemainder)) + step,
    penetrationStep: step + (protectionOnly || destroyed ? 0 : 1) };
  return { allowed: true, amount: protectionOnly || destroyed ? amount
    : Math.max(0, Math.round(amount - baseAmount * .1)), source: next };
}

/** Every layer is applied by the ordinary hub callback, including armor wear,
 * barriers, statuses and trauma. No armor formula is duplicated here. */
export async function applyConstructInteriorAttack({ actor, request, requests = null, applyLayer,
  resolveActor = uuid => globalThis.fromUuid?.(uuid), random = null,
  ancestry = [] } = {}) {
  if (typeof applyLayer !== "function") throw new TypeError("Interior damage requires the normal damage-hub layer callback.");
  const packet = (Array.isArray(requests) ? requests : [request]).filter(Boolean);
  request = packet[0] ?? request ?? {};
  const packetId = getConstructDamagePacketId(request);
  if (packet.length > 1 && (!packetId || packet.some(entry => getConstructDamagePacketId(entry) !== packetId)))
    return blockedResult(actor, request, "mixedDamagePackets");
  const target = resolveConstructInteriorAttackTarget(actor, request);
  if (!target || target.invalid || ancestry.includes(actor.uuid) || ancestry.length >= MAX_INTERIOR_LAYERS)
    return blockedResult(actor, request, target?.reason ?? "recursiveContainment");
  if (target.passenger) {
    const actual = await resolvePassengerActor(target.passenger, resolveActor);
    if (!actual || target.descriptor?.actorUuid && actual.uuid !== target.descriptor.actorUuid)
      return blockedResult(actor, request, "changedPassengerActor");
  }
  if (packet.some(entry => {
    const other = resolveConstructInteriorAttackTarget(actor, entry);
    return !other || other.invalid || other.slotId !== target.slotId
      || other.passenger?.id !== target.passenger?.id || !arraysEqual(other.path, target.path);
  })) return blockedResult(actor, request, "mixedInteriorTargets");
  const trace = [], results = [];
  const packetIndices = packet.map(entry => entry.source?.constructInteriorPacketIndex);
  const preserveIndices = packetIndices.every(index => Number.isInteger(index) && index >= 0)
    && new Set(packetIndices).size === packet.length;
  let components = packet.map((entry, index) => {
    const baseAmount = Number.isFinite(Number(entry.source?.constructInteriorBaseAmount))
      ? Math.max(0, integer(entry.source.constructInteriorBaseAmount)) : Math.max(0, integer(entry.amount));
    const source = { ...(entry.source ?? {}), constructInteriorPacketIndex:
      preserveIndices ? entry.source.constructInteriorPacketIndex : index, constructInteriorBaseAmount: baseAmount };
    delete source.constructInteriorTarget;
    return { request: entry, amount: Math.max(0, integer(entry.amount)),
      baseAmount, source };
  });
  const amountRemaining = () => components.reduce((sum, entry) => sum + entry.amount, 0);
  const packetSource = () => {
    // A fully stopped component no longer belongs to the packet hitting the
    // next layer; its exhausted penetration cannot stop surviving components.
    const active = components.filter(entry => entry.amount > 0);
    const entries = active.length ? active : components;
    return { ...entries[0]?.source,
      penetrationPower: Math.min(...entries.map(entry => number(entry.source.penetrationPower))),
      penetrationStep: Math.max(...entries.map(entry => number(entry.source.penetrationStep))) };
  };
  const makeLayerRequests = (victim, limbKey, metadata) => components.filter(entry => entry.amount > 0)
    .map(entry => ({ ...entry.request, actorUuid: victim.uuid, limbKey, scope: "healthAndLimb",
      amount: entry.amount, source: { ...entry.source, constructInteriorCarrierUuid: actor.uuid, ...metadata } }));
  const carryLayer = (result, { maximum, destroyed = false, protectionOnly = false }) => {
    if (!result || result.cancelled || result.failed || result.lethalDamagePrevented
      || result.finalHealthDamagePrevented > 0 || !(result.amountAfterBarrier > 0)
      || !protectionOnly && !destroyed && !doesConstructLayerPenetrate(result, maximum, packetSource())) {
      components = components.map(entry => ({ ...entry, amount: 0 }));
      return false;
    }
    const applications = result.damageApplications ?? [result];
    components = components.map(entry => {
      const applied = applications.find(row => Number(row.source?.constructInteriorPacketIndex) === entry.source.constructInteriorPacketIndex);
      if (!applied) return { ...entry, amount: 0 };
      const continuation = getConstructLayerContinuation({ ...applied, limbDelta: result.limbDelta,
        partDamage: result.partDamage, penetrationRemainder: applied.penetrationRemainder ?? result.penetrationRemainder },
      { maximum, source: entry.source, baseAmount: entry.baseAmount, destroyed,
        // The packet has already passed the common threshold. Each component
        // carries its own armor remainder without testing a split threshold.
        protectionOnly: true });
      const stepCost = protectionOnly || destroyed ? 0 : 1;
      return { ...entry, amount: continuation.allowed
        ? Math.max(0, Math.round(continuation.amount - (stepCost ? entry.baseAmount * .1 : 0))) : 0,
      source: { ...continuation.source, penetrationStep: number(entry.source.penetrationStep) + stepCost } };
    });
    return amountRemaining() > 0;
  };
  const applyPassenger = async (passenger, depth, limbKey = "") => {
    const victim = await resolvePassengerActor(passenger, resolveActor);
    if (!victim || ancestry.includes(victim.uuid) || victim.uuid === actor.uuid) return false;
    limbKey ||= selectRandomWeightedLimbKey(victim,
      { random: random ?? packetRandom(packetSource(), `passenger:${passenger.id}`) });
    if (!limbKey || !victim.system?.limbs?.[limbKey]) return false;
    const incomingAmount = amountRemaining();
    const result = unwrapLayerResult(await applyLayer(makeLayerRequests(victim, limbKey, {
      constructInteriorPassengerId: passenger.id, constructInteriorDepth: depth }),
    { actor: victim, protectionOnly: false, mitigationScale: 1,
      ancestry: [...ancestry, actor.uuid], passenger }));
    if (!result) return false;
    results.push(result);
    if (result.constructInteriorTrace?.length) trace.push(...result.constructInteriorTrace.map(row => ({ ...row,
      containedPassengerId: passenger.id })));
    else trace.push({ actorUuid: victim.uuid, passengerId: passenger.id, limbKey, incomingAmount,
      amountAfterBarrier: number(result.amountAfterBarrier), penetrationRemainder: number(result.penetrationRemainder),
      partDamage: number(result.partDamage ?? result.limbDelta) });
    if (result.constructInteriorContinuation) {
      const continuation = result.constructInteriorContinuation;
      const nextComponents = continuation.components ?? [];
      components = components.map(entry => {
        const next = nextComponents.find(row => Number(row.source?.constructInteriorPacketIndex) === entry.source.constructInteriorPacketIndex);
        return { ...entry, amount: next?.amount ?? 0, source: next?.source ?? entry.source };
      });
      return continuation.allowed && amountRemaining() > 0;
    }
    return carryLayer(result, { maximum: number(victim.system?.limbs?.[limbKey]?.max) });
  };
  let currentSlot = target.path[0], pathIndex = 0;
  let canContinue = false;
  const seenSlots = new Set();
  const window = target.passenger ? await getIncomingPassengerWindow(actor, target.passenger, request.source, resolveActor) : null;
  for (let depth = 0; currentSlot && amountRemaining() > 0 && depth < MAX_INTERIOR_LAYERS; depth++) {
    if (seenSlots.has(currentSlot)) break;
    seenSlots.add(currentSlot);
    const item = getInstalledConstructPartForSlot(actor, currentSlot);
    const windowLayer = Boolean(window && currentSlot === target.slotId);
    const destroyed = Boolean(item && isItemBrokenByCondition(item));
    let layerResult = null;
    // An absent shell or an entirely open firing port has no contact surface.
    if (item && !destroyed && (!windowLayer || window.coverPercent > 0)) {
      canContinue = false;
      const maximum = Math.max(0, Number(getConditionFunction(item).max)
        || Number(actor.system?.limbs?.[getConstructPartLimbKey(currentSlot)]?.max) || 0);
      const incomingAmount = amountRemaining();
      layerResult = unwrapLayerResult(await applyLayer(makeLayerRequests(actor, getConstructPartLimbKey(currentSlot), {
        constructInteriorSlotId: currentSlot, constructInteriorDepth: depth }), { actor, protectionOnly: windowLayer,
        mitigationScale: windowLayer ? window.coverPercent / 100 : 1,
        ancestry: [...ancestry, actor.uuid], shellSlotId: target.shellSlotId }));
      if (!layerResult) break;
      results.push(layerResult);
      trace.push({ actorUuid: actor.uuid, slotId: currentSlot,
        incomingAmount, amountAfterBarrier: number(layerResult.amountAfterBarrier),
        penetrationRemainder: number(layerResult.penetrationRemainder),
        partDamage: number(layerResult.limbDelta), protectionOnly: windowLayer,
        coverPercent: windowLayer ? window.coverPercent : 100 });
      if (layerResult.cancelled || layerResult.failed || layerResult.lethalDamagePrevented
        || layerResult.finalHealthDamagePrevented > 0 || !(layerResult.amountAfterBarrier > 0)) break;
      if (!carryLayer(layerResult, { maximum, destroyed, protectionOnly: windowLayer })) break;
      canContinue = !windowLayer;
    } else {
      canContinue = !windowLayer;
      trace.push({ actorUuid: actor.uuid, slotId: currentSlot,
        skipped: true, reason: destroyed ? "destroyedShell" : windowLayer ? "openFiringPort" : "removedShell",
        amountAfterBarrier: amountRemaining() });
    }
    if (!(amountRemaining() > 0)) break;
    if (target.descriptor || target.path.length > 1) {
      if (pathIndex < target.path.length - 1) {
        const livePath = getConstructPartContainmentPath(actor, target.slotId);
        if (!arraysEqual(livePath, target.path)) break;
        currentSlot = target.path[++pathIndex];
        continue;
      }
      if (!target.passenger) break;
      const passenger = getConstructCompartmentContents(actor, currentSlot).passengers.find(row =>
        row.id === target.passenger.id && row.actorUuid === target.passenger.actorUuid);
      if (!passenger) break;
      canContinue = await applyPassenger(passenger, depth + 1, String(target.descriptor?.limbKey ?? ""));
      break;
    }
    const choices = collectCompartmentTargets(actor, currentSlot);
    const choice = chooseWeightedTarget(actor, choices, random ?? packetRandom(packetSource(), currentSlot));
    if (!choice) break;
    if (choice.kind === "part") { currentSlot = choice.slotId; continue; }
    canContinue = await applyPassenger(choice.passenger, depth + 1);
    break;
  }
  const primary = combineInteriorActorResults(actor, request, results.filter(row => row.actor?.uuid === actor.uuid));
  primary.constructInteriorTrace = trace;
  primary.interiorResults = results.filter(row => row.actor?.uuid !== actor.uuid);
  primary.penetrationRemainder = number(trace.at(-1)?.penetrationRemainder);
  const finalSource = packetSource();
  primary.constructInteriorContinuation = { allowed: canContinue && amountRemaining() > 0,
    amount: amountRemaining(), penetrationPower: number(finalSource.penetrationPower),
    penetrationStep: number(finalSource.penetrationStep), components: components.map(entry => ({
      amount: entry.amount, damageTypeKey: entry.request.damageTypeKey,
      damageEventIndex: entry.request.damageEventIndex, source: entry.source })) };
  return primary;
}

async function getIncomingPassengerWindow(actor, passenger, source, resolveDocument) {
  if (![source?.attackerOrigin?.x, source?.attackerOrigin?.y].every(Number.isFinite)) return null;
  let document = null;
  try { document = source.targetTokenUuid ? await resolveDocument(source.targetTokenUuid) : null; }
  catch { return null; }
  if (!document || (document.actor ?? document.object?.actor)?.uuid !== actor.uuid) return null;
  const seat = getConstructCrewSeats(actor).find(row => row.slotId === passenger.slotId
    && row.slotIndex === Number(passenger.slotIndex));
  const port = seat ? getConstructFiringPortWorldTransform(document, seat) : null;
  return port && isConstructFiringPortPointInSector(port, source.attackerOrigin) ? port : null;
}

function collectCompartmentTargets(actor, slotId, visited = new Set()) {
  if (visited.has(slotId) || visited.size >= MAX_INTERIOR_LAYERS) return [];
  visited.add(slotId);
  const contents = getConstructCompartmentContents(actor, slotId);
  return [...contents.parts.flatMap(row => row.item ? [{ kind: "part", slotId: row.slotId }]
    : collectCompartmentTargets(actor, row.slotId, visited)),
  ...contents.passengers.map(passenger => ({ kind: "passenger", passenger }))];
}

function chooseWeightedTarget(actor, choices, random) {
  const entries = choices.map(choice => ({ choice, weight: choice.kind === "part"
    ? getRandomLimbWeight(actor.system?.limbs?.[getConstructPartLimbKey(choice.slotId)] ?? {}) : 1 }));
  let roll = random() * entries.reduce((sum, row) => sum + row.weight, 0);
  for (const row of entries) { roll -= row.weight; if (roll <= 0) return row.choice; }
  return entries.at(-1)?.choice ?? null;
}

export function combineInteriorActorResults(actor, request, results) {
  const primary = { ...blockedResult(actor, request, ""), cancelled: false,
    incomingAmount: 0, damageApplications: [], createdTraumas: [], barrierDepleted: [],
    limbDeltas: [], healthDeltasByType: [], applicationDeltas: [], sourceDamageEntries: [],
    destroyedLimbDamage: [], killedByDamage: false, overkillDamage: 0 };
  for (const row of results) {
    for (const key of ["amount", "incomingAmount", "amountBeforeResistance", "mitigationBlocked", "preBarrierAmount",
      "barrierAbsorbed", "amountAfterBarrier", "healthDelta", "resourceHealthDelta", "limbDelta"]) primary[key] = number(primary[key]) + number(row[key]);
    primary.createdTraumas.push(...(row.createdTraumas ?? []));
    primary.barrierDepleted.push(...(row.barrierDepleted ?? []));
    primary.limbDeltas.push(...(row.limbDeltas ?? []));
    primary.healthDeltasByType.push(...(row.healthDeltasByType ?? []));
    primary.applicationDeltas.push(...(row.applicationDeltas ?? []));
    primary.sourceDamageEntries.push(...(row.sourceDamageEntries ?? []));
    primary.destroyedLimbDamage.push(...(row.destroyedLimbDamage ?? []));
    primary.killedByDamage ||= row.killedByDamage === true;
    primary.overkillDamage = Math.max(primary.overkillDamage, number(row.overkillDamage));
    if (row.finishingBlow) primary.finishingBlow = row.finishingBlow;
    primary.damageApplications.push(...(row.damageApplications ?? [{ damageEventIndex: request.damageEventIndex ?? -1,
      limbKey: row.limbKey, damageTypeKey: row.damageTypeKey, source: row.source,
      incomingAmount: row.incomingAmount, amountBeforeResistance: row.amountBeforeResistance,
      mitigationBlocked: row.mitigationBlocked, preBarrierAmount: row.preBarrierAmount,
      barrierAbsorbed: row.barrierAbsorbed, amountAfterBarrier: row.amountAfterBarrier,
      actualHealthDelta: row.healthDelta, actualLimbDelta: row.limbDelta,
      penetrationRemainder: row.penetrationRemainder,
      barrierDepleted: row.barrierDepleted ?? [] }]));
  }
  return primary;
}

function blockedResult(actor, request = {}, reason) {
  return { actor, amount: 0, incomingAmount: Math.max(0, integer(request.amount)),
    healthDelta: 0, limbDelta: 0, amountAfterBarrier: 0, penetrationRemainder: 0,
    mode: "damage", scope: request.scope, limbKey: request.limbKey,
    damageTypeKey: request.damageTypeKey, source: request.source ?? {},
    cancelled: Boolean(reason), reason };
}
function resolvePassengerActorSync(passenger) {
  const doc = globalThis.fromUuidSync?.(String(passenger.actorUuid ?? ""));
  return doc?.actor ?? doc ?? globalThis.game?.actors?.get?.(passenger.parkedActorId) ?? null;
}
async function resolvePassengerActor(passenger, resolveActor) {
  let doc = null;
  try { doc = await resolveActor(passenger.actorUuid); } catch { /* A parked actor can outlive its original token. */ }
  return doc?.actor ?? doc ?? globalThis.game?.actors?.get?.(passenger.parkedActorId) ?? null;
}
function packetRandom(source, salt) {
  const packet = String(source.damagePacketId || source.conditionWearPacketId || source.attackId || source.operationId || "");
  if (!packet) return Math.random;
  let hash = 2166136261;
  for (const char of `${packet}:${salt}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return () => (hash >>> 0) / 4294967296;
}
function canonicalSlot(value) { return String(value ?? "").trim().replace(/^constructPart[:.]/, ""); }
function unwrapLayerResult(value) { return Array.isArray(value) ? value.flat(Infinity).find(Boolean) : value; }
function integer(value) { return Math.trunc(Number(value) || 0); }
function number(value) { return Math.max(0, Number(value) || 0); }
function arraysEqual(a, b) { return a.length === b.length && a.every((value, index) => value === b[index]); }
