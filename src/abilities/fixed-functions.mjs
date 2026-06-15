import { SYSTEM_ID } from "../constants.mjs";
import { getCurrencySettings, getSkillSettings } from "../settings/accessors.mjs";
import {
  ABILITY_FIXED_FUNCTION_KEYS,
  ABILITY_FUNCTION_TYPES,
  createAbilityFunction,
  getAbilitySourceId,
  normalizeAbilityFunctions,
  normalizeAllOrNothingSettings,
  normalizeCurseAndBlessingSettings,
  normalizeDeusExMachinaSettings
} from "../settings/abilities.mjs";
import {
  DAMAGE_APPLIED_HOOK,
  applyDestroyedLimbConsequences,
  isCriticalLimb,
  isLimbDestroyed,
  restoreDestroyedLimb,
  setLimbMissingState
} from "../combat/damage-hub.mjs";
import {
  WEAPON_ATTACK_DAMAGE_RESOLVED_HOOK,
  WEAPON_ATTACK_RESOLVED_HOOK
} from "../combat/weapon-attack-controller.mjs";
import { toInteger } from "../utils/numbers.mjs";
import {
  ALL_SKILLS_ADVANTAGE_EFFECT_KEY,
  ALL_SKILLS_BONUS_EFFECT_KEY,
  ALL_SKILLS_DISADVANTAGE_EFFECT_KEY,
  ABILITY_OVERLOAD_ENERGY_COST_EFFECT_KEY,
  SMART_FUDGE_RESULT_EFFECT_KEYS,
  evaluateActorEffectChangeNumber
} from "../utils/active-effect-changes.mjs";
import { evaluateActorFormula } from "../utils/actor-formulas.mjs";

const { DialogV2 } = foundry.applications.api;
const FormDataExtended = foundry.applications.ux.FormDataExtended;
export const ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY = "abilityFixedFunctionState";
const DEUS_EX_MACHINA_INSIGHT_EFFECT_FLAG_KEY = "deusExMachinaInsight";
const CURSE_AND_BLESSING_EFFECT_FLAG_KEY = "curseAndBlessing";
const ABILITY_OVERLOAD_EFFECT_FLAG_KEY = "abilityOverload";
const ALL_OR_NOTHING_EFFECT_FLAG_KEY = "allOrNothing";
const FIXED_ABILITY_SOCKET = `system.${SYSTEM_ID}`;
const FIXED_ABILITY_SOCKET_SCOPE = "fallout-maw.fixedAbilityFunctions";
const ENERGY_RESOURCE_KEY = "power";
const ACTIVE_EFFECT_SHOW_ICON_ALWAYS = 2;
const STATUS_EFFECTS = Object.freeze({
  dead: "dead"
});

const FIXED_ABILITY_FUNCTIONS = Object.freeze([
  Object.freeze({
    key: ABILITY_FIXED_FUNCTION_KEYS.deusExMachina,
    label: "Бог из машины",
    active: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.deusExMachina
    })
  }),
  Object.freeze({
    key: ABILITY_FIXED_FUNCTION_KEYS.curseAndBlessing,
    label: "Порча и благословение",
    active: true,
    toggleable: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.curseAndBlessing
    })
  }),
  Object.freeze({
    key: ABILITY_FIXED_FUNCTION_KEYS.allOrNothing,
    label: "Все или ничего",
    active: true,
    create: () => createAbilityFunction(ABILITY_FUNCTION_TYPES.fixed, {
      fixedKey: ABILITY_FIXED_FUNCTION_KEYS.allOrNothing
    })
  })
]);

export function registerFixedAbilityFunctionHooks() {
  Hooks.on(DAMAGE_APPLIED_HOOK, context => {
    void advanceDeusExMachinaProgressFromDamage(context?.results ?? []);
  });
  Hooks.on(WEAPON_ATTACK_DAMAGE_RESOLVED_HOOK, context => {
    void requestCurseAndBlessingAttackResolution(context);
  });
  Hooks.on(WEAPON_ATTACK_RESOLVED_HOOK, context => {
    void consumeAllOrNothingResultEffects(context);
  });
}

export function registerFixedAbilityFunctionSocket() {
  game.socket.on(FIXED_ABILITY_SOCKET, handleFixedAbilitySocketMessage);
}

export function getFixedAbilityFunctionDefinitions() {
  return [...FIXED_ABILITY_FUNCTIONS].sort((left, right) => left.label.localeCompare(right.label, game.i18n.lang));
}

export function getFixedAbilityFunctionDefinition(fixedKey = "") {
  const key = String(fixedKey ?? "").trim();
  return FIXED_ABILITY_FUNCTIONS.find(entry => entry.key === key) ?? null;
}

export function getFixedAbilityFunctionChoices() {
  return [
    { value: "", label: "Выберите фиксированную функцию", disabled: true, selected: true },
    ...getFixedAbilityFunctionDefinitions().map(entry => ({
      value: entry.key,
      label: entry.label
    }))
  ];
}

export function createFixedAbilityFunction(fixedKey = "") {
  const definition = getFixedAbilityFunctionDefinition(fixedKey);
  return definition?.create?.() ?? null;
}

export function getFixedAbilityFunctionLabel(fixedKey = "") {
  return getFixedAbilityFunctionDefinition(fixedKey)?.label ?? String(fixedKey ?? "");
}

export function isFixedAbilityFunctionActive(abilityFunction = {}) {
  if (abilityFunction?.type !== ABILITY_FUNCTION_TYPES.fixed) return false;
  return Boolean(getFixedAbilityFunctionDefinition(abilityFunction.fixedKey)?.active);
}

