/**
 * Virtuoso has no independent timers or combat lifecycle. Its last weapon
 * name is committed by the aggregate weapon-attack handler in fixed-functions.
 *
 * Kept as an explicit no-op entry point so callers can register the ability
 * without accidentally restoring Cascade's former runtime mode here.
 */
export function registerVirtuosoRuntime() {
  return false;
}
