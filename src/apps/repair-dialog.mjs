import { SYSTEM_ID, TEMPLATES } from "../constants.mjs";
import { requestCustomActorTokenSelection } from "../canvas/custom-token-selection.mjs";
import { requestSkillCheck } from "../rolls/skill-check.mjs";
import {
  getCraftingSettings,
  getSkillSettings,
  getSystemActionSettings,
  getToolSettings
} from "../settings/accessors.mjs";
import { getRepairToolCostMultiplier, isSkillThresholdMode } from "../settings/crafting.mjs";
import { normalizeImagePath } from "../utils/actor-display-data.mjs";
import {
  ITEM_FUNCTIONS,
  createToolFunctionKey,
  createToolResourceValueUpdate,
  getConditionFunction,
  getToolFunction,
  getToolResourceState,
  hasItemFunction
} from "../utils/item-functions.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { createActorOperationLock } from "../utils/actor-operation-lock.mjs";
import {
  applyToolSupplyCostPercent,
  getActorToolSupplyCostPercent
} from "../utils/tool-supply-cost.mjs";
import { executeAtomicActorItemUpdates } from "../utils/atomic-actor-item-updates.mjs";
import {
  groupToolSelectionOptions,
  normalizeToolSelectionPolicy,
  selectToolByPolicy
} from "../utils/tool-selection-policy.mjs";
import { analyzeMassRepairToolAvailability } from "../utils/repair-tool-availability.mjs";
import { withSystemEventRoot } from "../events/dispatcher.mjs";
import { runTerminalSystemEventWorkflow } from "../utils/system-event-workflow.mjs";
import {
  bindMassOperationDialogSubmitState,
  getMassOperationDialogSelectionState
} from "./mass-operation-dialog-state.mjs";

const { ApplicationV2, DialogV2, HandlebarsApplicationMixin } = foundry.applications.api;
const REPAIR_SOCKET = `system.${SYSTEM_ID}`;
const REPAIR_SOCKET_SCOPE = "fallout-maw.repair";
const REPAIR_SOCKET_TIMEOUT = 12 * 60 * 1000;
const REPAIR_SOCKET_RECEIPT_TTL = 30 * 60 * 1000;
const MAX_HANDLED_REPAIR_SOCKET_REQUESTS = 256;
const TOOL_CLASS_RANK = Object.freeze({ D: 0, C: 1, B: 2, A: 3, S: 4 });
const REPAIR_PROGRESS_STEP_RATIO = 0.25;
const DEFAULT_REPAIR_SKILL_KEY = "repair";
const pendingRepairSocketRequests = new Map();
const handledRepairSocketRequests = new Map();
const repairAuthorityLock = createActorOperationLock();

export function registerRepairSocket() {
  game.socket.on(REPAIR_SOCKET, handleRepairSocketMessage);
}

export async function requestRepairTarget(sourceToken) {
  const sourceActor = sourceToken?.actor;
  if (!sourceActor) return undefined;

  const action = getSystemActionSettings().find(entry => entry.key === "repair");
  const toolKey = action?.toolKey ?? "repair";
  const selected = await requestCustomActorTokenSelection({
    sourceActor,
    sourceToken,
    includeSelf: true,
    title: "Ремонт",
    noneWarning: "Нет подходящих целей для ремонта.",
    instructions: "Ремонт: выберите цель. Esc/ПКМ отменяет."
  });
  const targetToken = selected?.token ?? null;
  if (!selected?.actor || !targetToken) return undefined;

  const targetContext = await getRepairTargetContext(targetToken, toolKey, sourceActor);
  if (!targetContext) return undefined;

  return new RepairDialog({
    sourceActor,
    sourceToken,
    targetContext,
    targetToken,
    toolKey
  }).render({ force: true });
}

class RepairDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  #sourceActor = null;
  #sourceToken = null;
  #targetContext = null;
  #targetToken = null;
  #toolKey = "repair";
  #activeItemId = "";
  #repairInFlight = false;
  #disabledRepairActionStates = null;
  #pendingMassRepair = null;

  constructor({ sourceActor, sourceToken, targetContext, targetToken, toolKey = "repair" } = {}, options = {}) {
    super(options);
    this.#sourceActor = sourceActor;
    this.#sourceToken = sourceToken;
    this.#targetContext = targetContext;
    this.#targetToken = targetToken;
    this.#toolKey = toolKey;
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-repair-dialog",
    classes: ["fallout-maw", "fallout-maw-medicine-dialog", "fallout-maw-repair-dialog"],
    position: {
      width: 1290,
      height: "auto"
    },
    window: {
      resizable: true
    },
    actions: {
      startRepair: this.#onStartRepair,
      repairWithInstrument: this.#onRepairWithInstrument,
      repairAll: this.#onRepairAll
    }
  };

  static PARTS = {
    body: {
      template: TEMPLATES.repairDialog
    }
  };

  get title() {
    const sourceName = this.#sourceActor?.name ?? "";
    const targetName = this.#targetContext?.name ?? "";
    if (this.#isSelfRepair()) return `Ремонт - ${sourceName} чинит свои предметы`;
    return `Ремонт - ${sourceName} чинит предметы ${targetName}`;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const instruments = prepareRepairInstruments(this.#sourceActor, this.#toolKey);
    const items = prepareRepairableItems(
      this.#targetContext?.items ?? [],
      instruments,
      this.#activeItemId,
      this.#sourceActor
    );
    return {
      ...context,
      sourceActor: this.#sourceActor,
      sourceToken: this.#sourceToken,
      targetActor: {
        name: this.#targetContext?.name ?? this.#targetToken?.name ?? ""
      },
      targetToken: this.#targetToken,
      toolLabel: getToolSettings().find(tool => tool.key === this.#toolKey)?.label ?? this.#toolKey,
      items,
      hasRepairableItems: items.length > 0,
      fallbackIcon: "icons/svg/item-bag.svg"
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.#syncWindowTitle();
  }

  static #onStartRepair(event, target) {
    event.preventDefault();
    if (this.#repairInFlight) return false;
    const itemId = String(target.dataset.itemId ?? "");
    this.#activeItemId = this.#activeItemId === itemId ? "" : itemId;
    return this.render({ force: true });
  }

  static async #onRepairWithInstrument(event, target) {
    event.preventDefault();
    if (this.#repairInFlight) return undefined;
    const itemId = String(target.dataset.itemId ?? "");
    const instrumentId = String(target.dataset.instrumentId ?? "");
    const methodIndex = Math.max(0, toInteger(target.dataset.methodIndex));
    if (!itemId || !instrumentId) return undefined;

    this.#repairInFlight = true;
    this.#setRepairActionsDisabled(true);
    try {
      const result = await performRepair({
        sourceActor: this.#sourceActor,
        sourceToken: this.#sourceToken,
        targetContext: this.#targetContext,
        targetToken: this.#targetToken,
        itemId,
        instrumentId,
        methodIndex,
        toolKey: this.#toolKey
      });
      if (result?.targetContext) this.#targetContext = result.targetContext;
    } finally {
      this.#repairInFlight = false;
      this.#setRepairActionsDisabled(false);
    }
    return this.render({ force: true });
  }

  static async #onRepairAll(event) {
    event.preventDefault();
    if (this.#repairInFlight) return undefined;
    this.#repairInFlight = true;
    this.#setRepairActionsDisabled(true);
    try {
      let pending = this.#pendingMassRepair;
      if (!pending) {
        const options = await promptMassRepairOptions({
          sourceActor: this.#sourceActor,
          targetContext: this.#targetContext,
          toolKey: this.#toolKey
        });
        if (!options || options === "cancel") return false;
        pending = {
          requestId: foundry.utils.randomID(),
          options
        };
        this.#pendingMassRepair = pending;
      } else {
        ui.notifications.info("Повторное ожидание уже запущенного массового ремонта.");
      }
      const result = await performMassRepair({
        sourceActor: this.#sourceActor,
        sourceToken: this.#sourceToken,
        targetContext: this.#targetContext,
        targetToken: this.#targetToken,
        toolKey: this.#toolKey,
        options: pending.options,
        requestId: pending.requestId
      });
      if (result?.pending) return false;
      this.#pendingMassRepair = null;
      if (result?.targetContext) this.#targetContext = result.targetContext;
      if (result?.summary) await postMassRepairChat(this.#sourceActor, result.summary);
    } finally {
      this.#repairInFlight = false;
      this.#setRepairActionsDisabled(false);
    }
    return this.render({ force: true });
  }

  #isSelfRepair() {
    if (!this.#sourceActor || !this.#targetContext) return false;
    if (this.#targetContext.actorUuid === this.#sourceActor.uuid) return true;
    const sourceDocument = this.#sourceToken?.document;
    const targetDocument = this.#targetToken?.document;
    return Boolean(
      sourceDocument
      && targetDocument
      && sourceDocument.id === targetDocument.id
      && sourceDocument.parent?.id === targetDocument.parent?.id
    );
  }

  #syncWindowTitle() {
    const title = this.title;
    if (this.options?.window) this.options.window.title = title;
    const titleElement = this.element?.querySelector(".window-title");
    if (titleElement) titleElement.textContent = title;
  }

  #setRepairActionsDisabled(disabled) {
    const selector = "[data-action='startRepair'], [data-action='repairWithInstrument'], [data-action='repairAll']";
    if (disabled) {
      this.#disabledRepairActionStates = new Map();
      for (const button of this.element?.querySelectorAll?.(selector) ?? []) {
        this.#disabledRepairActionStates.set(button, Boolean(button.disabled));
        button.disabled = true;
      }
      return;
    }
    for (const [button, wasDisabled] of this.#disabledRepairActionStates ?? []) button.disabled = wasDisabled;
    this.#disabledRepairActionStates = null;
  }
}

async function getRepairTargetContext(targetToken, toolKey = "repair", sourceActor = null) {
  const actor = targetToken?.actor;
  if (!actor) return null;
  if (canUseActorLocally(actor)) return buildTargetContext(actor, targetToken, toolKey);

  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("Нет активного GM для доступа к цели ремонта.");
    return null;
  }

  try {
    const result = await requestRepairSocket("getTargetContext", {
      actorUuid: actor.uuid,
      sourceActorUuid: sourceActor?.uuid ?? "",
      targetTokenUuid: getRepairTokenUuid(targetToken),
      toolKey
    }, gm);
    return result?.targetContext ?? null;
  } catch (error) {
    console.error(`${SYSTEM_ID} | Repair target socket failed`, error);
    ui.notifications.error(`Не удалось получить данные цели ремонта: ${error.message}`);
    return null;
  }
}

function prepareRepairInstruments(actor, fallbackToolKey = "repair") {
  const skills = getSkillSettings();
  const toolSettings = getToolSettings();
  const fallbackLabel = toolSettings.find(tool => tool.key === fallbackToolKey)?.label ?? fallbackToolKey;
  return actor.items
    .filter(item => item.type === "gear")
    .flatMap(item => {
      const tools = item.system?.functions?.tools ?? {};
      return Object.entries(tools)
        .filter(([toolKey, data]) => (
          data?.enabled
          && hasItemFunction(item, createToolFunctionKey(toolKey))
        ))
        .map(([toolKey, data]) => {
          const resource = getToolResourceState(item, { ...data, toolKey });
          const skillKey = String(data.skillKey ?? "");
          const skillValue = toInteger(data.skillValue);
          const skillLabel = skillKey ? (skills.find(skill => skill.key === skillKey)?.label ?? skillKey) : "";
          const actorSkillValue = skillKey ? toInteger(actor.system?.skills?.[skillKey]?.value) : 0;
          const requirementMet = !skillKey || actorSkillValue >= skillValue;
          const toolLabel = toolSettings.find(tool => tool.key === toolKey)?.label ?? (toolKey === fallbackToolKey ? fallbackLabel : toolKey);
          return {
            uid: `${item.id}:${toolKey}`,
            id: item.id,
            name: item.name,
            img: normalizeImagePath(item.img, "icons/svg/item-bag.svg"),
            toolKey,
            toolLabel,
            toolClass: String(data.toolClass ?? "D"),
            supplyValue: resource.available ? resource.value : 0,
            supplyMax: resource.max,
            resourceMode: resource.mode,
            skillValue,
            skillLabel,
            actorSkillValue,
            skillRequirement: skillKey ? `${skillValue} ${skillLabel}` : "Без навыка",
            hasSkill: Boolean(skillKey),
            requirementMet
          };
        });
    });
}

function prepareRepairableItems(items, instruments, activeItemId, sourceActor = null) {
  return items.map(item => {
    const availableInstruments = item.recoveryMethods.flatMap((method, methodIndex) => {
      const requiredClass = String(method.toolClass ?? "D");
      const threshold = getRepairSkillThreshold(sourceActor, method, item.conditionValue);
      return instruments
        .filter(instrument => instrument.toolKey === method.toolKey)
        .map(instrument => {
          const classAccepted = isToolClassAccepted(instrument.toolClass, requiredClass);
          const efficiency = calculateBaseEfficiency(instrument.toolClass, requiredClass);
          const usable = classAccepted && instrument.supplyValue > 0 && instrument.requirementMet && threshold.met;
          return {
            ...instrument,
            methodIndex,
            efficiency,
            efficiencyLabel: `${formatNumber(efficiency)}%`,
            classAccepted,
            repairSkillThresholdMet: threshold.met,
            usable
          };
        });
    });
    return {
      ...item,
      active: item.id === activeItemId,
      conditionLabel: `${item.conditionValue} / ${item.conditionMax}`,
      repairClassLabel: joinUniqueLabels(item.recoveryMethods.map(method => method.toolClass)),
      repairDifficultyLabel: joinUniqueLabels(item.recoveryMethods.map(method => method.difficulty)),
      repairSkillLabel: joinUniqueLabels(item.recoveryMethods.map(method => method.skillLabel)),
      methodCount: item.recoveryMethods.length,
      usableInstrumentCount: availableInstruments.filter(instrument => instrument.usable).length,
      availableInstruments
    };
  });
}

async function promptMassRepairOptions({ sourceActor, targetContext, toolKey = "repair" } = {}) {
  const items = targetContext?.items ?? [];
  if (!items.length) {
    ui.notifications.warn("Нет предметов для массового ремонта.");
    return null;
  }

  const availability = getMassRepairAvailability(sourceActor, targetContext);
  if (!availability.ok) {
    ui.notifications.warn(availability.message);
    return null;
  }
  const groups = groupToolSelectionOptions(availability.instruments);

  const rows = groups.map(group => `
    <label class="fallout-maw-mass-operation-instrument">
      <input type="checkbox" name="toolGroup" value="${escapeAttribute(group.key)}" checked>
      <span>${escapeHtml(group.toolLabel)}</span>
      <strong>Класс ${escapeHtml(group.toolClass)}</strong>
      <em>${group.count} шт., запас ${group.supplyValue}/${group.supplyMax}</em>
    </label>
  `).join("");
  const content = `
    <div class="fallout-maw-mass-operation-dialog fallout-maw-mass-repair-dialog">
      <p><strong>Предметов для ремонта:</strong> ${items.length}</p>
      <div class="fallout-maw-mass-operation-modes">
        <strong>Качество инструмента</strong>
        <label>
          <input type="radio" name="qualityMode" value="matched" checked>
          <span>Подходящий класс — не тратить лучший без необходимости</span>
        </label>
        <label>
          <input type="radio" name="qualityMode" value="best">
          <span>Лучший доступный — максимальная эффективность</span>
        </label>
        <strong>Распределение запаса</strong>
        <label>
          <input type="radio" name="supplyMode" value="depleted" checked>
          <span>Добивать начатые — сначала наиболее израсходованные</span>
        </label>
        <label>
          <input type="radio" name="supplyMode" value="balanced">
          <span>Равномерно — сначала наиболее наполненные</span>
        </label>
      </div>
      <div class="fallout-maw-mass-operation-instruments">
        ${rows}
      </div>
    </div>
  `;

  return DialogV2.input({
    modal: true,
    window: {
      title: "Массовый ремонт"
    },
    content,
    render: (_event, dialog) => bindMassOperationDialogSubmitState(dialog),
    ok: {
      label: "Начать ремонт",
      icon: "fa-solid fa-screwdriver-wrench",
      callback: (_event, button) => {
        const form = button.form;
        const selectionState = getMassOperationDialogSelectionState(form);
        const allowedToolGroupKeys = Array.from(form.querySelectorAll("input[name='toolGroup']:checked"))
          .map(input => String(input.value ?? ""))
          .filter(Boolean);
        if (!selectionState.hasToolGroupSelection || !allowedToolGroupKeys.length) {
          ui.notifications.warn("Выберите хотя бы одну группу инструментов.");
          return "cancel";
        }
        return {
          qualityMode: String(form.querySelector("input[name='qualityMode']:checked")?.value ?? "matched"),
          supplyMode: String(form.querySelector("input[name='supplyMode']:checked")?.value ?? "depleted"),
          allowedToolGroupKeys
        };
      }
    },
    buttons: [{
      action: "cancel",
      label: "Отмена"
    }],
    position: {
      width: 560
    },
    rejectClose: false
  });
}

function collectMassRepairInstrumentOptions(sourceActor, targetContext) {
  return getMassRepairAvailability(sourceActor, targetContext).instruments
    .sort((left, right) => (
      toToolClassRank(right.toolClass) - toToolClassRank(left.toolClass)
      || right.supplyValue - left.supplyValue
      || left.name.localeCompare(right.name)
    ));
}

function getMassRepairAvailability(sourceActor, targetContext) {
  const requirements = (targetContext?.items ?? []).flatMap(item => (
    item.recoveryMethods ?? []
  ).map((method, methodIndex) => ({
    itemId: String(item.id ?? ""),
    itemName: String(item.name ?? ""),
    methodIndex,
    toolKey: String(method.toolKey ?? ""),
    toolLabel: String(method.toolLabel ?? method.toolKey ?? ""),
    toolClass: String(method.toolClass ?? "D"),
    skillThreshold: getRepairSkillThreshold(sourceActor, method, item.conditionValue)
  })));
  return analyzeMassRepairToolAvailability({
    instruments: prepareRepairInstruments(sourceActor),
    requirements
  });
}

async function performMassRepair({
  sourceActor,
  sourceToken = null,
  targetContext,
  targetToken = null,
  toolKey = "repair",
  options = {},
  requestId = ""
} = {}) {
  if (!sourceActor?.isOwner && !game.user?.isGM) {
    ui.notifications.warn(`Нет прав на использование инструментов ${sourceActor?.name ?? ""}.`);
    return undefined;
  }
  const normalizedOptions = normalizeToolSelectionPolicy(options);
  if (!normalizedOptions.allowedToolGroupKeys.length) {
    ui.notifications.warn("Выберите хотя бы одну группу инструментов.");
    return undefined;
  }
  return requestRepairResolution("performMassRepair", {
    sourceActor,
    sourceToken,
    targetContext,
    targetToken,
    toolKey,
    intent: { options: normalizedOptions },
    requestId
  });
}

function chooseBestRepairOption(sourceActor, item, options = {}) {
  const policy = normalizeToolSelectionPolicy(options);
  const instruments = prepareRepairInstruments(sourceActor);
  const choices = item.recoveryMethods.flatMap((method, methodIndex) => {
    if (!getRepairSkillThreshold(sourceActor, method, item.conditionValue).met) return [];
    const instrument = selectToolByPolicy(instruments, {
      requiredToolKey: method.toolKey,
      requiredToolClass: method.toolClass
    }, policy);
    if (!instrument) return [];
    const supplyMax = Math.max(0, toInteger(instrument.supplyMax));
    return [{
      methodIndex,
      instrumentId: instrument.id,
      instrument,
      method,
      rank: toToolClassRank(instrument.toolClass),
      classSurplus: toToolClassRank(instrument.toolClass) - toToolClassRank(method.toolClass),
      supplyRatio: supplyMax > 0 ? instrument.supplyValue / supplyMax : instrument.supplyValue
    }];
  });
  choices.sort((left, right) => {
    const qualityOrder = policy.qualityMode === "best"
      ? right.classSurplus - left.classSurplus
      : left.classSurplus - right.classSurplus;
    if (qualityOrder) return qualityOrder;
    const supplyOrder = policy.supplyMode === "balanced"
      ? right.supplyRatio - left.supplyRatio || right.instrument.supplyValue - left.instrument.supplyValue
      : left.supplyRatio - right.supplyRatio || left.instrument.supplyValue - right.instrument.supplyValue;
    if (supplyOrder) return supplyOrder;
    return left.instrument.name.localeCompare(right.instrument.name)
      || String(left.instrumentId).localeCompare(String(right.instrumentId))
      || left.methodIndex - right.methodIndex;
  });
  return choices.at(0) ?? null;
}

async function performRepair({
  sourceActor,
  sourceToken = null,
  targetContext,
  targetToken = null,
  itemId,
  instrumentId,
  methodIndex = 0,
  toolKey = "repair",
  quietWarnings = false
} = {}) {
  if (!sourceActor?.isOwner && !game.user?.isGM) {
    if (!quietWarnings) ui.notifications.warn(`Нет прав на использование инструментов ${sourceActor?.name ?? ""}.`);
    return undefined;
  }
  const resolution = await requestRepairResolution("performRepair", {
    sourceActor,
    sourceToken,
    targetContext,
    targetToken,
    toolKey,
    intent: {
      itemId,
      instrumentId,
      methodIndex: Math.max(0, toInteger(methodIndex))
    }
  });
  if (!resolution) return undefined;
  if (!quietWarnings) await postRepairResolutionChat(sourceActor, resolution);
  return resolution;
}

async function runRepairChecks({
  sourceActor,
  sourceToken = null,
  targetContext,
  targetToken = null,
  repairItem,
  method,
  tool,
  initialValue,
  maxValue,
  operationId = `repair-checks:${foundry.utils.randomID()}`,
  chainRef = null
}) {
  const progressPerCheck = Math.max(1, Math.ceil(maxValue * REPAIR_PROGRESS_STEP_RATIO));
  const missingValue = Math.max(0, maxValue - initialValue);
  const totalChecks = Math.max(1, Math.ceil(missingValue / progressPerCheck));
  const targetDocument = targetToken?.actor ?? (targetContext?.actorUuid
    ? await fromUuid(targetContext.actorUuid).catch(() => null)
    : null);
  const targetActor = targetDocument?.documentName === "Actor" ? targetDocument : null;
  const toolSupplyCostPercent = getActorToolSupplyCostPercent(sourceActor, tool.toolKey, {
    requester: "repair",
    actorToken: sourceToken?.object ?? sourceToken,
    targetActor,
    targetToken: targetToken?.object ?? targetToken,
    chanceOperationId: operationId
  });
  const craftingSettings = getCraftingSettings();
  const thresholdMode = isSkillThresholdMode(craftingSettings.repair.mode);
  let currentValue = initialValue;
  let availableCharges = toInteger(tool.resourceValue);
  let spentCharges = 0;
  const entries = [];

  for (let index = 1; index <= totalChecks; index += 1) {
    const remainingValue = Math.max(0, maxValue - currentValue);
    if (!remainingValue) break;
    if (availableCharges <= 0) break;

    const valueForCheck = Math.min(progressPerCheck, remainingValue);
    const difficulty = getRepairDifficulty(method, currentValue);
    let resultKey = "success";
    let resultLabel = "навык соответствует порогу";
    if (thresholdMode) {
      const threshold = getRepairSkillThreshold(sourceActor, method, currentValue);
      if (!threshold.met) {
        return {
          entries,
          spentCharges,
          remainingCharges: availableCharges,
          finalValue: currentValue,
          reason: `Для ремонта нужно ${threshold.difficulty} ${threshold.skillLabel} (сейчас ${threshold.skillValue}).`
        };
      }
    } else {
      const checkOperationId = `${operationId}:check:${index}`;
      const outcome = await requestSkillCheck({
        actor: sourceActor,
        skillKey: DEFAULT_REPAIR_SKILL_KEY,
        chainRef,
        data: {
          difficulty,
          actorToken: sourceToken?.object ?? sourceToken,
          targetActor,
          targetToken: targetToken?.object ?? targetToken,
          allowImplicitTarget: false,
          chanceOperationId: checkOperationId,
          systemEventOperationId: operationId
        },
        animate: false,
        createMessage: true,
        prompt: false,
        requester: "repair",
        options: { operationId: checkOperationId }
      });
      if (!outcome) {
        return {
          entries,
          spentCharges,
          remainingCharges: availableCharges,
          finalValue: currentValue,
          halted: true,
          reason: "Проверка навыка ремонта не выполнена."
        };
      }
      resultKey = String(outcome.result?.key ?? "failure");
      resultLabel = getRepairResultLabel(resultKey);
    }

    const repair = calculateRepairResult({
      method,
      tool,
      availableCharges,
      valueForCheck,
      missingValue: remainingValue,
      resultKey,
      toolSupplyCostPercent,
      craftingSettings
    });
    if (repair.chargesUsed <= 0) break;

    availableCharges -= repair.chargesUsed;
    spentCharges += repair.chargesUsed;
    currentValue = Math.min(maxValue, currentValue + repair.condition);
    entries.push({
      index,
      total: totalChecks,
      resultLabel,
      condition: repair.condition,
      charges: repair.chargesUsed,
      efficiency: repair.efficiency,
      currentValue
    });
  }

  return {
    entries,
    spentCharges,
    remainingCharges: availableCharges,
    finalValue: currentValue,
    halted: false,
    reason: availableCharges <= 0 ? "Запаса инструмента не хватило для ремонта." : ""
  };
}

function validateInstrumentForRepair(actor, method, tool) {
  if (!tool?.enabled) return { ok: false, message: "Инструмент не подходит для ремонта." };
  if (toInteger(tool.resourceValue) <= 0) return { ok: false, message: "Ресурс инструмента исчерпан." };

  const requiredClass = String(method.toolClass ?? "D");
  const toolClass = String(tool.toolClass ?? "D");
  if (!isToolClassAccepted(toolClass, requiredClass)) {
    return { ok: false, message: `Нужен инструмент класса ${requiredClass} или выше.` };
  }

  const skillKey = String(tool.skillKey ?? "");
  const skillValue = toInteger(tool.skillValue);
  if (skillKey && toInteger(actor.system?.skills?.[skillKey]?.value) < skillValue) {
    const label = getSkillSettings().find(skill => skill.key === skillKey)?.label ?? skillKey;
    return { ok: false, message: `Нужно ${skillValue} ${label}.` };
  }

  return { ok: true, message: "" };
}

function calculateRepairResult({
  method,
  tool,
  availableCharges,
  valueForCheck,
  missingValue,
  resultKey,
  toolSupplyCostPercent = 0,
  craftingSettings = getCraftingSettings()
}) {
  const targetValue = Math.min(valueForCheck, missingValue);
  let efficiency = calculateBaseEfficiency(tool.toolClass, method.toolClass);
  if (resultKey === "criticalSuccess") efficiency *= 1.5;

  const productiveChargesNeeded = Math.max(1, Math.ceil(targetValue * (100 / Math.max(1, efficiency))));
  const costMultiplier = getRepairToolCostMultiplier(craftingSettings, resultKey);
  const baseChargesNeeded = Math.max(1, Math.ceil(productiveChargesNeeded * costMultiplier));
  const chargesNeeded = applyToolSupplyCostPercent(baseChargesNeeded, toolSupplyCostPercent);
  const chargesUsed = Math.min(chargesNeeded, availableCharges);
  const baseChargesUsed = baseChargesNeeded * Math.min(1, chargesUsed / chargesNeeded);
  const productiveChargesUsed = baseChargesUsed / costMultiplier;
  const normalCondition = Math.max(0, Math.ceil(productiveChargesUsed * (efficiency / 100)));
  const conditionMultiplier = resultKey === "criticalSuccess" ? 2 : resultKey === "criticalFailure" ? 0.5 : 1;
  const condition = Math.min(missingValue, Math.max(0, Math.floor(normalCondition * conditionMultiplier)));
  return { condition, chargesUsed, efficiency };
}

function getRepairDifficulty(method = {}, currentValue = 1) {
  const baseDifficulty = Math.max(0, toInteger(method.difficulty));
  return currentValue <= 0 ? Math.ceil(baseDifficulty * 1.3) : baseDifficulty;
}

function getRepairSkillThreshold(actor, method = {}, currentValue = 1) {
  if (!isSkillThresholdMode(getCraftingSettings().repair.mode)) {
    return {
      met: true,
      skillKey: DEFAULT_REPAIR_SKILL_KEY,
      skillLabel: getSkillSettings().find(skill => skill.key === DEFAULT_REPAIR_SKILL_KEY)?.label ?? DEFAULT_REPAIR_SKILL_KEY,
      skillValue: toInteger(actor?.system?.skills?.[DEFAULT_REPAIR_SKILL_KEY]?.value),
      difficulty: getRepairDifficulty(method, currentValue)
    };
  }
  const difficulty = getRepairDifficulty(method, currentValue);
  const skillValue = toInteger(actor?.system?.skills?.[DEFAULT_REPAIR_SKILL_KEY]?.value);
  return {
    met: skillValue >= difficulty,
    skillKey: DEFAULT_REPAIR_SKILL_KEY,
    skillLabel: getSkillSettings().find(skill => skill.key === DEFAULT_REPAIR_SKILL_KEY)?.label ?? DEFAULT_REPAIR_SKILL_KEY,
    skillValue,
    difficulty
  };
}

async function requestRepairResolution(action, {
  sourceActor,
  sourceToken = null,
  targetContext,
  targetToken = null,
  toolKey = "repair",
  intent = {},
  requestId = ""
} = {}) {
  const actorUuid = String(targetContext?.actorUuid ?? targetToken?.actor?.uuid ?? "");
  const sourceActorUuid = String(sourceActor?.uuid ?? "");
  if (!actorUuid || !sourceActorUuid) {
    ui.notifications.warn("Не удалось определить участников ремонта.");
    return null;
  }
  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("Нет активного GM для выполнения ремонта.");
    return null;
  }
  const stableRequestId = String(requestId ?? "").trim();
  try {
    if (game.user?.isGM && game.user.id === gm.id) {
      const targetActor = await fromUuid(actorUuid);
      if (!targetActor) throw new Error("цель ремонта не найдена");
      return action === "performMassRepair"
        ? await resolveMassRepairOnAuthority({
            sourceActor,
            sourceToken: sourceToken?.document ?? sourceToken,
            targetActor,
            targetToken: targetToken?.document ?? targetToken,
            toolKey,
            options: intent.options,
            operationId: stableRequestId
              ? `repair-mass:${game.user?.id ?? "gm"}:${stableRequestId}`
              : `repair-mass:${foundry.utils.randomID()}`
          })
        : await resolveRepairOnAuthority({
            sourceActor,
            sourceToken: sourceToken?.document ?? sourceToken,
            targetActor,
            targetToken: targetToken?.document ?? targetToken,
            toolKey,
            itemId: intent.itemId,
            instrumentId: intent.instrumentId,
            methodIndex: intent.methodIndex,
            operationId: `repair:${foundry.utils.randomID()}`
          });
    }
    const result = await requestRepairSocket(action, {
      actorUuid,
      sourceActorUuid,
      sourceTokenUuid: getRepairTokenUuid(sourceToken),
      targetTokenUuid: getRepairTokenUuid(targetToken),
      toolKey,
      ...intent
    }, gm, { requestId: stableRequestId });
    return result?.resolution ?? null;
  } catch (error) {
    console.error(`${SYSTEM_ID} | Repair authority request failed`, error);
    if (error?.code === "authority-timeout" && action === "performMassRepair") {
      ui.notifications.warn("GM продолжает массовый ремонт. Повторное нажатие будет ожидать ту же операцию.");
      return { pending: true, requestId: stableRequestId };
    }
    ui.notifications.error(`Не удалось выполнить ремонт: ${error.message}`);
    return null;
  }
}

async function resolveRepairOnAuthority(args = {}) {
  const operationId = String(args.operationId ?? "").trim() || `repair:${foundry.utils.randomID()}`;
  const sourceToken = args.sourceToken?.document ?? args.sourceToken ?? null;
  const targetToken = args.targetToken?.document ?? args.targetToken ?? null;
  assertRepairTokenMatchesActor(sourceToken, args.sourceActor);
  assertRepairTokenMatchesActor(targetToken, args.targetActor);
  return withSystemEventRoot({
    kind: "repair",
    operationId,
    sceneUuid: String(targetToken?.parent?.uuid ?? sourceToken?.parent?.uuid ?? ""),
    combatUuid: String(game.combat?.uuid ?? ""),
    chainRef: args.chainRef ?? null,
    data: { systemEventOperationId: operationId }
  }, scope => runWithRepairAuthorityLocks(
    [args.sourceActor, args.targetActor],
    () => runRepairLifecycle({ ...args, sourceToken, targetToken, operationId }, scope),
    scope.chainRef
  ));
}

async function runRepairLifecycle(args, scope) {
  const workflow = await runTerminalSystemEventWorkflow({
    scope,
    beforeEventKey: "fallout-maw.repair.before",
    resolvedEventKey: "fallout-maw.repair.resolved",
    occurrenceBase: `repair:${scope.rootId}:${args.operationId}`,
    participants: buildRepairParticipants(args),
    beforeData: buildRepairEventData(args, null, "pending"),
    resolvedData: ({ value, status, reason }) => buildRepairEventData(args, value, status, reason),
    before: () => buildRepairStateSnapshot(args),
    after: () => buildRepairStateSnapshot(args),
    operation: () => resolveRepairOnAuthorityOperation({ ...args, chainRef: scope.chainRef }),
    getResultStatus: result => {
      if (["committed", "alreadyComplete"].includes(result?.status)) return "success";
      if (result?.status === "cancelled") return "cancelled";
      return "failed";
    },
    getResultReason: result => String(result?.reason ?? result?.status ?? "")
  });
  if (!workflow.cancelled) return workflow.value;
  return createRepairReceipt(args, {
    status: "cancelled",
    reason: workflow.reason || "Ремонт отменён событием системы."
  });
}

async function resolveRepairOnAuthorityOperation({
  sourceActor,
  sourceToken = null,
  targetActor,
  targetToken = null,
  itemId,
  instrumentId,
  methodIndex = 0,
  toolKey = "repair",
  operationId = "",
  chainRef = null
} = {}) {
  if (!sourceActor || !targetActor) throw new Error("участники ремонта не найдены");
  const contextToolKey = validateRepairToolKey(toolKey);
  const item = targetActor?.items?.get(String(itemId ?? ""));
  if (!item || !hasItemFunction(item, ITEM_FUNCTIONS.condition)) throw new Error("предмет ремонта не найден");
  const condition = getConditionFunction(item);
  const methods = normalizeRecoveryMethods(condition.recoveryMethods, contextToolKey);
  const method = methods[Math.max(0, toInteger(methodIndex))];
  if (!method) throw new Error("метод ремонта не найден");
  const instrument = sourceActor?.items?.get(String(instrumentId ?? ""));
  if (
    !instrument
    || instrument.type !== "gear"
    || !hasItemFunction(instrument, createToolFunctionKey(method.toolKey))
  ) throw new Error("инструмент ремонта не найден или сломан");
  const tool = getEffectiveRepairToolFunction(instrument, method.toolKey);
  const validation = validateInstrumentForRepair(sourceActor, method, tool);
  if (!validation.ok) throw new Error(validation.message);

  const maxValue = Math.max(1, toInteger(condition.max));
  const initialValue = Math.min(maxValue, Math.max(0, toInteger(condition.value)));
  const initialSupply = Math.max(0, toInteger(tool.resourceValue));
  const expectedInputFingerprint = createRepairInputFingerprint({
    sourceActor,
    targetItem: item,
    instrument,
    contextToolKey,
    methodIndex
  });
  if (initialValue >= maxValue) {
    return createRepairReceipt({ operationId, targetActor, targetToken }, {
      status: "alreadyComplete",
      reason: `«${item.name}» уже полностью отремонтирован.`,
      targetContext: buildTargetContext(targetActor, targetToken, contextToolKey),
      repairItem: snapshotRepairableItem(item, contextToolKey),
      instrument: snapshotRepairInstrument(instrument, method.toolKey),
      method,
      initialValue,
      finalValue: initialValue,
      maxValue,
      completed: true
    });
  }
  const result = await runRepairChecks({
    sourceActor,
    sourceToken,
    targetContext: buildTargetContext(targetActor, targetToken, contextToolKey),
    targetToken,
    repairItem: snapshotRepairableItem(item, contextToolKey),
    method,
    tool,
    initialValue,
    maxValue,
    operationId,
    chainRef
  });
  if (!result.entries.length) {
    return createRepairReceipt({ operationId, targetActor, targetToken }, {
      status: result.halted ? "cancelled" : "failed",
      reason: result.reason || "Ремонт не выполнен.",
      targetContext: buildTargetContext(targetActor, targetToken, contextToolKey),
      repairItem: snapshotRepairableItem(item, contextToolKey),
      instrument: snapshotRepairInstrument(instrument, method.toolKey),
      method,
      initialValue,
      finalValue: initialValue,
      maxValue
    });
  }

  const finalValue = Math.min(maxValue, Math.max(initialValue, toInteger(result.finalValue)));
  await commitRepairToActors({
    targetItem: item,
    instrument,
    sourceActor,
    contextToolKey,
    methodIndex,
    expectedInputFingerprint,
    instrumentToolKey: method.toolKey,
    expectedCondition: initialValue,
    expectedSupply: initialSupply,
    finalValue,
    remainingSupply: result.remainingCharges,
    chainRef
  });
  return createRepairReceipt({ operationId, targetActor, targetToken }, {
    status: "committed",
    targetContext: buildTargetContext(targetActor, targetToken, contextToolKey),
    repairItem: snapshotRepairableItem(item, contextToolKey),
    instrument: snapshotRepairInstrument(instrument, method.toolKey),
    method,
    initialValue,
    finalValue,
    maxValue,
    spentCharges: result.spentCharges,
    repairedCondition: Math.max(0, finalValue - initialValue),
    entries: result.entries,
    completed: finalValue >= maxValue,
    halted: Boolean(result.halted),
    reason: String(result.reason ?? "")
  });
}

async function commitRepairToActors({
  targetItem,
  instrument,
  sourceActor,
  contextToolKey,
  methodIndex,
  expectedInputFingerprint,
  instrumentToolKey,
  expectedCondition,
  expectedSupply,
  finalValue,
  remainingSupply,
  chainRef = null
} = {}) {
  if (!targetItem || !hasItemFunction(targetItem, ITEM_FUNCTIONS.condition)) {
    throw createRepairStaleError("Ремонтируемый предмет больше недоступен.");
  }
  if (
    !instrument
    || !hasItemFunction(instrument, createToolFunctionKey(instrumentToolKey))
    || !getToolFunction(instrument, instrumentToolKey)?.enabled
  ) throw createRepairStaleError("Инструмент ремонта больше недоступен или сломан.");
  const currentInputFingerprint = createRepairInputFingerprint({
    sourceActor,
    targetItem,
    instrument,
    contextToolKey,
    methodIndex
  });
  if (currentInputFingerprint !== expectedInputFingerprint) {
    throw createRepairStaleError("Правила, требования или навык ремонта изменились во время проверок.");
  }
  const currentCondition = Math.max(0, toInteger(getConditionFunction(targetItem).value));
  const liveTool = getEffectiveRepairToolFunction(instrument, instrumentToolKey);
  const currentSupply = Math.max(0, toInteger(liveTool.resourceValue));
  if (currentCondition !== Math.max(0, toInteger(expectedCondition))) {
    throw createRepairStaleError("Состояние ремонтируемого предмета изменилось во время проверок.");
  }
  if (currentSupply !== Math.max(0, toInteger(expectedSupply))) {
    throw createRepairStaleError("Запас инструмента изменился во время проверок.");
  }
  if (toInteger(finalValue) < currentCondition) throw new Error("Ремонт не может уменьшать состояние предмета.");
  if (toInteger(remainingSupply) >= currentSupply) throw new Error("Ремонт должен расходовать запас инструмента.");
  if (targetItem === instrument && liveTool.resource?.mode === "condition") {
    throw new Error("Предмет не может ремонтировать себя ценой собственного состояния.");
  }
  const conditionUpdate = { "system.functions.condition.value": Math.max(0, toInteger(finalValue)) };
  const supplyUpdate = createToolResourceValueUpdate(instrument, liveTool, remainingSupply);
  const updates = targetItem === instrument
    ? [{ document: targetItem, updates: { ...conditionUpdate, ...supplyUpdate } }]
    : [
        { document: targetItem, updates: conditionUpdate },
        { document: instrument, updates: supplyUpdate }
      ];
  await executeAtomicActorItemUpdates(updates, {
    chainRef,
    reason: "repair-with-tool"
  });
}

function createRepairInputFingerprint({
  sourceActor,
  targetItem,
  instrument,
  contextToolKey = "repair",
  methodIndex = 0
} = {}) {
  const condition = getConditionFunction(targetItem);
  const methods = normalizeRecoveryMethods(condition.recoveryMethods, contextToolKey);
  const method = methods[Math.max(0, toInteger(methodIndex))] ?? null;
  const tool = getToolFunction(instrument, method?.toolKey);
  const toolResource = getToolResourceState(instrument, { ...tool, toolKey: method?.toolKey });
  const toolSkillKey = String(tool?.skillKey ?? "");
  const repairSettings = getCraftingSettings().repair ?? {};
  return JSON.stringify({
    conditionMax: Math.max(0, toInteger(condition.max)),
    method: method ? {
      toolKey: String(method.toolKey ?? ""),
      toolClass: normalizeToolClass(method.toolClass),
      difficulty: Math.max(0, toInteger(method.difficulty)),
      skillKey: String(method.skillKey ?? "")
    } : null,
    tool: {
      enabled: Boolean(tool?.enabled),
      resourceMode: toolResource.mode,
      toolClass: normalizeToolClass(tool?.toolClass),
      skillKey: toolSkillKey,
      skillValue: Math.max(0, toInteger(tool?.skillValue))
    },
    toolRequirementSkillValue: toolSkillKey
      ? toInteger(sourceActor?.system?.skills?.[toolSkillKey]?.value)
      : null,
    repairSkillValue: toInteger(sourceActor?.system?.skills?.[DEFAULT_REPAIR_SKILL_KEY]?.value),
    repairSettings: {
      mode: String(repairSettings.mode ?? ""),
      failureToolCostIncreasePercent: toInteger(repairSettings.failureToolCostIncreasePercent),
      criticalFailureToolCostIncreasePercent: toInteger(repairSettings.criticalFailureToolCostIncreasePercent)
    }
  });
}

function createRepairStaleError(message) {
  const error = new Error(message);
  error.code = "inventory-stale";
  return error;
}

function createRepairReceipt(args = {}, values = {}) {
  return {
    operationId: String(args.operationId ?? ""),
    status: String(values.status ?? "failed"),
    reason: String(values.reason ?? ""),
    targetContext: values.targetContext ?? buildTargetContext(args.targetActor, args.targetToken),
    repairItem: values.repairItem ?? null,
    instrument: values.instrument ?? null,
    method: values.method ?? null,
    initialValue: Math.max(0, toInteger(values.initialValue)),
    finalValue: Math.max(0, toInteger(values.finalValue)),
    maxValue: Math.max(0, toInteger(values.maxValue)),
    spentCharges: Math.max(0, toInteger(values.spentCharges)),
    repairedCondition: Math.max(0, toInteger(values.repairedCondition)),
    entries: Array.isArray(values.entries) ? values.entries : [],
    completed: Boolean(values.completed),
    halted: Boolean(values.halted)
  };
}

function snapshotRepairInstrument(item, toolKey) {
  const tool = getEffectiveRepairToolFunction(item, toolKey);
  return {
    id: String(item?.id ?? ""),
    name: String(item?.name ?? ""),
    toolKey: String(toolKey ?? ""),
    toolClass: String(tool?.toolClass ?? "D"),
    supplyValue: Math.max(0, toInteger(tool?.resourceValue)),
    supplyMax: Math.max(0, toInteger(tool?.resourceMax))
  };
}

function getEffectiveRepairToolFunction(item, toolKey) {
  const normalizedToolKey = String(toolKey ?? "").trim();
  const tool = getToolFunction(item, normalizedToolKey);
  const resource = getToolResourceState(item, { ...tool, toolKey: normalizedToolKey });
  return {
    ...tool,
    toolKey: normalizedToolKey,
    resourceMode: resource.mode,
    resource,
    resourceValue: resource.available ? resource.value : 0,
    resourceMax: resource.max
  };
}

async function resolveMassRepairOnAuthority(args = {}) {
  const operationId = String(args.operationId ?? "").trim() || `repair-mass:${foundry.utils.randomID()}`;
  const sourceToken = args.sourceToken?.document ?? args.sourceToken ?? null;
  const targetToken = args.targetToken?.document ?? args.targetToken ?? null;
  assertRepairTokenMatchesActor(sourceToken, args.sourceActor);
  assertRepairTokenMatchesActor(targetToken, args.targetActor);
  const result = await resolveMassRepairOnAuthorityOperation({
    ...args,
    sourceToken,
    targetToken,
    operationId
  });
  await emitMassRepairResolved({
    ...args,
    sourceToken,
    targetToken,
    operationId,
    result
  });
  return result;
}

async function resolveMassRepairOnAuthorityOperation({
  sourceActor,
  sourceToken = null,
  targetActor,
  targetToken = null,
  toolKey = "repair",
  options = {},
  operationId = ""
} = {}) {
  if (!sourceActor || !targetActor) throw new Error("участники массового ремонта не найдены");
  const contextToolKey = validateRepairToolKey(toolKey);
  const policy = normalizeToolSelectionPolicy(options);
  if (!policy.allowedToolGroupKeys.length) throw new Error("Выберите хотя бы одну группу инструментов.");

  const initialContext = buildTargetContext(targetActor, targetToken, contextToolKey);
  const currentAvailability = getMassRepairAvailability(sourceActor, initialContext);
  if (!currentAvailability.ok) throw new Error(currentAvailability.message);
  const compatibleGroups = new Set(
    groupToolSelectionOptions(currentAvailability.instruments).map(group => group.key)
  );
  if (!policy.allowedToolGroupKeys.some(key => compatibleGroups.has(key))) {
    throw new Error("Выбранные группы инструментов больше недоступны.");
  }

  const summary = {
    targetName: initialContext.name,
    attempted: 0,
    completed: 0,
    repaired: 0,
    charges: 0,
    skipped: 0,
    stopped: false,
    stopStatus: "",
    reason: ""
  };
  const itemIds = [...initialContext.items]
    .sort((left, right) => left.conditionRatio - right.conditionRatio || left.name.localeCompare(right.name))
    .map(item => item.id);
  let step = 0;
  repairItems: for (const itemId of itemIds) {
    while (step < 1000) {
      const currentContext = buildTargetContext(targetActor, targetToken, contextToolKey);
      const repairItem = currentContext.items.find(item => item.id === itemId);
      if (!repairItem) break;
      const selection = chooseBestRepairOption(sourceActor, repairItem, policy);
      if (!selection) {
        summary.skipped += 1;
        break;
      }
      step += 1;
      summary.attempted += 1;
      let resolution;
      try {
        resolution = await resolveRepairOnAuthority({
          sourceActor,
          sourceToken,
          targetActor,
          targetToken,
          itemId,
          instrumentId: selection.instrumentId,
          methodIndex: selection.methodIndex,
          toolKey: contextToolKey,
          operationId: `${operationId}:step:${step}`
        });
      } catch (error) {
        console.error(`${SYSTEM_ID} | Mass repair step failed`, error);
        summary.stopped = true;
        summary.stopStatus = "failed";
        summary.reason = String(error?.message ?? "Массовый ремонт остановлен.");
        break repairItems;
      }
      summary.repaired += Math.max(0, toInteger(resolution?.repairedCondition));
      summary.charges += Math.max(0, toInteger(resolution?.spentCharges));
      if (["failed", "cancelled"].includes(String(resolution?.status ?? ""))) {
        summary.stopped = true;
        summary.stopStatus = String(resolution.status);
        summary.reason = String(resolution?.reason ?? "Массовый ремонт остановлен.");
        break repairItems;
      }
      if (resolution?.halted) {
        summary.stopped = true;
        summary.stopStatus = "cancelled";
        summary.reason = String(resolution?.reason ?? "Проверка ремонта остановлена.");
        break repairItems;
      }
      if (resolution?.completed) {
        summary.completed += 1;
        break;
      }
      if (resolution?.status !== "committed" || resolution.repairedCondition <= 0) {
        summary.reason ||= String(resolution?.reason ?? "");
        break;
      }
    }
    if (step >= 1000) {
      summary.stopped = true;
      summary.stopStatus = "failed";
      summary.reason = "Массовый ремонт остановлен защитным лимитом операций.";
      break;
    }
  }
  return {
    targetContext: buildTargetContext(targetActor, targetToken, contextToolKey),
    summary
  };
}

async function emitMassRepairResolved({
  sourceActor,
  sourceToken = null,
  targetActor,
  targetToken = null,
  toolKey = "repair",
  options = {},
  operationId = "",
  chainRef = null,
  result = {}
} = {}) {
  const contextToolKey = validateRepairToolKey(toolKey);
  const policy = normalizeToolSelectionPolicy(options);
  const summary = result.summary ?? {};
  const batchCancelled = summary.stopStatus === "cancelled";
  const batchFailed = summary.stopStatus === "failed" || (!summary.repaired && !batchCancelled);
  const batchStatus = batchCancelled ? "cancelled" : batchFailed ? "failed" : "success";
  return withSystemEventRoot({
    kind: "repairBatch",
    operationId,
    sceneUuid: String(targetToken?.parent?.uuid ?? sourceToken?.parent?.uuid ?? ""),
    combatUuid: String(game.combat?.uuid ?? ""),
    chainRef,
    data: { systemEventOperationId: operationId }
  }, scope => scope.emit("fallout-maw.repair.batch.resolved", {
    data: {
      schemaVersion: 1,
      operationId,
      ...summary,
      qualityMode: policy.qualityMode,
      supplyMode: policy.supplyMode,
      allowedToolGroupKeys: policy.allowedToolGroupKeys
    },
    after: { targetContext: buildTargetContext(targetActor, targetToken, contextToolKey) },
    outcome: {
      success: batchStatus === "success",
      cancelled: batchCancelled,
      failed: batchFailed,
      status: batchStatus
    },
    reason: summary.reason || (batchStatus === "success" ? "resolved" : "noRepair")
  }, {
    occurrenceKey: `repair-batch:${scope.rootId}:${operationId}:resolved`,
    participants: {
      source: createRepairParticipant(sourceActor, sourceToken),
      target: createRepairParticipant(targetActor, targetToken),
      related: []
    }
  }));
}

function buildRepairParticipants({ sourceActor, sourceToken, targetActor, targetToken, itemId, instrumentId } = {}) {
  return {
    source: createRepairParticipant(sourceActor, sourceToken, sourceActor?.items?.get?.(String(instrumentId ?? ""))),
    target: createRepairParticipant(targetActor, targetToken, targetActor?.items?.get?.(String(itemId ?? ""))),
    related: []
  };
}

function createRepairParticipant(actor = null, token = null, item = null) {
  const tokenDocument = token?.document ?? token;
  const participant = {
    actorUuid: String(actor?.uuid ?? tokenDocument?.actor?.uuid ?? ""),
    tokenUuid: String(tokenDocument?.uuid ?? ""),
    itemUuid: String(item?.uuid ?? "")
  };
  return Object.values(participant).some(Boolean) ? participant : null;
}

function buildRepairEventData(args = {}, receipt = null, status = "pending", reason = "") {
  const item = args.targetActor?.items?.get?.(String(args.itemId ?? ""));
  const instrument = args.sourceActor?.items?.get?.(String(args.instrumentId ?? ""));
  return {
    schemaVersion: 1,
    operationId: String(args.operationId ?? receipt?.operationId ?? ""),
    sourceActorUuid: String(args.sourceActor?.uuid ?? ""),
    targetActorUuid: String(args.targetActor?.uuid ?? ""),
    sourceTokenUuid: getRepairTokenUuid(args.sourceToken),
    targetTokenUuid: getRepairTokenUuid(args.targetToken),
    itemId: String(args.itemId ?? ""),
    itemUuid: String(item?.uuid ?? ""),
    itemName: String(receipt?.repairItem?.name ?? item?.name ?? ""),
    instrumentId: String(args.instrumentId ?? ""),
    instrumentItemUuid: String(instrument?.uuid ?? ""),
    instrumentName: String(receipt?.instrument?.name ?? instrument?.name ?? ""),
    methodIndex: Math.max(0, toInteger(args.methodIndex)),
    toolKey: String(args.toolKey ?? ""),
    status: String(receipt?.status ?? status),
    reason: String(receipt?.reason ?? reason),
    initialValue: Math.max(0, toInteger(receipt?.initialValue)),
    finalValue: Math.max(0, toInteger(receipt?.finalValue)),
    maxValue: Math.max(0, toInteger(receipt?.maxValue)),
    spentCharges: Math.max(0, toInteger(receipt?.spentCharges)),
    repairedCondition: Math.max(0, toInteger(receipt?.repairedCondition)),
    completed: Boolean(receipt?.completed)
  };
}

function buildRepairStateSnapshot({ sourceActor, targetActor, itemId, instrumentId } = {}) {
  const item = targetActor?.items?.get?.(String(itemId ?? ""));
  const instrument = sourceActor?.items?.get?.(String(instrumentId ?? ""));
  const condition = getConditionFunction(item);
  const tools = instrument?.system?.functions?.tools ?? {};
  return {
    condition: item ? Math.max(0, toInteger(condition.value)) : null,
    supplies: Object.fromEntries(Object.entries(tools).map(([key, value]) => {
      const resource = getToolResourceState(instrument, { ...value, toolKey: key });
      return [key, resource.available ? resource.value : 0];
    }))
  };
}

function buildTargetContext(actor, token = null, defaultToolKey = "repair") {
  return {
    actorUuid: actor.uuid,
    name: token?.name ?? actor.name,
    actorName: actor.name,
    tokenName: token?.name ?? "",
    items: actor.items
      .filter(item => item.type === "gear" && isConditionDamaged(item))
      .map(item => snapshotRepairableItem(item, defaultToolKey))
  };
}

function snapshotRepairableItem(item, defaultToolKey = "repair") {
  const condition = getConditionFunction(item);
  const maxValue = Math.max(0, toInteger(condition.max));
  const value = Math.min(maxValue, Math.max(0, toInteger(condition.value)));
  const missing = Math.max(0, maxValue - value);
  const ratio = maxValue > 0 ? value / maxValue : 1;
  const percent = Math.round(ratio * 100);
  return {
    id: item.id,
    name: item.name,
    img: normalizeImagePath(item.img, "icons/svg/item-bag.svg"),
    conditionValue: value,
    conditionMax: maxValue,
    missingCondition: missing,
    conditionRatio: ratio,
    conditionPercent: percent,
    recoveryMethods: normalizeRecoveryMethods(condition.recoveryMethods, defaultToolKey)
  };
}

function isConditionDamaged(item) {
  if (!hasItemFunction(item, ITEM_FUNCTIONS.condition)) return false;
  const condition = getConditionFunction(item);
  const maxValue = Math.max(0, toInteger(condition.max));
  const value = Math.min(maxValue, Math.max(0, toInteger(condition.value)));
  return maxValue > 0 && value < maxValue;
}

function normalizeRecoveryMethods(methods = [], defaultToolKey = "repair") {
  const normalized = (Array.isArray(methods) ? methods : [])
    .filter(method => String(method?.type ?? "tools") === "tools")
    .map(method => normalizeRecoveryMethod(method, defaultToolKey))
    .filter(method => method.toolKey);
  if (normalized.length) return normalized;
  return [normalizeRecoveryMethod({
    type: "tools",
    toolKey: defaultToolKey,
    toolClass: "D",
    difficulty: 0
  }, defaultToolKey)];
}

function normalizeRecoveryMethod(method = {}, defaultToolKey = "repair") {
  const toolKey = String(method.toolKey || defaultToolKey).trim();
  return {
    type: "tools",
    toolKey,
    toolLabel: getToolSettings().find(tool => tool.key === toolKey)?.label ?? toolKey,
    toolClass: normalizeToolClass(method.toolClass),
    difficulty: Math.max(0, toInteger(method.difficulty)),
    skillKey: DEFAULT_REPAIR_SKILL_KEY,
    skillLabel: getSkillSettings().find(skill => skill.key === DEFAULT_REPAIR_SKILL_KEY)?.label ?? DEFAULT_REPAIR_SKILL_KEY
  };
}

async function requestRepairSocket(action, payload = {}, gm = getResponsibleGM(), { requestId = "" } = {}) {
  if (!gm) throw new Error("нет активного GM");
  const resolvedRequestId = String(requestId ?? "").trim() || foundry.utils.randomID();
  const requesterUserId = game.user?.id ?? "";

  const promise = new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingRepairSocketRequests.delete(resolvedRequestId);
      const error = new Error("GM не ответил на запрос ремонта");
      error.code = "authority-timeout";
      reject(error);
    }, REPAIR_SOCKET_TIMEOUT);
    pendingRepairSocketRequests.set(resolvedRequestId, {
      resolve,
      reject,
      timeout,
      gmUserId: String(gm.id ?? "")
    });
  });

  game.socket.emit(REPAIR_SOCKET, {
    scope: REPAIR_SOCKET_SCOPE,
    type: "request",
    action,
    requestId: resolvedRequestId,
    requesterUserId,
    gmUserId: gm.id,
    payload
  });
  return promise;
}

