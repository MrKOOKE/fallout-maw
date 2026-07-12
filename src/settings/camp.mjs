import { IDENTIFIER_PATTERN } from "../formulas/index.mjs";

const DEFAULT_SLEEPINESS_NEED_KEY = "sleepiness";

export function createDefaultCampSettings() {
  return {
    restPlaces: [
      createCampRestPlace("ground", "На земле", -15),
      createCampRestPlace("cot", "Лежак", -25),
      createCampRestPlace("sleepingBag", "Спальник", -40),
      createCampRestPlace("bed", "Кровать", -55),
      createCampRestPlace("luxuryBed", "Роскошная кровать", -80)
    ]
  };
}

export function createEmptyCampState() {
  return {
    active: false,
    id: "",
    createdAt: 0,
    createdBy: "",
    restSeconds: 0,
    participants: []
  };
}

export function normalizeCampSettings(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const defaults = createDefaultCampSettings();
  const restPlaces = normalizeCampRestPlaces(source.restPlaces, defaults.restPlaces);
  return {
    restPlaces: restPlaces.length ? restPlaces : defaults.restPlaces
  };
}

export function normalizeCampState(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  if (!source.active) return createEmptyCampState();
  const id = String(source.id ?? "").trim();
  return {
    active: Boolean(id),
    id,
    createdAt: Math.max(0, Math.trunc(Number(source.createdAt) || 0)),
    createdBy: String(source.createdBy ?? ""),
    restSeconds: Math.max(0, Math.trunc(Number(source.restSeconds) || 0)),
    participants: normalizeCampParticipants(source.participants)
  };
}

export function createCampParticipant(actor, {
  userId = game.user?.id ?? "",
  restPlaceId = getDefaultCampRestPlaceId()
} = {}) {
  return {
    actorUuid: String(actor?.uuid ?? ""),
    userId: String(userId ?? ""),
    ready: false,
    watchSeconds: 0,
    researchSeconds: 0,
    researchId: "",
    restPlaceId: String(restPlaceId ?? ""),
    joinedAt: Date.now()
  };
}

export function getDefaultCampRestPlaceId(settings = normalizeCampSettings()) {
  return settings.restPlaces[0]?.id ?? "ground";
}

export function normalizeCampRestPlaceEffects(value = []) {
  const source = Array.isArray(value) ? value : [];
  return source
    .map(entry => ({
      needKey: String(entry?.needKey ?? entry?.key ?? "").trim(),
      perHour: toDecimal(entry?.perHour ?? entry?.value, 0)
    }))
    .filter(entry => IDENTIFIER_PATTERN.test(entry.needKey))
}

function createCampRestPlace(id, label, sleepinessPerHour) {
  return {
    id,
    label,
    effects: [
      {
        needKey: DEFAULT_SLEEPINESS_NEED_KEY,
        perHour: sleepinessPerHour
      }
    ]
  };
}

function normalizeCampRestPlaces(value, defaults = []) {
  const source = Array.isArray(value) ? value : defaults;
  const used = new Set();
  return source
    .map((entry, index) => {
      const fallback = defaults[index] ?? {};
      const id = normalizeIdentifier(entry?.id ?? entry?.key, fallback.id || `restPlace${index + 1}`);
      if (!id || used.has(id)) return null;
      used.add(id);
      return {
        id,
        label: String(entry?.label ?? entry?.name ?? fallback.label ?? "").trim() || `Место отдыха ${index + 1}`,
        effects: normalizeCampRestPlaceEffects(entry?.effects ?? fallback.effects)
      };
    })
    .filter(Boolean);
}

function normalizeCampParticipants(value = []) {
  const source = Array.isArray(value) ? value : [];
  const used = new Set();
  return source
    .map(entry => {
      const actorUuid = String(entry?.actorUuid ?? entry?.uuid ?? "").trim();
      if (!actorUuid || used.has(actorUuid)) return null;
      used.add(actorUuid);
      return {
        actorUuid,
        userId: String(entry?.userId ?? ""),
        ready: Boolean(entry?.ready),
        watchSeconds: Math.max(0, Math.trunc(Number(entry?.watchSeconds) || 0)),
        researchSeconds: Math.max(0, Math.trunc(Number(entry?.researchSeconds) || 0)),
        researchId: String(entry?.researchId ?? "").trim(),
        restPlaceId: String(entry?.restPlaceId ?? ""),
        joinedAt: Math.max(0, Math.trunc(Number(entry?.joinedAt) || 0))
      };
    })
    .filter(Boolean);
}

function normalizeIdentifier(value, fallback = "") {
  const id = String(value ?? "").trim();
  if (IDENTIFIER_PATTERN.test(id)) return id;
  return IDENTIFIER_PATTERN.test(fallback) ? fallback : "";
}

function toDecimal(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
