import { TEMPLATES } from "../constants.mjs";
import { requestCustomActorTokenSelection } from "../canvas/custom-token-selection.mjs";
import { getActorAvailableEnergy } from "../combat/energy-resource.mjs";
import { isActorInActiveCombat } from "../combat/combat-membership.mjs";
import {
  findQualityServiceGrant,
  getQualityServiceHoldData,
  getQualityServiceHolds,
  getQualityServiceTier,
  getQualityServiceTiers
} from "../abilities/quality-service.mjs";
import { escapeHtml } from "../utils/dom.mjs";

const { ApplicationV2, DialogV2, HandlebarsApplicationMixin } = foundry.applications.api;
let qualityServiceApplication = null;

export function openQualityServiceApplication(context = {}) {
  if (qualityServiceApplication?.matches(context)) {
    qualityServiceApplication.setContext(context);
    if (qualityServiceApplication.minimized) void qualityServiceApplication.maximize();
    return qualityServiceApplication.render({ force: true });
  }
  void qualityServiceApplication?.close();
  qualityServiceApplication = new QualityServiceApplication(context);
  return qualityServiceApplication.render({ force: true });
}

class QualityServiceApplication extends HandlebarsApplicationMixin(ApplicationV2) {
  #actor = null;
  #abilityItem = null;
  #abilityFunction = null;
  #sourceToken = null;
  #addHandler = null;
  #releaseHandler = null;
  #selectedTierId = "10";
  #busy = false;

  constructor(context = {}, options = {}) {
    super(options);
    this.setContext(context);
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-quality-service",
    classes: ["fallout-maw", "fallout-maw-anatomy-study", "fallout-maw-quality-service"],
    position: { width: 700, height: "auto" },
    window: { resizable: true, minimizable: true },
    actions: {
      tier: QualityServiceApplication.#onTier,
      select: QualityServiceApplication.#onSelect,
      release: QualityServiceApplication.#onRelease
    }
  };

  static PARTS = {
    body: { template: TEMPLATES.qualityService }
  };

  get title() {
    return String(this.#abilityItem?.name ?? "").trim() || "Качественное обслуживание";
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
    const tiers = getQualityServiceTiers(this.#abilityFunction?.fixedSettings);
    const selectedTier = getQualityServiceTier(this.#abilityFunction?.fixedSettings, this.#selectedTierId);
    this.#selectedTierId = selectedTier?.id ?? tiers[0]?.id ?? "";
    const holds = getQualityServiceHolds(this.#actor, {
      abilityItemId: this.#abilityItem?.id,
      functionId: this.#abilityFunction?.id
    }).map(effect => {
      const data = getQualityServiceHoldData(effect) ?? {};
      const target = globalThis.fromUuidSync?.(String(data.targetActorUuid ?? ""));
      return {
        effectId: String(effect.id ?? ""),
        name: String(target?.name ?? data.targetActorName ?? "Удалённая цель"),
        img: String(target?.img ?? data.targetActorImg ?? "icons/svg/mystery-man.svg"),
        energy: Math.max(0, Number(data.holdEnergy) || 0),
        summary: String(data.tierSummary ?? ""),
        targetActorUuid: String(data.targetActorUuid ?? "")
      };
    });
    const inCombat = isActorInActiveCombat(this.#actor);
    const availableEnergy = getActorAvailableEnergy(this.#actor);
    const insufficientEnergy = availableEnergy < Number(selectedTier?.holdEnergy ?? 0);
    const selectionDisabledReason = inCombat
      ? "Новые цели можно выбирать только вне боя. Активные удержания можно отключать."
      : insufficientEnergy
        ? `Для выбранного набора нужно ${selectedTier?.holdEnergy ?? 0} доступной энергии.`
        : "";
    return {
      ...context,
      tiers: tiers.map(tier => ({ ...tier, selected: tier.id === this.#selectedTierId })),
      selectedTier,
      availableEnergy,
      holds,
      hasHolds: holds.length > 0,
      selectionDisabled: this.#busy || Boolean(selectionDisabledReason),
      selectionDisabledReason
    };
  }

  async _onClose(options) {
    if (qualityServiceApplication === this) qualityServiceApplication = null;
    await super._onClose(options);
  }

  async #runSelection() {
    if (this.#busy || isActorInActiveCombat(this.#actor)) return;
    const tier = getQualityServiceTier(this.#abilityFunction?.fixedSettings, this.#selectedTierId);
    if (!tier || getActorAvailableEnergy(this.#actor) < tier.holdEnergy) {
      ui.notifications.warn(`${this.title}: недостаточно доступной энергии.`);
      return;
    }
    const heldActorUuids = new Set(getQualityServiceHolds(this.#actor, {
      abilityItemId: this.#abilityItem?.id,
      functionId: this.#abilityFunction?.id
    }).map(effect => String(getQualityServiceHoldData(effect)?.targetActorUuid ?? "")));
    this.#busy = true;
    await this.minimize();
    try {
      const selected = await requestCustomActorTokenSelection({
        sourceActor: this.#actor,
        sourceToken: this.#sourceToken,
        includeSelf: false,
        title: this.title,
        noneWarning: "Нет доступных целей для Качественного обслуживания.",
        instructions: `${this.title}: выберите подсвеченную цель для набора «${tier.label}». Esc/ПКМ отменяет.`,
        getReason: ({ actor }) => {
          if (heldActorUuids.has(String(actor?.uuid ?? ""))) return "Бонус для этой цели уже удерживается.";
          return findQualityServiceGrant(actor) ? "На цели уже действует Качественное обслуживание." : "";
        }
      });
      if (selected?.actor) await this.#addHandler?.({ targetActor: selected.actor, tierId: tier.id });
    } finally {
      this.#busy = false;
      if (this.rendered) {
        await this.maximize();
        await this.render({ force: true });
      }
    }
  }

  static #onTier(event, target) {
    event.preventDefault();
    if (this.#busy) return;
    const tierId = String(target?.dataset?.tierId ?? "").trim();
    if (!tierId || tierId === this.#selectedTierId) return;
    this.#selectedTierId = tierId;
    return this.render({ force: true });
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
    const data = getQualityServiceHoldData(effect);
    if (!effect || !data) return;
    const confirmed = await DialogV2.confirm({
      window: { title: "Отключить удержание" },
      content: `<p>Отключить Качественное обслуживание для «${escapeHtml(data.targetActorName ?? "цель")}»?</p>`,
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