export function isFixedAbilityFunctionToggleable(abilityFunction = {}) {
  if (abilityFunction?.type !== ABILITY_FUNCTION_TYPES.fixed) return false;
  return Boolean(getFixedAbilityFunctionDefinition(abilityFunction.fixedKey)?.toggleable);
}

export function getFixedAbilityToggleState(item) {
  if (item?.type !== "ability") return { toggleable: false, active: false };
  const state = getFixedAbilityState(item);
  const functions = normalizeAbilityFunctions(item.system?.functions ?? []).filter(isFixedAbilityFunctionToggleable);
  return {
    toggleable: functions.length > 0,
    active: functions.some(entry => Boolean(state[getFixedFunctionStateKey(entry)]?.active))
  };
}

export function hasActiveFixedAbilityFunction(item) {
  if (item?.type !== "ability") return false;
  return normalizeAbilityFunctions(item.system?.functions ?? []).some(isFixedAbilityFunctionActive);
}

export function getFixedAbilityFunctionProgressEntries(abilityItem) {
  if (abilityItem?.type !== "ability") return [];
  const state = getFixedAbilityState(abilityItem);
  return normalizeAbilityFunctions(abilityItem.system?.functions ?? [])
    .filter(entry => entry.type === ABILITY_FUNCTION_TYPES.fixed)
    .map(entry => {
      if (entry.fixedKey !== ABILITY_FIXED_FUNCTION_KEYS.deusExMachina) return null;
      const settings = normalizeDeusExMachinaSettings(entry.fixedSettings);
      const stateKey = getFixedFunctionStateKey(entry);
      return {
        key: stateKey,
        label: getFixedAbilityFunctionLabel(entry.fixedKey),
        current: Math.max(0, Math.min(settings.damageRequired, toInteger(state[stateKey]?.damage))),
        required: settings.damageRequired
      };
    })
    .filter(Boolean);
}

export async function useFixedAbilityFunctionItem({ actor = null, item = null, application = null } = {}) {
  if (!actor?.isOwner || item?.type !== "ability") return false;
  const abilityFunction = normalizeAbilityFunctions(item.system?.functions ?? [])
    .find(entry => isFixedAbilityFunctionActive(entry));
  if (!abilityFunction) return false;

  if (abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.allOrNothing) {
    const used = await useAllOrNothing(actor, item, abilityFunction);
    if (used) await application?.render?.({ force: true });
    return true;
  }

  if (abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.deusExMachina) {
    const used = await useDeusExMachina(actor, item, abilityFunction);
    if (used) await application?.render?.({ force: true });
    return true;
  }

  if (abilityFunction.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.curseAndBlessing) {
    await toggleCurseAndBlessing(actor, item, abilityFunction);
    await application?.render?.({ force: true });
    return true;
  }

  ui.notifications.warn("Фиксированная функция пока не имеет обработчика применения.");
  return true;
}

async function useAllOrNothing(actor, abilityItem, abilityFunction) {
  const settings = normalizeAllOrNothingSettings(abilityFunction.fixedSettings);
  const energyCost = getAbilityEnergyCost(actor, abilityItem, abilityFunction, settings.energyCost);
  if (hasPendingAllOrNothingResultEffect(actor, abilityItem, abilityFunction)) {
    ui.notifications.warn("Все или ничего: результат первой активации еще не потрачен.");
    return false;
  }
  if (!hasEnergy(actor, energyCost)) {
    ui.notifications.warn(`Все или ничего: недостаточно энергии (${getActorEnergy(actor)} / ${energyCost}).`);
    return false;
  }
  if (!(await spendEnergy(actor, energyCost))) return false;
  await applyAllOrNothingOverloadEffect(actor, abilityItem, abilityFunction, settings);
  await applyAllOrNothingResultEffect(actor, abilityItem, abilityFunction, settings);
  await createAbilityChatMessage(actor, abilityItem, "Все или ничего: способность успешно применена.");
  return true;
}

async function toggleCurseAndBlessing(actor, abilityItem, abilityFunction) {
  const settings = normalizeCurseAndBlessingSettings(abilityFunction.fixedSettings);
  const energyCost = getAbilityEnergyCost(actor, abilityItem, abilityFunction, settings.energyCost);
  settings.energyCost = energyCost;
  const state = foundry.utils.deepClone(getFixedAbilityState(abilityItem));
  const stateKey = getFixedFunctionStateKey(abilityFunction);
  const nextActive = !Boolean(state[stateKey]?.active);
  if (nextActive && !hasCurseAndBlessingEnergy(actor, energyCost)) {
    ui.notifications.warn(`Порча и благословение: недостаточно энергии (${getActorEnergy(actor)} / ${settings.energyCost}).`);
    return false;
  }
  state[stateKey] = {
    ...state[stateKey],
    fixedKey: abilityFunction.fixedKey,
    active: nextActive
  };
  await abilityItem.setFlag(SYSTEM_ID, ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY, state);
  ui.notifications.info(`Порча и благословение: ${nextActive ? "включено" : "выключено"}.`);
  return true;
}

async function requestCurseAndBlessingAttackResolution(context = {}) {
  const attackerUuid = String(context?.attackerUuid ?? "").trim();
  const targetUuids = Array.from(new Set((context?.targetUuids ?? [])
    .map(uuid => String(uuid ?? "").trim())
    .filter(Boolean)));
  if (!attackerUuid || !targetUuids.length) return;
  const payload = {
    attackerUuid,
    targetUuids,
    senderUserId: context?.senderUserId ?? game.user?.id ?? ""
  };
  if (game.user?.isActiveGM) {
    await processCurseAndBlessingAttackResolution(payload);
    return;
  }
  const gm = getResponsibleGM();
  if (gm) {
    game.socket.emit(FIXED_ABILITY_SOCKET, {
      scope: FIXED_ABILITY_SOCKET_SCOPE,
      action: "resolveCurseAndBlessingAttack",
      gmUserId: gm.id,
      senderUserId: game.user?.id ?? "",
      payload
    });
    return;
  }
  await processCurseAndBlessingAttackResolution(payload);
}

