import { SYSTEM_ID, TEMPLATES } from "../constants.mjs";
import { requestCustomActorTokenSelection } from "../canvas/custom-token-selection.mjs";
import { applyDestroyedLimbConsequences, clearLimbLossState, deleteHealedTraumas, getActorHealingModifierPercent, requestDamageApplication, setLimbMissingState } from "../combat/damage-hub.mjs";
import { createDiseaseImmunityEffect } from "../needs/need-thresholds.mjs";
import { requestSkillCheck } from "../rolls/skill-check.mjs";
import { getCreatureOptions, getSkillSettings, getSystemActionSettings, getToolSettings } from "../settings/accessors.mjs";
import { normalizeImagePath } from "../utils/actor-display-data.mjs";
import { createLimbSilhouetteHud } from "../utils/limb-silhouette.mjs";
import { getConditionFunction, getImplantFunction, getProsthesisFunction, getToolFunction, hasItemFunction, hasToolFunction, isImplantForLimb, isProsthesisForLimb, ITEM_FUNCTIONS } from "../utils/item-functions.mjs";
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
  const selected = await requestCustomActorTokenSelection({
    sourceActor,
    sourceToken,
    includeSelf: true,
    title: "Медицина",
    noneWarning: "Нет подходящих целей для медицины.",
    instructions: "Медицина: выберите цель. Esc/ПКМ отменяет."
  });
  const targetToken = selected?.token ?? null;
  if (!selected?.actor || !targetToken) return undefined;

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
  #activeImplantLimbKey = "";
  #activeProsthesisLimbKey = "";

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
      width: 1040,
      height: "auto"
    },
    window: {
      resizable: true
    },
    actions: {
      startTreatment: this.#onStartTreatment,
      installImplant: this.#onInstallImplant,
      installProsthesis: this.#onInstallProsthesis,
      removeImplant: this.#onRemoveImplant,
      removeProsthesis: this.#onRemoveProsthesis,
      setImplantLimb: this.#onSetImplantLimb,
      setProsthesisLimb: this.#onSetProsthesisLimb,
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
    const implants = prepareImplantMedicineContext(this.#sourceActor, this.#targetContext, this.#activeImplantLimbKey);
    const prostheses = prepareProsthesisMedicineContext(this.#sourceActor, this.#targetContext, this.#activeProsthesisLimbKey);
    this.#activeImplantLimbKey = implants.activeLimbKey;
    this.#activeProsthesisLimbKey = prostheses.activeLimbKey;
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
      implants,
      prostheses,
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
        },
        implant: {
          active: this.#activeTab === "implant",
          cssClass: this.#activeTab === "implant" ? "active" : ""
        },
        prosthesis: {
          active: this.#activeTab === "prosthesis",
          cssClass: this.#activeTab === "prosthesis" ? "active" : ""
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
    if (!["trauma", "disease", "implant", "prosthesis"].includes(tab)) return undefined;
    this.#activeTab = tab;
    return this.render({ force: true });
  }

  static #onSetImplantLimb(event, target) {
    event.preventDefault();
    const limbKey = String(target.dataset.limbKey ?? "");
    if (!limbKey) return undefined;
    this.#activeImplantLimbKey = limbKey;
    this.#activeTab = "implant";
    return this.render({ force: true });
  }

  static #onSetProsthesisLimb(event, target) {
    event.preventDefault();
    const limbKey = String(target.dataset.limbKey ?? "");
    if (!limbKey) return undefined;
    this.#activeProsthesisLimbKey = limbKey;
    this.#activeTab = "prosthesis";
    return this.render({ force: true });
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

  static async #onInstallImplant(event, target) {
    event.preventDefault();
    const limbKey = String(target.dataset.limbKey ?? "");
    const source = String(target.dataset.implantSource ?? "");
    const itemId = String(target.dataset.implantItemId ?? "");
    if (!limbKey || !source || !itemId) return undefined;

    const result = await performImplantInstallation({
      sourceActor: this.#sourceActor,
      targetContext: this.#targetContext,
      limbKey,
      implantSource: source,
      itemId
    });
    if (result?.targetContext) this.#targetContext = result.targetContext;
    this.#activeImplantLimbKey = limbKey;
    this.#activeTab = "implant";
    return this.render({ force: true });
  }

  static async #onInstallProsthesis(event, target) {
    event.preventDefault();
    const limbKey = String(target.dataset.limbKey ?? "");
    const source = String(target.dataset.prosthesisSource ?? "");
    const itemId = String(target.dataset.prosthesisItemId ?? "");
    if (!limbKey || !source || !itemId) return undefined;

    const result = await performProsthesisInstallation({
      sourceActor: this.#sourceActor,
      targetContext: this.#targetContext,
      limbKey,
      prosthesisSource: source,
      itemId
    });
    if (result?.targetContext) this.#targetContext = result.targetContext;
    this.#activeProsthesisLimbKey = limbKey;
    this.#activeTab = "prosthesis";
    return this.render({ force: true });
  }

  static async #onRemoveImplant(event, target) {
    event.preventDefault();
    const limbKey = String(target.dataset.limbKey ?? "");
    const itemId = String(target.dataset.implantItemId ?? "");
    if (!limbKey || !itemId) return undefined;

    const updatedTargetContext = await applyImplantRemoval({
      sourceActor: this.#sourceActor,
      targetContext: this.#targetContext,
      limbKey,
      itemId
    });
    if (updatedTargetContext) this.#targetContext = updatedTargetContext;
    this.#activeImplantLimbKey = limbKey;
    this.#activeTab = "implant";
    return this.render({ force: true });
  }

  static async #onRemoveProsthesis(event, target) {
    event.preventDefault();
    const limbKey = String(target.dataset.limbKey ?? "");
    const itemId = String(target.dataset.prosthesisItemId ?? "");
    if (!limbKey || !itemId) return undefined;

    const updatedTargetContext = await applyProsthesisRemoval({
      sourceActor: this.#sourceActor,
      targetContext: this.#targetContext,
      limbKey,
      itemId
    });
    if (updatedTargetContext) this.#targetContext = updatedTargetContext;
    this.#activeProsthesisLimbKey = limbKey;
    this.#activeTab = "prosthesis";
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

