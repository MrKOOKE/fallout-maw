import { SYSTEM_ID, TEMPLATES } from "../constants.mjs";
import { getSkillSettings } from "../settings/accessors.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { FalloutMaWFormApplicationV2 } from "./base-form-application-v2.mjs";

const BUTCHERING_OUTCOMES = Object.freeze([
  Object.freeze({ key: "criticalSuccess", label: "Крит. успех" }),
  Object.freeze({ key: "success", label: "Успех" }),
  Object.freeze({ key: "failure", label: "Провал" }),
  Object.freeze({ key: "criticalFailure", label: "Крит. провал" })
]);

let butcheringConfigWindow = null;

export function registerButcheringConfigHooks() {
  Hooks.on("getActorContextOptions", (app, entryOptions) => {
    entryOptions.unshift({
      label: "Разделка",
      icon: "fa-solid fa-drumstick-bite",
      visible: () => game.user?.isGM === true,
      onClick: (_event, li) => openButcheringConfig(getActorFromDirectoryEntry(app, li))
    });
  });
}

export function openButcheringConfig(actor) {
  if (!actor || !game.user?.isGM) return undefined;
  butcheringConfigWindow ??= new ButcheringConfigApplication();
  butcheringConfigWindow.setActor(actor);
  return butcheringConfigWindow.render({ force: true });
}

export function getButcheringConfig(actor) {
  return normalizeButcheringConfig(actor?.getFlag?.(SYSTEM_ID, "butchering"));
}

export function normalizeButcheringConfig(config = {}) {
  const skillKeys = new Set(getSkillSettings().map(skill => String(skill.key ?? "")).filter(Boolean));
  const fallbackSkillKey = getSkillSettings()[0]?.key ?? "";
  const requestedSkillKey = String(config?.skillKey ?? "");
  const stages = normalizeArray(config?.stages).map((stage, index) => normalizeButcheringStage(stage, index));
  return {
    skillKey: skillKeys.has(requestedSkillKey) ? requestedSkillKey : fallbackSkillKey,
    completed: config?.completed === true,
    stages
  };
}

export function hasConfiguredButchering(config = {}) {
  return Boolean(
    String(config?.skillKey ?? "")
    && Array.isArray(config?.stages)
    && config.stages.length
  );
}

export function getButcheringOutcomeDefinitions() {
  return BUTCHERING_OUTCOMES;
}

