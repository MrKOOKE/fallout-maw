import { SYSTEM_ID } from "../constants.mjs";
import {
  ENERGY_RESOURCE_KEY,
  restoreActorEnergy
} from "../combat/energy-resource.mjs";
import {
  ABILITY_FIXED_FUNCTION_KEYS,
  ABILITY_FUNCTION_TYPES,
  normalizeAbilityFunctions,
  normalizePainLordSettings
} from "../settings/abilities.mjs";
import { getReverseEffectKey } from "../utils/active-effect-keys.mjs";
import { isPhantomEntity } from "./phantom-entity.mjs";

export const PAIN_LORD_DAMAGE_HANDLER_ID = "fallout-maw.fixed.painLord";
export const PAIN_LORD_MARK_EFFECT_FLAG_KEY = "painLordMark";
export const PAIN_LORD_OVERFLOW_EFFECT_FLAG_KEY = "painLordOverflow";

const DAMAGE_PERCENT_EFFECT_KEY = "system.combat.damagePercent";
const INCOMING_DAMAGE_PERCENT_EFFECT_KEY = getReverseEffectKey(DAMAGE_PERCENT_EFFECT_KEY);
const ACTIVE_EFFECT_SHOW_ICON_ALWAYS = 2;
const PAIN_LORD_MARK_EFFECT_NAME = "Владыка боли";
const PAIN_LORD_OVERFLOW_EFFECT_NAME = "Владыка боли: Избыток энергии";

/**
 * Apply one completed damage-hub operation. Damage is first aggregated so
 * split damage types never lose 5:1 remainder and never restore Energy twice.
 */
export async function processPainLordDamageResults(results = []) {
  const batches = collectPainLordDamageBatches(results);
  if (!batches.victims.size) return { victims: 0, offenders: 0 };

  const markContributions = new Map();
  for (const batch of batches.victims.values()) {
    const context = findPainLordAbilityContext(batch.actor);
    if (!context || !canManageActor(batch.actor)) continue;

    const requestedEnergy = Math.max(0, Math.floor(
      (batch.damage * context.settings.energyPerDamage) + 1e-9
    ));
    if (requestedEnergy > 0 && batch.actor.system?.resources?.[ENERGY_RESOURCE_KEY]) {
      const receipt = await restoreActorEnergy(batch.actor, requestedEnergy);
      if (receipt.overflow > 0) {
        await addPainLordOverflow(batch.actor, context, receipt.overflow);
      }
    }

    for (const [offenderUuid, offenderDamage] of batch.offenders) {
      const offender = resolveActorUuid(offenderUuid);
      if (
        !offender
        || offender.uuid === batch.actor.uuid
        || isPhantomEntity(offender)
        || !canManageActor(offender)
      ) continue;
      const entry = markContributions.get(offender.uuid) ?? { actor: offender, contributions: [] };
      entry.contributions.push({ context, damage: offenderDamage });
      markContributions.set(offender.uuid, entry);
    }
  }

  for (const entry of markContributions.values()) {
    await addPainLordMarkContributions(entry.actor, entry.contributions);
  }
  return { victims: batches.victims.size, offenders: markContributions.size };
}

/** Build the exact percentage from the stored raw pool without losing remainder. */
export function calculatePainLordAccumulation(rawAmount = 0, amountPerPercent = 5, maxPercent = 100) {
  const ratio = Math.max(0.01, Number(amountPerPercent) || 5);
  const maximumPercent = Math.max(0, Number(maxPercent) || 0);
  const maximumRaw = ratio * maximumPercent;
  const raw = Math.min(maximumRaw, Math.max(0, Number(rawAmount) || 0));
  return {
    raw,
    maximumRaw,
    percent: Math.min(maximumPercent, Math.floor((raw / ratio) + 1e-9))
  };
}

export function abilityItemHasPainLord(item) {
  if (item?.type !== "ability") return false;
  return normalizeAbilityFunctions(item.system?.functions ?? []).some(entry => (
    entry.type === ABILITY_FUNCTION_TYPES.fixed
    && entry.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.painLord
  ));
}

