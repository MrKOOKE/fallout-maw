import { SYSTEM_ID } from "../constants.mjs";
import {
  expandActorEffectChangeKeys,
  prepareActorEffectChangeForApplication
} from "../utils/active-effect-changes.mjs";
import { getActorApplicableEffects } from "../documents/actor-effect-preparation-index.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { getAdvancementPureValueEffectTarget } from "./pure-value-keys.mjs";

export const ADVANCEMENT_PURE_EFFECT_FLAG_KEY = "advancementPure";

export function buildAdvancementPureEffectFlag(changeIndexes = []) {
  const normalized = Array.from(new Set((changeIndexes ?? [])
    .map(index => Number(index))
    .filter(index => Number.isInteger(index) && index >= 0)))
    .sort((left, right) => left - right);
  return normalized.length ? { changeIndexes: normalized } : null;
}

export function collectAdvancementPureValueProjection(
  actor,
  characteristicSettings = [],
  skillSettings = []
) {
  const characteristicKeys = new Set(
    (characteristicSettings ?? [])
      .map(entry => String(entry?.key ?? entry ?? "").trim())
      .filter(Boolean)
  );
  const skillKeys = new Set(
    (skillSettings ?? [])
      .map(entry => String(entry?.key ?? entry ?? "").trim())
      .filter(Boolean)
  );
  const characteristicChanges = Object.fromEntries(
    Array.from(characteristicKeys, key => [key, []])
  );
  const skillBonusChanges = Object.fromEntries(
    Array.from(skillKeys, key => [key, []])
  );
  let order = 0;

  for (const effect of getApplicableActorEffects(actor)) {
    const changes = Array.from(effect?.system?.changes ?? effect?.changes ?? []);
    const indexes = getAdvancementPureEffectChangeIndexes(effect, changes.length);
    if (!indexes.length) continue;

    for (const index of indexes) {
      const sourceChange = changes[index];
      if (!sourceChange) continue;
      const effectChange = { ...sourceChange, effect };
      for (const expandedChange of expandActorEffectChangeKeys(actor, effectChange)) {
        const target = getAdvancementPureValueEffectTarget(expandedChange?.key);
        if (!target) continue;
        if (target.kind === "characteristic" && !characteristicKeys.has(target.key)) continue;
        if (target.kind === "skill" && !skillKeys.has(target.key)) continue;

        const prepared = prepareActorEffectChangeForApplication(actor, expandedChange, {
          stage: "initial-active-effect"
        });
        const value = Number(prepared?.value);
        if (!prepared || !Number.isFinite(value)) continue;
        const entry = {
          type: String(prepared.type ?? "add"),
          value,
          priority: getEffectChangePriority(prepared),
          order: order++
        };
        if (target.kind === "characteristic") characteristicChanges[target.key].push(entry);
        else skillBonusChanges[target.key].push(entry);
      }
    }
  }

  for (const changes of [
    ...Object.values(characteristicChanges),
    ...Object.values(skillBonusChanges)
  ]) {
    changes.sort(compareEffectChanges);
  }

  const sourceSkillBonuses = actor?._source?.system?.skills ?? {};
  const skillBonusDeltas = Object.fromEntries(
    Array.from(skillKeys, key => {
      const sourceBonus = toInteger(sourceSkillBonuses?.[key]?.bonus);
      const pureBonus = applyAdvancementPureValueChanges(sourceBonus, skillBonusChanges[key]);
      return [key, pureBonus - sourceBonus];
    })
  );

  return {
    characteristicChanges,
    skillBonusChanges,
    skillBonusDeltas
  };
}

export function applyAdvancementPureValueChanges(baseValue = 0, changes = []) {
  let value = Number(baseValue);
  if (!Number.isFinite(value)) value = 0;

  for (const change of changes ?? []) {
    const amount = Number(change?.value);
    if (!Number.isFinite(amount)) continue;
    switch (String(change?.type ?? "add")) {
      case "subtract":
        value -= amount;
        break;
      case "multiply":
        value *= amount;
        break;
      case "override":
        value = amount;
        break;
      case "upgrade":
        value = Math.max(value, amount);
        break;
      case "downgrade":
        value = Math.min(value, amount);
        break;
      default:
        value += amount;
        break;
    }
    // Both supported targets are integer NumberFields. Foundry cleans an
    // integer field after every ActiveEffect operation, not only at the end.
    value = Math.round(value);
  }

  return toInteger(value);
}

export function applyAdvancementPureCharacteristic(
  projection = {},
  characteristicKey = "",
  baseValue = 0
) {
  return applyAdvancementPureValueChanges(
    baseValue,
    projection?.characteristicChanges?.[characteristicKey] ?? []
  );
}

function getAdvancementPureEffectChangeIndexes(effect = null, changeCount = 0) {
  const systemFlags = effect?.flags?.[SYSTEM_ID] ?? {};
  const explicit = systemFlags?.[ADVANCEMENT_PURE_EFFECT_FLAG_KEY]?.changeIndexes;
  if (Array.isArray(explicit)) {
    return Array.from(new Set(explicit
      .map(index => Number(index))
      .filter(index => Number.isInteger(index) && index >= 0 && index < changeCount)))
      .sort((left, right) => left - right);
  }

  const functionData = Object.values(systemFlags)
    .find(data => data && typeof data === "object" && data.functionData)?.functionData;
  if (functionData?.includeInPureValues !== true) return [];
  return Array.from({ length: changeCount }, (_entry, index) => index);
}

function getApplicableActorEffects(actor = null) {
  return Array.from(getActorApplicableEffects(actor))
    .filter(effect => effect?.disabled !== true && effect?.active !== false);
}

function getEffectChangePriority(change = {}) {
  const configured = change?.priority;
  const value = Number(configured);
  if (configured !== null && configured !== undefined && configured !== "" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  const ActiveEffect = foundry.documents?.ActiveEffect?.implementation ?? globalThis.ActiveEffect;
  return toInteger(ActiveEffect?.CHANGE_TYPES?.[change?.type]?.defaultPriority);
}

function compareEffectChanges(left = {}, right = {}) {
  return (toInteger(left.priority) - toInteger(right.priority))
    || (toInteger(left.order) - toInteger(right.order));
}
