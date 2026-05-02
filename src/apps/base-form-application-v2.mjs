const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Shared V2 base class for all non-document Fallout-MaW configuration windows.
 *
 * Foundry V2 applications render a single top-level HTMLElement. For settings windows
 * this element is a form, while the Handlebars template provides only the form body.
 */
export class FalloutMaWFormApplicationV2 extends HandlebarsApplicationMixin(ApplicationV2) {
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
    }
  };

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

  forceRender() {
    return this.render({ force: true });
  }
}

export function getFlatFormData(formData) {
  return formData?.object ?? {};
}

export function getExpandedFormData(formData) {
  return foundry.utils.expandObject(getFlatFormData(formData));
}