async function handleRepairSocketMessage(message = {}, senderUserId = "") {
  if (message?.scope !== REPAIR_SOCKET_SCOPE) return;
  const authenticatedSenderId = String(senderUserId ?? "").trim();

  if (message.type === "response") {
    if (message.recipientUserId && message.recipientUserId !== game.user?.id) return;
    const pending = pendingRepairSocketRequests.get(message.requestId);
    if (!pending) return;
    if (!authenticatedSenderId || authenticatedSenderId !== pending.gmUserId) return;
    window.clearTimeout(pending.timeout);
    pendingRepairSocketRequests.delete(message.requestId);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error || "ошибка GM-сокета ремонта"));
    return;
  }

  if (message.type !== "request") return;
  if (!game.user?.isGM || message.gmUserId !== game.user.id) return;
  if (!authenticatedSenderId || authenticatedSenderId !== String(message.requesterUserId ?? "")) return;

  try {
    const result = await handleRepairSocketRequestOnce(message);
    game.socket.emit(REPAIR_SOCKET, {
      scope: REPAIR_SOCKET_SCOPE,
      type: "response",
      requestId: message.requestId,
      recipientUserId: message.requesterUserId,
      ok: true,
      result
    });
  } catch (error) {
    console.error(`${SYSTEM_ID} | Repair socket request failed`, error);
    game.socket.emit(REPAIR_SOCKET, {
      scope: REPAIR_SOCKET_SCOPE,
      type: "response",
      requestId: message.requestId,
      recipientUserId: message.requesterUserId,
      ok: false,
      error: error.message
    });
  }
}

