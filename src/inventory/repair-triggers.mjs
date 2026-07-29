import { TRAUMA_CREATE_OPTION } from "../constants.mjs";

const LIMB_RUNTIME_STATE_FIELDS = new Set([
  "value",
  "spent",
  "damageAccumulation"
]);

export function createdItemRequiresInventoryRepair(item = null, options = {}) {
  if (item?.type !== "trauma" || options?.[TRAUMA_CREATE_OPTION] !== true) return true;
  return itemHasInventoryRelevantTransferEffect(item);
}

export function isInventoryRelevantActorPath(path = "") {
  return (
    path === "type"
    || path.startsWith("system.constructPartSlots")
    || path.startsWith("system.creature.raceId")
    || path.startsWith("system.inventory")
    || isInventoryRelevantLimbPath(path)
    || path.startsWith("system.trade.infiniteInventory")
  );
}

function itemHasInventoryRelevantTransferEffect(item = null) {
  const effects = Array.from(item?.effects?.contents ?? item?.effects ?? []);
  for (const effect of effects) {
    if (effect?.disabled === true || effect?.active === false || effect?.transfer === false) continue;
    const changes = Array.from(effect?.system?.changes ?? effect?.changes ?? []);
    if (changes.some(change => isInventoryRelevantActorPath(String(change?.key ?? "")))) return true;
  }
  return false;
}

function isInventoryRelevantLimbPath(path = "") {
  if (path === "system.limbs") return true;
  if (!path.startsWith("system.limbs.")) return false;

  const [, , limbKey, field] = path.split(".");
  if (!limbKey || limbKey.startsWith("-=") || !field) return true;
  return !LIMB_RUNTIME_STATE_FIELDS.has(field);
}