export function painLordAbilityUpdateMayAffectEffects(changes = {}) {
  return Object.keys(foundry.utils.flattenObject(changes ?? {})).some(path => (
    path === "name"
    || path === "img"
    || path === "system.functions"
    || path.startsWith("system.functions.")
  ));
}

/** Remove one deleted/changed ability's own overflow and its contribution to every mark. */
export async function cleanupPainLordEffectsForAbilityItem(item) {
  if (item?.type !== "ability") return;
  const sourceActorUuid = String(item.parent?.uuid ?? "");
  const abilityItemId = String(item.id ?? "");
  if (!sourceActorUuid || !abilityItemId) return;

  for (const actor of getKnownActors()) {
    if (!canManageActor(actor)) continue;
    await removePainLordSourceFromActorEffects(actor, { sourceActorUuid, abilityItemId });
  }
}

/** Refresh presentation/settings retained in effects after editing the fixed function. */
export async function reconcilePainLordEffectsForAbilityItem(item) {
  if (item?.type !== "ability" || !item.parent) return;
  const contexts = findPainLordAbilityContexts(item.parent)
    .filter(context => String(context.abilityItem.id ?? "") === String(item.id ?? ""));
  if (!contexts.length) {
    await cleanupPainLordEffectsForAbilityItem(item);
    return;
  }

  const contextsByFunctionId = new Map(contexts.map(context => [
    String(context.abilityFunction.id ?? ""),
    context
  ]));
  for (const actor of getKnownActors()) {
    if (!canManageActor(actor)) continue;
    await reconcilePainLordActorEffects(actor, item.parent.uuid, item.id, contextsByFunctionId);
  }
}

export async function cleanupPainLordEffectsForSourceActor(actor) {
  const sourceActorUuid = String(actor?.uuid ?? "");
  if (!sourceActorUuid) return;
  for (const candidate of getKnownActors()) {
    if (!canManageActor(candidate)) continue;
    await removePainLordSourceFromActorEffects(candidate, { sourceActorUuid });
  }
}

export function getPainLordAbilityProgressEntry(abilityItem, abilityFunction) {
  const effect = findPainLordOverflowEffect(abilityItem?.parent, {
    sourceActorUuid: abilityItem?.parent?.uuid,
    abilityItemId: abilityItem?.id,
    functionId: abilityFunction?.id
  });
  const state = getPainLordOverflowData(effect);
  if (!state || !isPainLordOverflowEffectActive(effect)) {
    return {
      key: `${String(abilityFunction?.id ?? "")}:${ABILITY_FIXED_FUNCTION_KEYS.painLord}`,
      label: "Избыток Энергии",
      value: "нет"
    };
  }
  const settings = normalizePainLordSettings(state.settings ?? abilityFunction?.fixedSettings);
  const accumulation = calculatePainLordAccumulation(
    state.accumulatedOverflow,
    settings.overflowEnergyPerPercent,
    settings.overflowMaxPercent
  );
  return {
    key: `${String(abilityFunction?.id ?? "")}:${ABILITY_FIXED_FUNCTION_KEYS.painLord}`,
    label: "Избыток Энергии",
    value: `${formatNumber(accumulation.raw)} / ${formatNumber(accumulation.maximumRaw)} · урон +${formatNumber(accumulation.percent)}%`
  };
}

function collectPainLordDamageBatches(results = []) {
  const victims = new Map();
  for (const result of Array.from(results ?? []).flat(Infinity).filter(Boolean)) {
    if (result.mode && result.mode !== "damage") continue;
    const actor = resolveDamageResultActor(result);
    const damage = Math.max(0, Number(result.healthDelta) || 0);
    if (!actor?.uuid || damage <= 0 || isPhantomEntity(actor)) continue;

    const batch = victims.get(actor.uuid) ?? {
      actor,
      damage: 0,
      offenders: new Map()
    };
    batch.damage += damage;
    victims.set(actor.uuid, batch);

    const sourceEntries = Array.isArray(result.sourceDamageEntries) && result.sourceDamageEntries.length
      ? result.sourceDamageEntries
      : [{ source: result.source, damage }];
    for (const entry of sourceEntries) {
      const offender = resolveDamageSourceActor(entry?.source);
      const offenderDamage = Math.max(0, Number(entry?.damage) || 0);
      if (!offender?.uuid || offender.uuid === actor.uuid || offenderDamage <= 0 || isPhantomEntity(offender)) continue;
      batch.offenders.set(offender.uuid, (batch.offenders.get(offender.uuid) ?? 0) + offenderDamage);
    }
  }
  return { victims };
}

