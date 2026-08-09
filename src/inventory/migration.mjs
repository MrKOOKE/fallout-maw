import { getCreatureOptions } from "../settings/accessors.mjs";
import { executeInventoryMutation } from "./mutation.mjs";
import { planActorInventoryRepair } from "./repair.mjs";
import { INVENTORY_ATOMIC_OPTION } from "./constants.mjs";
import {
  createdItemRequiresInventoryRepair,
  isInventoryRelevantActorPath
} from "./repair-triggers.mjs";

const INVENTORY_REPAIR_REASON = "inventory-repair";
let hooksRegistered = false;
let repairQueueRunning = false;
const queuedActors = new Map();

/**
 * Register lightweight guards for documents which may enter the world outside
 * the normal inventory surfaces. The full-world repair remains an explicit
 * migration tool and is never scanned on every ready hook.
 */
export function registerInventoryRepairHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;

  Hooks.on("createItem", (item, options = {}) => {
    if (isRepairOperation(options) || !createdItemRequiresInventoryRepair(item, options)) return;
    queueInventoryRepair(item?.parent);
  });
  Hooks.on("updateItem", (item, changes = {}, options = {}) => {
    if (
      isRepairOperation(options)
      || options?.[INVENTORY_ATOMIC_OPTION] === true
      || !isInventoryRelevantItemUpdate(changes)
    ) return;
    queueInventoryRepair(item?.parent);
  });
  Hooks.on("updateActor", (actor, changes = {}, options = {}) => {
    if (isRepairOperation(options) || !isInventoryRelevantActorUpdate(changes)) return;
    queueInventoryRepair(actor);
  });
  Hooks.on("createActor", actor => queueInventoryRepair(actor));
  Hooks.on("createToken", token => queueInventoryRepair(token?.actor));
  Hooks.on("updateToken", (token, changes = {}, options = {}) => {
    if (isRepairOperation(options) || !changesActorIdentity(changes)) return;
    queueInventoryRepair(token?.actor);
  });
}

/**
 * Repair every world and synthetic-token Actor for which this client is the
 * elected authority. Failures are isolated per Actor so one damaged document
 * cannot prevent the rest of the world from loading.
 */
export async function repairWorldInventories() {
  const actors = collectWorldInventoryActors();
  const results = [];
  const failures = [];

  for (const actor of actors) {
    if (!isCurrentUserRepairAuthority(actor)) continue;
    try {
      const result = await repairActorInventory(actor, {
        automatic: true,
        render: false
      });
      if (result.changed) results.push(result);
    } catch (error) {
      failures.push({ actor, error });
      console.error(`Fallout MaW | Failed to repair inventory for ${actor?.uuid ?? actor?.id}.`, error);
    }
  }

  if (results.length) {
    console.info(
      `Fallout MaW | Repaired ${results.length} Actor inventories`
      + ` (${results.reduce((total, result) => total + result.updates.length, 0)} Items).`
    );
  }
  return { repaired: results, failures };
}

/**
 * Plan and commit one deterministic inventory repair.
 */
export async function repairActorInventory(actor, {
  automatic = false,
  race = null,
  render = true
} = {}) {
  if (actor?.documentName !== "Actor") {
    return { actor, changed: false, updates: [], repairs: [] };
  }
  if (automatic && !isCurrentUserRepairAuthority(actor)) {
    return { actor, changed: false, updates: [], repairs: [] };
  }

  const expectedItems = Array.from(actor.items ?? [], item => (
    foundry.utils.deepClone(item?.toObject?.() ?? item)
  ));
  const resolvedRace = race ?? getActorRace(actor);
  const plan = await planActorInventoryRepair(actor, resolvedRace, {
    items: expectedItems
  });
  if (!plan.updates.length) {
    return { actor, changed: false, ...plan };
  }

  await executeInventoryMutation({
    actor,
    updates: plan.updates,
    expectedItems
  }, {
    validateLoad: false,
    render,
    reason: INVENTORY_REPAIR_REASON
  });
  return { actor, changed: true, ...plan };
}

