export const PRESET_FORMAT = "fallout-maw-settings-preset";
export const PRESET_SCHEMA_VERSION = 1;
export const MAIN_PRESET_ID = "fallout-maw";

const SYSTEM_ID = "fallout-maw";
const REVISION_PATTERN = /^[a-f0-9]{64}$/;
const PRESET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SETTING_ID_PATTERN = /^fallout-maw\.[^\s.][^\s]*$/;
const MAX_PRESET_NAME_LENGTH = 200;

const DOCUMENT_KEYS = new Set([
  "format",
  "schemaVersion",
  "version",
  "system",
  "systemId",
  "id",
  "name",
  "revision",
  "updatedAt",
  "systemVersion",
  "seedPending",
  "deleted",
  "saves",
  "settings"
]);

const SETTING_KEYS = new Set(["id", "scope", "value"]);
const SAVE_KEYS = new Set(["id", "name", "revision", "createdAt", "systemVersion", "settings"]);

const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

/**
 * Serialize a JSON value with lexicographically sorted object keys.
 * Unsupported JSON values are rejected instead of being silently discarded.
 */
export function canonicalStringify(value) {
  const ancestors = new Set();

  const encode = (current, path) => {
    if (current === null) return "null";

    switch (typeof current) {
      case "string":
      case "boolean":
        return JSON.stringify(current);
      case "number":
        if (!Number.isFinite(current)) {
          throw new TypeError(`Value at ${path} must be a finite JSON number.`);
        }
        return JSON.stringify(current);
      case "undefined":
      case "bigint":
      case "symbol":
      case "function":
        throw new TypeError(`Value at ${path} is not JSON-safe.`);
      default:
        break;
    }

    if (ancestors.has(current)) {
      throw new TypeError(`Value at ${path} contains a circular reference.`);
    }
    ancestors.add(current);

    let result;
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) {
        if (!Object.hasOwn(current, index)) {
          ancestors.delete(current);
          throw new TypeError(`Value at ${path}[${index}] contains a sparse array slot.`);
        }
      }
      result = `[${current.map((entry, index) => encode(entry, `${path}[${index}]`)).join(",")}]`;
    } else {
      assertPlainRecord(current, `Value at ${path}`);
      if (Object.getOwnPropertySymbols(current).length > 0) {
        ancestors.delete(current);
        throw new TypeError(`Value at ${path} contains symbol keys.`);
      }
      const keys = Object.keys(current).sort(compareText);
      result = `{${keys.map(key => `${JSON.stringify(key)}:${encode(current[key], `${path}.${key}`)}`).join(",")}}`;
    }

    ancestors.delete(current);
    return result;
  };

  return encode(value, "$");
}

/**
 * Compute the canonical preset revision. Volatile metadata never affects it.
 */
export async function computePresetRevision(preset) {
  return computePresetRevisionSync(preset);
}

/**
 * Validate and normalize a current preset document. Legacy baseline snapshots
 * are accepted only when explicitly requested.
 */
