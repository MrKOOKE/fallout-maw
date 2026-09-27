import { SYSTEM_ID } from "../constants.mjs";
import { getActorFixedAbilityFunctionEntry, getAbilityFixedFunctionState, getAbilityFixedFunctionStateKey } from "./runtime-state.mjs";
import { ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY } from "../settings/abilities.mjs";
import { evaluateActorFormula } from "../utils/actor-formulas.mjs";
import { getActorActiveCombat } from "../combat/combat-membership.mjs";
import { registerSystemEventObserver } from "../events/dispatcher.mjs";
import { registerQueuedWorldTimeProcessor } from "../time/world-time-queue.mjs";
import { spendActorEnergyWithReceipt } from "../combat/energy-resource.mjs";
import { runOneTimeResourceMutation } from "../combat/one-time-resources.mjs";
import { applyAbilityOverloadEffect, getAbilityOverloadEnergyCost } from "./overload.mjs";
import { getResourceKeyFromOverloadEffectKey, evaluateActorEffectChangeNumber } from "../utils/active-effect-changes.mjs";
import { requestDamageApplication, requestDamageApplications, getCurrentDamageHubOperationRef, registerDamageAppliedHandler } from "../combat/damage-hub.mjs";
import { buildWeaponExplosionDamageRequests, canTokenPhysicallySeeTarget } from "../combat/weapon-attack-controller.mjs";
import { playWeaponExplosionAnimation } from "../combat/attack-animations.mjs";
import { getDamageTypeSettings } from "../settings/accessors.mjs";
import { getAuraRelation, measureTokenDistanceMeters, getTokenCenter } from "./aura-conditions.mjs";
import { advanceOnslaught, bloodbathMissingHealthBonus, secondWindResourceRecovery } from "./release-ability-rules.mjs";
import { absorbLiberationOverload, activeLiberations } from "./liberation-state.mjs";

const onslaughtSnapshots = new Map();
const activeWatchers = new Set();
let registered = false;
const now = () => Number(game.time?.worldTime) || 0;
const entryFor = (actor, key) => getActorFixedAbilityFunctionEntry(actor, key);
const resolve = uuid => uuid ? globalThis.fromUuidSync?.(uuid) : null;
const tokenFor = actor => canvas?.tokens?.placeables?.find(token => token.actor?.uuid === actor?.uuid);
const authorized = actor => game.user?.isGM || actor?.isOwner;
function stateFor(entry) { return getAbilityFixedFunctionState(entry?.abilityItem)[getAbilityFixedFunctionStateKey(entry?.abilityFunction)] ?? {}; }
async function saveState(entry, state) {
  const all = foundry.utils.deepClone(getAbilityFixedFunctionState(entry.abilityItem));
  all[getAbilityFixedFunctionStateKey(entry.abilityFunction)] = state;
  await entry.abilityItem.setFlag(SYSTEM_ID, ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY, all);
}
function sourceFor(actor, item, extra = {}) { return { attackerUuid: actor.uuid, abilityItemUuid: item.uuid, ...extra }; }
async function chat(actor, item, text) {
  await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: `<p><strong>${foundry.utils.escapeHTML(item.name)}</strong>: ${text}</p>` });
}
async function pay(actor, item, fn, cost, overload, seconds) {
  const total = cost + getAbilityOverloadEnergyCost(actor, item, fn);
  const receipt = await spendActorEnergyWithReceipt(actor, total);
  if (receipt.spent !== total) { ui.notifications.warn(`${item.name}: недостаточно энергии.`); return false; }
  await applyAbilityOverloadEffect(actor, item, fn, { name: `Перегрузка: ${item.name}`, energyCost: overload, durationSeconds: seconds });
  return true;
}
function effectData(item, flag, data, changes = [], seconds = 0) {
  return { type: "base", name: item.name, img: item.img, origin: item.uuid, transfer: false, disabled: false, showIcon: 2,
    start: { time: now() }, duration: seconds ? { value: seconds, units: "seconds", expired: false } : {},
    system: { changes }, flags: { [SYSTEM_ID]: { kind: "temporary", [flag]: data } } };
}
const change = (key, value) => ({ key, type: "add", value: String(value), phase: "initial", priority: null });