function prepareProsthesisMedicineContext(sourceActor, targetContext, activeLimbKey = "") {
  const targetLimbs = (targetContext?.limbs ?? []).filter(limb => limb.missing || limb.prosthesis);
  const active = targetLimbs.some(limb => limb.key === activeLimbKey)
    ? activeLimbKey
    : "";
  const sourceItems = sourceActor?.uuid === targetContext?.actorUuid
    ? []
    : snapshotProsthesisItems(sourceActor, "source")
      .filter(item => !item.installed);
  const targetItems = (targetContext?.prosthesisItems ?? [])
    .filter(item => !item.installed);
  const candidateItems = [...sourceItems, ...targetItems];
  const limbs = targetLimbs.map(limb => {
    const candidates = candidateItems
      .filter(item => item.limbKeys.includes(limb.key))
      .map(item => ({
        ...item,
        usable: !limb.prosthesis && limb.missing && isProsthesisSnapshotInstallable(item),
        skillRequirement: item.skillLabel
      }));
    const conditionRatio = limb.prosthesis?.hasCondition && limb.prosthesis.conditionMax > 0
      ? Math.max(0, Math.min(1, limb.prosthesis.conditionValue / limb.prosthesis.conditionMax))
      : 1;
    return {
      ...limb,
      active: limb.key === active,
      cssClass: limb.key === active ? "active" : "",
      candidates,
      hasCandidates: candidates.length > 0,
      statusLabel: limb.prosthesis
        ? `Протез: ${limb.prosthesis.name}`
        : "Отсутствует",
      conditionLabel: limb.prosthesis?.conditionLabel ?? "",
      displayValue: limb.prosthesis ? (limb.prosthesis.hasCondition ? limb.prosthesis.conditionValue : "∞") : "Отсутствует",
      displayMax: limb.prosthesis?.hasCondition ? limb.prosthesis.conditionMax : "",
      fill: limb.prosthesis ? mixRgb([22, 81, 122], [143, 216, 255], conditionRatio) : "rgba(6, 8, 8, 0.96)"
    };
  });
  const activeLimb = limbs.find(limb => limb.key === active) ?? null;
  const interactiveLimbs = new Map(limbs.map(limb => [limb.key, limb]));
  const silhouetteLimbs = Object.fromEntries((targetContext?.limbs ?? []).map(limb => {
    const interactive = interactiveLimbs.get(limb.key);
    return [limb.key, interactive ?? {
      ...limb,
      displayValue: limb.value,
      displayMax: limb.max,
      popoverRows: []
    }];
  }));
  const silhouette = createLimbSilhouetteHud(targetContext?.limbSilhouette, silhouetteLimbs);
  for (const part of silhouette?.parts ?? []) {
    part.active = part.limbKey === active;
    part.interactive = interactiveLimbs.has(part.limbKey);
  }
  return {
    activeLimbKey: active,
    activeLimb,
    limbs,
    hasLimbs: limbs.length > 0,
    silhouette
  };
}

