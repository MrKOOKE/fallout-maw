import { recordManagedBarrierProjectionDepletions } from "../abilities/barrier-depletion.mjs";

export const DAMAGE_BARRIER_EFFECT_KEY_ROOT = "system.damageBarriers";
export const DAMAGE_BARRIER_ALL_EFFECT_KEY = `${DAMAGE_BARRIER_EFFECT_KEY_ROOT}.all`;

export function getDamageBarrierEffectKey(damageTypeKey = "") {
  const key = normalizeDamageTypeKey(damageTypeKey);
  return key ? `${DAMAGE_BARRIER_EFFECT_KEY_ROOT}.${key}` : "";
}

export function parseDamageBarrierEffectKey(effectKey = "") {
  const key = String(effectKey ?? "").trim();
  const prefix = `${DAMAGE_BARRIER_EFFECT_KEY_ROOT}.`;
  if (!key.startsWith(prefix)) return null;

  const damageTypeKey = normalizeDamageTypeKey(key.slice(prefix.length));
  if (!damageTypeKey) return null;
  return {
    key,
    kind: damageTypeKey === "all" ? "all" : "damageType",
    damageTypeKey
  };
}

export function isDamageBarrierEffectKey(effectKey = "") {
  return Boolean(parseDamageBarrierEffectKey(effectKey));
}

/**
 * Creates a mutable in-memory view of every barrier on an Actor.
 *
 * A Damage Hub operation creates this ledger once, lets all components of the
 * damage packet spend it, and commits only the final Active Effect state.
 */
export function createDamageBarrierLedger(actor, {
  evaluateChange = (_actor, change) => Number(change?.value),
  effects = null
} = {}) {
  const effectStates = new Map();
  const rows = [];

  for (const effect of effects ?? getApplicableActorEffects(actor)) {
    if (!isUsableBarrierEffect(effect)) continue;
    const changes = Array.from(effect?.system?.changes ?? []);
    const effectId = String(effect?.id ?? effect?._id ?? "").trim();
    if (!effectId || !changes.length) continue;

    const effectState = {
      effect,
      effectId,
      owner: effect?.parent?.documentName === "Item" ? effect.parent : actor,
      changes,
      rows: [],
      touched: false,
      commit: null
    };
    for (let changeIndex = 0; changeIndex < changes.length; changeIndex += 1) {
      const change = changes[changeIndex];
      const parsed = parseDamageBarrierEffectKey(change?.key);
      if (!parsed) continue;
      const evaluated = Number(evaluateChange(actor, { ...change, effect }));
      const remaining = Number.isFinite(evaluated) ? Math.max(0, Math.floor(evaluated)) : 0;
      if (remaining <= 0) continue;

      const row = {
        effectState,
        changeIndex,
        change,
        kind: parsed.kind,
        damageTypeKey: parsed.damageTypeKey,
        initial: remaining,
        remaining,
        priority: normalizePriority(change?.priority),
        createdTime: normalizeSortNumber(effect?._stats?.createdTime),
        effectSort: normalizeSortNumber(effect?.sort),
        effectId
      };
      rows.push(row);
      effectState.rows.push(row);
    }
    if (effectState.rows.length) {
      const ownerKey = String(effectState.owner?.uuid ?? effectState.owner?.id ?? "actor");
      effectStates.set(`${ownerKey}:${effectId}`, effectState);
    }
  }

  return {
    actor,
    rows,
    effectStates,
    absorbedTotal: 0,
    applications: []
  };
}

