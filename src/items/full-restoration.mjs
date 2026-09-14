import { applyWeaponModuleModifiers, getWeaponModuleSlotItemData } from "../utils/weapon-modules.mjs";

/** Restore owned data only; installed modules keep their changes in the host Item. */
export function createFullItemRestorationUpdate(item) {
  const data = item.toObject();
  const restored = foundry.utils.deepClone(data);
  restoreItemData(restored, new Set([item.uuid].filter(Boolean)));
  const changes = foundry.utils.diffObject(data, restored);
  return Object.keys(changes).length ? { _id: item.id, ...changes } : null;
}

function restoreItemData(data, ancestors) {
  const functions = data?.system?.functions;
  if (!functions) return;
  if (functions.condition?.enabled) {
    functions.condition.value = Math.max(0, Math.trunc(Number(functions.condition.max) || 0));
  }
  if (functions.energySource?.enabled) fillReserve(functions.energySource.reserve);
  const installed = functions.energyConsumer?.enabled ? functions.energyConsumer.installedSource : null;
  if (installed?.sourceItemUuid) {
    fillReserve(installed.reserve);
    if (installed.itemData?.system) restoreItemData(installed.itemData, ancestors);
  }

  const weapon = functions.weapon;
  if (weapon?.enabled) {
    // Repair modules first: a broken capacity upgrade becomes effective again.
    for (const slot of weapon.moduleSlots ?? []) {
      const uuid = String(slot.itemUuid ?? "");
      if (uuid && ancestors.has(uuid)) continue;
      const source = getWeaponModuleSlotItemData(slot);
      if (!source?.system) continue;
      const restored = foundry.utils.deepClone(source);
      restoreItemData(restored, new Set([...ancestors, uuid].filter(Boolean)));
      if (Object.keys(foundry.utils.diffObject(source, restored)).length) slot.itemData = restored;
    }
    fillMagazine(weapon, applyWeaponModuleModifiers(weapon));
    for (const additional of Object.values(functions.additionalWeapons ?? {})) {
      if (additional?.enabled) fillMagazine(additional);
    }
  }
  if (functions.module?.enabled) {
    for (const additional of Object.values(functions.module.additionalWeapons ?? {})) {
      if (additional?.enabled) fillMagazine(additional);
    }
  }
}

function fillMagazine(weapon, effective = weapon) {
  const max = Math.trunc(Number(effective.magazine?.max));
  // A zero capacity means an unlimited magazine in the existing rules.
  if (weapon.magazine && Number.isFinite(max) && max > 0) weapon.magazine.value = max;
}

function fillReserve(reserve) {
  const max = Number(reserve?.max);
  if (reserve && Number.isFinite(max) && max > 0) reserve.value = max;
}