function handleFixedAbilitySocketMessage(message = {}) {
  if (message?.scope !== FIXED_ABILITY_SOCKET_SCOPE) return;
  if (message.action !== "resolveCurseAndBlessingAttack") return;
  if (!game.user?.isGM || message.gmUserId !== game.user.id) return;
  void processCurseAndBlessingAttackResolution({
    ...(message.payload ?? {}),
    senderUserId: message.senderUserId ?? message.payload?.senderUserId ?? ""
  });
}

async function processCurseAndBlessingAttackResolution({ attackerUuid = "", targetUuids = [], senderUserId = "" } = {}) {
  const attacker = await fromUuid(String(attackerUuid ?? ""));
  const targets = (await Promise.all(Array.from(new Set(targetUuids))
    .map(uuid => fromUuid(String(uuid ?? "")))))
    .filter(Boolean);
  if (!attacker || !targets.length) return;
  const sender = game.users?.get(String(senderUserId ?? ""));
  if (sender && !sender.isGM && !attacker.testUserPermission(sender, "OWNER")) return;
  await processCurseAndBlessingActorFunctions({
    owner: attacker,
    effectTargets: targets,
    effectKey: ALL_SKILLS_DISADVANTAGE_EFFECT_KEY,
    effectName: "Порча"
  });
  for (const target of targets) {
    await processCurseAndBlessingActorFunctions({
      owner: target,
      effectTargets: [target],
      effectKey: ALL_SKILLS_ADVANTAGE_EFFECT_KEY,
      effectName: "Благословение"
    });
  }
}

async function processCurseAndBlessingActorFunctions({ owner = null, effectTargets = [], effectKey = "", effectName = "" } = {}) {
  const targets = (Array.isArray(effectTargets) ? effectTargets : [effectTargets]).filter(Boolean);
  if (!owner || !targets.length || (!game.user?.isGM && !owner.isOwner)) return;
  for (const abilityItem of owner.items?.filter(item => item.type === "ability") ?? []) {
    const state = getFixedAbilityState(abilityItem);
    const functions = normalizeAbilityFunctions(abilityItem.system?.functions ?? [])
      .filter(entry => entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.curseAndBlessing)
      .filter(entry => Boolean(state[getFixedFunctionStateKey(entry)]?.active));
    for (const abilityFunction of functions) {
      const settings = normalizeCurseAndBlessingSettings(abilityFunction.fixedSettings);
      const spent = await spendCurseAndBlessingEnergy(owner, abilityItem, abilityFunction, getAbilityEnergyCost(owner, abilityItem, abilityFunction, settings.energyCost));
      if (!spent) continue;
      const chance = Math.min(100, evaluateActorFormula(settings.triggerFormula, owner, {
        fallback: 0,
        minimum: 0,
        context: "Порча и благословение"
      }));
      for (const target of targets) {
        if ((Math.floor(Math.random() * 100) + 1) > chance) continue;
        await applyCurseAndBlessingEffect(target, abilityItem, abilityFunction, {
          effectKey,
          effectName,
          durationSeconds: settings.durationSeconds
        });
      }
    }
  }
}

async function spendCurseAndBlessingEnergy(actor, abilityItem, abilityFunction, energyCost = 0) {
  const cost = Math.max(0, toInteger(energyCost));
  if (!hasCurseAndBlessingEnergy(actor, cost)) {
    await deactivateFixedAbilityFunction(abilityItem, abilityFunction);
    await createAbilityChatMessage(actor, abilityItem, `Порча и благословение выключено: недостаточно энергии (${getActorEnergy(actor)} / ${cost}).`);
    return false;
  }
  if (!cost) return true;
  const resource = actor.system?.resources?.[ENERGY_RESOURCE_KEY];
  const nextValue = Math.max(toInteger(resource?.min), getActorEnergy(actor) - cost);
  const update = {
    [`system.resources.${ENERGY_RESOURCE_KEY}.value`]: nextValue
  };
  if (resource && Object.hasOwn(resource, "spent")) {
    update[`system.resources.${ENERGY_RESOURCE_KEY}.spent`] = Math.max(0, toInteger(resource.max) - nextValue);
  }
  await actor.update(update);
  return true;
}

async function spendEnergy(actor, energyCost = 0) {
  const cost = Math.max(0, toInteger(energyCost));
  if (!hasEnergy(actor, cost)) return false;
  if (!cost) return true;
  const resource = actor.system?.resources?.[ENERGY_RESOURCE_KEY];
  const nextValue = Math.max(toInteger(resource?.min), getActorEnergy(actor) - cost);
  const update = {
    [`system.resources.${ENERGY_RESOURCE_KEY}.value`]: nextValue
  };
  if (resource && Object.hasOwn(resource, "spent")) {
    update[`system.resources.${ENERGY_RESOURCE_KEY}.spent`] = Math.max(0, toInteger(resource.max) - nextValue);
  }
  await actor.update(update);
  return true;
}

function getAbilityEnergyCost(actor, abilityItem, abilityFunction, baseCost = 0) {
  return Math.max(0, toInteger(baseCost)) + getAbilityOverloadEnergyCost(actor, abilityItem, abilityFunction);
}

