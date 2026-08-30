import { SYSTEM_ID } from "../constants.mjs";
import { registerSystemEventObserver } from "../events/dispatcher.mjs";
import {
  ALL_COMBAT_ADVANTAGE_EFFECT_KEY,
  getReverseEffectKey
} from "../utils/active-effect-keys.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { normalizeFalseBreachSettings } from "../settings/abilities.mjs";

export const FALSE_BREACH_EFFECT_FLAG_KEY = "falseBreach";
export const FALSE_BREACH_MARK_FLAG_KEY = "falseBreachMark";
export const FALSE_BREACH_ATTACK_OBSERVER_ID = "fallout-maw.fixed.falseBreach.attackResolved";

const ATTACK_EVENT_KEY = "fallout-maw.weapon.attack.resolved";
const ACTIVE_EFFECT_SHOW_ICON_ALWAYS = 2;
const DEFAULT_ICON = "icons/svg/target.svg";
const DAMAGE_PERCENT_EFFECT_KEY = "system.combat.damagePercent";
const activationMutationQueues = new Map();
const markMutationQueues = new Map();
let runtimeRegistered = false;

/** Register the single aggregate-attack observer used by False Breach. */
export function registerFalseBreachRuntime() {
  if (runtimeRegistered) return false;
  runtimeRegistered = true;
  registerSystemEventObserver({
    id: FALSE_BREACH_ATTACK_OBSERVER_ID,
    eventKeys: [ATTACK_EVENT_KEY],
    priority: 146,
    observe: observeFalseBreachResolvedAttack
  });
  return true;
}

/** Activate the defensive effect. Energy and overload are handled by the caller. */
export async function activateFalseBreachEffect({
  actor = null,
  abilityItem = null,
  abilityFunction = null,
  settings = {}
} = {}) {
  if (!actor || !abilityItem || !abilityFunction) return null;
  return queueActorMutation(activationMutationQueues, actor, async () => {
    if (findActiveFalseBreachEffect(actor, abilityItem, abilityFunction)) return null;
    const normalized = normalizeFalseBreachSettings(settings);
    const now = getWorldTime();
    try {
      const [created] = await actor.createEmbeddedDocuments("ActiveEffect", [buildFalseBreachEffectData({
        actor,
        abilityItem,
        abilityFunction,
        settings: normalized,
        startTime: now
      })], { animate: false });
      return created ?? null;
    } catch (error) {
      console.error(`${SYSTEM_ID} | False Breach activation failed`, error);
      return null;
    }
  });
}

export function buildFalseBreachEffectData({
  actor = null,
  abilityItem = null,
  abilityFunction = null,
  settings = {},
  startTime = 0
} = {}) {
  const normalized = normalizeFalseBreachSettings(settings);
  const now = finiteNumber(startTime, 0);
  const abilityName = getAbilityName(abilityItem);
  return {
    type: "base",
    name: abilityName,
    img: abilityItem?.img || DEFAULT_ICON,
    description: `Уклонение +${normalized.dodgeBonus}; показываемый противнику шанс не учитывает уклонение.`,
    origin: String(abilityItem?.uuid ?? ""),
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    duration: {
      seconds: normalized.durationSeconds,
      startTime: now
    },
    system: { changes: buildFalseBreachEffectChanges(normalized) },
    flags: {
      [SYSTEM_ID]: {
        kind: "temporary",
        [FALSE_BREACH_EFFECT_FLAG_KEY]: {
          sourceActorUuid: String(actor?.uuid ?? ""),
          abilityItemId: String(abilityItem?.id ?? ""),
          abilityItemUuid: String(abilityItem?.uuid ?? ""),
          abilitySourceId: String(abilityItem?.getFlag?.("core", "sourceId") ?? abilityItem?.flags?.core?.sourceId ?? ""),
          functionId: String(abilityFunction?.id ?? ""),
          fixedKey: String(abilityFunction?.fixedKey ?? "falseBreach"),
          abilityName,
          abilityImg: String(abilityItem?.img ?? ""),
          createdAt: now,
          expiresAt: now + normalized.durationSeconds,
          settings: normalized
        }
      }
    }
  };
}

export function buildFalseBreachEffectChanges(settings = {}) {
  const normalized = normalizeFalseBreachSettings(settings);
  return normalized.dodgeBonus > 0 ? [createChange(
    "system.resources.dodge.bonus",
    normalized.dodgeBonus
  )] : [];
}

/**
 * Both mark modifiers are target-owned reverse keys. They therefore affect
 * every actor attacking the marked character without copying effects around.
 */
