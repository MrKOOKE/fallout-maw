import { TEMPLATES } from "../constants.mjs";
import {
  getCombatSettings,
  setCombatSettings
} from "../settings/accessors.mjs";
import {
  ATTACK_ACTION_POINT_MOVEMENT_LOSS_MODES,
  LIMB_DESTRUCTION_MODES
} from "../settings/combat.mjs";
import { FalloutMaWFormApplicationV2, getExpandedFormData } from "./base-form-application-v2.mjs";
import { activateFormulaAutocomplete } from "./formula-autocomplete.mjs";

const UNCONSCIOUSNESS_FORMULA_VARIABLES = Object.freeze([
  { key: "damage", abbr: "damage", label: "Урон" },
  { key: "normalDamage", abbr: "normalDamage", label: "Урон в обычной зоне" },
  { key: "negativeDamage", abbr: "negativeDamage", label: "Урон в минусовой зоне" },
  { key: "previous", abbr: "previous", label: "Значение до урона" },
  { key: "next", abbr: "next", label: "Значение после урона" },
  { key: "min", abbr: "min", label: "Минимум конечности" },
  { key: "max", abbr: "max", label: "Максимум конечности" },
  { key: "missingStateRatio", abbr: "missingStateRatio", label: "Доля недостающего состояния" },
  { key: "negativeDepthRatio", abbr: "negativeDepthRatio", label: "Доля глубины минуса" },
  { key: "critical", abbr: "critical", label: "Критическая часть: 1 или 0" },
  { key: "resistance", abbr: "resistance", label: "Сопротивление потере сознания" }
]);

const AREA_MOVEMENT_FORMULA_VARIABLES = Object.freeze([
  { key: "actionPointsMax", abbr: "ОД", label: "Максимум ОД" },
  { key: "movementPointsMax", abbr: "ОП", label: "Максимум ОП" }
]);

export class CombatSettingsConfig extends FalloutMaWFormApplicationV2 {
  constructor(options = {}) {
    super(options);
    this.settings = getCombatSettings();
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-combat-settings",
    classes: ["fallout-maw", "fallout-maw-config-form", "fallout-maw-combat-settings"],
    position: {
      width: 840,
      height: 820
    },
    window: {
      resizable: true
    },
    form: {
      closeOnSubmit: true
    },
    actions: {}
  };

  static PARTS = {
    form: {
      template: TEMPLATES.settings.combat,
      scrollable: [".fallout-maw-combat-settings-scroll"]
    }
  };

  get title() {
    return game.i18n.localize("FALLOUTMAW.Settings.Combat.Title");
  }

  async _prepareContext(options) {
    const buildLimbDestructionChoices = selectedMode => [
      {
        value: LIMB_DESTRUCTION_MODES.standard,
        label: game.i18n.localize("FALLOUTMAW.Settings.Combat.LimbDestructionStandard"),
        selected: selectedMode === LIMB_DESTRUCTION_MODES.standard
      },
      {
        value: LIMB_DESTRUCTION_MODES.nonCriticalOnly,
        label: game.i18n.localize("FALLOUTMAW.Settings.Combat.LimbDestructionNonCriticalOnly"),
        selected: selectedMode === LIMB_DESTRUCTION_MODES.nonCriticalOnly
      },
      {
        value: LIMB_DESTRUCTION_MODES.disabled,
        label: game.i18n.localize("FALLOUTMAW.Settings.Combat.LimbDestructionDisabled"),
        selected: selectedMode === LIMB_DESTRUCTION_MODES.disabled
      }
    ];
    return {
      ...(await super._prepareContext(options)),
      settings: this.settings,
      nonPlayerLimbDestructionChoices: buildLimbDestructionChoices(
        this.settings.limbDestruction?.nonPlayerMode
      ),
      playerOwnedLimbDestructionChoices: buildLimbDestructionChoices(
        this.settings.limbDestruction?.playerOwnedMode
      ),
      attackActionPointMovementLossModeChoices: [
        {
          value: ATTACK_ACTION_POINT_MOVEMENT_LOSS_MODES.percent,
          label: game.i18n.localize("FALLOUTMAW.Settings.Combat.AttackActionPointMovementLossModePercent"),
          selected: this.settings.attackActionPointMovementLoss?.mode
            === ATTACK_ACTION_POINT_MOVEMENT_LOSS_MODES.percent
        },
        {
          value: ATTACK_ACTION_POINT_MOVEMENT_LOSS_MODES.disabled,
          label: game.i18n.localize("FALLOUTMAW.Settings.Combat.AttackActionPointMovementLossModeDisabled"),
          selected: this.settings.attackActionPointMovementLoss?.mode
            === ATTACK_ACTION_POINT_MOVEMENT_LOSS_MODES.disabled
        },
        {
          value: ATTACK_ACTION_POINT_MOVEMENT_LOSS_MODES.fullLoss,
          label: game.i18n.localize("FALLOUTMAW.Settings.Combat.AttackActionPointMovementLossModeFullLoss"),
          selected: this.settings.attackActionPointMovementLoss?.mode
            === ATTACK_ACTION_POINT_MOVEMENT_LOSS_MODES.fullLoss
        }
      ],
      turnOrderSchemeChoices: [
        {
          value: "normal",
          label: game.i18n.localize("FALLOUTMAW.Settings.Combat.TurnOrderNormal"),
          selected: this.settings.turnOrder?.scheme === "normal"
        },
        {
          value: "block",
          label: game.i18n.localize("FALLOUTMAW.Settings.Combat.TurnOrderBlock"),
          selected: this.settings.turnOrder?.scheme === "block"
        }
      ]
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    activateFormulaAutocomplete(this.element, {
      variables: [...UNCONSCIOUSNESS_FORMULA_VARIABLES, ...AREA_MOVEMENT_FORMULA_VARIABLES]
    });
  }

  async _processFormData(_event, _form, formData) {
    const data = getExpandedFormData(formData);
    await setCombatSettings(data);
    this.settings = getCombatSettings();
    ui.notifications.info(game.i18n.localize("FALLOUTMAW.Messages.CombatSettingsSaved"));
    return this.forceRender();
  }

}
