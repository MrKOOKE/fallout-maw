import { localize as auditLocalize } from "../utils/i18n.mjs";
import {
  CONSTRUCT_PART_MITIGATION_LIMB_KEY,
  DAMAGE_MITIGATION_MODES,
  ITEM_FUNCTIONS,
  getConditionWeakeningData,
  getDamageMitigationFunction,
  getInstalledFunctionModuleItems,
  hasItemFunction
} from "../utils/item-functions.mjs";
import { getConstructPartLimbKey, getConstructPartSlotId } from "../utils/construct-parts.mjs";
import { scaleEquipmentProtectionValue } from "./equipment-effectiveness.mjs";
import { toInteger } from "../utils/numbers.mjs";

/** Prepare equipped protection; source metadata is opt-in for the open Actor sheet only. */
export function buildEquippedItemDamageMitigation(
  items,
  limbs = {},
  damageTypeSettings = [],
  actor = null,
  { includeSources = false } = {}
) {
  const defenses = buildEmptyLimbDamageMap(limbs, damageTypeSettings);
  const resistances = buildEmptyLimbDamageMap(limbs, damageTypeSettings);
  const defenseSources = includeSources ? buildEmptyLimbDamageSourceMap(limbs, damageTypeSettings) : null;
  const resistanceSources = includeSources ? buildEmptyLimbDamageSourceMap(limbs, damageTypeSettings) : null;
  const limbKeys = new Set(Object.keys(limbs ?? {}));
  const damageTypeKeys = new Set(damageTypeSettings.map(damageType => damageType.key));

  for (const item of items ?? []) {
    if (item.type !== "gear") continue;
    const isConstructPart = hasItemFunction(item, ITEM_FUNCTIONS.constructPart)
      && String(item.system?.placement?.mode ?? "") === ITEM_FUNCTIONS.constructPart;
    if (!item.system?.equipped && !isConstructPart) continue;
    const mitigationActive = hasItemFunction(item, ITEM_FUNCTIONS.damageMitigation);
    const canDescribeSuppressedMitigation = includeSources
      && hasItemFunction(item, ITEM_FUNCTIONS.damageMitigation, { ignoreBroken: true });
    if (!mitigationActive && !canDescribeSuppressedMitigation) continue;
    const sourceItems = [item, ...getInstalledFunctionModuleItems(item, ITEM_FUNCTIONS.damageMitigation, {
      actor, ignoreBroken: includeSources
    })];
    for (const sourceItem of sourceItems) {
      const mitigation = getDamageMitigationFunction(sourceItem);
      const mode = String(mitigation.mode || DAMAGE_MITIGATION_MODES.defense);
      const weakening = getConditionWeakeningData(sourceItem);
      const constructPartLimbKey = isConstructPart
        ? getConstructPartLimbKey(getConstructPartSlotId(item))
        : "";

      for (const [rawLimbKey, damageEntries] of Object.entries(mitigation.entries ?? {})) {
        const limbKey = rawLimbKey === CONSTRUCT_PART_MITIGATION_LIMB_KEY && constructPartLimbKey
          ? constructPartLimbKey
          : rawLimbKey;
        if (isConstructPart && limbKey !== constructPartLimbKey) continue;
        if (!limbKeys.has(limbKey)) continue;
        for (const [damageTypeKey, entry] of Object.entries(damageEntries ?? {})) {
          if (!damageTypeKeys.has(damageTypeKey)) continue;
          const prepared = prepareEquipmentDamageMitigationValue(sourceItem, actor, entry?.value, {
            mitigationActive: mitigationActive && hasItemFunction(sourceItem, ITEM_FUNCTIONS.damageMitigation),
            weakening
          });
          const { baseValue, weakenedValue, value } = prepared;
          if (!value && (!includeSources || !baseValue)) continue;

          const isResistance = mode === DAMAGE_MITIGATION_MODES.resistance;
          const values = isResistance ? resistances : defenses;
          values[limbKey][damageTypeKey] += value;
          if (!includeSources) continue;
          const sources = isResistance ? resistanceSources : defenseSources;
          sources[limbKey][damageTypeKey].push({
            itemId: String(sourceItem.id ?? ""),
            name: String(sourceItem.name ?? auditLocalize("FALLOUTMAW.AuditRuntime.R1115", "Снаряжение")),
            img: String(sourceItem.img ?? "") || "icons/svg/item-bag.svg",
            baseValue,
            weakenedValue,
            value,
            protectionPercent: prepared.protectionPercent
          });
        }
      }
    }
  }

  return { defenses, resistances, defenseSources, resistanceSources };
}