function prepareImplantMedicineContext(sourceActor, targetContext, activeLimbKey = "") {
  const targetLimbs = (targetContext?.limbs ?? []).filter(limb => (
    Math.max(0, toInteger(limb?.implantLimit)) > 0
    || (limb?.implants ?? []).length > 0
  ));
  const active = targetLimbs.some(limb => limb.key === activeLimbKey)
    ? activeLimbKey
    : targetLimbs[0]?.key ?? "";
  const sourceItems = sourceActor?.uuid === targetContext?.actorUuid
    ? []
    : snapshotImplantItems(sourceActor, "source")
      .filter(item => !item.installed);
  const targetItems = (targetContext?.implantItems ?? [])
    .filter(item => !item.installed);
  const candidateItems = [...sourceItems, ...targetItems];
  const limbs = targetLimbs.map(limb => {
    const installed = Array.isArray(limb.implants) ? limb.implants : [];
    const implantLimit = Math.max(0, toInteger(limb.implantLimit));
    const slotsAvailable = installed.length < implantLimit;
    const candidates = candidateItems
      .filter(item => item.limbKeys.includes(limb.key))
      .map(item => ({
        ...item,
        usable: slotsAvailable && isImplantSnapshotInstallable(item),
        skillRequirement: item.skillLabel
      }));
    const fillRatio = implantLimit > 0 ? Math.max(0, Math.min(1, installed.length / implantLimit)) : 1;
    return {
      ...limb,
      active: limb.key === active,
      cssClass: limb.key === active ? "active" : "",
      candidates,
      hasCandidates: candidates.length > 0,
      installedCount: installed.length,
      implantLimit,
      slotsAvailable,
      statusLabel: `Импланты: ${installed.length} / ${implantLimit}`,
      displayValue: installed.length,
      displayMax: implantLimit,
      fill: installed.length ? mixRgb([40, 80, 56], [130, 230, 165], fillRatio) : "rgba(6, 8, 8, 0.96)"
    };
  });
  const activeLimb = limbs.find(limb => limb.key === active) ?? null;
  const interactiveLimbs = new Map(limbs.map(limb => [limb.key, limb]));
  const silhouetteLimbs = Object.fromEntries((targetContext?.limbs ?? []).map(limb => {
    const interactive = interactiveLimbs.get(limb.key);
    return [limb.key, interactive ?? {
      ...limb,
      displayValue: limb.value,
      displayMax: limb.max,
      popoverRows: []
    }];
  }));
  const silhouette = createLimbSilhouetteHud(targetContext?.limbSilhouette, silhouetteLimbs);
  for (const part of silhouette?.parts ?? []) {
    part.active = part.limbKey === active;
    part.interactive = interactiveLimbs.has(part.limbKey);
  }
  return {
    activeLimbKey: active,
    activeLimb,
    limbs,
    hasLimbs: limbs.length > 0,
    silhouette
  };
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

async function performImplantInstallation({ sourceActor, targetContext, limbKey = "", implantSource = "", itemId = "" } = {}) {
  if (!sourceActor?.isOwner && !game.user?.isGM) {
    ui.notifications.warn(`Нет прав на использование инвентаря ${sourceActor?.name ?? ""}.`);
    return undefined;
  }
  const targetActorUuid = String(targetContext?.actorUuid ?? "");
  if (!targetActorUuid || !limbKey || !itemId) return undefined;

  const targetLimb = (targetContext?.limbs ?? []).find(limb => limb.key === limbKey);
  if (!targetLimb) {
    ui.notifications.warn("Часть тела для установки импланта не найдена.");
    return undefined;
  }
  const implantLimit = Math.max(0, toInteger(targetLimb.implantLimit));
  if ((targetLimb.implants ?? []).length >= implantLimit) {
    ui.notifications.warn("На выбранной части тела нет свободного места для импланта.");
    return undefined;
  }

  const implant = await resolveImplantInstallItem({ sourceActor, targetActorUuid, implantSource, itemId })
    ?? createImplantPseudoItem((targetContext?.implantItems ?? []).find(item => item.id === itemId && item.source === implantSource));
  if (!implant || !isImplantForLimb(implant, limbKey)) {
    ui.notifications.warn("Имплант не найден или не подходит к выбранной части тела.");
    return undefined;
  }
  if (!isImplantItemInstallable(implant)) {
    ui.notifications.warn("Этот имплант сломан и не может быть установлен.");
    return undefined;
  }

  const data = getImplantFunction(implant);
  const skillKey = String(data.skillKey ?? "doctor") || "doctor";
  const difficulty = Math.max(0, toInteger(data.difficulty ?? 60));
  const outcome = skillKey
    ? await requestSkillCheck({
      actor: sourceActor,
      skillKey,
      data: { difficulty },
      animate: false,
      createMessage: true,
      prompt: false,
      requester: "medicineImplant"
    })
    : { result: { key: "success" } };
  if (!outcome) return undefined;

  const resultKey = String(outcome.result?.key ?? "failure");
  if (resultKey !== "success" && resultKey !== "criticalSuccess") {
    if (resultKey === "criticalFailure") {
      const updatedTargetContext = await applyImplantCriticalFailure({
        sourceActor,
        targetActorUuid,
        limbKey,
        implantSource,
        itemId
      });
      await postMedicineChat(sourceActor, {
        title: `Установка импланта: ${implant.name}`,
        tone: "failure",
        lines: ["Критический провал. Имплант повреждён и не установлен."]
      });
      return { targetContext: updatedTargetContext ?? targetContext };
    }
    await postMedicineChat(sourceActor, {
      title: `Установка импланта: ${implant.name}`,
      tone: "failure",
      lines: ["Проверка провалена. Имплант не установлен."]
    });
    return undefined;
  }

  const updatedTargetContext = await applyImplantInstall({
    sourceActor,
    targetActorUuid,
    limbKey,
    implantSource,
    itemId
  });
  await postMedicineChat(sourceActor, {
    title: `Установка импланта: ${implant.name}`,
    tone: "success",
    lines: [`${targetContext?.name ?? "Цель"}: ${getTargetLimbLabel(targetContext, limbKey)} получила имплант.`]
  });
  return { targetContext: updatedTargetContext ?? targetContext };
}

async function resolveImplantInstallItem({ sourceActor, targetActorUuid = "", implantSource = "", itemId = "" } = {}) {
  if (implantSource === "source") return sourceActor?.items?.get(itemId) ?? null;
  const targetActor = await fromUuid(targetActorUuid);
  if (targetActor && canUseActorLocally(targetActor)) return targetActor.items?.get(itemId) ?? null;
  if (sourceActor?.uuid === targetActorUuid) return sourceActor.items?.get(itemId) ?? null;
  return null;
}

function createImplantPseudoItem(snapshot = null) {
  if (!snapshot) return null;
  return {
    id: snapshot.id,
    name: snapshot.name,
    system: {
      functions: {
        condition: {
          enabled: Boolean(snapshot.hasCondition),
          value: snapshot.conditionValue ?? 0,
          max: snapshot.conditionMax ?? 0
        },
        implant: {
          enabled: true,
          limbKeys: snapshot.limbKeys ?? [],
          difficulty: snapshot.difficulty,
          skillKey: snapshot.skillKey
        }
      }
    }
  };
}

async function applyImplantInstall({ sourceActor, targetActorUuid = "", limbKey = "", implantSource = "", itemId = "" } = {}) {
  const targetActor = await fromUuid(targetActorUuid);
  const sourceActorUuid = sourceActor?.uuid ?? "";
  if (targetActor && canUseActorLocally(targetActor) && (implantSource === "target" || sourceActor?.isOwner || game.user?.isGM)) {
    return applyImplantInstallLocally({ sourceActor, targetActor, limbKey, implantSource, itemId });
  }
  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("Нет активного GM для установки импланта.");
    return null;
  }
  const result = await requestMedicineSocket("installImplant", {
    sourceActorUuid,
    targetActorUuid,
    limbKey,
    implantSource,
    itemId
  }, gm);
  return result?.targetContext ?? null;
}

async function applyImplantCriticalFailure({ sourceActor, targetActorUuid = "", limbKey = "", implantSource = "", itemId = "" } = {}) {
  const targetActor = await fromUuid(targetActorUuid);
  const sourceActorUuid = sourceActor?.uuid ?? "";
  if (targetActor && canUseActorLocally(targetActor) && (implantSource === "target" || sourceActor?.isOwner || game.user?.isGM)) {
    return applyImplantCriticalFailureLocally({ sourceActor, targetActor, limbKey, implantSource, itemId });
  }
  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("Нет активного GM для повреждения импланта.");
    return null;
  }
  const result = await requestMedicineSocket("implantCriticalFailure", {
    sourceActorUuid,
    targetActorUuid,
    limbKey,
    implantSource,
    itemId
  }, gm);
  return result?.targetContext ?? null;
}

async function applyImplantRemoval({ sourceActor, targetContext, limbKey = "", itemId = "" } = {}) {
  const targetActorUuid = String(targetContext?.actorUuid ?? "");
  const targetActor = await fromUuid(targetActorUuid);
  const sourceActorUuid = sourceActor?.uuid ?? "";
  const sourceActorDocument = sourceActorUuid ? await fromUuid(sourceActorUuid) : sourceActor;
  if (
    targetActor
    && sourceActorDocument
    && canUseActorLocally(targetActor)
    && canUseActorLocally(sourceActorDocument)
  ) {
    return applyImplantRemovalLocally({ sourceActor: sourceActorDocument, targetActor, limbKey, itemId });
  }
  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("Нет активного GM для снятия импланта.");
    return null;
  }
  const result = await requestMedicineSocket("removeImplant", {
    sourceActorUuid,
    targetActorUuid,
    limbKey,
    itemId
  }, gm);
  return result?.targetContext ?? null;
}

