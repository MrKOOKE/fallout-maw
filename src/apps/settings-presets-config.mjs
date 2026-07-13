import { SYSTEM_ID, TEMPLATES } from "../constants.mjs";
import { format, localize } from "../utils/i18n.mjs";

const { ApplicationV2, DialogV2, HandlebarsApplicationMixin } = foundry.applications.api;

const MAIN_PRESET_ID = SYSTEM_ID;
const LOCALIZATION_ROOT = "FALLOUTMAW.Settings.Presets";

const SOURCE_KEYS = Object.freeze({
  system: `${LOCALIZATION_ROOT}.Sources.System`,
  world: `${LOCALIZATION_ROOT}.Sources.World`,
  "system+world": `${LOCALIZATION_ROOT}.Sources.SystemWorld`
});

const SYNC_STATE_KEYS = Object.freeze({
  synced: `${LOCALIZATION_ROOT}.SyncStates.Synced`,
  pending: `${LOCALIZATION_ROOT}.SyncStates.Pending`,
  "world-only": `${LOCALIZATION_ROOT}.SyncStates.WorldOnly`,
  error: `${LOCALIZATION_ROOT}.SyncStates.Error`
});

/**
 * GM-facing manager for portable Fallout-MaW settings presets.
 */
export class SettingsPresetsConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "fallout-maw-settings-presets-config",
    classes: ["fallout-maw", "fallout-maw-config-form", "fallout-maw-settings-presets-config"],
    position: {
      width: 980,
      height: 700
    },
    window: {
      icon: "fa-solid fa-sliders",
      resizable: true
    },
    actions: {
      activate: SettingsPresetsConfig.#onActivate,
      create: SettingsPresetsConfig.#onCreate,
      delete: SettingsPresetsConfig.#onDelete,
      export: SettingsPresetsConfig.#onExport,
      import: SettingsPresetsConfig.#onImport,
      refresh: SettingsPresetsConfig.#onRefresh,
      rename: SettingsPresetsConfig.#onRename
    }
  };

  static PARTS = {
    body: {
      template: TEMPLATES.settings.settingsPresets
    }
  };

  _operationPending = false;
  _presetChangedHook = null;

  get title() {
    return localize(`${LOCALIZATION_ROOT}.Title`);
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const api = getSettingsPresetsApi();
    const [listed, active, status] = await Promise.all([
      api.list(),
      resolveApiValue(api, "active", null),
      resolveApiValue(api, "status", {})
    ]);
    const presets = Array.isArray(listed) ? listed : [];
    const activePresetId = getActivePresetId(active, status, presets);
    const preparedPresets = presets.map(preset => preparePresetContext(preset, activePresetId));
    const activePreset = preparedPresets.find(preset => preset.active) ?? null;
    const preparedStatus = prepareStatusContext(status);

    return {
      ...context,
      presets: preparedPresets,
      hasPresets: preparedPresets.length > 0,
      activePreset,
      status: preparedStatus,
      importActivate: true
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this._presetChangedHook ??= Hooks.on(`${SYSTEM_ID}.settingsPresetsChanged`, () => {
      if (!this._operationPending && this.rendered) void this.render({ force: true });
    });
    const nameInput = this.element?.querySelector("[data-preset-create-name]");
    nameInput?.addEventListener("keydown", event => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      this.element?.querySelector("[data-action='create']")?.click();
    });
  }

  _onClose(options) {
    if (this._presetChangedHook !== null) Hooks.off(`${SYSTEM_ID}.settingsPresetsChanged`, this._presetChangedHook);
    this._presetChangedHook = null;
    return super._onClose(options);
  }

  static async #onActivate(event, target) {
    event.preventDefault();
    const preset = await this.#getTargetPreset(target);
    if (!preset || preset.active) return undefined;
    return this.#runOperation(
      api => api.activate(preset.id),
      `${LOCALIZATION_ROOT}.Notifications.Activated`,
      { name: preset.name }
    );
  }

  static async #onCreate(event) {
    event.preventDefault();
    const input = this.element?.querySelector("[data-preset-create-name]");
    const name = String(input?.value ?? "").trim();
    if (!name) {
      ui.notifications.warn(localize(`${LOCALIZATION_ROOT}.Warnings.NameRequired`));
      input?.focus();
      return undefined;
    }

    return this.#runOperation(
      api => api.create({ name }),
      `${LOCALIZATION_ROOT}.Notifications.Created`,
      { name }
    );
  }

  static async #onRename(event, target) {
    event.preventDefault();
    const preset = await this.#getTargetPreset(target);
    if (!preset) return undefined;

    const name = await DialogV2.prompt({
      window: {
        title: format(`${LOCALIZATION_ROOT}.Rename.Title`, { name: preset.name }),
        icon: "fa-solid fa-pen"
      },
      content: `
        <label class="form-group">
          <span>${escapeHTML(localize(`${LOCALIZATION_ROOT}.Name`))}</span>
          <input type="text" name="name" value="${escapeAttribute(preset.name)}" autocomplete="off" autofocus>
        </label>
      `,
      ok: {
        label: `${LOCALIZATION_ROOT}.Actions.Rename`,
        callback: (_event, button) => button.form.elements.name.value
      },
      rejectClose: false,
      modal: true
    });
    if (name === null || name === undefined) return undefined;

    const normalizedName = String(name).trim();
    if (!normalizedName) {
      ui.notifications.warn(localize(`${LOCALIZATION_ROOT}.Warnings.NameRequired`));
      return undefined;
    }
    if (normalizedName === preset.name) return undefined;

    return this.#runOperation(
      api => api.rename(preset.id, normalizedName),
      `${LOCALIZATION_ROOT}.Notifications.Renamed`,
      { name: normalizedName }
    );
  }

  static async #onDelete(event, target) {
    event.preventDefault();
    const preset = await this.#getTargetPreset(target);
    if (!preset || preset.isMain || !preset.canDelete) return undefined;

    const confirmed = await DialogV2.confirm({
      window: {
        title: format(`${LOCALIZATION_ROOT}.Delete.Title`, { name: preset.name }),
        icon: "fa-solid fa-trash"
      },
      content: `<p>${escapeHTML(format(`${LOCALIZATION_ROOT}.Delete.Content`, { name: preset.name }))}</p>${
        preset.active ? `<p class="notification warning">${escapeHTML(localize(`${LOCALIZATION_ROOT}.Delete.ActiveWarning`))}</p>` : ""
      }`,
      yes: {
        label: `${LOCALIZATION_ROOT}.Actions.Delete`
      },
      no: {
        label: "FALLOUTMAW.Common.Cancel"
      },
      rejectClose: false,
      modal: true
    });
    if (!confirmed) return undefined;

    return this.#runOperation(
      api => api.remove(preset.id),
      `${LOCALIZATION_ROOT}.Notifications.Deleted`,
      { name: preset.name }
    );
  }

  static async #onExport(event, target) {
    event.preventDefault();
    const preset = await this.#getTargetPreset(target);
    if (!preset) return undefined;
    return this.#runOperation(
      api => api.export(preset.id),
      `${LOCALIZATION_ROOT}.Notifications.Exported`,
      { name: preset.name },
      { render: false }
    );
  }

  static async #onImport(event) {
    event.preventDefault();
    const input = this.element?.querySelector("[data-preset-import-file]");
    const file = input?.files?.[0];
    if (!file) {
      ui.notifications.warn(localize(`${LOCALIZATION_ROOT}.Warnings.FileRequired`));
      input?.focus();
      return undefined;
    }

    let metadata;
    try {
      metadata = await readImportMetadata(file);
    } catch (error) {
      notifyOperationError(error);
      return undefined;
    }

    let api;
    let listed;
    try {
      api = getSettingsPresetsApi();
      listed = await api.list();
    } catch (error) {
      notifyOperationError(error);
      return undefined;
    }
    const existing = Array.isArray(listed)
      ? listed.find(preset => String(preset?.id ?? "") === metadata.id)
      : null;

    if (existing) {
      const confirmed = await DialogV2.confirm({
        window: {
          title: localize(`${LOCALIZATION_ROOT}.Import.ReplaceTitle`),
          icon: "fa-solid fa-file-import"
        },
        content: `<p>${escapeHTML(format(`${LOCALIZATION_ROOT}.Import.ReplaceContent`, {
          name: existing.name || metadata.name || metadata.id,
          id: metadata.id
        }))}</p>`,
        yes: {
          label: `${LOCALIZATION_ROOT}.Import.Replace`
        },
        no: {
          label: "FALLOUTMAW.Common.Cancel"
        },
        rejectClose: false,
        modal: true
      });
      if (!confirmed) return undefined;
    }

    const activate = Boolean(this.element?.querySelector("[data-preset-import-activate]")?.checked);
    return this.#runOperation(
      manager => manager.importFile(file, { activate }),
      `${LOCALIZATION_ROOT}.Notifications.Imported`,
      { name: metadata.name || file.name }
    );
  }

  static async #onRefresh(event) {
    event.preventDefault();
    return this.#runOperation(
      api => api.refresh(),
      `${LOCALIZATION_ROOT}.Notifications.Refreshed`
    );
  }

  async #getTargetPreset(target) {
    const id = String(target?.closest?.("[data-preset-id]")?.dataset?.presetId ?? "").trim();
    if (!id) return null;
    try {
      const presets = await getSettingsPresetsApi().list();
      return Array.isArray(presets)
        ? presets.find(preset => String(preset?.id ?? "") === id) ?? null
        : null;
    } catch (error) {
      notifyOperationError(error);
      return null;
    }
  }

  async #runOperation(callback, successKey, successData = {}, { render = true } = {}) {
    if (this._operationPending) return undefined;
    if (!game.user?.isGM) {
      ui.notifications.error(localize(`${LOCALIZATION_ROOT}.Warnings.OnlyGM`));
      return undefined;
    }

    this._operationPending = true;
    this.#setBusy(true);
    try {
      const result = await callback(getSettingsPresetsApi());
      if (successKey) ui.notifications.info(format(successKey, successData));
      if (render) await this.render({ force: true });
      return result;
    } catch (error) {
      notifyOperationError(error);
      return undefined;
    } finally {
      this._operationPending = false;
      this.#setBusy(false);
    }
  }

  #setBusy(busy) {
    const root = this.element;
    if (!root) return;
    root.classList.toggle("is-busy", busy);
    root.setAttribute("aria-busy", String(busy));
    if (busy) {
      root.querySelectorAll("button, input").forEach(control => {
        control.dataset.presetWasDisabled = String(control.disabled);
        control.disabled = true;
      });
    } else {
      root.querySelectorAll("[data-preset-was-disabled]").forEach(control => {
        control.disabled = control.dataset.presetWasDisabled === "true";
        delete control.dataset.presetWasDisabled;
      });
    }
  }
}