function findPainLordAbilityContext(actor) {
  return findPainLordAbilityContexts(actor)[0] ?? null;
}

function findPainLordAbilityContexts(actor) {
  const contexts = [];
  const abilityItems = actor?.itemTypes?.ability
    ?? Array.from(actor?.items ?? []).filter(item => item?.type === "ability");
  for (const abilityItem of abilityItems) {
    for (const abilityFunction of normalizeAbilityFunctions(abilityItem.system?.functions ?? [])) {
      if (
        abilityFunction.type !== ABILITY_FUNCTION_TYPES.fixed
        || abilityFunction.fixedKey !== ABILITY_FIXED_FUNCTION_KEYS.painLord
      ) continue;
      contexts.push({
        actor,
        abilityItem,
        abilityFunction,
        settings: normalizePainLordSettings(abilityFunction.fixedSettings)
      });
    }
  }
  return contexts;
}

async function addPainLordOverflow(actor, context, overflow = 0) {
  const amount = Math.max(0, Number(overflow) || 0);
  if (!amount) return null;
  const existing = findPainLordOverflowEffect(actor, getPainLordSourceIdentity(context));
  const previous = getPainLordOverflowData(existing);
  const previousAccumulation = isPainLordOverflowEffectActive(existing)
    ? Number(previous?.accumulatedOverflow) || 0
    : 0;
  const accumulation = calculatePainLordAccumulation(
    previousAccumulation + amount,
    context.settings.overflowEnergyPerPercent,
    context.settings.overflowMaxPercent
  );
  const now = getWorldTime();
  const metadata = {
    ...getPainLordSourceIdentity(context),
    accumulatedOverflow: accumulation.raw,
    settings: context.settings
  };
  const effectData = buildPainLordOverflowEffectData(actor, context, metadata, accumulation, now);
  return upsertPainLordEffect(actor, existing, effectData, effect => (
    Boolean(getPainLordOverflowData(effect))
  ));
}

async function addPainLordMarkContributions(actor, additions = []) {
  if (!additions.length) return null;
  const effects = findPainLordMarkEffects(actor);
  const existing = effects[0] ?? null;
  const current = normalizePainLordMarkData(getPainLordMarkData(existing));
  const contributors = [...current.contributors];

  for (const addition of additions) {
    const identity = getPainLordSourceIdentity(addition.context);
    const id = getPainLordSourceId(identity);
    const index = contributors.findIndex(entry => getPainLordSourceId(entry) === id);
    const previous = index >= 0 ? contributors[index] : null;
    const settings = addition.context.settings;
    const accumulation = calculatePainLordAccumulation(
      (Number(previous?.accumulatedDamage) || 0) + Math.max(0, Number(addition.damage) || 0),
      settings.offenderDamagePerPercent,
      settings.offenderMaxPercent
    );
    const next = {
      ...identity,
      accumulatedDamage: accumulation.raw,
      settings: {
        offenderDamagePerPercent: settings.offenderDamagePerPercent,
        offenderMaxPercent: settings.offenderMaxPercent
      }
    };
    if (index >= 0) contributors[index] = next;
    else contributors.push(next);
  }

  const presentation = calculatePainLordMarkPresentation(contributors);
  const effectData = buildPainLordMarkEffectData(
    actor,
    contributors,
    presentation,
    additions.at(-1)?.context,
    existing
  );
  const effect = await upsertPainLordEffect(actor, existing, effectData, candidate => (
    Boolean(getPainLordMarkData(candidate))
  ));
  const duplicateIds = effects.slice(1).map(candidate => candidate.id).filter(Boolean);
  if (duplicateIds.length) await safelyDeleteEffects(actor, duplicateIds);
  return effect;
}

