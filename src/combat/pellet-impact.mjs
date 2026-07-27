/**
 * Build the projectile-level representation of one attack.
 *
 * Normally every pellet is an independent projectile. Concentrated pellet
 * impact keeps the pellets as damage shares, but carries all of them on one
 * projectile and therefore one hit check.
 */
export function createPelletImpactProjectiles({
  damageAmount = 0,
  pelletCount = 1,
  concentrated = false
} = {}) {
  const count = normalizePelletCount(pelletCount);
  if (concentrated) {
    return [{
      damageAmount: normalizeDamageAmount(damageAmount),
      pelletImpactCount: count,
      pelletImpactIndex: 0
    }];
  }

  return distributePelletImpactDamage(damageAmount, count).map((amount, index) => ({
    damageAmount: amount,
    pelletImpactCount: 1,
    pelletImpactIndex: index
  }));
}

/**
 * Split one successful concentrated impact back into its individual pellet
 * damage shares. The sum always equals the rounded non-negative source amount.
 */
export function distributePelletImpactDamage(damageAmount = 0, pelletCount = 1) {
  const amount = normalizeDamageAmount(damageAmount);
  const count = normalizePelletCount(pelletCount);
  const whole = Math.floor(amount / count);
  const remainder = amount - (whole * count);
  return Array.from({ length: count }, (_entry, index) => (
    whole + (index < remainder ? 1 : 0)
  ));
}

export function getPelletProjectileCount(pelletCount = 1, { concentrated = false } = {}) {
  return concentrated ? 1 : normalizePelletCount(pelletCount);
}

function normalizePelletCount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.trunc(number)) : 1;
}

function normalizeDamageAmount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}