export function normalizePresetDocument(raw, { allowLegacy = false, name } = {}) {
  assertPlainRecord(raw, "Preset document");

  if (allowLegacy && !Object.hasOwn(raw, "format") && isPlainRecord(raw.settings)) {
    return convertLegacyBaseline(raw, {
      id: raw.id ?? MAIN_PRESET_ID,
      name: raw.name ?? name ?? (raw.id === MAIN_PRESET_ID ? "Fallout-MaW" : "Imported preset")
    });
  }

  assertOnlyKeys(raw, DOCUMENT_KEYS, "Preset document");

  if (raw.format !== PRESET_FORMAT) {
    throw new TypeError(`Preset format must be ${PRESET_FORMAT}.`);
  }

  const schemaVersion = raw.schemaVersion ?? (allowLegacy ? raw.version : undefined);
  if (schemaVersion !== PRESET_SCHEMA_VERSION) {
    throw new TypeError(`Preset schemaVersion must be ${PRESET_SCHEMA_VERSION}.`);
  }

  const systemId = normalizeSystemId(raw);
  const id = normalizePresetId(raw.id);
  const normalizedName = normalizePresetName(raw.name ?? name);
  const deleted = normalizeOptionalBoolean(raw.deleted, "deleted", false);
  const seedPending = normalizeOptionalBoolean(raw.seedPending, "seedPending", false);

  if (deleted && id === MAIN_PRESET_ID) {
    throw new TypeError("The main Fallout-MaW preset cannot be a tombstone.");
  }
  if (deleted && seedPending) {
    throw new TypeError("A tombstone cannot be marked as a pending seed.");
  }

  const settings = normalizeSettings(raw.settings, { deleted });
  const saves = normalizePresetSaves(raw.saves, { deleted });
  const systemVersion = normalizeSystemVersion(raw.systemVersion);
  const updatedAt = normalizeUpdatedAt(raw.updatedAt);
  const suppliedRevision = normalizeRevision(raw.revision);

  const normalized = {
    format: PRESET_FORMAT,
    schemaVersion: PRESET_SCHEMA_VERSION,
    systemId,
    id,
    name: normalizedName,
    revision: null,
    updatedAt,
    systemVersion,
    seedPending,
    deleted,
    settings,
    ...(saves.length || Object.hasOwn(raw, "saves") ? { saves } : {})
  };

  const computedRevision = computePresetRevisionSync(normalized);
  if (suppliedRevision && suppliedRevision !== computedRevision) {
    throw new TypeError(`Preset ${id} has an invalid revision.`);
  }
  normalized.revision = suppliedRevision ?? computedRevision;
  return normalized;
}

/** Create a complete current-schema preset document. */
export function createPresetDocument({
  id,
  name,
  settings,
  saves = [],
  systemVersion = null,
  seedPending = false
}) {
  return normalizePresetDocument({
    format: PRESET_FORMAT,
    schemaVersion: PRESET_SCHEMA_VERSION,
    systemId: SYSTEM_ID,
    id,
    name,
    updatedAt: new Date().toISOString(),
    systemVersion,
    seedPending,
    deleted: false,
    settings,
    ...(saves.length ? { saves } : {})
  });
}

/** Create a deletion marker which retains a preset's stable identity. */
export function createPresetTombstone(preset) {
  const source = normalizePresetDocument(preset);
  if (source.id === MAIN_PRESET_ID) {
    throw new TypeError("The main Fallout-MaW preset cannot be deleted.");
  }

  return normalizePresetDocument({
    format: PRESET_FORMAT,
    schemaVersion: PRESET_SCHEMA_VERSION,
    systemId: SYSTEM_ID,
    id: source.id,
    name: source.name,
    updatedAt: new Date().toISOString(),
    systemVersion: source.systemVersion,
    seedPending: false,
    deleted: true,
    settings: []
  });
}

/** Clone the main preset into a new stable preset identity. */
export function clonePresetFromMain(main, { id, name }) {
  const source = normalizePresetDocument(main);
  if (source.id !== MAIN_PRESET_ID || source.deleted) {
    throw new TypeError("Only the live main Fallout-MaW preset can be cloned.");
  }
  const cloneId = normalizePresetId(id);
  if (cloneId === MAIN_PRESET_ID) {
    throw new TypeError("A cloned preset must use a new id.");
  }

  return createPresetDocument({
    id: cloneId,
    name,
    settings: source.settings,
    systemVersion: source.systemVersion,
    seedPending: false
  });
}

/** Create an immutable named snapshot inside a preset. */
export function createPresetSave({ id, name, settings, systemVersion = null, createdAt = new Date().toISOString() }) {
  const normalized = normalizePresetSave({ id, name, settings, systemVersion, createdAt }, 0);
  return { ...normalized, revision: computePresetSaveRevision(normalized) };
}

/**
 * Merge portable system files with world backups. System documents (including
 * tombstones) are authoritative for matching ids. World-only documents are
 * retained and explicitly identified for restoration to system storage.
 */
