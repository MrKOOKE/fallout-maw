const TAU = Math.PI * 2;
const EPSILON = 1e-9;

/** Positive screen angles turn clockwise; negative offsets are the left side. */
export function getAttackConeAngles(geometry = {}) {
  geometry ??= {};
  const fallback = finiteAngle(geometry.halfAngle);
  const leftHalfAngle = geometry.leftHalfAngle == null ? fallback : finiteAngle(geometry.leftHalfAngle);
  const rightHalfAngle = geometry.rightHalfAngle == null ? fallback : finiteAngle(geometry.rightHalfAngle);
  return { leftHalfAngle, rightHalfAngle, halfAngle: Math.max(leftHalfAngle, rightHalfAngle),
    width: leftHalfAngle + rightHalfAngle };
}

/** Preserve the free half of a cone when its axis reaches a physical stop. */
export function clipAttackConeToSector(geometry = {}, sector = null) {
  const angles = getAttackConeAngles(geometry);
  const angle = Number(geometry.angle) || 0;
  const min = Number(sector?.minRotation), max = Number(sector?.maxRotation);
  if (!sector || !Number.isFinite(min) || !Number.isFinite(max) || max - min >= 360) {
    return { angle, ...angles };
  }
  const low = Math.min(min, max), high = Math.max(min, max);
  const rotation = Number(sector.rotation) || 0;
  let relative = normalizeRadians(angle + Math.PI / 2 - rotation * Math.PI / 180) * 180 / Math.PI;
  // +180 and -180 describe the same ray; prefer the representation inside this sector.
  const equivalent = [relative, relative + 360, relative - 360]
    .find(value => value >= low - EPSILON && value <= high + EPSILON);
  relative = Math.min(high, Math.max(low, equivalent ?? relative));
  const leftHalfAngle = Math.min(angles.leftHalfAngle, Math.max(0, relative - low) * Math.PI / 180);
  const rightHalfAngle = Math.min(angles.rightHalfAngle, Math.max(0, high - relative) * Math.PI / 180);
  return { angle: normalizeRadians((rotation + relative - 90) * Math.PI / 180),
    ...getAttackConeAngles({ leftHalfAngle, rightHalfAngle }) };
}

export function getAttackConeSampleOffset(geometry, ratio = 0.5) {
  const { leftHalfAngle, width } = getAttackConeAngles(geometry);
  return -leftHalfAngle + width * Math.min(1, Math.max(0, Number(ratio) || 0));
}

/** Include axis/cardinal extrema so a token candidate bound contains the whole arc. */
export function getAttackConeSampleOffsets(geometry, segments = 24) {
  const { leftHalfAngle, rightHalfAngle, width } = getAttackConeAngles(geometry);
  if (width <= 0) return [];
  const count = Math.max(1, Math.trunc(Number(segments)) || 24);
  const offsets = Array.from({ length: count + 1 }, (_, index) => getAttackConeSampleOffset(geometry, index / count));
  offsets.push(0);
  const angle = Number(geometry.angle) || 0;
  for (let index = 0; index < 4; index += 1) {
    const offset = normalizeRadians(index * Math.PI / 2 - angle);
    if (offset >= -leftHalfAngle - EPSILON && offset <= rightHalfAngle + EPSILON) offsets.push(offset);
  }
  return offsets.sort((a, b) => a - b).filter((value, index, all) => !index || value - all[index - 1] > EPSILON);
}

export function isAttackConeOffsetAllowed(offset, geometry, epsilon = 0) {
  const { leftHalfAngle, rightHalfAngle } = getAttackConeAngles(geometry);
  const normalized = normalizeRadians(offset);
  return [normalized, normalized + TAU, normalized - TAU]
    .some(value => value >= -leftHalfAngle - epsilon && value <= rightHalfAngle + epsilon);
}

function finiteAngle(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(Math.PI, Math.max(0, number)) : 0;
}

function normalizeRadians(angle) {
  return ((angle + Math.PI) % TAU + TAU) % TAU - Math.PI;
}