export function getFixedAbilityEnergyCost(actor, abilityItem, abilityFunction, baseCost = 0) {
  return getAbilityEnergyCost(actor, abilityItem, abilityFunction, baseCost);
}

function getAbilityOverloadEnergyCost(actor, abilityItem, abilityFunction) {
  if (!actor || !abilityItem) return 0;
  const abilityItemId = String(abilityItem.id ?? "").trim();
  const abilitySourceId = getAbilitySourceId(abilityItem);
  let total = 0;
  for (const effect of actor.allApplicableEffects?.() ?? actor.effects ?? []) {
    if (effect?.disabled) continue;
    const overload = effect.getFlag?.(SYSTEM_ID, ABILITY_OVERLOAD_EFFECT_FLAG_KEY);
    if (!abilityOverloadApplies(overload, { abilityItemId, abilitySourceId })) continue;
    for (const change of effect.system?.changes ?? []) {
      if (String(change?.key ?? "") !== ABILITY_OVERLOAD_ENERGY_COST_EFFECT_KEY) continue;
      total += Math.max(0, evaluateActorEffectChangeNumber(actor, { ...change, effect }, { fallback: 0 }));
    }
  }
  return Math.max(0, Math.trunc(total));
}

function abilityOverloadApplies(overload = {}, { abilityItemId = "", abilitySourceId = "" } = {}) {
  if (!overload || typeof overload !== "object") return false;
  const overloadSourceId = String(overload.abilitySourceId ?? "").trim();
  if (overloadSourceId && abilitySourceId) return overloadSourceId === abilitySourceId;
  return String(overload.abilityItemId ?? "").trim() === abilityItemId;
}

async function deactivateFixedAbilityFunction(abilityItem, abilityFunction) {
  const state = foundry.utils.deepClone(getFixedAbilityState(abilityItem));
  const stateKey = getFixedFunctionStateKey(abilityFunction);
  state[stateKey] = {
    ...state[stateKey],
    fixedKey: abilityFunction.fixedKey,
    active: false
  };
  await abilityItem.setFlag(SYSTEM_ID, ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY, state);
}

async function applyCurseAndBlessingEffect(actor, abilityItem, abilityFunction, { effectKey = "", effectName = "", durationSeconds = 0 } = {}) {
  if (!actor || (!game.user?.isGM && !actor.isOwner)) return false;
  const startTime = Number(game.time?.worldTime) || 0;
  await actor.createEmbeddedDocuments("ActiveEffect", [{
    type: "base",
    name: effectName,
    img: abilityItem.img || "icons/svg/aura.svg",
    origin: abilityItem.uuid,
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    duration: {
      seconds: Math.max(0, toInteger(durationSeconds)),
      startTime
    },
    system: {
      changes: [{
        key: effectKey,
        type: "add",
        value: "1",
        phase: "initial",
        priority: null
      }]
    },
    flags: {
      [SYSTEM_ID]: {
        kind: "temporary",
        [CURSE_AND_BLESSING_EFFECT_FLAG_KEY]: {
          abilityItemId: abilityItem.id,
          functionId: abilityFunction.id,
          createdAt: startTime
        }
      }
    }
  }], { animate: false });
  await createAbilityChatMessage(actor, abilityItem, `${effectName}: ${formatDuration(durationSeconds)}.`);
  return true;
}

async function applyAllOrNothingOverloadEffect(actor, abilityItem, abilityFunction, settings) {
  if (!actor || (!game.user?.isGM && !actor.isOwner)) return false;
  const startTime = Number(game.time?.worldTime) || 0;
  await actor.createEmbeddedDocuments("ActiveEffect", [{
    type: "base",
    name: "Перегрузка: Все или ничего",
    img: abilityItem.img || "icons/svg/aura.svg",
    origin: abilityItem.uuid,
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    duration: {
      seconds: Math.max(0, toInteger(settings.overloadDurationSeconds)),
      startTime
    },
    system: {
      changes: [{
        key: ABILITY_OVERLOAD_ENERGY_COST_EFFECT_KEY,
        type: "add",
        value: String(Math.max(0, toInteger(settings.overloadEnergyCost))),
        phase: "initial",
        priority: null
      }]
    },
    flags: {
      [SYSTEM_ID]: {
        kind: "temporary",
        [ABILITY_OVERLOAD_EFFECT_FLAG_KEY]: {
          abilityItemId: abilityItem.id,
          abilitySourceId: getAbilitySourceId(abilityItem),
          functionId: abilityFunction.id,
          fixedKey: abilityFunction.fixedKey,
          createdAt: startTime
        }
      }
    }
  }], { animate: false });
  return true;
}