export function buildFalseBreachMarkChanges(settings = {}) {
  const normalized = normalizeFalseBreachSettings(settings);
  const changes = [];
  if (normalized.incomingDamagePercent > 0) {
    changes.push(createChange(
      getReverseEffectKey(DAMAGE_PERCENT_EFFECT_KEY),
      normalized.incomingDamagePercent
    ));
  }
  if (normalized.attackAdvantage > 0) {
    changes.push(createChange(
      getReverseEffectKey(ALL_COMBAT_ADVANTAGE_EFFECT_KEY),
      normalized.attackAdvantage
    ));
  }
  return changes;
}

export function getFalseBreachEffectData(effect = null) {
  const raw = effect?.getFlag?.(SYSTEM_ID, FALSE_BREACH_EFFECT_FLAG_KEY)
    ?? effect?.flags?.[SYSTEM_ID]?.[FALSE_BREACH_EFFECT_FLAG_KEY]
    ?? null;
  if (!raw?.sourceActorUuid || !raw?.functionId) return null;
  return {
    sourceActorUuid: String(raw.sourceActorUuid),
    abilityItemId: String(raw.abilityItemId ?? ""),
    abilityItemUuid: String(raw.abilityItemUuid ?? ""),
    abilitySourceId: String(raw.abilitySourceId ?? ""),
    functionId: String(raw.functionId),
    fixedKey: String(raw.fixedKey ?? "falseBreach"),
    abilityName: String(raw.abilityName ?? effect?.name ?? "Ложная брешь"),
    abilityImg: String(raw.abilityImg ?? effect?.img ?? ""),
    createdAt: finiteNumber(raw.createdAt, 0),
    expiresAt: finiteNumber(raw.expiresAt, 0),
    settings: normalizeFalseBreachSettings(raw.settings)
  };
}

export function getFalseBreachMarkData(effect = null) {
  const raw = effect?.getFlag?.(SYSTEM_ID, FALSE_BREACH_MARK_FLAG_KEY)
    ?? effect?.flags?.[SYSTEM_ID]?.[FALSE_BREACH_MARK_FLAG_KEY]
    ?? null;
  if (!raw?.sourceActorUuid || !raw?.markedActorUuid || !raw?.functionId) return null;
  return {
    sourceActorUuid: String(raw.sourceActorUuid),
    markedActorUuid: String(raw.markedActorUuid),
    abilityItemId: String(raw.abilityItemId ?? ""),
    abilityItemUuid: String(raw.abilityItemUuid ?? ""),
    functionId: String(raw.functionId),
    createdAt: finiteNumber(raw.createdAt, 0),
    expiresAt: finiteNumber(raw.expiresAt, 0),
    settings: normalizeFalseBreachSettings(raw.settings)
  };
}

export function findActiveFalseBreachEffects(actor = null) {
  return getActorEffects(actor).filter(effect => (
    isLiveTemporaryEffect(effect, getFalseBreachEffectData(effect))
  ));
}

export function findActiveFalseBreachEffect(actor = null, abilityItem = null, abilityFunction = null) {
  const abilityItemId = String(abilityItem?.id ?? "");
  const abilitySourceId = String(abilityItem?.getFlag?.("core", "sourceId") ?? abilityItem?.flags?.core?.sourceId ?? "");
  const functionId = String(abilityFunction?.id ?? "");
  return findActiveFalseBreachEffects(actor).find(effect => {
    const data = getFalseBreachEffectData(effect);
    if (functionId && data.functionId !== functionId) return false;
    if (abilityItemId && data.abilityItemId === abilityItemId) return true;
    return Boolean(abilitySourceId && data.abilitySourceId === abilitySourceId);
  }) ?? null;
}

/** Only preview paths call this; real attack difficulty keeps the prepared Dodge. */
export function getFalseBreachDisplayedDodgeDifficulty(targetActor = null, actualDifficulty = 0) {
  return findActiveFalseBreachEffects(targetActor).length > 0
    ? 0
    : Math.max(0, toInteger(actualDifficulty));
}