export async function useReleaseAbility(actor, item, fn, { targetActor = null } = {}) {
  const entry = { abilityItem: item, abilityFunction: fn };
  if (fn.fixedKey === "secondWind") {
    if (!await pay(actor, item, fn, 50, 200, 86400)) return false;
    const traumas = Array.from(actor.items ?? []).filter(i => i.type === "trauma").map(i => i.id);
    if (traumas.length) await actor.deleteEmbeddedDocuments("Item", traumas);
    await requestDamageApplication({ actor, mode: "healing", scope: "health", amount: Math.ceil(Number(actor.system.resources.health.max) / 2), applyMitigation: false,
      processDamageTypeSettings: false, source: sourceFor(actor, item) });
    await runOneTimeResourceMutation(actor, async () => {
      const updates = {};
      for (const key of ["actionPoints", "movementPoints"]) {
        const resource = actor.system.resources[key];
        if (!resource) continue;
        const recovery = secondWindResourceRecovery(resource);
        updates[`system.resources.${key}.value`] = recovery.value;
        updates[`system.resources.${key}.once`] = recovery.once;
      }
      await actor.update(updates);
    });
    await chat(actor, item, "Травмы излечены, здоровье и очки восстановлены.");
    return true;
  }
  if (fn.fixedKey === "equipmentLimit") {
    const selected = targetActor ? [] : Array.from(game.user?.targets ?? []).filter(t => t.actor);
    const target = targetActor ?? selected[0]?.actor ?? actor;
    if (selected.length > 1 || !["self", "ally"].includes(getAuraRelation(actor, target))) {
      ui.notifications.warn("Выберите одного союзника или снимите выделение цели для применения на себя."); return false;
    }
    if (!authorized(target)) {
      const gm = game.users?.activeGM;
      if (!gm) { ui.notifications.warn("Для применения к союзнику нужен активный ведущий."); return false; }
      return gm.query("fallout-maw.equipmentLimit", { actorUuid: actor.uuid, itemId: item.id, targetUuid: target.uuid });
    }
    if (!await pay(actor, item, fn, 20, 20, 60)) return false;
    const itemIds = Array.from(target.items ?? []).filter(i => i.type === "gear" && Number(i.system?.functions?.condition?.value) > 0).map(i => i.id);
    await target.createEmbeddedDocuments("ActiveEffect", [effectData(item, "equipmentLimit", { itemIds, expiresAt: now() + 12 }, [], 12)]);
    return true;
  }
  if (fn.fixedKey === "watcher") {
    const combat = getActorActiveCombat(actor);
    if (!combat) { ui.notifications.warn("Смотритель: активация доступна только в бою."); return false; }
    if (stateFor(entry).combatUuid === combat.uuid) return false;
    if (!await pay(actor, item, fn, 30, 100, 3600)) return false;
    await saveState(entry, { combatUuid: combat.uuid });
    activeWatchers.add(actor.uuid);
    await chat(actor, item, "Наблюдение за союзниками активно до конца боя."); return true;
  }
  if (fn.fixedKey === "liberation") {
    const state = stateFor(entry);
    if (state.cooldownUntil > now()) { ui.notifications.warn("Освобождение: способность перезаряжается."); return false; }
    if (!tokenFor(actor)) { ui.notifications.warn("Освобождение: нужен токен на сцене."); return false; }
    await saveState(entry, { cooldownUntil: now() + 86400 });
    await actor.setFlag(SYSTEM_ID, "liberation", { until: now() + 6, damage: 0, itemUuid: item.uuid, tokenUuid: tokenFor(actor).document.uuid });
    activeLiberations.set(actor.uuid, actor);
    const effects = Array.from(actor.effects ?? []).filter(e => !e.disabled && !e.isExpired && e.flags?.[SYSTEM_ID]?.abilityOverload);
    let damage = 0;
    for (const effect of effects) for (const row of effect.system?.changes ?? []) {
      if (getResourceKeyFromOverloadEffectKey(row.key)) damage += Math.max(0, evaluateActorEffectChangeNumber(actor, { ...row, effect }, { fallback: 0 }));
    }
    if (effects.length) await actor.deleteEmbeddedDocuments("ActiveEffect", effects.map(e => e.id));
    await absorbLiberationOverload(actor, damage);
    return true;
  }
  return false;
}

function onslaughtState(actor, entry) {
  const combat = getActorActiveCombat(actor);
  if (!combat) return null;
  const gain = Math.floor(evaluateActorFormula("10+athletics/5", actor));
  const saved = stateFor(entry);
  return advanceOnslaught(saved.combatUuid === combat.uuid ? saved : { combatUuid: combat.uuid, damage: gain, nextGainAt: now() + 6 }, now(), gain);
}