function buildPainLordOverflowEffectData(actor, context, metadata, accumulation, worldTime) {
  const percent = accumulation.percent;
  return {
    type: "base",
    name: PAIN_LORD_OVERFLOW_EFFECT_NAME,
    img: context.abilityItem.img || actor.img || "icons/svg/upgrade.svg",
    description: `Накоплено избытка Энергии: ${formatNumber(accumulation.raw)} / ${formatNumber(accumulation.maximumRaw)}.`,
    origin: context.abilityItem.uuid ?? actor.uuid,
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    start: { time: worldTime },
    duration: {
      value: context.settings.overflowDurationSeconds,
      units: "seconds",
      expiry: null,
      expired: false
    },
    system: {
      changes: percent > 0 ? [createPercentChange(DAMAGE_PERCENT_EFFECT_KEY, percent)] : []
    },
    flags: {
      [SYSTEM_ID]: {
        kind: "temporary",
        [PAIN_LORD_OVERFLOW_EFFECT_FLAG_KEY]: metadata
      }
    }
  };
}

function buildPainLordMarkEffectData(actor, contributors, presentation, context = null, existingEffect = null) {
  const remainingOrigin = contributors.find(entry => String(entry?.abilityItemUuid ?? "").trim())?.abilityItemUuid;
  return {
    type: "base",
    name: PAIN_LORD_MARK_EFFECT_NAME,
    img: context?.abilityItem?.img || existingEffect?.img || actor.img || "icons/svg/blood.svg",
    description: "",
    origin: context?.abilityItem?.uuid || remainingOrigin || existingEffect?.origin || actor.uuid,
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    start: null,
    duration: { value: null, units: "seconds", expiry: null, expired: false },
    system: {
      changes: presentation.percent > 0
        ? [createPercentChange(INCOMING_DAMAGE_PERCENT_EFFECT_KEY, presentation.percent)]
        : []
    },
    flags: {
      [SYSTEM_ID]: {
        kind: "temporary",
        [PAIN_LORD_MARK_EFFECT_FLAG_KEY]: { contributors }
      }
    }
  };
}

function createPercentChange(key, percent) {
  return {
    key,
    type: "add",
    value: String(formatNumber(percent)),
    phase: "initial",
    priority: null
  };
}

function calculatePainLordMarkPresentation(contributors = []) {
  let raw = 0;
  let percent = 0;
  let maximumPercent = 0;
  for (const contributor of contributors) {
    const settings = normalizePainLordContributorSettings(contributor?.settings);
    const accumulation = calculatePainLordAccumulation(
      contributor?.accumulatedDamage,
      settings.offenderDamagePerPercent,
      settings.offenderMaxPercent
    );
    raw += accumulation.raw;
    percent += accumulation.percent;
    maximumPercent = Math.max(maximumPercent, settings.offenderMaxPercent);
  }
  return {
    raw,
    percent: Math.min(maximumPercent, percent),
    maximumPercent
  };
}

async function upsertPainLordEffect(actor, existing, effectData, replacementPredicate) {
  if (!existing) {
    const [created] = await actor.createEmbeddedDocuments("ActiveEffect", [effectData], { animate: false });
    return created ?? null;
  }
  try {
    await existing.update(effectData, { animate: false });
    return existing;
  } catch (error) {
    if (!isMissingEffectError(error)) throw error;
    const replacement = Array.from(actor?.effects ?? []).find(effect => replacementPredicate(effect));
    if (replacement && replacement !== existing) {
      await replacement.update(effectData, { animate: false });
      return replacement;
    }
    const [created] = await actor.createEmbeddedDocuments("ActiveEffect", [effectData], { animate: false });
    return created ?? null;
  }
}

async function removePainLordSourceFromActorEffects(actor, identity = {}) {
  const deleteIds = [];
  for (const effect of Array.from(actor?.effects ?? [])) {
    const overflow = getPainLordOverflowData(effect);
    if (overflow && painLordIdentityMatches(overflow, identity)) {
      if (effect.id) deleteIds.push(effect.id);
      continue;
    }

    const mark = getPainLordMarkData(effect);
    if (!mark) continue;
    const contributors = normalizePainLordMarkData(mark).contributors
      .filter(entry => !painLordIdentityMatches(entry, identity));
    if (!contributors.length) {
      if (effect.id) deleteIds.push(effect.id);
      continue;
    }
    if (contributors.length === normalizePainLordMarkData(mark).contributors.length) continue;
    const presentation = calculatePainLordMarkPresentation(contributors);
    await effect.update(buildPainLordMarkEffectData(actor, contributors, presentation, null, effect), { animate: false });
  }
  if (deleteIds.length) await safelyDeleteEffects(actor, deleteIds);
}