/** Use the exact Actor preparation order for one equipment protection value. */
export function prepareEquipmentDamageMitigationValue(item, actor, rawValue = 0, {
  mitigationActive = hasItemFunction(item, ITEM_FUNCTIONS.damageMitigation),
  weakening = getConditionWeakeningData(item)
} = {}) {
  const baseValue = toInteger(rawValue);
  const weakeningRatio = weakening?.active ? weakening.ratio : 1;
  const weakenedValue = mitigationActive
    ? (baseValue > 0 ? Math.floor(baseValue * weakeningRatio) : baseValue)
    : 0;
  return {
    baseValue,
    weakenedValue,
    value: mitigationActive ? scaleEquipmentProtectionValue(actor, weakenedValue) : 0,
    protectionPercent: Number(actor?.system?.equipmentEffectiveness?.protectionPercent) || 0
  };
}

/** Item tooltips use the same per-source rounding as equipped Actor protection. */
export function prepareItemDamageMitigationCell(item, actor, limbKey, damageTypeKey, {
  sourceItems = [item, ...getInstalledFunctionModuleItems(item, ITEM_FUNCTIONS.damageMitigation, { actor, ignoreBroken: true })]
} = {}) {
  const result = { defense: { value: 0, sources: [] }, resistance: { value: 0, sources: [] } };
  const hostActive = hasItemFunction(item, ITEM_FUNCTIONS.damageMitigation);
  for (const sourceItem of sourceItems) {
    const mitigation = getDamageMitigationFunction(sourceItem);
    const mode = mitigation.mode === DAMAGE_MITIGATION_MODES.resistance ? "resistance" : "defense";
    const prepared = prepareEquipmentDamageMitigationValue(sourceItem, actor, mitigation.entries?.[limbKey]?.[damageTypeKey]?.value, {
      mitigationActive: hostActive && hasItemFunction(sourceItem, ITEM_FUNCTIONS.damageMitigation)
    });
    result[mode].value += prepared.value;
    result[mode].sources.push({ item: sourceItem, ...prepared });
  }
  return result;
}

export function buildEmptyLimbDamageMap(limbs = {}, damageTypeSettings = []) {
  return Object.fromEntries(
    Object.keys(limbs ?? {}).map(limbKey => [
      limbKey,
      Object.fromEntries(damageTypeSettings.map(damageType => [damageType.key, 0]))
    ])
  );
}

export function expandLimbDamageMapSelectors(source = {}, limbs = {}, damageTypeSettings = []) {
  const result = buildEmptyLimbDamageMap(limbs, damageTypeSettings);
  for (const limbKey of Object.keys(limbs ?? {})) {
    for (const damageType of damageTypeSettings) {
      result[limbKey][damageType.key] = [
        source?.all?.all,
        source?.all?.[damageType.key],
        source?.[limbKey]?.all,
        source?.[limbKey]?.[damageType.key]
      ].reduce((sum, value) => sum + toInteger(value), 0);
    }
  }
  return result;
}

function buildEmptyLimbDamageSourceMap(limbs = {}, damageTypeSettings = []) {
  return Object.fromEntries(Object.keys(limbs ?? {}).map(limbKey => [
    limbKey,
    Object.fromEntries(damageTypeSettings.map(damageType => [damageType.key, []]))
  ]));
}
