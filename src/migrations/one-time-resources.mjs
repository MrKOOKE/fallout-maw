import { SYSTEM_ID } from "../constants.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { runOneTimeResourceMutation } from "../combat/one-time-resources.mjs";

export const LEGACY_ONE_TIME_MIGRATION_FLAG = "legacyOneTimeResourceMigration";
const LEGACY_REACTION_FLAG = "oneTimeReactionPoints";
const LEGACY_ACTION_FLAG = "oneTimeActionPoints";
const MIGRATION_OPTION = "falloutMawOneTimeResourceMigration";
const KEY_PATTERN = /^system\.resources\.(actionPoints|reactionPoints|dodge)\.once$/;
const CONVERSION_FLAGS = { reactionPoints: "reactionPointsConversion", dodge: "reactionDodgeConversion" };
let hooksRegistered = false;

/**
 * Persist the balance and its migration receipt in the same Actor update before
 * removing legacy effects. A canceled cleanup can then be retried without
 * granting points twice, including after a client restart.
 */
export function migrateActorOneTimeResources(actor) {
  if (!actor || !["character", "construct"].includes(actor.type)) return Promise.resolve(false);
  return runOneTimeResourceMutation(actor, () => migrateActorNow(actor));
}

export async function migrateWorldOneTimeResources() {
  registerMigrationHooks();
  if (!globalThis.game?.user?.isActiveGM) return { migrated: 0, failed: 0 };
  const actors = new Map();
  for (const actor of game.actors?.contents ?? []) actors.set(actor.uuid, actor);
  for (const scene of game.scenes?.contents ?? []) {
    for (const token of scene.tokens?.contents ?? scene.tokens ?? []) {
      if (!token.actorLink && token.actor) actors.set(token.actor.uuid, token.actor);
    }
  }
  const result = { migrated: 0, failed: 0 };
  for (const actor of actors.values()) {
    try { if (await migrateActorOneTimeResources(actor)) result.migrated += 1; }
    catch (error) {
      result.failed += 1;
      console.error(`${SYSTEM_ID} | One-time resource migration failed for ${actor.uuid}`, error);
    }
  }
  return result;
}

