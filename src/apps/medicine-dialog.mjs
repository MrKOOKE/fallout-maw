import { SYSTEM_ID, TEMPLATES } from "../constants.mjs";
import { getActorHealingModifierPercent } from "../combat/damage-hub.mjs";
import { createDiseaseImmunityEffect } from "../needs/need-thresholds.mjs";
import { requestSkillCheck } from "../rolls/skill-check.mjs";
import { getSkillSettings, getSystemActionSettings, getToolSettings } from "../settings/accessors.mjs";
import { normalizeImagePath } from "../utils/actor-display-data.mjs";
import { getToolFunction, hasToolFunction } from "../utils/item-functions.mjs";
import { toInteger } from "../utils/numbers.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const MEDICINE_SOCKET = `system.${SYSTEM_ID}`;
const MEDICINE_SOCKET_SCOPE = "fallout-maw.medicine";
const MEDICINE_SOCKET_TIMEOUT = 10000;
const TOOL_CLASS_RANK = Object.freeze({ D: 0, C: 1, B: 2, A: 3, S: 4 });
const TREATMENT_PROGRESS_STEP_RATIO = 0.25;
const pendingMedicineSocketRequests = new Map();

export function registerMedicineSocket() {
  game.socket.on(MEDICINE_SOCKET, handleMedicineSocketMessage);
}

export async function requestMedicineTarget(sourceToken) {
  const sourceActor = sourceToken?.actor;
  if (!sourceActor) return undefined;

  const action = getSystemActionSettings().find(entry => entry.key === "medicine");
  const targetToken = getTargetedToken() ?? sourceToken;
  if (!targetToken?.actor) return undefined;

  const targetContext = await getMedicineTargetContext(targetToken);
  if (!targetContext) return undefined;

  return new MedicineTreatmentDialog({
    sourceActor,
    sourceToken,
    targetContext,
    targetToken,
    toolKey: action?.toolKey ?? "medical"
  }).render({ force: true });
}

class MedicineTreatmentDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  #sourceActor = null;
  #sourceToken = null;
  #targetContext = null;
  #targetToken = null;
  #toolKey = "medical";
  #activeTreatmentType = "trauma";
  #activeTreatmentId = "";
  #activeTab = "trauma";
  #targetRefreshTimeout = null;
  #targetRefreshInFlight = false;
  #targetRefreshQueued = false;
  #boundOnTargetToken = this.#onTargetToken.bind(this);

  constructor({ sourceActor, sourceToken, targetContext, targetToken, toolKey = "medical" } = {}, options = {}) {
    super(options);
    this.#sourceActor = sourceActor;
    this.#sourceToken = sourceToken;
    this.#targetContext = targetContext;
    this.#targetToken = targetToken;
    this.#toolKey = toolKey;
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-medicine-dialog",
    classes: ["fallout-maw", "fallout-maw-medicine-dialog"],
    position: {
      width: 1290,
      height: "auto"
    },
    window: {
      resizable: true
    },
    actions: {
      startTreatment: this.#onStartTreatment,
      setMedicineTab: this.#onSetMedicineTab,
      treatWithInstrument: this.#onTreatWithInstrument
    }
  };

  static PARTS = {
    body: {
      template: TEMPLATES.medicineDialog
    }
  };

  get title() {
    const sourceName = this.#sourceActor?.name ?? "";
    const targetName = this.#targetContext?.name ?? "";
    if (this.#isSelfTreatment()) return `Медицина - ${sourceName} лечит себя`;
    return `Медицина - ${sourceName} лечит ${targetName}`;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const instruments = prepareMedicalInstruments(this.#sourceActor, this.#toolKey);
    const traumas = prepareTargetTreatments(this.#targetContext?.traumas ?? [], instruments, this.#activeTreatmentType === "trauma" ? this.#activeTreatmentId : "");
    const diseases = prepareTargetTreatments(this.#targetContext?.diseases ?? [], instruments, this.#activeTreatmentType === "disease" ? this.#activeTreatmentId : "");
    return {
      ...context,
      sourceActor: this.#sourceActor,
      sourceToken: this.#sourceToken,
      targetActor: {
        name: this.#targetContext?.name ?? this.#targetToken?.name ?? ""
      },
      targetToken: this.#targetToken,
      toolLabel: getToolSettings().find(tool => tool.key === this.#toolKey)?.label ?? this.#toolKey,
      traumas,
      diseases,
      hasTraumas: traumas.length > 0,
      hasDiseases: diseases.length > 0,
      tabs: {
        trauma: {
          active: this.#activeTab === "trauma",
          cssClass: this.#activeTab === "trauma" ? "active" : ""
        },
        disease: {
          active: this.#activeTab === "disease",
          cssClass: this.#activeTab === "disease" ? "active" : ""
        }
      },
      fallbackIcon: "icons/svg/item-bag.svg"
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.#syncWindowTitle();
  }

  static #onStartTreatment(event, target) {
    event.preventDefault();
    const treatmentType = String(target.dataset.treatmentType ?? "trauma");
    const treatmentId = String(target.dataset.treatmentId ?? target.dataset.traumaId ?? "");
    const alreadyActive = this.#activeTreatmentType === treatmentType && this.#activeTreatmentId === treatmentId;
    this.#activeTreatmentType = treatmentType;
    this.#activeTreatmentId = alreadyActive ? "" : treatmentId;
    this.#activeTab = treatmentType;
    return this.render({ force: true });
  }

  static #onSetMedicineTab(event, target) {
    event.preventDefault();
    const tab = String(target.dataset.medicineTab ?? "trauma");
    if (!["trauma", "disease"].includes(tab)) return undefined;
    this.#activeTab = tab;
    return this.render({ force: true });
  }

  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    Hooks.on("targetToken", this.#boundOnTargetToken);
  }

  async _onClose(options) {
    await super._onClose(options);
    Hooks.off("targetToken", this.#boundOnTargetToken);
    if (this.#targetRefreshTimeout) window.clearTimeout(this.#targetRefreshTimeout);
    this.#targetRefreshTimeout = null;
  }

  #onTargetToken(user) {
    if (user?.id !== game.user?.id) return;
    if (this.#targetRefreshTimeout) window.clearTimeout(this.#targetRefreshTimeout);
    this.#targetRefreshTimeout = window.setTimeout(() => {
      this.#targetRefreshTimeout = null;
      void this.#refreshTargetFromSelection();
    }, 0);
  }

  async #refreshTargetFromSelection() {
    if (this.#targetRefreshInFlight) {
      this.#targetRefreshQueued = true;
      return;
    }
    this.#targetRefreshInFlight = true;
    try {
      const nextTargetToken = getTargetedToken() ?? this.#sourceToken;
      if (!nextTargetToken?.actor) return;
      const nextTargetContext = await getMedicineTargetContext(nextTargetToken);
      if (!nextTargetContext) return;

      const currentActorUuid = String(this.#targetContext?.actorUuid ?? "");
      const nextActorUuid = String(nextTargetContext.actorUuid ?? "");
      if (currentActorUuid !== nextActorUuid) this.#activeTreatmentId = "";
      else if (this.#activeTreatmentId && !getTargetTreatments(nextTargetContext, this.#activeTreatmentType).some(item => item.id === this.#activeTreatmentId)) {
        this.#activeTreatmentId = "";
      }

      this.#targetToken = nextTargetToken;
      this.#targetContext = nextTargetContext;
      const result = await this.render({ force: true });
      this.#syncWindowTitle();
      return result;
    } finally {
      this.#targetRefreshInFlight = false;
      if (this.#targetRefreshQueued) {
        this.#targetRefreshQueued = false;
        void this.#refreshTargetFromSelection();
      }
    }
  }

  #isSelfTreatment() {
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

  static async #onTreatWithInstrument(event, target) {
    event.preventDefault();
    const treatmentType = String(target.dataset.treatmentType ?? "trauma");
    const treatmentId = String(target.dataset.treatmentId ?? target.dataset.traumaId ?? "");
    const instrumentId = String(target.dataset.instrumentId ?? "");
    if (!treatmentId || !instrumentId) return undefined;

    const result = await performTreatment({
      sourceActor: this.#sourceActor,
      targetContext: this.#targetContext,
      treatmentType,
      treatmentId,
      instrumentId,
      toolKey: this.#toolKey
    });
    if (result?.targetContext) this.#targetContext = result.targetContext;
    return this.render({ force: true });
  }
}

async function getMedicineTargetContext(targetToken) {
  const actor = targetToken?.actor;
  if (!actor) return null;
  if (canUseActorLocally(actor)) return buildTargetContext(actor, targetToken);

  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("Нет активного GM для доступа к цели медицины.");
    return null;
  }

  try {
    const result = await requestMedicineSocket("getTargetContext", {
      actorUuid: actor.uuid,
      tokenName: targetToken.name
    }, gm);
    return result?.targetContext ?? null;
  } catch (error) {
    console.error(`${SYSTEM_ID} | Medicine target socket failed`, error);
    ui.notifications.error(`Не удалось получить данные цели медицины: ${error.message}`);
    return null;
  }
}

function prepareTargetTreatments(treatments, instruments, activeTreatmentId) {
  return treatments.map(treatment => {
    const requiredClass = String(treatment.healingToolClass ?? "D");
    const availableInstruments = instruments.map(instrument => {
      const classAccepted = isToolClassAccepted(instrument.toolClass, requiredClass);
      const efficiency = calculateBaseEfficiency(instrument.toolClass, requiredClass);
      return {
        ...instrument,
        efficiency,
        efficiencyLabel: `${formatNumber(efficiency)}%`,
        classAccepted,
        usable: classAccepted && instrument.supplyValue > 0 && instrument.requirementMet
      };
    });
    return {
      ...treatment,
      active: treatment.id === activeTreatmentId,
      availableInstruments
    };
  });
}

function getTargetTreatments(targetContext, treatmentType) {
  return treatmentType === "disease" ? (targetContext?.diseases ?? []) : (targetContext?.traumas ?? []);
}

function prepareMedicalInstruments(actor, toolKey) {
  const skills = getSkillSettings();
  return actor.items
    .filter(item => item.type === "gear" && hasToolFunction(item, toolKey))
    .map(item => {
      const data = getToolFunction(item, toolKey);
      const skillKey = String(data.skillKey ?? "");
      const skillValue = toInteger(data.skillValue);
      const skillLabel = skillKey ? (skills.find(skill => skill.key === skillKey)?.label ?? skillKey) : "";
      const actorSkillValue = skillKey ? toInteger(actor.system?.skills?.[skillKey]?.value) : 0;
      const requirementMet = !skillKey || actorSkillValue >= skillValue;
      return {
        id: item.id,
        name: item.name,
        img: normalizeImagePath(item.img, "icons/svg/item-bag.svg"),
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
}

async function performTreatment({ sourceActor, targetContext, treatmentType = "trauma", treatmentId, instrumentId, toolKey }) {
  if (!sourceActor?.isOwner && !game.user?.isGM) {
    ui.notifications.warn(`Нет прав на использование инструментов ${sourceActor?.name ?? ""}.`);
    return undefined;
  }

  const trauma = getTargetTreatments(targetContext, treatmentType).find(item => item.id === treatmentId);
  const instrument = sourceActor?.items?.get(instrumentId);
  if (!trauma || !instrument || instrument.type !== "gear") {
    ui.notifications.warn("Не удалось найти травму или инструмент лечения.");
    return undefined;
  }

  const tool = getToolFunction(instrument, toolKey);
  const validation = validateInstrumentForTreatment(sourceActor, trauma, tool);
  if (!validation.ok) {
    ui.notifications.warn(validation.message);
    return undefined;
  }

  const maxProgress = Math.max(1, toInteger(trauma.healingProgressMax));
  const initialProgress = Math.min(maxProgress, Math.max(0, toInteger(trauma.healingProgress)));
  const missingProgress = Math.max(0, maxProgress - initialProgress);
  if (!missingProgress) {
    await postMedicineChat(sourceActor, {
      title: "Медицина",
      tone: "success",
      lines: [`"${trauma.name}" уже вылечено.`]
    });
    return undefined;
  }

  const result = await runTreatmentChecks({
    sourceActor,
    targetContext,
    trauma,
    tool,
    initialProgress,
    maxProgress
  });

  if (!result.entries.length) {
    await postMedicineChat(sourceActor, {
      title: `Лечение: ${trauma.name}`,
      tone: "failure",
      lines: [result.reason || "Лечение не выполнено."]
    });
    return undefined;
  }

  const completed = result.finalProgress >= maxProgress;
  const finalProgress = Math.min(maxProgress, result.finalProgress);
  const updatedTargetContext = await applyTreatmentToTarget(targetContext, {
    treatmentType,
    treatmentId,
    finalProgress,
    completed
  });
  if (!updatedTargetContext) return undefined;

  await instrument.update({ [`system.functions.tools.${toolKey}.supply.value`]: result.remainingCharges });
  await postTreatmentResultChat(sourceActor, {
    trauma,
    instrument,
    initialProgress,
    finalProgress,
    maxProgress,
    spentCharges: result.spentCharges,
    entries: result.entries,
    completed
  });
  return { targetContext: updatedTargetContext };
}

async function runTreatmentChecks({ sourceActor, targetContext = null, trauma, tool, initialProgress, maxProgress }) {
  const skillKey = String(trauma.healingSkillKey ?? "");
  const difficulty = Math.max(1, toInteger(trauma.healingDifficulty));
  const progressPerCheck = Math.max(1, Math.ceil(maxProgress * TREATMENT_PROGRESS_STEP_RATIO));
  const missingProgress = Math.max(0, maxProgress - initialProgress);
  const totalChecks = Math.max(1, Math.ceil(missingProgress / progressPerCheck));
  let currentProgress = initialProgress;
  let availableCharges = toInteger(tool.supply?.value);
  let spentCharges = 0;
  const entries = [];

  for (let index = 1; index <= totalChecks; index += 1) {
    const remainingProgress = Math.max(0, maxProgress - currentProgress);
    if (!remainingProgress) break;
    if (availableCharges <= 0) break;

    const progressForCheck = Math.min(progressPerCheck, remainingProgress);
    const outcome = skillKey
      ? await requestSkillCheck({
        actor: sourceActor,
        skillKey,
        data: { difficulty },
        animate: false,
        createMessage: true,
        prompt: false,
        requester: "medicine"
      })
      : { result: { key: "success" } };
    if (!outcome) {
      return {
        entries,
        spentCharges,
        remainingCharges: availableCharges,
        finalProgress: currentProgress,
        reason: "Проверка навыка лечения не выполнена."
      };
    }

    const treatment = calculateTreatmentResult({
      trauma,
      tool,
      availableCharges,
      progressForCheck,
      missingProgress: remainingProgress,
      resultKey: String(outcome.result?.key ?? "failure"),
      healingMultiplier: getTreatmentHealingMultiplier(sourceActor, targetContext)
    });
    if (treatment.chargesUsed <= 0) break;

    availableCharges -= treatment.chargesUsed;
    spentCharges += treatment.chargesUsed;
    currentProgress = Math.min(maxProgress, currentProgress + treatment.progress);
    entries.push({
      index,
      total: totalChecks,
      resultLabel: getTreatmentResultLabel(outcome.result?.key),
      progress: treatment.progress,
      charges: treatment.chargesUsed,
      efficiency: treatment.efficiency,
      currentProgress
    });
  }

  return {
    entries,
    spentCharges,
    remainingCharges: availableCharges,
    finalProgress: currentProgress,
    reason: availableCharges <= 0 ? "Запаса инструмента не хватило для лечения." : ""
  };
}

function validateInstrumentForTreatment(actor, trauma, tool) {
  if (!tool?.enabled) return { ok: false, message: "Инструмент не подходит для лечения." };
  if (toInteger(tool.supply?.value) <= 0) return { ok: false, message: "У инструмента нет запаса." };

  const requiredClass = String(trauma.healingToolClass ?? "D");
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

function calculateTreatmentResult({ trauma, tool, availableCharges, progressForCheck, missingProgress, resultKey, healingMultiplier = 1 }) {
  const targetProgress = Math.min(progressForCheck, missingProgress);
  let efficiency = calculateBaseEfficiency(tool.toolClass, trauma.healingToolClass);
  if (resultKey === "criticalSuccess") efficiency *= 1.5;
  else if (resultKey === "failure") efficiency *= 0.5;

  const chargesNeeded = Math.max(1, Math.ceil(targetProgress * (100 / Math.max(1, efficiency))));
  const chargesUsed = Math.min(chargesNeeded, availableCharges);
  const normalProgress = Math.max(0, Math.ceil(chargesUsed * (efficiency / 100)));
  const progressMultiplier = resultKey === "criticalSuccess" ? 2 : resultKey === "criticalFailure" ? 0.5 : 1;
  const progress = Math.min(missingProgress, Math.max(0, Math.floor(normalProgress * progressMultiplier * Math.max(0, Number(healingMultiplier) || 0))));
  return { progress, chargesUsed, efficiency };
}

function getTreatmentHealingMultiplier(sourceActor, targetContext = null) {
  const outgoing = Math.max(0, 1 + (getActorHealingModifierPercent(sourceActor, "outgoing") / 100));
  const incoming = Math.max(0, 1 + (toInteger(targetContext?.incomingHealingPercent) / 100));
  return outgoing * incoming;
}

async function applyTreatmentToTarget(targetContext, { treatmentType = "trauma", treatmentId, finalProgress, completed }) {
  const actorUuid = String(targetContext?.actorUuid ?? "");
  if (!actorUuid) {
    ui.notifications.warn("Не удалось определить цель лечения.");
    return null;
  }

  const actor = await fromUuid(actorUuid);
  if (actor && canUseActorLocally(actor)) {
    try {
      return await applyTreatmentToActor(actor, { treatmentType, treatmentId, finalProgress, completed });
    } catch (error) {
      console.error(`${SYSTEM_ID} | Medicine local apply failed`, error);
      ui.notifications.error(`Не удалось применить лечение: ${error.message}`);
      return null;
    }
  }

  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("Нет активного GM для применения лечения.");
    return null;
  }

  try {
    const result = await requestMedicineSocket("applyTreatment", {
      actorUuid,
      treatmentType,
      treatmentId,
      finalProgress,
      completed
    }, gm);
    return result?.targetContext ?? null;
  } catch (error) {
    console.error(`${SYSTEM_ID} | Medicine apply socket failed`, error);
    ui.notifications.error(`Не удалось применить лечение: ${error.message}`);
    return null;
  }
}

async function applyTreatmentToActor(actor, { treatmentType = "trauma", treatmentId, finalProgress, completed }) {
  const trauma = actor?.items?.get(String(treatmentId ?? ""));
  if (!trauma || trauma.type !== treatmentType) throw new Error("цель лечения не найдена");

  const maxProgress = Math.max(1, toInteger(trauma.system?.healingProgressMax));
  const nextProgress = Math.min(maxProgress, Math.max(0, toInteger(finalProgress)));
  if (completed || nextProgress >= maxProgress) {
    if (trauma.type === "disease") await createDiseaseImmunityEffect(actor, trauma);
    await trauma.delete();
  } else {
    await trauma.update({ "system.healingProgress": nextProgress });
  }

  return buildTargetContext(actor);
}

function buildTargetContext(actor, token = null) {
  return {
    actorUuid: actor.uuid,
    name: token?.name ?? actor.name,
    actorName: actor.name,
    tokenName: token?.name ?? "",
    incomingHealingPercent: getActorHealingModifierPercent(actor, "incoming"),
    traumas: actor.items
      .filter(item => item.type === "trauma")
      .map(snapshotTrauma),
    diseases: actor.items
      .filter(item => item.type === "disease")
      .map(snapshotDisease)
  };
}

function snapshotTrauma(item) {
  const system = item.system ?? {};
  return {
    id: item.id,
    name: item.name,
    img: normalizeImagePath(item.img, "icons/svg/blood.svg"),
    limbLabel: system.limbLabel ?? "",
    damageTypeLabel: system.damageTypeLabel ?? "",
    sources: prepareTraumaSourceEntries(item),
    healingDifficulty: toInteger(system.healingDifficulty),
    healingToolClass: String(system.healingToolClass ?? "D"),
    healingProgress: toInteger(system.healingProgress),
    healingProgressMax: Math.max(1, toInteger(system.healingProgressMax)),
    healingSkillKey: String(system.healingSkillKey ?? ""),
    healingSkillLabel: getHealingSkillLabel(system.healingSkillKey)
  };
}

function snapshotDisease(item) {
  const system = item.system ?? {};
  const level = toInteger(system.level);
  const thresholdPercent = toInteger(system.thresholdPercent);
  return {
    id: item.id,
    type: "disease",
    name: item.name,
    img: normalizeImagePath(item.img, "icons/svg/biohazard.svg"),
    sources: [{
      summary: `${system.needLabel ?? system.needKey}: ${thresholdPercent}% / уровень ${level}`
    }],
    healingDifficulty: toInteger(system.healingDifficulty),
    healingToolClass: String(system.healingToolClass ?? "D"),
    healingProgress: toInteger(system.healingProgress),
    healingProgressMax: Math.max(1, toInteger(system.healingProgressMax)),
    healingSkillKey: String(system.healingSkillKey ?? ""),
    healingSkillLabel: getHealingSkillLabel(system.healingSkillKey)
  };
}

function prepareTraumaSourceEntries(item) {
  const sources = Array.isArray(item.system?.sources) && item.system.sources.length
    ? item.system.sources
    : [{
      limbLabel: item.system?.limbLabel ?? item.system?.limbKey ?? "",
      damageTypeLabel: item.system?.damageTypeLabel ?? item.system?.damageTypeKey ?? "",
      thresholdPercent: item.system?.thresholdPercent
    }];

  return sources.map(source => {
    const limbLabel = String(source.limbLabel ?? source.limbKey ?? "").trim();
    const damageTypeLabel = String(source.damageTypeLabel ?? source.damageTypeKey ?? "").trim();
    const thresholdPercent = toInteger(source.thresholdPercent);
    return {
      limbLabel,
      damageTypeLabel,
      thresholdPercent,
      summary: `${limbLabel} - ${damageTypeLabel}: ${thresholdPercent}%`
    };
  });
}

async function requestMedicineSocket(action, payload = {}, gm = getResponsibleGM()) {
  if (!gm) throw new Error("нет активного GM");
  const requestId = foundry.utils.randomID();
  const requesterUserId = game.user?.id ?? "";

  const promise = new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingMedicineSocketRequests.delete(requestId);
      reject(new Error("GM не ответил на запрос медицины"));
    }, MEDICINE_SOCKET_TIMEOUT);
    pendingMedicineSocketRequests.set(requestId, { resolve, reject, timeout });
  });

  game.socket.emit(MEDICINE_SOCKET, {
    scope: MEDICINE_SOCKET_SCOPE,
    type: "request",
    action,
    requestId,
    requesterUserId,
    gmUserId: gm.id,
    payload
  });
  return promise;
}

