import { TEMPLATES } from "../constants.mjs";
import { getCreatureOptions } from "../settings/accessors.mjs";
import { requestCustomActorTokenSelection } from "../canvas/custom-token-selection.mjs";
import { escapeHtml } from "../utils/dom.mjs";
import {
  getActorRaceId,
  getAnatomyStudyAvailableBonusKeys,
  getAnatomyStudyBonusDefinitions,
  getAnatomyStudyFunctionState,
  getAnatomyStudyMemoryCapacity,
  getAnatomyStudyMemoryUsage,
  isActorDeadForAnatomyStudy
} from "../abilities/anatomy-study.mjs";

const { ApplicationV2, DialogV2, HandlebarsApplicationMixin } = foundry.applications.api;
let anatomyStudyApplication = null;

export function openAnatomyStudyApplication(context = {}) {
  if (anatomyStudyApplication?.matches(context)) {
    anatomyStudyApplication.setContext(context);
    if (anatomyStudyApplication.minimized) void anatomyStudyApplication.maximize();
    return anatomyStudyApplication.render({ force: true });
  }
  void anatomyStudyApplication?.close();
  anatomyStudyApplication = new AnatomyStudyApplication(context);
  return anatomyStudyApplication.render({ force: true });
}

class AnatomyStudyApplication extends HandlebarsApplicationMixin(ApplicationV2) {
  #actor = null;
  #abilityItem = null;
  #abilityFunction = null;
  #sourceToken = null;
  #getActivationState = null;
  #researchHandler = null;
  #forgetHandler = null;
  #busy = false;

  constructor(context = {}, options = {}) {
    super(options);
    this.setContext(context);
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-anatomy-study",
    classes: ["fallout-maw", "fallout-maw-anatomy-study"],
    position: { width: 620, height: "auto" },
    window: { resizable: true, minimizable: true },
    actions: {
      research: AnatomyStudyApplication.#onResearch,
      forget: AnatomyStudyApplication.#onForget
    }
  };

  static PARTS = {
    body: { template: TEMPLATES.anatomyStudy }
  };

