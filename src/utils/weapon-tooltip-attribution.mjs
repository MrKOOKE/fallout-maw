import {
  getActorAtRandomActionPointCostReduction,
  getActorAtRandomActionPointCostSources
} from "../abilities/runtime-state.mjs";
import {
  POSTURE_EFFECT_CHANGE_ROOT,
  getActorPostureAction,
  getActorPostureWeaponActionPointCostBonus,
  isPostureEffectApplicableToActor
} from "../canvas/posture-movement.mjs";
import { applyDamageCostModifier, getDamageCostModifierState } from "../combat/damage-hub.mjs";
import {
  evaluateActorEffectChangeNumber,
  prepareActorEffectChangeForApplication
} from "./active-effect-changes.mjs";
import { getModuleFunction } from "./item-functions.mjs";
import { toInteger } from "./numbers.mjs";
import {
  getWeaponModuleDisplayName,
  getWeaponModuleSlots,
  getWeaponModuleSlotItemData
} from "./weapon-modules.mjs";

const FALLBACK_ICON = "icons/svg/d20-grey.svg";
const ACTION_COST_EFFECT_KEYS = Object.freeze({
  aimedShot: "system.costs.actions.aimedShot",
  snapshot: "system.costs.actions.snapshot",
  burst: "system.costs.actions.burst",
  volley: "system.costs.actions.volley",
  meleeAttack: "system.costs.actions.meleeAttack",
  aimedMeleeAttack: "system.costs.actions.aimedMeleeAttack",
  push: "system.costs.actions.push",
  reload: "system.costs.actions.reload"
});

/**
 * Calculate the effective action-point cost of a weapon action together with
 * the same source attribution shown by the token action HUD.
 *
 * `effectiveWeaponData` is the weapon function after installed-module
 * modifiers have been applied. `baseWeaponData` is the unmodified weapon
 * function. Keeping both values explicit lets callers evaluate a foreign item
 * for another actor without losing the item's own module provenance.
 *
 * Each source contains the legacy `name`, `img`, and numeric `delta` fields.
 * It additionally exposes `operation`, `before`, `after`, and `steps` so other
 * item tooltips can render a detailed breakdown without reverse-engineering
 * the final number.
 */
export function getWeaponActionPointCostAttribution(
  actor,
  effectiveWeaponData = {},
  actionKey = "",
  baseWeaponData = effectiveWeaponData,
  { moduleSlots = [] } = {}
) {
  const baseCost = getWeaponActionPointBaseCost(baseWeaponData, actionKey);
  const configuredCost = getWeaponActionPointBaseCost(effectiveWeaponData, actionKey);
  const atRandomReduction = getActorAtRandomActionPointCostReduction(actor, actionKey);
  const cost = Math.max(0, Math.ceil(
    applyDamageCostModifier(configuredCost, getDamageCostModifierState(actor, { actionKey }).action)
    + getActorPostureWeaponActionPointCostBonus(actor)
    - atRandomReduction
  ));
  const tone = cost < baseCost ? "cheaper" : (cost > baseCost ? "dearer" : "");
  const sources = collectWeaponActionPointCostSources(actor, {
    actionKey,
    baseCost,
    configuredCost,
    moduleSlots
  });
  return { baseCost, configuredCost, cost, tone, sources };
}

export function getWeaponActionPointBaseCost(weaponData = {}, actionKey = "") {
  const value = Number(weaponData?.[actionKey]?.actionPointCost);
  const fallback = actionKey === "reload" ? 2 : 5;
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : fallback;
}

