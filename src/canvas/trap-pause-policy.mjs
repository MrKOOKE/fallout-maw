/**
 * Successful trap detection interrupts exploration, but combat already has
 * its own turn flow and must not be paused.
 */
export function shouldPauseAfterTrapDetection(combat) {
  return !combat?.started;
}
