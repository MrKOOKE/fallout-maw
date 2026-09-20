export const MODULE_ACTION_LABELS = Object.freeze({
  aimedShot: "WeaponActionAimedShot", snapshot: "WeaponActionSnapshot", burst: "WeaponActionBurst",
  volley: "WeaponActionVolley", meleeAttack: "WeaponActionMeleeAttack", aimedMeleeAttack: "WeaponActionAimedMeleeAttack",
  push: "WeaponActionPush", reload: "WeaponActionReload"
});

const field = (path, label, options = {}) => ({ path, label, integer: false, min: null, ...options });
export function getModuleActionNumericFields(key) {
  if (key === "reload") return [];
  if (key === "volley") return [
    field("damageRadius", "WeaponVolleyDamageRadius", { formula: true, min: 0 }),
    field("regionRadius", "WeaponVolleyRegionRadius", { formula: true, min: 0 }),
    field("regionDurationSeconds", "WeaponVolleyRegionDuration", { formula: true, min: 0 }),
    field("regionDelaySeconds", "WeaponVolleyExplosionDelay", { formula: true, min: 0 }),
    field("regionRadiusDeltaMeters", "WeaponVolleyRegionRadiusDelta", { formula: true })
  ];
  const fields = [field("attackConeDegrees", "WeaponAttackCone", { min: 0, higherIsBetter: false })];
  if (key === "burst") fields.push(
    field("count", "WeaponBurstCount", { integer: true, min: 1 }),
    field("difficultyPerShot", "WeaponBurstDifficultyPerShot", { integer: true, min: 0, higherIsBetter: false })
  );
  if (key === "push") fields.push(
    field("maxRangeMeters", "WeaponMaxRange", { min: 0 }),
    field("accuracyModifier", "WeaponModeAccuracyModifier", { integer: true }),
    field("pushDifficultyModifier", "WeaponPushDifficultyModifier", { integer: true })
  );
  if (key === "meleeAttack" || key === "aimedMeleeAttack") {
    for (const mode of ["thrust", "swing"]) {
      fields.push(
        field(`${mode}.accuracyModifier`, "WeaponModeAccuracyModifier", { integer: true, mode }),
        field(`${mode}.criticalChanceModifier`, "WeaponModeCriticalChanceModifier", { integer: true, mode }),
        field(`${mode}.damagePercentModifier`, "WeaponModeDamagePercentModifier", { integer: true, mode })
      );
    }
  }
  return fields;
}

const get = (object, path) => path.split(".").reduce((value, key) => value?.[key], object);
const set = (object, path, value) => {
  const parts = path.split(".");
  const key = parts.pop();
  const parent = parts.reduce((entry, part) => (entry[part] ??= {}), object);
  parent[key] = value;
};
const clone = value => foundry.utils.deepClone(value);

function addFormula(left, right, ratio = 1, minimum = null) {
  const change = String(right ?? "0").trim() || "0";
  if (Number(change) === 0 || ratio === 0) return left;
  const base = String(left ?? "0").trim() || "0";
  if (Number.isFinite(Number(base)) && Number.isFinite(Number(change))) {
    const value = Number(base) + Number(change) * ratio;
    return String(minimum === null ? value : Math.max(minimum, value));
  }
  return `(${base}) + (${ratio === 1 ? change : `(${change}) * ${ratio}`})`;
}

/** Numeric values are deltas; empty modifier records must be a complete no-op. */
export function applyWeaponModuleActionModifiers(weapon, actions = {}, ratio = 1) {
  ratio = Math.max(0, Math.min(1, Number(ratio) || 0));
  if (!ratio) return;
  for (const key of Object.keys(MODULE_ACTION_LABELS)) {
    const change = actions[key];
    if (!change) continue;
    if (change.availability === "enable" || change.availability === "disable") {
      weapon.availableActions ??= {};
      weapon.availableActions[key] = change.availability === "enable";
    }
    for (const spec of getModuleActionNumericFields(key)) {
      const delta = get(change, spec.path);
      if (!String(delta ?? "").trim() || Number(delta) === 0) continue;
      const path = `${key}.${spec.path}`;
      if (spec.formula) {
        set(weapon, path, addFormula(get(weapon, path), delta, ratio, spec.min));
      } else {
        if (!Number.isFinite(Number(delta))) continue;
        const scaled = spec.integer ? Math.round(Number(delta) * ratio) : Number(delta) * ratio;
        const current = Number(get(weapon, path)) || 0;
        const value = current + scaled;
        set(weapon, path, spec.min === null ? value : Math.max(spec.min, value));
      }
    }
    for (const path of ["name", "explosionAnimationKey", "explosionSoundPath"]) {
      if (String(change[path] ?? "").trim()) set(weapon, `${key}.${path}`, String(change[path]).trim());
    }
    for (const mode of ["thrust", "swing"]) {
      const enabled = change[mode]?.enabled;
      if (enabled === "enable" || enabled === "disable") set(weapon, `${key}.${mode}.enabled`, enabled === "enable");
    }
    for (const listKey of ["criticalFailureConsequences", "regionDamageEntries", "regionSpecialProperties"]) {
      const additions = change[listKey] ?? [];
      const replace = change[`${listKey}Mode`] === "replace";
      if (!replace && !additions.length) continue;
      const entries = replace ? [] : clone(weapon[key]?.[listKey] ?? []);
      for (const entry of additions) {
        if (listKey === "regionDamageEntries") {
          const existing = entries.find(row => row.damageTypeKey === entry.damageTypeKey);
          const amount = addFormula(existing?.amount ?? "0", entry.amount, ratio);
          if (existing) existing.amount = amount;
          else entries.push({ ...clone(entry), amount });
        } else if (listKey === "regionSpecialProperties") {
          if (!entry.type || entry.type === "pending") continue;
          const index = entries.findIndex(row => row.type === entry.type);
          if (index >= 0) entries[index] = clone(entry);
          else entries.push(clone(entry));
        } else {
          entries.push({ ...clone(entry), amount: Math.max(0, Math.round((Number(entry.amount) || 0) * ratio)) });
        }
      }
      set(weapon, `${key}.${listKey}`, entries);
    }
  }
}