export function getReleaseCombatBonus(actor, key, context = {}) {
  if (!actor) return 0;
  let bonus = 0;
  if (key === "damageFlat") {
    const entry = entryFor(actor, "onslaught");
    const state = entry && onslaughtState(actor, entry);
    if (state) {
      const id = String(context.weaponAttackId ?? context.attackId ?? context.chanceOperationId ?? "");
      const cacheKey = `${actor.uuid}:${id}`;
      if (id && !onslaughtSnapshots.has(cacheKey)) {
        if (onslaughtSnapshots.size >= 128) onslaughtSnapshots.delete(onslaughtSnapshots.keys().next().value);
        onslaughtSnapshots.set(cacheKey, state.damage);
      }
      bonus += id ? onslaughtSnapshots.get(cacheKey) : state.damage;
    }
  }
  if (["criticalChance", "criticalDamagePercent"].includes(key) && entryFor(actor, "bloodbath")) {
    const target = context.targetActor ?? context.targetToken?.actor;
    bonus += bloodbathMissingHealthBonus(target?.system?.resources?.health) * (key === "criticalChance" ? 1 : 5);
  }
  return bonus;
}

export function getWatcherAttackBonus(attacker, target, context = {}) {
  if (!attacker || !target || !activeWatchers.size) return { accuracy: 0, difficulty: 0 };
  let accuracy = 0, difficulty = 0;
  const attackerToken = context.actorToken?.object ?? context.actorToken ?? tokenFor(attacker);
  const targetToken = context.targetToken?.object ?? context.targetToken ?? tokenFor(target);
  if (!attackerToken || !targetToken) return { accuracy, difficulty };
  for (const uuid of activeWatchers) {
    const owner = resolve(uuid), watcher = tokenFor(owner);
    if (!watcher || owner.statuses?.has("dead") || owner.statuses?.has("unconscious")) continue;
    const entry = entryFor(owner, "watcher"), combat = getActorActiveCombat(owner);
    if (!entry || !combat || stateFor(entry).combatUuid !== combat.uuid) continue;
    const radius = evaluateActorFormula("5+speech/10", owner);
    if (getAuraRelation(owner, attacker) === "ally" && measureTokenDistanceMeters(watcher, attackerToken) <= radius
      && canTokenPhysicallySeeTarget(watcher, targetToken)) accuracy = Math.max(accuracy, 30);
    if (getAuraRelation(owner, target) === "ally" && measureTokenDistanceMeters(watcher, targetToken) <= radius
      && canTokenPhysicallySeeTarget(watcher, attackerToken)) difficulty = Math.max(difficulty, 40);
  }
  return { accuracy, difficulty };
}

export async function applySoulEaterLuck(context, actor, item) {
  const combat = getActorActiveCombat(actor);
  if (!combat) return;
  const killed = new Set(context.killedTargetUuids ?? []);
  const hits = [...new Set(context.successfulAttackTargetActorUuids ?? [])];
  const existing = Array.from(actor.effects ?? []).find(e => e.flags?.[SYSTEM_ID]?.soulEater?.sourceActorUuid === actor.uuid
    && e.flags[SYSTEM_ID].soulEater.combatUuid === combat.uuid && !e.disabled);
  const current = Number(existing?.flags[SYSTEM_ID]?.soulEater?.bonus) || 0;
  let gain = Math.min(12 - current, 3 * killed.size);
  for (const uuid of hits) {
    if (current + gain >= 12) break;
    const target = resolve(uuid);
    if (!target || target.uuid === actor.uuid || !(Number(target.system?.characteristics?.luck) > 0)) continue;
    if (!authorized(target)) continue;
    await target.createEmbeddedDocuments("ActiveEffect", [effectData(item, "soulEater", { combatUuid: combat.uuid, sourceActorUuid: actor.uuid }, [change("system.characteristics.luck", -1)])]);
    gain += 1;
  }
  if (gain <= 0) return;
  const bonus = Math.min(12, current + gain);
  const data = effectData(item, "soulEater", { combatUuid: combat.uuid, sourceActorUuid: actor.uuid, bonus }, [change("system.characteristics.luck", bonus)]);
  if (existing) await existing.update(data);
  else await actor.createEmbeddedDocuments("ActiveEffect", [data]);
}