/** Pure plan over persisted source rows; prepared rows can contain Documents. */
export function buildLegacyOneTimeResourceMigration(actor) {
  const source = getSource(actor);
  const flags = clone(source.flags?.[SYSTEM_ID] ?? {});
  const receipt = clone(flags[LEGACY_ONE_TIME_MIGRATION_FLAG] ?? { version: 1, effects: {} });
  receipt.effects ??= {};
  const grants = { actionPoints: 0, reactionPoints: 0, dodge: 0 };
  const conversionTotals = { reactionPoints: 0, dodge: 0 };
  const effects = [];
  let receiptChanged = false;
  for (const effect of actor.effects?.contents ?? actor.effects ?? []) {
    const data = getSource(effect);
    const rows = Array.from(data.system?.changes ?? []);
    const legacyRows = rows.filter(row => getLegacyResourceKey(row, data));
    if (!legacyRows.length) continue;
    // Dormant effects were not spendable. Preserve them until activation, when
    // the updateActiveEffect hook can migrate their newly available balance.
    if (effect.disabled || effect.active === false || effect.isSuppressed) continue;
    const id = String(effect.id ?? data._id ?? "");
    if (!id) continue;
    effects.push({ effect, id, changes: clone(rows.filter(row => !getLegacyResourceKey(row, data))) });
    if (Object.hasOwn(receipt.effects, id)) continue;
    const granted = { actionPoints: 0, reactionPoints: 0, dodge: 0 };
    for (const row of legacyRows) {
      const resource = getLegacyResourceKey(row, data);
      const amount = Math.max(0, toInteger(row.value));
      if (String(row.key).endsWith(".bonus")) conversionTotals[resource] += amount;
      else granted[resource] += amount;
    }
    grants.actionPoints += granted.actionPoints;
    grants.reactionPoints += granted.reactionPoints;
    grants.dodge += granted.dodge;
    receipt.effects[id] = { rows: clone(legacyRows), granted };
    receiptChanged = true;
  }
  const hasLegacyReactionFlag = Object.hasOwn(flags, LEGACY_REACTION_FLAG);
  if (hasLegacyReactionFlag) {
    const amount = Math.max(0, toInteger(flags[LEGACY_REACTION_FLAG]));
    grants.reactionPoints += amount;
    receipt.reactionFlagAmount = Math.max(0, toInteger(receipt.reactionFlagAmount)) + amount;
    delete flags[LEGACY_REACTION_FLAG];
    receiptChanged = true;
  }
  const updates = {};
  if (receiptChanged) {
    for (const [key, amount] of Object.entries(conversionTotals)) {
      if (!amount) continue;
      const resource = actor.system?.resources?.[key] ?? {};
      const baseMax = Math.max(0, toInteger(resource.max) - amount);
      const current = Math.max(0, toInteger(resource.value));
      const once = Math.min(amount, Math.max(0, current - baseMax));
      const normal = Math.min(baseMax, current - once);
      grants[key] += once;
      updates[`system.resources.${key}.value`] = normal;
      updates[`system.resources.${key}.spent`] = Math.max(0, baseMax - normal);
      receipt.conversions ??= {};
      receipt.conversions[key] = { amount, once, normal, baseMax };
    }
    updates[`flags.${SYSTEM_ID}.${LEGACY_ONE_TIME_MIGRATION_FLAG}`] = receipt;
    if (hasLegacyReactionFlag) updates[`flags.${SYSTEM_ID}.-=${LEGACY_REACTION_FLAG}`] = null;
    for (const [key, grant] of Object.entries(grants)) {
      if (!grant) continue;
      updates[`system.resources.${key}.once`] = Math.max(0, toInteger(source.system?.resources?.[key]?.once)) + grant;
    }
  }
  return { updates, effects, receipt, changed: receiptChanged || effects.length > 0 };
}

async function migrateActorNow(actor) {
  const plan = buildLegacyOneTimeResourceMigration(actor);
  if (!plan.changed) return false;
  const options = { [MIGRATION_OPTION]: true, falloutMawDocumentMigration: true,
    falloutMawReactionResourceUpdate: true, render: false };
  if (Object.keys(plan.updates).length) {
    await actor.update(plan.updates, { ...options });
    for (const [path, expected] of Object.entries(plan.updates)) {
      const actual = getPath(getSource(actor), path.replace(".-=", "."));
      if (path.includes(".-=") ? actual !== undefined : !equal(actual, expected)) {
        throw new Error("One-time resource migration balance/receipt update was canceled or changed.");
      }
    }
  }
  for (const { effect, id, changes } of plan.effects) {
    const current = actor.effects?.get?.(id) ?? Array.from(actor.effects?.contents ?? actor.effects ?? []).find(entry => entry.id === id);
    if (current !== effect) continue;
    const data = getSource(current);
    const currentRows = Array.from(data.system?.changes ?? []);
    const expectedRows = [...changes, ...plan.receipt.effects[id]?.rows ?? []];
    if (currentRows.length !== expectedRows.length || !equal(
      currentRows.filter(row => !getLegacyResourceKey(row, data)), changes
    ) || !equal(currentRows.filter(row => getLegacyResourceKey(row, data)), plan.receipt.effects[id]?.rows)) {
      throw new Error("Legacy one-time effect changed during migration; receipt retained for review.");
    }
    if (canDeleteLegacyEffect(data, changes)) {
      await actor.deleteEmbeddedDocuments("ActiveEffect", [id], { ...options });
    } else {
      const updates = { "system.changes": changes };
      for (const flag of [LEGACY_ACTION_FLAG, ...Object.values(CONVERSION_FLAGS)]) {
        if (Object.hasOwn(data.flags?.[SYSTEM_ID] ?? {}, flag)) updates[`flags.${SYSTEM_ID}.-=${flag}`] = null;
      }
      await current.update(updates, { ...options });
    }
    const after = actor.effects?.get?.(id) ?? Array.from(actor.effects?.contents ?? actor.effects ?? []).find(entry => entry.id === id);
    if (after && Array.from(getSource(after).system?.changes ?? []).some(row => getLegacyResourceKey(row, getSource(after)))) {
      throw new Error("Legacy one-time effect cleanup was canceled; persisted receipt prevents duplicate grants.");
    }
  }
  return true;
}