function handleRepairSocketRequestOnce(message = {}) {
  const requestId = String(message.requestId ?? "").trim();
  const requesterUserId = String(message.requesterUserId ?? "").trim();
  if (!requestId || !requesterUserId) throw new Error("некорректный запрос ремонта");
  const key = `${requesterUserId}:${requestId}`;
  const existing = handledRepairSocketRequests.get(key);
  if (existing) return existing.promise;

  const entry = { promise: null, settled: false };
  entry.promise = Promise.resolve().then(() => handleRepairSocketRequest(
    message.action,
    message.payload ?? {},
    requesterUserId,
    `repair-socket:${requesterUserId}:${requestId}`
  ));
  handledRepairSocketRequests.set(key, entry);
  entry.promise.then(
    () => settleHandledRepairSocketRequest(key, entry),
    () => settleHandledRepairSocketRequest(key, entry)
  );
  pruneHandledRepairSocketRequests();
  return entry.promise;
}

function settleHandledRepairSocketRequest(key, entry) {
  entry.settled = true;
  window.setTimeout(() => {
    if (handledRepairSocketRequests.get(key) === entry) handledRepairSocketRequests.delete(key);
  }, REPAIR_SOCKET_RECEIPT_TTL);
}

function pruneHandledRepairSocketRequests() {
  if (handledRepairSocketRequests.size <= MAX_HANDLED_REPAIR_SOCKET_REQUESTS) return;
  for (const [key, entry] of handledRepairSocketRequests) {
    if (!entry.settled) continue;
    handledRepairSocketRequests.delete(key);
    if (handledRepairSocketRequests.size <= MAX_HANDLED_REPAIR_SOCKET_REQUESTS) break;
  }
}