  get title() {
    return String(this.#abilityItem?.name ?? "").trim() || "Изучение анатомии";
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
    getActivationState = null,
    onResearch = null,
    onForget = null
  } = {}) {
    this.#actor = actor;
    this.#abilityItem = abilityItem;
    this.#abilityFunction = abilityFunction;
    this.#sourceToken = sourceToken;
    this.#getActivationState = getActivationState;
    this.#researchHandler = onResearch;
    this.#forgetHandler = onForget;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const knowledge = getAnatomyStudyFunctionState(this.#abilityItem, this.#abilityFunction);
    const settings = this.#abilityFunction?.fixedSettings ?? {};
    const capacity = getAnatomyStudyMemoryCapacity(this.#actor, settings);
    const used = getAnatomyStudyMemoryUsage(knowledge);
    const definitions = getAnatomyStudyBonusDefinitions(settings);
    const definitionsByKey = new Map(definitions.map(entry => [entry.key, entry]));
    const raceLabels = getRaceLabels();
    const activation = this.#getActivationState?.() ?? {};
    const full = used >= capacity;
    return {
      ...context,
      actorName: String(this.#actor?.name ?? ""),
      actorImg: String(this.#actor?.img ?? "icons/svg/mystery-man.svg"),
      memory: {
        used,
        capacity,
        percent: capacity > 0 ? Math.min(100, Math.round((used / capacity) * 100)) : 100,
        full
      },
      energyCost: Math.max(0, Number(activation.energyCost) || 0),
      actionPointCost: Math.max(0, Number(activation.actionPointCost) || 0),
      overloadEnergyCost: Math.max(0, Number(activation.overloadEnergyCost) || 0),
      overloadDurationLabel: String(activation.overloadDurationLabel ?? ""),
      researchDisabled: this.#busy || full,
      researchDisabledReason: full ? "Память заполнена. Забудьте одно из направлений, чтобы продолжить." : "",
      races: knowledge.races
        .map(race => ({
          raceId: race.raceId,
          label: raceLabels.get(race.raceId) ?? race.raceId,
          bonuses: race.bonuses
            .map(key => definitionsByKey.get(key))
            .filter(Boolean)
            .map(definition => ({ ...definition, raceId: race.raceId }))
        }))
        .sort((left, right) => left.label.localeCompare(right.label, game.i18n.lang)),
      hasKnowledge: knowledge.races.length > 0
    };
  }

  async _onClose(options) {
    if (anatomyStudyApplication === this) anatomyStudyApplication = null;
    await super._onClose(options);
  }

  async #runResearch() {
    if (this.#busy) return;
    const capacity = getAnatomyStudyMemoryCapacity(this.#actor, this.#abilityFunction?.fixedSettings);
    const knowledge = getAnatomyStudyFunctionState(this.#abilityItem, this.#abilityFunction);
    if (getAnatomyStudyMemoryUsage(knowledge) >= capacity) {
      ui.notifications.warn(`Изучение анатомии: память заполнена (${capacity}/${capacity}).`);
      return;
    }

    this.#busy = true;
    await this.minimize();
    try {
      const selected = await requestCustomActorTokenSelection({
        sourceActor: this.#actor,
        sourceToken: this.#sourceToken,
        includeSelf: false,
        title: this.title,
        noneWarning: "Нет доступных мёртвых целей с неизученной анатомией.",
        instructions: "Изучение анатомии: выберите подсвеченную мёртвую цель. Esc/ПКМ отменяет.",
        getReason: ({ actor }) => getAnatomyTargetUnavailableReason(
          actor,
          this.#abilityItem,
          this.#abilityFunction
        )
      });
      const targetActor = selected?.actor ?? null;
      if (!targetActor) return;
      const raceId = getActorRaceId(targetActor);
      const bonusKey = await promptAnatomyStudyBonus({
        targetActor,
        raceId,
        abilityItem: this.#abilityItem,
        abilityFunction: this.#abilityFunction
      });
      if (!bonusKey) return;
      await this.#researchHandler?.({
        targetActor,
        raceId,
        bonusKey
      });
    } finally {
      this.#busy = false;
      if (this.rendered) {
        await this.maximize();
        await this.render({ force: true });
      }
    }
  }

  static #onResearch(event) {
    event.preventDefault();
    return this.#runResearch();
  }

  static async #onForget(event, target) {
    event.preventDefault();
    if (this.#busy) return;
    const raceId = String(target?.dataset?.raceId ?? "").trim();
    const bonusKey = String(target?.dataset?.bonusKey ?? "").trim();
    if (!raceId || !bonusKey) return;
    const raceLabel = getRaceLabels().get(raceId) ?? raceId;
    const definition = getAnatomyStudyBonusDefinitions(this.#abilityFunction?.fixedSettings)
      .find(entry => entry.key === bonusKey);
    if (!definition) return;
    const confirmed = await DialogV2.confirm({
      window: { title: "Забыть знание" },
      content: `<p>Забыть «${escapeHtml(definition.label)}» для расы «${escapeHtml(raceLabel)}»?</p>`,
      rejectClose: false,
      modal: true
    });
    if (!confirmed) return;
    this.#busy = true;
    try {
      await this.#forgetHandler?.({ raceId, bonusKey });
    } finally {
      this.#busy = false;
      if (this.rendered) await this.render({ force: true });
    }
  }
}

function getAnatomyTargetUnavailableReason(actor = null, abilityItem = null, abilityFunction = null) {
  if (!isActorDeadForAnatomyStudy(actor)) return "Цель не мертва.";
  const raceId = getActorRaceId(actor);
  if (!raceId) return "У цели не указана раса.";
  const knowledge = getAnatomyStudyFunctionState(abilityItem, abilityFunction);
  if (!getAnatomyStudyAvailableBonusKeys(knowledge, raceId).length) return "Все бонусы этой расы уже изучены.";
  return "";
}

async function promptAnatomyStudyBonus({
  targetActor = null,
  raceId = "",
  abilityItem = null,
  abilityFunction = null
} = {}) {
  const knowledge = getAnatomyStudyFunctionState(abilityItem, abilityFunction);
  const available = new Set(getAnatomyStudyAvailableBonusKeys(knowledge, raceId));
  const choices = getAnatomyStudyBonusDefinitions(abilityFunction?.fixedSettings)
    .filter(entry => available.has(entry.key));
  if (!choices.length) {
    ui.notifications.warn("Для этой расы уже изучены все направления.");
    return "";
  }
  const raceLabel = getRaceLabels().get(raceId) ?? raceId;
  const content = `
    <div class="fallout-maw-fixed-function-dialog fallout-maw-anatomy-bonus-dialog">
      <p><strong>${escapeHtml(targetActor?.name ?? raceLabel)}</strong> · ${escapeHtml(raceLabel)}</p>
      ${choices.map((choice, index) => `
        <label class="fallout-maw-radio-card">
          <input type="radio" name="bonusKey" value="${escapeHtml(choice.key)}" ${index === 0 ? "checked" : ""}>
          <span><strong>${escapeHtml(choice.label)}</strong><em>${escapeHtml(choice.valueLabel)}</em></span>
        </label>
      `).join("")}
    </div>
  `;
  const result = await DialogV2.input({
    window: { title: "Выберите направление исследования" },
    content,
    ok: {
      label: "Изучить",
      icon: "fa-solid fa-microscope",
      callback: (_event, button) => String(button.form?.querySelector?.("input[name='bonusKey']:checked")?.value ?? "")
    },
    buttons: [{ action: "cancel", label: game.i18n.localize("FALLOUTMAW.Common.Cancel") }],
    rejectClose: false,
    modal: true,
    position: { width: 480 }
  });
  return available.has(String(result ?? "")) ? String(result) : "";
}

function getRaceLabels() {
  try {
    return new Map((getCreatureOptions().races ?? [])
      .map(race => [String(race?.id ?? "").trim(), String(race?.label ?? race?.name ?? race?.id ?? "")])
      .filter(([id]) => id));
  } catch (_error) {
    return new Map();
  }
}