async function handleMedicineSocketMessage(message = {}) {
  if (message?.scope !== MEDICINE_SOCKET_SCOPE) return;

  if (message.type === "response") {
    if (message.recipientUserId && message.recipientUserId !== game.user?.id) return;
    const pending = pendingMedicineSocketRequests.get(message.requestId);
    if (!pending) return;
    window.clearTimeout(pending.timeout);
    pendingMedicineSocketRequests.delete(message.requestId);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error || "ошибка GM-сокета медицины"));
    return;
  }

  if (message.type !== "request") return;
  if (!game.user?.isGM || message.gmUserId !== game.user.id) return;

  try {
    const result = await handleMedicineSocketRequest(message.action, message.payload ?? {});
    game.socket.emit(MEDICINE_SOCKET, {
      scope: MEDICINE_SOCKET_SCOPE,
      type: "response",
      requestId: message.requestId,
      recipientUserId: message.requesterUserId,
      ok: true,
      result
    });
  } catch (error) {
    console.error(`${SYSTEM_ID} | Medicine socket request failed`, error);
    game.socket.emit(MEDICINE_SOCKET, {
      scope: MEDICINE_SOCKET_SCOPE,
      type: "response",
      requestId: message.requestId,
      recipientUserId: message.requesterUserId,
      ok: false,
      error: error.message
    });
  }
}