async function handleRepairSocketRequest(action, payload = {}, requesterUserId = "", operationId = "") {
  const actor = await fromUuid(String(payload.actorUuid ?? ""));
  if (!actor || actor.documentName !== "Actor") throw new Error("цель не найдена");
  const toolKey = validateRepairToolKey(payload.toolKey);

  if (action === "getTargetContext") {
    await getRepairSocketSourceActor(payload.sourceActorUuid, requesterUserId);
    const targetToken = await resolveRepairTokenForActor(payload.targetTokenUuid, actor, { required: true });
    return {
      targetContext: buildTargetContext(actor, targetToken, toolKey)
    };
  }

  if (action === "performRepair" || action === "performMassRepair") {
    const sourceActor = await getRepairSocketSourceActor(payload.sourceActorUuid, requesterUserId);
    const [sourceToken, targetToken] = await Promise.all([
      resolveRepairTokenForActor(payload.sourceTokenUuid, sourceActor, { required: true }),
      resolveRepairTokenForActor(payload.targetTokenUuid, actor, { required: true })
    ]);
    return {
      resolution: action === "performMassRepair"
        ? await resolveMassRepairOnAuthority({
            sourceActor,
            sourceToken,
            targetActor: actor,
            targetToken,
            toolKey,
            options: payload.options,
            operationId
          })
        : await resolveRepairOnAuthority({
            sourceActor,
            sourceToken,
            targetActor: actor,
            targetToken,
            itemId: payload.itemId,
            instrumentId: payload.instrumentId,
            methodIndex: payload.methodIndex,
            toolKey,
            operationId
          })
    };
  }

  throw new Error(`неизвестное действие ремонта: ${action}`);
}

