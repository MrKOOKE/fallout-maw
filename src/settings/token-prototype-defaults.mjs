import { ACTOR_TYPES } from "../constants.mjs";
import { FALLOUT_MAW } from "../config/system-config.mjs";
import { TOKEN_PROTOTYPE_DEFAULTS_SETTING } from "./constants.mjs";

const PROTOTYPE_TOKEN_FIELDS = Object.freeze([
  "name",
  "displayName",
  "actorLink",
  "width",
  "height",
  "depth",
  "texture",
  "lockRotation",
  "rotation",
  "alpha",
  "disposition",
  "displayBars",
  "bar1",
  "bar2",
  "light",
  "sight",
  "detectionModes",
  "occludable",
  "ring",
  "turnMarker",
  "movementAction",
  "flags",
  "randomImg",
  "appendNumber",
  "prependAdjective"
]);

export function createDefaultTokenPrototypeDefaults() {
  return {
    base: {},
    types: Object.fromEntries(ACTOR_TYPES.map(type => [type, {}]))
  };
}

export function normalizeTokenPrototypeDefaults(value = {}) {
  const normalized = createDefaultTokenPrototypeDefaults();
  if (!value || typeof value !== "object") return normalized;

  normalized.base = sanitizePrototypeTokenData(value.base ?? {});
  const types = value.types && typeof value.types === "object" ? value.types : value;
  for (const actorType of ACTOR_TYPES) {
    normalized.types[actorType] = sanitizePrototypeTokenData(types?.[actorType] ?? {});
  }
  return normalized;
}

export function getTokenPrototypeDefaults() {
  return normalizeTokenPrototypeDefaults(game.settings.get(FALLOUT_MAW.id, TOKEN_PROTOTYPE_DEFAULTS_SETTING));
}

export async function setTokenPrototypeDefaults(value = {}) {
  const normalized = normalizeTokenPrototypeDefaults(value);
  await game.settings.set(FALLOUT_MAW.id, TOKEN_PROTOTYPE_DEFAULTS_SETTING, normalized);
  return normalized;
}

export function getTokenPrototypeDefaultForActorType(actorType) {
  if (!ACTOR_TYPES.includes(actorType)) return {};
  const settings = getTokenPrototypeDefaults();
  return foundry.utils.mergeObject(
    foundry.utils.deepClone(settings.base ?? {}),
    foundry.utils.deepClone(settings.types?.[actorType] ?? {}),
    { inplace: false }
  );
}

export async function setTokenPrototypeDefault(actorType, prototypeTokenData = {}, { merge = false, includeName = false } = {}) {
  if (!ACTOR_TYPES.includes(actorType)) throw new Error(`Unsupported actor type: ${actorType}`);

  const settings = getTokenPrototypeDefaults();
  const current = merge ? settings.types[actorType] ?? {} : {};
  settings.types[actorType] = foundry.utils.mergeObject(
    foundry.utils.deepClone(current),
    sanitizePrototypeTokenData(prototypeTokenData, { includeName }),
    { inplace: false }
  );
  await game.settings.set(FALLOUT_MAW.id, TOKEN_PROTOTYPE_DEFAULTS_SETTING, settings);
  return settings.types[actorType];
}

export async function setBaseTokenPrototypeDefault(prototypeTokenData = {}, { merge = false, includeName = false } = {}) {
  const settings = getTokenPrototypeDefaults();
  const current = merge ? settings.base ?? {} : {};
  settings.base = foundry.utils.mergeObject(
    foundry.utils.deepClone(current),
    sanitizePrototypeTokenData(prototypeTokenData, { includeName }),
    { inplace: false }
  );
  await game.settings.set(FALLOUT_MAW.id, TOKEN_PROTOTYPE_DEFAULTS_SETTING, settings);
  return settings.base;
}

export async function setTokenPrototypeDefaultFromActor(actor, { actorType = actor?.type, merge = false, includeName = false } = {}) {
  const prototypeTokenData = actor?.prototypeToken?.toObject?.() ?? actor?.prototypeToken ?? {};
  return setTokenPrototypeDefault(actorType, prototypeTokenData, { merge, includeName });
}

export async function setTokenPrototypeDefaultFromToken(tokenOrDocument, { actorType = tokenOrDocument?.actor?.type, merge = false, includeName = false } = {}) {
  const tokenDocument = tokenOrDocument?.document ?? tokenOrDocument;
  const tokenData = tokenDocument?.toObject?.() ?? tokenDocument ?? {};
  return setTokenPrototypeDefault(actorType, tokenData, { merge, includeName });
}

export async function clearTokenPrototypeDefault(actorType) {
  if (!ACTOR_TYPES.includes(actorType)) throw new Error(`Unsupported actor type: ${actorType}`);
  const settings = getTokenPrototypeDefaults();
  settings.types[actorType] = {};
  await game.settings.set(FALLOUT_MAW.id, TOKEN_PROTOTYPE_DEFAULTS_SETTING, settings);
  return settings;
}

export async function applyTokenPrototypeDefaults(actor, data = {}, options = {}) {
  if (!actor || options?.pack || !ACTOR_TYPES.includes(actor.type)) return;
  if (foundry.utils.hasProperty(data ?? {}, "prototypeToken")) return;

  const defaults = sanitizePrototypeTokenData(getTokenPrototypeDefaultForActorType(actor.type));
  if (foundry.utils.isEmpty(defaults)) return;

  defaults.name = actor.name;
  actor.updateSource({ prototypeToken: defaults });
}

export function registerTokenPrototypeDefaultsApi() {
  CONFIG.FalloutMaW ??= {};
  CONFIG.FalloutMaW.tokenPrototypeDefaults = {
    get: getTokenPrototypeDefaults,
    getForType: getTokenPrototypeDefaultForActorType,
    set: setTokenPrototypeDefaults,
    setBase: setBaseTokenPrototypeDefault,
    setForType: setTokenPrototypeDefault,
    setFromActor: setTokenPrototypeDefaultFromActor,
    setFromToken: setTokenPrototypeDefaultFromToken,
    clear: clearTokenPrototypeDefault
  };
}

function sanitizePrototypeTokenData(value = {}, { includeName = false } = {}) {
  if (!value || typeof value !== "object") return {};

  const source = foundry.utils.deepClone(value);
  const allowed = includeName ? PROTOTYPE_TOKEN_FIELDS : PROTOTYPE_TOKEN_FIELDS.filter(field => field !== "name");
  const sanitized = {};
  for (const field of allowed) {
    if (!foundry.utils.hasProperty(source, field)) continue;
    foundry.utils.setProperty(sanitized, field, foundry.utils.getProperty(source, field));
  }
  return sanitized;
}
