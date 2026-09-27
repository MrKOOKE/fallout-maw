const emptyResource = () => ({
  min: 0, spent: 0, bonus: 0, value: 0, max: 0, recoveryTarget: 0
});

const emptySkill = () => ({
  base: 0, min: 0, bonus: 0, bonusPercent: 0, pureValue: 0,
  developmentLimitPureOnly: true, advantage: 0, disadvantage: 0,
  criticalSuccessChance: 0, criticalFailureChance: 0,
  developmentBonus: 0, abilityBonus: 0, max: 0,
  valueBeforePercent: 0, value: 0
});

/** Make dynamic Actor fields available before Foundry applies initial effects. */
export function seedConstructEffectTargets(system, {
  resourceSettings = [], needSettings = [], proficiencySettings = [],
  characteristicSettings = [], skillSettings = [], currencySettings = [], limbSource = {}
} = {}) {
  for (const [property, settings] of [
    ["resources", resourceSettings],
    ["needs", needSettings],
    ["proficiencies", proficiencySettings]
  ]) {
    system[property] ??= {};
    for (const { key } of settings) {
      if (key) system[property][key] ??= emptyResource();
    }
  }

  system.characteristics ??= {};
  for (const { key } of characteristicSettings) {
    if (key) system.characteristics[key] ??= 0;
  }

  system.skills ??= {};
  for (const { key } of skillSettings) {
    if (key) system.skills[key] ??= emptySkill();
  }

  system.currencies ??= {};
  for (const { key } of currencySettings) {
    if (key) system.currencies[key] ??= 0;
  }

  system.limbs ??= {};
  for (const [key, source] of Object.entries(limbSource)) {
    system.limbs[key] ??= { implantLimitBonus: 0, ...source };
  }
}