class ButcheringConfigApplication extends FalloutMaWFormApplicationV2 {
  #actorUuid = "";
  #actor = null;
  #config = normalizeButcheringConfig();
  #dragDrop = null;
  #scrollPosition = { left: 0, top: 0 };

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-butchering-config",
    classes: ["fallout-maw", "fallout-maw-config-form", "fallout-maw-butchering-config"],
    position: {
      width: 1180
    },
    window: {
      resizable: true
    },
    actions: {
      addStage: this.#onAddStage,
      deleteStage: this.#onDeleteStage,
      deleteReward: this.#onDeleteReward
    }
  };

  static PARTS = {
    form: {
      template: TEMPLATES.butcheringConfig
    }
  };

  get title() {
    return `Разделка: ${this.#actor?.name ?? ""}`;
  }

  setActor(actor) {
    this.#actorUuid = actor?.uuid ?? "";
    this.#actor = actor ?? null;
    this.#config = getButcheringConfig(actor);
  }

  get _dragDrop() {
    return this.#dragDrop ??= new foundry.applications.ux.DragDrop.implementation({
      dragSelector: null,
      dropSelector: "[data-butchering-drop]",
      permissions: {
        drop: () => game.user?.isGM === true
      },
      callbacks: {
        drop: this.#onDropReward.bind(this)
      }
    });
  }

  async _prepareContext(options) {
    this.#actor = this.#actorUuid ? await fromUuid(this.#actorUuid) : null;
    this.#config = normalizeButcheringConfig(this.#config);
    const skillSettings = getSkillSettings();
    return {
      ...(await super._prepareContext(options)),
      actor: this.#actor,
      config: {
        ...this.#config,
        stages: this.#config.stages.map((stage, index) => ({
          ...stage,
          displayIndex: index + 1,
          outcomes: BUTCHERING_OUTCOMES.map(outcome => ({
            ...outcome,
            rewards: stage.outcomes[outcome.key] ?? []
          }))
        }))
      },
      outcomeHeaders: BUTCHERING_OUTCOMES,
      skillOptions: skillSettings.map(skill => ({
        key: skill.key,
        label: skill.label,
        selected: skill.key === this.#config.skillKey
      }))
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this._dragDrop.bind(this.element);
    requestAnimationFrame(() => {
      const scroller = this.#getScrollElement();
      if (!scroller) return;
      scroller.scrollLeft = this.#scrollPosition.left;
      scroller.scrollTop = this.#scrollPosition.top;
    });
  }

  render(options = {}) {
    const scroller = this.#getScrollElement();
    if (scroller) {
      this.#scrollPosition = {
        left: scroller.scrollLeft ?? 0,
        top: scroller.scrollTop ?? 0
      };
    }
    return super.render(options);
  }

  async _processFormData() {
    if (!this.#actor || !game.user?.isGM) return undefined;
    this.#config = this.#readConfigFromForm();
    await this.#actor.setFlag(SYSTEM_ID, "butchering", this.#config);
    ui.notifications.info(`Настройки разделки для ${this.#actor.name} сохранены.`);
    return this.close();
  }

  #readConfigFromForm() {
    const stages = Array.from(this.form?.querySelectorAll("[data-butchering-stage]") ?? []).map((stageElement, index) => {
      const existing = this.#config.stages.find(stage => stage.id === stageElement.dataset.stageId)
        ?? this.#config.stages[index]
        ?? createButcheringStage(index);
      const outcomes = {};
      for (const outcome of BUTCHERING_OUTCOMES) {
        outcomes[outcome.key] = Array.from(stageElement.querySelectorAll(`[data-butchering-reward][data-outcome-key="${outcome.key}"]`))
          .map(rewardElement => {
            const rewardId = String(rewardElement.dataset.rewardId ?? "");
            const reward = existing.outcomes?.[outcome.key]?.find(entry => entry.id === rewardId);
            if (!reward) return null;
            const minimum = Math.max(1, toInteger(rewardElement.querySelector("[data-reward-min]")?.value) || 1);
            const maximum = Math.max(1, toInteger(rewardElement.querySelector("[data-reward-max]")?.value) || minimum);
            return {
              ...reward,
              min: Math.min(minimum, maximum),
              max: Math.max(minimum, maximum)
            };
          })
          .filter(Boolean);
      }
      return normalizeButcheringStage({
        ...existing,
        id: String(stageElement.dataset.stageId ?? existing.id),
        name: stageElement.querySelector("[data-stage-name]")?.value ?? existing.name,
        difficulty: stageElement.querySelector("[data-stage-difficulty]")?.value ?? existing.difficulty,
        outcomes
      }, index);
    });

    return normalizeButcheringConfig({
      skillKey: this.form?.querySelector("[name='skillKey']")?.value ?? this.#config.skillKey,
      completed: this.form?.querySelector("[name='completed']")?.checked === true,
      stages
    });
  }

  static #onAddStage(event) {
    event.preventDefault();
    this.#config = this.#readConfigFromForm();
    this.#config.stages.push(createButcheringStage(this.#config.stages.length));
    return this.forceRender();
  }

  static #onDeleteStage(event, target) {
    event.preventDefault();
    this.#config = this.#readConfigFromForm();
    const stageId = String(target.closest("[data-butchering-stage]")?.dataset.stageId ?? "");
    this.#config.stages = this.#config.stages.filter(stage => stage.id !== stageId);
    return this.forceRender();
  }

  static #onDeleteReward(event, target) {
    event.preventDefault();
    this.#config = this.#readConfigFromForm();
    const stageId = String(target.closest("[data-butchering-stage]")?.dataset.stageId ?? "");
    const rewardElement = target.closest("[data-butchering-reward]");
    const outcomeKey = String(rewardElement?.dataset.outcomeKey ?? "");
    const rewardId = String(rewardElement?.dataset.rewardId ?? "");
    const stage = this.#config.stages.find(entry => entry.id === stageId);
    if (!stage || !BUTCHERING_OUTCOMES.some(outcome => outcome.key === outcomeKey)) return undefined;
    stage.outcomes[outcomeKey] = stage.outcomes[outcomeKey].filter(reward => reward.id !== rewardId);
    return this.forceRender();
  }

  async #onDropReward(event) {
    event.preventDefault();
    if (!game.user?.isGM) return undefined;
    const dropzone = event.target?.closest?.("[data-butchering-drop]");
    const stageElement = dropzone?.closest?.("[data-butchering-stage]");
    const stageId = String(stageElement?.dataset.stageId ?? "");
    const outcomeKey = String(dropzone?.dataset.outcomeKey ?? "");
    if (!stageId || !BUTCHERING_OUTCOMES.some(outcome => outcome.key === outcomeKey)) return undefined;

    let data;
    try {
      data = JSON.parse(event.dataTransfer?.getData("text/plain") || "{}");
    } catch (_error) {
      return undefined;
    }
    if (data?.type !== "Item" || !data.uuid) return undefined;

    const item = await fromUuid(String(data.uuid));
    if (!(item instanceof Item)) return undefined;

    this.#config = this.#readConfigFromForm();
    const stage = this.#config.stages.find(entry => entry.id === stageId);
    if (!stage) return undefined;
    stage.outcomes[outcomeKey].push({
      id: foundry.utils.randomID(),
      uuid: item.uuid,
      name: item.name,
      img: item.img,
      min: 1,
      max: 1
    });
    return this.forceRender();
  }

  #getScrollElement() {
    return this.element?.querySelector?.(".window-content")
      ?? this.element?.closest?.(".window-content")
      ?? this.element;
  }
}