async function applyImplantInstallLocally({ sourceActor, targetActor, limbKey = "", implantSource = "", itemId = "" } = {}) {
  const sourceContainer = implantSource === "source" ? sourceActor : targetActor;
  const item = sourceContainer?.items?.get(itemId);
  if (!item || item.type !== "gear" || !isImplantForLimb(item, limbKey)) return buildTargetContext(targetActor);
  if (!isImplantItemInstallable(item)) return buildTargetContext(targetActor);

  const implantLimit = getActorLimbImplantLimit(targetActor, limbKey);
  if (getInstalledTargetImplants(targetActor, limbKey).length >= implantLimit) return buildTargetContext(targetActor);

  if (sourceContainer?.uuid === targetActor.uuid) {
    const quantity = Math.max(1, toInteger(item.system?.quantity) || 1);
    if (quantity > 1) {
      await targetActor.updateEmbeddedDocuments("Item", [{
        _id: item.id,
        "system.quantity": quantity - 1
      }]);
      await targetActor.createEmbeddedDocuments("Item", [createImplantItemData(item, limbKey)]);
    } else {
      await targetActor.updateEmbeddedDocuments("Item", [createInstallImplantUpdate(item, limbKey)]);
    }
  } else {
    await targetActor.createEmbeddedDocuments("Item", [createImplantItemData(item, limbKey)]);
    const quantity = Math.max(1, toInteger(item.system?.quantity) || 1);
    if (quantity > 1) await item.update({ "system.quantity": quantity - 1 });
    else await item.delete();
  }

  return buildTargetContext(targetActor);
}

async function applyImplantRemovalLocally({ sourceActor, targetActor, limbKey = "", itemId = "" } = {}) {
  const item = targetActor?.items?.get(itemId);
  if (!item || item.type !== "gear") return buildTargetContext(targetActor);
  if (String(item.system?.placement?.mode ?? "") !== "implant") return buildTargetContext(targetActor);
  if (String(item.system?.placement?.limbKey ?? "") !== limbKey) return buildTargetContext(targetActor);

  if (sourceActor && sourceActor.uuid !== targetActor.uuid) {
    await sourceActor.createEmbeddedDocuments("Item", [createReturnedImplantItemData(item)]);
    await targetActor.deleteEmbeddedDocuments("Item", [item.id]);
  } else {
    await targetActor.updateEmbeddedDocuments("Item", [createReturnImplantUpdate(item)]);
  }
  return buildTargetContext(targetActor);
}

async function applyImplantCriticalFailureLocally({ sourceActor, targetActor, limbKey = "", implantSource = "", itemId = "" } = {}) {
  const sourceContainer = implantSource === "source" ? sourceActor : targetActor;
  const item = sourceContainer?.items?.get(itemId);
  if (!item) return buildTargetContext(targetActor);

  const applied = await damageImplantForCriticalFailure(item);
  if (applied > 0) {
    await requestDamageApplication({
      actor: targetActor,
      amount: applied,
      mode: "damage",
      scope: "health",
      applyMitigation: false,
      processDamageTypeSettings: false,
      source: {
        requester: "medicineImplantCriticalFailure",
        limbKey
      }
    });
  }
  return buildTargetContext(targetActor);
}

async function damageImplantForCriticalFailure(item) {
  if (!item || !hasItemFunction(item, ITEM_FUNCTIONS.condition)) return 0;
  const condition = getConditionFunction(item);
  const max = Math.max(0, toInteger(condition.max));
  const current = Math.max(0, toInteger(condition.value));
  const loss = Math.min(current, Math.ceil(max * 0.2));
  if (loss <= 0) return 0;
  await item.update({ "system.functions.condition.value": Math.max(0, current - loss) });
  return loss;
}

function createInstallImplantUpdate(item, limbKey = "") {
  const placement = item.system?.placement ?? {};
  return {
    _id: item.id,
    "system.equipped": true,
    "system.container.parentId": "",
    "system.placement.mode": "implant",
    "system.placement.equipmentSlot": "",
    "system.placement.weaponSet": "",
    "system.placement.weaponSlot": "",
    "system.placement.limbKey": limbKey,
    "system.placement.x": 1,
    "system.placement.y": 1,
    "system.placement.width": Math.max(1, toInteger(placement.width) || 1),
    "system.placement.height": Math.max(1, toInteger(placement.height) || 1),
    "system.placement.rotated": Boolean(placement.rotated)
  };
}

function createImplantItemData(item, limbKey = "") {
  const itemData = item.toObject();
  delete itemData._id;
  delete itemData.id;
  const placement = item.system?.placement ?? {};
  foundry.utils.mergeObject(itemData, {
    system: {
      quantity: 1,
      equipped: true,
      container: { parentId: "" },
      placement: {
        mode: "implant",
        equipmentSlot: "",
        weaponSet: "",
        weaponSlot: "",
        limbKey,
        x: 1,
        y: 1,
        width: Math.max(1, toInteger(placement.width) || 1),
        height: Math.max(1, toInteger(placement.height) || 1),
        rotated: Boolean(placement.rotated)
      }
    }
  });
  return itemData;
}

function createReturnImplantUpdate(item) {
  const placement = item.system?.placement ?? {};
  return {
    _id: item.id,
    "system.equipped": false,
    "system.container.parentId": "",
    "system.placement.mode": "inventory",
    "system.placement.equipmentSlot": "",
    "system.placement.weaponSet": "",
    "system.placement.weaponSlot": "",
    "system.placement.limbKey": "",
    "system.placement.x": 1,
    "system.placement.y": 10000,
    "system.placement.width": Math.max(1, toInteger(placement.width) || 1),
    "system.placement.height": Math.max(1, toInteger(placement.height) || 1),
    "system.placement.rotated": Boolean(placement.rotated)
  };
}

function createReturnedImplantItemData(item) {
  const itemData = item.toObject();
  delete itemData._id;
  delete itemData.id;
  const placement = item.system?.placement ?? {};
  foundry.utils.mergeObject(itemData, {
    system: {
      quantity: 1,
      equipped: false,
      container: { parentId: "" },
      placement: {
        mode: "inventory",
        equipmentSlot: "",
        weaponSet: "",
        weaponSlot: "",
        limbKey: "",
        x: 1,
        y: 10000,
        width: Math.max(1, toInteger(placement.width) || 1),
        height: Math.max(1, toInteger(placement.height) || 1),
        rotated: Boolean(placement.rotated)
      }
    }
  });
  return itemData;
}