async function handleMedicineSocketRequest(action, payload = {}) {
  const actor = await fromUuid(String(payload.actorUuid ?? ""));
  if (!actor) throw new Error("цель не найдена");

  if (action === "getTargetContext") {
    return {
      targetContext: {
        ...buildTargetContext(actor),
        name: String(payload.tokenName ?? "") || actor.name,
        tokenName: String(payload.tokenName ?? "")
      }
    };
  }

  if (action === "applyTreatment") {
    return {
      targetContext: await applyTreatmentToActor(actor, {
        treatmentType: payload.treatmentType ?? "trauma",
        treatmentId: payload.treatmentId ?? payload.traumaId,
        finalProgress: payload.finalProgress,
        completed: payload.completed
      })
    };
  }

  throw new Error(`неизвестное действие медицины: ${action}`);
}

async function postTreatmentResultChat(actor, { trauma, instrument, initialProgress, finalProgress, maxProgress, spentCharges, entries, completed }) {
  const completionLabel = trauma.type === "disease" ? "Болезнь вылечена." : "Травма полностью вылечена.";
  const rows = entries.map(entry => `
    <li>
      Проверка ${entry.index}/${entry.total}: ${entry.resultLabel},
      +${entry.progress} прогресса,
      запас ${entry.charges},
      эффективность ${formatNumber(entry.efficiency)}%,
      итог ${entry.currentProgress}/${maxProgress}
    </li>
  `).join("");
  await postMedicineChat(actor, {
    title: `Лечение: ${trauma.name}`,
    tone: completed ? "success" : "standard",
    lines: [
      `Инструмент: ${instrument.name}`,
      `Прогресс: ${initialProgress}/${maxProgress} -> ${finalProgress}/${maxProgress}`,
      `Потрачено запаса: ${spentCharges}`,
      `<ul>${rows}</ul>`,
      completed ? completionLabel : ""
    ].filter(Boolean)
  });
}

