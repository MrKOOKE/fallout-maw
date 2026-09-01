/**
 * Resolve Virtuoso for one completed weapon attack without mutating the stored
 * ability state. Virtuoso deliberately compares display names: Cascade owns
 * the separate UUID-based weapon-chain mechanic.
 */
export function resolveVirtuosoAttackTransition({
  state = {},
  weaponName = ""
} = {}) {
  const normalizedWeaponName = String(weaponName ?? "").trim();
  if (!normalizedWeaponName) return inactiveTransition();

  const previousWeaponName = String(state?.weaponName ?? "").trim();
  if (previousWeaponName === normalizedWeaponName) return inactiveTransition();
  return {
    bonusMultiplier: 1,
    nextState: { weaponName: normalizedWeaponName },
    reset: false
  };
}

function inactiveTransition() {
  return {
    bonusMultiplier: 0,
    nextState: null,
    reset: false
  };
}
