import { FALLOUT_MAW } from "../../config/system-config.mjs";
import { SYSTEM_ID, SYSTEM_TITLE } from "../../constants.mjs";
import { SETTINGS_PRESET_STATE_SETTING } from "../constants.mjs";
import {
  MAIN_PRESET_ID,
  PRESET_FORMAT,
  clonePresetFromMain,
  convertLegacyBaseline,
  createPresetDocument,
  normalizePresetDocument,
  reconcilePresetSources
} from "./schema.mjs";

const PRESET_SOCKET = `system.${SYSTEM_ID}`;
const PRESET_QUERY = `${SYSTEM_ID}.settingsPresets`;
const SOCKET_KIND = "settings-presets";
const SYSTEM_PRESET_DIRECTORY = `systems/${SYSTEM_ID}/storage/settings-presets`;
const APPLY_MARKER = "falloutMaWSettingsPresetApply";
const APPLY_BATCH_ID = "falloutMaWSettingsPresetBatchId";
const APPLY_BATCH_SIZE = "falloutMaWSettingsPresetBatchSize";
const APPLY_ORIGIN_CLIENT = "falloutMaWSettingsPresetOriginClient";
const MATERIALIZE_MARKER = "falloutMaWSettingsPresetMaterialize";
const STATE_MARKER = "falloutMaWSettingsPresetState";
const AUTOSAVE_DELAY = 300;
const RPC_TIMEOUT = 30_000;
const CLIENT_LEADER_RETRY_DELAY = 500;
const MIGRATION_VERSION = 1;
const MIGRATION_SEED_PRESET_ID = "fallout-maw-migration-seed";
const CLIENT_INSTANCE_ID = globalThis.crypto?.randomUUID?.()
  ?? `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const runtime = {
  ready: false,
  autosaveEnabled: false,
  busy: false,
  hooksRegistered: false,
  socketRegistered: false,
  wrappedChanges: false,
  presets: new Map(),
  descriptors: new Map(),
  sourceSystem: new Map(),
  sourceWorld: new Map(),
  migrationSeed: null,
  legacyRemovedPresetIds: new Set(),
  lastError: "",
  autosaveTimer: null,
  autosaveDirty: false,
  applyCallbacks: new Map(),
  applyEffectFlags: { actors: false, naturalRace: false, combatCarousel: false },
  applyBatches: new Map(),
  applyEffectsQueue: Promise.resolve(),
  deferredApplyEffects: false,
  pendingDocument: null,
  retryTimer: null,
  mutationQueue: Promise.resolve(),
  primaryClientLeader: true,
  primaryClientLockPending: false,
  primaryClientLockRelease: null,
  primaryClientRetryTimer: null
};

const api = Object.freeze({
  list: listSettingsPresets,
  get: getSettingsPreset,
  active: getActiveSettingsPreset,
  status: getSettingsPresetStatus,
  create: createSettingsPreset,
  activate: activateSettingsPreset,
  rename: renameSettingsPreset,
  remove: removeSettingsPreset,
  import: importSettingsPreset,
  importFile: importSettingsPreset,
  export: exportSettingsPreset,
  refresh: refreshSettingsPresets,
  flush: flushSettingsPreset
});

/** Register the public API and document listeners during init. */
export function registerSettingsPresetTools() {
  FALLOUT_MAW.settingsPresets = api;
  if (globalThis.CONFIG?.FalloutMaW) CONFIG.FalloutMaW.settingsPresets = api;
  if (globalThis.CONFIG?.queries) CONFIG.queries[PRESET_QUERY] = handlePresetUserQuery;
  if (runtime.hooksRegistered) return;
  runtime.hooksRegistered = true;
  Hooks.on("createSetting", onSettingCreated);
  Hooks.on("updateSetting", onSettingUpdated);
}

/**
 * Load, reconcile, migrate, and (when needed) apply settings presets.
 * This must run before the rest of the system's ready-time initialization.
 */
export async function initializeSettingsPresets() {
  registerSettingsPresetTools();
  registerPresetSocket();
  wrapManagedSettingOnChanges();
  runtime.busy = true;
  runtime.lastError = "";
  try {
    if (!game.user?.isGM) {
      runtime.ready = true;
      return api;
    }
    await initializePrimaryClientLeadership();
    await loadPresetSources();
    if (isPrimaryGM()) await enqueueMutation(initializePrimaryGM);
    runtime.ready = true;
    Hooks.callAll(`${SYSTEM_ID}.settingsPresetsReady`, api);
    return api;
  } catch (error) {
    runtime.lastError = errorMessage(error);
    console.error(`${SYSTEM_TITLE} | Failed to initialize settings presets`, error);
    if (game.user?.isGM) ui.notifications?.error?.(`${SYSTEM_TITLE}: ${runtime.lastError}`);
    throw error;
  } finally {
    runtime.busy = false;
  }
}

/** Enable change capture after the system's own ready-time migrations finish. */
export async function finalizeSettingsPresetStartup() {
  const hasDeferredApplyEffects = runtime.deferredApplyEffects;
  runtime.autosaveEnabled = true;
  if (hasDeferredApplyEffects) {
    runtime.deferredApplyEffects = false;
    await enqueuePresetApplyEffects({ skipCoreEffects: true });
  }
  if (!isPrimaryGM()) return null;
  return enqueueMutation(async () => {
    try {
      const preset = await flushActivePresetLocal();
      if (preset) broadcastPresetChange();
      return preset;
    } catch (error) {
      runtime.lastError = errorMessage(error);
      console.error(`${SYSTEM_TITLE} | Failed to finalize settings preset startup`, error);
      ui.notifications?.error?.(`${SYSTEM_TITLE}: ${runtime.lastError}`);
      return null;
    }
  });
}

/** Return the main preset value used by reset actions after ready. */
export function getMainPresetDefault(key, fallback, { namespace = SYSTEM_ID } = {}) {
  const main = runtime.presets.get(MAIN_PRESET_ID);
  const fullId = String(key ?? "").includes(".") ? String(key) : `${namespace}.${key}`;
  const entry = main?.settings?.find(candidate => candidate.id === fullId);
  return cloneValue(entry && Object.hasOwn(entry, "value") ? entry.value : fallback);
}

/** True only for registrations deliberately opted into portable presets. */
export function isPresetManagedSetting(setting) {
  return Boolean(setting
    && setting.namespace === SYSTEM_ID
    && setting.scope === "world"
    && setting.preset === true);
}

export function createDefaultSettingsPresetState() {
  return {
    migrationVersion: 0,
    migrationPresetId: "",
    migrationFinalizeMain: false,
    removedPresetIds: [],
    activePresetId: "",
    appliedRevision: "",
    appliedManagedSignature: "",
    pendingPresetId: "",
    pendingRevision: "",
    pendingTarget: "",
    pendingDocument: null,
    lastError: ""
  };
}

export function getManagedPresetSettings() {
  return Array.from(game.settings?.settings?.values?.() ?? [])
    .filter(isPresetManagedSetting)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function getManagedPresetSignature() {
  return JSON.stringify(getManagedPresetSettings().map(setting => ({
    id: setting.id,
    type: settingTypeSignature(setting.type),
    defaultShape: jsonValueShape(setting.default),
    defaultRevision: compactJsonSignature(setting.default),
    choices: registeredChoiceKeys(setting),
    rangeRevision: compactJsonSignature(setting.range ?? null)
  })));
}

export async function listSettingsPresets() {
  return Array.from(runtime.descriptors.values())
    .map(descriptor => describePreset(descriptor.preset))
    .sort((left, right) => {
      if (left.isMain !== right.isMain) return left.isMain ? -1 : 1;
      return left.name.localeCompare(right.name, game.i18n?.lang ?? undefined) || left.id.localeCompare(right.id);
    });
}

export async function getSettingsPreset(id) {
  const presetId = String(id ?? "");
  const preset = runtime.presets.get(presetId) ?? runtime.descriptors.get(presetId)?.preset;
  return preset ? cloneValue(sanitizePresetSettings(preset)) : null;
}

export async function getActiveSettingsPreset() {
  const id = getPresetState().activePresetId;
  const preset = runtime.presets.get(id);
  return preset ? describePreset(preset) : null;
}

export function getSettingsPresetStatus() {
  const state = getPresetState();
  return {
    ready: runtime.ready,
    busy: runtime.busy,
    activePresetId: state.activePresetId || "",
    appliedRevision: state.appliedRevision || "",
    pendingPresetId: state.pendingPresetId || "",
    pendingRevision: state.pendingRevision || "",
    pendingTarget: state.pendingTarget || "",
    lastError: runtime.lastError || state.lastError || "",
    primaryGM: getPrimaryGM()?.id ?? null,
    primaryClient: isPrimaryGM()
  };
}

export async function createSettingsPreset(nameOrOptions, options = {}) {
  if (nameOrOptions && typeof nameOrOptions === "object") {
    options = nameOrOptions;
    nameOrOptions = options.name;
  }
  const cleanName = normalizeName(nameOrOptions, game.world?.title || "Preset");
  return runMutation("create", [cleanName, normalizeMutationOptions(options)], async () => {
    await flushActivePresetLocal();
    const main = requirePreset(MAIN_PRESET_ID);
    const preset = clonePresetFromMain(main, {
      id: randomPresetId(),
      name: cleanName
    });
    await savePresetCopies(preset);
    if (options?.activate) await activatePresetLocal(preset.id);
    broadcastPresetChange();
    return cloneValue(preset);
  });
}

export async function activateSettingsPreset(id) {
  return runMutation("activate", [String(id ?? "")], async () => {
    const preset = await activatePresetLocal(String(id ?? ""));
    broadcastPresetChange();
    return cloneValue(preset);
  });
}

export async function renameSettingsPreset(id, name) {
  const presetId = String(id ?? "");
  const cleanName = normalizeName(name);
  return runMutation("rename", [presetId, cleanName], async () => {
    await flushActivePresetLocal();
    const current = requirePreset(presetId);
    const renamed = await rebuildPreset(current, { name: cleanName });
    await savePresetCopies(renamed);
    await updatePresetState({
      ...(getPresetState().activePresetId === presetId ? { appliedRevision: renamed.revision } : {}),
      ...(runtime.lastError ? {} : { lastError: "" })
    });
    broadcastPresetChange();
    return cloneValue(renamed);
  });
}

export async function removeSettingsPreset(id) {
  const presetId = String(id ?? "");
  return runMutation("remove", [presetId], async () => {
    if (presetId === MAIN_PRESET_ID) throw new Error("The Fallout-MaW preset cannot be deleted.");
    await flushActivePresetLocal();
    const current = requirePreset(presetId);
    if (getPresetState().activePresetId === presetId) await activatePresetLocal(MAIN_PRESET_ID, { skipFlush: true });
    const state = getPresetState();
    const removedPresetIds = normalizeRemovedPresetIds([...state.removedPresetIds, presetId]);
    if (state.pendingPresetId === presetId) {
      runtime.pendingDocument = null;
      clearTimeout(runtime.retryTimer);
      runtime.retryTimer = null;
    }
    await updatePresetState({
      removedPresetIds,
      ...(state.pendingPresetId === presetId ? {
        pendingPresetId: "",
        pendingRevision: "",
        pendingTarget: "",
        pendingDocument: null,
        lastError: ""
      } : {})
    });
    removeRuntimePreset(presetId);
    broadcastPresetChange();
    return { id: current.id, name: current.name, removed: true };
  });
}

export async function importSettingsPreset(input, options = {}) {
  let document = input;
  if (isFileLike(input)) {
    const text = await foundry.utils.readTextFromFile(input);
    document = JSON.parse(text);
  } else if (typeof input === "string") {
    document = JSON.parse(input);
  }
  const activate = options?.activate !== false;
  let imported = isLegacyBaseline(document)
    ? convertLegacyBaseline(document, {
      id: randomPresetId(),
      name: normalizeName(options?.name, legacyPresetName(document)),
      systemVersion: game.system?.version ?? null
    })
    : normalizePresetDocument(document);
  if (isLegacyBaseline(document)) {
    const managed = new Set(getManagedPresetSettings().map(setting => setting.id));
    imported = createPresetDocument({
      ...imported,
      settings: imported.settings.filter(entry => managed.has(entry.id)),
      systemVersion: game.system?.version ?? imported.systemVersion ?? null
    });
  }
  if (imported.id === MIGRATION_SEED_PRESET_ID) {
    throw new Error("The internal migration seed cannot be imported or replaced.");
  }
  if (imported.deleted) {
    throw new Error("Portable preset deletion markers are no longer supported.");
  }
  imported = sanitizePresetSettings(imported);
  return runMutation("importDocument", [imported, { activate }], async () => {
    let preset = normalizePresetDocument(imported);
    assertNoPresetIdCaseCollision(preset.id, runtime.descriptors.keys());
    preset = validatePresetForStorage(preset);
    await flushActivePresetLocal();
    const state = getPresetState();
    if (state.removedPresetIds.includes(preset.id)) {
      await updatePresetState({
        removedPresetIds: state.removedPresetIds.filter(id => id !== preset.id)
      });
    }
    const wasActive = getPresetState().activePresetId === preset.id;
    await savePresetCopies(preset);
    const result = activate || wasActive
      ? await activatePresetLocal(preset.id, { skipFlush: true })
      : preset;
    broadcastPresetChange();
    return cloneValue(result);
  });
}

export async function exportSettingsPreset(id) {
  const presetId = String(id ?? "");
  if (getPresetState().activePresetId === presetId) await flushSettingsPreset();
  const preset = sanitizePresetSettings(requirePreset(presetId));
  const data = cloneValue(preset);
  foundry.utils.saveDataToFile(
    JSON.stringify(data, null, 2),
    "application/json",
    `${slugifyName(data.name) || data.id}-${data.id}.json`
  );
  return data;
}

export async function refreshSettingsPresets(options = {}) {
  return runMutation("refresh", [normalizeMutationOptions(options)], async () => {
    clearTimeout(runtime.autosaveTimer);
    runtime.autosaveTimer = null;
    if (runtime.autosaveDirty) await flushActivePresetLocal();
    const beforeState = getPresetState();
    const beforeRevision = runtime.presets.get(beforeState.activePresetId)?.revision ?? "";
    await loadPresetSources();
    if (getPresetState().pendingPresetId) {
      await reconcilePendingWrite();
      if (getPresetState().pendingPresetId) {
        throw new Error("A pending settings preset file could not be synchronized during refresh.");
      }
    }
    await restoreUniqueWorldPresets();
    const afterPreset = runtime.presets.get(beforeState.activePresetId);
    const authoritative = runtime.sourceSystem.get(beforeState.activePresetId);
    const externalActiveChanged = !afterPreset
      || Boolean(beforeRevision && authoritative?.revision === afterPreset.revision && afterPreset.revision !== beforeRevision);
    if (externalActiveChanged) await applyActiveRevisionIfNeeded();
    else await flushActivePresetLocal();
    await backupSystemPresetsToWorld();
    broadcastPresetChange();
    return listSettingsPresets();
  });
}

export async function flushSettingsPreset() {
  return runMutation("flush", [], async () => {
    const preset = await flushActivePresetLocal();
    broadcastPresetChange();
    return preset ? cloneValue(preset) : null;
  });
}

async function initializePrimaryGM() {
  await adoptLegacyLocalRemovals();
  if (getPresetState().pendingPresetId) {
    await reconcilePendingWrite();
    if (getPresetState().pendingPresetId) {
      throw new Error("A pending settings preset file could not be recovered during startup.");
    }
  }
  await restoreUniqueWorldPresets();
  await backupSystemPresetsToWorld();

  const state = getPresetState();
  if (Number(state.migrationVersion || 0) < MIGRATION_VERSION) await migrateExistingWorld();
  else await applyActiveRevisionIfNeeded();

  const nextState = getPresetState();
  if (nextState.pendingPresetId) await reconcilePendingWrite();
}

async function loadPresetSources() {
  const [systemDocuments, worldDocuments] = await Promise.all([
    readPresetDirectory(SYSTEM_PRESET_DIRECTORY, { required: true }),
    readPresetDirectory(getWorldPresetDirectory(), { required: false })
  ]);
  const rawSystem = indexPresetDocuments(systemDocuments);
  const rawWorld = indexPresetDocuments(worldDocuments);
  assertNoPresetSourceCaseCollisions([...rawSystem.keys(), ...rawWorld.keys()]);
  runtime.legacyRemovedPresetIds = new Set(
    [...rawWorld.values()]
      .filter(preset => preset.deleted && preset.id !== MAIN_PRESET_ID)
      .map(preset => preset.id)
  );
  const removedPresetIds = new Set([
    ...getPresetState().removedPresetIds,
    ...runtime.legacyRemovedPresetIds
  ]);
  const isVisibleSource = preset => preset.id === MIGRATION_SEED_PRESET_ID
    || (!preset.deleted && !removedPresetIds.has(preset.id));
  runtime.sourceSystem = new Map([...rawSystem].filter(([, preset]) => isVisibleSource(preset)));
  runtime.sourceWorld = new Map([...rawWorld].filter(([, preset]) => isVisibleSource(preset)));

  const pending = getPresetState();
  if (pending.pendingPresetId && pending.pendingRevision && pending.pendingTarget !== "world") {
    const worldPending = runtime.sourceWorld.get(pending.pendingPresetId);
    if (worldPending?.revision === pending.pendingRevision) runtime.sourceSystem.delete(pending.pendingPresetId);
  }

  const reconciled = reconcilePresetSources({
    systemPresets: Array.from(runtime.sourceSystem.values()),
    worldPresets: Array.from(runtime.sourceWorld.values())
  });
  runtime.presets.clear();
  runtime.descriptors.clear();
  runtime.migrationSeed = null;
  for (const descriptor of reconciled.presets ?? []) {
    const preset = normalizePresetDocument(descriptor.preset ?? descriptor);
    if (preset.id === MIGRATION_SEED_PRESET_ID) {
      if (preset.deleted) throw new Error("The internal settings migration seed cannot be deleted.");
      runtime.migrationSeed = preset;
      continue;
    }
    const source = descriptor.source ?? "system";
    runtime.descriptors.set(preset.id, {
      preset,
      source,
      restoreToSystem: Boolean(descriptor.restoreToSystem),
      syncState: descriptor.restoreToSystem ? "world-only" : "synced"
    });
    runtime.presets.set(preset.id, preset);
  }
  runtime.restoreToSystem = (reconciled.restoreToSystem ?? []).map(normalizePresetDocument);
  const pendingDocument = pending.pendingDocument;
  if (pending.pendingPresetId
      && pending.pendingRevision
      && pendingDocument?.id === pending.pendingPresetId
      && pendingDocument.revision === pending.pendingRevision
      && !pendingDocument.deleted
      && !removedPresetIds.has(pendingDocument.id)) {
    runtime.restoreToSystem = runtime.restoreToSystem.filter(preset => preset.id !== pendingDocument.id);
    if (pendingDocument.id === MIGRATION_SEED_PRESET_ID) runtime.migrationSeed = pendingDocument;
    else {
      runtime.presets.set(pendingDocument.id, pendingDocument);
      runtime.descriptors.set(pendingDocument.id, {
        preset: pendingDocument,
        source: "pending",
        restoreToSystem: false,
        syncState: "pending"
      });
    }
  }
  if (!runtime.presets.has(MAIN_PRESET_ID)) {
    throw new Error(`Required settings preset ${MAIN_PRESET_ID} was not found.`);
  }
  if (Number(getPresetState().migrationVersion || 0) < MIGRATION_VERSION && !runtime.migrationSeed) {
    throw new Error("The immutable Fallout-MaW migration seed was not found.");
  }
}

async function adoptLegacyLocalRemovals() {
  if (!runtime.legacyRemovedPresetIds.size) return false;
  const state = getPresetState();
  const removedPresetIds = normalizeRemovedPresetIds([
    ...state.removedPresetIds,
    ...runtime.legacyRemovedPresetIds
  ]);
  runtime.legacyRemovedPresetIds.clear();
  if (removedPresetIds.length === state.removedPresetIds.length
      && removedPresetIds.every((id, index) => id === state.removedPresetIds[index])) return false;
  await updatePresetState({ removedPresetIds });
  return true;
}

async function restoreUniqueWorldPresets() {
  for (const rawPreset of runtime.restoreToSystem ?? []) {
    const preset = sanitizePresetSettings(rawPreset);
    try {
      await writeSystemPreset(preset);
      runtime.sourceSystem.set(preset.id, preset);
      setRuntimePreset(preset, "system+world");
    } catch (error) {
      runtime.lastError = errorMessage(error);
      const descriptor = runtime.descriptors.get(preset.id);
      if (descriptor) descriptor.syncState = "error";
      console.error(`${SYSTEM_TITLE} | Failed to restore world preset ${preset.id} to system storage`, error);
    }
  }
  runtime.restoreToSystem = [];
}

async function backupSystemPresetsToWorld() {
  for (const rawPreset of runtime.sourceSystem.values()) {
    const preset = sanitizePresetSettings(rawPreset);
    if (preset.id === MIGRATION_SEED_PRESET_ID) continue;
    const backup = runtime.sourceWorld.get(preset.id);
    if (backup?.revision === preset.revision) {
      const descriptor = runtime.descriptors.get(preset.id);
      if (descriptor) {
        descriptor.source = "system+world";
        descriptor.syncState = "synced";
      }
      continue;
    }
    try {
      await writeWorldPreset(preset);
      runtime.sourceWorld.set(preset.id, preset);
      const descriptor = runtime.descriptors.get(preset.id);
      if (descriptor) {
        descriptor.source = "system+world";
        descriptor.syncState = "synced";
      }
    } catch (error) {
      runtime.lastError = errorMessage(error);
      const descriptor = runtime.descriptors.get(preset.id);
      if (descriptor) descriptor.syncState = "error";
      console.error(`${SYSTEM_TITLE} | Failed to back up preset ${preset.id} into the world`, error);
    }
  }
}

async function reconcilePendingWrite() {
  const state = getPresetState();
  if (!state.pendingPresetId || !state.pendingRevision) return false;
  const target = state.pendingTarget || "system";
  const candidates = target === "world"
    ? [runtime.sourceSystem.get(state.pendingPresetId), state.pendingDocument]
    : (target === "system"
      ? [runtime.sourceWorld.get(state.pendingPresetId), state.pendingDocument]
      : [state.pendingDocument, runtime.sourceWorld.get(state.pendingPresetId), runtime.sourceSystem.get(state.pendingPresetId)]);
  const pending = candidates.find(candidate => candidate?.revision === state.pendingRevision);
  if (!pending) {
    clearPendingPresetRetry();
    await updatePresetState({
      pendingPresetId: "",
      pendingRevision: "",
      pendingTarget: "",
      pendingDocument: null,
      lastError: "Pending preset backup is unavailable."
    });
    return false;
  }
  try {
    if (target === "world") {
      await writeWorldPreset(pending);
      runtime.sourceWorld.set(pending.id, pending);
    } else {
      await writeSystemPreset(pending);
      runtime.sourceSystem.set(pending.id, pending);
      if (target === "both") {
        await writeWorldPreset(pending);
        runtime.sourceWorld.set(pending.id, pending);
      }
    }
    setRuntimePreset(pending, "system+world");
    await updatePresetState({
      pendingPresetId: "",
      pendingRevision: "",
      pendingTarget: "",
      pendingDocument: null,
      lastError: ""
    });
    clearPendingPresetRetry();
    runtime.lastError = "";
    return true;
  } catch (error) {
    runtime.lastError = errorMessage(error);
    await updatePresetState({ lastError: runtime.lastError });
    return false;
  }
}

async function migrateExistingWorld() {
  const main = requirePreset(MAIN_PRESET_ID);
  const migrationState = getPresetState();
  const isExistingWorld = isExistingWorldForPresetMigration();
  const currentEntries = captureCurrentSettings({
    useStoredOnly: true,
    fallbackPreset: runtime.migrationSeed ?? main
  });
  const worldName = normalizeName(game.world?.title, game.world?.id || "World");
  let personal = null;
  const finalizeMainSeed = Boolean(main.seedPending || migrationState.migrationFinalizeMain);

  if (isExistingWorld) {
    const personalId = migrationState.migrationPresetId || randomPresetId();
    if (!migrationState.migrationPresetId || migrationState.migrationFinalizeMain !== finalizeMainSeed) {
      await updatePresetState({
        migrationPresetId: personalId,
        migrationFinalizeMain: finalizeMainSeed
      });
    }
    personal = await makePreset({
      id: personalId,
      name: worldName,
      settings: currentEntries
    });
    await savePresetCopies(personal);
  }

  let activeId = MAIN_PRESET_ID;
  let activePreset = main;
  if (finalizeMainSeed && isExistingWorld) {
    activePreset = await makePreset({
      ...main,
      id: MAIN_PRESET_ID,
      name: main.name || "Fallout-MaW",
      seedPending: false,
      deleted: false,
      settings: currentEntries
    });
    await savePresetCopies(activePreset);
  } else if (personal) {
    activeId = personal.id;
    activePreset = personal;
  }

  await applyPresetAtomically(activePreset, {
    statePatch: {
      migrationVersion: MIGRATION_VERSION,
      migrationPresetId: "",
      migrationFinalizeMain: false,
      activePresetId: activeId,
      appliedRevision: activePreset.revision,
      ...(runtime.lastError ? {} : { lastError: "" })
    }
  });
}

async function applyActiveRevisionIfNeeded() {
  const state = getPresetState();
  let activeId = state.activePresetId || MAIN_PRESET_ID;
  let preset = runtime.presets.get(activeId);
  if (!preset) {
    activeId = MAIN_PRESET_ID;
    preset = requirePreset(MAIN_PRESET_ID);
  }
  const worldStorage = game.settings.storage.get("world");
  const needsKnownKeyFallback = getManagedPresetSettings()
    .some(setting => !worldStorage.getSetting(setting.id, null));
  if (state.appliedRevision === preset.revision
      && state.activePresetId === activeId
      && state.appliedManagedSignature === getManagedPresetSignature()
      && !needsKnownKeyFallback) return false;
  await applyPresetAtomically(preset, {
    statePatch: {
      migrationVersion: Math.max(MIGRATION_VERSION, Number(state.migrationVersion || 0)),
      activePresetId: activeId,
      appliedRevision: preset.revision,
      lastError: ""
    }
  });
  return true;
}

async function activatePresetLocal(id, { skipFlush = false } = {}) {
  if (!skipFlush) await flushActivePresetLocal();
  const preset = requirePreset(id);
  return applyPresetAtomically(preset, {
    statePatch: {
      migrationVersion: MIGRATION_VERSION,
      activePresetId: preset.id,
      appliedRevision: preset.revision,
      lastError: ""
    }
  });
}

async function flushActivePresetLocal() {
  clearTimeout(runtime.autosaveTimer);
  runtime.autosaveTimer = null;
  if (getPresetState().pendingPresetId) {
    await reconcilePendingWrite();
    if (getPresetState().pendingPresetId) {
      throw new Error("A previous settings preset write is still pending and must be synchronized first.");
    }
  }
  const state = getPresetState();
  if (!state.activePresetId) return null;
  const current = runtime.presets.get(state.activePresetId);
  if (!current) return null;
  const settings = mergeKnownSnapshotWithUnknown(current, captureCurrentSettings());
  const next = await makePreset({
    ...current,
    settings,
    seedPending: current.seedPending,
    deleted: false
  });
  if (next.revision === current.revision) {
    runtime.autosaveDirty = false;
    return current;
  }

  await savePresetCopies(next, { statePatch: {
    activePresetId: next.id,
    appliedRevision: next.revision,
  }});
  runtime.autosaveDirty = false;
  return next;
}

function captureCurrentSettings({ useStoredOnly = false, fallbackPreset = null } = {}) {
  const activeFallback = fallbackPreset ?? runtime.presets.get(getPresetState().activePresetId);
  const fallback = new Map((activeFallback?.settings ?? []).map(entry => [entry.id, entry.value]));
  const main = runtime.presets.get(MAIN_PRESET_ID);
  const mainValues = new Map((main?.settings ?? []).map(entry => [entry.id, entry.value]));
  const worldStorage = game.settings.storage.get("world");
  const entries = [];
  const errors = [];
  const recoveries = [];

  for (const setting of getManagedPresetSettings()) {
    const stored = worldStorage.getSetting(setting.id, null);
    const provided = Boolean(stored) || !useStoredOnly;
    let currentValue;
    if (provided) {
      try {
        currentValue = game.settings.get(setting.namespace, setting.key);
      } catch (_error) {
        currentValue = undefined;
      }
    }

    try {
      const fallbacks = [];
      if (fallback.has(setting.id)) {
        fallbacks.push({
          source: fallbackPreset ? "migration" : "active",
          provided: true,
          value: fallback.get(setting.id)
        });
      }
      if (mainValues.has(setting.id) && activeFallback?.id !== MAIN_PRESET_ID) {
        fallbacks.push({ source: "main", provided: true, value: mainValues.get(setting.id) });
      }
      const resolution = resolveStoredSettingValue(setting, {
        provided,
        presetValue: currentValue,
        fallbacks
      });
      entries.push({ id: setting.id, scope: "world", value: resolution.value });
      if (resolution.fallbackSource) recoveries.push(`${setting.id} ← ${resolution.fallbackSource}`);
    } catch (error) {
      errors.push(`${setting.id}: ${errorMessage(error)}`);
    }
  }

  if (errors.length) {
    throw new TypeError(`Cannot capture ${errors.length} managed setting(s):\n- ${errors.join("\n- ")}`);
  }
  if (recoveries.length) {
    console.warn(`${SYSTEM_TITLE} | Recovered managed settings while capturing a preset:\n- ${recoveries.join("\n- ")}`);
  }
  return entries;
}

function worldHasStoredManagedSettings() {
  const worldStorage = game.settings.storage.get("world");
  return getManagedPresetSettings().some(setting => Boolean(worldStorage.getSetting(setting.id, null)));
}

function isExistingWorldForPresetMigration() {
  if (worldHasStoredManagedSettings() || Number(game.world?.playtime || 0) > 0) return true;

  const previousSystemVersion = String(game.world?.systemVersion ?? game.world?._source?.systemVersion ?? "");
  const currentSystemVersion = String(game.system?.version ?? "");
  if (previousSystemVersion && currentSystemVersion && previousSystemVersion !== currentSystemVersion) return true;

  const worldStorage = game.settings.storage.get("world");
  const storedSettings = worldStorage?.contents
    ?? Array.from(worldStorage?.values?.() ?? []);
  if (storedSettings.some(document => {
    const key = String(document?.key ?? "");
    return key.startsWith(`${SYSTEM_ID}.`) && key !== `${SYSTEM_ID}.${SETTINGS_PRESET_STATE_SETTING}`;
  })) return true;

  return ["actors", "items", "scenes", "journal", "tables", "playlists", "macros", "cards"]
    .some(collectionName => Number(game[collectionName]?.size ?? game[collectionName]?.contents?.length ?? 0) > 0);
}

function mergeKnownSnapshotWithUnknown(preset, knownEntries) {
  const managed = new Set(getManagedPresetSettings().map(setting => setting.id));
  const unknown = (preset.settings ?? [])
    .filter(entry => entry.scope === "world"
      && !managed.has(entry.id)
      && !game.settings.settings.has(entry.id))
    .map(cloneValue);
  return [...knownEntries, ...unknown].sort((left, right) => left.id.localeCompare(right.id));
}

function sanitizePresetSettings(rawPreset) {
  const preset = normalizePresetDocument(rawPreset);
  if (preset.deleted) return preset;
  const settings = preset.settings.filter(entry => {
    const registration = game.settings.settings.get(entry.id);
    return !registration || isPresetManagedSetting(registration);
  });
  if (settings.length === preset.settings.length) return preset;
  return createPresetDocument({
    id: preset.id,
    name: preset.name,
    settings,
    systemVersion: preset.systemVersion,
    seedPending: preset.seedPending
  });
}

async function applyPresetAtomically(rawPreset, { statePatch = {} } = {}) {
  const preset = normalizePresetDocument(rawPreset);
  if (preset.deleted) throw new Error(`Cannot activate deleted settings preset ${preset.id}.`);
  const assignments = buildPresetAssignments(preset, { coerceLegacy: true });
  const healedAssignments = assignments.filter(assignment => assignment.canonicalized);
  const appliedPreset = healedAssignments.length
    ? await makePreset({
      ...preset,
      settings: mergeKnownSnapshotWithUnknown(
        preset,
        assignments.map(({ setting, value }) => ({ id: setting.id, scope: "world", value }))
      )
    })
    : preset;

  const nextState = normalizePresetState({
    ...getPresetState(),
    ...statePatch,
    appliedRevision: appliedPreset.revision,
    appliedManagedSignature: getManagedPresetSignature()
  });
  const stateConfig = game.settings.settings.get(`${SYSTEM_ID}.${SETTINGS_PRESET_STATE_SETTING}`);
  if (!stateConfig) throw new Error("Settings preset state is not registered.");
  const values = [
    ...assignments.map(({ setting, json }) => ({ config: setting, json })),
    { config: stateConfig, json: JSON.stringify(nextState) }
  ];
  const storage = game.settings.storage.get("world");
  let batchId = null;
  try {
    const documentIds = await materializeMissingSettingDocuments(values, storage);
    const updates = values.map(({ config, json }) => ({
      _id: documentIds.get(config.id),
      value: json
    }));
    if (updates.some(update => !update._id)) {
      throw new Error("Foundry did not materialize every managed Setting document.");
    }

    batchId = randomPresetId("apply");
    runtime.applyBatches.set(batchId, {
      id: batchId,
      expected: values.length,
      seen: new Set(),
      originClientId: CLIENT_INSTANCE_ID,
      confirmed: false,
      complete: false
    });
    const operation = {
      action: "update",
      documentName: "Setting",
      updates,
      noHook: true,
      [APPLY_MARKER]: true,
      [APPLY_BATCH_ID]: batchId,
      [APPLY_BATCH_SIZE]: values.length,
      [APPLY_ORIGIN_CLIENT]: CLIENT_INSTANCE_ID,
      diff: false
    };
    const results = await foundry.documents.modifyBatch([operation]);
    const complete = Array.isArray(results)
      && results.length === 1
      && Array.isArray(results[0])
      && results[0].length === updates.length;
    if (!complete) throw new Error("Foundry rejected one or more operations in the atomic settings batch.");
    await confirmPresetApplyBatch(batchId, { force: true });
  } catch (error) {
    if (batchId) discardPresetApplyBatch(batchId);
    runtime.lastError = errorMessage(error);
    throw new Error(`Preset ${preset.name} was not applied atomically: ${runtime.lastError}`, { cause: error });
  }

  if (healedAssignments.length) {
    const details = healedAssignments.map(({ setting, fallbackSource, recoveryError }) => {
      const source = fallbackSource ? `fallback ${fallbackSource}` : "legacy conversion";
      return `${setting.id} (${source}${recoveryError ? `; ${recoveryError}` : ""})`;
    });
    console.warn(`${SYSTEM_TITLE} | Canonicalized ${healedAssignments.length} setting(s) in preset ${preset.id}:\n- ${details.join("\n- ")}`);
    try {
      await savePresetCopies(appliedPreset);
    } catch (error) {
      runtime.lastError = errorMessage(error);
      console.error(`${SYSTEM_TITLE} | Preset ${preset.id} was applied, but its canonical file copies are pending`, error);
    }
  }
  return appliedPreset;
}

async function materializeMissingSettingDocuments(values, storage) {
  const documentIds = new Map();
  const missing = [];
  for (const { config } of values) {
    const current = storage.getSetting(config.id, null);
    const currentId = current?.id ?? current?._id;
    if (currentId) {
      documentIds.set(config.id, currentId);
      continue;
    }
    const value = config.id === `${SYSTEM_ID}.${SETTINGS_PRESET_STATE_SETTING}`
      ? getPresetState()
      : game.settings.get(config.namespace, config.key);
    missing.push({
      config,
      data: { key: config.id, user: null, value: JSON.stringify(serializableValue(value)) }
    });
  }

  if (!missing.length) return documentIds;
  const operation = {
    action: "create",
    documentName: "Setting",
    data: missing.map(entry => entry.data),
    noHook: true,
    [MATERIALIZE_MARKER]: true
  };
  const results = await foundry.documents.modifyBatch([operation]);
  const created = Array.isArray(results) && results.length === 1 && Array.isArray(results[0])
    ? results[0]
    : [];
  if (created.length !== missing.length) {
    throw new Error("Foundry rejected Setting document materialization before preset application.");
  }
  for (let index = 0; index < missing.length; index += 1) {
    const { config } = missing[index];
    const createdDocument = created[index];
    const storedDocument = storage.getSetting(config.id, null);
    const documentId = createdDocument?.id ?? createdDocument?._id ?? storedDocument?.id ?? storedDocument?._id;
    if (!documentId) throw new Error(`Foundry did not return the materialized Setting ${config.id}.`);
    documentIds.set(config.id, documentId);
  }
  return documentIds;
}

function buildPresetAssignments(preset, { coerceLegacy = false } = {}) {
  const main = preset.id === MAIN_PRESET_ID ? preset : requirePreset(MAIN_PRESET_ID);
  const presetValues = new Map((preset.settings ?? []).map(entry => [entry.id, entry.value]));
  const mainValues = new Map((main.settings ?? []).map(entry => [entry.id, entry.value]));
  const assignments = [];
  const errors = [];

  for (const setting of getManagedPresetSettings()) {
    const provided = presetValues.has(setting.id);
    if (!coerceLegacy && provided) {
      try {
        const value = validateSettingValue(setting, presetValues.get(setting.id));
        assignments.push({ setting, value, json: JSON.stringify(value), canonicalized: false, fallbackSource: "" });
      } catch (error) {
        errors.push(`${setting.id}: ${errorMessage(error)}`);
      }
      continue;
    }

    try {
      assignments.push(resolveStoredSettingValue(setting, {
        provided,
        presetValue: presetValues.get(setting.id),
        fallbacks: preset.id === MAIN_PRESET_ID ? [] : [{
          source: "main",
          provided: mainValues.has(setting.id),
          value: mainValues.get(setting.id)
        }]
      }));
    } catch (error) {
      errors.push(`${setting.id}: ${errorMessage(error)}`);
    }
  }

  if (errors.length) {
    throw new TypeError(`Preset ${preset.name} contains ${errors.length} incompatible managed setting(s):\n- ${errors.join("\n- ")}`);
  }
  return assignments;
}

function resolveStoredSettingValue(setting, { provided = false, presetValue, fallbacks = [] } = {}) {
  const candidates = [];
  if (provided) candidates.push({ source: "preset", value: presetValue, coerceLegacy: true });
  for (const fallback of fallbacks) {
    if (!fallback?.provided) continue;
    candidates.push({
      source: String(fallback.source || "fallback"),
      value: fallback.value,
      coerceLegacy: true
    });
  }
  candidates.push({ source: "default", value: setting.default, coerceLegacy: false });

  const failures = [];
  for (const candidate of candidates) {
    try {
      const value = validateSettingValue(setting, candidate.value, { coerceLegacy: candidate.coerceLegacy });
      const originalJson = provided ? safeSettingJson(presetValue) : null;
      const json = JSON.stringify(value);
      return {
        setting,
        value,
        json,
        canonicalized: !provided || candidate.source !== "preset" || originalJson !== json,
        fallbackSource: candidate.source === "preset" ? "" : candidate.source,
        recoveryError: failures[0] ?? ""
      };
    } catch (error) {
      failures.push(`${candidate.source}: ${errorMessage(error)}`);
    }
  }
  throw new TypeError(failures.join("; "));
}

function validatePresetForStorage(preset) {
  const normalized = normalizePresetDocument(preset);
  if (normalized.deleted) return normalized;
  const assignments = buildPresetAssignments(normalized);
  if (!assignments.some(assignment => assignment.canonicalized)) return normalized;
  return createPresetDocument({
    id: normalized.id,
    name: normalized.name,
    settings: mergeKnownSnapshotWithUnknown(
      normalized,
      assignments.map(({ setting, value }) => ({ id: setting.id, scope: "world", value }))
    ),
    systemVersion: normalized.systemVersion,
    seedPending: normalized.seedPending
  });
}

function validateSettingValue(setting, candidate, { coerceLegacy = false } = {}) {
  let value = serializableValue(candidate);
  const type = setting.type;

  if (type instanceof foundry.data.fields.DataField) {
    value = type.clean(value);
    type.validate(value, { fallback: false, strict: true });
    return serializableValue(value);
  }
  if (typeof type === "function" && foundry.utils.isSubclass(type, foundry.abstract.DataModel)) {
    return serializableValue(type.fromSource(value || {}, { strict: true }));
  }
  if (value === null && setting.default === null) return null;
  if (type === Object) {
    if (!Array.isArray(value) && !isPlainObject(value)) {
      throw new TypeError(`${setting.id} must be an object or array.`);
    }
  } else if (type === Array) {
    if (!Array.isArray(value)) throw new TypeError(`${setting.id} must be an array.`);
  } else if (type === String) {
    if (coerceLegacy && ["number", "boolean"].includes(typeof value)) value = JSON.stringify(value);
    if (typeof value !== "string") throw new TypeError(`${setting.id} must be a string.`);
  } else if (type === Number) {
    if (coerceLegacy && typeof value === "boolean") value = value ? 1 : 0;
    else if (coerceLegacy && typeof value === "string" && value.trim() !== "") value = Number(value);
    if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${setting.id} must be a finite number.`);
  } else if (type === Boolean) {
    if (coerceLegacy && (value === 0 || value === 1)) value = value === 1;
    else if (coerceLegacy && typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes", "on"].includes(normalized)) value = true;
      else if (["false", "0", "no", "off", ""].includes(normalized)) value = false;
    }
    if (typeof value !== "boolean") throw new TypeError(`${setting.id} must be a boolean.`);
  } else if (typeof type === "function") {
    try {
      value = serializableValue(type?.prototype?.constructor === type ? new type(value) : type(value));
    } catch (error) {
      throw new TypeError(`${setting.id} has an invalid value: ${errorMessage(error)}`, { cause: error });
    }
  }
  validateSettingChoices(setting, value);
  return value;
}