async function postMedicineChat(actor, { title, lines = [], tone = "standard" }) {
  const content = `
    <article class="fallout-maw-chat-card fallout-maw-medicine-chat-card ${tone}">
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

function getTreatmentResultLabel(resultKey) {
  if (resultKey === "criticalSuccess") return "критический успех";
  if (resultKey === "success") return "успех";
  if (resultKey === "criticalFailure") return "критический провал";
  return "провал";
}

function formatNumber(value) {
  return Number(value).toFixed(Number.isInteger(value) ? 0 : 1);
}

function calculateBaseEfficiency(actualClass, requiredClass) {
  return 100 + Math.max(0, toToolClassRank(actualClass) - toToolClassRank(requiredClass)) * 50;
}

function getHealingSkillLabel(skillKey) {
  const key = String(skillKey ?? "");
  if (!key) return "";
  return getSkillSettings().find(skill => skill.key === key)?.label ?? key;
}

function isToolClassAccepted(actual, required) {
  return toToolClassRank(actual) >= toToolClassRank(required);
}

function toToolClassRank(value) {
  return TOOL_CLASS_RANK[String(value ?? "D")] ?? 0;
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

function getTargetedToken() {
  const targets = Array.from(game.user?.targets ?? []);
  return targets.find(token => token?.actor) ?? null;
}