export function absorbDamageWithBarrier(ledger, {
  amount = 0,
  damageTypeKey = "",
  bypassBarrier = false
} = {}) {
  const incoming = Math.max(0, Math.floor(Number(amount) || 0));
  const normalizedDamageTypeKey = normalizeDamageTypeKey(damageTypeKey);
  if (!ledger || incoming <= 0 || bypassBarrier) {
    return {
      incoming,
      absorbed: 0,
      remaining: incoming,
      damageTypeKey: normalizedDamageTypeKey,
      depleted: []
    };
  }

  const candidates = ledger.rows
    .filter(row => (
      row.remaining > 0
      && (row.kind === "all" || row.damageTypeKey === normalizedDamageTypeKey)
    ))
    .sort((left, right) => (
      barrierSpecificity(left) - barrierSpecificity(right)
      || left.priority - right.priority
      || left.createdTime - right.createdTime
      || left.effectSort - right.effectSort
      || left.effectId.localeCompare(right.effectId)
      || left.changeIndex - right.changeIndex
    ));

  let remaining = incoming;
  const depleted = [];
  const spent = [];
  for (const row of candidates) {
    if (remaining <= 0) break;
    const consumed = Math.min(remaining, row.remaining);
    if (consumed <= 0) continue;

    row.remaining -= consumed;
    row.effectState.touched = true;
    remaining -= consumed;
    spent.push({
      effectId: row.effectId,
      changeIndex: row.changeIndex,
      key: String(row.change?.key ?? ""),
      amount: consumed,
      remaining: row.remaining
    });
    if (row.remaining <= 0) depleted.push({
      effectId: row.effectId,
      changeIndex: row.changeIndex,
      key: String(row.change?.key ?? "")
    });
  }

  const absorbed = incoming - remaining;
  const application = {
    incoming,
    absorbed,
    remaining,
    damageTypeKey: normalizedDamageTypeKey,
    depleted,
    spent
  };
  if (absorbed > 0) {
    ledger.absorbedTotal += absorbed;
    ledger.applications.push(application);
  }
  return application;
}

export function buildDamageBarrierCommitPlan(ledger) {
  const updates = [];
  const deleteIds = [];
  if (!ledger) return { updates, deleteIds };

  for (const effectState of ledger.effectStates.values()) {
    if (!effectState.touched) continue;

    const rowByIndex = new Map(effectState.rows.map(row => [row.changeIndex, row]));
    const changes = [];
    for (let index = 0; index < effectState.changes.length; index += 1) {
      const original = effectState.changes[index];
      const row = rowByIndex.get(index);
      if (!row) {
        changes.push(original);
        continue;
      }
      if (row.remaining <= 0) continue;
      changes.push({
        ...original,
        value: String(row.remaining)
      });
    }

    if (!changes.length) {
      effectState.commit = { delete: true, update: null };
      deleteIds.push(effectState.effectId);
    } else {
      const update = {
        _id: effectState.effectId,
        "system.changes": changes
      };
      effectState.commit = { delete: false, update };
      updates.push(update);
    }
  }

  return { updates, deleteIds };
}

/**
 * Commits an entire packet in no more than one batch update and one batch
 * deletion. Actors without a matching barrier perform no document writes.
 */
export async function commitDamageBarrierLedger(actor, ledger, options = {}) {
  const plan = buildDamageBarrierCommitPlan(ledger);
  const groups = new Map();
  for (const state of ledger?.effectStates?.values?.() ?? []) {
    if (!state.commit) continue;
    const owner = state.owner ?? actor;
    const group = groups.get(owner) ?? { owner, updates: [], deleteIds: [], deletedEffects: [] };
    if (state.commit.delete) {
      group.deleteIds.push(state.effectId);
      group.deletedEffects.push(state.effect);
    } else if (state.commit.update) group.updates.push(state.commit.update);
    groups.set(owner, group);
  }

  const deletedEffects = Array.from(groups.values()).flatMap(group => group.deletedEffects);
  if (deletedEffects.length) {
    // A persistent marker is only needed for a completely depleted managed
    // projection. Ordinary and partially depleted barriers never update Actor.
    await recordManagedBarrierProjectionDepletions(actor, deletedEffects);
  }
  for (const group of groups.values()) {
    if (group.updates.length) {
      await group.owner.updateEmbeddedDocuments("ActiveEffect", group.updates, {
        ...options,
        falloutMawDamageBarrierCommit: true
      });
    }
    if (!group.deleteIds.length) continue;
    await group.owner.deleteEmbeddedDocuments("ActiveEffect", group.deleteIds, {
      ...options,
      falloutMawDamageBarrierCommit: true
    });
  }
  return plan;
}

function getApplicableActorEffects(actor) {
  const source = typeof actor?.allApplicableEffects === "function"
    ? actor.allApplicableEffects()
    : actor?.effects ?? [];
  return Array.from(source ?? []);
}

function isUsableBarrierEffect(effect) {
  if (!effect || effect.disabled || effect.active === false || effect.isSuppressed) return false;
  return true;
}

function barrierSpecificity(row) {
  return row.kind === "damageType" ? 0 : 1;
}

function normalizeDamageTypeKey(value = "") {
  const key = String(value ?? "").trim();
  if (!key || key.includes(".")) return "";
  return key;
}

function normalizePriority(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeSortNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.MAX_SAFE_INTEGER;
}