async function pulse(actor, item, centerToken, radius, damage, typeKey, pellets, source = {}, excludeAllies = false) {
  if (!centerToken || damage <= 0) return;
  const type = getDamageTypeSettings().find(t => t.key === typeKey);
  if (!type) throw new Error(`Unknown damage type: ${typeKey}`);
  const requests = [];
  const seen = new Set();
  for (const token of canvas.tokens?.placeables ?? []) {
    if (!token.actor || seen.has(token.actor.uuid) || measureTokenDistanceMeters(centerToken, token) > radius) continue;
    if (excludeAllies && ["self", "ally"].includes(getAuraRelation(actor, token.actor))) continue;
    seen.add(token.actor.uuid);
    requests.push(...buildWeaponExplosionDamageRequests({ targetToken: token, center: getTokenCenter(centerToken), radiusPixels: 0,
      baseDamage: damage, pelletCount: pellets, damageTypes: [{ key: type.key, weight: 1 }], source: sourceFor(actor, item, source) }));
  }
  if (requests.length) await requestDamageApplications(requests);
}

export function registerReleaseAbilityRuntime() {
  if (registered) return;
  registered = true;
  CONFIG.queries["fallout-maw.equipmentLimit"] = async (data, { user } = {}) => {
    if (!game.user?.isGM || !user) return false;
    const actor = resolve(data.actorUuid), target = resolve(data.targetUuid);
    const entry = entryFor(actor, "equipmentLimit");
    if (!actor?.testUserPermission(user, "OWNER") || !target || entry?.abilityItem.id !== data.itemId) return false;
    return useReleaseAbility(actor, entry.abilityItem, entry.abilityFunction, { targetActor: target });
  };
  registerSystemEventObserver({ id: "fallout-maw.releaseAbilities.combat", eventKeys: ["fallout-maw.combat.started", "fallout-maw.combat.ended"], priority: 155,
    observe: async ({ event }) => {
      if (!game.user?.isActiveGM) return;
      const combat = resolve(event.data?.combatUuid);
      const actors = new Map(Array.from(combat?.combatants ?? [], c => [c.actor?.uuid, c.actor]));
      for (const actor of actors.values()) {
        if (!actor) continue;
        const entry = entryFor(actor, "onslaught");
        if (entry) await saveState(entry, event.key.endsWith("started") ? { combatUuid: combat.uuid, damage: Math.min(200, Math.floor(evaluateActorFormula("10+athletics/5", actor))), nextGainAt: now() + 6 } : {});
      }
      if (event.key.endsWith("ended")) {
        for (const actor of actors.values()) if (actor) activeWatchers.delete(actor.uuid);
        const all = new Map([...Array.from(game.actors ?? [], a => [a.uuid, a]), ...Array.from(canvas?.tokens?.placeables ?? [], t => [t.actor?.uuid, t.actor])]);
        for (const actor of all.values()) {
          const ids = Array.from(actor?.effects ?? []).filter(e => e.flags?.[SYSTEM_ID]?.soulEater?.combatUuid === event.data.combatUuid).map(e => e.id);
          if (ids.length) await actor.deleteEmbeddedDocuments("ActiveEffect", ids);
        }
      }
    }
  });
  registerSystemEventObserver({ id: "fallout-maw.releaseAbilities.attack", eventKeys: ["fallout-maw.weapon.attack.resolved"], priority: 156,
    observe: async ({ event }) => {
      if (!game.user?.isActiveGM || event?.data?.attackCycleAggregate !== true || !(event.data.attackCheckCount > 0)) return;
      const actor = resolve(event.participants?.source?.actorUuid);
      const entry = entryFor(actor, "onslaught");
      if (entry && !event.data.deferredImpactResolution) {
        const state = onslaughtState(actor, entry);
        if (state) {
          const attackId = String(event.data.attackId ?? event.data.weaponAttackId ?? "");
          const id = `${actor.uuid}:${attackId}`;
          const spent = onslaughtSnapshots.get(id) ?? state.damage;
          onslaughtSnapshots.delete(id);
          const pending = { ...(state.pending ?? {}) };
          const gained = Number(pending[attackId]) || 0;
          delete pending[attackId];
          await saveState(entry, { ...state, damage: Math.min(200, Math.max(0, state.damage - spent) + gained), pending, lastAttackId: attackId });
        }
      }
      if (event.data.deferredImpactPending) return;
      const reaper = entryFor(actor, "reaper");
      if (reaper?.abilityFunction.fixedSettings?.stealLuck) await applySoulEaterLuck(event.data, actor, reaper.abilityItem);
    }
  });
  registerDamageAppliedHandler("fallout-maw.releaseAbilities.damage", async ({ results }) => {
    for (const result of results) {
      if (result.mode !== "damage" || result.lethalDamagePrevented || result.source?.releaseAbilityPulse) continue;
      const actor = resolve(result.source?.attackerUuid);
      if (!actor || !authorized(actor)) continue;
      const onslaught = entryFor(actor, "onslaught");
      if (onslaught && result.killedByDamage) {
        const state = onslaughtState(actor, onslaught);
        if (state) {
          const attackId = String(result.source?.attackId ?? "");
          const gain = Math.max(0, Number(result.overkillDamage) || 0);
          if (!attackId || state.lastAttackId === attackId) await saveState(onslaught, { ...state, damage: Math.min(200, state.damage + gain) });
          else await saveState(onslaught, { ...state, pending: { ...(state.pending ?? {}), [attackId]: Math.min(200, (Number(state.pending?.[attackId]) || 0) + gain) } });
        }
      }
      const bloodbath = entryFor(actor, "bloodbath");
      if (!bloodbath) continue;
      for (const destroyed of result.destroyedLimbDamage ?? []) {
        if (!destroyed.critical) continue;
        const token = resolve(result.source?.targetTokenUuid)?.object ?? tokenFor(result.actor);
        if (!token) continue;
        await chat(actor, bloodbath.abilityItem, "сработала.");
        const grid = token.document?.parent?.grid ?? canvas.scene?.grid;
        await playWeaponExplosionAnimation({
          weaponData: { volley: { explosionAnimationKey: bloodbath.abilityFunction.fixedSettings.explosionAnimationKey } },
          center: getTokenCenter(token),
          radiusPixels: 2 * (Number(grid?.size) || 100) / (Number(grid?.distance) || 1)
        });
        await pulse(actor, bloodbath.abilityItem, token, 2, destroyed.max + destroyed.excess, "bludgeoning", 8, {
          releaseAbilityPulse: true, chainRef: result.source?.chainRef,
          damageHubOperationRef: getCurrentDamageHubOperationRef()
        });
      }
    }
  });
  registerQueuedWorldTimeProcessor(async time => {
    if (!game.user?.isActiveGM) return;
    for (const [uuid, actor] of activeLiberations) {
      const data = actor.getFlag(SYSTEM_ID, "liberation");
      if (!data) { activeLiberations.delete(uuid); continue; }
      if (data.until > time) continue;
      const token = resolve(data.tokenUuid)?.object ?? tokenFor(actor);
      if (!token) continue;
      const item = resolve(data.itemUuid);
      if (!item) { await actor.unsetFlag(SYSTEM_ID, "liberation"); activeLiberations.delete(uuid); continue; }
      await actor.unsetFlag(SYSTEM_ID, "liberation");
      activeLiberations.delete(uuid);
      await pulse(actor, item, token, evaluateActorFormula("10+energy/10", actor), data.damage, "energy", 1, { releaseAbilityPulse: true }, true);
    }
  }, { priority: 35 });
  const reconcile = () => {
    for (const actor of [...(game.actors ?? []), ...(canvas?.tokens?.placeables ?? []).map(t => t.actor)].filter(Boolean)) {
      if (actor.getFlag(SYSTEM_ID, "liberation")) activeLiberations.set(actor.uuid, actor);
      const entry = entryFor(actor, "watcher");
      if (entry && stateFor(entry).combatUuid === getActorActiveCombat(actor)?.uuid) activeWatchers.add(actor.uuid);
    }
  };
  Hooks.on("updateItem", item => {
    if (item.type !== "ability" || !Array.from(item.system?.functions ?? []).some(fn => fn.fixedKey === "watcher")) return;
    const actor = item.parent, entry = entryFor(actor, "watcher");
    if (entry && stateFor(entry).combatUuid === getActorActiveCombat(actor)?.uuid) activeWatchers.add(actor.uuid);
    else activeWatchers.delete(actor?.uuid);
  });
  Hooks.on("deleteActor", actor => { activeWatchers.delete(actor.uuid); activeLiberations.delete(actor.uuid); });
  Hooks.on("canvasReady", reconcile);
  Hooks.on("fallout-maw.modifySkillCheck", check => {
    if (check.requester !== "weaponAttack") return;
    const bonus = getWatcherAttackBonus(check.actor, check.targetActor, check);
    if (bonus.difficulty) {
      check.difficulty = (Number(check.difficulty) || 0) + bonus.difficulty;
      check.modifiers?.push?.({ source: "watcher", label: "Смотритель: защита союзника", value: bonus.difficulty });
    }
  });
  if (game.ready) reconcile(); else Hooks.once("ready", reconcile);
}