function assertSocketActorOwner(actor, requesterUserId) {
  const user = game.users?.get?.(String(requesterUserId ?? ""))
    ?? (game.users?.contents ?? []).find(entry => entry.id === requesterUserId);
  if (!user || (!user.isGM && !actor?.testUserPermission?.(user, "OWNER"))) {
    throw new Error("нет прав на использование инструмента");
  }
}

async function getRepairSocketSourceActor(actorUuid = "", requesterUserId = "") {
  const actor = await fromUuid(String(actorUuid ?? "").trim());
  if (!actor || actor.documentName !== "Actor") throw new Error("источник ремонта не найден");
  assertSocketActorOwner(actor, requesterUserId);
  return actor;
}

function validateRepairToolKey(value = "repair") {
  const configured = String(
    getSystemActionSettings().find(entry => entry.key === "repair")?.toolKey ?? "repair"
  ).trim() || "repair";
  if (configured.includes(".") || !getToolSettings().some(entry => entry.key === configured)) {
    throw new Error("в настройках ремонта указан некорректный тип инструмента");
  }
  const requested = String(value ?? configured).trim() || configured;
  if (requested !== configured) {
    throw new Error("тип инструмента не соответствует настройкам действия ремонта");
  }
  return configured;
}

function assertRepairTokenMatchesActor(token = null, actor = null) {
  if (!token) return;
  if (
    token.documentName !== "Token"
    || !token.actor
    || String(token.actor.uuid ?? "") !== String(actor?.uuid ?? "")
  ) {
    throw new Error("токен не соответствует участнику ремонта");
  }
}

