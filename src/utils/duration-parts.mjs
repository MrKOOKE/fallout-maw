import { localize as auditLocalize } from "./i18n.mjs";
import { toInteger } from "./numbers.mjs";

const DURATION_UNIT_MULTIPLIERS = {
  seconds: 1,
  minutes: 60,
  hours: 3600
};

const DURATION_UNIT_SHORT_LABELS = {
  get seconds() { return auditLocalize("FALLOUTMAW.AuditRuntime.R1214", "сек."); },
  get minutes() { return auditLocalize("FALLOUTMAW.AuditRuntime.R1215", "мин."); },
  get hours() { return auditLocalize("FALLOUTMAW.AuditRuntime.R1216", "ч."); }
};

export function splitDurationSeconds(value) {
  const seconds = Math.max(0, toInteger(value));
  if (seconds > 0 && seconds % 3600 === 0) return { amount: seconds / 3600, unit: "hours" };
  if (seconds > 0 && seconds % 60 === 0) return { amount: seconds / 60, unit: "minutes" };
  return { amount: seconds, unit: "seconds" };
}

export function buildDurationUnitChoices(selected = "seconds") {
  return [
    { value: "seconds", label: auditLocalize("FALLOUTMAW.AuditRuntime.R1217", "секунды") },
    { value: "minutes", label: auditLocalize("FALLOUTMAW.AuditRuntime.R1218", "минуты") },
    { value: "hours", label: auditLocalize("FALLOUTMAW.AuditRuntime.R1219", "часы") }
  ].map(choice => ({
    ...choice,
    selected: choice.value === selected
  }));
}

export function durationPartsToSeconds(amount, unit) {
  const multiplier = DURATION_UNIT_MULTIPLIERS[String(unit ?? "seconds")] ?? 1;
  return Math.max(0, toInteger(amount) * multiplier);
}

export function formatDurationShort(seconds = 0) {
  const safeSeconds = Math.max(0, toInteger(seconds));
  if (!safeSeconds) return "";
  const { amount, unit } = splitDurationSeconds(safeSeconds);
  return `${amount} ${DURATION_UNIT_SHORT_LABELS[unit] ?? unit}`;
}

export function buildDurationPartsContext(durationSeconds) {
  const duration = splitDurationSeconds(Math.max(0, toInteger(durationSeconds)));
  return {
    amount: duration.amount,
    unit: duration.unit,
    unitChoices: buildDurationUnitChoices(duration.unit)
  };
}
