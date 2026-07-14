import {
  getTokenPrototypeDefaultForActorType,
  setTokenPrototypeDefault
} from "../settings/token-prototype-defaults.mjs";
import { openPresetMigrationForApplication } from "./settings-preset-migration.mjs";

const ACTOR_TYPE_LABELS = Object.freeze({
  character: "Персонаж",
  construct: "Конструкт",
  group: "Группа"
});

class TokenPrototypeDefaultsConfig extends foundry.applications.sheets.PrototypeTokenConfig {
  constructor(options = {}) {
    const actorType = options.actorType ?? new.target.actorType;
    const actor = createSyntheticActor(actorType, new.target.documentActorType ?? actorType);
    super({ ...options, prototype: actor.prototypeToken });
    this.actorType = actorType;
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-token-prototype-defaults",
    actions: {
      assignToken: TokenPrototypeDefaultsConfig.onAssignToken,
      migratePresetSettings: TokenPrototypeDefaultsConfig.onMigratePresetSettings
    },
    form: {
      handler: TokenPrototypeDefaultsConfig.onSubmit,
      closeOnSubmit: true
    }
  };

  get title() {
    return `Базовый прототип токена: ${ACTOR_TYPE_LABELS[this.actorType] ?? this.actorType}`;
  }

  _prepareButtons() {
    const buttons = super._prepareButtons();
    buttons.unshift({
      type: "button",
      icon: "fa-solid fa-code-compare",
      label: "Мигрировать из других пресетов",
      action: "migratePresetSettings"
    });
    return buttons;
  }

  static onMigratePresetSettings(event) {
    event.preventDefault();
    return openPresetMigrationForApplication(this);
  }

  static async onAssignToken() {
    const tokens = canvas.ready ? canvas.tokens.controlled : [];
    if (tokens.length !== 1) {
      ui.notifications.warn("TOKEN.AssignWarn", { localize: true });
      return;
    }

    const token = tokens[0].document.toObject();
    token.randomImg = this.form.elements.randomImg.checked;
    if (token.randomImg) delete token.texture.src;
    await saveDefaults(this, token);
    ui.notifications.info(`Базовый прототип токена сохранен: ${ACTOR_TYPE_LABELS[this.actorType] ?? this.actorType}`);
    await this.render({ force: true });
  }

  static async onSubmit(event, form, formData) {
    const submitData = this._processFormData(event, form, formData);
    await saveDefaults(this, submitData);
    ui.notifications.info(`Базовый прототип токена сохранен: ${ACTOR_TYPE_LABELS[this.actorType] ?? this.actorType}`);
  }
}

export class CharacterTokenPrototypeDefaultsConfig extends TokenPrototypeDefaultsConfig {
  static actorType = "character";
}

export class ConstructTokenPrototypeDefaultsConfig extends TokenPrototypeDefaultsConfig {
  static actorType = "construct";
}

export class GroupTokenPrototypeDefaultsConfig extends TokenPrototypeDefaultsConfig {
  static actorType = "group";
  static documentActorType = "character";
}

async function saveDefaults(app, tokenData) {
  await setTokenPrototypeDefault(app.actorType, tokenData);
  const defaults = getTokenPrototypeDefaultForActorType(app.actorType);
  app.actor.updateSource({ prototypeToken: { ...defaults, name: app.actor.name } });
}

function createSyntheticActor(actorType, documentActorType = actorType) {
  const label = ACTOR_TYPE_LABELS[actorType] ?? actorType;
  return new Actor.implementation({
    _id: foundry.utils.randomID(),
    name: `Базовый прототип токена: ${label}`,
    type: documentActorType,
    prototypeToken: {
      ...getTokenPrototypeDefaultForActorType(actorType),
      name: `Базовый прототип токена: ${label}`
    }
  });
}