/** Text is escaped by the tooltip renderer; numeric deltas use its standard benefit colors. */
export function getWeaponModuleActionTooltipRows(actions = {}, localize = key => game.i18n.localize(key), damageLabel = key => key, renderChange = null) {
  const label = key => localize(`FALLOUTMAW.Item.${key}`);
  const signed = value => Number.isFinite(Number(value)) ? `${Number(value) > 0 ? "+" : ""}${Number(value)}` : `+ (${value})`;
  const changeValue = (value, options = {}) => renderChange && Number.isFinite(Number(value))
    ? renderChange(Number(value), options)
    : signed(value);
  const rows = [];
  for (const [key, actionLabel] of Object.entries(MODULE_ACTION_LABELS)) {
    const change = actions[key];
    if (!change) continue;
    const prefix = label(actionLabel);
    if (change.availability === "enable" || change.availability === "disable") rows.push([prefix, label(change.availability === "enable" ? "ModuleActionEnable" : "ModuleActionDisable")]);
    if (String(change.name ?? "").trim()) rows.push([`${prefix}: ${label("WeaponActionName")}`, change.name]);
    for (const spec of getModuleActionNumericFields(key)) {
      const value = get(change, spec.path);
      if (!String(value ?? "").trim() || Number(value) === 0) continue;
      const mode = spec.mode ? `${label(spec.mode === "thrust" ? "WeaponAttackModeThrust" : "WeaponAttackModeSwing")}: ` : "";
      const uniqueParameter = key === "volley" || ["count", "difficultyPerShot", "pushDifficultyModifier"].includes(spec.path);
      const parameterLabel = `${uniqueParameter ? "" : `${prefix}: `}${mode}${label(spec.label)}`;
      rows.push([parameterLabel, changeValue(value, { higherIsBetter: spec.higherIsBetter !== false })]);
    }
    for (const mode of ["thrust", "swing"]) {
      if (["enable", "disable"].includes(change[mode]?.enabled)) rows.push([
        `${prefix}: ${label(mode === "thrust" ? "WeaponAttackModeThrust" : "WeaponAttackModeSwing")}`,
        label(change[mode].enabled === "enable" ? "ModuleActionEnable" : "ModuleActionDisable")
      ]);
    }
    for (const [path, title] of [["explosionAnimationKey", "WeaponExplosionAnimation"], ["explosionSoundPath", "WeaponExplosionSound"]]) {
      if (change[path]) rows.push([`${prefix}: ${label(title)}`, change[path]]);
    }
    for (const [path, title] of [["regionDamageEntries", "WeaponVolleyRegion"], ["regionSpecialProperties", "ModuleRegionProperties"], ["criticalFailureConsequences", "WeaponCriticalFailureConsequences"]]) {
      if (change[`${path}Mode`] === "replace") rows.push([`${prefix}: ${label(title)}`, label("ModuleListReplace")]);
      for (const entry of change[path] ?? []) {
        if (path === "regionDamageEntries") rows.push([`${prefix}: ${label(title)} — ${damageLabel(entry.damageTypeKey)}`, changeValue(entry.amount)]);
        else if (path === "regionSpecialProperties" && entry.type === "smoke") rows.push([
          `${prefix}: ${localize("FALLOUTMAW.RegionBehavior.PeriodicDamage.Smoke")}`,
          `${localize("FALLOUTMAW.RegionBehavior.PeriodicDamage.SmokeThickness")}: ${entry.smoke?.thickness ?? "1"}; ${localize("FALLOUTMAW.RegionBehavior.PeriodicDamage.SmokeDensity")}: ${entry.smoke?.densityPercent ?? "50"}%`
        ]);
        else if (path === "criticalFailureConsequences") {
          const resourceLabel = { magazine: "WeaponCostMagazine", condition: "WeaponCostCondition", energyConsumer: "WeaponCostEnergy", quantity: "WeaponCostQuantity" }[entry.resourceType];
          rows.push([`${prefix}: ${label(title)} — ${entry.resourceKey || (resourceLabel ? label(resourceLabel) : entry.resourceType)}`, changeValue(entry.amount, { higherIsBetter: false })]);
        }
      }
    }
  }
  return rows;
}