export function collectWeaponActionPointCostSources(
  actor,
  { actionKey = "", baseCost = 0, configuredCost = 0, moduleSlots = [] } = {}
) {
  let runningCost = Math.max(0, toInteger(baseCost));
  const sources = [];
  for (const source of collectModuleActionPointCostSources(moduleSlots, actionKey, runningCost)) {
    sources.push(source);
    runningCost = Math.max(0, runningCost + source.delta);
  }

  // The effective weapon data is authoritative. Resetting here preserves the
  // HUD's established behavior if a caller supplies precomputed weapon data.
  const effectiveConfiguredCost = Math.max(0, toInteger(configuredCost));
  if (runningCost !== effectiveConfiguredCost) {
    sources.push(createCalculationSource({
      key: "calculation:configured-cost",
      name: "FALLOUTMAW.Item.TooltipBreakdownConfiguredCost",
      operation: "override",
      before: runningCost,
      after: effectiveConfiguredCost,
      value: effectiveConfiguredCost,
      kind: "configured"
    }));
  }
  runningCost = effectiveConfiguredCost;

  const actionTrace = collectEffectActionPointCostTrace(actor, actionKey, runningCost);
  sources.push(...actionTrace.sources);
  runningCost = actionTrace.cost;

  const postureTrace = collectPostureActionPointCostTrace(actor, runningCost);
  for (const source of postureTrace.sources) {
    sources.push(source);
  }
  runningCost += postureTrace.bonus;

  for (const source of getActorAtRandomActionPointCostSources(actor, actionKey)) {
    const before = runningCost;
    const reduction = Math.max(0, toInteger(source.reduction));
    const after = before - reduction;
    const delta = after - before;
    if (!delta) continue;
    sources.push(createActionPointCostSource({
      key: source.key,
      name: source.name,
      img: source.img,
      delta,
      operation: "subtract",
      before,
      after,
      value: reduction,
      kind: "ability"
    }));
    runningCost = after;
  }

  const finalCost = Math.max(0, Math.ceil(runningCost));
  if (runningCost !== finalCost) {
    sources.push(createCalculationSource({
      key: "calculation:final-action-cost",
      name: "FALLOUTMAW.Item.TooltipBreakdownPreparedValue",
      operation: "override",
      before: runningCost,
      after: finalCost,
      value: finalCost,
      kind: "calculation"
    }));
  }

  return combineAdjacentActionPointCostSources(sources);
}

function collectModuleActionPointCostSources(moduleSlots = [], actionKey = "", initialCost = 0) {
  const sources = [];
  let runningCost = Math.max(0, toInteger(initialCost));
  for (const slot of getWeaponModuleSlots({ moduleSlots })) {
    const itemData = getWeaponModuleSlotItemData(slot);
    const module = getModuleFunction(itemData);
    const value = toInteger(module?.weapon?.actionPointCosts?.[actionKey]);
    if (!value) continue;
    const before = runningCost;
    const after = Math.max(0, before + value);
    const delta = after - before;
    runningCost = after;
    if (!delta) continue;
    sources.push(createActionPointCostSource({
      key: `module:${slot.id}:${String(itemData?.uuid ?? itemData?._id ?? itemData?.name ?? "")}`,
      name: getWeaponModuleDisplayName(itemData),
      img: itemData?.img,
      delta,
      operation: "add",
      before,
      after,
      value,
      kind: "module"
    }));
  }
  return sources;
}

function collectEffectActionPointCostTrace(actor, actionKey = "", initialCost = 0) {
  const configuredCost = Math.max(0, Number(initialCost) || 0);
  const generalChanges = collectActiveEffectCostChanges(actor, "system.costs.action");
  const specificKey = ACTION_COST_EFFECT_KEYS[String(actionKey ?? "").trim()] ?? "";
  const specificChanges = collectActiveEffectCostChanges(actor, specificKey);
  const trace = replayAggregatedCostChanges(
    configuredCost,
    createMergedCostChangeGroups(generalChanges, specificChanges),
    (entry, before, after) => createEffectActionPointCostSource(entry, {
      before,
      after,
      kind: "effect"
    })
  );
  const sources = [...trace.sources];
  const runningCost = trace.value;

  const runtimeCost = applyDamageCostModifier(
    configuredCost,
    getDamageCostModifierState(actor, { actionKey }).action
  );
  if (runningCost !== runtimeCost) {
    sources.push(createCalculationSource({
      key: "calculation:effect-action-cost",
      name: "FALLOUTMAW.Item.TooltipBreakdownPreparedValue",
      operation: "override",
      before: runningCost,
      after: runtimeCost,
      value: runtimeCost,
      kind: "calculation"
    }));
  }

  return { cost: runtimeCost, sources };
}