async function applyAllOrNothingResultEffect(actor, abilityItem, abilityFunction, settings) {
  if (!actor || (!game.user?.isGM && !actor.isOwner)) return false;
  const startTime = Number(game.time?.worldTime) || 0;
  const chance = Math.min(100, Math.max(0, evaluateActorFormula(settings.chanceFormula ?? "50 + gambling/10", actor, {
    fallback: 0,
    minimum: 0,
    context: "Все или ничего"
  })));
  const result = (Math.floor(Math.random() * 100) + 1) <= chance
    ? "criticalSuccess"
    : "criticalFailure";
  const effectKey = SMART_FUDGE_RESULT_EFFECT_KEYS[result];
  await actor.createEmbeddedDocuments("ActiveEffect", [{
    type: "base",
    name: "Все или ничего",
    img: abilityItem.img || "icons/svg/aura.svg",
    origin: abilityItem.uuid,
    transfer: false,
    disabled: false,
    showIcon: 0,
    system: {
      changes: [{
        key: effectKey,
        type: "add",
        value: "1",
        phase: "initial",
        priority: null
      }]
    },
    flags: {
      [SYSTEM_ID]: {
        kind: "temporary",
        [ALL_OR_NOTHING_EFFECT_FLAG_KEY]: {
          pending: true,
          abilityItemId: abilityItem.id,
          abilitySourceId: getAbilitySourceId(abilityItem),
          functionId: abilityFunction.id,
          fixedKey: abilityFunction.fixedKey,
          result,
          pelletCoveragePercent: Math.max(0, Math.min(100, toInteger(settings.pelletCoveragePercent))),
          burstCoveragePercent: Math.max(0, Math.min(100, toInteger(settings.burstCoveragePercent))),
          createdAt: startTime
        }
      }
    }
  }], { animate: false });
  return true;
}

async function consumeAllOrNothingResultEffects(context = {}) {
  const actorUuid = String(context?.attackerUuid ?? context?.actorUuid ?? "").trim();
  const actor = actorUuid ? fromUuidSync(actorUuid) : null;
  if (!actor || (!game.user?.isGM && !actor.isOwner)) return;
  const effectIds = Array.from(actor.effects ?? [])
    .filter(effect => !effect.disabled && Boolean(effect.getFlag?.(SYSTEM_ID, ALL_OR_NOTHING_EFFECT_FLAG_KEY)?.pending))
    .map(effect => effect.id)
    .filter(Boolean);
  if (!effectIds.length) return;
  await actor.deleteEmbeddedDocuments("ActiveEffect", effectIds, { animate: false });
}

function hasPendingAllOrNothingResultEffect(actor, abilityItem, abilityFunction) {
  if (!actor || !abilityItem) return false;
  const abilityItemId = String(abilityItem.id ?? "").trim();
  const abilitySourceId = getAbilitySourceId(abilityItem);
  return Array.from(actor.effects ?? []).some(effect => (
    !effect.disabled
    && allOrNothingResultApplies(effect.getFlag?.(SYSTEM_ID, ALL_OR_NOTHING_EFFECT_FLAG_KEY), {
      abilityItemId,
      abilitySourceId,
      functionId: abilityFunction?.id ?? ""
    })
  ));
}

function allOrNothingResultApplies(data = {}, { abilityItemId = "", abilitySourceId = "", functionId = "" } = {}) {
  if (!data || typeof data !== "object" || !data.pending) return false;
  const dataFunctionId = String(data.functionId ?? "").trim();
  if (dataFunctionId && functionId && dataFunctionId !== String(functionId).trim()) return false;
  const dataSourceId = String(data.abilitySourceId ?? "").trim();
  if (dataSourceId && abilitySourceId) return dataSourceId === abilitySourceId;
  return String(data.abilityItemId ?? "").trim() === abilityItemId;
}

function hasCurseAndBlessingEnergy(actor, cost = 0) {
  return hasEnergy(actor, cost);
}

function hasEnergy(actor, cost = 0) {
  return getActorEnergy(actor) - Math.max(0, toInteger(cost)) >= toInteger(actor?.system?.resources?.[ENERGY_RESOURCE_KEY]?.min);
}

function getActorEnergy(actor) {
  return Math.max(0, toInteger(actor?.system?.resources?.[ENERGY_RESOURCE_KEY]?.value));
}

function getResponsibleGM() {
  return game.users?.activeGM ?? (game.users?.contents ?? [])
    .filter(user => user.active && user.isGM)
    .sort((left, right) => left.id.localeCompare(right.id))
    .at(0) ?? null;
}

async function advanceDeusExMachinaProgressFromDamage(results = []) {
  const damageByActorUuid = new Map();
  for (const result of results.flat(Infinity).filter(Boolean)) {
    if (result.mode && result.mode !== "damage") continue;
    const targetActor = result.actor ?? (result.actorUuid ? fromUuidSync(result.actorUuid) : null);
    const targetActorUuid = targetActor?.uuid ?? String(result.actorUuid ?? "");
    const damage = Math.max(0, toInteger(result.healthDelta));
    if (!damage) continue;
    addActorDamageProgress(damageByActorUuid, targetActorUuid, damage);
    const sourceEntries = Array.isArray(result.sourceDamageEntries) && result.sourceDamageEntries.length
      ? result.sourceDamageEntries
      : [{ source: result.source, damage }];
    for (const entry of sourceEntries) {
      const attackerUuid = String(entry.source?.attackerUuid ?? "").trim();
      addActorDamageProgress(damageByActorUuid, attackerUuid, Math.max(0, toInteger(entry.damage)));
    }
  }

  for (const [actorUuid, damage] of damageByActorUuid) {
    const actor = fromUuidSync(actorUuid);
    if (!actor || (!game.user?.isGM && !actor.isOwner)) continue;
    for (const abilityItem of actor.items?.filter(item => item.type === "ability") ?? []) {
      await advanceDeusExMachinaProgress(actor, abilityItem, damage);
    }
  }
}

function addActorDamageProgress(progressMap, actorUuid = "", damage = 0) {
  const key = String(actorUuid ?? "").trim();
  if (!key || damage <= 0) return;
  progressMap.set(key, (progressMap.get(key) ?? 0) + damage);
}