function canDeleteLegacyEffect(data, changes) {
  if (changes.length || Array.from(data.statuses ?? []).length) return false;
  const flags = data.flags?.[SYSTEM_ID] ?? {};
  return Boolean(flags[LEGACY_ACTION_FLAG] || Object.values(CONVERSION_FLAGS).some(key => flags[key]))
    && Object.keys(data.flags ?? {}).every(key => key === SYSTEM_ID)
    && Object.keys(flags).every(key => ["kind", LEGACY_ACTION_FLAG, ...Object.values(CONVERSION_FLAGS)].includes(key));
}

function getLegacyResourceKey(row, data) {
  const key = String(row?.key ?? "");
  const once = KEY_PATTERN.exec(key);
  if (once) return once[1];
  for (const [resource, flag] of Object.entries(CONVERSION_FLAGS)) {
    if (data.flags?.[SYSTEM_ID]?.[flag] && key === `system.resources.${resource}.bonus`) return resource;
  }
  return "";
}

/** A receipt makes old bonus rows inert even if effect cleanup was canceled. */
export function isMigratedOneTimeResourceChange(actor, effect, change) {
  const id = String(effect?.id ?? effect?._id ?? "");
  const rows = getSource(actor).flags?.[SYSTEM_ID]?.[LEGACY_ONE_TIME_MIGRATION_FLAG]?.effects?.[id]?.rows;
  return Array.isArray(rows) && rows.some(row => (
    String(row?.key ?? "") === String(change?.key ?? "")
    && String(row?.value ?? "") === String(change?.value ?? "")
    && String(row?.type ?? "add") === String(change?.type ?? "add")
    && String(row?.phase ?? "initial") === String(change?.phase ?? "initial")
  ));
}

function registerMigrationHooks() {
  if (hooksRegistered || !globalThis.Hooks?.on) return;
  hooksRegistered = true;
  const schedule = (actor, options = {}) => {
    if (!game.user?.isActiveGM || options[MIGRATION_OPTION]) return;
    void migrateActorOneTimeResources(actor).catch(error => {
      console.error(`${SYSTEM_ID} | Imported one-time resource migration failed for ${actor?.uuid}`, error);
    });
  };
  Hooks.on("createActor", (actor, options) => schedule(actor, options));
  Hooks.on("createToken", (token, options) => { if (!token.actorLink) schedule(token.actor, options); });
  Hooks.on("updateActor", (actor, changes, options) => {
    if (Object.keys(changes ?? {}).some(path => path === "effects" || path === "flags" || path.startsWith(`flags.${SYSTEM_ID}`))) schedule(actor, options);
  });
  Hooks.on("updateActiveEffect", (effect, _changes, options) => {
    if (effect.parent?.documentName === "Actor") schedule(effect.parent, options);
  });
  // Removing a suppressing effect can reactivate a different legacy effect
  // without publishing updateActiveEffect for that newly active document.
  for (const event of ["createActiveEffect", "deleteActiveEffect"]) Hooks.on(event, (effect, options) => {
    if (effect.parent?.documentName === "Actor") schedule(effect.parent, options);
  });
}

function getSource(document) { return document?._source ?? document?.toObject?.() ?? document ?? {}; }
function clone(value) { return globalThis.foundry?.utils?.deepClone?.(value) ?? structuredClone(value); }
function equal(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function getPath(object, path) { return path.split(".").reduce((value, key) => value?.[key], object); }