async function reconcilePainLordActorEffects(actor, sourceActorUuid, abilityItemId, contextsByFunctionId) {
  const deleteIds = [];
  for (const effect of Array.from(actor?.effects ?? [])) {
    const overflow = getPainLordOverflowData(effect);
    if (overflow && painLordIdentityMatches(overflow, { sourceActorUuid, abilityItemId })) {
      const context = contextsByFunctionId.get(String(overflow.functionId ?? ""));
      if (!context || !isPainLordOverflowEffectActive(effect)) {
        if (effect.id) deleteIds.push(effect.id);
        continue;
      }
      const accumulation = calculatePainLordAccumulation(
        overflow.accumulatedOverflow,
        context.settings.overflowEnergyPerPercent,
        context.settings.overflowMaxPercent
      );
      const metadata = {
        ...getPainLordSourceIdentity(context),
        accumulatedOverflow: accumulation.raw,
        settings: context.settings
      };
      await effect.update(buildPainLordOverflowEffectData(
        actor,
        context,
        metadata,
        accumulation,
        Number(effect.start?.time) || getWorldTime()
      ), { animate: false });
      continue;
    }

    const mark = getPainLordMarkData(effect);
    if (!mark) continue;
    let changed = false;
    let presentationContext = null;
    const contributors = [];
    for (const contributor of normalizePainLordMarkData(mark).contributors) {
      if (!painLordIdentityMatches(contributor, { sourceActorUuid, abilityItemId })) {
        contributors.push(contributor);
        continue;
      }
      const context = contextsByFunctionId.get(String(contributor.functionId ?? ""));
      if (!context) {
        changed = true;
        continue;
      }
      const accumulation = calculatePainLordAccumulation(
        contributor.accumulatedDamage,
        context.settings.offenderDamagePerPercent,
        context.settings.offenderMaxPercent
      );
      contributors.push({
        ...getPainLordSourceIdentity(context),
        accumulatedDamage: accumulation.raw,
        settings: {
          offenderDamagePerPercent: context.settings.offenderDamagePerPercent,
          offenderMaxPercent: context.settings.offenderMaxPercent
        }
      });
      presentationContext ??= context;
      changed = true;
    }
    if (!changed) continue;
    if (!contributors.length) {
      if (effect.id) deleteIds.push(effect.id);
      continue;
    }
    const presentation = calculatePainLordMarkPresentation(contributors);
    await effect.update(buildPainLordMarkEffectData(
      actor,
      contributors,
      presentation,
      presentationContext,
      effect
    ), { animate: false });
  }
  if (deleteIds.length) await safelyDeleteEffects(actor, deleteIds);
}

function findPainLordOverflowEffect(actor, identity = {}) {
  return Array.from(actor?.effects ?? []).find(effect => {
    const data = getPainLordOverflowData(effect);
    return data && painLordIdentityMatches(data, identity);
  }) ?? null;
}

function isPainLordOverflowEffectActive(effect, worldTime = getWorldTime()) {
  if (!effect || effect.disabled || effect.active === false || effect.duration?.expired === true) return false;
  const durationValue = Number(effect.duration?.value ?? effect.duration?.seconds);
  if (!(durationValue > 0)) return true;
  const startTime = Number(effect.start?.time ?? effect.duration?.startTime);
  if (!Number.isFinite(startTime)) return true;
  return worldTime < (startTime + durationValue);
}

function findPainLordMarkEffects(actor) {
  return Array.from(actor?.effects ?? []).filter(effect => Boolean(getPainLordMarkData(effect)));
}

function getPainLordOverflowData(effect) {
  return readEffectFlag(effect, PAIN_LORD_OVERFLOW_EFFECT_FLAG_KEY);
}

function getPainLordMarkData(effect) {
  return readEffectFlag(effect, PAIN_LORD_MARK_EFFECT_FLAG_KEY);
}

