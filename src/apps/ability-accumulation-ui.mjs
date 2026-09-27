import { localize as auditLocalize, format as auditFormat } from "../utils/i18n.mjs";
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
      [ABILITY_ACCUMULATION_VALUE_SOURCES.damageActualHealthLoss, auditLocalize("FALLOUTMAW.AuditApps.ActualHealthLoss", "Фактическая потеря здоровья")],
      [ABILITY_ACCUMULATION_VALUE_SOURCES.damageAfterMitigation, auditLocalize("FALLOUTMAW.AuditApps.DamageAfterResistance", "Урон после сопротивлений")],
      [ABILITY_ACCUMULATION_VALUE_SOURCES.damageBeforeResistance, auditLocalize("FALLOUTMAW.AuditApps.DamageAfterDefenseBeforeResistance", "Урон после Защиты, до Сопротивления")],
      [ABILITY_ACCUMULATION_VALUE_SOURCES.damageBarrierAbsorbed, auditLocalize("FALLOUTMAW.AuditApps.DamageAbsorbedByTheBarrier", "Урон, поглощённый барьером")],
      [ABILITY_ACCUMULATION_VALUE_SOURCES.damageAfterBarrier, auditLocalize("FALLOUTMAW.AuditApps.DamageAfterTheBarrier", "Урон после барьера")],
      [ABILITY_ACCUMULATION_VALUE_SOURCES.damageIncoming, auditLocalize("FALLOUTMAW.AuditApps.IncomingDamageBeforeResistance", "Входящий урон до сопротивлений")],
      [ABILITY_ACCUMULATION_VALUE_SOURCES.damageLimbLoss, auditLocalize("FALLOUTMAW.AuditApps.ActualLimbDamage", "Фактический урон конечности")],
      [ABILITY_ACCUMULATION_VALUE_SOURCES.damageItemConditionLoss, auditLocalize("FALLOUTMAW.AuditApps.ActualItemConditionLoss", "Фактическая потеря состояния предмета")]
    ]),
    groupByChoices: choices(settings.groupBy, [
      [ABILITY_ACCUMULATION_GROUP_SOURCES.none, auditLocalize("FALLOUTMAW.AuditApps.DoNotSplit", "Не разделять")],
      [ABILITY_ACCUMULATION_GROUP_SOURCES.damageType, auditLocalize("FALLOUTMAW.AuditApps.DamageTypeFromEvent", "Тип урона из события")]
    ]),
    roundingChoices: choices(settings.rounding, [
      [ABILITY_ACCUMULATION_ROUNDING_MODES.floorTotal, auditLocalize("FALLOUTMAW.AuditApps.RoundDownAfterAccumulatingFractions", "Вниз после накопления дробей")],
      [ABILITY_ACCUMULATION_ROUNDING_MODES.roundTotal, auditLocalize("FALLOUTMAW.AuditApps.RoundToNearestAfterAccumulatingFractions", "До ближайшего после накопления дробей")],
      [ABILITY_ACCUMULATION_ROUNDING_MODES.ceilTotal, auditLocalize("FALLOUTMAW.AuditApps.RoundUpAfterAccumulatingFractions", "Вверх после накопления дробей")]
    ]),
    durationPolicyChoices: choices(settings.durationPolicy, [
      [ABILITY_ACCUMULATION_DURATION_POLICIES.fromFirst, auditLocalize("FALLOUTMAW.AuditApps.FromInitialCreationDoNotRefresh", "От первого создания — не обновлять")],
      [ABILITY_ACCUMULATION_DURATION_POLICIES.refresh, auditLocalize("FALLOUTMAW.AuditApps.RestartOnAccumulation", "Начинать заново при накоплении")]
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
        label: name || auditFormat("FALLOUTMAW.AuditApps.Accumulation", { v0: (index + 1) }, "Накопление {v0}"),
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
