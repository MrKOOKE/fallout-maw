import { TEMPLATES } from "../constants.mjs";
import { IDENTIFIER_PATTERN } from "../formulas/index.mjs";
import { getToolSettings, resetToolSettings, setToolSettings } from "../settings/accessors.mjs";
import { localize } from "../utils/i18n.mjs";
import { FalloutMaWFormApplicationV2 } from "./base-form-application-v2.mjs";
import { activateSettingsReorder } from "./settings-reorder.mjs";

export class ToolSettingsConfig extends FalloutMaWFormApplicationV2 {
  constructor(options = {}) {
    super(options);
    this.tools = getToolSettings();
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-tool-settings",
    classes: ["fallout-maw", "fallout-maw-config-form", "fallout-maw-tool-settings"],
    position: {
      width: 760,
      height: "auto"
    },
    window: {
      resizable: true
    },
    form: {
      closeOnSubmit: true
    },
    actions: {
      createTool: this.#onCreateTool,
      deleteTool: this.#onDeleteTool,
      resetDefaults: this.#onResetDefaults
    }
  };

  static PARTS = {
    form: {
      template: TEMPLATES.settings.tools
    }
  };

  get title() {
    return "Настройка инструментов";
  }

  async _prepareContext(options) {
    return {
      ...(await super._prepareContext(options)),
      tools: this.tools
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    activateSettingsReorder(this.element, "[data-tool-row]");
  }

  async _processFormData(_event, _form, _formData) {
    const tools = this.#readToolsFromForm();
    this.#validateTools(tools);
    await setToolSettings(tools);
    this.tools = getToolSettings();
    ui.notifications.info("Настройка инструментов сохранена.");
    return this.forceRender();
  }

  static #onCreateTool(event) {
    event.preventDefault();
    this.tools = this.#readToolsFromForm();
    this.tools.push({
      key: this.#getUniqueKey("newTool"),
      label: "Новый инструмент"
    });
    return this.forceRender();
  }

  static #onDeleteTool(event, target) {
    event.preventDefault();
    const rows = Array.from(this.form?.querySelectorAll("[data-tool-row]") ?? []);
    const index = rows.indexOf(target.closest("[data-tool-row]"));
    if (index < 0) return undefined;

    this.tools = this.#readToolsFromForm();
    this.tools.splice(index, 1);
    return this.forceRender();
  }

  static async #onResetDefaults(event) {
    event.preventDefault();
    await resetToolSettings();
    this.tools = getToolSettings();
    return this.forceRender();
  }

  #readToolsFromForm() {
    const rows = Array.from(this.form?.querySelectorAll("[data-tool-row]") ?? []);
    return rows.map(row => ({
      key: row.querySelector("[data-field='key']")?.value?.trim() ?? "",
      label: row.querySelector("[data-field='label']")?.value?.trim() ?? ""
    }));
  }

  #validateTools(tools) {
    const keys = new Set();
    for (const [index, tool] of tools.entries()) {
      const key = String(tool.key ?? "").trim();
      if (!IDENTIFIER_PATTERN.test(key)) throwValidationError(`Инструмент ${index + 1}: ключ должен быть латинским идентификатором.`);
      if (keys.has(key)) throwValidationError(`Ключ инструмента "${key}" повторяется.`);
      keys.add(key);
    }
  }

  #getUniqueKey(baseKey) {
    const keys = new Set(this.tools.map(tool => tool.key));
    if (!keys.has(baseKey)) return baseKey;

    let index = 2;
    while (keys.has(`${baseKey}${index}`)) index += 1;
    return `${baseKey}${index}`;
  }
}

function throwValidationError(message) {
  ui.notifications.error(message);
  throw new Error(message);
}