function collectPostureActionPointCostTrace(actor, initialCost = 0) {
  const postureAction = getActorPostureAction(actor);
  if (!postureAction) return { bonus: 0, sources: [] };
  const changeKey = `${POSTURE_EFFECT_CHANGE_ROOT}.${postureAction}.weaponActionCost`;
  const changes = collectActiveEffectCostChanges(actor, changeKey, { postureOnly: true });
  const actionCost = Number(initialCost) || 0;
  const trace = replayAggregatedCostChanges(
    0,
    createMergedCostChangeGroups(changes),
    (entry, scopeBefore, scopeAfter) => createEffectActionPointCostSource(entry, {
      before: actionCost + scopeBefore,
      after: actionCost + scopeAfter,
      kind: "posture",
      scope: "postureBonus",
      scopeBefore,
      scopeAfter
    })
  );
  const sources = [...trace.sources];
  const runningBonus = trace.value;

  const runtimeBonus = getActorPostureWeaponActionPointCostBonus(actor);
  if (runningBonus !== runtimeBonus) {
    sources.push(createCalculationSource({
      key: "calculation:posture-action-cost",
      name: "FALLOUTMAW.Item.TooltipBreakdownPreparedValue",
      operation: "add",
      before: actionCost + runningBonus,
      after: actionCost + runtimeBonus,
      value: runtimeBonus - runningBonus,
      kind: "calculation",
      scope: "postureBonus",
      scopeBefore: runningBonus,
      scopeAfter: runtimeBonus
    }));
  }

  return { bonus: runtimeBonus, sources };
}

function collectActiveEffectCostChanges(actor, key = "", { postureOnly = false } = {}) {
  if (!key) return [];
  const changes = [];
  for (const effect of getActorApplicableEffects(actor)) {
    if (effect.disabled) continue;
    if (postureOnly && !isPostureEffectApplicableToActor(effect, actor)) continue;
    for (const change of effect.system?.changes ?? effect.changes ?? []) {
      if (String(change?.key ?? "").trim() !== key) continue;
      const value = postureOnly
        ? evaluatePostureEffectChangeNumber(actor, { ...change, effect })
        : evaluateActorEffectChangeNumber(actor, { ...change, effect });
      if (!Number.isFinite(value)) continue;
      changes.push({
        effect,
        changeKey: key,
        operation: normalizeActionPointCostOperation(change.type),
        value
      });
    }
  }
  return changes;
}

function evaluatePostureEffectChangeNumber(actor, change = {}) {
  const prepared = prepareActorEffectChangeForApplication(actor, change);
  if (!prepared) return Number.NaN;
  const text = String(prepared.value ?? "").trim();
  if (!text) return 0;
  const direct = Number(text);
  if (Number.isFinite(direct)) return direct;

  try {
    const roll = new Roll(text, actor?.getRollData?.() ?? {});
    roll.evaluateSync?.({ strict: false });
    return Number(roll.total);
  } catch (_error) {
    return Number.NaN;
  }
}

function createMergedCostChangeGroups(generalChanges = [], specificChanges = []) {
  const general = partitionCostChanges(generalChanges);
  const specific = partitionCostChanges(specificChanges);
  return {
    override: specific.overrides.at(-1) ?? general.overrides.at(-1) ?? null,
    multiplierGroups: [general.multipliers, specific.multipliers],
    additionGroups: [general.additions, specific.additions]
  };
}

function partitionCostChanges(changes = []) {
  const result = { overrides: [], multipliers: [], additions: [] };
  for (const change of changes) {
    if (change.operation === "override") result.overrides.push(change);
    else if (change.operation === "multiply") result.multipliers.push(change);
    else result.additions.push({ ...change, operation: "add" });
  }
  return result;
}

function replayAggregatedCostChanges(initialCost = 0, groups = {}, createSource) {
  const sources = [];
  let runningCost = Number(initialCost) || 0;

  const override = groups.override ?? null;
  if (override) {
    const before = runningCost;
    runningCost = override.value;
    if (runningCost !== before) sources.push(createSource(override, before, runningCost));
  }

  const multiplicationBase = runningCost;
  let mergedMultiplier = 1;
  for (const entries of groups.multiplierGroups ?? []) {
    const previousGroupsMultiplier = mergedMultiplier;
    let groupMultiplier = 1;
    for (const entry of entries) {
      const before = runningCost;
      groupMultiplier *= entry.value;
      runningCost = multiplicationBase * (previousGroupsMultiplier * groupMultiplier);
      if (runningCost !== before) sources.push(createSource(entry, before, runningCost));
    }
    mergedMultiplier = previousGroupsMultiplier * groupMultiplier;
  }

  const additionBase = runningCost;
  let mergedAddition = 0;
  for (const entries of groups.additionGroups ?? []) {
    const previousGroupsAddition = mergedAddition;
    let groupAddition = 0;
    for (const entry of entries) {
      const before = runningCost;
      groupAddition += entry.value;
      runningCost = additionBase + (previousGroupsAddition + groupAddition);
      if (runningCost !== before) sources.push(createSource(entry, before, runningCost));
    }
    mergedAddition = previousGroupsAddition + groupAddition;
  }

  return { value: runningCost, sources };
}