async function advanceDeusExMachinaProgress(actor, abilityItem, damage = 0) {
  const entries = normalizeAbilityFunctions(abilityItem.system?.functions ?? [])
    .filter(entry => entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.deusExMachina);
  if (!entries.length || damage <= 0) return;

  const state = foundry.utils.deepClone(getFixedAbilityState(abilityItem));
  let changed = false;
  const readyMessages = [];
  for (const entry of entries) {
    const settings = normalizeDeusExMachinaSettings(entry.fixedSettings);
    const stateKey = getFixedFunctionStateKey(entry);
    const current = state[stateKey] ?? {};
    const nextDamage = Math.max(0, toInteger(current.damage)) + damage;
    const ready = nextDamage >= settings.damageRequired;
    state[stateKey] = {
      ...current,
      fixedKey: entry.fixedKey,
      damage: nextDamage,
      readyNotified: Boolean(current.readyNotified) || ready
    };
    changed = true;
    if (ready && !current.readyNotified) readyMessages.push(getFixedAbilityFunctionLabel(entry.fixedKey));
  }

  if (changed) await abilityItem.setFlag(SYSTEM_ID, ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY, state);
  for (const label of readyMessages) {
    await createAbilityChatMessage(actor, abilityItem, `${label}: накопление завершено. Способность готова к применению.`);
  }
}

async function useDeusExMachina(actor, abilityItem, abilityFunction) {
  const settings = normalizeDeusExMachinaSettings(abilityFunction.fixedSettings);
  const state = getFixedAbilityState(abilityItem);
  const stateKey = getFixedFunctionStateKey(abilityFunction);
  const progress = Math.max(0, toInteger(state[stateKey]?.damage));
  if (progress < settings.damageRequired) {
    ui.notifications.warn(`Бог из машины: накоплено ${progress} / ${settings.damageRequired}.`);
    return false;
  }

  const choice = await requestDeusExMachinaChoice(actor, settings);
  if (!choice) return false;

  let applied = false;
  if (choice === "insight") applied = await applyDeusExMachinaInsight(actor, abilityItem, abilityFunction, settings);
  else if (choice === "disintegrate") applied = await applyDeusExMachinaDisintegrate(actor, settings);
  else if (choice === "luckyFind") applied = await applyDeusExMachinaLuckyFind(actor, settings);
  else if (choice === "rescue") applied = await applyDeusExMachinaRescue(actor, settings);

  if (!applied) return false;
  await resetFixedFunctionProgress(abilityItem, abilityFunction);
  return true;
}

async function requestDeusExMachinaChoice(actor, settings) {
  const insightActive = hasDeusExMachinaInsightEffect(actor);
  const targets = Array.from(game.user?.targets ?? []).filter(token => token?.actor);
  const canDisintegrate = targets.length === 1;
  const canRescue = isActorDeadForDeusExMachina(actor);
  const choices = [
    {
      value: "insight",
      label: "Прозрение",
      description: `+${settings.insight.skillBonus} ко всем навыкам на ${formatDuration(settings.insight.durationSeconds)}.`,
      disabledReason: insightActive ? "Бонус уже активен." : ""
    },
    {
      value: "disintegrate",
      label: "Забавный случай",
      description: `Уничтожить ключевые конечности цели и ${settings.disintegrate.destroyPercent}% предметов/валюты.`,
      disabledReason: canDisintegrate ? "" : "Нужна ровно одна цель в таргете."
    },
    {
      value: "luckyFind",
      label: "Удачная находка",
      description: `Найти валюту общей ценностью ${settings.luckyFind.valueMin}-${settings.luckyFind.valueMax}.`,
      disabledReason: ""
    },
    {
      value: "rescue",
      label: "Чудесное спасение",
      description: getRescueChoiceDescription(settings),
      disabledReason: canRescue ? "" : "Доступно только если владелец мертв."
    }
  ];
  const defaultChoice = choices.find(choice => !choice.disabledReason)?.value ?? "";
  const content = `
    <div class="fallout-maw-fixed-function-dialog">
      ${choices.map(choice => renderDeusExMachinaChoice(
        choice.value,
        choice.label,
        choice.description,
        choice.disabledReason,
        choice.value === defaultChoice
      )).join("")}
    </div>
  `;
  let activeDialog = null;
  const onTargetToken = user => {
    if (user?.id !== game.user?.id || !activeDialog) return;
    queueMicrotask(() => syncDeusExMachinaTargetChoice(activeDialog));
  };
  Hooks.on("targetToken", onTargetToken);
  let formData;
  try {
    formData = await DialogV2.input({
      window: { title: "Бог из машины" },
      content,
      ok: {
        label: "Применить",
        icon: "fa-solid fa-check",
        callback: (_event, button) => new FormDataExtended(button.form).object
      },
      buttons: [{ action: "cancel", label: game.i18n.localize("FALLOUTMAW.Common.Cancel") }],
      position: { width: 520 },
      rejectClose: false,
      render: (_event, dialog) => {
        activeDialog = dialog;
        syncDeusExMachinaTargetChoice(dialog);
      }
    });
  } finally {
    Hooks.off("targetToken", onTargetToken);
    activeDialog = null;
  }
  const effect = String(formData?.effect ?? "");
  return ["insight", "disintegrate", "luckyFind", "rescue"].includes(effect) ? effect : "";
}

function renderDeusExMachinaChoice(value, label, description, disabledReason = "", checked = false) {
  const disabled = Boolean(disabledReason);
  return `
    <label class="fallout-maw-radio-card ${disabled ? "disabled" : ""}" data-deus-ex-machina-choice="${escapeAttribute(value)}">
      <input type="radio" name="effect" value="${escapeAttribute(value)}" ${disabled ? "disabled" : ""} ${checked && !disabled ? "checked" : ""}>
      <span>
        <strong>${escapeHTML(label)}</strong>
        <em>${escapeHTML(description)}</em>
        <small data-deus-ex-machina-disabled-reason ${disabled ? "" : "hidden"}>${escapeHTML(disabledReason)}</small>
      </span>
    </label>
  `;
}

