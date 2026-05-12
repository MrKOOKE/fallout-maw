import { TEMPLATES } from "../constants.mjs";
import { getTokenActionHudDamageIcons, setTokenActionHudDamageIcons } from "../settings/accessors.mjs";
import { FalloutMaWFormApplicationV2, getFlatFormData } from "./base-form-application-v2.mjs";

export class TokenActionHudSettings extends FalloutMaWFormApplicationV2 {
  constructor(options = {}) {
    super(options);
    this.icons = getTokenActionHudDamageIcons();
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-token-action-hud-settings",
    classes: ["fallout-maw", "fallout-maw-config-form", "fallout-maw-token-action-hud-settings"],
    position: {
      width: 560,
      height: "auto"
    },
    window: {
      resizable: false
    },
    form: {
      handler: TokenActionHudSettings.handleFormSubmit,
      submitOnChange: false,
      closeOnSubmit: true
    },
    actions: {
      browseDamageReductionImage: this.#onBrowseDamageReductionImage,
      browseDamageBlockedImage: this.#onBrowseDamageBlockedImage
    }
  };

  static PARTS = {
    form: {
      template: TEMPLATES.settings.tokenActionHud
    }
  };

  get title() {
    return game.i18n.localize("FALLOUTMAW.Settings.HUD.Title");
  }

  async _prepareContext(options) {
    return {
      ...(await super._prepareContext(options)),
      ...this.icons
    };
  }

  async _processFormData(_event, _form, formData) {
    const data = getFlatFormData(formData);
    this.icons = {
      damageReductionIcon: data.damageReductionIcon,
      damageBlockedIcon: data.damageBlockedIcon
    };
    await setTokenActionHudDamageIcons({
      ...this.icons
    });
  }

  static #onBrowseDamageReductionImage(event) {
    event.preventDefault();
    return this.#browseImagePath("damageReductionIcon");
  }

  static #onBrowseDamageBlockedImage(event) {
    event.preventDefault();
    return this.#browseImagePath("damageBlockedIcon");
  }

  async #browseImagePath(fieldName) {
    this.icons = this.#readIconsFromForm();
    const current = this.icons[fieldName] ?? "";
    const picker = new foundry.applications.apps.FilePicker.implementation({
      type: "image",
      current,
      callback: path => {
        this.icons[fieldName] = path;
        this.forceRender();
      }
    });

    await picker.browse(undefined, { render: false });
    return picker.render({ force: true });
  }

  #readIconsFromForm() {
    return {
      damageReductionIcon: this.form?.querySelector("[name='damageReductionIcon']")?.value?.trim() ?? this.icons.damageReductionIcon,
      damageBlockedIcon: this.form?.querySelector("[name='damageBlockedIcon']")?.value?.trim() ?? this.icons.damageBlockedIcon
    };
  }
}
