import { SYSTEM_ID, SYSTEM_TITLE, TEMPLATES } from "../constants.mjs";
import { CAMP_STATE_SETTING, MIGRATION_STATE_SETTING } from "./constants.mjs";
import { SETTINGS_BASELINE } from "./baseline-data.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const BASELINE_INTERNAL_KEYS = new Set([
  `${SYSTEM_ID}.${CAMP_STATE_SETTING}`,
  `${SYSTEM_ID}.${MIGRATION_STATE_SETTING}`
]);

export class SettingsBaselineConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "fallout-maw-settings-baseline-config",
    classes: ["fallout-maw", "fallout-maw-config-form", "fallout-maw-settings-baseline-config"],
    position: {
      width: 820,
      height: 620
    },
    window: {
      resizable: true
    },
    actions: {
      copy: SettingsBaselineConfig.#onCopy,
      download: SettingsBaselineConfig.#onDownload,
      refresh: SettingsBaselineConfig.#onRefresh
    }
  };

  static PARTS = {
    body: {
      template: TEMPLATES.settings.baseline
    }
  };

  get title() {
    return `${SYSTEM_TITLE}: Settings Baseline`;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const snapshot = createSettingsBaselineSnapshot();
    context.snapshot = snapshot;
    context.snapshotText = formatSettingsBaselineSnapshot(snapshot);
    context.settingCount = Object.keys(snapshot.settings).length;
    return context;
  }

  static async #onCopy(event) {
    event.preventDefault();
    await copySettingsBaselineSnapshot();
  }

  static #onDownload(event) {
    event.preventDefault();
    downloadSettingsBaselineSnapshot();
  }

  static #onRefresh(event) {
    event.preventDefault();
    return this.render({ force: true });
  }
}

export function registerSettingsBaselineTools() {
  CONFIG.FalloutMaW ??= {};
  CONFIG.FalloutMaW.settingsBaseline = {
    snapshot: createSettingsBaselineSnapshot,
    format: formatSettingsBaselineSnapshot,
    copy: copySettingsBaselineSnapshot,
    download: downloadSettingsBaselineSnapshot,
    apply: applySettingsBaselineSnapshot,
    current: SETTINGS_BASELINE
  };
}

export function getBaselineDefault(key, fallback, { namespace = SYSTEM_ID } = {}) {
  const id = `${namespace}.${key}`;
  const entry = getBaselineEntry(id) ?? getBaselineEntry(key);
  if (!entry || !Object.hasOwn(entry, "value")) return cloneSettingValue(fallback);
  return cloneSettingValue(entry.value);
}

export function createSettingsBaselineSnapshot({
  includeClient = true,
  includeWorld = true,
  includeUser = false,
  includeInternal = false
} = {}) {
  const settings = {};
  const scopes = new Set([
    includeClient ? "client" : null,
    includeWorld ? "world" : null,
    includeUser ? "user" : null
  ].filter(Boolean));

  const registered = Array.from(game.settings.settings.values())
    .filter(setting => setting.namespace === SYSTEM_ID)
    .filter(setting => scopes.has(setting.scope))
    .filter(setting => includeInternal || !BASELINE_INTERNAL_KEYS.has(setting.id))
    .sort((left, right) => left.id.localeCompare(right.id));

  for (const setting of registered) {
    let value;
    try {
      value = game.settings.get(setting.namespace, setting.key);
    } catch (_error) {
      value = setting.default;
    }
    settings[setting.id] = {
      scope: setting.scope,
      value: toSerializableSettingValue(value)
    };
  }

  return {
    version: 1,
    system: SYSTEM_ID,
    systemVersion: game.system?.version ?? null,
    createdAt: new Date().toISOString(),
    sourceWorld: game.world?.id ?? null,
    settings
  };
}

export function formatSettingsBaselineSnapshot(snapshot = createSettingsBaselineSnapshot()) {
  return JSON.stringify(snapshot, null, 2);
}

export async function copySettingsBaselineSnapshot(options = {}) {
  const text = formatSettingsBaselineSnapshot(createSettingsBaselineSnapshot(options));
  try {
    await navigator.clipboard.writeText(text);
    ui.notifications.info(`${SYSTEM_TITLE}: settings baseline copied to clipboard.`);
  } catch (_error) {
    ui.notifications.warn(`${SYSTEM_TITLE}: clipboard is unavailable; use Download JSON instead.`);
  }
  return text;
}

export function downloadSettingsBaselineSnapshot(options = {}) {
  const snapshot = createSettingsBaselineSnapshot(options);
  const worldId = String(snapshot.sourceWorld || "world").slugify({ strict: true });
  foundry.utils.saveDataToFile(
    formatSettingsBaselineSnapshot(snapshot),
    "application/json",
    `${SYSTEM_ID}-settings-baseline-${worldId}.json`
  );
  return snapshot;
}

export async function applySettingsBaselineSnapshot(snapshot, {
  includeClient = true,
  includeWorld = true,
  includeUser = false,
  includeInternal = false
} = {}) {
  if (!game.user?.isGM) throw new Error("Only a GM can apply Fallout-MaW settings baseline snapshots.");
  const entries = normalizeSnapshotEntries(snapshot);
  const scopes = new Set([
    includeClient ? "client" : null,
    includeWorld ? "world" : null,
    includeUser ? "user" : null
  ].filter(Boolean));

  const applied = [];
  for (const [id, entry] of entries) {
    if (!includeInternal && BASELINE_INTERNAL_KEYS.has(id)) continue;
    const setting = game.settings.settings.get(id);
    if (!setting || setting.namespace !== SYSTEM_ID || !scopes.has(setting.scope)) continue;
    if (!entry || !Object.hasOwn(entry, "value")) continue;
    await game.settings.set(setting.namespace, setting.key, entry.value);
    applied.push(id);
  }
  ui.notifications.info(`${SYSTEM_TITLE}: applied ${applied.length} settings from baseline.`);
  return applied;
}

function getBaselineEntry(id) {
  return SETTINGS_BASELINE?.settings?.[id] ?? null;
}

function normalizeSnapshotEntries(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return [];
  const settings = snapshot.settings && typeof snapshot.settings === "object" ? snapshot.settings : {};
  return Object.entries(settings).sort(([left], [right]) => left.localeCompare(right));
}

function cloneSettingValue(value) {
  if ((value === null) || (typeof value !== "object")) return value;
  if (globalThis.foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
  return JSON.parse(JSON.stringify(value));
}

function toSerializableSettingValue(value) {
  if (value?.toObject instanceof Function) return value.toObject();
  return JSON.parse(JSON.stringify(value, (_key, current) => {
    if (current instanceof Set) return Array.from(current);
    if (current instanceof Map) return Object.fromEntries(current.entries());
    return current;
  }));
}