async function observeFalseBreachResolvedAttack({ event } = {}) {
  if (!isFalseBreachAuthority() || event?.data?.attackCycleAggregate !== true) return;
  if (Math.max(0, toInteger(event?.data?.attackCheckCount)) <= 0) return;
  const attackerUuid = String(event?.participants?.source?.actorUuid ?? event?.data?.actorUuid ?? "").trim();
  const attacker = resolveUuidSync(attackerUuid);
  if (!attacker) return;

  const successfulTargets = new Set(uniqueUuids(event?.data?.successfulAttackTargetActorUuids));
  const checkedTargets = uniqueUuids(event?.data?.attackCheckTargetActorUuids);
  for (const defenderUuid of checkedTargets) {
    if (defenderUuid === attackerUuid || successfulTargets.has(defenderUuid)) continue;
    const defender = resolveUuidSync(defenderUuid);
    const activeEffects = findActiveFalseBreachEffects(defender);
    for (const sourceEffect of activeEffects) {
      try {
        await queueActorMutation(markMutationQueues, attacker, () => applyOrRefreshFalseBreachMark(attacker, sourceEffect));
      } catch (error) {
        console.error(`${SYSTEM_ID} | False Breach mark failed`, error);
      }
    }
  }
}

async function applyOrRefreshFalseBreachMark(markedActor, sourceEffect) {
  const source = getFalseBreachEffectData(sourceEffect);
  if (!markedActor || !isLiveTemporaryEffect(sourceEffect, source)) return null;
  const settings = source.settings;
  const now = getWorldTime();
  const flag = {
    sourceActorUuid: source.sourceActorUuid,
    markedActorUuid: String(markedActor.uuid ?? ""),
    abilityItemId: source.abilityItemId,
    abilityItemUuid: source.abilityItemUuid,
    functionId: source.functionId,
    createdAt: now,
    expiresAt: now + settings.markDurationSeconds,
    settings
  };
  const existing = getActorEffects(markedActor).find(effect => {
    const data = getFalseBreachMarkData(effect);
    return data
      && isLiveTemporaryEffect(effect, data)
      && data.sourceActorUuid === source.sourceActorUuid
      && data.abilityItemId === source.abilityItemId
      && data.functionId === source.functionId;
  });
  const effectData = {
    name: `${source.abilityName}: Метка`,
    img: source.abilityImg || sourceEffect?.img || DEFAULT_ICON,
    description: `Входящий урон +${settings.incomingDamagePercent}%; преимущество атак против отмеченного +${settings.attackAdvantage}.`,
    origin: source.abilityItemUuid,
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    duration: { seconds: settings.markDurationSeconds, startTime: now },
    system: { changes: buildFalseBreachMarkChanges(settings) },
    flags: {
      [SYSTEM_ID]: {
        kind: "temporary",
        [FALSE_BREACH_MARK_FLAG_KEY]: flag
      }
    }
  };
  if (existing) {
    await existing.update(effectData, { falloutMawFalseBreachRuntime: true });
    return resolveCurrentEffect(existing);
  }
  const [created] = await markedActor.createEmbeddedDocuments("ActiveEffect", [{
    type: "base",
    ...effectData
  }], { animate: false, falloutMawFalseBreachRuntime: true });
  return created ?? null;
}

function queueActorMutation(queues, actor, operation) {
  const key = String(actor?.uuid ?? "");
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(operation)
    .finally(() => {
      if (queues.get(key) === current) queues.delete(key);
    });
  queues.set(key, current);
  return current;
}

function createChange(key, value) {
  return {
    key,
    type: "add",
    value: String(value),
    phase: "initial",
    priority: null
  };
}

function getActorEffects(actor) {
  return Array.from(actor?.effects?.contents ?? actor?.effects ?? []);
}

function isLiveTemporaryEffect(effect, data) {
  if (!effect || !data || effect.disabled || effect.active === false || effect.duration?.expired === true) return false;
  return !(data.expiresAt > 0 && getWorldTime() >= data.expiresAt);
}

function getAbilityName(abilityItem) {
  return String(abilityItem?.name ?? "").trim() || "Ложная брешь";
}

function getWorldTime() {
  return finiteNumber(globalThis.game?.time?.worldTime, 0);
}

function resolveCurrentEffect(effect) {
  return resolveUuidSync(effect?.uuid) ?? effect ?? null;
}

function resolveUuidSync(uuid = "") {
  const normalized = String(uuid ?? "").trim();
  if (!normalized) return null;
  return globalThis.fromUuidSync?.(normalized)
    ?? globalThis.foundry?.utils?.fromUuidSync?.(normalized)
    ?? null;
}

function isFalseBreachAuthority() {
  return Boolean(
    globalThis.game?.user?.isActiveGM
    || (globalThis.game?.user?.id && globalThis.game?.users?.activeGM?.id === globalThis.game.user.id)
  );
}

function uniqueUuids(values) {
  const source = Array.isArray(values) ? values : [];
  return Array.from(new Set(source.map(value => String(value ?? "").trim()).filter(Boolean)));
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