function syncDeusExMachinaTargetChoice(dialog) {
  const root = dialog?.element?.querySelector?.(".fallout-maw-fixed-function-dialog");
  const choice = root?.querySelector?.('[data-deus-ex-machina-choice="disintegrate"]');
  const input = choice?.querySelector?.('input[name="effect"]');
  const reason = choice?.querySelector?.("[data-deus-ex-machina-disabled-reason]");
  if (!choice || !input || !reason) return;

  const canDisintegrate = Array.from(game.user?.targets ?? []).filter(token => token?.actor).length === 1;
  input.disabled = !canDisintegrate;
  choice.classList.toggle("disabled", !canDisintegrate);
  reason.hidden = canDisintegrate;
  reason.textContent = canDisintegrate ? "" : "Нужна ровно одна цель в таргете.";

  if (!canDisintegrate && input.checked) {
    input.checked = false;
    root.querySelector('input[name="effect"]:not(:disabled)')?.click();
  }
}

async function applyDeusExMachinaInsight(actor, abilityItem, abilityFunction, settings) {
  if (hasDeusExMachinaInsightEffect(actor)) {
    ui.notifications.warn("Прозрение уже активно.");
    return false;
  }
  if (!getSkillSettings().length) {
    ui.notifications.warn("Навыки не настроены.");
    return false;
  }
  const changes = [{
    key: ALL_SKILLS_BONUS_EFFECT_KEY,
    type: "add",
    value: String(settings.insight.skillBonus),
    phase: "initial",
    priority: null
  }];

  const startTime = Number(game.time?.worldTime) || 0;
  await actor.createEmbeddedDocuments("ActiveEffect", [{
    type: "base",
    name: "Прозрение",
    img: abilityItem.img || "icons/svg/aura.svg",
    origin: abilityItem.uuid,
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    duration: {
      seconds: Math.max(0, toInteger(settings.insight.durationSeconds)),
      startTime
    },
    system: { changes },
    flags: {
      [SYSTEM_ID]: {
        kind: "temporary",
        [DEUS_EX_MACHINA_INSIGHT_EFFECT_FLAG_KEY]: {
          abilityItemId: abilityItem.id,
          abilitySourceId: getAbilitySourceId(abilityItem),
          functionId: abilityFunction.id,
          createdAt: startTime
        }
      }
    }
  }], { animate: false });
  await createAbilityChatMessage(actor, abilityItem, "Бог из машины: Прозрение применено.");
  return true;
}

async function applyDeusExMachinaDisintegrate(actor, settings) {
  const targets = Array.from(game.user?.targets ?? []).filter(token => token?.actor);
  if (targets.length !== 1) {
    ui.notifications.warn("Для Забавного случая нужна ровно одна цель.");
    return false;
  }
  const targetActor = targets[0].actor;
  if (!targetActor?.isOwner && !game.user?.isGM) {
    ui.notifications.warn(`Нет прав на изменение цели ${targetActor?.name ?? ""}.`);
    return false;
  }

  const criticalLimbKeys = getCriticalLimbKeys(targetActor);
  for (const limbKey of criticalLimbKeys) await setLimbMissingState(targetActor, limbKey, { syncStatus: false });
  await applyDestroyedLimbConsequences(targetActor, criticalLimbKeys);
  await destroyTargetPossessions(targetActor, settings.disintegrate.destroyPercent);
  await createAbilityChatMessage(actor, null, `Бог из машины: цель ${targetActor.name} постиг забавный случай.`);
  return true;
}

async function applyDeusExMachinaLuckyFind(actor, settings) {
  const min = Math.min(settings.luckyFind.valueMin, settings.luckyFind.valueMax);
  const max = Math.max(settings.luckyFind.valueMin, settings.luckyFind.valueMax);
  const totalValue = min + Math.floor(Math.random() * ((max - min) + 1));
  const awards = createRandomCurrencyAwards(totalValue);
  if (!awards.length) {
    ui.notifications.warn("Валюты не настроены.");
    return false;
  }

  const update = {};
  for (const award of awards) {
    update[`system.currencies.${award.key}`] = Math.max(0, toInteger(actor.system?.currencies?.[award.key])) + award.amount;
  }
  await actor.update(update);
  await createAbilityChatMessage(actor, null, `Бог из машины: найдена валюта общей ценностью ${totalValue}.`);
  return true;
}

async function applyDeusExMachinaRescue(actor, settings) {
  if (!isActorDeadForDeusExMachina(actor)) {
    ui.notifications.warn("Чудесное спасение доступно только если владелец мертв.");
    return false;
  }

  const destroyed = getCriticalLimbKeys(actor).filter(limbKey => isLimbDestroyed(actor, limbKey));
  const restoreKeys = settings.rescue.restoreMode === "all"
    ? destroyed
    : destroyed.slice(0, Math.max(1, toInteger(settings.rescue.restoreCount)));
  for (const limbKey of restoreKeys) await restoreDeusExMachinaLimb(actor, limbKey);

  const health = actor.system?.resources?.health;
  const min = toInteger(health?.min);
  if (toInteger(health?.value) <= min) {
    await actor.update({ "system.resources.health.value": min + 1 });
  }
  await createAbilityChatMessage(actor, null, "Бог из машины: Чудесное спасение применено.");
  return true;
}

