// Очистка оружия мира: оставить только основную оружейную функцию и выставить ближним атакам конус 120 градусов.
// Запускать GM-ом из Foundry Macro. Меняет мировые предметы, предметы актеров и мировые паки Item/Actor.

const SYSTEM_ID = "fallout-maw";
const MELEE_CONE_DEGREES = 120;

if (game.system.id !== SYSTEM_ID) {
  ui.notifications.error("Этот макрос рассчитан только на систему fallout-maw.");
  return;
}

if (!game.user?.isGM) {
  ui.notifications.error("Макрос должен запускать GM.");
  return;
}

const stats = {
  scanned: 0,
  updatedItems: 0,
  removedAdditionalWeaponFunctions: 0,
  cleanedModuleWeaponFunctions: 0,
  meleeConeUpdates: 0,
  skippedPacks: 0,
  errors: 0
};

const changedItems = [];
const errors = [];

for (const item of game.items.contents) {
  await updateItemDocument(item, "world item");
}

for (const actor of game.actors.contents) {
  await updateActorItems(actor, "world actor");
}

for (const pack of game.packs) {
  if (!isWorldPack(pack)) continue;
  if (!["Item", "Actor"].includes(pack.documentName)) continue;

  const wasLocked = Boolean(pack.locked);
  try {
    if (wasLocked) await pack.configure({ locked: false });
    const documents = await pack.getDocuments();
    if (pack.documentName === "Item") {
      for (const item of documents) {
        await updateItemDocument(item, `pack ${pack.collection}`);
      }
    } else {
      for (const actor of documents) {
        await updateActorItems(actor, `pack ${pack.collection}`);
      }
    }
  } catch (error) {
    stats.errors += 1;
    errors.push({ scope: `pack ${pack.collection}`, error });
    console.error("fallout-maw weapon cleanup pack failed", pack.collection, error);
  } finally {
    if (wasLocked) {
      try {
        await pack.configure({ locked: true });
      } catch (error) {
        stats.errors += 1;
        errors.push({ scope: `pack ${pack.collection} relock`, error });
        console.error("fallout-maw weapon cleanup pack relock failed", pack.collection, error);
      }
    }
  }
}

const message = [
  `Оружие очищено: обновлено ${stats.updatedItems}`,
  `удалено доп. функций ${stats.removedAdditionalWeaponFunctions}`,
  `очищено функций модулей ${stats.cleanedModuleWeaponFunctions}`,
  `конусов ближнего боя ${stats.meleeConeUpdates}`,
  `ошибок ${stats.errors}`
].join(", ");

ui.notifications.info(message);
console.log("fallout-maw weapon cleanup", { stats, changedItems, errors });

async function updateActorItems(actor, scope) {
  const updates = [];
  const changesByItemId = new Map();

  for (const item of actor.items.contents) {
    const result = buildItemUpdates(item);
    if (!result) continue;
    updates.push({ _id: item.id, ...result.updates });
    changesByItemId.set(item.id, result.changes);
  }

  if (!updates.length) return;

  try {
    await actor.updateEmbeddedDocuments("Item", updates);
    for (const update of updates) {
      const changes = changesByItemId.get(update._id) ?? {};
      recordUpdatedItem(actor.items.get(update._id), `${scope}: ${actor.name}`, changes);
    }
  } catch (error) {
    stats.errors += 1;
    errors.push({ scope: `${scope}: ${actor.name}`, error });
    console.error("fallout-maw weapon cleanup actor failed", actor.uuid, actor.name, error);
  }
}

async function updateItemDocument(item, scope) {
  const result = buildItemUpdates(item);
  if (!result) return;

  try {
    await item.update(result.updates);
    recordUpdatedItem(item, scope, result.changes);
  } catch (error) {
    stats.errors += 1;
    errors.push({ scope: `${scope}: ${item.name}`, error });
    console.error("fallout-maw weapon cleanup item failed", item.uuid, item.name, error);
  }
}