export function reconcilePresetSources({ systemPresets = [], worldPresets = [] } = {}) {
  const system = normalizePresetCollection(systemPresets, "systemPresets");
  const world = normalizePresetCollection(worldPresets, "worldPresets");
  const reconciled = new Map();

  for (const preset of system.values()) {
    reconciled.set(preset.id, {
      preset,
      source: "system",
      restoreToSystem: false
    });
  }

  const restoreToSystem = [];
  for (const preset of world.values()) {
    if (system.has(preset.id)) continue;
    reconciled.set(preset.id, {
      preset,
      source: "world",
      restoreToSystem: true
    });
    restoreToSystem.push(preset);
  }

  const presets = Array.from(reconciled.values())
    .sort((left, right) => compareText(left.preset.id, right.preset.id));
  restoreToSystem.sort((left, right) => compareText(left.id, right.id));

  return { presets, restoreToSystem };
}

/** Convert an exported settings baseline into a new world-only preset. */
export function convertLegacyBaseline(raw, { id, name }) {
  assertPlainRecord(raw, "Legacy settings baseline");
  normalizeSystemId(raw);
  assertPlainRecord(raw.settings, "Legacy settings baseline.settings");

  const settings = [];
  for (const [settingId, entry] of Object.entries(raw.settings).sort(([left], [right]) => compareText(left, right))) {
    if (!settingId.startsWith(`${SYSTEM_ID}.`)) continue;
    if (!isPlainRecord(entry) || entry.scope !== "world" || !Object.hasOwn(entry, "value")) continue;
    settings.push({ id: settingId, scope: "world", value: entry.value });
  }

  return createPresetDocument({
    id,
    name,
    settings,
    systemVersion: raw.systemVersion ?? null,
    seedPending: false
  });
}

function normalizeSettings(rawSettings, { deleted }) {
  if (!Array.isArray(rawSettings)) {
    throw new TypeError("Preset settings must be an array.");
  }
  if (deleted && rawSettings.length > 0) {
    throw new TypeError("A preset tombstone cannot contain settings.");
  }

  const ids = new Set();
  const settings = rawSettings.map((raw, index) => {
    assertPlainRecord(raw, `Preset settings[${index}]`);
    assertOnlyKeys(raw, SETTING_KEYS, `Preset settings[${index}]`);

    if (typeof raw.id !== "string" || !SETTING_ID_PATTERN.test(raw.id)) {
      throw new TypeError(`Preset settings[${index}].id must be a ${SYSTEM_ID} setting id.`);
    }
    if (ids.has(raw.id)) {
      throw new TypeError(`Preset settings contains duplicate id ${raw.id}.`);
    }
    ids.add(raw.id);

    if (raw.scope !== "world") {
      throw new TypeError(`Preset setting ${raw.id} must use world scope.`);
    }
    if (!Object.hasOwn(raw, "value")) {
      throw new TypeError(`Preset setting ${raw.id} must contain a value.`);
    }

    return {
      id: raw.id,
      scope: "world",
      value: cloneJsonValue(raw.value, `Preset setting ${raw.id}.value`)
    };
  });

  return settings.sort((left, right) => compareText(left.id, right.id));
}

function normalizePresetSaves(rawSaves, { deleted }) {
  if (rawSaves === undefined) return [];
  if (!Array.isArray(rawSaves)) throw new TypeError("Preset saves must be an array.");
  if (deleted && rawSaves.length) throw new TypeError("A preset tombstone cannot contain saves.");
  const ids = new Set();
  return rawSaves.map((raw, index) => {
    const save = normalizePresetSave(raw, index);
    if (ids.has(save.id)) throw new TypeError(`Preset saves contains duplicate id ${save.id}.`);
    ids.add(save.id);
    return save;
  });
}

function normalizePresetSave(raw, index) {
  assertPlainRecord(raw, `Preset saves[${index}]`);
  assertOnlyKeys(raw, SAVE_KEYS, `Preset saves[${index}]`);
  const save = {
    id: normalizePresetId(raw.id),
    name: normalizePresetName(raw.name),
    revision: null,
    createdAt: normalizeUpdatedAt(raw.createdAt),
    systemVersion: normalizeSystemVersion(raw.systemVersion),
    settings: normalizeSettings(raw.settings, { deleted: false })
  };
  if (!save.createdAt) throw new TypeError(`Preset saves[${index}].createdAt is required.`);
  const suppliedRevision = normalizeRevision(raw.revision);
  const revision = computePresetSaveRevision(save);
  if (suppliedRevision && suppliedRevision !== revision) {
    throw new TypeError(`Preset save ${save.id} has an invalid revision.`);
  }
  save.revision = suppliedRevision ?? revision;
  return save;
}