function getInstalledTargetImplants(actor, limbKey = "") {
  return (actor?.items?.contents ?? Array.from(actor?.items ?? []))
    .filter(item => (
      item.type === "gear"
      && item.system?.equipped
      && hasItemFunction(item, ITEM_FUNCTIONS.implant)
      && String(item.system?.placement?.mode ?? "") === "implant"
      && String(item.system?.placement?.limbKey ?? "") === limbKey
    ));
}

function getActorLimbImplantLimit(actor, limbKey = "") {
  return Math.max(0, toInteger(actor?.system?.limbs?.[limbKey]?.implantLimit ?? 0));
}

function isImplantItemInstallable(item) {
  if (!hasItemFunction(item, ITEM_FUNCTIONS.condition)) return true;
  const condition = getConditionFunction(item);
  return Math.max(0, toInteger(condition.max)) > 0 && Math.max(0, toInteger(condition.value)) > 0;
}

function isImplantSnapshotInstallable(item) {
  if (!item?.hasCondition) return true;
  return Math.max(0, toInteger(item.conditionMax)) > 0 && Math.max(0, toInteger(item.conditionValue)) > 0;
}

async function performProsthesisInstallation({ sourceActor, targetContext, limbKey = "", prosthesisSource = "", itemId = "" } = {}) {
  if (!sourceActor?.isOwner && !game.user?.isGM) {
    ui.notifications.warn(`Нет прав на использование инвентаря ${sourceActor?.name ?? ""}.`);
    return undefined;
  }
  const targetActorUuid = String(targetContext?.actorUuid ?? "");
  if (!targetActorUuid || !limbKey || !itemId) return undefined;

  const prosthesis = await resolveProsthesisInstallItem({ sourceActor, targetActorUuid, prosthesisSource, itemId })
    ?? createProsthesisPseudoItem((targetContext?.prosthesisItems ?? []).find(item => item.id === itemId && item.source === prosthesisSource));
  if (!prosthesis || !isProsthesisForLimb(prosthesis, limbKey)) {
    ui.notifications.warn("Протез не найден или не подходит к выбранной части тела.");
    return undefined;
  }
  if (!isProsthesisItemInstallable(prosthesis)) {
    ui.notifications.warn("Этот протез сломан и не может быть установлен.");
    return undefined;
  }

  const data = getProsthesisFunction(prosthesis);
  const skillKey = String(data.skillKey ?? "doctor") || "doctor";
  const difficulty = Math.max(0, toInteger(data.difficulty ?? 60));
  const outcome = skillKey
    ? await requestSkillCheck({
      actor: sourceActor,
      skillKey,
      data: { difficulty },
      animate: false,
      createMessage: true,
      prompt: false,
      requester: "medicineProsthesis"
    })
    : { result: { key: "success" } };
  if (!outcome) return undefined;

  const resultKey = String(outcome.result?.key ?? "failure");
  if (resultKey !== "success" && resultKey !== "criticalSuccess") {
    if (resultKey === "criticalFailure") {
      const updatedTargetContext = await applyProsthesisCriticalFailure({
        sourceActor,
        targetActorUuid,
        limbKey,
        prosthesisSource,
        itemId
      });
      await postMedicineChat(sourceActor, {
        title: `Установка протеза: ${prosthesis.name}`,
        tone: "failure",
        lines: ["Критический провал. Протез поврежден и не установлен."]
      });
      return { targetContext: updatedTargetContext ?? targetContext };
    }
    await postMedicineChat(sourceActor, {
      title: `Установка протеза: ${prosthesis.name}`,
      tone: "failure",
      lines: ["Проверка провалена. Протез не установлен."]
    });
    return undefined;
  }

  const updatedTargetContext = await applyProsthesisInstall({
    sourceActor,
    targetActorUuid,
    limbKey,
    prosthesisSource,
    itemId
  });
  await postMedicineChat(sourceActor, {
    title: `Установка протеза: ${prosthesis.name}`,
    tone: "success",
    lines: [`${targetContext?.name ?? "Цель"}: ${getTargetLimbLabel(targetContext, limbKey)} заменена протезом.`]
  });
  return { targetContext: updatedTargetContext ?? targetContext };
}

async function resolveProsthesisInstallItem({ sourceActor, targetActorUuid = "", prosthesisSource = "", itemId = "" } = {}) {
  if (prosthesisSource === "source") return sourceActor?.items?.get(itemId) ?? null;
  const targetActor = await fromUuid(targetActorUuid);
  if (targetActor && canUseActorLocally(targetActor)) return targetActor.items?.get(itemId) ?? null;
  if (sourceActor?.uuid === targetActorUuid) return sourceActor.items?.get(itemId) ?? null;
  return null;
}

function createProsthesisPseudoItem(snapshot = null) {
  if (!snapshot) return null;
  return {
    id: snapshot.id,
    name: snapshot.name,
    system: {
      functions: {
        condition: {
          enabled: Boolean(snapshot.hasCondition),
          value: snapshot.conditionValue ?? 0,
          max: snapshot.conditionMax ?? 0
        },
        prosthesis: {
          enabled: true,
          limbKeys: snapshot.limbKeys ?? [],
          integrationPercent: snapshot.integrationPercent,
          difficulty: snapshot.difficulty,
          skillKey: snapshot.skillKey
        }
      }
    }
  };
}

async function applyProsthesisInstall({ sourceActor, targetActorUuid = "", limbKey = "", prosthesisSource = "", itemId = "" } = {}) {
  const targetActor = await fromUuid(targetActorUuid);
  const sourceActorUuid = sourceActor?.uuid ?? "";
  if (targetActor && canUseActorLocally(targetActor) && (prosthesisSource === "target" || sourceActor?.isOwner || game.user?.isGM)) {
    return applyProsthesisInstallLocally({ sourceActor, targetActor, limbKey, prosthesisSource, itemId });
  }
  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("Нет активного GM для установки протеза.");
    return null;
  }
  const result = await requestMedicineSocket("installProsthesis", {
    sourceActorUuid,
    targetActorUuid,
    limbKey,
    prosthesisSource,
    itemId
  }, gm);
  return result?.targetContext ?? null;
}

