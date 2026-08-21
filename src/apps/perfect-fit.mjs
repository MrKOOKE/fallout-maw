import { TEMPLATES } from "../constants.mjs";
import { requestCustomActorTokenSelection } from "../canvas/custom-token-selection.mjs";
import { getActorAvailableEnergy } from "../combat/energy-resource.mjs";
import { isActorInActiveCombat } from "../combat/combat-membership.mjs";
import {
  findPerfectFitGrant,
  getPerfectFitHoldData,
  getPerfectFitHolds
} from "../abilities/perfect-fit.mjs";
import { normalizePerfectFitSettings } from "../settings/abilities.mjs";
import { escapeHtml } from "../utils/dom.mjs";

const { ApplicationV2, DialogV2, HandlebarsApplicationMixin } = foundry.applications.api;
let perfectFitApplication = null;

export function openPerfectFitApplication(context = {}) {
  if (perfectFitApplication?.matches(context)) {
    perfectFitApplication.setContext(context);
    if (perfectFitApplication.minimized) void perfectFitApplication.maximize();
    return perfectFitApplication.render({ force: true });
  }
  void perfectFitApplication?.close();
  perfectFitApplication = new PerfectFitApplication(context);
  return perfectFitApplication.render({ force: true });
}

class PerfectFitApplication extends HandlebarsApplicationMixin(ApplicationV2) {
  #actor = null;
  #abilityItem = null;
  #abilityFunction = null;
  #sourceToken = null;
  #addHandler = null;
  #releaseHandler = null;
  #busy = false;

  constructor(context = {}, options = {}) {
    super(options);
    this.setContext(context);
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-perfect-fit",
    classes: ["fallout-maw", "fallout-maw-anatomy-study", "fallout-maw-perfect-fit"],
    position: { width: 620, height: "auto" },
    window: { resizable: true, minimizable: true },
    actions: {
      select: PerfectFitApplication.#onSelect,
      release: PerfectFitApplication.#onRelease
    }
  };

  static PARTS = {
    body: { template: TEMPLATES.perfectFit }
  };

  get title() {
    return String(this.#abilityItem?.name ?? "").trim() || "Идеальная подгонка";
  }

  matches({ actor = null, abilityItem = null, abilityFunction = null } = {}) {
    return String(this.#actor?.uuid ?? "") === String(actor?.uuid ?? "")
      && String(this.#abilityItem?.id ?? "") === String(abilityItem?.id ?? "")
      && String(this.#abilityFunction?.id ?? "") === String(abilityFunction?.id ?? "");
  }

  setContext({
    actor = null,
    abilityItem = null,
    abilityFunction = null,
    sourceToken = null,
    onAdd = null,
    onRelease = null
  } = {}) {
    this.#actor = actor;
    this.#abilityItem = abilityItem;
    this.#abilityFunction = abilityFunction;
    this.#sourceToken = sourceToken;
    this.#addHandler = onAdd;
    this.#releaseHandler = onRelease;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const settings = normalizePerfectFitSettings(this.#abilityFunction?.fixedSettings);
    const holds = getPerfectFitHolds(this.#actor, {
      abilityItemId: this.#abilityItem?.id,
      functionId: this.#abilityFunction?.id
    }).map(effect => {
      const data = getPerfectFitHoldData(effect) ?? {};
      const target = globalThis.fromUuidSync?.(String(data.targetActorUuid ?? ""));
      return {
        effectId: String(effect.id ?? ""),
        name: String(target?.name ?? data.targetActorName ?? "Удалённая цель"),
        img: String(target?.img ?? data.targetActorImg ?? "icons/svg/mystery-man.svg"),
        energy: Math.max(0, Number(data.holdEnergy) || 0),
        equipmentRequirementPercent: Number(data.equipmentRequirementPercent) || 0,
        weaponRequirementPercent: Number(data.weaponRequirementPercent) || 0,
        targetActorUuid: String(data.targetActorUuid ?? "")
      };
    });
    const inCombat = isActorInActiveCombat(this.#actor);
    const availableEnergy = getActorAvailableEnergy(this.#actor);
    const insufficientEnergy = availableEnergy < settings.holdEnergy;
    const selectionDisabledReason = inCombat
      ? "Новые цели можно выбирать только вне боя. Активные удержания можно отключать."
      : insufficientEnergy
        ? `Для новой цели нужно ${settings.holdEnergy} доступной энергии.`
        : "";
    return {
      ...context,
      equipmentRequirementPercent: settings.equipmentRequirementPercent,
      weaponRequirementPercent: settings.weaponRequirementPercent,
      holdEnergy: settings.holdEnergy,
      availableEnergy,
      holds,
      hasHolds: holds.length > 0,
      selectionDisabled: this.#busy || Boolean(selectionDisabledReason),
      selectionDisabledReason
    };
  }

  async _onClose(options) {
    if (perfectFitApplication === this) perfectFitApplication = null;
    await super._onClose(options);
  }

  async #runSelection() {
    if (this.#busy || isActorInActiveCombat(this.#actor)) return;
    const settings = normalizePerfectFitSettings(this.#abilityFunction?.fixedSettings);
    if (getActorAvailableEnergy(this.#actor) < settings.holdEnergy) {
      ui.notifications.warn(`${this.title}: недостаточно доступной энергии.`);
      return;
    }
    const heldActorUuids = new Set(getPerfectFitHolds(this.#actor, {
      abilityItemId: this.#abilityItem?.id,
      functionId: this.#abilityFunction?.id
    }).map(effect => String(getPerfectFitHoldData(effect)?.targetActorUuid ?? "")));
    this.#busy = true;
    await this.minimize();
    try {
      const selected = await requestCustomActorTokenSelection({
        sourceActor: this.#actor,
        sourceToken: this.#sourceToken,
        includeSelf: false,
        title: this.title,
        noneWarning: "Нет доступных целей для Идеальной подгонки.",
        instructions: "Идеальная подгонка: выберите подсвеченную цель. Esc/ПКМ отменяет.",
        getReason: ({ actor }) => {
          if (heldActorUuids.has(String(actor?.uuid ?? ""))) return "Бонус для этой цели уже удерживается.";
          return findPerfectFitGrant(actor) ? "На цели уже действует Идеальная подгонка." : "";
        }
      });
      if (selected?.actor) await this.#addHandler?.({ targetActor: selected.actor });
    } finally {
      this.#busy = false;
      if (this.rendered) {
        await this.maximize();
        await this.render({ force: true });
      }
    }
  }

  static #onSelect(event) {
    event.preventDefault();
    return this.#runSelection();
  }

  static async #onRelease(event, target) {
    event.preventDefault();
    if (this.#busy) return;
    const effectId = String(target?.dataset?.effectId ?? "").trim();
    const effect = this.#actor?.effects?.get?.(effectId)
      ?? Array.from(this.#actor?.effects ?? []).find(entry => entry.id === effectId);
    const data = getPerfectFitHoldData(effect);
    if (!effect || !data) return;
    const confirmed = await DialogV2.confirm({
      window: { title: "Отключить удержание" },
      content: `<p>Отключить Идеальную подгонку для «${escapeHtml(data.targetActorName ?? "цель")}»?</p>`,
      rejectClose: false,
      modal: true
    });
    if (!confirmed) return;
    this.#busy = true;
    try {
      await this.#releaseHandler?.({ effectId });
    } finally {
      this.#busy = false;
      if (this.rendered) await this.render({ force: true });
    }
  }
}
