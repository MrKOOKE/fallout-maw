import { TEMPLATES } from "../constants.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { FalloutMaWFormApplicationV2, getExpandedFormData } from "./base-form-application-v2.mjs";

export class ActorTradeSettingsConfig extends FalloutMaWFormApplicationV2 {
  constructor(actor, options = {}) {
    super(options);
    if (!actor) throw new Error("ActorTradeSettingsConfig requires an actor.");
    this.actor = actor;
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-actor-trade-settings",
    classes: ["fallout-maw", "fallout-maw-config-form", "fallout-maw-actor-trade-settings"],
    position: {
      width: 420,
      height: "auto"
    },
    window: {
      resizable: true
    },
    form: {
      closeOnSubmit: true
    }
  };

  static PARTS = {
    form: {
      template: TEMPLATES.actorTradeSettings
    }
  };

  get title() {
    return `Торговля: ${this.actor.name}`;
  }

  async _prepareContext(options) {
    return {
      ...(await super._prepareContext(options)),
      actor: this.actor,
      settings: {
        infiniteInventory: Boolean(this.actor.system.trade.infiniteInventory),
        markupPercent: toInteger(this.actor.system.trade.markupPercent)
      }
    };
  }

  async _processFormData(_event, _form, formData) {
    const data = getExpandedFormData(formData);
    const trade = data.trade ?? {};
    await this.actor.update({
      "system.trade.infiniteInventory": Boolean(trade.infiniteInventory),
      "system.trade.markupPercent": toInteger(trade.markupPercent)
    });
    ui.notifications.info("Настройки торговли сохранены.");
    return this.close();
  }
}
