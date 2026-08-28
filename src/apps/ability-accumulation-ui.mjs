import {
  ABILITY_ACCUMULATION_DURATION_POLICIES,
  ABILITY_ACCUMULATION_GROUP_SOURCES,
  ABILITY_ACCUMULATION_ROUNDING_MODES,
  ABILITY_ACCUMULATION_VALUE_SOURCES,
  ABILITY_CHANGE_VALUE_SOURCES,
  ABILITY_CONDITION_TYPES,
  normalizeAbilityAccumulation
} from "../settings/abilities.mjs";

export function prepareAbilityAccumulationForDisplay(value = {}) {
  const settings = normalizeAbilityAccumulation(value);
  return {
    ...settings,
    valueSourceChoices: choices(settings.valueSource, [
      [ABILITY_ACCUMULATION_VALUE_SOURCES.damageActualHealthLoss, "Фактическая потеря здоровья"],
      [ABILITY_ACCUMULATION_VALUE_SOURCES.damageAfterMitigation, "Урон после сопротивлений"],
      [ABILITY_ACCUMULATION_VALUE_SOURCES.damageBeforeResistance, "Урон после Защиты, до Сопротивления"],
      [ABILITY_ACCUMULATION_VALUE_SOURCES.damageBarrierAbsorbed, "Урон, поглощённый барьером"],
      [ABILITY_ACCUMULATION_VALUE_SOURCES.damageAfterBarrier, "Урон после барьера"],
      [ABILITY_ACCUMULATION_VALUE_SOURCES.damageIncoming, "Входящий урон до сопротивлений"],
      [ABILITY_ACCUMULATION_VALUE_SOURCES.damageLimbLoss, "Фактический урон конечности"],
      [ABILITY_ACCUMULATION_VALUE_SOURCES.damageItemConditionLoss, "Фактическая потеря состояния предмета"]
    ]),
    groupByChoices: choices(settings.groupBy, [
      [ABILITY_ACCUMULATION_GROUP_SOURCES.none, "Не разделять"],
      [ABILITY_ACCUMULATION_GROUP_SOURCES.damageType, "Тип урона из события"]
    ]),
    roundingChoices: choices(settings.rounding, [
      [ABILITY_ACCUMULATION_ROUNDING_MODES.floorTotal, "Вниз после накопления дробей"],
      [ABILITY_ACCUMULATION_ROUNDING_MODES.roundTotal, "До ближайшего после накопления дробей"],
      [ABILITY_ACCUMULATION_ROUNDING_MODES.ceilTotal, "Вверх после накопления дробей"]
    ]),
    durationPolicyChoices: choices(settings.durationPolicy, [
      [ABILITY_ACCUMULATION_DURATION_POLICIES.fromFirst, "От первого создания — не обновлять"],
      [ABILITY_ACCUMULATION_DURATION_POLICIES.refresh, "Начинать заново при накоплении"]
    ])
  };
}

export function prepareAbilityAccumulatorExchangeForDisplay(change = {}, conditions = []) {
  const enabled = change?.valueSource === ABILITY_CHANGE_VALUE_SOURCES.accumulation;
  const selectedId = String(change?.accumulatorExchange?.conditionId ?? "").trim();
  const accumulators = (Array.isArray(conditions) ? conditions : Object.values(conditions ?? {}))
    .filter(condition => condition?.type === ABILITY_CONDITION_TYPES.accumulation);
  return {
    enabled,
    selectedId,
    hasAccumulators: accumulators.length > 0,
    conditionChoices: accumulators.map((condition, index) => {
      const name = String(condition?.accumulation?.name ?? "").trim();
      return {
        value: String(condition?.id ?? ""),
        label: name || `Накопление ${index + 1}`,
        selected: String(condition?.id ?? "") === selectedId
      };
    })
  };
}

function choices(selected, entries) {
  return entries.map(([value, label]) => ({
    value,
    label,
    selected: value === selected
  }));
}
