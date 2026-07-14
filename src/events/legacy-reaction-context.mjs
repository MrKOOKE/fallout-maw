import { serializeSystemEventPayload } from "./catalog.mjs";

const COMMON_FIELDS = Object.freeze(["title", "message", "damageHubOperationRef"]);

const LEGACY_CONTEXT_FIELDS = Object.freeze({
  weaponAttackTargeted: Object.freeze([
    "attackId",
    "attackerActorUuid",
    "attackerTokenUuid",
    "targetActorUuid",
    "targetTokenUuid",
    "weaponUuid",
    "actionKey",
    "weaponFunctionId"
  ]),
  weaponAttackCommitted: Object.freeze([
    "attackId",
    "attackerActorUuid",
    "attackerTokenUuid",
    "targetActorUuid",
    "targetTokenUuid",
    "weaponUuid",
    "actionKey",
    "weaponFunctionId",
    "originalHitChance"
  ]),
  aimedAttackLimbSelected: Object.freeze([
    "attackId",
    "attackerActorUuid",
    "attackerTokenUuid",
    "targetActorUuid",
    "targetTokenUuid",
    "weaponUuid",
    "actionKey",
    "weaponFunctionId",
    "limbKey"
  ]),
  weaponAttackResolved: Object.freeze([
    "attackId",
    "attackerActorUuid",
    "attackerTokenUuid",
    "targetActorUuid",
    "targetTokenUuid",
    "targetActorUuids",
    "targetTokenUuids",
    "weaponUuid",
    "actionKey",
    "weaponFunctionId"
  ]),
  tokenLeavingAdjacency: Object.freeze([
    "movementId",
    "moverActorUuid",
    "moverTokenUuid",
    "reactorTokenUuids"
  ]),
  oversightThreshold: Object.freeze([
    "activationId",
    "sourceActorUuid",
    "sourceTokenUuid",
    "targetActorUuid",
    "targetTokenUuid"
  ])
});

const ARRAY_FIELDS = new Set(["targetActorUuids", "targetTokenUuids", "reactorTokenUuids"]);

/**
 * Copy only the legacy fields that fixed providers still consume. Runtime objects are neither traversed nor
 * converted: an allow-listed field with an invalid value rejects the bridge instead of producing a lossy payload.
 */
export function serializeLegacyReactionContext(eventKey, rawContext = {}) {
  const key = String(eventKey ?? "").trim();
  const fields = LEGACY_CONTEXT_FIELDS[key];
  if (!fields) throw new TypeError(`Unsupported legacy reaction event '${key}'.`);
  if (!isPlainObject(rawContext)) throw new TypeError(`Legacy reaction context for '${key}' must be a plain object.`);

  const serialized = {};
  for (const field of [...COMMON_FIELDS, ...fields]) {
    const value = rawContext[field];
    if (value === undefined || value === null) continue;
    if (ARRAY_FIELDS.has(field)) {
      if (!Array.isArray(value) || value.some(entry => typeof entry !== "string")) {
        throw new TypeError(`Legacy reaction field '${field}' must be an array of strings.`);
      }
      serialized[field] = [...value];
      continue;
    }
    if (
      typeof value === "string"
      || typeof value === "boolean"
      || (typeof value === "number" && Number.isFinite(value))
    ) {
      serialized[field] = value;
      continue;
    }
    throw new TypeError(`Legacy reaction field '${field}' must be a JSON primitive.`);
  }

  const chainRef = rawContext.chainRef ?? rawContext.falloutMawSystemEventChainRef;
  if (chainRef !== undefined && chainRef !== null) serialized.chainRef = serializeChainRef(chainRef);
  return serializeSystemEventPayload(serialized);
}

function serializeChainRef(value) {
  if (!isPlainObject(value)) throw new TypeError("Legacy reaction chainRef must be a plain object.");
  const version = Number(value.version);
  if (!Number.isInteger(version) || version < 1) throw new TypeError("Legacy reaction chainRef version is invalid.");
  const rootId = requiredString(value.rootId, "rootId");
  return {
    version,
    rootId,
    leaseId: optionalString(value.leaseId, "leaseId"),
    parentEventId: optionalString(value.parentEventId, "parentEventId") || null,
    executionToken: optionalString(value.executionToken, "executionToken")
  };
}

function requiredString(value, field) {
  const normalized = optionalString(value, field);
  if (!normalized) throw new TypeError(`Legacy reaction chainRef ${field} is required.`);
  return normalized;
}

function optionalString(value, field) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new TypeError(`Legacy reaction chainRef ${field} must be a string.`);
  return value.trim();
}

function isPlainObject(value) {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export const LEGACY_REACTION_CONTEXT_TESTING = Object.freeze({
  fields: LEGACY_CONTEXT_FIELDS
});