async function applyProsthesisCriticalFailure({ sourceActor, targetActorUuid = "", limbKey = "", prosthesisSource = "", itemId = "" } = {}) {
  const targetActor = await fromUuid(targetActorUuid);
  const sourceActorUuid = sourceActor?.uuid ?? "";
  if (targetActor && canUseActorLocally(targetActor) && (prosthesisSource === "target" || sourceActor?.isOwner || game.user?.isGM)) {
    return applyProsthesisCriticalFailureLocally({ sourceActor, targetActor, limbKey, prosthesisSource, itemId });
  }
  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("Нет активного GM для повреждения протеза.");
    return null;
  }
  const result = await requestMedicineSocket("prosthesisCriticalFailure", {
    sourceActorUuid,
    targetActorUuid,
    limbKey,
    prosthesisSource,
    itemId
  }, gm);
  return result?.targetContext ?? null;
}

async function applyProsthesisRemoval({ sourceActor, targetContext, limbKey = "", itemId = "" } = {}) {
  const targetActorUuid = String(targetContext?.actorUuid ?? "");
  const targetActor = await fromUuid(targetActorUuid);
  const sourceActorUuid = sourceActor?.uuid ?? "";
  const sourceActorDocument = sourceActorUuid ? await fromUuid(sourceActorUuid) : sourceActor;
  if (
    targetActor
    && sourceActorDocument
    && canUseActorLocally(targetActor)
    && canUseActorLocally(sourceActorDocument)
  ) {
    return applyProsthesisRemovalLocally({ sourceActor: sourceActorDocument, targetActor, limbKey, itemId });
  }
  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("Нет активного GM для снятия протеза.");
    return null;
  }
  const result = await requestMedicineSocket("removeProsthesis", {
    sourceActorUuid,
    targetActorUuid,
    limbKey,
    itemId
  }, gm);
  return result?.targetContext ?? null;
}

async function applyProsthesisInstallLocally({ sourceActor, targetActor, limbKey = "", prosthesisSource = "", itemId = "" } = {}) {
  const sourceContainer = prosthesisSource === "source" ? sourceActor : targetActor;
  const item = sourceContainer?.items?.get(itemId);
  if (!item || item.type !== "gear" || !isProsthesisForLimb(item, limbKey)) return buildTargetContext(targetActor);
  if (!isProsthesisItemInstallable(item)) return buildTargetContext(targetActor);

  const existing = getInstalledTargetProsthesis(targetActor, limbKey);
  if (existing) await targetActor.updateEmbeddedDocuments("Item", [createReturnProsthesisUpdate(existing)]);

  if (sourceContainer?.uuid === targetActor.uuid) {
    const quantity = Math.max(1, toInteger(item.system?.quantity) || 1);
    if (quantity > 1) {
      await targetActor.updateEmbeddedDocuments("Item", [{
        _id: item.id,
        "system.quantity": quantity - 1
      }]);
      await targetActor.createEmbeddedDocuments("Item", [createProsthesisItemData(item, limbKey)]);
    } else {
      await targetActor.updateEmbeddedDocuments("Item", [createInstallProsthesisUpdate(item, limbKey)]);
    }
  } else {
    await targetActor.createEmbeddedDocuments("Item", [createProsthesisItemData(item, limbKey)]);
    const quantity = Math.max(1, toInteger(item.system?.quantity) || 1);
    if (quantity > 1) await item.update({ "system.quantity": quantity - 1 });
    else await item.delete();
  }

  await clearLimbLossState(targetActor, limbKey);
  await setLimbMissingState(targetActor, limbKey);
  return buildTargetContext(targetActor);
}

async function applyProsthesisRemovalLocally({ sourceActor, targetActor, limbKey = "", itemId = "" } = {}) {
  const item = targetActor?.items?.get(itemId);
  if (!item || item.type !== "gear") return buildTargetContext(targetActor);
  if (String(item.system?.placement?.mode ?? "") !== "prosthesis") return buildTargetContext(targetActor);
  if (String(item.system?.placement?.limbKey ?? "") !== limbKey) return buildTargetContext(targetActor);

  if (sourceActor && sourceActor.uuid !== targetActor.uuid) {
    await sourceActor.createEmbeddedDocuments("Item", [createReturnedProsthesisItemData(item)]);
    await targetActor.deleteEmbeddedDocuments("Item", [item.id]);
  } else {
    await targetActor.updateEmbeddedDocuments("Item", [createReturnProsthesisUpdate(item)]);
  }
  await setLimbMissingState(targetActor, limbKey);
  await applyDestroyedLimbConsequences(targetActor, [limbKey], { ignoreInstalledProsthesis: true });
  return buildTargetContext(targetActor);
}

async function applyProsthesisCriticalFailureLocally({ sourceActor, targetActor, limbKey = "", prosthesisSource = "", itemId = "" } = {}) {
  const sourceContainer = prosthesisSource === "source" ? sourceActor : targetActor;
  const item = sourceContainer?.items?.get(itemId);
  if (!item) return buildTargetContext(targetActor);

  const applied = await damageProsthesisForCriticalFailure(item);
  if (applied > 0) {
    await requestDamageApplication({
      actor: targetActor,
      amount: applied,
      mode: "damage",
      scope: "health",
      applyMitigation: false,
      processDamageTypeSettings: false,
      source: {
        requester: "medicineProsthesisCriticalFailure",
        limbKey
      }
    });
  }
  return buildTargetContext(targetActor);
}

async function damageProsthesisForCriticalFailure(item) {
  if (!item || !hasItemFunction(item, ITEM_FUNCTIONS.condition)) return 0;
  const condition = getConditionFunction(item);
  const max = Math.max(0, toInteger(condition.max));
  const current = Math.max(0, toInteger(condition.value));
  const loss = Math.min(current, Math.ceil(max * 0.2));
  if (loss <= 0) return 0;
  await item.update({ "system.functions.condition.value": Math.max(0, current - loss) });
  return loss;
}

function createInstallProsthesisUpdate(item, limbKey = "") {
  const placement = item.system?.placement ?? {};
  return {
    _id: item.id,
    "system.equipped": true,
    "system.container.parentId": "",
    "system.placement.mode": "prosthesis",
    "system.placement.equipmentSlot": "",
    "system.placement.weaponSet": "",
    "system.placement.weaponSlot": "",
    "system.placement.limbKey": limbKey,
    "system.placement.x": 1,
    "system.placement.y": 1,
    "system.placement.width": Math.max(1, toInteger(placement.width) || 1),
    "system.placement.height": Math.max(1, toInteger(placement.height) || 1),
    "system.placement.rotated": Boolean(placement.rotated)
  };
}