function getRepairTokenUuid(token = null) {
  const document = token?.document ?? token;
  return document?.documentName === "Token" ? String(document.uuid ?? "") : "";
}

async function resolveRepairTokenForActor(tokenUuid = "", actor = null, { required = false } = {}) {
  const uuid = String(tokenUuid ?? "").trim();
  if (!uuid) {
    if (required) throw new Error("токен участника ремонта не найден");
    return null;
  }
  const token = await fromUuid(uuid);
  if (
    token?.documentName !== "Token"
    || !token.actor
    || String(token.actor.uuid ?? "") !== String(actor?.uuid ?? "")
  ) throw new Error("токен не соответствует участнику ремонта");
  return token;
}

async function postRepairResolutionChat(actor, resolution = {}) {
  if (resolution.status === "committed") {
    return postRepairResultChat(actor, resolution);
  }
  return postRepairChat(actor, {
    title: resolution.repairItem?.name ? `Ремонт: ${resolution.repairItem.name}` : "Ремонт",
    tone: resolution.status === "alreadyComplete" ? "success" : "failure",
    lines: [resolution.reason || "Ремонт не выполнен."]
  });
}

async function postRepairResultChat(actor, { repairItem, instrument, method, initialValue, finalValue, maxValue, spentCharges, entries, completed, halted = false, reason = "" }) {
  const rows = entries.map(entry => `
    <li>
      Проверка ${entry.index}/${entry.total}: ${entry.resultLabel},
      +${entry.condition} состояния,
      запас ${entry.charges},
      эффективность ${formatNumber(entry.efficiency)}%,
      итог ${entry.currentValue}/${maxValue}
    </li>
  `).join("");
  await postRepairChat(actor, {
    title: `Ремонт: ${repairItem.name}`,
    tone: halted ? "failure" : completed ? "success" : "standard",
    lines: [
      `Инструмент: ${instrument.name}`,
      `Метод: ${method.toolLabel}, класс ${method.toolClass}, сложность ${method.difficulty}`,
      `Состояние: ${initialValue}/${maxValue} -> ${finalValue}/${maxValue}`,
      `Потрачено запаса: ${spentCharges}`,
      `<ul>${rows}</ul>`,
      halted ? `Остановлено: ${reason || "проверка ремонта не завершена"}` : "",
      completed ? "Предмет полностью отремонтирован." : ""
    ].filter(Boolean)
  });
}