function buildItemUpdates(item) {
  stats.scanned += 1;
  if (item.type !== "gear") return null;

  const functions = item.system?.functions;
  const weapon = functions?.weapon;
  const additionalWeapons = functions?.additionalWeapons ?? {};
  if (!weapon?.enabled && !Object.keys(additionalWeapons).length) return null;

  const updates = {};
  const changes = {
    removedAdditionalWeaponFunctions: 0,
    cleanedModuleWeaponFunctions: 0,
    meleeConeUpdates: 0
  };

  const additionalKeys = Object.keys(additionalWeapons);
  if (additionalKeys.length) {
    updates["system.functions.additionalWeapons"] = {};
    for (const key of additionalKeys) {
      updates[`system.functions.additionalWeapons.-=${key}`] = null;
    }
    changes.removedAdditionalWeaponFunctions += additionalKeys.length;
  }

  if (weapon?.enabled && isMeleeWeaponFunction(weapon)) {
    if (weapon.attackConeDegrees !== MELEE_CONE_DEGREES) {
      updates["system.functions.weapon.attackConeDegrees"] = MELEE_CONE_DEGREES;
      changes.meleeConeUpdates += 1;
    }
    if (weapon.availableActions?.meleeAttack && weapon.meleeAttack?.attackConeDegrees !== MELEE_CONE_DEGREES) {
      updates["system.functions.weapon.meleeAttack.attackConeDegrees"] = MELEE_CONE_DEGREES;
      changes.meleeConeUpdates += 1;
    }
    if (weapon.availableActions?.aimedMeleeAttack && weapon.aimedMeleeAttack?.attackConeDegrees !== MELEE_CONE_DEGREES) {
      updates["system.functions.weapon.aimedMeleeAttack.attackConeDegrees"] = MELEE_CONE_DEGREES;
      changes.meleeConeUpdates += 1;
    }
  }

  const moduleSlotCleanup = cleanModuleSlotWeaponFunctions(weapon?.moduleSlots);
  if (moduleSlotCleanup.changed) {
    updates["system.functions.weapon.moduleSlots"] = moduleSlotCleanup.moduleSlots;
    changes.cleanedModuleWeaponFunctions += moduleSlotCleanup.removed;
  }

  if (!Object.keys(updates).length) return null;
  return { updates, changes };
}

function cleanModuleSlotWeaponFunctions(moduleSlots) {
  const slots = foundry.utils.deepClone(Array.isArray(moduleSlots) ? moduleSlots : []);
  let changed = false;
  let removed = 0;

  for (const slot of slots) {
    const moduleFunctions = slot?.itemData?.system?.functions?.module;
    const additionalWeapons = moduleFunctions?.additionalWeapons;
    if (!additionalWeapons || typeof additionalWeapons !== "object") continue;

    const keys = Object.keys(additionalWeapons);
    if (!keys.length) continue;

    moduleFunctions.additionalWeapons = {};
    removed += keys.length;
    changed = true;
  }

  return { changed, moduleSlots: slots, removed };
}

function isMeleeWeaponFunction(weapon) {
  const actions = weapon?.availableActions ?? {};
  return String(weapon?.skillKey ?? "") === "meleeCombat"
    || Boolean(actions.meleeAttack)
    || Boolean(actions.aimedMeleeAttack);
}

function recordUpdatedItem(item, scope, changes) {
  stats.updatedItems += 1;
  stats.removedAdditionalWeaponFunctions += changes.removedAdditionalWeaponFunctions;
  stats.cleanedModuleWeaponFunctions += changes.cleanedModuleWeaponFunctions;
  stats.meleeConeUpdates += changes.meleeConeUpdates;

  changedItems.push({
    scope,
    uuid: item?.uuid ?? "",
    name: item?.name ?? "",
    removedAdditionalWeaponFunctions: changes.removedAdditionalWeaponFunctions,
    cleanedModuleWeaponFunctions: changes.cleanedModuleWeaponFunctions,
    meleeConeUpdates: changes.meleeConeUpdates
  });
}

function isWorldPack(pack) {
  const packageType = String(pack.metadata?.packageType ?? pack.packageType ?? "");
  if (packageType === "world") return true;

  const packageName = String(pack.metadata?.packageName ?? pack.packageName ?? "");
  if (packageName && packageName === game.world?.id) return true;

  stats.skippedPacks += 1;
  return false;
}
