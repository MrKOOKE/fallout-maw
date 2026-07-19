import { SYSTEM_ID, TEMPLATES } from "../constants.mjs";
import { requestCustomActorTokenSelection } from "../canvas/custom-token-selection.mjs";
import { requestSkillCheck } from "../rolls/skill-check.mjs";
import { getSkillSettings, getSystemActionSettings, getToolSettings } from "../settings/accessors.mjs";
import { normalizeImagePath } from "../utils/actor-display-data.mjs";
import {
  ITEM_FUNCTIONS,
  getConditionFunction,
  getToolFunction,
  hasItemFunction
} from "../utils/item-functions.mjs";
import { toInteger } from "../utils/numbers.mjs";

const { ApplicationV2, DialogV2, HandlebarsApplicationMixin } = foundry.applications.api;
const REPAIR_SOCKET = `system.${SYSTEM_ID}`;
const REPAIR_SOCKET_SCOPE = "fallout-maw.repair";
const REPAIR_SOCKET_TIMEOUT = 10000;
const TOOL_CLASS_RANK = Object.freeze({ D: 0, C: 1, B: 2, A: 3, S: 4 });
const REPAIR_PROGRESS_STEP_RATIO = 0.25;
const DEFAULT_REPAIR_SKILL_KEY = "repair";
const pendingRepairSocketRequests = new Map();

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

  const targetContext = await getRepairTargetContext(targetToken, toolKey);
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
    const items = prepareRepairableItems(this.#targetContext?.items ?? [], instruments, this.#activeItemId);
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
    }
    return this.render({ force: true });
  }

  static async #onRepairAll(event) {
    event.preventDefault();
    if (this.#repairInFlight) return undefined;
    const options = await promptMassRepairOptions({
      sourceActor: this.#sourceActor,
      targetContext: this.#targetContext,
      toolKey: this.#toolKey
    });
    if (!options || options === "cancel") return undefined;

    this.#repairInFlight = true;
    try {
      const result = await performMassRepair({
        sourceActor: this.#sourceActor,
        sourceToken: this.#sourceToken,
        targetContext: this.#targetContext,
        targetToken: this.#targetToken,
        toolKey: this.#toolKey,
        options
      });
      if (result?.targetContext) this.#targetContext = result.targetContext;
      if (result?.summary) await postMassRepairChat(this.#sourceActor, result.summary);
    } finally {
      this.#repairInFlight = false;
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
}

async function getRepairTargetContext(targetToken, toolKey = "repair") {
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
      tokenName: targetToken.name,
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
        .filter(([_toolKey, data]) => data?.enabled)
        .map(([toolKey, data]) => {
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
            supplyValue: toInteger(data.supply?.value),
            supplyMax: toInteger(data.supply?.max),
            skillValue,
            skillLabel,
            skillRequirement: skillKey ? `${skillValue} ${skillLabel}` : "Без навыка",
            hasSkill: Boolean(skillKey),
            requirementMet
          };
        });
    });
}