async function postMassRepairChat(actor, summary) {
  await postRepairChat(actor, {
    title: "Массовый ремонт",
    tone: summary.stopped ? "failure" : summary.completed > 0 ? "success" : "standard",
    lines: [
      summary.targetName ? `Цель: ${summary.targetName}` : "",
      `Попыток ремонта: ${summary.attempted}`,
      `Полностью отремонтировано: ${summary.completed}`,
      `Восстановлено состояния: ${summary.repaired}`,
      `Потрачено запаса: ${summary.charges}`,
      summary.skipped ? `Пропущено без подходящих инструментов: ${summary.skipped}` : "",
      summary.stopped ? `Остановлено: ${summary.reason || "дальнейший ремонт невозможен"}` : ""
    ].filter(Boolean)
  });
}

async function postRepairChat(actor, { title, lines = [], tone = "standard" }) {
  const content = `
    <article class="fallout-maw-chat-card fallout-maw-repair-chat-card ${tone}">
      <h3>${escapeHtml(title)}</h3>
      ${lines.map(line => isHtmlLine(line) ? line : `<p>${escapeHtml(line)}</p>`).join("")}
    </article>
  `;
  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content,
    sound: null
  });
}

function isHtmlLine(line) {
  return String(line).trim().startsWith("<");
}

function escapeHtml(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

function getRepairResultLabel(resultKey) {
  if (resultKey === "criticalSuccess") return "критический успех";
  if (resultKey === "success") return "успех";
  if (resultKey === "criticalFailure") return "критический провал";
  return "провал";
}

function formatNumber(value) {
  return Number(value).toFixed(Number.isInteger(value) ? 0 : 1);
}

function joinUniqueLabels(values = []) {
  const unique = Array.from(new Set(values.map(value => String(value ?? "").trim()).filter(Boolean)));
  return unique.length ? unique.join(" / ") : "-";
}

function calculateBaseEfficiency(actualClass, requiredClass) {
  return 100 + Math.max(0, toToolClassRank(actualClass) - toToolClassRank(requiredClass)) * 50;
}

function isToolClassAccepted(actual, required) {
  return toToolClassRank(actual) >= toToolClassRank(required);
}

function toToolClassRank(value) {
  return TOOL_CLASS_RANK[String(value ?? "D")] ?? 0;
}

function normalizeToolClass(value) {
  const toolClass = String(value ?? "D");
  return Object.hasOwn(TOOL_CLASS_RANK, toolClass) ? toolClass : "D";
}

function canUseActorLocally(actor) {
  return Boolean(game.user?.isGM || actor?.isOwner);
}

function runWithRepairAuthorityLocks(actors, operation, chainRef = null, index = 0) {
  const ordered = index === 0
    ? Array.from(new Map((actors ?? [])
      .filter(Boolean)
      .map(actor => [String(actor.uuid ?? actor.id ?? ""), actor]))
      .values())
      .sort((left, right) => String(left.uuid ?? left.id ?? "").localeCompare(String(right.uuid ?? right.id ?? "")))
    : actors;
  if (index >= ordered.length) return operation();
  return repairAuthorityLock.run(
    ordered[index],
    chainRef,
    () => runWithRepairAuthorityLocks(ordered, operation, chainRef, index + 1)
  );
}

function getResponsibleGM() {
  return game.users?.activeGM ?? null;
}
