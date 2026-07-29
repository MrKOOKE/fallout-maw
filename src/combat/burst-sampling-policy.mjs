export const BURST_PREVIEW_SAMPLE_BUDGET = 64;
export const BURST_RESOLUTION_SAMPLE_MIN = 64;
export const BURST_RESOLUTION_SAMPLE_MULTIPLIER = 12;

/**
 * Preview precision is deliberately independent from projectile count.
 * Resolution retains the existing projectile-scaled sampling policy.
 */
export function getBurstSampleCount(projectileCount, { purpose = "resolution" } = {}) {
  const amount = Math.max(1, Math.trunc(Number(projectileCount)) || 1);
  if (purpose === "preview") return BURST_PREVIEW_SAMPLE_BUDGET;
  return Math.max(
    BURST_RESOLUTION_SAMPLE_MIN,
    amount * BURST_RESOLUTION_SAMPLE_MULTIPLIER
  );
}

export function getEvenBurstSampleOffset(index, sampleCount) {
  const count = Math.max(1, Math.trunc(Number(sampleCount)) || 1);
  const position = Math.max(0, Math.min(count - 1, Math.trunc(Number(index)) || 0));
  return count <= 1 ? 0 : -1 + ((2 * position) / (count - 1));
}