function readEffectFlag(effect, key) {
  return effect?.getFlag?.(SYSTEM_ID, key)
    ?? effect?.flags?.[SYSTEM_ID]?.[key]
    ?? effect?._source?.flags?.[SYSTEM_ID]?.[key]
    ?? null;
}

function normalizePainLordMarkData(value = {}) {
  return {
    contributors: Array.from(value?.contributors ?? [])
      .filter(entry => entry && typeof entry === "object")
      .map(entry => ({ ...entry }))
  };
}

function normalizePainLordContributorSettings(value = {}) {
  return {
    offenderDamagePerPercent: Math.max(0.01, Number(value?.offenderDamagePerPercent) || 5),
    offenderMaxPercent: Math.max(0, Number(value?.offenderMaxPercent) || 0)
  };
}

function getPainLordSourceIdentity(context = {}) {
  return {
    sourceActorUuid: String(context.actor?.uuid ?? context.abilityItem?.parent?.uuid ?? ""),
    abilityItemId: String(context.abilityItem?.id ?? ""),
    abilityItemUuid: String(context.abilityItem?.uuid ?? ""),
    functionId: String(context.abilityFunction?.id ?? ""),
    fixedKey: ABILITY_FIXED_FUNCTION_KEYS.painLord
  };
}

function getPainLordSourceId(identity = {}) {
  return [identity.sourceActorUuid, identity.abilityItemId, identity.functionId]
    .map(value => String(value ?? ""))
    .join("::");
}

function painLordIdentityMatches(candidate = {}, expected = {}) {
  return ["sourceActorUuid", "abilityItemId", "functionId"].every(key => {
    const value = String(expected?.[key] ?? "");
    return !value || String(candidate?.[key] ?? "") === value;
  });
}

function resolveDamageResultActor(result = {}) {
  const targetToken = resolveUuid(result?.source?.targetTokenUuid);
  return result?.actor
    ?? targetToken?.actor
    ?? resolveActorUuid(result?.actorUuid);
}

function resolveDamageSourceActor(source = {}) {
  const actorUuid = String(
    source?.attackerActorUuid
    ?? source?.attackerUuid
    ?? source?.sourceActorUuid
    ?? source?.actorUuid
    ?? ""
  ).trim();
  const actor = actorUuid ? resolveActorUuid(actorUuid) : null;
  if (actor) return actor;
  const tokenUuid = String(source?.attackerTokenUuid ?? source?.sourceTokenUuid ?? "").trim();
  return resolveUuid(tokenUuid)?.actor ?? null;
}

function resolveActorUuid(uuid = "") {
  const document = resolveUuid(uuid);
  return document?.documentName === "Token" ? document.actor : document;
}

function resolveUuid(uuid = "") {
  const value = String(uuid ?? "").trim();
  return value ? globalThis.fromUuidSync?.(value) ?? null : null;
}

function getKnownActors() {
  const actors = new Map();
  const add = actor => {
    const uuid = String(actor?.uuid ?? "");
    if (uuid && !isPhantomEntity(actor)) actors.set(uuid, actor);
  };
  for (const actor of game.actors?.contents ?? []) add(actor);
  for (const scene of game.scenes?.contents ?? []) {
    for (const token of scene.tokens ?? []) add(token?.actor);
  }
  for (const token of globalThis.canvas?.tokens?.placeables ?? []) add(token?.actor);
  return actors.values();
}

function canManageActor(actor) {
  return Boolean(actor && (game.user?.isGM || actor.isOwner));
}

async function safelyDeleteEffects(actor, ids = []) {
  try {
    await actor.deleteEmbeddedDocuments("ActiveEffect", [...new Set(ids)], { animate: false });
  } catch (error) {
    if (!isMissingEffectError(error)) throw error;
  }
}

function isMissingEffectError(error) {
  return /does not exist|not found|deleted/i.test(String(error?.message ?? error ?? ""));
}

function getWorldTime() {
  return Math.max(0, Number(globalThis.game?.time?.worldTime) || 0);
}

function formatNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "0";
  return Number.isInteger(numeric)
    ? String(numeric)
    : String(Math.round(numeric * 100) / 100);
}