function createProsthesisItemData(item, limbKey = "") {
  const itemData = item.toObject();
  delete itemData._id;
  delete itemData.id;
  const placement = item.system?.placement ?? {};
  foundry.utils.mergeObject(itemData, {
    system: {
      quantity: 1,
      equipped: true,
      container: { parentId: "" },
      placement: {
        mode: "prosthesis",
        equipmentSlot: "",
        weaponSet: "",
        weaponSlot: "",
        limbKey,
        x: 1,
        y: 1,
        width: Math.max(1, toInteger(placement.width) || 1),
        height: Math.max(1, toInteger(placement.height) || 1),
        rotated: Boolean(placement.rotated)
      }
    }
  });
  return itemData;
}

function createReturnProsthesisUpdate(item) {
  const placement = item.system?.placement ?? {};
  return {
    _id: item.id,
    "system.equipped": false,
    "system.container.parentId": "",
    "system.placement.mode": "inventory",
    "system.placement.equipmentSlot": "",
    "system.placement.weaponSet": "",
    "system.placement.weaponSlot": "",
    "system.placement.limbKey": "",
    "system.placement.x": 1,
    "system.placement.y": 10000,
    "system.placement.width": Math.max(1, toInteger(placement.width) || 1),
    "system.placement.height": Math.max(1, toInteger(placement.height) || 1),
    "system.placement.rotated": Boolean(placement.rotated)
  };
}

function createReturnedProsthesisItemData(item) {
  const itemData = item.toObject();
  delete itemData._id;
  delete itemData.id;
  const placement = item.system?.placement ?? {};
  foundry.utils.mergeObject(itemData, {
    system: {
      quantity: 1,
      equipped: false,
      container: { parentId: "" },
      placement: {
        mode: "inventory",
        equipmentSlot: "",
        weaponSet: "",
        weaponSlot: "",
        limbKey: "",
        x: 1,
        y: 10000,
        width: Math.max(1, toInteger(placement.width) || 1),
        height: Math.max(1, toInteger(placement.height) || 1),
        rotated: Boolean(placement.rotated)
      }
    }
  });
  return itemData;
}

function getInstalledTargetProsthesis(actor, limbKey = "") {
  return actor?.items?.find(item => (
    item.type === "gear"
    && item.system?.equipped
    && hasItemFunction(item, ITEM_FUNCTIONS.prosthesis)
    && String(item.system?.placement?.mode ?? "") === "prosthesis"
    && String(item.system?.placement?.limbKey ?? "") === limbKey
  )) ?? null;
}

function isProsthesisItemInstallable(item) {
  if (!hasItemFunction(item, ITEM_FUNCTIONS.condition)) return true;
  const condition = getConditionFunction(item);
  return Math.max(0, toInteger(condition.max)) > 0 && Math.max(0, toInteger(condition.value)) > 0;
}

function isProsthesisSnapshotInstallable(item) {
  if (!item?.hasCondition) return true;
  return Math.max(0, toInteger(item.conditionMax)) > 0 && Math.max(0, toInteger(item.conditionValue)) > 0;
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
    if (trauma.type === "disease") {
      await createDiseaseImmunityEffect(actor, trauma);
      await trauma.delete();
    } else {
      await deleteHealedTraumas(actor, [trauma.id]);
    }
  } else {
    await trauma.update({ "system.healingProgress": nextProgress });
  }

  return buildTargetContext(actor);
}

function buildTargetContext(actor, token = null) {
  const race = getCreatureOptions().races.find(entry => entry.id === actor.system?.creature?.raceId) ?? null;
  return {
    actorUuid: actor.uuid,
    name: token?.name ?? actor.name,
    actorName: actor.name,
    tokenName: token?.name ?? "",
    incomingHealingPercent: getActorHealingModifierPercent(actor, "incoming"),
    limbs: snapshotActorLimbs(actor),
    limbSilhouette: actor.system?.limbSilhouetteOverride
      ? (actor.system?.limbSilhouette ?? null)
      : (race?.limbSilhouette ?? null),
    implantItems: snapshotImplantItems(actor, "target"),
    prosthesisItems: snapshotProsthesisItems(actor, "target"),
    traumas: actor.items
      .filter(item => item.type === "trauma")
      .map(snapshotTrauma),
    diseases: actor.items
      .filter(item => item.type === "disease")
      .map(snapshotDisease)
  };
}

function snapshotActorLimbs(actor) {
  const installedImplants = getInstalledImplantsByLimb(actor);
  const installed = getInstalledProsthesesByLimb(actor);
  return Object.entries(actor.system?.limbs ?? {}).map(([key, limb]) => {
    const implants = installedImplants.get(key) ?? [];
    const prosthesis = installed.get(key) ?? null;
    const missing = Boolean(limb?.missing);
    return {
      key,
      label: String(limb?.label ?? key),
      value: toInteger(limb?.value),
      min: toInteger(limb?.min),
      max: toInteger(limb?.max),
      implantLimit: Math.max(0, toInteger(limb?.implantLimit ?? 1)),
      implants: implants.map(item => snapshotImplantItem(item, "target")),
      missing,
      prosthesis: prosthesis ? snapshotProsthesisItem(prosthesis, "target") : null
    };
  });
}

function snapshotImplantItems(actor, source = "target") {
  return actor.items
    .filter(item => item.type === "gear" && hasItemFunction(item, ITEM_FUNCTIONS.implant))
    .map(item => snapshotImplantItem(item, source));
}

function snapshotImplantItem(item, source = "target") {
  const implant = getImplantFunction(item);
  const condition = getConditionFunction(item);
  const hasCondition = hasItemFunction(item, ITEM_FUNCTIONS.condition);
  return {
    id: item.id,
    actorUuid: item.actor?.uuid ?? item.parent?.uuid ?? "",
    source,
    name: item.name,
    img: normalizeImagePath(item.img, "icons/svg/cyber-eye.svg"),
    limbKeys: (implant.limbKeys ?? []).map(key => String(key ?? "").trim()).filter(Boolean),
    difficulty: Math.max(0, toInteger(implant.difficulty ?? 60)),
    skillKey: String(implant.skillKey ?? "doctor") || "doctor",
    skillLabel: getHealingSkillLabel(implant.skillKey ?? "doctor"),
    hasCondition,
    conditionValue: hasCondition ? Math.max(0, toInteger(condition.value)) : null,
    conditionMax: hasCondition ? Math.max(0, toInteger(condition.max)) : null,
    conditionLabel: hasCondition ? `${Math.max(0, toInteger(condition.value))} / ${Math.max(0, toInteger(condition.max))}` : "∞",
    installed: String(item.system?.placement?.mode ?? "") === "implant",
    installedLimbKey: String(item.system?.placement?.limbKey ?? ""),
    quantity: Math.max(1, toInteger(item.system?.quantity) || 1)
  };
}