function createEffectActionPointCostSource(entry = {}, options = {}) {
  const effect = entry.effect ?? {};
  return createActionPointCostSource({
    key: effect.uuid || effect.id || `${effect.name}:${entry.changeKey}`,
    name: localizeDocumentName(effect.name),
    img: effect.img,
    delta: Number(options.after) - Number(options.before),
    operation: entry.operation,
    before: options.before,
    after: options.after,
    value: entry.value,
    changeKey: entry.changeKey,
    kind: options.kind,
    scope: options.scope,
    scopeBefore: options.scopeBefore,
    scopeAfter: options.scopeAfter
  });
}

function getActorApplicableEffects(actor) {
  if (typeof actor?.allApplicableEffects === "function") return Array.from(actor.allApplicableEffects());
  return Array.from(actor?.effects ?? []);
}

function createCalculationSource(source = {}) {
  return createActionPointCostSource({
    img: FALLBACK_ICON,
    ...source,
    name: localizeDocumentName(source.name),
    delta: Number(source.after) - Number(source.before)
  });
}

function createActionPointCostSource(source = {}) {
  const step = {
    operation: String(source.operation ?? "add"),
    before: finiteNumber(source.before),
    after: finiteNumber(source.after),
    value: finiteNumber(source.value),
    ...(source.changeKey ? { changeKey: String(source.changeKey) } : {}),
    ...(source.scope ? {
      scope: String(source.scope),
      scopeBefore: finiteNumber(source.scopeBefore),
      scopeAfter: finiteNumber(source.scopeAfter)
    } : {})
  };
  return {
    key: String(source.key ?? ""),
    name: String(source.name ?? ""),
    img: normalizeImagePath(source.img),
    delta: finiteNumber(source.delta, step.after - step.before),
    operation: step.operation,
    before: step.before,
    after: step.after,
    value: step.value,
    kind: String(source.kind ?? ""),
    ...(step.changeKey ? { changeKey: step.changeKey } : {}),
    ...(step.scope ? {
      scope: step.scope,
      scopeBefore: step.scopeBefore,
      scopeAfter: step.scopeAfter
    } : {}),
    steps: [step]
  };
}

function combineAdjacentActionPointCostSources(sources = []) {
  const combined = [];
  for (const source of sources) {
    const key = String(source?.key ?? "");
    if (!key) continue;
    const existing = combined.at(-1)?.key === key ? combined.at(-1) : null;
    if (existing) {
      existing.delta += finiteNumber(source.delta);
      existing.after = source.after;
      if (source.scope) existing.scopeAfter = source.scopeAfter;
      existing.steps.push(...(source.steps ?? []));
      if (existing.operation !== source.operation) existing.operation = "mixed";
    } else {
      combined.push({
        ...source,
        delta: finiteNumber(source.delta),
        steps: Array.from(source.steps ?? [])
      });
    }
  }
  return combined.filter(source => Math.abs(finiteNumber(source.delta)) > Number.EPSILON);
}

function normalizeActionPointCostOperation(type = "") {
  const operation = String(type ?? "").trim();
  if (operation === "override" || operation === "multiply") return operation;
  return operation === "subtract" ? "subtract" : "add";
}

function normalizeImagePath(path, fallback = FALLBACK_ICON) {
  const normalized = String(path ?? "").trim();
  return normalized || fallback;
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function localizeDocumentName(value) {
  const text = String(value ?? "");
  return globalThis.game?.i18n?.has?.(text) ? game.i18n.localize(text) : text;
}
