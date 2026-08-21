/** Apply actor-wide noise modifiers at the boundary between an action and its noise zone. */
export function getActorAdjustedNoiseLevel(actor, baseNoiseLevel = 0) {
  const baseCells = Math.max(0, Math.trunc(Number(baseNoiseLevel) || 0));
  const gridDistance = Math.max(0.0001, Number(
    globalThis.canvas?.scene?.grid?.distance ?? globalThis.canvas?.grid?.distance
  ) || 1);
  const flatMeters = Number(actor?.system?.stealth?.noiseLevelFlat) || 0;
  const percent = Number(actor?.system?.stealth?.noiseLevelPercent) || 0;
  const adjustedMeters = Math.max(
    0,
    ((baseCells * gridDistance) + flatMeters) * Math.max(0, 1 + (percent / 100))
  );
  return adjustedMeters / gridDistance;
}