function getSettingsPresetsApi() {
  const api = CONFIG.FalloutMaW?.settingsPresets;
  const required = ["list", "activate", "create", "rename", "remove", "importFile", "export", "refresh"];
  if (!api || required.some(method => !(api[method] instanceof Function))) {
    throw new Error(localize(`${LOCALIZATION_ROOT}.Errors.ApiUnavailable`));
  }
  return api;
}

async function resolveApiValue(api, property, fallback) {
  const value = api[property];
  if (value instanceof Function) return (await value.call(api)) ?? fallback;
  return (await value) ?? fallback;
}

function getActivePresetId(active, status, presets) {
  if (typeof active === "string") return active;
  if (active?.id) return String(active.id);
  if (status?.activePresetId) return String(status.activePresetId);
  return String(presets.find(preset => preset?.active)?.id ?? "");
}

function preparePresetContext(preset, activePresetId) {
  const id = String(preset?.id ?? "");
  const name = String(preset?.name || id || localize(`${LOCALIZATION_ROOT}.Unnamed`));
  const revision = String(preset?.revision ?? "");
  const source = String(preset?.source ?? "");
  const syncState = String(preset?.syncState ?? "");
  const isMain = Boolean(preset?.isMain) || id === MAIN_PRESET_ID;
  const active = Boolean(preset?.active) || (!!id && id === activePresetId);
  const canDelete = !isMain && (preset?.canDelete ?? true);

  return {
    ...preset,
    id,
    name,
    revision,
    shortId: shorten(id, 12),
    shortRevision: revision ? shorten(revision, 12) : "—",
    source,
    sourceLabel: localizeEnum(source, SOURCE_KEYS),
    syncState,
    syncLabel: localizeEnum(syncState, SYNC_STATE_KEYS),
    syncClass: normalizeCssToken(syncState, "unknown"),
    active,
    isMain,
    seedPending: Boolean(preset?.seedPending),
    canActivate: !active,
    canRename: true,
    canDelete,
    canExport: true,
    rowClass: active ? "is-active" : ""
  };
}