async function restoreDeusExMachinaLimb(actor, limbKey = "") {
  if (game.user?.isGM) return restoreDestroyedLimb(actor, limbKey);
  const limb = actor?.system?.limbs?.[limbKey];
  if (!actor?.isOwner || !limb) return undefined;
  const max = Math.max(0, toInteger(limb.max));
  return actor.update({
    [`system.limbs.${limbKey}.missing`]: false,
    [`system.limbs.${limbKey}.value`]: max,
    [`system.limbs.${limbKey}.spent`]: 0,
    [`system.limbs.${limbKey}.damageAccumulation`]: {}
  });
}

async function resetFixedFunctionProgress(abilityItem, abilityFunction) {
  const state = foundry.utils.deepClone(getFixedAbilityState(abilityItem));
  const stateKey = getFixedFunctionStateKey(abilityFunction);
  state[stateKey] = {
    fixedKey: abilityFunction.fixedKey,
    damage: 0,
    readyNotified: false
  };
  await abilityItem.setFlag(SYSTEM_ID, ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY, state);
}

async function destroyTargetPossessions(actor, percent = 100) {
  const destroyPercent = Math.max(0, Math.min(100, toInteger(percent)));
  if (!destroyPercent) return;

  const itemUpdates = [];
  const itemDeletes = [];
  for (const item of actor.items ?? []) {
    if (item.type === "ability") continue;
    const quantity = Math.max(1, toInteger(item.system?.quantity ?? 1));
    const destroyQuantity = destroyPercent >= 100 ? quantity : Math.floor((quantity * destroyPercent) / 100);
    if (destroyQuantity <= 0) continue;
    if (destroyQuantity >= quantity) itemDeletes.push(item.id);
    else itemUpdates.push({ _id: item.id, "system.quantity": quantity - destroyQuantity });
  }
  if (itemDeletes.length) await actor.deleteEmbeddedDocuments("Item", itemDeletes, { animate: false });
  if (itemUpdates.length) await actor.updateEmbeddedDocuments("Item", itemUpdates);

  const currencyUpdate = {};
  for (const key of Object.keys(actor.system?.currencies ?? {})) {
    const amount = Math.max(0, toInteger(actor.system.currencies[key]));
    const destroyed = destroyPercent >= 100 ? amount : Math.floor((amount * destroyPercent) / 100);
    currencyUpdate[`system.currencies.${key}`] = Math.max(0, amount - destroyed);
  }
  if (Object.keys(currencyUpdate).length) await actor.update(currencyUpdate);
}

function createRandomCurrencyAwards(totalValue = 0) {
  const currencies = getCurrencySettings()
    .map(currency => ({
      key: String(currency.key ?? "").trim(),
      label: String(currency.label ?? currency.key ?? ""),
      value: Math.max(1, Number(currency.value) || 1)
    }))
    .filter(currency => currency.key);
  if (!currencies.length) return [];

  const awards = new Map();
  let remaining = Math.max(0, toInteger(totalValue));
  let guard = 0;
  while (remaining > 0 && guard < 10000) {
    guard += 1;
    const affordable = currencies.filter(currency => currency.value <= remaining);
    const pool = affordable.length ? affordable : currencies;
    const currency = pool[Math.floor(Math.random() * pool.length)];
    awards.set(currency.key, (awards.get(currency.key) ?? 0) + 1);
    remaining -= currency.value;
  }
  return Array.from(awards, ([key, amount]) => ({ key, amount }));
}

function getFixedAbilityState(abilityItem) {
  const state = abilityItem?.getFlag?.(SYSTEM_ID, ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY)
    ?? abilityItem?.flags?.[SYSTEM_ID]?.[ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY];
  return state && typeof state === "object" ? state : {};
}

function getFixedFunctionStateKey(abilityFunction = {}) {
  return [String(abilityFunction.id ?? ""), String(abilityFunction.fixedKey ?? "")].filter(Boolean).join(":");
}

function getCriticalLimbKeys(actor) {
  return Object.keys(actor?.system?.limbs ?? {}).filter(limbKey => isCriticalLimb(actor, limbKey));
}

function isActorDeadForDeusExMachina(actor) {
  return Boolean(actor?.statuses?.has?.(STATUS_EFFECTS.dead))
    || getCriticalLimbKeys(actor).some(limbKey => isLimbDestroyed(actor, limbKey));
}

function hasDeusExMachinaInsightEffect(actor) {
  return Array.from(actor?.effects ?? []).some(effect => (
    !effect.disabled
    && Boolean(effect.getFlag?.(SYSTEM_ID, DEUS_EX_MACHINA_INSIGHT_EFFECT_FLAG_KEY))
  ));
}

function getRescueChoiceDescription(settings) {
  if (settings.rescue.restoreMode === "all") return "Восстановить все ключевые конечности и прийти в сознание.";
  return `Восстановить ключевые конечности: ${Math.max(1, toInteger(settings.rescue.restoreCount))}.`;
}

function formatDuration(seconds = 0) {
  const safeSeconds = Math.max(0, toInteger(seconds));
  if (!safeSeconds) return "без ограничения времени";
  if (safeSeconds % 3600 === 0) return `${safeSeconds / 3600} ч.`;
  if (safeSeconds % 60 === 0) return `${safeSeconds / 60} мин.`;
  return `${safeSeconds} сек.`;
}

async function createAbilityChatMessage(actor, item, message = "") {
  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<p><strong>${escapeHTML(item?.name ?? "Бог из машины")}</strong></p><p>${escapeHTML(message)}</p>`,
    sound: null
  });
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  })[character]);
}

function escapeAttribute(value) {
  return escapeHTML(value).replace(/`/g, "&#096;");
}
