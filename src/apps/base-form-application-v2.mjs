import { captureApplicationScrollPositions, restoreApplicationScrollPositions } from "../utils/application-scroll.mjs";
import {
  preserveTextSelectionBeforePartSync,
  restoreTextSelectionAfterPartSync
} from "../utils/application-focus-state.mjs";
import { openPresetMigrationForApplication } from "./settings-preset-migration.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Shared V2 base class for all non-document Fallout-MaW configuration windows.
 *
 * Foundry V2 applications render a single top-level HTMLElement. For settings windows
 * this element is a form, while the Handlebars template provides only the form body.
 */
export class FalloutMaWFormApplicationV2 extends HandlebarsApplicationMixin(ApplicationV2) {
  #scrollPositions = new Map();

  static DEFAULT_OPTIONS = {
    tag: "form",
    classes: ["fallout-maw", "fallout-maw-config-form"],
    position: {
      width: 720,
      height: "auto"
    },
    window: {
      resizable: true
    },
    form: {
      handler: FalloutMaWFormApplicationV2.handleFormSubmit,
      submitOnChange: false,
      closeOnSubmit: false
    },
    actions: {
      migratePresetSettings: FalloutMaWFormApplicationV2.onMigratePresetSettings
    }
  };

  static onMigratePresetSettings(event) {
    event.preventDefault();
    return openPresetMigrationForApplication(this);
  }

  static async handleFormSubmit(event, form, formData) {
    event.preventDefault();
    await this._processFormData(event, form, formData);
  }

  async _processFormData(_event, _form, _formData) {
    throw new Error(`${this.constructor.name} must implement _processFormData().`);
  }

  get form() {
    return this.element instanceof HTMLFormElement ? this.element : this.element?.querySelector("form");
  }

  _preSyncPartState(partId, newElement, priorElement, state) {
    super._preSyncPartState(partId, newElement, priorElement, state);
    preserveTextSelectionBeforePartSync(priorElement, state);
  }

  _syncPartState(partId, newElement, priorElement, state) {
    super._syncPartState(partId, newElement, priorElement, state);
    restoreTextSelectionAfterPartSync(newElement, state);
  }

  render(options = {}) {
    this.#captureScrollPositions();
    return super.render(options);
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.#restoreScrollPositions();
  }

  forceRender() {
    return this.render();
  }

  #captureScrollPositions() {
    this.#scrollPositions = captureApplicationScrollPositions(this.element, this.constructor.scrollPreservationSelectors);
  }

  #restoreScrollPositions() {
    restoreApplicationScrollPositions(this.element, this.#scrollPositions, this.constructor.scrollPreservationSelectors);
  }

  static get scrollPreservationSelectors() {
    return [".window-content", ".fallout-maw-sheet-body > .tab.active"];
  }
}

export function getFlatFormData(formData) {
  return formData?.object ?? {};
}

export function getExpandedFormData(formData) {
  return foundry.utils.expandObject(getFlatFormData(formData));
}
