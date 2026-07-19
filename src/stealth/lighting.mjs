/**
 * Shared scene-lighting measurements used by stealth, traps and ability
 * conditions.  Keep the calculation in one place so every subsystem sees the
 * same value and callers can cache the relatively expensive token sampling.
 */
export function analyzeTokenLighting(token) {
  const samples = getTokenLightingPoints(token).map(point => analyzeLightingPoint(point));
  const brightest = samples.reduce(
    (best, sample) => sample.effectiveDarkness < best.effectiveDarkness ? sample : best,
    samples[0] ?? analyzeLightingPoint(getTokenCenter(token))
  );
  return {
    ...brightest,
    darknessLabel: brightest.effectiveDarkness.toFixed(2),
    darknessPercent: Math.round(brightest.effectiveDarkness * 100),
    illuminationPercent: Math.round((1 - brightest.effectiveDarkness) * 100)
  };
}

export function getTokenIlluminationPercent(token) {
  return analyzeTokenLighting(token).illuminationPercent;
}

export function analyzeLightingPoint(point) {
  const activeCanvas = globalThis.canvas;
  const elevatedPoint = {
    x: Number(point?.x) || 0,
    y: Number(point?.y) || 0,
    elevation: Number(point?.elevation) || 0
  };
  const baseDarkness = clampAlpha(
    activeCanvas?.effects?.getDarknessLevel?.(elevatedPoint)
      ?? activeCanvas?.environment?.darknessLevel
      ?? activeCanvas?.scene?.environment?.darknessLevel
      ?? 0
  );
  const darknessSourcePenalty = activeCanvas?.effects?.testInsideDarkness?.(elevatedPoint) ? 1 : baseDarkness;
  const lightIntensity = getPointLightIntensity(elevatedPoint, baseDarkness, activeCanvas);
  return {
    baseDarkness,
    effectiveDarkness: clampAlpha(Math.max(baseDarkness, darknessSourcePenalty) - lightIntensity),
    lightIntensity
  };
}

function getTokenLightingPoints(token) {
  const document = token?.document ?? token;
  const points = document?.getVisibilityTestPoints?.();
  if (Array.isArray(points) && points.length) return points;
  return [getTokenCenter(token)];
}

function getTokenCenter(token) {
  const document = token?.document ?? token;
  const center = document?.getCenterPoint?.() ?? token?.center ?? {
    x: Number(document?.x) || 0,
    y: Number(document?.y) || 0
  };
  return {
    x: Number(center?.x) || 0,
    y: Number(center?.y) || 0,
    elevation: Number(center?.elevation ?? document?.elevation) || 0
  };
}

function getPointLightIntensity(point, baseDarkness, activeCanvas) {
  let intensity = getGlobalLightIntensity(point, baseDarkness, activeCanvas);
  const lightSources = activeCanvas?.effects?.lightSources;
  for (const source of lightSources?.values?.() ?? lightSources ?? []) {
    if (!source?.active || isGlobalLightSource(source)) continue;
    if (!source.testPoint?.(point)) continue;
    intensity = Math.max(intensity, getLocalLightIntensity(source, point));
  }
  return clampAlpha(intensity);
}

function getGlobalLightIntensity(point, baseDarkness, activeCanvas) {
  const globalLightSource = activeCanvas?.environment?.globalLightSource;
  if (!globalLightSource?.active) return 0;
  const darkness = globalLightSource.data?.darkness ?? {};
  const minimum = Number(darkness.min) || 0;
  const maximum = Number.isFinite(Number(darkness.max)) ? Number(darkness.max) : 1;
  if (baseDarkness < minimum || baseDarkness > maximum) return 0;
  return activeCanvas?.effects?.testInsideLight?.(point, { condition: source => isGlobalLightSource(source) }) ? 1 : 0;
}

function getLocalLightIntensity(source, point) {
  const origin = source.origin ?? source;
  const distance = Math.hypot(point.x - (Number(origin.x) || 0), point.y - (Number(origin.y) || 0));
  const brightRadius = Math.max(0, Number(source.data?.bright) || 0);
  const dimRadius = Math.max(brightRadius, Number(source.data?.dim) || Number(source.data?.radius) || 0);
  if (brightRadius > 0 && distance <= brightRadius) return 1;
  if (dimRadius <= 0 || distance > dimRadius) return 0;
  if (dimRadius <= brightRadius) return 0.5;
  const ratio = clampAlpha((distance - brightRadius) / Math.max(1, dimRadius - brightRadius));
  return 0.5 + ((1 - ratio) * 0.5);
}

function isGlobalLightSource(source) {
  return source?.constructor?.name === "GlobalLightSource" || source?.name === "GlobalLight";
}

function clampAlpha(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}