function prepareRepairableItems(items, instruments, activeItemId) {
  return items.map(item => {
    const availableInstruments = item.recoveryMethods.flatMap((method, methodIndex) => {
      const requiredClass = String(method.toolClass ?? "D");
      return instruments
        .filter(instrument => instrument.toolKey === method.toolKey)
        .map(instrument => {
          const classAccepted = isToolClassAccepted(instrument.toolClass, requiredClass);
          const efficiency = calculateBaseEfficiency(instrument.toolClass, requiredClass);
          const usable = classAccepted && instrument.supplyValue > 0 && instrument.requirementMet;
          return {
            ...instrument,
            methodIndex,
            efficiency,
            efficiencyLabel: `${formatNumber(efficiency)}%`,
            classAccepted,
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

  const instruments = collectMassRepairInstrumentOptions(sourceActor, targetContext);
  if (!instruments.length) {
    ui.notifications.warn("Нет подходящих инструментов для массового ремонта.");
    return null;
  }

  const rows = instruments.map(instrument => `
    <label class="fallout-maw-mass-repair-instrument">
      <input type="checkbox" name="instrument" value="${escapeAttribute(instrument.uid)}" checked>
      <span>${escapeHtml(instrument.name)}</span>
      <strong>${escapeHtml(instrument.toolLabel)} ${escapeHtml(instrument.toolClass)}</strong>
      <em>${instrument.supplyValue}/${instrument.supplyMax}</em>
    </label>
  `).join("");
  const content = `
    <div class="fallout-maw-mass-repair-dialog">
      <p><strong>Предметов для ремонта:</strong> ${items.length}</p>
      <div class="fallout-maw-mass-repair-modes">
        <label>
          <input type="radio" name="mode" value="even" checked>
          <span>Равномерное использование</span>
        </label>
        <label>
          <input type="radio" name="mode" value="max">
          <span>Максимально эффективно</span>
        </label>
      </div>
      <div class="fallout-maw-mass-repair-instruments">
        ${rows}
      </div>
    </div>
  `;

  return DialogV2.input({
    window: {
      title: "Массовый ремонт"
    },
    content,
    ok: {
      label: "Начать ремонт",
      icon: "fa-solid fa-screwdriver-wrench",
      callback: (_event, button) => {
        const form = button.form;
        const selectedInstrumentUids = new Set(Array.from(form.querySelectorAll("input[name='instrument']:checked"))
          .map(input => String(input.value ?? ""))
          .filter(Boolean));
        if (!selectedInstrumentUids.size) {
          ui.notifications.warn("Выберите хотя бы один инструмент.");
          return null;
        }
        return {
          mode: String(form.querySelector("input[name='mode']:checked")?.value ?? "even"),
          selectedInstrumentUids
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
  const methods = targetContext.items.flatMap(item => item.recoveryMethods ?? []);
  return prepareRepairInstruments(sourceActor)
    .filter(instrument => instrument.supplyValue > 0 && instrument.requirementMet)
    .filter(instrument => methods.some(method => (
      method.toolKey === instrument.toolKey
      && isToolClassAccepted(instrument.toolClass, method.toolClass)
    )))
    .sort((left, right) => (
      toToolClassRank(right.toolClass) - toToolClassRank(left.toolClass)
      || right.supplyValue - left.supplyValue
      || left.name.localeCompare(right.name)
    ));
}

async function performMassRepair({
  sourceActor,
  sourceToken = null,
  targetContext,
  targetToken = null,
  toolKey = "repair",
  options = {}
} = {}) {
  if (!sourceActor?.isOwner && !game.user?.isGM) {
    ui.notifications.warn(`Нет прав на использование инструментов ${sourceActor?.name ?? ""}.`);
    return undefined;
  }

  let workingContext = targetContext;
  const summary = {
    targetName: targetContext?.name ?? "",
    attempted: 0,
    completed: 0,
    repaired: 0,
    charges: 0,
    skipped: 0
  };

  const sortedItems = [...(workingContext?.items ?? [])].sort((left, right) => left.conditionRatio - right.conditionRatio);
  for (const item of sortedItems) {
    while (true) {
      const currentItem = workingContext?.items?.find(entry => entry.id === item.id);
      if (!currentItem || currentItem.conditionValue >= currentItem.conditionMax) break;
      const selection = chooseBestRepairOption(sourceActor, currentItem, options);
      if (!selection) {
        summary.skipped += 1;
        break;
      }

      summary.attempted += 1;
      const result = await performRepair({
        sourceActor,
        sourceToken,
        targetContext: workingContext,
        targetToken,
        itemId: currentItem.id,
        instrumentId: selection.instrumentId,
        methodIndex: selection.methodIndex,
        toolKey,
        quietWarnings: true
      });
      if (!result?.targetContext) break;

      workingContext = result.targetContext;
      summary.repaired += result.repairedCondition;
      summary.charges += result.spentCharges;
      if (result.repairedCondition <= 0) break;
      if (result.completed) {
        summary.completed += 1;
        break;
      }
    }
  }

  return {
    targetContext: workingContext,
    summary
  };
}

function chooseBestRepairOption(sourceActor, item, options = {}) {
  const selectedInstrumentUids = options.selectedInstrumentUids instanceof Set ? options.selectedInstrumentUids : null;
  const mode = String(options.mode ?? "even");
  const instruments = prepareRepairInstruments(sourceActor);
  const choices = item.recoveryMethods.flatMap((method, methodIndex) => {
    const requiredClass = String(method.toolClass ?? "D");
    return instruments
      .filter(instrument => !selectedInstrumentUids || selectedInstrumentUids.has(instrument.uid))
      .filter(instrument => instrument.toolKey === method.toolKey)
      .filter(instrument => instrument.supplyValue > 0 && instrument.requirementMet)
      .filter(instrument => isToolClassAccepted(instrument.toolClass, requiredClass))
      .map(instrument => ({
        methodIndex,
        instrumentId: instrument.id,
        instrument,
        method,
        rank: toToolClassRank(instrument.toolClass),
        classSurplus: toToolClassRank(instrument.toolClass) - toToolClassRank(requiredClass)
      }));
  });
  if (mode === "max") {
    choices.sort((left, right) => (
      right.classSurplus - left.classSurplus
      || right.rank - left.rank
      || right.instrument.supplyValue - left.instrument.supplyValue
    ));
  } else {
    choices.sort((left, right) => (
      left.classSurplus - right.classSurplus
      || left.rank - right.rank
      || right.instrument.supplyValue - left.instrument.supplyValue
    ));
  }
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

  const repairItem = targetContext?.items?.find(item => item.id === itemId);
  const method = repairItem?.recoveryMethods?.[methodIndex];
  const instrument = sourceActor?.items?.get(instrumentId);
  if (!repairItem || !method || !instrument || instrument.type !== "gear") {
    if (!quietWarnings) ui.notifications.warn("Не удалось найти предмет или инструмент ремонта.");
    return undefined;
  }

  const tool = getToolFunction(instrument, method.toolKey);
  const validation = validateInstrumentForRepair(sourceActor, method, tool);
  if (!validation.ok) {
    if (!quietWarnings) ui.notifications.warn(validation.message);
    return undefined;
  }

  const maxValue = Math.max(1, toInteger(repairItem.conditionMax));
  const initialValue = Math.min(maxValue, Math.max(0, toInteger(repairItem.conditionValue)));
  const missingValue = Math.max(0, maxValue - initialValue);
  if (!missingValue) {
    if (!quietWarnings) {
      await postRepairChat(sourceActor, {
        title: "Ремонт",
        tone: "success",
        lines: [`"${repairItem.name}" уже полностью отремонтирован.`]
      });
    }
    return undefined;
  }

  const result = await runRepairChecks({
    sourceActor,
    sourceToken,
    targetContext,
    targetToken,
    repairItem,
    method,
    tool,
    initialValue,
    maxValue
  });

  if (!result.entries.length) {
    if (!quietWarnings) {
      await postRepairChat(sourceActor, {
        title: `Ремонт: ${repairItem.name}`,
        tone: "failure",
        lines: [result.reason || "Ремонт не выполнен."]
      });
    }
    return undefined;
  }

  const completed = result.finalValue >= maxValue;
  const finalValue = Math.min(maxValue, result.finalValue);
  const updatedTargetContext = await applyRepairToTarget(targetContext, {
    itemId,
    finalValue,
    toolKey
  });
  if (!updatedTargetContext) return undefined;

  await instrument.update({ [`system.functions.tools.${method.toolKey}.supply.value`]: result.remainingCharges });
  await postRepairResultChat(sourceActor, {
    repairItem,
    instrument,
    method,
    initialValue,
    finalValue,
    maxValue,
    spentCharges: result.spentCharges,
    entries: result.entries,
    completed
  });
  return {
    targetContext: updatedTargetContext,
    repairedCondition: Math.max(0, finalValue - initialValue),
    spentCharges: result.spentCharges,
    completed
  };
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
  maxValue
}) {
  const progressPerCheck = Math.max(1, Math.ceil(maxValue * REPAIR_PROGRESS_STEP_RATIO));
  const missingValue = Math.max(0, maxValue - initialValue);
  const totalChecks = Math.max(1, Math.ceil(missingValue / progressPerCheck));
  const targetDocument = targetToken?.actor ?? (targetContext?.actorUuid
    ? await fromUuid(targetContext.actorUuid).catch(() => null)
    : null);
  const targetActor = targetDocument?.documentName === "Actor" ? targetDocument : null;
  let currentValue = initialValue;
  let availableCharges = toInteger(tool.supply?.value);
  let spentCharges = 0;
  const entries = [];

  for (let index = 1; index <= totalChecks; index += 1) {
    const remainingValue = Math.max(0, maxValue - currentValue);
    if (!remainingValue) break;
    if (availableCharges <= 0) break;

    const valueForCheck = Math.min(progressPerCheck, remainingValue);
    const difficulty = currentValue <= 0
      ? Math.ceil(Math.max(0, toInteger(method.difficulty)) * 1.3)
      : Math.max(0, toInteger(method.difficulty));
    const outcome = await requestSkillCheck({
      actor: sourceActor,
      skillKey: DEFAULT_REPAIR_SKILL_KEY,
      data: {
        difficulty,
        actorToken: sourceToken?.object ?? sourceToken,
        targetActor,
        targetToken: targetToken?.object ?? targetToken
      },
      animate: false,
      createMessage: true,
      prompt: false,
      requester: "repair"
    });
    if (!outcome) {
      return {
        entries,
        spentCharges,
        remainingCharges: availableCharges,
        finalValue: currentValue,
        reason: "Проверка навыка ремонта не выполнена."
      };
    }

    const repair = calculateRepairResult({
      method,
      tool,
      availableCharges,
      valueForCheck,
      missingValue: remainingValue,
      resultKey: String(outcome.result?.key ?? "failure")
    });
    if (repair.chargesUsed <= 0) break;

    availableCharges -= repair.chargesUsed;
    spentCharges += repair.chargesUsed;
    currentValue = Math.min(maxValue, currentValue + repair.condition);
    entries.push({
      index,
      total: totalChecks,
      resultLabel: getRepairResultLabel(outcome.result?.key),
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
    reason: availableCharges <= 0 ? "Запаса инструмента не хватило для ремонта." : ""
  };
}

function validateInstrumentForRepair(actor, method, tool) {
  if (!tool?.enabled) return { ok: false, message: "Инструмент не подходит для ремонта." };
  if (toInteger(tool.supply?.value) <= 0) return { ok: false, message: "У инструмента нет запаса." };

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

function calculateRepairResult({ method, tool, availableCharges, valueForCheck, missingValue, resultKey }) {
  const targetValue = Math.min(valueForCheck, missingValue);
  let efficiency = calculateBaseEfficiency(tool.toolClass, method.toolClass);
  if (resultKey === "criticalSuccess") efficiency *= 1.5;
  else if (resultKey === "failure") efficiency *= 0.5;

  const chargesNeeded = Math.max(1, Math.ceil(targetValue * (100 / Math.max(1, efficiency))));
  const chargesUsed = Math.min(chargesNeeded, availableCharges);
  const normalCondition = Math.max(0, Math.ceil(chargesUsed * (efficiency / 100)));
  const conditionMultiplier = resultKey === "criticalSuccess" ? 2 : resultKey === "criticalFailure" ? 0.5 : 1;
  const condition = Math.min(missingValue, Math.max(0, Math.floor(normalCondition * conditionMultiplier)));
  return { condition, chargesUsed, efficiency };
}

async function applyRepairToTarget(targetContext, { itemId, finalValue, toolKey = "repair" }) {
  const actorUuid = String(targetContext?.actorUuid ?? "");
  if (!actorUuid) {
    ui.notifications.warn("Не удалось определить цель ремонта.");
    return null;
  }

  const actor = await fromUuid(actorUuid);
  if (actor && canUseActorLocally(actor)) {
    try {
      return await applyRepairToActor(actor, { itemId, finalValue, toolKey });
    } catch (error) {
      console.error(`${SYSTEM_ID} | Repair local apply failed`, error);
      ui.notifications.error(`Не удалось применить ремонт: ${error.message}`);
      return null;
    }
  }

  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("Нет активного GM для применения ремонта.");
    return null;
  }

  try {
    const result = await requestRepairSocket("applyRepair", {
      actorUuid,
      itemId,
      finalValue,
      toolKey
    }, gm);
    return result?.targetContext ?? null;
  } catch (error) {
    console.error(`${SYSTEM_ID} | Repair apply socket failed`, error);
    ui.notifications.error(`Не удалось применить ремонт: ${error.message}`);
    return null;
  }
}

async function applyRepairToActor(actor, { itemId, finalValue, toolKey = "repair" }) {
  const item = actor?.items?.get(String(itemId ?? ""));
  if (!item || !hasItemFunction(item, ITEM_FUNCTIONS.condition)) throw new Error("предмет ремонта не найден");

  const condition = getConditionFunction(item);
  const maxValue = Math.max(0, toInteger(condition.max));
  const nextValue = Math.min(maxValue, Math.max(0, toInteger(finalValue)));
  await item.update({ "system.functions.condition.value": nextValue });
  return buildTargetContext(actor, null, toolKey);
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

async function requestRepairSocket(action, payload = {}, gm = getResponsibleGM()) {
  if (!gm) throw new Error("нет активного GM");
  const requestId = foundry.utils.randomID();
  const requesterUserId = game.user?.id ?? "";

  const promise = new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingRepairSocketRequests.delete(requestId);
      reject(new Error("GM не ответил на запрос ремонта"));
    }, REPAIR_SOCKET_TIMEOUT);
    pendingRepairSocketRequests.set(requestId, { resolve, reject, timeout });
  });

  game.socket.emit(REPAIR_SOCKET, {
    scope: REPAIR_SOCKET_SCOPE,
    type: "request",
    action,
    requestId,
    requesterUserId,
    gmUserId: gm.id,
    payload
  });
  return promise;
}

async function handleRepairSocketMessage(message = {}) {
  if (message?.scope !== REPAIR_SOCKET_SCOPE) return;

  if (message.type === "response") {
    if (message.recipientUserId && message.recipientUserId !== game.user?.id) return;
    const pending = pendingRepairSocketRequests.get(message.requestId);
    if (!pending) return;
    window.clearTimeout(pending.timeout);
    pendingRepairSocketRequests.delete(message.requestId);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error || "ошибка GM-сокета ремонта"));
    return;
  }

  if (message.type !== "request") return;
  if (!game.user?.isGM || message.gmUserId !== game.user.id) return;

  try {
    const result = await handleRepairSocketRequest(message.action, message.payload ?? {});
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

async function handleRepairSocketRequest(action, payload = {}) {
  const actor = await fromUuid(String(payload.actorUuid ?? ""));
  if (!actor) throw new Error("цель не найдена");
  const toolKey = String(payload.toolKey ?? "repair") || "repair";

  if (action === "getTargetContext") {
    return {
      targetContext: {
        ...buildTargetContext(actor, null, toolKey),
        name: String(payload.tokenName ?? "") || actor.name,
        tokenName: String(payload.tokenName ?? "")
      }
    };
  }

  if (action === "applyRepair") {
    return {
      targetContext: await applyRepairToActor(actor, {
        itemId: payload.itemId,
        finalValue: payload.finalValue,
        toolKey
      })
    };
  }

  throw new Error(`неизвестное действие ремонта: ${action}`);
}

async function postRepairResultChat(actor, { repairItem, instrument, method, initialValue, finalValue, maxValue, spentCharges, entries, completed }) {
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
    tone: completed ? "success" : "standard",
    lines: [
      `Инструмент: ${instrument.name}`,
      `Метод: ${method.toolLabel}, класс ${method.toolClass}, сложность ${method.difficulty}`,
      `Состояние: ${initialValue}/${maxValue} -> ${finalValue}/${maxValue}`,
      `Потрачено запаса: ${spentCharges}`,
      `<ul>${rows}</ul>`,
      completed ? "Предмет полностью отремонтирован." : ""
    ].filter(Boolean)
  });
}

async function postMassRepairChat(actor, summary) {
  await postRepairChat(actor, {
    title: "Массовый ремонт",
    tone: summary.completed > 0 ? "success" : "standard",
    lines: [
      summary.targetName ? `Цель: ${summary.targetName}` : "",
      `Попыток ремонта: ${summary.attempted}`,
      `Полностью отремонтировано: ${summary.completed}`,
      `Восстановлено состояния: ${summary.repaired}`,
      `Потрачено запаса: ${summary.charges}`,
      summary.skipped ? `Пропущено без подходящих инструментов: ${summary.skipped}` : ""
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

function getResponsibleGM() {
  return (game.users?.contents ?? [])
    .filter(user => user.active && user.isGM)
    .sort((left, right) => left.id.localeCompare(right.id))
    .at(0) ?? null;
}