function prepareStatusContext(status = {}) {
  let state = "ready";
  if (status?.lastError) state = "error";
  else if (status?.busy) state = "busy";
  else if (status?.pendingPresetId || status?.pendingRevision) state = "pending";
  else if (status?.ready === false) state = "loading";

  const key = `${LOCALIZATION_ROOT}.ManagerStates.${state[0].toUpperCase()}${state.slice(1)}`;
  return {
    ...status,
    state,
    stateClass: normalizeCssToken(state, "unknown"),
    label: localize(key),
    error: status?.lastError ? String(status.lastError?.message ?? status.lastError) : ""
  };
}

async function readImportMetadata(file) {
  let document;
  try {
    document = JSON.parse(await foundry.utils.readTextFromFile(file));
  } catch (_error) {
    throw new Error(localize(`${LOCALIZATION_ROOT}.Errors.InvalidJson`));
  }

  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error(localize(`${LOCALIZATION_ROOT}.Errors.InvalidJson`));
  }

  const candidate = document.preset && typeof document.preset === "object" ? document.preset : document;
  return {
    id: String(candidate.id ?? "").trim(),
    name: String(candidate.name ?? "").trim()
  };
}

function notifyOperationError(error) {
  const message = String(error?.message ?? error ?? localize(`${LOCALIZATION_ROOT}.Errors.Unknown`));
  console.error(`${SYSTEM_ID} | Settings presets operation failed`, error);
  ui.notifications.error(format(`${LOCALIZATION_ROOT}.Errors.OperationFailed`, { message }));
}

function localizeEnum(value, keys) {
  const key = keys[value];
  if (key) return localize(key);
  return value || localize(`${LOCALIZATION_ROOT}.Unknown`);
}

function shorten(value, maxLength) {
  const text = String(value ?? "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 1))}…`;
}

function normalizeCssToken(value, fallback) {
  const token = String(value ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return token || fallback;
}

function escapeHTML(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

function escapeAttribute(value) {
  return escapeHTML(value).replace(/"/g, "&quot;");
}
