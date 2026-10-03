const providers = new Map();
const normalize = angle => ((angle + 180) % 360 + 360) % 360 - 180;

/** Any mechanic charging for angular travel can supply its current cost sector. */
export function registerAimActivationSectorProvider(id, provider) {
  providers.set(id, provider);
  return () => { if (providers.get(id) === provider) providers.delete(id); };
}

export function getAimActivationSector(controller) {
  for (const provider of providers.values()) {
    const sector = provider(controller);
    if (sector) return sector;
  }
  return null;
}

function validSector(sector) {
  return Boolean(sector && [sector.origin?.x, sector.origin?.y, sector.rotation, sector.minRotation, sector.maxRotation].every(Number.isFinite)
    && sector.maxRotation >= sector.minRotation && sector.maxRotation - sector.minRotation < 360);
}

function relativeAngle(angle, sector) {
  const relative = normalize(angle - sector.rotation);
  return [relative, relative - 360, relative + 360]
    .find(value => value >= sector.minRotation - 1e-6 && value <= sector.maxRotation + 1e-6);
}

/** The central half of the displayed cost cone is the safe activation area. */
export function getAimActivationUnlockSector(sector) {
  if (!validSector(sector)) return null;
  const middle = (sector.minRotation + sector.maxRotation) / 2;
  const halfWidth = (sector.maxRotation - sector.minRotation) / 4;
  return { ...sector, minRotation: middle - halfWidth, maxRotation: middle + halfWidth };
}

/** Only real pointer input arms the gate; the seeded preview never does. */
export class AimActivationGate {
  waiting = false;
  constructor(getSector) { this.getSector = getSector; }

  initialize(fallback = null) {
    this.waiting = validSector(this.getSector());
    return this.seedPoint() ?? fallback;
  }

  seedPoint() {
    if (!this.waiting) return null;
    const sector = this.getSector();
    if (!validSector(sector)) { this.waiting = false; return null; }
    const angle = Number.isFinite(sector.initialRotation) ? sector.initialRotation : sector.rotation;
    const relative = relativeAngle(angle, sector) ?? (sector.minRotation + sector.maxRotation) / 2;
    const radians = (sector.rotation + relative) * Math.PI / 180;
    const distance = Math.max(1, Number(sector.seedDistance) || 200);
    return { x: sector.origin.x + Math.sin(radians) * distance, y: sector.origin.y - Math.cos(radians) * distance };
  }

  getWaitingSector() {
    if (!this.waiting) return null;
    const sector = getAimActivationUnlockSector(this.getSector());
    if (!sector) this.waiting = false;
    return sector;
  }

  accept(point) {
    if (!this.waiting) return true;
    const sector = this.getWaitingSector();
    if (!sector) return true;
    if (![point?.x, point?.y].every(Number.isFinite)) return false;
    const dx = point.x - sector.origin.x, dy = point.y - sector.origin.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 0.001 || Number.isFinite(sector.radius) && distance > sector.radius + 1e-6) return false;
    if (relativeAngle(Math.atan2(dx, -dy) * 180 / Math.PI, sector) === undefined) return false;
    this.waiting = false;
    return true;
  }
}
