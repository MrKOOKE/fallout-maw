import { TEMPLATES } from "../constants.mjs";
import {
  getSystemActionSettings,
  resetSystemActionSettings,
  setSystemActionSettings
} from "../settings/accessors.mjs";
import { FalloutMaWFormApplicationV2 } from "./base-form-application-v2.mjs";

export class SystemActionSettingsConfig extends FalloutMaWFormApplicationV2 {
  constructor(options = {}) {
    super(options);
    this.actions = getSystemActionSettings();
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-system-action-settings",
    classes: ["fallout-maw", "fallout-maw-config-form", "fallout-maw-system-action-settings"],
    position: {
      width: 760,
      height: "auto"
    },
    window: {
      resizable: true
    },
    actions: {
      browseActionImage: this.#onBrowseActionImage,
      resetDefaults: this.#onResetDefaults
    }
  };

  static PARTS = {
    form: {
      template: TEMPLATES.settings.systemActions
    }
  };

  get title() {
    return "Настройка действий";
  }

  async _prepareContext(options) {
    return {
      ...(await super._prepareContext(options)),
      actions: this.actions
    };
  }

  async _processFormData(_event, _form, _formData) {
    await setSystemActionSettings(this.#readActionsFromForm());
    this.actions = getSystemActionSettings();
    ui.notifications.info("Настройка действий сохранена.");
    return this.forceRender();
  }

  static async #onBrowseActionImage(event, target) {
    event.preventDefault();
    const rows = Array.from(this.form?.querySelectorAll("[data-system-action-row]") ?? []);
    const row = target.closest("[data-system-action-row]");
    const index = rows.indexOf(row);
    if (index < 0) return undefined;

    this.actions = this.#readActionsFromForm();
    const current = this.actions[index]?.img ?? "";
    const picker = new foundry.applications.apps.FilePicker.implementation({
      type: "image",
      current,
      callback: path => {
        this.actions[index].img = path;
        this.forceRender();
      }
    });

    await picker.browse(undefined, { render: false });
    return picker.render({ force: true });
  }

  static async #onResetDefaults(event) {
    event.preventDefault();
    await resetSystemActionSettings();
    this.actions = getSystemActionSettings();
    return this.forceRender();
  }

  #readActionsFromForm() {
    const rows = Array.from(this.form?.querySelectorAll("[data-system-action-row]") ?? []);
    return rows.map(row => ({
      key: row.dataset.actionKey ?? "",
      label: row.dataset.actionLabel ?? "",
      toolKey: row.dataset.toolKey ?? "",
      img: row.querySelector("[data-field='img']")?.value?.trim() ?? ""
    }));
  }
}