function computePresetSaveRevision(save) {
  const stable = {};
  for (const key of Object.keys(save)) {
    if (key === "revision") continue;
    stable[key] = save[key];
  }
  return sha256Hex(canonicalStringify(stable));
}

function normalizePresetCollection(rawCollection, label) {
  if (!Array.isArray(rawCollection)) {
    throw new TypeError(`${label} must be an array.`);
  }

  const normalized = new Map();
  for (const raw of rawCollection) {
    const preset = normalizePresetDocument(raw);
    if (normalized.has(preset.id)) {
      throw new TypeError(`${label} contains duplicate preset id ${preset.id}.`);
    }
    normalized.set(preset.id, preset);
  }
  return normalized;
}

function normalizeSystemId(raw) {
  const system = raw.system;
  const systemId = raw.systemId;
  if (system !== undefined && systemId !== undefined && system !== systemId) {
    throw new TypeError("Preset system and systemId must match.");
  }
  const value = systemId ?? system;
  if (value !== SYSTEM_ID) {
    throw new TypeError(`Preset systemId must be ${SYSTEM_ID}.`);
  }
  return SYSTEM_ID;
}

function normalizePresetId(value) {
  if (typeof value !== "string" || !PRESET_ID_PATTERN.test(value)) {
    throw new TypeError("Preset id must be a safe non-empty file id.");
  }
  return value;
}

function normalizePresetName(value) {
  if (typeof value !== "string") {
    throw new TypeError("Preset name must be a string.");
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_PRESET_NAME_LENGTH || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new TypeError(`Preset name must contain 1-${MAX_PRESET_NAME_LENGTH} printable characters.`);
  }
  return normalized;
}

function normalizeSystemVersion(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError("Preset systemVersion must be a non-empty string or null.");
  }
  return value.trim();
}

function normalizeUpdatedAt(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError("Preset updatedAt must be an ISO date string or null.");
  }
  return new Date(value).toISOString();
}

function normalizeRevision(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !REVISION_PATTERN.test(value)) {
    throw new TypeError("Preset revision must be a lowercase SHA-256 hex digest.");
  }
  return value;
}

function normalizeOptionalBoolean(value, key, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new TypeError(`Preset ${key} must be a boolean.`);
  }
  return value;
}

function cloneJsonValue(value, label) {
  try {
    return JSON.parse(canonicalStringify(value));
  } catch (error) {
    throw new TypeError(`${label} is not JSON-safe: ${error.message}`, { cause: error });
  }
}

function computePresetRevisionSync(preset) {
  assertPlainRecord(preset, "Preset revision input");
  const stable = {};
  for (const key of Object.keys(preset)) {
    if (key === "revision" || key === "updatedAt") continue;
    stable[key] = preset[key];
  }
  return sha256Hex(canonicalStringify(stable));
}

function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const data = new Uint8Array(paddedLength);
  data.set(bytes);
  data[bytes.length] = 0x80;

  let bitLength = BigInt(bytes.length) * 8n;
  for (let offset = 0; offset < 8; offset += 1) {
    data[data.length - 1 - offset] = Number(bitLength & 0xffn);
    bitLength >>= 8n;
  }

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const words = new Uint32Array(64);

  for (let chunk = 0; chunk < data.length; chunk += 64) {
    const view = new DataView(data.buffer, data.byteOffset + chunk, 64);
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const word15 = words[index - 15];
      const word2 = words[index - 2];
      const sigma0 = rotateRight(word15, 7) ^ rotateRight(word15, 18) ^ (word15 >>> 3);
      const sigma1 = rotateRight(word2, 17) ^ rotateRight(word2, 19) ^ (word2 >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temporary1 = (h + sum1 + choose + SHA256_CONSTANTS[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map(word => word.toString(16).padStart(8, "0"))
    .join("");
}

function rotateRight(value, count) {
  return (value >>> count) | (value << (32 - count));
}

function assertPlainRecord(value, label) {
  if (!isPlainRecord(value)) {
    throw new TypeError(`${label} must be a plain object.`);
  }
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertOnlyKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${label} contains unsupported key ${key}.`);
    }
  }
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
