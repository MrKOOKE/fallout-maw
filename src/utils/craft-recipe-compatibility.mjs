import { getItemMagazineSourceUuids, isAmmoCompatibleItem } from "./item-ammo-compatibility.mjs";
import { findFreeFunctionModuleSlot, getModuleSlotFunctionEntries } from "./weapon-modules.mjs";
import { resolveWorldItemSync } from "./world-items.mjs";

export function getCraftCompatibilityActions(item) {
  const actions = [];
  if (getItemMagazineSourceUuids(item).length) {
    actions.push({ action: "show-ammo", kind: "ammo", icon: "fa-crosshairs", label: "Подходящие боеприпасы" });
  }
  if (getModuleSlotFunctionEntries(item).length) {
    actions.push({ action: "show-modules", kind: "modules", icon: "fa-puzzle-piece", label: "Подходящие модули" });
  }
  return actions;
}

/** Match the crafted item, keeping each known recipe variant as a separate result. */
export function filterCompatibleCraftRecipes(targetItem, kind, recipes = [], resolveItem = resolveWorldItemSync) {
  if (kind !== "ammo" && kind !== "modules") return [];
  const matches = new Map();
  return recipes.filter(recipe => {
    const uuid = recipe.itemUuid;
    if (!matches.has(uuid)) {
      const item = resolveItem(uuid);
      matches.set(uuid, Boolean(item && (kind === "modules"
        ? findFreeFunctionModuleSlot(targetItem, item)
        : isAmmoCompatibleItem(targetItem, item))));
    }
    return matches.get(uuid);
  });
}