export function collectWorldInventoryActors() {
  const actors = new Map();
  const addActor = actor => {
    if (actor?.documentName !== "Actor") return;
    const key = String(actor.uuid ?? actor.id ?? "");
    if (key) actors.set(key, actor);
  };

  for (const actor of game.actors?.contents ?? game.actors ?? []) addActor(actor);
  for (const scene of game.scenes?.contents ?? game.scenes ?? []) {
    for (const token of scene.tokens?.contents ?? scene.tokens ?? []) addActor(token.actor);
  }
  return Array.from(actors.values())
    .sort((left, right) => String(left.uuid ?? left.id).localeCompare(String(right.uuid ?? right.id)));
}

function queueInventoryRepair(actor) {
  if (actor?.documentName !== "Actor" || !isCurrentUserRepairAuthority(actor)) return;
  const key = String(actor.uuid ?? actor.id ?? "");
  if (!key) return;
  queuedActors.set(key, actor);
  if (repairQueueRunning) return;

  repairQueueRunning = true;
  queueMicrotask(() => {
    void flushInventoryRepairQueue();
  });
}

async function flushInventoryRepairQueue() {
  try {
    while (queuedActors.size) {
      const actors = Array.from(queuedActors.values());
      queuedActors.clear();
      for (const actor of actors) {
        try {
          await repairActorInventory(actor, { automatic: true });
        } catch (error) {
          console.error(`Fallout MaW | Automatic inventory repair failed for ${actor?.uuid ?? actor?.id}.`, error);
        }
      }
    }
  } finally {
    repairQueueRunning = false;
    if (queuedActors.size) queueInventoryRepair(queuedActors.values().next().value);
  }
}

function getActorRace(actor) {
  const raceId = String(actor?.system?.creature?.raceId ?? "");
  return getCreatureOptions().races.find(entry => String(entry.id) === raceId) ?? null;
}

function changesActorIdentity(changes = {}) {
  return (
    Object.hasOwn(changes, "actorId")
    || Object.hasOwn(changes, "actorLink")
    || Object.hasOwn(changes, "delta")
  );
}

function isInventoryRelevantItemUpdate(changes = {}) {
  const paths = Object.keys(foundry.utils.flattenObject(changes ?? {}));
  return paths.some(path => (
    path === "type"
    || path.startsWith("system.container")
    || path.startsWith("system.equipped")
    || path.startsWith("system.functions.container")
    || path.startsWith("system.functions.constructPart")
    || path.startsWith("system.itemFunction")
    || path.startsWith("system.locked")
    || path.startsWith("system.maxStack")
    || path.startsWith("system.placement")
    || path.startsWith("system.quantity")
    || path.startsWith("system.stackParts")
    || path.startsWith("system.occupiedSlotMode")
    || path.startsWith("system.occupiedSlots")
    || path.startsWith("system.weaponSlotRequirement")
    || path.startsWith("system.weight")
  ));
}

export function isInventoryRelevantActorUpdate(changes = {}) {
  const paths = Object.keys(foundry.utils.flattenObject(changes ?? {}));
  return paths.some(isInventoryRelevantActorPath);
}

function isRepairOperation(options = {}) {
  return (
    options.falloutMawInventoryReason === INVENTORY_REPAIR_REASON
    || options.falloutMawInventoryRecovery === true
  );
}

function isCurrentUserRepairAuthority(actor) {
  const currentUser = game.user;
  if (!currentUser?.active) return false;

  const users = Array.from(game.users?.contents ?? game.users ?? []);
  const activeGM = game.users?.activeGM ?? users
    .filter(user => user.active && user.isGM)
    .sort(compareUsers)[0] ?? null;
  if (activeGM) return activeGM.id === currentUser.id;

  const owners = users
    .filter(user => user.active && actor.testUserPermission?.(user, "OWNER"))
    .sort(compareUsers);
  return owners[0]?.id === currentUser.id;
}

function compareUsers(left, right) {
  return String(left?.id ?? "").localeCompare(String(right?.id ?? ""));
}