function snapshotProsthesisItems(actor, source = "target") {
  return actor.items
    .filter(item => item.type === "gear" && hasItemFunction(item, ITEM_FUNCTIONS.prosthesis))
    .map(item => snapshotProsthesisItem(item, source));
}

function snapshotProsthesisItem(item, source = "target") {
  const prosthesis = getProsthesisFunction(item);
  const condition = getConditionFunction(item);
  const hasCondition = hasItemFunction(item, ITEM_FUNCTIONS.condition);
  return {
    id: item.id,
    actorUuid: item.actor?.uuid ?? item.parent?.uuid ?? "",
    source,
    name: item.name,
    img: normalizeImagePath(item.img, "icons/svg/cyber-eye.svg"),
    limbKeys: (prosthesis.limbKeys ?? []).map(key => String(key ?? "").trim()).filter(Boolean),
    integrationPercent: Math.max(0, Math.min(100, toInteger(prosthesis.integrationPercent))),
    difficulty: Math.max(0, toInteger(prosthesis.difficulty ?? 60)),
    skillKey: String(prosthesis.skillKey ?? "doctor") || "doctor",
    skillLabel: getHealingSkillLabel(prosthesis.skillKey ?? "doctor"),
    hasCondition,
    conditionValue: hasCondition ? Math.max(0, toInteger(condition.value)) : null,
    conditionMax: hasCondition ? Math.max(0, toInteger(condition.max)) : null,
    conditionLabel: hasCondition ? `${Math.max(0, toInteger(condition.value))} / ${Math.max(0, toInteger(condition.max))}` : "∞",
    installed: String(item.system?.placement?.mode ?? "") === "prosthesis",
    installedLimbKey: String(item.system?.placement?.limbKey ?? ""),
    quantity: Math.max(1, toInteger(item.system?.quantity) || 1)
  };
}

function getInstalledImplantsByLimb(actor) {
  const map = new Map();
  for (const item of actor.items?.contents ?? Array.from(actor.items ?? [])) {
    if (item.type !== "gear" || !item.system?.equipped) continue;
    if (!hasItemFunction(item, ITEM_FUNCTIONS.implant)) continue;
    if (String(item.system?.placement?.mode ?? "") !== "implant") continue;
    const limbKey = String(item.system?.placement?.limbKey ?? "");
    if (!limbKey) continue;
    const items = map.get(limbKey) ?? [];
    items.push(item);
    map.set(limbKey, items);
  }
  return map;
}

function getInstalledProsthesesByLimb(actor) {
  const map = new Map();
  for (const item of actor.items?.contents ?? Array.from(actor.items ?? [])) {
    if (item.type !== "gear" || !item.system?.equipped) continue;
    if (!hasItemFunction(item, ITEM_FUNCTIONS.prosthesis)) continue;
    if (String(item.system?.placement?.mode ?? "") !== "prosthesis") continue;
    const limbKey = String(item.system?.placement?.limbKey ?? "");
    if (limbKey) map.set(limbKey, item);
  }
  return map;
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
  const actor = await fromUuid(String(payload.actorUuid ?? payload.targetActorUuid ?? ""));
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

  if (action === "installImplant") {
    const sourceActor = await fromUuid(String(payload.sourceActorUuid ?? "")) ?? actor;
    return {
      targetContext: await applyImplantInstallLocally({
        sourceActor,
        targetActor: actor,
        limbKey: payload.limbKey,
        implantSource: payload.implantSource,
        itemId: payload.itemId
      })
    };
  }

  if (action === "implantCriticalFailure") {
    const sourceActor = await fromUuid(String(payload.sourceActorUuid ?? "")) ?? actor;
    return {
      targetContext: await applyImplantCriticalFailureLocally({
        sourceActor,
        targetActor: actor,
        limbKey: payload.limbKey,
        implantSource: payload.implantSource,
        itemId: payload.itemId
      })
    };
  }

  if (action === "removeImplant") {
    const sourceActor = await fromUuid(String(payload.sourceActorUuid ?? "")) ?? actor;
    return {
      targetContext: await applyImplantRemovalLocally({
        sourceActor,
        targetActor: actor,
        limbKey: payload.limbKey,
        itemId: payload.itemId
      })
    };
  }

  if (action === "installProsthesis") {
    const sourceActor = await fromUuid(String(payload.sourceActorUuid ?? "")) ?? actor;
    return {
      targetContext: await applyProsthesisInstallLocally({
        sourceActor,
        targetActor: actor,
        limbKey: payload.limbKey,
        prosthesisSource: payload.prosthesisSource,
        itemId: payload.itemId
      })
    };
  }

  if (action === "prosthesisCriticalFailure") {
    const sourceActor = await fromUuid(String(payload.sourceActorUuid ?? "")) ?? actor;
    return {
      targetContext: await applyProsthesisCriticalFailureLocally({
        sourceActor,
        targetActor: actor,
        limbKey: payload.limbKey,
        prosthesisSource: payload.prosthesisSource,
        itemId: payload.itemId
      })
    };
  }

  if (action === "removeProsthesis") {
    const sourceActor = await fromUuid(String(payload.sourceActorUuid ?? "")) ?? actor;
    return {
      targetContext: await applyProsthesisRemovalLocally({
        sourceActor,
        targetActor: actor,
        limbKey: payload.limbKey,
        itemId: payload.itemId
      })
    };
  }

  throw new Error(`неизвестное действие медицины: ${action}`);
}

function getTargetLimbLabel(targetContext, limbKey = "") {
  return targetContext?.limbs?.find(limb => limb.key === limbKey)?.label ?? limbKey;
}

function mixRgb(from, to, ratio) {
  const amount = Math.max(0, Math.min(1, Number(ratio) || 0));
  const channels = from.map((channel, index) => Math.round(channel + ((to[index] - channel) * amount)));
  return `rgb(${channels[0]}, ${channels[1]}, ${channels[2]})`;
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