function validateSettingChoices(setting, value) {
  const choices = registeredChoiceKeys(setting);
  if (!choices.length) return;
  const valid = choices.some(choice => (
    setting.type === Number ? Number(choice) === value : choice === String(value)
  ));
  if (!valid) throw new TypeError(`${setting.id} must be one of the registered choices.`);
}

function registeredChoiceKeys(setting) {
  if (setting?.choices instanceof Map) return Array.from(setting.choices.keys(), String).sort();
  if (!setting?.choices || typeof setting.choices !== "object" || Array.isArray(setting.choices)) return [];
  return Object.keys(setting.choices).sort();
}

function settingTypeSignature(type) {
  if (type instanceof foundry.data.fields.DataField) {
    return `DataField:${type.constructor?.name || "anonymous"}`;
  }
  if (typeof type === "function" && foundry.utils.isSubclass(type, foundry.abstract.DataModel)) {
    return `DataModel:${type.name || "anonymous"}`;
  }
  return type?.name || typeof type;
}

function jsonValueShape(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function compactJsonSignature(value) {
  let source;
  try {
    source = JSON.stringify(serializableValue(value));
  } catch (_error) {
    return "invalid";
  }
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${source.length}:${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

function safeSettingJson(value) {
  try {
    return JSON.stringify(serializableValue(value));
  } catch (_error) {
    return "";
  }
}

async function savePresetCopies(rawPreset, { statePatch = {} } = {}) {
  const preset = normalizePresetDocument(rawPreset);
  const existingPending = getPresetState();
  if (existingPending.pendingPresetId
      && (existingPending.pendingPresetId !== preset.id
        || existingPending.pendingRevision !== preset.revision)) {
    await reconcilePendingWrite();
    if (getPresetState().pendingPresetId) {
      throw new Error(`Preset ${existingPending.pendingPresetId} still has an unresolved file write.`);
    }
  }

  await updatePresetState({
    ...statePatch,
    pendingPresetId: preset.id,
    pendingRevision: preset.revision,
    pendingTarget: "both",
    pendingDocument: preset,
    lastError: ""
  });

  const { systemSaved, worldSaved } = await persistPresetCopies(preset);
  await updatePresetState({
    ...statePatch,
    pendingPresetId: systemSaved && worldSaved ? "" : preset.id,
    pendingRevision: systemSaved && worldSaved ? "" : preset.revision,
    pendingTarget: systemSaved && worldSaved ? "" : (!systemSaved && !worldSaved ? "both" : (systemSaved ? "world" : "system")),
    pendingDocument: systemSaved && worldSaved ? null : preset,
    lastError: systemSaved && worldSaved ? "" : runtime.lastError
  });
  if (!systemSaved && !worldSaved) throw new Error(runtime.lastError || `Failed to persist preset ${preset.id}.`);
  return preset;
}

async function persistPresetCopies(preset, { scheduleRetry = true } = {}) {
  let worldSaved = false;
  let systemSaved = false;
  const errors = [];
  try {
    await writeSystemPreset(preset);
    systemSaved = true;
    runtime.sourceSystem.set(preset.id, preset);
  } catch (error) {
    errors.push(`system: ${errorMessage(error)}`);
  }
  try {
    await writeWorldPreset(preset);
    worldSaved = true;
    runtime.sourceWorld.set(preset.id, preset);
  } catch (error) {
    errors.push(`world: ${errorMessage(error)}`);
  }
  setRuntimePreset(preset, systemSaved && worldSaved ? "system+world" : (systemSaved ? "system" : "world"));
  runtime.lastError = errors.join("; ");
  if (errors.length) {
    console.error(`${SYSTEM_TITLE} | Incomplete preset write ${preset.id}: ${runtime.lastError}`);
    if (scheduleRetry) schedulePresetWriteRetry(preset);
  } else if (runtime.pendingDocument?.id === preset.id && runtime.pendingDocument?.revision === preset.revision) {
    runtime.pendingDocument = null;
    clearTimeout(runtime.retryTimer);
    runtime.retryTimer = null;
  }
  return { systemSaved, worldSaved };
}

function schedulePresetWriteRetry(preset) {
  runtime.pendingDocument = preset;
  clearTimeout(runtime.retryTimer);
  runtime.retryTimer = setTimeout(() => {
    runtime.retryTimer = null;
    const retryDocument = runtime.pendingDocument;
    void enqueueMutation(() => retryPendingPresetWrite(retryDocument)).catch(error => {
      runtime.lastError = errorMessage(error);
      console.error(`${SYSTEM_TITLE} | Failed to retry preset write`, error);
      runtime.pendingDocument ??= retryDocument;
      if (runtime.pendingDocument) schedulePresetWriteRetry(runtime.pendingDocument);
    });
  }, 5_000);
}

async function retryPendingPresetWrite(pending) {
  if (!pending || !pendingStateMatches(pending)) return false;
  const result = await persistPresetCopies(pending, { scheduleRetry: false });
  if (!pendingStateMatches(pending)) return false;
  if (result.systemSaved && result.worldSaved) {
    await updatePresetState({
      pendingPresetId: "",
      pendingRevision: "",
      pendingTarget: "",
      pendingDocument: null,
      lastError: ""
    });
    clearPendingPresetRetry();
    broadcastPresetChange();
    return true;
  }
  schedulePresetWriteRetry(pending);
  return false;
}

function pendingStateMatches(preset) {
  const state = getPresetState();
  return state.pendingPresetId === preset.id && state.pendingRevision === preset.revision;
}

function clearPendingPresetRetry() {
  runtime.pendingDocument = null;
  clearTimeout(runtime.retryTimer);
  runtime.retryTimer = null;
}

async function readPresetDirectory(directory, { required = false } = {}) {
  let browse;
  try {
    browse = await getFilePicker().browse("data", directory, { extensions: [".json"] });
  } catch (error) {
    if (!required) return [];
    throw new Error(`Cannot browse settings preset directory ${directory}: ${errorMessage(error)}`, { cause: error });
  }
  const files = Array.from(browse?.files ?? [])
    .filter(path => String(path).toLowerCase().endsWith(".json"))
    .sort();
  const documents = [];
  for (const path of files) {
    try {
      const separator = String(path).includes("?") ? "&" : "?";
      const response = await fetch(`${path}${separator}preset-cache=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      documents.push(normalizePresetDocument(await response.json()));
    } catch (error) {
      console.warn(`${SYSTEM_TITLE} | Ignoring unreadable settings preset file ${path}: ${errorMessage(error)}`);
    }
  }
  return documents;
}

function indexPresetDocuments(documents) {
  const result = new Map();
  for (const preset of documents) {
    if (result.has(preset.id)) throw new Error(`Duplicate settings preset id ${preset.id}.`);
    assertNoPresetIdCaseCollision(preset.id, result.keys());
    result.set(preset.id, preset);
  }
  return result;
}

function assertNoPresetSourceCaseCollisions(ids) {
  const seen = new Map();
  for (const id of ids) {
    const folded = id.toLocaleLowerCase("en-US");
    const previous = seen.get(folded);
    if (previous && previous !== id) {
      throw new Error(`Settings preset ids ${previous} and ${id} collide on this filesystem.`);
    }
    seen.set(folded, id);
  }
}

function assertNoPresetIdCaseCollision(id, existingIds) {
  const folded = id.toLocaleLowerCase("en-US");
  for (const existingId of existingIds) {
    if (existingId !== id && existingId.toLocaleLowerCase("en-US") === folded) {
      throw new Error(`Settings preset ids ${existingId} and ${id} collide on this filesystem.`);
    }
  }
}

async function writeSystemPreset(preset) {
  const file = presetFile(preset);
  const response = await getFilePicker().uploadPersistent(
    SYSTEM_ID,
    "settings-presets",
    file,
    {},
    { notify: false }
  );
  assertUploadResponse(response, preset.id, "system");
  return response;
}

async function writeWorldPreset(preset) {
  const directory = getWorldPresetDirectory();
  await ensureDirectory(directory);
  const response = await getFilePicker().upload("data", directory, presetFile(preset), {}, { notify: false });
  assertUploadResponse(response, preset.id, "world");
  return response;
}

async function ensureDirectory(directory) {
  try {
    await getFilePicker().browse("data", directory);
  } catch (_error) {
    try {
      await getFilePicker().createDirectory("data", directory);
    } catch (error) {
      try {
        await getFilePicker().browse("data", directory);
      } catch (_browseError) {
        throw new Error(`Cannot create settings preset backup directory ${directory}: ${errorMessage(error)}`, { cause: error });
      }
    }
  }
}

function presetFile(preset) {
  return new File(
    [JSON.stringify(normalizePresetDocument(preset), null, 2)],
    `${preset.id}.json`,
    { type: "application/json" }
  );
}

function assertUploadResponse(response, id, destination) {
  if (!response || response.error || !response.path) {
    throw new Error(`Failed to write preset ${id} to ${destination} storage.`);
  }
}

function getFilePicker() {
  const picker = globalThis.CONFIG?.ux?.FilePicker
    ?? globalThis.foundry?.applications?.apps?.FilePicker
    ?? globalThis.FilePicker;
  if (!picker) throw new Error("Foundry FilePicker is unavailable.");
  return picker;
}

function getWorldPresetDirectory() {
  return `worlds/${game.world.id}/settings-presets`;
}

function onSettingCreated(setting, options, userId) {
  handleSettingMutation(setting, { value: setting?.value }, options, userId);
}

function onSettingUpdated(setting, changes, options, userId) {
  if (!Object.hasOwn(changes ?? {}, "value")) return;
  handleSettingMutation(setting, changes, options, userId);
}

function handleSettingMutation(document, _changes, options = {}, userId) {
  const config = document?.config ?? game.settings?.settings?.get?.(document?.key);
  if (options?.[MATERIALIZE_MARKER]) return;
  if (options?.[APPLY_MARKER]) {
    recordPresetApplyMutation(config?.id ?? document?.key, options, userId);
    return;
  }
  if (!isPresetManagedSetting(config)) return;
  if (!runtime.ready || !runtime.autosaveEnabled || !game.user?.isGM) return;
  runtime.autosaveDirty = true;
  clearTimeout(runtime.autosaveTimer);
  runtime.autosaveTimer = setTimeout(() => {
    runtime.autosaveTimer = null;
    if (!isPrimaryGM()) return;
    void enqueueMutation(async () => {
      try {
        await flushActivePresetLocal();
        broadcastPresetChange();
      } catch (error) {
        runtime.lastError = errorMessage(error);
        ui.notifications?.error?.(`${SYSTEM_TITLE}: ${runtime.lastError}`);
      }
    });
  }, AUTOSAVE_DELAY);
}

function wrapManagedSettingOnChanges() {
  if (runtime.wrappedChanges) return;
  runtime.wrappedChanges = true;
  for (const setting of getManagedPresetSettings()) {
    const original = setting.onChange;
    if (typeof original !== "function" || original.__falloutMaWPresetWrapped) continue;
    const wrapped = (value, options = {}, userId) => {
      if (options?.[MATERIALIZE_MARKER]) return undefined;
      if (!options?.[APPLY_MARKER]) return original(value, options, userId);
      if (setting.presetEffect === "actors" || setting.presetEffect === "creatures") {
        runtime.applyEffectFlags.actors = true;
        if (setting.presetEffect === "creatures") runtime.applyEffectFlags.naturalRace = true;
      } else if (setting.presetEffect === "combatCarousel") {
        runtime.applyEffectFlags.combatCarousel = true;
      } else runtime.applyCallbacks.set(original, { original, value, options, userId });
      return undefined;
    };
    Object.defineProperty(wrapped, "__falloutMaWPresetWrapped", { value: true });
    setting.onChange = wrapped;
  }
}

function recordPresetApplyMutation(settingId, options = {}) {
  const batchId = options?.[APPLY_BATCH_ID];
  const expected = Math.max(0, Math.trunc(Number(options?.[APPLY_BATCH_SIZE]) || 0));
  if (!batchId || !expected) return;
  let batch = runtime.applyBatches.get(batchId);
  if (!batch) {
    batch = {
      id: batchId,
      expected,
      seen: new Set(),
      originClientId: options?.[APPLY_ORIGIN_CLIENT] ?? "",
      confirmed: options?.[APPLY_ORIGIN_CLIENT] !== CLIENT_INSTANCE_ID,
      complete: false
    };
    runtime.applyBatches.set(batchId, batch);
  }
  batch.expected = Math.max(batch.expected, expected);
  batch.seen.add(settingId);
  if (batch.confirmed && batch.seen.size >= batch.expected) void completePresetApplyBatch(batchId);
}

async function confirmPresetApplyBatch(batchId, { force = false } = {}) {
  const batch = runtime.applyBatches.get(batchId);
  if (!batch) return undefined;
  batch.confirmed = true;
  if (!force && batch.seen.size < batch.expected) return undefined;
  return completePresetApplyBatch(batchId);
}

function completePresetApplyBatch(batchId) {
  const batch = runtime.applyBatches.get(batchId);
  if (!batch || batch.complete) return runtime.applyEffectsQueue;
  batch.complete = true;
  runtime.applyBatches.delete(batchId);
  if (!runtime.autosaveEnabled) {
    runtime.deferredApplyEffects = true;
    return runtime.applyEffectsQueue;
  }
  return enqueuePresetApplyEffects();
}

function discardPresetApplyBatch(batchId) {
  runtime.applyBatches.delete(batchId);
  runtime.applyCallbacks.clear();
  runtime.applyEffectFlags.actors = false;
  runtime.applyEffectFlags.naturalRace = false;
  runtime.applyEffectFlags.combatCarousel = false;
}

function enqueuePresetApplyEffects({ skipCoreEffects = false } = {}) {
  const effects = {
    callbacks: Array.from(runtime.applyCallbacks.values()),
    actors: runtime.applyEffectFlags.actors,
    naturalRace: runtime.applyEffectFlags.naturalRace,
    combatCarousel: runtime.applyEffectFlags.combatCarousel
  };
  runtime.applyCallbacks.clear();
  runtime.applyEffectFlags.actors = false;
  runtime.applyEffectFlags.naturalRace = false;
  runtime.applyEffectFlags.combatCarousel = false;
  const next = runtime.applyEffectsQueue.then(
    () => flushPresetApplyEffects(effects, { skipCoreEffects }),
    () => flushPresetApplyEffects(effects, { skipCoreEffects })
  );
  runtime.applyEffectsQueue = next.catch(() => undefined);
  return next;
}

async function flushPresetApplyEffects(effects, { skipCoreEffects = false } = {}) {
  let refreshActors = null;
  if (!skipCoreEffects) {
    try {
      const { refreshPreparedActorsAfterConfig, syncSettingsIntoSystemConfig } = await import("../accessors.mjs");
      syncSettingsIntoSystemConfig();
      refreshActors = refreshPreparedActorsAfterConfig;
    } catch (error) {
      console.error(`${SYSTEM_TITLE} | Failed to synchronize CONFIG after preset application`, error);
    }
  }
  await drainPresetApplyCallbacks(effects.callbacks);
  if (!skipCoreEffects && effects.actors && refreshActors) {
    try {
      refreshActors();
    } catch (error) {
      console.error(`${SYSTEM_TITLE} | Failed to refresh Actors after preset application`, error);
    }
  }
  if (!skipCoreEffects && effects.naturalRace && game.ready) {
    try {
      const { syncLoadedActorNaturalRaceItems } = await import("../../races/natural-items.mjs");
      await syncLoadedActorNaturalRaceItems();
    } catch (error) {
      console.error(`${SYSTEM_TITLE} | Failed to synchronize natural race items after preset application`, error);
    }
  }
  if (!skipCoreEffects && effects.combatCarousel) {
    try {
      const { restartCombatCarousel } = await import("../../apps/combat-carousel.mjs");
      await restartCombatCarousel();
    } catch (error) {
      console.error(`${SYSTEM_TITLE} | Failed to refresh Combat Carousel after preset application`, error);
    }
  }
  try {
    ui.settings?.render?.(false);
  } catch (error) {
    console.error(`${SYSTEM_TITLE} | Failed to render settings after preset application`, error);
  }
  try {
    Hooks.callAll(`${SYSTEM_ID}.settingsPresetApplied`, getPresetState());
  } catch (error) {
    console.error(`${SYSTEM_TITLE} | Settings preset applied hook failed`, error);
  }
}

async function drainPresetApplyCallbacks(callbacks = null) {
  if (!callbacks) {
    callbacks = Array.from(runtime.applyCallbacks.values());
    runtime.applyCallbacks.clear();
  }
  for (const { original, value, options, userId } of callbacks) {
    try {
      await original(value, options, userId);
    } catch (error) {
      console.error(`${SYSTEM_TITLE} | Settings preset onChange failed`, error);
    }
  }
}

function registerPresetSocket() {
  if (runtime.socketRegistered || !game.socket?.on) return;
  runtime.socketRegistered = true;
  game.socket.on(PRESET_SOCKET, handlePresetSocketMessage);
}

async function handlePresetSocketMessage(message = {}, authenticatedSenderId) {
  if (message?.kind !== SOCKET_KIND) return;
  if (message.type === "changed") {
    if (!authenticatedSenderId || message.senderId !== authenticatedSenderId) return;
    if (message.senderId === game.user?.id && message.senderClientId === CLIENT_INSTANCE_ID) return;
    const sender = game.users?.get?.(message.senderId);
    if (!sender?.active || !sender.isGM) return;
    if (getPrimaryGM()?.id !== sender.id) return;
    if (!game.user?.isGM) {
      Hooks.callAll(`${SYSTEM_ID}.settingsPresetsChanged`, message);
      return;
    }
    try {
      await enqueueMutation(async () => {
        await loadPresetSources();
        Hooks.callAll(`${SYSTEM_ID}.settingsPresetsChanged`, message);
      });
    } catch (error) {
      runtime.lastError = errorMessage(error);
      console.error(`${SYSTEM_TITLE} | Failed to refresh presets after socket update`, error);
    }
    return;
  }
}

async function handlePresetUserQuery(data = {}, { user, timeout } = {}) {
  if (!user?.active || !user.isGM) throw new Error("Only an active GM may request settings preset mutations.");
  if (!isPrimaryGM()) {
    await waitForPrimaryClientLeadership((Number(timeout) || RPC_TIMEOUT) + 1_000);
  }
  if (!isPrimaryGM()) throw new Error("Only the active GM client can process settings preset mutations.");
  return dispatchRemoteMutation(data.action, data.args ?? []);
}

async function dispatchRemoteMutation(action, args) {
  switch (action) {
    case "create": return createSettingsPreset(...args);
    case "activate": return activateSettingsPreset(...args);
    case "rename": return renameSettingsPreset(...args);
    case "remove": return removeSettingsPreset(...args);
    case "importDocument": return importSettingsPreset(...args);
    case "refresh": return refreshSettingsPresets(...args);
    case "flush": return flushSettingsPreset();
    default: throw new Error(`Unsupported settings preset action ${action}.`);
  }
}

function runMutation(action, args, localOperation) {
  if (!game.user?.isGM) return Promise.reject(new Error("Only a GM can manage settings presets."));
  const primary = getPrimaryGM();
  if (!primary) return Promise.reject(new Error("No active GM is available to manage settings presets."));
  if (isPrimaryGM()) return enqueueMutation(localOperation);
  return requestPrimaryGM(action, args);
}

function enqueueMutation(operation) {
  const next = runtime.mutationQueue.then(async () => {
    runtime.busy = true;
    try {
      return await operation();
    } finally {
      runtime.busy = false;
    }
  }, async () => {
    runtime.busy = true;
    try {
      return await operation();
    } finally {
      runtime.busy = false;
    }
  });
  runtime.mutationQueue = next.catch(() => undefined);
  return next;
}

async function requestPrimaryGM(action, args) {
  const primary = getPrimaryGM();
  if (!primary) throw new Error("No active GM is available to manage settings presets.");
  const result = await primary.query(PRESET_QUERY, { action, args }, { timeout: RPC_TIMEOUT });
  await enqueueMutation(loadPresetSources);
  return result;
}

function broadcastPresetChange() {
  Hooks.callAll(`${SYSTEM_ID}.settingsPresetsChanged`, getSettingsPresetStatus());
  game.socket?.emit?.(PRESET_SOCKET, {
    kind: SOCKET_KIND,
    type: "changed",
    senderId: game.user?.id,
    senderClientId: CLIENT_INSTANCE_ID,
    activePresetId: getPresetState().activePresetId,
    revision: getPresetState().appliedRevision
  });
}

function getPrimaryGM() {
  if (game.users?.activeGM) return game.users.activeGM;
  return Array.from(game.users?.contents ?? [])
    .filter(user => user.active && user.isGM)
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))[0] ?? null;
}

function isPrimaryGM() {
  return getPrimaryGM()?.id === game.user?.id && runtime.primaryClientLeader;
}

/**
 * Elect exactly one browser tab for this GM User. Foundry V14 delivers User.query
 * to every socket of a User, so user-id election alone would execute mutations once
 * per open tab. Web Locks are provided by the Chromium runtime used by Foundry V14.
 */
async function initializePrimaryClientLeadership() {
  const locks = globalThis.navigator?.locks;
  if (!locks?.request) {
    runtime.primaryClientLeader = true;
    return true;
  }
  runtime.primaryClientLeader = false;
  const acquired = await tryAcquirePrimaryClientLock(locks);
  if (!acquired) schedulePrimaryClientLeadershipRetry(locks);
  return acquired;
}

function tryAcquirePrimaryClientLock(locks = globalThis.navigator?.locks) {
  if (!locks?.request || runtime.primaryClientLockPending || runtime.primaryClientLeader) {
    return Promise.resolve(runtime.primaryClientLeader);
  }
  runtime.primaryClientLockPending = true;
  const lockName = `${PRESET_QUERY}:${game.world?.id ?? "world"}:${game.user?.id ?? "user"}`;
  return new Promise(resolve => {
    let resolved = false;
    const settle = value => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };
    void locks.request(lockName, { mode: "exclusive", ifAvailable: true }, async lock => {
      runtime.primaryClientLockPending = false;
      if (!lock) {
        settle(false);
        return;
      }
      runtime.primaryClientLeader = true;
      settle(true);
      if (runtime.ready) void promotePrimaryClient().catch(error => {
        runtime.lastError = errorMessage(error);
        console.error(`${SYSTEM_TITLE} | Failed to promote settings preset client`, error);
      });
      await new Promise(release => {
        runtime.primaryClientLockRelease = release;
      });
      runtime.primaryClientLockRelease = null;
      runtime.primaryClientLeader = false;
    }).catch(error => {
      runtime.primaryClientLockPending = false;
      runtime.primaryClientLeader = true;
      console.warn(`${SYSTEM_TITLE} | Browser tab election is unavailable; using this GM client`, error);
      settle(true);
    });
  });
}

function schedulePrimaryClientLeadershipRetry(locks = globalThis.navigator?.locks) {
  if (runtime.primaryClientLeader || runtime.primaryClientRetryTimer || !locks?.request) return;
  runtime.primaryClientRetryTimer = setTimeout(async () => {
    runtime.primaryClientRetryTimer = null;
    const acquired = await tryAcquirePrimaryClientLock(locks);
    if (!acquired) schedulePrimaryClientLeadershipRetry(locks);
  }, CLIENT_LEADER_RETRY_DELAY);
}

async function promotePrimaryClient() {
  if (!isPrimaryGM()) return;
  await enqueueMutation(async () => {
    await loadPresetSources();
    await initializePrimaryGM();
    if (runtime.autosaveEnabled) await flushActivePresetLocal();
    broadcastPresetChange();
  });
}

function waitForPrimaryClientLeadership(timeout = RPC_TIMEOUT) {
  if (isPrimaryGM()) return Promise.resolve(true);
  return new Promise(resolve => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (isPrimaryGM() || Date.now() - started >= timeout) {
        clearInterval(timer);
        resolve(isPrimaryGM());
      }
    }, 50);
  });
}

async function updatePresetState(patch = {}) {
  const next = normalizePresetState({ ...getPresetState(), ...patch });
  await game.settings.set(SYSTEM_ID, SETTINGS_PRESET_STATE_SETTING, next, {
    [STATE_MARKER]: true,
    [APPLY_MARKER]: true
  });
  return next;
}

function getPresetState() {
  try {
    return normalizePresetState(game.settings.get(SYSTEM_ID, SETTINGS_PRESET_STATE_SETTING));
  } catch (_error) {
    return createDefaultSettingsPresetState();
  }
}

function normalizePresetState(value = {}) {
  const fallback = createDefaultSettingsPresetState();
  const source = isPlainObject(value) ? value : fallback;
  let pendingDocument = null;
  if (isPlainObject(source.pendingDocument)) {
    try {
      pendingDocument = normalizePresetDocument(source.pendingDocument);
    } catch (_error) {
      pendingDocument = null;
    }
  }
  return {
    migrationVersion: Math.max(0, Math.trunc(Number(source.migrationVersion) || 0)),
    migrationPresetId: typeof source.migrationPresetId === "string" ? source.migrationPresetId : "",
    migrationFinalizeMain: source.migrationFinalizeMain === true,
    removedPresetIds: normalizeRemovedPresetIds(source.removedPresetIds),
    activePresetId: typeof source.activePresetId === "string" ? source.activePresetId : "",
    appliedRevision: typeof source.appliedRevision === "string" ? source.appliedRevision : "",
    appliedManagedSignature: typeof source.appliedManagedSignature === "string"
      ? source.appliedManagedSignature
      : "",
    pendingPresetId: typeof source.pendingPresetId === "string" ? source.pendingPresetId : "",
    pendingRevision: typeof source.pendingRevision === "string" ? source.pendingRevision : "",
    pendingTarget: ["system", "world", "both"].includes(source.pendingTarget) ? source.pendingTarget : "",
    pendingDocument,
    lastError: typeof source.lastError === "string" ? source.lastError : ""
  };
}

async function makePreset(source) {
  return createPresetDocument({
    id: source.id,
    name: source.name,
    settings: source.settings ?? [],
    systemVersion: game.system?.version ?? source.systemVersion ?? null,
    seedPending: Boolean(source.seedPending)
  });
}

async function rebuildPreset(source, changes = {}) {
  return makePreset({
    ...source,
    ...changes,
    id: source.id,
    settings: changes.settings ?? source.settings,
    seedPending: changes.seedPending ?? source.seedPending
  });
}

function setRuntimePreset(rawPreset, source = "system") {
  const preset = normalizePresetDocument(rawPreset);
  if (preset.id === MIGRATION_SEED_PRESET_ID) {
    if (preset.deleted) throw new Error("The internal settings migration seed cannot be deleted.");
    runtime.migrationSeed = preset;
    return preset;
  }
  if (getPresetState().removedPresetIds.includes(preset.id)) {
    removeRuntimePreset(preset.id);
    return preset;
  }
  if (preset.deleted) {
    removeRuntimePreset(preset.id);
    return preset;
  }
  const previous = runtime.descriptors.get(preset.id);
  const syncState = source === "world" ? "world-only" : "synced";
  runtime.descriptors.set(preset.id, {
    preset,
    source,
    restoreToSystem: source === "world",
    syncState: previous?.syncState === "pending" && source !== "system+world" ? "pending" : syncState
  });
  runtime.presets.set(preset.id, preset);
  return preset;
}

function removeRuntimePreset(id) {
  const presetId = String(id ?? "");
  runtime.presets.delete(presetId);
  runtime.descriptors.delete(presetId);
  runtime.sourceSystem.delete(presetId);
  runtime.sourceWorld.delete(presetId);
  runtime.legacyRemovedPresetIds.delete(presetId);
  runtime.restoreToSystem = (runtime.restoreToSystem ?? []).filter(preset => preset.id !== presetId);
}

function requirePreset(id) {
  const preset = runtime.presets.get(String(id ?? ""));
  if (!preset) throw new Error(`Settings preset ${id || "(empty)"} was not found.`);
  return preset;
}

function describePreset(preset) {
  const descriptor = runtime.descriptors.get(preset.id) ?? {};
  const state = getPresetState();
  let syncState = descriptor.syncState ?? "synced";
  if (state.pendingPresetId === preset.id && state.pendingRevision === preset.revision) syncState = "pending";
  if ((runtime.lastError || state.lastError) && state.pendingPresetId === preset.id) syncState = "error";
  return {
    id: preset.id,
    name: preset.name,
    revision: preset.revision,
    updatedAt: preset.updatedAt,
    systemVersion: preset.systemVersion,
    source: descriptor.source ?? "system",
    isMain: preset.id === MAIN_PRESET_ID,
    active: state.activePresetId === preset.id,
    seedPending: Boolean(preset.seedPending),
    canDelete: preset.id !== MAIN_PRESET_ID,
    syncState
  };
}

function normalizeName(value, fallback = "Preset") {
  const name = String(value ?? "").trim() || String(fallback ?? "Preset").trim();
  if (!name) throw new Error("Preset name cannot be empty.");
  if (name.length > 200) throw new Error("Preset name cannot exceed 200 characters.");
  if (/[\u0000-\u001f\u007f]/u.test(name)) throw new Error("Preset name contains control characters.");
  return name;
}

function normalizeRemovedPresetIds(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .filter(id => typeof id === "string")
    .map(id => id.trim())
    .filter(id => id && id !== MAIN_PRESET_ID && id !== MIGRATION_SEED_PRESET_ID)))
    .sort((left, right) => left.localeCompare(right));
}

function randomPresetId(prefix = "preset") {
  const random = globalThis.foundry?.utils?.randomID?.(24)
    ?? globalThis.crypto?.randomUUID?.().replaceAll("-", "")
    ?? `${Date.now()}${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}

function isLegacyBaseline(document) {
  return isPlainObject(document)
    && document.format !== PRESET_FORMAT
    && isPlainObject(document.settings)
    && (document.system === SYSTEM_ID || document.systemId === SYSTEM_ID);
}

function legacyPresetName(document) {
  const source = document.sourceWorld ? ` (${document.sourceWorld})` : "";
  return `Imported baseline${source}`;
}

function isFileLike(value) {
  if (!value || typeof value !== "object") return false;
  if (typeof globalThis.File === "function" && value instanceof globalThis.File) return true;
  return typeof value.name === "string"
    && (typeof value.text === "function" || typeof value.arrayBuffer === "function");
}

function normalizeMutationOptions(value) {
  if (!isPlainObject(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => {
    const type = typeof entry;
    return entry === null || ["string", "number", "boolean"].includes(type);
  }));
}

function serializableValue(value) {
  if (value?.toObject instanceof Function) value = value.toObject();
  const text = JSON.stringify(value, (_key, current) => {
    if (current instanceof Set) return Array.from(current);
    if (current instanceof Map) return Object.fromEntries(current.entries());
    if (current?.toObject instanceof Function) return current.toObject();
    return current;
  });
  if (text === undefined) throw new TypeError("A preset setting value is not JSON-safe.");
  return JSON.parse(text);
}

function cloneValue(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") return value;
  if (globalThis.foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
  return serializableValue(value);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeMutationError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error) {
  return normalizeMutationError(error).message || "Unknown settings preset error.";
}

function slugifyName(value) {
  const text = String(value ?? "").trim();
  if (typeof text.slugify === "function") return text.slugify({ strict: true });
  return text.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Narrow test seam for the Foundry-facing atomic and migration logic. */
export const SETTINGS_PRESET_TESTING = Object.freeze({
  applyActiveRevisionIfNeeded,
  applyPresetAtomically,
  captureCurrentSettings,
  drainPresetApplyCallbacks,
  getManagedPresetSignature,
  isExistingWorldForPresetMigration,
  loadPresetSources,
  mergeKnownSnapshotWithUnknown,
  migrateExistingWorld,
  persistPresetCopies: preset => persistPresetCopies(preset, { scheduleRetry: false }),
  reconcilePendingWrite,
  retryPendingPresetWrite,
  sanitizePresetSettings,
  savePresetCopies,
  validatePresetForStorage,
  wrapManagedSettingOnChanges,
  installPresets(presets) {
    runtime.presets.clear();
    runtime.descriptors.clear();
    for (const preset of presets) setRuntimePreset(preset, "system+world");
  },
  installSources({ system = [], world = [] } = {}) {
    runtime.sourceSystem = new Map(system.map(preset => [preset.id, preset]));
    runtime.sourceWorld = new Map(world.map(preset => [preset.id, preset]));
  },
  reset() {
    clearTimeout(runtime.autosaveTimer);
    clearTimeout(runtime.retryTimer);
    runtime.presets.clear();
    runtime.descriptors.clear();
    runtime.sourceSystem.clear();
    runtime.sourceWorld.clear();
    runtime.applyCallbacks.clear();
    runtime.applyBatches.clear();
    runtime.applyEffectFlags.actors = false;
    runtime.applyEffectFlags.naturalRace = false;
    runtime.applyEffectFlags.combatCarousel = false;
    runtime.applyEffectsQueue = Promise.resolve();
    runtime.deferredApplyEffects = false;
    runtime.pendingDocument = null;
    runtime.migrationSeed = null;
    runtime.legacyRemovedPresetIds.clear();
    runtime.autosaveTimer = null;
    runtime.autosaveDirty = false;
    runtime.retryTimer = null;
    runtime.lastError = "";
    runtime.ready = false;
    runtime.autosaveEnabled = false;
    runtime.busy = false;
    runtime.mutationQueue = Promise.resolve();
    runtime.wrappedChanges = false;
  }
});