function getActorFromDirectoryEntry(app, li) {
  const entry = li?.closest?.("[data-entry-id]") ?? li;
  const actorId = entry?.dataset?.entryId ?? entry?.dataset?.documentId ?? "";
  return app?.collection?.get?.(actorId) ?? game.actors?.get?.(actorId) ?? null;
}

function createButcheringStage(index = 0) {
  return normalizeButcheringStage({
    id: foundry.utils.randomID(),
    name: `Этап ${index + 1}`,
    difficulty: 60,
    outcomes: {}
  }, index);
}

function normalizeButcheringStage(stage = {}, index = 0) {
  const outcomes = {};
  for (const outcome of BUTCHERING_OUTCOMES) {
    outcomes[outcome.key] = normalizeArray(stage?.outcomes?.[outcome.key])
      .map(normalizeButcheringReward)
      .filter(Boolean);
  }
  return {
    id: String(stage?.id ?? "").trim() || foundry.utils.randomID(),
    name: String(stage?.name ?? "").trim() || `Этап ${index + 1}`,
    difficulty: Math.max(0, toInteger(stage?.difficulty ?? 60)),
    outcomes
  };
}

function normalizeButcheringReward(reward = {}) {
  const uuid = String(reward?.uuid ?? "").trim();
  if (!uuid) return null;
  const legacyQuantity = Math.max(1, toInteger(reward?.quantity) || 1);
  const minimum = Math.max(1, toInteger(reward?.min) || legacyQuantity);
  const maximum = Math.max(1, toInteger(reward?.max) || legacyQuantity);
  return {
    id: String(reward?.id ?? "").trim() || foundry.utils.randomID(),
    uuid,
    name: String(reward?.name ?? "").trim() || "Предмет",
    img: String(reward?.img ?? "").trim() || "icons/svg/item-bag.svg",
    min: Math.min(minimum, maximum),
    max: Math.max(minimum, maximum)
  };
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  return Object.keys(value)
    .filter(key => !key.startsWith("-="))
    .sort((left, right) => Number(left) - Number(right))
    .map(key => value[key])
    .filter(Boolean);
}
