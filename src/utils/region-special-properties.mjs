export const REGION_SPECIAL_PROPERTY_SMOKE = "smoke";
export const REGION_SPECIAL_PROPERTY_PENDING = "pending";

const DEFAULT_SMOKE_THICKNESS = "1";
const DEFAULT_SMOKE_DENSITY_PERCENT = "50";

/** Normalize persisted rows, retaining at most one selectable area property. */
export function normalizeRegionSpecialProperties(value = []) {
  const rows = Array.isArray(value) ? value : Object.values(value ?? {});
  const smoke = rows.find(row => String(row?.type ?? "").trim() === REGION_SPECIAL_PROPERTY_SMOKE);
  const selected = smoke ?? rows.find(row => row && typeof row === "object");
  if (!selected) return [];
  const type = smoke ? REGION_SPECIAL_PROPERTY_SMOKE : REGION_SPECIAL_PROPERTY_PENDING;
  return [{
    type,
    smoke: {
      thickness: normalizeScalar(selected.smoke?.thickness, DEFAULT_SMOKE_THICKNESS),
      densityPercent: normalizeScalar(selected.smoke?.densityPercent, DEFAULT_SMOKE_DENSITY_PERCENT)
    }
  }];
}

/** Create a complete row when it is added or its selected type changes. */
export function createDefaultRegionSpecialPropertyData(type = REGION_SPECIAL_PROPERTY_PENDING, source = {}) {
  const normalizedType = type === REGION_SPECIAL_PROPERTY_SMOKE
    ? REGION_SPECIAL_PROPERTY_SMOKE
    : REGION_SPECIAL_PROPERTY_PENDING;
  return {
    type: normalizedType,
    smoke: {
      thickness: normalizeScalar(source?.smoke?.thickness, DEFAULT_SMOKE_THICKNESS),
      densityPercent: normalizeScalar(source?.smoke?.densityPercent, DEFAULT_SMOKE_DENSITY_PERCENT)
    }
  };
}

/** Resolve one area row into the compact runtime representation. */
export function resolveRegionSpecialProperties(value = [], evaluate = defaultEvaluate) {
  return normalizeRegionSpecialProperties(value).filter(row => row.type === REGION_SPECIAL_PROPERTY_SMOKE).map(row => {
    const thickness = clamp(Number(evaluate(row.smoke.thickness)), 0, 1, 1);
    const densityPercent = clamp(Number(evaluate(row.smoke.densityPercent)), 0, 100, 50);
    return {
      type: REGION_SPECIAL_PROPERTY_SMOKE,
      smoke: {
        thickness,
        density: densityPercent / 100,
        densityPercent
      }
    };
  });
}

export function getSmokeSpecialProperty(value = []) {
  return resolveRegionSpecialProperties(value).find(row => row.type === REGION_SPECIAL_PROPERTY_SMOKE) ?? null;
}

export function getSmokeRuntimeProperties(value = [], evaluate = defaultEvaluate) {
  return resolveRegionSpecialProperties(value, evaluate)
    .find(row => row.type === REGION_SPECIAL_PROPERTY_SMOKE)?.smoke ?? null;
}

function defaultEvaluate(value) {
  return value;
}

function normalizeScalar(value, fallback) {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function clamp(value, minimum, maximum, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}
