import { SYSTEM_ID, TEMPLATES } from "../constants.mjs";
import { requestCustomActorTokenSelection } from "../canvas/custom-token-selection.mjs";
import {
  applyDestroyedLimbConsequences,
  buildActorLimbHealthContext,
  canActorReceiveHealing,
  clearLimbLossState,
  getActorHealingModifierPercent,
  getLimbHealingCap,
  prepareTargetedLimbHealingActorUpdate,
  requestDamageApplication,
  runExternalHealingSystemEventWorkflow,
  setLimbMissingState,
  synchronizeActorDamageStatusesAfterInventoryMutation
} from "../combat/damage-hub.mjs";
import { createDiseaseImmunityEffect } from "../needs/need-thresholds.mjs";
import { requestSkillCheck } from "../rolls/skill-check.mjs";
import {
  getCraftingSettings,
  getCreatureOptions,
  getSkillSettings,
  getSystemActionSettings,
  getToolSettings
} from "../settings/accessors.mjs";
import { isSkillThresholdMode } from "../settings/crafting.mjs";
import { normalizeImagePath } from "../utils/actor-display-data.mjs";
import { getHealingResolutionActiveUseKeys } from "../abilities/active-use-keys.mjs";
import {
  commitPreparedActiveUseOperations,
  prepareActiveUseOperation
} from "../abilities/active-use-runtime.mjs";
import { createLimbSilhouetteHud } from "../utils/limb-silhouette.mjs";
import { createToolFunctionKey, createToolResourceValueUpdate, getConditionFunction, getImplantFunction, getProsthesisFunction, getToolFunction, getToolResourceState, hasItemFunction, isImplantForLimb, isProsthesisForLimb, ITEM_FUNCTIONS } from "../utils/item-functions.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { createActorOperationLock } from "../utils/actor-operation-lock.mjs";
import { planActorInventoryGrant } from "../utils/inventory-grants.mjs";
import {
  createItemStackPartRemovalUpdate,
  isContainerItem,
  usesVirtualInventoryStacks
} from "../utils/inventory-containers.mjs";
import { executeInventoryMutation } from "../inventory/mutation.mjs";
import { executeAtomicActorItemUpdates } from "../utils/atomic-actor-item-updates.mjs";
import {
  groupToolSelectionOptions,
  selectToolByPolicy
} from "../utils/tool-selection-policy.mjs";
import { withSystemEventRoot } from "../events/dispatcher.mjs";
import { runTerminalSystemEventWorkflow } from "../utils/system-event-workflow.mjs";
import { transferItemBetweenActors } from "./search-inventory.mjs";
import {
  getMassTreatmentTargetCounts,
  getMassTreatmentTargets,
  normalizeMassTreatmentOptions,
  runSequentialMassTreatment
} from "./medicine-mass-treatment.mjs";
import {
  evaluateMedicineSkillResolution,
  resolveMedicineSkillAction
} from "./medicine-skill-resolution.mjs";
import { analyzeMedicineToolAvailability } from "./medicine-tool-availability.mjs";
import {
  bindMassOperationDialogSubmitState,
  getMassOperationDialogSelectionState
} from "./mass-operation-dialog-state.mjs";

const { ApplicationV2, DialogV2, HandlebarsApplicationMixin } = foundry.applications.api;
const MEDICINE_SOCKET = `system.${SYSTEM_ID}`;
const MEDICINE_SOCKET_SCOPE = "fallout-maw.medicine";
const MEDICINE_SOCKET_TIMEOUT = 12 * 60 * 1000;
const MEDICINE_SOCKET_RECEIPT_TTL = 30 * 60 * 1000;
const MAX_HANDLED_MEDICINE_SOCKET_REQUESTS = 256;
const TOOL_CLASS_RANK = Object.freeze({ D: 0, C: 1, B: 2, A: 3, S: 4 });
const TREATMENT_PROGRESS_STEP_RATIO = 0.25;
const LIMB_TREATMENT_DIFFICULTY = 60;
const LIMB_TREATMENT_TOOL_CLASS = "D";
const LIMB_TREATMENT_SKILL_KEY = "doctor";
const pendingMedicineSocketRequests = new Map();
const handledMedicineSocketRequests = new Map();
const medicineAuthorityLock = createActorOperationLock();

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

  const targetContext = await getMedicineTargetContext(targetToken, sourceActor);
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
  #mutationInFlight = false;
  #pendingMassTreatment = null;

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
      treatWithInstrument: this.#onTreatWithInstrument,
      treatAll: this.#onTreatAll
    }
  };

  static PARTS = {
    body: {
      template: TEMPLATES.medicineDialog,
      templates: [TEMPLATES.medicineTreatmentRow]
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
    let traumaTreatmentContext = { limbGroups: [], unassignedTraumas: [], hasTreatments: false };
    let diseases = [];
    let implants = {};
    let prostheses = {};
    let hasMassTreatments = false;

    if (this.#activeTab === "trauma" || this.#activeTab === "disease") {
      const medicineMode = getMedicineResolutionMode();
      const instruments = prepareMedicalInstruments(this.#sourceActor, this.#toolKey);
      const instrumentRowsByClass = new Map();
      if (this.#activeTab === "trauma") {
        traumaTreatmentContext = prepareLimbTreatmentGroups(
          this.#targetContext,
          instruments,
          this.#activeTreatmentType,
          this.#activeTreatmentId,
          instrumentRowsByClass,
          this.#sourceActor,
          medicineMode
        );
        hasMassTreatments = hasMassTreatmentTargets(this.#targetContext);
      } else {
        diseases = prepareTargetTreatments(
          this.#targetContext?.diseases ?? [],
          instruments,
          this.#activeTreatmentType === "disease" ? this.#activeTreatmentId : "",
          instrumentRowsByClass,
          this.#sourceActor,
          medicineMode
        );
      }
    } else if (this.#activeTab === "implant") {
      implants = prepareImplantMedicineContext(
        this.#sourceActor,
        this.#targetContext,
        this.#activeImplantLimbKey
      );
      this.#activeImplantLimbKey = implants.activeLimbKey;
    } else if (this.#activeTab === "prosthesis") {
      prostheses = prepareProsthesisMedicineContext(
        this.#sourceActor,
        this.#targetContext,
        this.#activeProsthesisLimbKey
      );
      this.#activeProsthesisLimbKey = prostheses.activeLimbKey;
    }
    return {
      ...context,
      sourceActor: this.#sourceActor,
      sourceToken: this.#sourceToken,
      targetActor: {
        name: this.#targetContext?.name ?? this.#targetToken?.name ?? ""
      },
      targetToken: this.#targetToken,
      toolLabel: getToolSettings().find(tool => tool.key === this.#toolKey)?.label ?? this.#toolKey,
      limbGroups: traumaTreatmentContext.limbGroups,
      unassignedTraumas: traumaTreatmentContext.unassignedTraumas,
      diseases,
      implants,
      prostheses,
      hasTraumaTreatments: traumaTreatmentContext.hasTreatments,
      hasMassTreatments,
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
    this.#setMutationBusyState(this.#mutationInFlight);
  }

  static #onStartTreatment(event, target) {
    event.preventDefault();
    if (this.#mutationInFlight) return undefined;
    const treatmentType = String(target.dataset.treatmentType ?? "trauma");
    const treatmentId = String(target.dataset.treatmentId ?? target.dataset.traumaId ?? "");
    const alreadyActive = this.#activeTreatmentType === treatmentType && this.#activeTreatmentId === treatmentId;
    this.#activeTreatmentType = treatmentType;
    this.#activeTreatmentId = alreadyActive ? "" : treatmentId;
    this.#activeTab = treatmentType === "limb" ? "trauma" : treatmentType;
    return this.render({ force: true });
  }

  static #onSetMedicineTab(event, target) {
    event.preventDefault();
    if (this.#mutationInFlight) return undefined;
    const tab = String(target.dataset.medicineTab ?? "trauma");
    if (!["trauma", "disease", "implant", "prosthesis"].includes(tab)) return undefined;
    this.#activeTab = tab;
    return this.render({ force: true });
  }

  static #onSetImplantLimb(event, target) {
    event.preventDefault();
    if (this.#mutationInFlight) return undefined;
    const limbKey = String(target.dataset.limbKey ?? "");
    if (!limbKey) return undefined;
    this.#activeImplantLimbKey = limbKey;
    this.#activeTab = "implant";
    return this.render({ force: true });
  }

  static #onSetProsthesisLimb(event, target) {
    event.preventDefault();
    if (this.#mutationInFlight) return undefined;
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

  #setMutationBusyState(active) {
    const element = this.element;
    if (!element) return;
    element.classList.toggle("is-mutation-busy", active);
    if (active) element.setAttribute("aria-busy", "true");
    else element.removeAttribute("aria-busy");

    for (const button of element.querySelectorAll("button[data-action]")) {
      if (active) {
        if (button.disabled) continue;
        button.disabled = true;
        button.dataset.medicineBusyDisabled = "true";
      } else if (button.dataset.medicineBusyDisabled === "true") {
        button.disabled = false;
        delete button.dataset.medicineBusyDisabled;
      }
    }
  }

  async #runMutation(operation) {
    if (this.#mutationInFlight) return undefined;
    this.#mutationInFlight = true;
    this.#setMutationBusyState(true);
    try {
      return await operation();
    } catch (error) {
      console.error(`${SYSTEM_ID} | Medicine dialog mutation failed`, error);
      ui.notifications.error(`Медицинская операция не выполнена: ${error.message}`);
      return undefined;
    } finally {
      this.#mutationInFlight = false;
      this.#setMutationBusyState(false);
    }
  }

  static async #onTreatWithInstrument(event, target) {
    event.preventDefault();
    if (this.#mutationInFlight) return undefined;
    const treatmentType = String(target.dataset.treatmentType ?? "trauma");
    const treatmentId = String(target.dataset.treatmentId ?? target.dataset.traumaId ?? "");
    const instrumentId = String(target.dataset.instrumentId ?? "");
    if (!treatmentId || !instrumentId) return undefined;

    return this.#runMutation(async () => {
      const result = await performTreatment({
        sourceActor: this.#sourceActor,
        sourceToken: this.#sourceToken,
        targetContext: this.#targetContext,
        targetToken: this.#targetToken,
        treatmentType,
        treatmentId,
        instrumentId,
        toolKey: this.#toolKey
      });
      if (result?.targetContext) {
        this.#targetContext = result.targetContext;
        const refreshedTarget = getTargetTreatments(this.#targetContext, treatmentType)
          .find(item => item.id === treatmentId);
        if (
          !refreshedTarget
          || refreshedTarget.treatable === false
          || toInteger(refreshedTarget.healingProgress) >= Math.max(1, toInteger(refreshedTarget.healingProgressMax))
        ) {
          if (
            this.#activeTreatmentType === treatmentType
            && this.#activeTreatmentId === treatmentId
          ) this.#activeTreatmentId = "";
        }
      }
      return await this.render({ force: true });
    });
  }

  static async #onTreatAll(event) {
    event.preventDefault();
    if (this.#mutationInFlight) return undefined;
    return this.#runMutation(async () => {
      let pending = this.#pendingMassTreatment;
      if (!pending) {
        const options = await promptMassTreatmentOptions({
          sourceActor: this.#sourceActor,
          targetContext: this.#targetContext,
          toolKey: this.#toolKey
        });
        if (!options || options === "cancel") return undefined;
        pending = {
          requestId: foundry.utils.randomID(),
          options
        };
        this.#pendingMassTreatment = pending;
      } else {
        ui.notifications.info("Повторное ожидание уже запущенного массового лечения.");
      }
      const result = await performMassTreatment({
        sourceActor: this.#sourceActor,
        sourceToken: this.#sourceToken,
        targetContext: this.#targetContext,
        targetToken: this.#targetToken,
        toolKey: this.#toolKey,
        options: pending.options,
        requestId: pending.requestId
      });
      if (result?.pending) return undefined;
      this.#pendingMassTreatment = null;
      if (result?.targetContext) this.#targetContext = result.targetContext;
      if (this.#activeTreatmentId) {
        const activeTarget = getTargetTreatments(this.#targetContext, this.#activeTreatmentType)
          .find(item => item.id === this.#activeTreatmentId);
        if (!activeTarget || activeTarget.treatable === false) this.#activeTreatmentId = "";
      }
      return await this.render({ force: true });
    });
  }

  static async #onInstallImplant(event, target) {
    event.preventDefault();
    if (this.#mutationInFlight) return undefined;
    const limbKey = String(target.dataset.limbKey ?? "");
    const source = String(target.dataset.implantSource ?? "");
    const itemId = String(target.dataset.implantItemId ?? "");
    if (!limbKey || !source || !itemId) return undefined;

    return this.#runMutation(async () => {
      const result = await performImplantInstallation({
        sourceActor: this.#sourceActor,
        sourceToken: this.#sourceToken,
        targetContext: this.#targetContext,
        targetToken: this.#targetToken,
        limbKey,
        implantSource: source,
        itemId
      });
      if (result?.targetContext) this.#targetContext = result.targetContext;
      this.#activeImplantLimbKey = limbKey;
      this.#activeTab = "implant";
      return this.render({ force: true });
    });
  }

  static async #onInstallProsthesis(event, target) {
    event.preventDefault();
    if (this.#mutationInFlight) return undefined;
    const limbKey = String(target.dataset.limbKey ?? "");
    const source = String(target.dataset.prosthesisSource ?? "");
    const itemId = String(target.dataset.prosthesisItemId ?? "");
    if (!limbKey || !source || !itemId) return undefined;

    return this.#runMutation(async () => {
      const result = await performProsthesisInstallation({
        sourceActor: this.#sourceActor,
        sourceToken: this.#sourceToken,
        targetContext: this.#targetContext,
        targetToken: this.#targetToken,
        limbKey,
        prosthesisSource: source,
        itemId
      });
      if (result?.targetContext) this.#targetContext = result.targetContext;
      this.#activeProsthesisLimbKey = limbKey;
      this.#activeTab = "prosthesis";
      return this.render({ force: true });
    });
  }

  static async #onRemoveImplant(event, target) {
    event.preventDefault();
    if (this.#mutationInFlight) return undefined;
    const limbKey = String(target.dataset.limbKey ?? "");
    const itemId = String(target.dataset.implantItemId ?? "");
    if (!limbKey || !itemId) return undefined;

    return this.#runMutation(async () => {
      const updatedTargetContext = await applyImplantRemoval({
        sourceActor: this.#sourceActor,
        targetContext: this.#targetContext,
        targetToken: this.#targetToken,
        limbKey,
        itemId
      });
      if (updatedTargetContext) this.#targetContext = updatedTargetContext;
      this.#activeImplantLimbKey = limbKey;
      this.#activeTab = "implant";
      return this.render({ force: true });
    });
  }

  static async #onRemoveProsthesis(event, target) {
    event.preventDefault();
    if (this.#mutationInFlight) return undefined;
    const limbKey = String(target.dataset.limbKey ?? "");
    const itemId = String(target.dataset.prosthesisItemId ?? "");
    if (!limbKey || !itemId) return undefined;

    return this.#runMutation(async () => {
      const updatedTargetContext = await applyProsthesisRemoval({
        sourceActor: this.#sourceActor,
        targetContext: this.#targetContext,
        targetToken: this.#targetToken,
        limbKey,
        itemId
      });
      if (updatedTargetContext) this.#targetContext = updatedTargetContext;
      this.#activeProsthesisLimbKey = limbKey;
      this.#activeTab = "prosthesis";
      return this.render({ force: true });
    });
  }
}

async function getMedicineTargetContext(targetToken, sourceActor = null) {
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
      sourceActorUuid: sourceActor?.uuid ?? "",
      targetTokenUuid: getMedicineTokenUuid(targetToken)
    }, gm);
    return result?.targetContext ?? null;
  } catch (error) {
    console.error(`${SYSTEM_ID} | Medicine target socket failed`, error);
    ui.notifications.error(`Не удалось получить данные цели медицины: ${error.message}`);
    return null;
  }
}

function prepareLimbTreatmentGroups(
  targetContext,
  instruments,
  activeTreatmentType = "trauma",
  activeTreatmentId = "",
  instrumentRowsByClass = new Map(),
  sourceActor = null,
  medicineMode = getMedicineResolutionMode()
) {
  const targetLimbKeys = new Set((targetContext?.limbs ?? []).map(limb => limb.key));
  const traumasByLimb = new Map();
  const unassigned = [];
  for (const trauma of targetContext?.traumas ?? []) {
    const limbKey = getTraumaTreatmentLimbKey(trauma, targetLimbKeys);
    if (!limbKey) {
      unassigned.push(trauma);
      continue;
    }
    const entries = traumasByLimb.get(limbKey) ?? [];
    entries.push(trauma);
    traumasByLimb.set(limbKey, entries);
  }

  const limbGroups = [];
  for (const limb of targetContext?.limbs ?? []) {
    const traumas = prepareTargetTreatments(
      traumasByLimb.get(limb.key) ?? [],
      instruments,
      activeTreatmentType === "trauma" ? activeTreatmentId : "",
      instrumentRowsByClass,
      sourceActor,
      medicineMode
    );
    const [limbTreatment] = prepareTargetTreatments(
      [limb],
      instruments,
      activeTreatmentType === "limb" ? activeTreatmentId : "",
      instrumentRowsByClass,
      sourceActor,
      medicineMode
    );
    if (!limbTreatment || (!limb.damaged && !traumas.length)) continue;
    limbGroups.push({
      key: limb.key,
      label: limb.label,
      value: limb.value,
      max: limb.max,
      healingCap: limb.healingCap,
      hasHealingLimit: limb.healingCap < limb.max,
      statusLabel: limb.statusLabel,
      limbTreatment,
      traumas
    });
  }

  const unassignedTraumas = prepareTargetTreatments(
    unassigned,
    instruments,
    activeTreatmentType === "trauma" ? activeTreatmentId : "",
    instrumentRowsByClass,
    sourceActor,
    medicineMode
  );
  return {
    limbGroups,
    unassignedTraumas,
    hasTreatments: limbGroups.length > 0 || unassignedTraumas.length > 0
  };
}

function getTraumaTreatmentLimbKey(trauma, targetLimbKeys) {
  const keys = Array.from(new Set([trauma?.limbKey, ...(trauma?.limbKeys ?? [])]
    .map(key => String(key ?? "").trim())
    .filter(key => key && targetLimbKeys.has(key))));
  return keys.length === 1 ? keys[0] : "";
}

function prepareTargetTreatments(
  treatments,
  instruments,
  activeTreatmentId,
  instrumentRowsByClass = new Map(),
  sourceActor = null,
  medicineMode = getMedicineResolutionMode()
) {
  return treatments.map(treatment => {
    const requiredClass = String(treatment.healingToolClass ?? "D");
    let baseInstrumentRows = instrumentRowsByClass.get(requiredClass);
    if (!baseInstrumentRows) {
      baseInstrumentRows = instruments.map(instrument => {
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
      instrumentRowsByClass.set(requiredClass, baseInstrumentRows);
    }
    const skillResolution = getMedicineSkillResolution(sourceActor, treatment, medicineMode);
    const availableInstruments = baseInstrumentRows.map(instrument => ({
      ...instrument,
      treatmentSkillThresholdMet: skillResolution.met,
      usable: instrument.usable && skillResolution.met
    }));
    const treatable = treatment.treatable !== false
      && toInteger(treatment.healingProgress) < Math.max(1, toInteger(treatment.healingProgressMax));
    return {
      ...treatment,
      active: treatment.id === activeTreatmentId,
      treatable,
      treatmentSkillThresholdMet: skillResolution.met,
      treatmentSkillRequirement: skillResolution.usesThreshold
        ? getMedicineSkillThresholdMessage(skillResolution)
        : "",
      progressValue: treatment.displayProgressValue ?? treatment.healingProgress,
      progressMax: treatment.displayProgressMax ?? treatment.healingProgressMax,
      availableInstruments: treatable
        ? availableInstruments
        : availableInstruments.map(instrument => ({ ...instrument, usable: false }))
    };
  });
}

function getTargetTreatments(targetContext, treatmentType) {
  if (treatmentType === "limb") return targetContext?.limbs ?? [];
  if (treatmentType === "disease") return targetContext?.diseases ?? [];
  return targetContext?.traumas ?? [];
}

function prepareMedicalInstruments(actor, toolKey) {
  const skills = getSkillSettings();
  const skillLabels = new Map(skills.map(skill => [skill.key, skill.label]));
  const toolLabel = getToolSettings().find(tool => tool.key === toolKey)?.label ?? toolKey;
  const functionKey = createToolFunctionKey(toolKey);
  return getActorItemsByType(actor, "gear")
    .filter(item => hasItemFunction(item, functionKey))
    .map(item => {
      const data = getEffectiveMedicineToolFunction(item, toolKey);
      const skillKey = String(data.skillKey ?? "");
      const skillValue = toInteger(data.skillValue);
      const skillLabel = skillKey ? (skillLabels.get(skillKey) ?? skillKey) : "";
      const actorSkillValue = skillKey ? toInteger(actor.system?.skills?.[skillKey]?.value) : 0;
      const requirementMet = !skillKey || actorSkillValue >= skillValue;
      return {
        id: item.id,
        name: item.name,
        img: normalizeImagePath(item.img, "icons/svg/item-bag.svg"),
        toolKey,
        toolLabel,
        toolClass: String(data.toolClass ?? "D"),
        supplyValue: data.resource.value,
        supplyMax: data.resource.max,
        skillValue,
        skillLabel,
        actorSkillValue,
        skillRequirement: skillKey ? `${skillValue} ${skillLabel}` : "Без навыка",
        hasSkill: Boolean(skillKey),
        requirementMet
      };
    });
}

function getEffectiveMedicineToolFunction(item, toolKey) {
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

function hasMassTreatmentTargets(targetContext) {
  const counts = getMassTreatmentTargetCounts(targetContext);
  return counts.traumas + counts.limbHealth > 0;
}

async function promptMassTreatmentOptions({ sourceActor, targetContext, toolKey = "medical" } = {}) {
  const counts = getMassTreatmentTargetCounts(targetContext);
  if (counts.traumas + counts.limbHealth <= 0) {
    ui.notifications.warn("Нет травм или повреждённых частей тела для массового лечения.");
    return null;
  }

  const availability = getMassTreatmentAvailability(sourceActor, targetContext, toolKey);
  if (!availability.ok) {
    ui.notifications.warn(availability.message);
    return null;
  }
  const instruments = availability.instruments;

  const toolGroups = groupToolSelectionOptions(instruments);
  const instrumentRows = toolGroups.map(group => `
    <label class="fallout-maw-mass-operation-instrument">
      <input type="checkbox" name="toolGroup" value="${escapeAttribute(group.key)}" checked>
      <span>${escapeHtml(group.toolLabel)}</span>
      <strong>Класс ${escapeHtml(group.toolClass)}</strong>
      <em>${group.count} шт., общий запас ${group.supplyValue}/${group.supplyMax}</em>
    </label>
  `).join("");
  const content = `
    <div class="fallout-maw-mass-operation-dialog fallout-maw-mass-treatment-dialog">
      <p>Лечение выполняется последовательно: сначала травмы, затем здоровье частей тела.</p>
      <div class="fallout-maw-mass-operation-categories">
        <label>
          <input type="checkbox" name="includeTraumas" ${counts.traumas > 0 ? "checked" : "disabled"}>
          <span>Лечить травмы</span>
          <strong>${counts.traumas}</strong>
        </label>
        <label>
          <input type="checkbox" name="includeLimbHealth" ${counts.limbHealth > 0 ? "checked" : "disabled"}>
          <span>Восстанавливать здоровье частей тела</span>
          <strong>${counts.limbHealth}</strong>
        </label>
      </div>
      <fieldset class="fallout-maw-mass-operation-modes">
        <legend>Выбор класса</legend>
        <label>
          <input type="radio" name="qualityMode" value="matched" checked>
          <span>Минимально достаточный класс</span>
        </label>
        <label>
          <input type="radio" name="qualityMode" value="best">
          <span>Лучший доступный класс</span>
        </label>
      </fieldset>
      <fieldset class="fallout-maw-mass-operation-modes">
        <legend>Распределение запаса</legend>
        <label>
          <input type="radio" name="supplyMode" value="depleted" checked>
          <span>Сначала наиболее израсходованные наборы</span>
        </label>
        <label>
          <input type="radio" name="supplyMode" value="balanced">
          <span>Выравнивать остаток между наборами</span>
        </label>
      </fieldset>
      <div class="fallout-maw-mass-operation-instruments">
        ${instrumentRows}
      </div>
    </div>
  `;

  return DialogV2.input({
    modal: true,
    window: { title: "Массовое лечение" },
    content,
    render: (_event, dialog) => bindMassOperationDialogSubmitState(dialog, {
      categoryNames: ["includeTraumas", "includeLimbHealth"]
    }),
    ok: {
      label: "Начать лечение",
      icon: "fa-solid fa-kit-medical",
      callback: (_event, button) => {
        const form = button.form;
        const selectionState = getMassOperationDialogSelectionState(form, {
          categoryNames: ["includeTraumas", "includeLimbHealth"]
        });
        if (!selectionState.hasCategorySelection) {
          ui.notifications.warn("Выберите травмы, здоровье частей тела или оба варианта.");
          return "cancel";
        }
        const includeTraumas = Boolean(form.querySelector("input[name='includeTraumas']")?.checked);
        const includeLimbHealth = Boolean(form.querySelector("input[name='includeLimbHealth']")?.checked);
        const allowedToolGroupKeys = Array.from(form.querySelectorAll("input[name='toolGroup']:checked"))
          .map(input => String(input.value ?? "").trim())
          .filter(Boolean);
        if (!selectionState.hasToolGroupSelection || !allowedToolGroupKeys.length) {
          ui.notifications.warn("Выберите хотя бы одну группу медицинских инструментов.");
          return "cancel";
        }
        const options = normalizeMassTreatmentOptions({
          includeTraumas,
          includeLimbHealth,
          qualityMode: form.querySelector("input[name='qualityMode']:checked")?.value,
          supplyMode: form.querySelector("input[name='supplyMode']:checked")?.value,
          allowedToolGroupKeys
        });
        const currentAvailability = getMassTreatmentAvailability(
          sourceActor,
          targetContext,
          toolKey,
          options
        );
        if (!currentAvailability.ok) {
          ui.notifications.warn(currentAvailability.message);
          return "cancel";
        }
        return options;
      }
    },
    buttons: [{ action: "cancel", label: "Отмена" }],
    position: { width: 580 },
    rejectClose: false
  });
}

function chooseBestTreatmentInstrument(sourceActor, treatment, toolKey, options = {}) {
  const normalizedOptions = normalizeMassTreatmentOptions(options);
  const medicineMode = getMedicineResolutionMode();
  const availability = analyzeMedicineToolAvailability({
    instruments: prepareMedicalInstruments(sourceActor, toolKey),
    treatments: [prepareMedicineTreatmentRequirement(sourceActor, treatment, medicineMode)],
    toolKey,
    toolLabel: getMedicineToolLabel(toolKey),
    allowedToolGroupKeys: normalizedOptions.allowedToolGroupKeys
  });
  if (!availability.ok) return { reason: availability.message };
  const selected = selectToolByPolicy(availability.instruments, {
    requiredToolKey: toolKey,
    requiredToolClass: treatment?.healingToolClass
  }, normalizedOptions);
  return selected
    ? { instrumentId: selected.id }
    : { reason: "Выбранные медицинские инструменты больше не подходят для этой цели." };
}

function getMassTreatmentAvailability(
  sourceActor,
  targetContext,
  toolKey = "medical",
  options = {}
) {
  const normalizedOptions = normalizeMassTreatmentOptions(options);
  const medicineMode = getMedicineResolutionMode();
  const targets = getMassTreatmentTargets(targetContext);
  const treatments = [
    ...(normalizedOptions.includeTraumas ? targets.traumas : []),
    ...(normalizedOptions.includeLimbHealth ? targets.limbHealth : [])
  ].map(treatment => prepareMedicineTreatmentRequirement(sourceActor, treatment, medicineMode));
  return analyzeMedicineToolAvailability({
    instruments: prepareMedicalInstruments(sourceActor, toolKey),
    treatments,
    toolKey,
    toolLabel: getMedicineToolLabel(toolKey),
    allowedToolGroupKeys: normalizedOptions.allowedToolGroupKeys
  });
}

function prepareMedicineTreatmentRequirement(
  sourceActor,
  treatment,
  medicineMode = getMedicineResolutionMode()
) {
  const skillResolution = getMedicineSkillResolution(sourceActor, treatment, medicineMode);
  return {
    ...treatment,
    skillThreshold: {
      ...skillResolution,
      skillLabel: getHealingSkillLabel(skillResolution.skillKey)
    }
  };
}

function getMedicineToolLabel(toolKey = "medical") {
  const normalized = String(toolKey ?? "").trim();
  return getToolSettings().find(tool => tool.key === normalized)?.label ?? normalized;
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

async function performTreatment({ sourceActor, sourceToken = null, targetContext, targetToken = null, treatmentType = "trauma", treatmentId, instrumentId, toolKey }) {
  if (!sourceActor?.isOwner && !game.user?.isGM) {
    ui.notifications.warn(`Нет прав на использование инструментов ${sourceActor?.name ?? ""}.`);
    return undefined;
  }
  const resolution = await applyTreatmentToTarget(targetContext, {
    sourceActor,
    sourceToken,
    targetToken,
    treatmentType,
    treatmentId,
    instrumentId,
    toolKey
  });
  if (!resolution) return undefined;

  const {
    targetContext: updatedTargetContext,
    treatment,
    instrument,
    initialProgress,
    finalProgress,
    maxProgress,
    spentCharges,
    entries = [],
    completed,
    reason = "",
    alreadyHealed = false
  } = resolution;
  if (alreadyHealed) {
    await postMedicineChat(sourceActor, {
      title: "Медицина",
      tone: "success",
      lines: [`"${treatment?.name ?? "Цель лечения"}" уже вылечено.`]
    });
    return { targetContext: updatedTargetContext ?? targetContext };
  }
  if (!entries.length) {
    await postMedicineChat(sourceActor, {
      title: `Лечение: ${treatment?.name ?? "цель"}`,
      tone: "failure",
      lines: [reason || "Лечение не выполнено."]
    });
    return undefined;
  }

  await postTreatmentResultChat(sourceActor, {
    treatment,
    instrument,
    initialProgress,
    finalProgress,
    maxProgress,
    spentCharges,
    entries,
    completed
  });
  return { targetContext: updatedTargetContext };
}

async function performMassTreatment({
  sourceActor,
  sourceToken = null,
  targetContext,
  targetToken = null,
  toolKey = "medical",
  options = {},
  requestId = ""
} = {}) {
  if (!sourceActor?.isOwner && !game.user?.isGM) {
    ui.notifications.warn(`Нет прав на использование инструментов ${sourceActor?.name ?? ""}.`);
    return undefined;
  }
  const resolution = await applyMassTreatmentToTarget(targetContext, {
    sourceActor,
    sourceToken,
    targetToken,
    toolKey,
    options,
    requestId
  });
  if (!resolution) return undefined;
  if (resolution.pending) return resolution;
  await postMassTreatmentChat(sourceActor, resolution.summary);
  return resolution;
}

async function applyMassTreatmentToTarget(targetContext, {
  sourceActor,
  sourceToken = null,
  targetToken = null,
  toolKey = "medical",
  options = {},
  requestId = ""
} = {}) {
  const actorUuid = String(targetContext?.actorUuid ?? "");
  const sourceActorUuid = String(sourceActor?.uuid ?? "");
  if (!actorUuid || !sourceActorUuid) {
    ui.notifications.warn("Не удалось определить цель массового лечения.");
    return null;
  }
  const normalizedOptions = normalizeMassTreatmentOptions(options);
  const stableRequestId = String(requestId ?? "").trim();
  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("Нет активного GM для массового лечения.");
    return null;
  }
  if (isCurrentResponsibleGM(gm)) {
    try {
      const actor = targetToken?.actor ?? await fromUuid(actorUuid);
      if (!actor || String(actor.uuid ?? "") !== actorUuid) {
        throw new Error("цель массового лечения не найдена");
      }
      return await resolveMassTreatmentOnAuthority({
        sourceActor,
        sourceToken,
        targetActor: actor,
        targetToken,
        toolKey,
        options: normalizedOptions,
        operationId: stableRequestId
          ? `medicine-mass-treatment:${game.user?.id ?? "local"}:${stableRequestId}`
          : `medicine-mass-treatment:${foundry.utils.randomID()}`
      });
    } catch (error) {
      console.error(`${SYSTEM_ID} | Medicine local mass treatment failed`, error);
      ui.notifications.error(`Не удалось выполнить массовое лечение: ${error.message}`);
      return null;
    }
  }

  try {
    const result = await requestMedicineSocket("performMassTreatment", {
      actorUuid,
      sourceActorUuid,
      sourceTokenUuid: getMedicineTokenUuid(sourceToken),
      targetTokenUuid: getMedicineTokenUuid(targetToken),
      toolKey,
      options: normalizedOptions
    }, gm, { requestId: stableRequestId });
    return result?.resolution ?? null;
  } catch (error) {
    console.error(`${SYSTEM_ID} | Medicine mass treatment socket failed`, error);
    if (error?.code === "authority-timeout") {
      ui.notifications.warn("GM продолжает массовое лечение. Повторное нажатие будет ожидать ту же операцию.");
      return { pending: true, requestId: stableRequestId };
    }
    ui.notifications.error(`Не удалось выполнить массовое лечение: ${error.message}`);
    return null;
  }
}

async function resolveMassTreatmentOnAuthority(args = {}) {
  const operationId = String(args.operationId ?? "").trim()
    || `medicine-mass-treatment:${foundry.utils.randomID()}`;
  const sourceToken = args.sourceToken?.document ?? args.sourceToken ?? null;
  const targetToken = args.targetToken?.document ?? args.targetToken ?? null;
  assertMedicineTokenMatchesActor(sourceToken, args.sourceActor);
  assertMedicineTokenMatchesActor(targetToken, args.targetActor);
  return resolveMassTreatmentOnAuthorityOperation({
    ...args,
    sourceToken,
    targetToken,
    operationId
  });
}

async function resolveMassTreatmentOnAuthorityOperation({
  sourceActor,
  sourceToken = null,
  targetActor,
  targetToken = null,
  toolKey = "medical",
  options = {},
  operationId = `medicine-mass-treatment:${foundry.utils.randomID()}`
} = {}) {
  if (!sourceActor || !targetActor) throw new Error("участники массового лечения не найдены");
  const normalizedToolKey = validateConfiguredMedicineToolKey(toolKey);

  const normalizedOptions = normalizeMassTreatmentOptions(options);
  if (!normalizedOptions.includeTraumas && !normalizedOptions.includeLimbHealth) {
    throw new Error("Выберите хотя бы один вид массового лечения.");
  }
  if (!normalizedOptions.allowedToolGroupKeys.length) {
    throw new Error("Выберите хотя бы одну группу медицинских инструментов.");
  }

  const initialContext = buildTargetContext(targetActor, targetToken);
  if (!canActorReceiveHealing(targetActor)) {
    return {
      targetContext: initialContext,
      summary: createEmptyMassTreatmentSummary(initialContext, normalizedOptions, {
        stopped: true,
        reason: "Цель сейчас не может получать лечение."
      })
    };
  }
  const availability = getMassTreatmentAvailability(
    sourceActor,
    initialContext,
    normalizedToolKey,
    normalizedOptions
  );
  if (!availability.ok) throw new Error(availability.message);

  const result = await runSequentialMassTreatment({
    initialContext,
    options: normalizedOptions,
    chooseInstrument: ({ treatment, options: currentOptions }) => chooseBestTreatmentInstrument(
      sourceActor,
      treatment,
      normalizedToolKey,
      currentOptions
    ),
    resolveTreatment: async ({ treatmentType, treatmentId, instrumentId, step }) => {
      try {
        return await resolveTreatmentOnAuthority({
          sourceActor,
          sourceToken,
          targetActor,
          targetToken,
          treatmentType,
          treatmentId,
          instrumentId,
          toolKey: normalizedToolKey,
          operationId: `${operationId}:step:${step}`
        });
      } catch (error) {
        console.error(`${SYSTEM_ID} | Medicine mass treatment step failed`, error);
        return createFailedMassTreatmentReceipt({
          targetActor,
          targetToken,
          treatmentType,
          treatmentId,
          operationId: `${operationId}:step:${step}`,
          reason: error.message
        });
      }
    }
  });
  return {
    targetContext: buildTargetContext(targetActor, targetToken),
    summary: result.summary
  };
}

function createEmptyMassTreatmentSummary(targetContext, options, { stopped = false, reason = "" } = {}) {
  const normalized = normalizeMassTreatmentOptions(options);
  const counts = getMassTreatmentTargetCounts(targetContext);
  return {
    targetName: String(targetContext?.name ?? ""),
    requestedTraumas: normalized.includeTraumas ? counts.traumas : 0,
    requestedLimbHealth: normalized.includeLimbHealth ? counts.limbHealth : 0,
    attempted: 0,
    completedTraumas: 0,
    completedLimbs: 0,
    restoredTraumaProgress: 0,
    restoredLimbHealth: 0,
    charges: 0,
    skipped: 0,
    stopped: Boolean(stopped),
    reasons: reason ? [String(reason)] : []
  };
}

function createFailedMassTreatmentReceipt({
  targetActor,
  targetToken = null,
  treatmentType = "trauma",
  treatmentId = "",
  operationId = "",
  reason = "Лечение не выполнено."
} = {}) {
  const targetContext = buildTargetContext(targetActor, targetToken);
  const treatment = getTargetTreatments(targetContext, treatmentType)
    .find(entry => entry.id === String(treatmentId ?? "")) ?? null;
  const maxProgress = Math.max(1, toInteger(treatment?.healingProgressMax));
  const initialProgress = Math.min(maxProgress, Math.max(0, toInteger(treatment?.healingProgress)));
  return {
    version: 1,
    status: "failed",
    operationId,
    targetContext,
    treatment,
    initialProgress,
    finalProgress: initialProgress,
    maxProgress,
    spentCharges: 0,
    entries: [],
    completed: initialProgress >= maxProgress,
    reason: String(reason || "Лечение не выполнено.")
  };
}

async function performImplantInstallation({ sourceActor, sourceToken = null, targetContext, targetToken = null, limbKey = "", implantSource = "", itemId = "" } = {}) {
  if (!sourceActor?.isOwner && !game.user?.isGM) {
    ui.notifications.warn(`Нет прав на использование инвентаря ${sourceActor?.name ?? ""}.`);
    return undefined;
  }
  const targetActorUuid = String(targetContext?.actorUuid ?? "");
  if (!targetActorUuid || !limbKey || !itemId) return undefined;
  const resolution = await requestImplantInstallation({
    sourceActor,
    sourceToken,
    targetActorUuid,
    targetToken,
    limbKey,
    implantSource,
    itemId
  });
  if (!resolution || resolution.cancelled) return undefined;

  const title = `Установка импланта: ${resolution.itemName ?? "имплант"}`;
  if (resolution.resultKey === "criticalFailure") {
    await postMedicineChat(sourceActor, {
      title,
      tone: "failure",
      lines: [resolution.criticalDamage > 0
        ? `Критический провал. Имплант повреждён на ${resolution.criticalDamage} и не установлен.`
        : "Критический провал. Имплант не установлен."]
    });
    return { targetContext: resolution.targetContext ?? targetContext };
  }
  if (!isSuccessfulSkillResult(resolution.resultKey)) {
    await postMedicineChat(sourceActor, {
      title,
      tone: "failure",
      lines: [resolution.reason || "Проверка провалена. Имплант не установлен."]
    });
    return { targetContext: resolution.targetContext ?? targetContext };
  }

  await postMedicineChat(sourceActor, {
    title,
    tone: "success",
    lines: [`${resolution.targetName ?? targetContext?.name ?? "Цель"}: ${resolution.limbLabel ?? getTargetLimbLabel(targetContext, limbKey)} получила имплант.`]
  });
  return { targetContext: resolution.targetContext ?? targetContext };
}

async function requestImplantInstallation({
  sourceActor,
  sourceToken = null,
  targetActorUuid = "",
  targetToken = null,
  limbKey = "",
  implantSource = "",
  itemId = ""
} = {}) {
  const targetActor = targetToken?.actor ?? await fromUuid(targetActorUuid);
  if (
    targetActor
    && String(targetActor.uuid ?? "") === String(targetActorUuid)
    && canUseActorLocally(targetActor)
    && canUseActorLocally(sourceActor)
  ) {
    return resolveImplantInstallationOnAuthority({
      sourceActor,
      sourceToken,
      targetActor,
      targetToken,
      limbKey,
      implantSource,
      itemId
    });
  }
  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("Нет активного GM для установки импланта.");
    return null;
  }
  try {
    const result = await requestMedicineSocket("performImplantInstallation", {
      actorUuid: targetActorUuid,
      sourceActorUuid: sourceActor?.uuid ?? "",
      sourceTokenUuid: getMedicineTokenUuid(sourceToken),
      targetTokenUuid: getMedicineTokenUuid(targetToken),
      limbKey,
      implantSource,
      itemId
    }, gm);
    return result?.resolution ?? null;
  } catch (error) {
    console.error(`${SYSTEM_ID} | Medicine implant socket failed`, error);
    ui.notifications.error(`Не удалось выполнить установку импланта: ${error.message}`);
    return null;
  }
}

async function resolveImplantInstallationOnAuthority(args = {}) {
  return runWithMedicineAuthorityLocks(
    [args.sourceActor, args.targetActor],
    () => resolveImplantInstallationOnAuthorityLocked(args)
  );
}

async function resolveImplantInstallationOnAuthorityLocked({
  sourceActor,
  sourceToken = null,
  targetActor,
  targetToken = null,
  limbKey = "",
  implantSource = "",
  itemId = ""
} = {}) {
  if (!sourceActor || !targetActor) throw new Error("участники установки импланта не найдены");
  if (!["source", "target"].includes(implantSource)) throw new Error("некорректный источник импланта");

  const targetContext = buildTargetContext(targetActor, targetToken);
  const targetLimb = targetContext.limbs.find(limb => limb.key === limbKey);
  if (!targetLimb) throw new Error("часть тела для установки импланта не найдена");
  const implantLimit = Math.max(0, toInteger(targetLimb.implantLimit));
  if ((targetLimb.implants ?? []).length >= implantLimit) {
    throw new Error("на выбранной части тела нет свободного места для импланта");
  }

  const sourceContainer = implantSource === "source" ? sourceActor : targetActor;
  const implant = sourceContainer.items?.get(String(itemId ?? ""));
  if (!implant || implant.type !== "gear" || !isImplantForLimb(implant, limbKey)) {
    throw new Error("имплант не найден или не подходит к выбранной части тела");
  }
  if (!isImplantItemInstallable(implant)) throw new Error("сломанный имплант нельзя установить");

  const data = getImplantFunction(implant);
  const skillKey = String(data.skillKey ?? "doctor") || "doctor";
  const difficulty = Math.max(0, toInteger(data.difficulty ?? 60));
  const skillResolution = await resolveMedicineSkillAction(sourceActor, {
    skillKey,
    difficulty,
    thresholdMode: isSkillThresholdMode(getMedicineResolutionMode())
  }, {
    requestCheck: () => requestSkillCheck({
      actor: sourceActor,
      skillKey,
      data: {
        difficulty,
        actorToken: sourceToken?.object ?? sourceToken,
        targetActor,
        targetToken: targetToken?.object ?? targetToken,
        allowImplicitTarget: false
      },
      animate: false,
      createMessage: true,
      prompt: false,
      requester: "medicineImplant"
    })
  });
  if (!skillResolution.met) {
    return {
      targetContext,
      resultKey: "failure",
      itemName: implant.name,
      targetName: targetContext.name,
      limbLabel: targetLimb.label,
      criticalDamage: 0,
      reason: getMedicineInstallationSkillThresholdMessage(
        skillResolution,
        "импланта",
        implant.name
      )
    };
  }
  const outcome = skillResolution.outcome;
  if (!outcome) return { targetContext, cancelled: true };

  const resultKey = String(outcome.result?.key ?? "failure");
  let updatedTargetContext = targetContext;
  let criticalDamage = 0;
  if (resultKey === "criticalFailure") {
    const criticalResult = await applyImplantCriticalFailureLocally({
      sourceActor,
      targetActor,
      limbKey,
      implantSource,
      itemId
    });
    criticalDamage = criticalResult.appliedDamage;
    updatedTargetContext = buildTargetContext(targetActor, targetToken);
  } else if (isSuccessfulSkillResult(resultKey)) {
    await applyImplantInstallLocally({
      sourceActor,
      targetActor,
      limbKey,
      implantSource,
      itemId
    });
    updatedTargetContext = buildTargetContext(targetActor, targetToken);
  }
  return {
    targetContext: updatedTargetContext,
    resultKey,
    itemName: implant.name,
    targetName: targetContext.name,
    limbLabel: targetLimb.label,
    criticalDamage
  };
}

async function applyImplantRemoval({ sourceActor, targetContext, targetToken = null, limbKey = "", itemId = "" } = {}) {
  const targetActorUuid = String(targetContext?.actorUuid ?? "");
  const targetActor = targetToken?.actor ?? await fromUuid(targetActorUuid);
  const sourceActorUuid = sourceActor?.uuid ?? "";
  const sourceActorDocument = sourceActorUuid ? await fromUuid(sourceActorUuid) : sourceActor;
  if (
    targetActor
    && String(targetActor.uuid ?? "") === targetActorUuid
    && sourceActorDocument
    && canUseActorLocally(targetActor)
    && canUseActorLocally(sourceActorDocument)
  ) {
    return runWithMedicineAuthorityLocks(
      [sourceActorDocument, targetActor],
      () => applyImplantRemovalLocally({ sourceActor: sourceActorDocument, targetActor, targetToken, limbKey, itemId })
    );
  }
  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("Нет активного GM для снятия импланта.");
    return null;
  }
  const result = await requestMedicineSocket("removeImplant", {
    sourceActorUuid,
    targetActorUuid,
    targetTokenUuid: getMedicineTokenUuid(targetToken),
    limbKey,
    itemId
  }, gm);
  return result?.targetContext ?? null;
}

async function applyImplantInstallLocally({ sourceActor, targetActor, limbKey = "", implantSource = "", itemId = "" } = {}) {
  const sourceContainer = implantSource === "source" ? sourceActor : targetActor;
  const item = sourceContainer?.items?.get(itemId);
  if (!item || item.type !== "gear" || !isImplantForLimb(item, limbKey)) {
    throw createTreatmentStaleError("Имплант изменился или больше не доступен.");
  }
  if (!isImplantItemInstallable(item)) {
    throw createTreatmentStaleError("Имплант сломан до завершения установки.");
  }

  const implantLimit = getActorLimbImplantLimit(targetActor, limbKey);
  const installedBefore = getInstalledTargetImplants(targetActor, limbKey).length;
  if (installedBefore >= implantLimit) {
    throw createTreatmentStaleError("Свободное место для импланта уже занято.");
  }
  if (sourceContainer?.uuid !== targetActor.uuid && isContainerItem(item)) {
    await transferItemBetweenActors({
      sourceActor: sourceContainer,
      targetActor,
      sourceItem: item,
      targetMode: "implant",
      targetConstructPartSlot: limbKey,
      quantity: 1,
      allowLocked: true,
      spendWeaponSwitchCost: false
    });
    if (getInstalledTargetImplants(targetActor, limbKey).length <= installedBefore) {
      throw new Error("Foundry не подтвердил установку импланта.");
    }
    return true;
  }

  const quantity = Math.max(1, toInteger(item.system?.quantity) || 1);
  if (sourceContainer?.uuid === targetActor.uuid && quantity <= 1) {
    await executeInventoryMutation({
      actor: targetActor,
      updates: [createInstallImplantUpdate(item, limbKey)]
    }, { reason: "implant-install" });
  } else {
    const sourcePlan = createSingleInventoryItemConsumptionPlan(sourceContainer, item);
    await executeInventoryMutation([
      {
        actor: sourceContainer,
        updates: sourcePlan.updates,
        deletes: sourcePlan.deletes
      },
      {
        actor: targetActor,
        creates: [createImplantItemData(item, limbKey)]
      }
    ], { reason: "implant-install" });
  }

  if (getInstalledTargetImplants(targetActor, limbKey).length <= installedBefore) {
    throw new Error("Foundry не подтвердил установку импланта.");
  }
  return true;
}

async function applyImplantRemovalLocally({ sourceActor, targetActor, targetToken = null, limbKey = "", itemId = "" } = {}) {
  const item = targetActor?.items?.get(itemId);
  if (
    !item
    || item.type !== "gear"
    || String(item.system?.placement?.mode ?? "") !== "implant"
    || String(item.system?.placement?.limbKey ?? "") !== limbKey
  ) throw createTreatmentStaleError("Установленный имплант изменился или уже снят.");

  const receivingActor = sourceActor && sourceActor.uuid !== targetActor.uuid ? sourceActor : targetActor;
  const returnPlan = planActorInventoryGrant(receivingActor, createReturnedImplantItemData(item), {
    quantity: 1,
    merge: false
  });
  if (!returnPlan) throw new Error("В инвентаре получателя нет места для снятого импланта.");
  await executeInventoryMutation([
    {
      actor: receivingActor,
      updates: returnPlan.updates,
      creates: returnPlan.creates
    },
    {
      actor: targetActor,
      deletes: [item.id]
    }
  ], { reason: "implant-remove" });
  return buildTargetContext(targetActor, targetToken);
}

async function applyImplantCriticalFailureLocally({ sourceActor, targetActor, limbKey = "", implantSource = "", itemId = "" } = {}) {
  const sourceContainer = implantSource === "source" ? sourceActor : targetActor;
  const item = sourceContainer?.items?.get(itemId);
  if (!item || item.type !== "gear" || !isImplantForLimb(item, limbKey)) {
    throw createTreatmentStaleError("Имплант изменился до применения критического провала.");
  }

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
  return {
    appliedDamage: applied
  };
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
    "system.stackParts": [],
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
  foundry.utils.setProperty(itemData, "system.stackParts", []);
  return itemData;
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
  foundry.utils.setProperty(itemData, "system.stackParts", []);
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

async function performProsthesisInstallation({ sourceActor, sourceToken = null, targetContext, targetToken = null, limbKey = "", prosthesisSource = "", itemId = "" } = {}) {
  if (!sourceActor?.isOwner && !game.user?.isGM) {
    ui.notifications.warn(`Нет прав на использование инвентаря ${sourceActor?.name ?? ""}.`);
    return undefined;
  }
  const targetActorUuid = String(targetContext?.actorUuid ?? "");
  if (!targetActorUuid || !limbKey || !itemId) return undefined;
  const resolution = await requestProsthesisInstallation({
    sourceActor,
    sourceToken,
    targetActorUuid,
    targetToken,
    limbKey,
    prosthesisSource,
    itemId
  });
  if (!resolution || resolution.cancelled) return undefined;

  const title = `Установка протеза: ${resolution.itemName ?? "протез"}`;
  if (resolution.resultKey === "criticalFailure") {
    await postMedicineChat(sourceActor, {
      title,
      tone: "failure",
      lines: [resolution.criticalDamage > 0
        ? `Критический провал. Протез повреждён на ${resolution.criticalDamage} и не установлен.`
        : "Критический провал. Протез не установлен."]
    });
    return { targetContext: resolution.targetContext ?? targetContext };
  }
  if (!isSuccessfulSkillResult(resolution.resultKey)) {
    await postMedicineChat(sourceActor, {
      title,
      tone: "failure",
      lines: [resolution.reason || "Проверка провалена. Протез не установлен."]
    });
    return { targetContext: resolution.targetContext ?? targetContext };
  }

  await postMedicineChat(sourceActor, {
    title,
    tone: "success",
    lines: [`${resolution.targetName ?? targetContext?.name ?? "Цель"}: ${resolution.limbLabel ?? getTargetLimbLabel(targetContext, limbKey)} заменена протезом.`]
  });
  return { targetContext: resolution.targetContext ?? targetContext };
}

async function requestProsthesisInstallation({
  sourceActor,
  sourceToken = null,
  targetActorUuid = "",
  targetToken = null,
  limbKey = "",
  prosthesisSource = "",
  itemId = ""
} = {}) {
  const targetActor = targetToken?.actor ?? await fromUuid(targetActorUuid);
  if (
    targetActor
    && String(targetActor.uuid ?? "") === String(targetActorUuid)
    && canUseActorLocally(targetActor)
    && canUseActorLocally(sourceActor)
  ) {
    return resolveProsthesisInstallationOnAuthority({
      sourceActor,
      sourceToken,
      targetActor,
      targetToken,
      limbKey,
      prosthesisSource,
      itemId
    });
  }
  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("Нет активного GM для установки протеза.");
    return null;
  }
  try {
    const result = await requestMedicineSocket("performProsthesisInstallation", {
      actorUuid: targetActorUuid,
      sourceActorUuid: sourceActor?.uuid ?? "",
      sourceTokenUuid: getMedicineTokenUuid(sourceToken),
      targetTokenUuid: getMedicineTokenUuid(targetToken),
      limbKey,
      prosthesisSource,
      itemId
    }, gm);
    return result?.resolution ?? null;
  } catch (error) {
    console.error(`${SYSTEM_ID} | Medicine prosthesis socket failed`, error);
    ui.notifications.error(`Не удалось выполнить установку протеза: ${error.message}`);
    return null;
  }
}

async function resolveProsthesisInstallationOnAuthority(args = {}) {
  return runWithMedicineAuthorityLocks(
    [args.sourceActor, args.targetActor],
    () => resolveProsthesisInstallationOnAuthorityLocked(args)
  );
}

async function resolveProsthesisInstallationOnAuthorityLocked({
  sourceActor,
  sourceToken = null,
  targetActor,
  targetToken = null,
  limbKey = "",
  prosthesisSource = "",
  itemId = ""
} = {}) {
  if (!sourceActor || !targetActor) throw new Error("участники установки протеза не найдены");
  if (!["source", "target"].includes(prosthesisSource)) throw new Error("некорректный источник протеза");

  const targetContext = buildTargetContext(targetActor, targetToken);
  const targetLimb = targetContext.limbs.find(limb => limb.key === limbKey);
  if (!targetLimb) throw new Error("часть тела для установки протеза не найдена");
  if (!targetLimb.missing || targetLimb.prosthesis) {
    throw new Error("протез можно установить только на отсутствующую свободную часть тела");
  }

  const sourceContainer = prosthesisSource === "source" ? sourceActor : targetActor;
  const prosthesis = sourceContainer.items?.get(String(itemId ?? ""));
  if (!prosthesis || prosthesis.type !== "gear" || !isProsthesisForLimb(prosthesis, limbKey)) {
    throw new Error("протез не найден или не подходит к выбранной части тела");
  }
  if (!isProsthesisItemInstallable(prosthesis)) throw new Error("сломанный протез нельзя установить");

  const data = getProsthesisFunction(prosthesis);
  const skillKey = String(data.skillKey ?? "doctor") || "doctor";
  const difficulty = Math.max(0, toInteger(data.difficulty ?? 60));
  const skillResolution = await resolveMedicineSkillAction(sourceActor, {
    skillKey,
    difficulty,
    thresholdMode: isSkillThresholdMode(getMedicineResolutionMode())
  }, {
    requestCheck: () => requestSkillCheck({
      actor: sourceActor,
      skillKey,
      data: {
        difficulty,
        actorToken: sourceToken?.object ?? sourceToken,
        targetActor,
        targetToken: targetToken?.object ?? targetToken,
        allowImplicitTarget: false
      },
      animate: false,
      createMessage: true,
      prompt: false,
      requester: "medicineProsthesis"
    })
  });
  if (!skillResolution.met) {
    return {
      targetContext,
      resultKey: "failure",
      itemName: prosthesis.name,
      targetName: targetContext.name,
      limbLabel: targetLimb.label,
      criticalDamage: 0,
      reason: getMedicineInstallationSkillThresholdMessage(
        skillResolution,
        "протеза",
        prosthesis.name
      )
    };
  }
  const outcome = skillResolution.outcome;
  if (!outcome) return { targetContext, cancelled: true };

  const resultKey = String(outcome.result?.key ?? "failure");
  let updatedTargetContext = targetContext;
  let criticalDamage = 0;
  if (resultKey === "criticalFailure") {
    const criticalResult = await applyProsthesisCriticalFailureLocally({
      sourceActor,
      targetActor,
      limbKey,
      prosthesisSource,
      itemId
    });
    criticalDamage = criticalResult.appliedDamage;
    updatedTargetContext = buildTargetContext(targetActor, targetToken);
  } else if (isSuccessfulSkillResult(resultKey)) {
    await applyProsthesisInstallLocally({
      sourceActor,
      targetActor,
      limbKey,
      prosthesisSource,
      itemId
    });
    updatedTargetContext = buildTargetContext(targetActor, targetToken);
  }
  return {
    targetContext: updatedTargetContext,
    resultKey,
    itemName: prosthesis.name,
    targetName: targetContext.name,
    limbLabel: targetLimb.label,
    criticalDamage
  };
}

async function applyProsthesisRemoval({ sourceActor, targetContext, targetToken = null, limbKey = "", itemId = "" } = {}) {
  const targetActorUuid = String(targetContext?.actorUuid ?? "");
  const targetActor = targetToken?.actor ?? await fromUuid(targetActorUuid);
  const sourceActorUuid = sourceActor?.uuid ?? "";
  const sourceActorDocument = sourceActorUuid ? await fromUuid(sourceActorUuid) : sourceActor;
  if (
    targetActor
    && String(targetActor.uuid ?? "") === targetActorUuid
    && sourceActorDocument
    && canUseActorLocally(targetActor)
    && canUseActorLocally(sourceActorDocument)
  ) {
    return runWithMedicineAuthorityLocks(
      [sourceActorDocument, targetActor],
      () => applyProsthesisRemovalLocally({ sourceActor: sourceActorDocument, targetActor, targetToken, limbKey, itemId })
    );
  }
  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("Нет активного GM для снятия протеза.");
    return null;
  }
  const result = await requestMedicineSocket("removeProsthesis", {
    sourceActorUuid,
    targetActorUuid,
    targetTokenUuid: getMedicineTokenUuid(targetToken),
    limbKey,
    itemId
  }, gm);
  return result?.targetContext ?? null;
}

async function applyProsthesisInstallLocally({ sourceActor, targetActor, limbKey = "", prosthesisSource = "", itemId = "" } = {}) {
  const sourceContainer = prosthesisSource === "source" ? sourceActor : targetActor;
  const item = sourceContainer?.items?.get(itemId);
  if (!item || item.type !== "gear" || !isProsthesisForLimb(item, limbKey)) {
    throw createTreatmentStaleError("Протез изменился или больше не доступен.");
  }
  if (!isProsthesisItemInstallable(item)) {
    throw createTreatmentStaleError("Протез сломан до завершения установки.");
  }

  if (!targetActor?.system?.limbs?.[limbKey]?.missing) {
    throw createTreatmentStaleError("Часть тела больше не отсутствует.");
  }
  const existing = getInstalledTargetProsthesis(targetActor, limbKey);
  if (existing) throw createTreatmentStaleError("На части тела уже установлен протез.");
  if (sourceContainer?.uuid !== targetActor.uuid && isContainerItem(item)) {
    await transferItemBetweenActors({
      sourceActor: sourceContainer,
      targetActor,
      sourceItem: item,
      targetMode: "prosthesis",
      targetConstructPartSlot: limbKey,
      quantity: 1,
      allowLocked: true,
      spendWeaponSwitchCost: false
    });
    await clearLimbLossState(targetActor, limbKey);
    await setLimbMissingState(targetActor, limbKey);
    if (!getInstalledTargetProsthesis(targetActor, limbKey)) {
      throw new Error("Foundry не подтвердил установку протеза.");
    }
    return true;
  }
  const quantity = Math.max(1, toInteger(item.system?.quantity) || 1);
  const targetUpdates = [];
  const targetDeletes = [];
  const targetCreates = [];
  const mutationPlans = [];

  if (sourceContainer?.uuid === targetActor.uuid && quantity <= 1) {
    targetUpdates.push(createInstallProsthesisUpdate(item, limbKey));
  } else {
    const sourcePlan = createSingleInventoryItemConsumptionPlan(sourceContainer, item);
    mutationPlans.push({
      actor: sourceContainer,
      updates: sourcePlan.updates,
      deletes: sourcePlan.deletes
    });
    targetCreates.push(createProsthesisItemData(item, limbKey));
  }
  mutationPlans.push({
    actor: targetActor,
    updates: targetUpdates,
    deletes: targetDeletes,
    creates: targetCreates
  });
  await executeInventoryMutation(mutationPlans, { reason: "prosthesis-install" });

  await clearLimbLossState(targetActor, limbKey);
  await setLimbMissingState(targetActor, limbKey);
  if (!getInstalledTargetProsthesis(targetActor, limbKey)) {
    throw new Error("Foundry не подтвердил установку протеза.");
  }
  return true;
}

async function applyProsthesisRemovalLocally({ sourceActor, targetActor, targetToken = null, limbKey = "", itemId = "" } = {}) {
  const item = targetActor?.items?.get(itemId);
  if (
    !item
    || item.type !== "gear"
    || String(item.system?.placement?.mode ?? "") !== "prosthesis"
    || String(item.system?.placement?.limbKey ?? "") !== limbKey
  ) throw createTreatmentStaleError("Установленный протез изменился или уже снят.");

  const receivingActor = sourceActor && sourceActor.uuid !== targetActor.uuid ? sourceActor : targetActor;
  const returnPlan = planActorInventoryGrant(receivingActor, createReturnedProsthesisItemData(item), {
    quantity: 1,
    merge: false
  });
  if (!returnPlan) throw new Error("В инвентаре получателя нет места для снятого протеза.");
  await executeInventoryMutation([
    {
      actor: receivingActor,
      updates: returnPlan.updates,
      creates: returnPlan.creates
    },
    {
      actor: targetActor,
      deletes: [item.id]
    }
  ], { reason: "prosthesis-remove" });
  await setLimbMissingState(targetActor, limbKey);
  await applyDestroyedLimbConsequences(targetActor, [limbKey], { ignoreInstalledProsthesis: true });
  return buildTargetContext(targetActor, targetToken);
}

async function applyProsthesisCriticalFailureLocally({ sourceActor, targetActor, limbKey = "", prosthesisSource = "", itemId = "" } = {}) {
  const sourceContainer = prosthesisSource === "source" ? sourceActor : targetActor;
  const item = sourceContainer?.items?.get(itemId);
  if (!item || item.type !== "gear" || !isProsthesisForLimb(item, limbKey)) {
    throw createTreatmentStaleError("Протез изменился до применения критического провала.");
  }

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
  return {
    appliedDamage: applied
  };
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
    "system.stackParts": [],
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
  foundry.utils.setProperty(itemData, "system.stackParts", []);
  return itemData;
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
  foundry.utils.setProperty(itemData, "system.stackParts", []);
  return itemData;
}

function createSingleInventoryItemConsumptionPlan(actor, item) {
  const quantity = Math.max(1, toInteger(item?.system?.quantity) || 1);
  if (quantity <= 1) return { updates: [], deletes: [item.id] };
  if (!usesVirtualInventoryStacks(item)) {
    return {
      updates: [{ _id: item.id, "system.quantity": quantity - 1 }],
      deletes: []
    };
  }

  const update = createItemStackPartRemovalUpdate(item, 1, 0);
  if (!update) {
    throw new Error(game.i18n.localize("FALLOUTMAW.Messages.InventoryInvalid"));
  }
  return (update["system.quantity"] ?? 0) > 0
    ? { updates: [update], deletes: [] }
    : { updates: [], deletes: [item.id] };
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

async function runTreatmentChecks({
  sourceActor,
  sourceToken = null,
  targetContext = null,
  targetToken = null,
  treatment,
  tool,
  initialProgress,
  maxProgress,
  operationId = `medicine-treatment:${foundry.utils.randomID()}`,
  chainRef = null,
  medicineMode = getMedicineResolutionMode()
}) {
  const skillKey = String(treatment.healingSkillKey ?? "");
  const difficulty = Math.max(1, toInteger(treatment.healingDifficulty));
  const skillOptions = {
    skillKey,
    difficulty,
    thresholdMode: isSkillThresholdMode(medicineMode)
  };
  const skillResolution = evaluateMedicineSkillResolution(sourceActor, skillOptions);
  if (!skillResolution.met) {
    return {
      entries: [],
      spentCharges: 0,
      remainingCharges: toInteger(tool.resourceValue),
      finalProgress: initialProgress,
      halted: false,
      reason: getMedicineSkillThresholdMessage(skillResolution, treatment?.name)
    };
  }
  const progressPerCheck = Math.max(1, Math.ceil(maxProgress * TREATMENT_PROGRESS_STEP_RATIO));
  const missingProgress = Math.max(0, maxProgress - initialProgress);
  const totalChecks = Math.max(1, Math.ceil(missingProgress / progressPerCheck));
  let currentProgress = initialProgress;
  let availableCharges = toInteger(tool.resourceValue);
  let spentCharges = 0;
  const entries = [];
  const targetActor = targetToken?.actor ?? (String(targetContext?.actorUuid ?? "")
    ? await fromUuid(String(targetContext.actorUuid))
    : null);

  for (let index = 1; index <= totalChecks; index += 1) {
    const remainingProgress = Math.max(0, maxProgress - currentProgress);
    if (!remainingProgress) break;
    if (availableCharges <= 0) break;

    const progressForCheck = Math.min(progressPerCheck, remainingProgress);
    const checkOperationId = `${operationId}:check:${index}`;
    const resolvedSkill = await resolveMedicineSkillAction(sourceActor, skillOptions, {
      requestCheck: () => requestSkillCheck({
        actor: sourceActor,
        skillKey,
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
        requester: "medicine",
        options: { operationId: checkOperationId }
      })
    });
    const outcome = resolvedSkill.outcome;
    const resultLabel = resolvedSkill.usesThreshold
      ? resolvedSkill.resultLabel
      : getTreatmentResultLabel(outcome?.result?.key);
    if (!outcome) {
      return {
        entries,
        spentCharges,
        remainingCharges: availableCharges,
        finalProgress: currentProgress,
        halted: true,
        reason: "Проверка навыка лечения не выполнена."
      };
    }

    const healingOperationId = `${operationId}:healing:${index}`;
    const activeUsePreparations = prepareTreatmentHealingActiveUses({
      sourceActor,
      sourceToken,
      targetActor,
      targetToken,
      chanceOperationId: healingOperationId
    });
    const treatmentResult = calculateTreatmentResult({
      treatmentTarget: treatment,
      tool,
      availableCharges,
      progressForCheck,
      missingProgress: remainingProgress,
      resultKey: String(outcome.result?.key ?? "failure"),
      healingMultiplier: getTreatmentHealingMultiplier(sourceActor, targetActor, targetContext, {
        sourceToken,
        targetToken,
        chanceOperationId: healingOperationId
      })
    });
    if (treatmentResult.chargesUsed <= 0) break;

    if (activeUsePreparations.length) {
      try {
        await commitPreparedActiveUseOperations(activeUsePreparations, {
          operationId: healingOperationId
        });
      } catch (error) {
        console.error(`${SYSTEM_ID} | Medicine healing active-use commit failed`, error);
      }
    }

    availableCharges -= treatmentResult.chargesUsed;
    spentCharges += treatmentResult.chargesUsed;
    currentProgress = Math.min(maxProgress, currentProgress + treatmentResult.progress);
    entries.push({
      index,
      total: totalChecks,
      resultLabel,
      progress: treatmentResult.progress,
      charges: treatmentResult.chargesUsed,
      efficiency: treatmentResult.efficiency,
      currentProgress,
      resultKey: String(outcome.result?.key ?? "failure"),
      skillCheckMessageUuid: String(outcome.message?.uuid ?? "")
    });
  }

  return {
    entries,
    spentCharges,
    remainingCharges: availableCharges,
    finalProgress: currentProgress,
    halted: false,
    reason: availableCharges <= 0 ? "Запаса инструмента не хватило для лечения." : ""
  };
}

function validateInstrumentForTreatment(actor, treatment, tool) {
  if (treatment?.treatable === false) {
    return { ok: false, message: treatment.unavailableReason || "Эту цель сейчас нельзя лечить." };
  }
  if (!tool?.enabled) return { ok: false, message: "Инструмент не подходит для лечения." };
  if (toInteger(tool.resourceValue) <= 0) return { ok: false, message: "Ресурс инструмента исчерпан." };

  const requiredClass = String(treatment.healingToolClass ?? "D");
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

function calculateTreatmentResult({ treatmentTarget, tool, availableCharges, progressForCheck, missingProgress, resultKey, healingMultiplier = 1 }) {
  const targetProgress = Math.min(progressForCheck, missingProgress);
  let efficiency = calculateBaseEfficiency(tool.toolClass, treatmentTarget.healingToolClass);
  if (resultKey === "criticalSuccess") efficiency *= 1.5;
  else if (resultKey === "failure") efficiency *= 0.5;

  const chargesNeeded = Math.max(1, Math.ceil(targetProgress * (100 / Math.max(1, efficiency))));
  const chargesUsed = Math.min(chargesNeeded, availableCharges);
  const normalProgress = Math.max(0, Math.ceil(chargesUsed * (efficiency / 100)));
  const progressMultiplier = resultKey === "criticalSuccess" ? 2 : resultKey === "criticalFailure" ? 0.5 : 1;
  const progress = Math.min(missingProgress, Math.max(0, Math.floor(normalProgress * progressMultiplier * Math.max(0, Number(healingMultiplier) || 0))));
  return { progress, chargesUsed, efficiency };
}

function prepareTreatmentHealingActiveUses({
  sourceActor = null,
  sourceToken = null,
  targetActor = null,
  targetToken = null,
  chanceOperationId = ""
} = {}) {
  const sourcePreparation = prepareActiveUseOperation({
    kind: "medicineOutgoingHealing",
    actor: sourceActor,
    keys: getHealingResolutionActiveUseKeys({ direction: "outgoing" }),
    conditionContexts: [{
      actorToken: sourceToken?.object ?? sourceToken,
      targetActor,
      targetToken: targetToken?.object ?? targetToken,
      chanceOperationId
    }],
    reverseOnly: false
  });
  const targetPreparation = prepareActiveUseOperation({
    kind: "medicineIncomingHealing",
    actor: targetActor,
    keys: getHealingResolutionActiveUseKeys({ direction: "incoming" }),
    conditionContexts: [{
      actorToken: targetToken?.object ?? targetToken,
      targetActor: sourceActor,
      targetToken: sourceToken?.object ?? sourceToken,
      chanceOperationId
    }],
    reverseOnly: false
  });
  return [sourcePreparation, targetPreparation].filter(Boolean);
}

function getTreatmentHealingMultiplier(sourceActor, targetActor = null, targetContext = null, {
  sourceToken = null,
  targetToken = null,
  chanceOperationId = ""
} = {}) {
  const outgoing = Math.max(0, 1 + (getActorHealingModifierPercent(sourceActor, "outgoing", {
    actorToken: sourceToken?.object ?? sourceToken,
    targetActor,
    targetToken: targetToken?.object ?? targetToken,
    chanceOperationId
  }) / 100));
  const incomingPercent = targetActor
    ? getActorHealingModifierPercent(targetActor, "incoming", {
      actorToken: targetToken?.object ?? targetToken,
      targetActor: sourceActor,
      targetToken: sourceToken?.object ?? sourceToken,
      chanceOperationId
    })
    : toInteger(targetContext?.incomingHealingPercent);
  const incoming = Math.max(0, 1 + (incomingPercent / 100));
  return outgoing * incoming;
}

async function applyTreatmentToTarget(targetContext, {
  sourceActor,
  sourceToken = null,
  targetToken = null,
  treatmentType = "trauma",
  treatmentId,
  instrumentId,
  toolKey
}) {
  const actorUuid = String(targetContext?.actorUuid ?? "");
  const sourceActorUuid = String(sourceActor?.uuid ?? "");
  if (!actorUuid || !sourceActorUuid) {
    ui.notifications.warn("Не удалось определить цель лечения.");
    return null;
  }

  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("Нет активного GM для применения лечения.");
    return null;
  }
  if (isCurrentResponsibleGM(gm)) {
    try {
      const actor = targetToken?.actor ?? await fromUuid(actorUuid);
      if (!actor || String(actor.uuid ?? "") !== actorUuid) {
        throw new Error("цель лечения не найдена");
      }
      return await resolveTreatmentOnAuthority({
        sourceActor,
        sourceToken,
        targetActor: actor,
        targetToken,
        treatmentType,
        treatmentId,
        instrumentId,
        toolKey,
        operationId: `medicine-treatment:${foundry.utils.randomID()}`
      });
    } catch (error) {
      console.error(`${SYSTEM_ID} | Medicine local treatment failed`, error);
      ui.notifications.error(`Не удалось применить лечение: ${error.message}`);
      return null;
    }
  }

  try {
    const result = await requestMedicineSocket("performTreatment", {
      actorUuid,
      sourceActorUuid,
      sourceTokenUuid: getMedicineTokenUuid(sourceToken),
      targetTokenUuid: getMedicineTokenUuid(targetToken),
      treatmentType,
      treatmentId,
      instrumentId,
      toolKey
    }, gm);
    return result?.resolution ?? null;
  } catch (error) {
    console.error(`${SYSTEM_ID} | Medicine treatment socket failed`, error);
    ui.notifications.error(`Не удалось применить лечение: ${error.message}`);
    return null;
  }
}

async function resolveTreatmentOnAuthority(args = {}) {
  const operationId = String(args.operationId ?? "").trim()
    || `medicine-treatment:${foundry.utils.randomID()}`;
  const sourceToken = args.sourceToken?.document ?? args.sourceToken ?? null;
  const targetToken = args.targetToken?.document ?? args.targetToken ?? null;
  assertMedicineTokenMatchesActor(sourceToken, args.sourceActor);
  assertMedicineTokenMatchesActor(targetToken, args.targetActor);
  return withSystemEventRoot({
    kind: "medicineTreatment",
    operationId,
    sceneUuid: String(targetToken?.parent?.uuid ?? sourceToken?.parent?.uuid ?? ""),
    combatUuid: String(game.combat?.uuid ?? ""),
    chainRef: args.chainRef ?? null,
    data: { systemEventOperationId: operationId }
  }, scope => runWithMedicineAuthorityLocks(
    [args.sourceActor, args.targetActor],
    () => runMedicineTreatmentLifecycle({ ...args, operationId }, scope),
    scope.chainRef
  ));
}

async function runMedicineTreatmentLifecycle(args = {}, scope) {
  const occurrenceBase = `medicine-treatment:${scope.rootId}:${args.operationId}`;
  const participants = buildMedicineTreatmentParticipants(args);
  const workflow = await runTerminalSystemEventWorkflow({
    scope,
    beforeEventKey: "fallout-maw.medicine.treatment.before",
    resolvedEventKey: "fallout-maw.medicine.treatment.resolved",
    occurrenceBase,
    participants,
    beforeData: buildMedicineTreatmentEventData(args, { status: "pending" }),
    resolvedData: ({ value, status, reason }) => buildMedicineTreatmentEventData(args, {
      receipt: value,
      status,
      reason
    }),
    before: () => buildMedicineTreatmentStateSnapshot(args),
    after: () => buildMedicineTreatmentStateSnapshot(args),
    operation: () => resolveTreatmentOnAuthorityOperation({
      ...args,
      chainRef: scope.chainRef
    }),
    getResultStatus: result => getMedicineTreatmentTerminalStatus(result),
    getResultReason: (result, status) => String(result?.reason ?? "").trim()
      || (status === "success" ? String(result?.status ?? "committed") : status)
  });
  if (!workflow.cancelled) return workflow.value;
  return createCancelledMedicineTreatmentReceipt(args, workflow.reason);
}

function getMedicineTreatmentTerminalStatus(result = null) {
  const status = String(result?.status ?? "").trim();
  if (["committed", "alreadyComplete"].includes(status)) return "success";
  if (status === "cancelled") return "cancelled";
  return "failed";
}

function buildMedicineTreatmentParticipants({
  sourceActor = null,
  sourceToken = null,
  targetActor = null,
  targetToken = null,
  treatmentType = "trauma",
  treatmentId = "",
  instrumentId = ""
} = {}) {
  const instrument = sourceActor?.items?.get?.(String(instrumentId ?? "")) ?? null;
  const treatmentItem = treatmentType === "limb"
    ? null
    : targetActor?.items?.get?.(String(treatmentId ?? "")) ?? null;
  return {
    source: createMedicineEventParticipant(sourceActor, sourceToken, instrument),
    target: createMedicineEventParticipant(targetActor, targetToken, treatmentItem),
    related: []
  };
}

function createMedicineEventParticipant(actor = null, token = null, item = null) {
  const tokenDocument = token?.document ?? token;
  const participant = {
    actorUuid: String(actor?.uuid ?? tokenDocument?.actor?.uuid ?? ""),
    tokenUuid: String(tokenDocument?.uuid ?? ""),
    itemUuid: String(item?.uuid ?? "")
  };
  return Object.values(participant).some(Boolean) ? participant : null;
}

function buildMedicineTreatmentEventData(args = {}, {
  receipt = null,
  status = "pending",
  reason = ""
} = {}) {
  const sourceActor = args.sourceActor ?? null;
  const targetActor = args.targetActor ?? null;
  const instrument = sourceActor?.items?.get?.(String(args.instrumentId ?? "")) ?? null;
  const treatmentItem = args.treatmentType === "limb"
    ? null
    : targetActor?.items?.get?.(String(args.treatmentId ?? "")) ?? null;
  const entries = Array.isArray(receipt?.entries)
    ? receipt.entries.map(entry => ({
        index: toInteger(entry?.index),
        total: toInteger(entry?.total),
        resultKey: String(entry?.resultKey ?? ""),
        progress: Math.max(0, toInteger(entry?.progress)),
        charges: Math.max(0, toInteger(entry?.charges)),
        currentProgress: Math.max(0, toInteger(entry?.currentProgress)),
        skillCheckMessageUuid: String(entry?.skillCheckMessageUuid ?? "")
      }))
    : [];
  return {
    schemaVersion: 1,
    operationId: String(args.operationId ?? receipt?.operationId ?? ""),
    sourceActorUuid: String(sourceActor?.uuid ?? ""),
    targetActorUuid: String(targetActor?.uuid ?? ""),
    sourceTokenUuid: getMedicineTokenUuid(args.sourceToken),
    targetTokenUuid: getMedicineTokenUuid(args.targetToken),
    treatmentType: String(args.treatmentType ?? "trauma"),
    treatmentId: String(args.treatmentId ?? ""),
    treatmentItemUuid: String(treatmentItem?.uuid ?? ""),
    treatmentName: String(receipt?.treatment?.name ?? treatmentItem?.name ?? ""),
    instrumentId: String(args.instrumentId ?? ""),
    instrumentItemUuid: String(instrument?.uuid ?? ""),
    instrumentName: String(receipt?.instrument?.name ?? instrument?.name ?? ""),
    toolKey: String(args.toolKey ?? ""),
    status: String(receipt?.status ?? status),
    reason: String(receipt?.reason ?? reason),
    initialProgress: Math.max(0, toInteger(receipt?.initialProgress)),
    finalProgress: Math.max(0, toInteger(receipt?.finalProgress)),
    maxProgress: Math.max(0, toInteger(receipt?.maxProgress)),
    spentCharges: Math.max(0, toInteger(receipt?.spentCharges)),
    completed: Boolean(receipt?.completed),
    entries
  };
}

function buildMedicineTreatmentStateSnapshot({
  sourceActor = null,
  targetActor = null,
  treatmentType = "trauma",
  treatmentId = "",
  instrumentId = "",
  toolKey = ""
} = {}) {
  const instrument = sourceActor?.items?.get?.(String(instrumentId ?? "")) ?? null;
  const supply = getEffectiveMedicineToolFunction(instrument, toolKey)?.resourceValue;
  if (treatmentType === "limb") {
    const limb = targetActor?.system?.limbs?.[String(treatmentId ?? "")];
    return {
      progress: limb ? toInteger(limb.value) - toInteger(limb.min) : null,
      maxProgress: limb ? Math.max(0, toInteger(limb.max) - toInteger(limb.min)) : null,
      supply: supply === undefined ? null : Math.max(0, toInteger(supply)),
      limbValue: limb ? toInteger(limb.value) : null
    };
  }
  const treatment = targetActor?.items?.get?.(String(treatmentId ?? "")) ?? null;
  return {
    progress: treatment ? Math.max(0, toInteger(treatment.system?.healingProgress)) : null,
    maxProgress: treatment ? Math.max(1, toInteger(treatment.system?.healingProgressMax)) : null,
    supply: supply === undefined ? null : Math.max(0, toInteger(supply)),
    limbValue: null
  };
}

function createCancelledMedicineTreatmentReceipt(args = {}, reason = "cancelled") {
  const targetContext = args.targetActor ? buildTargetContext(args.targetActor, args.targetToken) : null;
  const treatment = getTargetTreatments(targetContext, args.treatmentType)
    .find(entry => entry.id === String(args.treatmentId ?? "")) ?? null;
  const instrument = args.sourceActor?.items?.get?.(String(args.instrumentId ?? "")) ?? null;
  const maxProgress = Math.max(1, toInteger(treatment?.healingProgressMax));
  const initialProgress = Math.min(maxProgress, Math.max(0, toInteger(treatment?.healingProgress)));
  return {
    version: 1,
    status: "cancelled",
    operationId: String(args.operationId ?? ""),
    targetContext,
    treatment,
    instrument: instrument ? {
      id: instrument.id,
      name: instrument.name,
      img: normalizeImagePath(instrument.img, "icons/svg/item-bag.svg")
    } : null,
    initialProgress,
    finalProgress: initialProgress,
    maxProgress,
    spentCharges: 0,
    entries: [],
    completed: initialProgress >= maxProgress,
    reason: String(reason || "Лечение отменено.")
  };
}

function getExternalMedicineHealingFailureReason(result = {}) {
  if (result.cancelled) return "Лечение отменено до применения.";
  if (result.reason === "healing-blocked") return "Цель сейчас не может получать лечение.";
  return "Лечение не удалось применить.";
}

async function resolveTreatmentOnAuthorityOperation({
  sourceActor,
  sourceToken = null,
  targetActor,
  targetToken = null,
  treatmentType = "trauma",
  treatmentId,
  instrumentId,
  toolKey,
  operationId = `medicine-treatment:${foundry.utils.randomID()}`,
  chainRef = null
} = {}) {
  if (!sourceActor || !targetActor) throw new Error("участники лечения не найдены");
  if (!["limb", "trauma", "disease"].includes(treatmentType)) {
    throw new Error("некорректный тип цели лечения");
  }
  if (!String(treatmentId ?? "").trim() || !String(instrumentId ?? "").trim()) {
    throw new Error("цель или инструмент лечения не указаны");
  }

  const currentTargetContext = buildTargetContext(targetActor, targetToken);
  const treatment = getTargetTreatments(currentTargetContext, treatmentType)
    .find(item => item.id === String(treatmentId ?? ""));
  const instrument = sourceActor.items?.get(String(instrumentId ?? ""));
  const normalizedToolKey = validateConfiguredMedicineToolKey(toolKey);
  if (
    !treatment
    || !instrument
    || instrument.type !== "gear"
    || !hasItemFunction(instrument, createToolFunctionKey(normalizedToolKey))
  ) {
    throw new Error("цель или исправный инструмент лечения не найдены");
  }

  const tool = getEffectiveMedicineToolFunction(instrument, normalizedToolKey);
  const validation = validateInstrumentForTreatment(sourceActor, treatment, tool);
  if (!validation.ok) throw new Error(validation.message);

  const maxProgress = Math.max(1, toInteger(treatment.healingProgressMax));
  const initialProgress = Math.min(maxProgress, Math.max(0, toInteger(treatment.healingProgress)));
  const receiptBase = {
    version: 1,
    status: "pending",
    operationId,
    targetContext: currentTargetContext,
    treatment,
    instrument: {
      id: instrument.id,
      name: instrument.name,
      img: normalizeImagePath(instrument.img, "icons/svg/item-bag.svg")
    },
    initialProgress,
    finalProgress: initialProgress,
    maxProgress,
    spentCharges: 0,
    entries: [],
    completed: initialProgress >= maxProgress,
    reason: ""
  };
  if (!canActorReceiveHealing(targetActor)) {
    return {
      ...receiptBase,
      status: "failed",
      reason: "Цель сейчас не может получать лечение."
    };
  }
  if (initialProgress >= maxProgress) {
    return { ...receiptBase, status: "alreadyComplete", alreadyHealed: true };
  }

  const medicineMode = getMedicineResolutionMode();
  const result = await runTreatmentChecks({
    sourceActor,
    sourceToken,
    targetContext: currentTargetContext,
    targetToken,
    treatment,
    tool,
    initialProgress,
    maxProgress,
    operationId,
    chainRef,
    medicineMode
  });
  if (!result.entries.length) {
    return {
      ...receiptBase,
      status: "failed",
      reason: result.reason || "Лечение не выполнено."
    };
  }

  const finalProgress = Math.min(maxProgress, result.finalProgress);
  const completed = finalProgress >= maxProgress;
  const commitRequest = {
    sourceActor,
    targetActor,
    targetToken,
    treatmentType,
    treatmentId,
    instrumentId: instrument.id,
    toolKey: normalizedToolKey,
    expectedProgress: initialProgress,
    finalProgress,
    completed,
    expectedSupply: toInteger(tool.resourceValue),
    remainingSupply: result.remainingCharges,
    expectedMedicineMode: medicineMode,
    chainRef
  };
  let commitResult;
  if (treatmentType === "limb" && finalProgress > initialProgress) {
    const healingResult = await runExternalHealingSystemEventWorkflow({
      actorUuid: targetActor.uuid,
      amount: finalProgress - initialProgress,
      mode: "healing",
      scope: "limb",
      limbKey: String(treatmentId ?? ""),
      source: {
        kind: "medicineTreatment",
        operationId,
        sourceActorUuid: String(sourceActor.uuid ?? ""),
        sourceTokenUuid: getMedicineTokenUuid(sourceToken),
        targetTokenUuid: getMedicineTokenUuid(targetToken),
        sourceItemUuid: String(instrument.uuid ?? ""),
        limitedUseSkipOutgoing: true,
        limitedUseSkipIncoming: true,
        chainRef
      }
    }, async ({ actor, chainRef: healingChainRef }) => {
      const committed = await commitTreatmentToActors({
        ...commitRequest,
        targetActor: actor,
        chainRef: healingChainRef ?? chainRef
      });
      return {
        actor,
        amount: committed.healing?.appliedHealing ?? 0,
        healthDelta: committed.healing?.healthDelta ?? 0,
        limbDelta: committed.healing?.appliedHealing ?? 0,
        mode: "healing",
        scope: "limb",
        limbKey: String(treatmentId ?? ""),
        targetContext: committed.targetContext
      };
    });
    if (healingResult?.cancelled || healingResult?.failed) {
      return {
        ...receiptBase,
        status: healingResult.cancelled ? "cancelled" : "failed",
        reason: getExternalMedicineHealingFailureReason(healingResult)
      };
    }
    commitResult = {
      targetContext: healingResult?.targetContext ?? buildTargetContext(targetActor, targetToken),
      healing: healingResult
    };
  } else {
    commitResult = await commitTreatmentToActors(commitRequest);
  }
  return {
    ...receiptBase,
    status: "committed",
    targetContext: commitResult.targetContext,
    finalProgress,
    spentCharges: result.spentCharges,
    entries: result.entries,
    completed,
    halted: Boolean(result.halted),
    reason: String(result.reason ?? "")
  };
}

async function commitTreatmentToActors({
  sourceActor,
  targetActor,
  targetToken = null,
  treatmentType = "trauma",
  treatmentId,
  instrumentId,
  toolKey,
  expectedProgress,
  finalProgress,
  completed,
  expectedSupply,
  remainingSupply,
  expectedMedicineMode,
  chainRef = null
}) {
  const instrument = sourceActor?.items?.get(String(instrumentId ?? ""));
  const normalizedToolKey = String(toolKey ?? "").trim();
  const tool = getEffectiveMedicineToolFunction(instrument, normalizedToolKey);
  const currentSupply = Math.max(0, toInteger(tool?.resourceValue));
  const expected = Math.max(0, toInteger(expectedSupply));
  const remaining = Math.max(0, toInteger(remainingSupply));
  if (
    !instrument
    || instrument.type !== "gear"
    || !hasItemFunction(instrument, createToolFunctionKey(normalizedToolKey))
    || !tool?.enabled
  ) {
    throw new Error("инструмент лечения не найден");
  }
  if (currentSupply !== expected) {
    throw createTreatmentStaleError("Запас инструмента изменился.");
  }
  if (remaining >= currentSupply) throw new Error("Лечение должно расходовать запас инструмента.");
  if (getMedicineResolutionMode() !== expectedMedicineMode) {
    throw createTreatmentStaleError("Режим медицины изменился во время лечения.");
  }

  const treatmentCommit = treatmentType === "limb"
    ? prepareLimbTreatmentCommit(targetActor, {
        treatmentId,
        expectedProgress,
        finalProgress,
        completed
      })
    : prepareItemTreatmentCommit(targetActor, {
        treatmentType,
        treatmentId,
        expectedProgress,
        finalProgress,
        completed
      });
  const authoritativeValidation = validateInstrumentForTreatment(
    sourceActor,
    treatmentCommit.treatmentTarget,
    tool
  );
  if (!authoritativeValidation.ok) throw new Error(authoritativeValidation.message);
  const authoritativeSkill = getMedicineSkillResolution(
    sourceActor,
    treatmentCommit.treatmentTarget,
    expectedMedicineMode
  );
  if (!authoritativeSkill.met) {
    throw createTreatmentStaleError(
      getMedicineSkillThresholdMessage(
        authoritativeSkill,
        treatmentCommit.treatmentTarget?.name
      )
    );
  }
  const instrumentUpdate = createToolResourceValueUpdate(instrument, tool, remaining);
  if (treatmentType === "limb") {
    await executeAtomicActorItemUpdates([
      ...treatmentCommit.targetPlan.actorUpdates.map(updates => ({
        document: targetActor,
        updates,
        documentOptions: {
          falloutMawSkipDamageStatusSync: true,
          falloutMawLimbCapSync: true
        }
      })),
      { document: instrument, updates: instrumentUpdate }
    ], {
      reason: "medicine-limb-treatment-with-tool",
      chainRef
    });
  } else {
    await executeInventoryMutation([
      treatmentCommit.targetPlan,
      {
        actor: sourceActor,
        updates: [{ _id: instrument.id, ...instrumentUpdate }]
      }
    ], {
      reason: "medicine-treatment-with-tool",
      documentOptions: {
        falloutMawSkipDamageStatusSync: true,
        falloutMawLimbCapSync: true,
        ...(chainRef ? { chainRef, falloutMawSystemEventChainRef: chainRef } : {})
      }
    });
  }

  if (treatmentCommit.syncDamageStatuses) {
    try {
      await synchronizeActorDamageStatusesAfterInventoryMutation(targetActor);
    } catch (error) {
      console.error(`${SYSTEM_ID} | Damage status sync failed after treatment commit`, error);
    }
  }
  if (treatmentCommit.diseaseSnapshot) {
    try {
      await createDiseaseImmunityEffect(targetActor, treatmentCommit.diseaseSnapshot, chainRef
        ? { chainRef, falloutMawSystemEventChainRef: chainRef }
        : {});
    } catch (error) {
      console.error(`${SYSTEM_ID} | Disease immunity effect creation failed after treatment commit`, error);
      ui.notifications.warn("Болезнь вылечена, но эффект иммунитета создать не удалось.");
    }
  }
  return {
    targetContext: buildTargetContext(targetActor, targetToken),
    healing: treatmentCommit.healing ?? null
  };
}

function prepareLimbTreatmentCommit(targetActor, {
  treatmentId,
  expectedProgress,
  finalProgress,
  completed
} = {}) {
  const limbKey = String(treatmentId ?? "").trim();
  const limb = targetActor?.system?.limbs?.[limbKey];
  if (!limb || targetActor?.type === "construct") throw new Error("цель лечения не найдена");

  const limbHealthContext = buildActorLimbHealthContext(targetActor);
  const min = toInteger(limb.min);
  const currentLimbValue = toInteger(limb.value);
  const healingCap = Math.min(
    Math.max(0, toInteger(limb.max)),
    getLimbHealingCap(targetActor, limbKey, limbHealthContext)
  );
  if (
    limb.missing
    || limbHealthContext.prosthesesByLimb.has(limbKey)
    || currentLimbValue >= healingCap
  ) {
    throw createTreatmentStaleError("Конечность больше не подлежит лечению.");
  }
  const maxProgress = Math.max(1, healingCap - min);
  const currentProgress = Math.min(maxProgress, Math.max(0, currentLimbValue - min));
  const nextProgress = Math.min(maxProgress, Math.max(0, toInteger(finalProgress)));
  assertTreatmentProgressIsCurrent(currentProgress, expectedProgress);
  if (nextProgress < currentProgress) throw new Error("Лечение не может уменьшать здоровье конечности.");
  assertTreatmentCompletionIsCurrent(nextProgress, maxProgress, completed);

  const expectedLimbValue = Math.min(healingCap, min + nextProgress);
  const healing = prepareTargetedLimbHealingActorUpdate(
    targetActor,
    limbKey,
    expectedLimbValue - currentLimbValue,
    limbHealthContext
  );
  if (healing.previousValue !== currentLimbValue || healing.finalValue !== expectedLimbValue) {
    throw createTreatmentStaleError("Состояние конечности изменилось или она больше не подлежит лечению.");
  }

  const targetPlan = createEmptyTreatmentPlan(targetActor);
  if (Object.keys(healing.updateData).length) targetPlan.actorUpdates.push(healing.updateData);
  return {
    targetPlan,
    treatmentTarget: {
      type: "limb",
      name: String(limb.label ?? limbKey),
      healingToolClass: LIMB_TREATMENT_TOOL_CLASS,
      healingDifficulty: LIMB_TREATMENT_DIFFICULTY,
      healingSkillKey: LIMB_TREATMENT_SKILL_KEY,
      treatable: true
    },
    diseaseSnapshot: null,
    syncDamageStatuses: healing.appliedHealing > 0,
    healing
  };
}

function prepareItemTreatmentCommit(targetActor, {
  treatmentType = "trauma",
  treatmentId,
  expectedProgress,
  finalProgress,
  completed
} = {}) {
  const treatment = targetActor?.items?.get(String(treatmentId ?? ""));
  if (!treatment || treatment.type !== treatmentType || !["trauma", "disease"].includes(treatmentType)) {
    throw new Error("цель лечения не найдена");
  }

  const maxProgress = Math.max(1, toInteger(treatment.system?.healingProgressMax));
  const currentProgress = Math.min(maxProgress, Math.max(0, toInteger(treatment.system?.healingProgress)));
  const nextProgress = Math.min(maxProgress, Math.max(0, toInteger(finalProgress)));
  assertTreatmentProgressIsCurrent(currentProgress, expectedProgress);
  if (nextProgress < currentProgress) throw new Error("Лечение не может уменьшать прогресс.");
  const treatmentCompleted = assertTreatmentCompletionIsCurrent(nextProgress, maxProgress, completed);

  const targetPlan = createEmptyTreatmentPlan(targetActor);
  if (treatmentCompleted) {
    targetPlan.deletes.push(treatment.id);
    if (treatment.type === "trauma") {
      const actorUpdate = createHealedTraumaActorUpdate(targetActor, treatment);
      if (Object.keys(actorUpdate).length) targetPlan.actorUpdates.push(actorUpdate);
    }
  } else {
    targetPlan.updates.push({
      _id: treatment.id,
      "system.healingProgress": nextProgress
    });
  }
  return {
    targetPlan,
    treatmentTarget: {
      type: treatment.type,
      name: String(treatment.name ?? ""),
      healingToolClass: String(treatment.system?.healingToolClass ?? "D"),
      healingDifficulty: toInteger(treatment.system?.healingDifficulty),
      healingSkillKey: String(treatment.system?.healingSkillKey ?? ""),
      treatable: true
    },
    diseaseSnapshot: treatment.type === "disease" && treatmentCompleted ? treatment.toObject() : null,
    syncDamageStatuses: treatment.type === "trauma" && treatmentCompleted,
    healing: null
  };
}

function createEmptyTreatmentPlan(actor) {
  return {
    actor,
    updates: [],
    deletes: [],
    actorUpdates: []
  };
}

function assertTreatmentProgressIsCurrent(currentProgress, expectedProgress) {
  if (currentProgress !== toInteger(expectedProgress)) {
    throw createTreatmentStaleError("Прогресс лечения изменился.");
  }
}

function assertTreatmentCompletionIsCurrent(nextProgress, maxProgress, completed) {
  const treatmentCompleted = nextProgress >= maxProgress;
  if (Boolean(completed) !== treatmentCompleted) {
    throw createTreatmentStaleError("Результат лечения больше не соответствует состоянию цели.");
  }
  return treatmentCompleted;
}

function createHealedTraumaActorUpdate(actor, trauma) {
  const limbKeys = new Set();
  const primaryLimbKey = String(trauma?.system?.limbKey ?? "").trim();
  if (primaryLimbKey) limbKeys.add(primaryLimbKey);
  for (const source of trauma?.system?.sources ?? []) {
    const limbKey = String(source?.limbKey ?? "").trim();
    if (limbKey) limbKeys.add(limbKey);
  }

  const update = {};
  for (const limbKey of limbKeys) {
    if (!actor?.system?.limbs?.[limbKey]) continue;
    update[`system.limbs.${limbKey}.damageAccumulation`] =
      foundry.data.operators.ForcedReplacement.create({});
  }
  return update;
}

function createTreatmentStaleError(message) {
  const error = new Error(message);
  error.code = "inventory-stale";
  return error;
}

function buildTargetContext(actor, token = null) {
  const race = getCreatureOptions().races.find(entry => entry.id === actor.system?.creature?.raceId) ?? null;
  const limbHealthContext = buildActorLimbHealthContext(actor);
  return {
    actorUuid: actor.uuid,
    actorType: actor.type,
    name: token?.name ?? actor.name,
    actorName: actor.name,
    tokenName: token?.name ?? "",
    incomingHealingPercent: getActorHealingModifierPercent(actor, "incoming"),
    limbs: snapshotActorLimbs(actor, limbHealthContext),
    limbSilhouette: actor.system?.limbSilhouetteOverride
      ? (actor.system?.limbSilhouette ?? null)
      : (race?.limbSilhouette ?? null),
    implantItems: snapshotImplantItems(actor, "target"),
    prosthesisItems: snapshotProsthesisItems(actor, "target"),
    traumas: getActorItemsByType(actor, "trauma").map(snapshotTrauma),
    diseases: getActorItemsByType(actor, "disease").map(snapshotDisease)
  };
}

function snapshotActorLimbs(actor, limbHealthContext = buildActorLimbHealthContext(actor)) {
  const installedImplants = getInstalledImplantsByLimb(actor);
  const installed = limbHealthContext?.prosthesesByLimb ?? getInstalledProsthesesByLimb(actor);
  return Object.entries(actor.system?.limbs ?? {}).map(([key, limb]) => {
    const implants = installedImplants.get(key) ?? [];
    const prosthesis = installed.get(key) ?? null;
    const missing = Boolean(limb?.missing);
    const value = toInteger(limb?.value);
    const min = toInteger(limb?.min);
    const max = Math.max(0, toInteger(limb?.max));
    const healingCap = Math.min(max, Math.max(min, toInteger(getLimbHealingCap(actor, key, limbHealthContext))));
    const healable = actor.type !== "construct" && !missing && !prosthesis && value < healingCap;
    const unavailableReason = getLimbTreatmentUnavailableReason({
      actorType: actor.type,
      value,
      max,
      healingCap,
      missing,
      prosthesis
    });
    return {
      id: key,
      type: "limb",
      key,
      limbKey: key,
      name: `Здоровье: ${String(limb?.label ?? key)}`,
      label: String(limb?.label ?? key),
      img: "icons/svg/heal.svg",
      value,
      min,
      max,
      healingCap,
      damaged: value < max,
      healable,
      treatable: healable,
      unavailableReason,
      statusLabel: unavailableReason || (healingCap < max ? `Доступный предел: ${healingCap}` : "Можно лечить"),
      healingDifficulty: LIMB_TREATMENT_DIFFICULTY,
      healingToolClass: LIMB_TREATMENT_TOOL_CLASS,
      healingSkillKey: LIMB_TREATMENT_SKILL_KEY,
      healingSkillLabel: getHealingSkillLabel(LIMB_TREATMENT_SKILL_KEY),
      healingProgress: Math.max(0, value - min),
      healingProgressMax: Math.max(1, healingCap - min),
      displayProgressValue: value,
      displayProgressMax: healingCap,
      implantLimit: Math.max(0, toInteger(limb?.implantLimit ?? 1)),
      implants: implants.map(item => snapshotImplantItem(item, "target")),
      missing,
      prosthesis: prosthesis ? snapshotProsthesisItem(prosthesis, "target") : null
    };
  });
}

function getLimbTreatmentUnavailableReason({ actorType = "", value = 0, max = 0, healingCap = 0, missing = false, prosthesis = null } = {}) {
  if (actorType === "construct") return "Для механизмов используется ремонт.";
  if (missing) return "Конечность отсутствует.";
  if (prosthesis) return "Установленный протез лечению не подлежит.";
  if (value >= healingCap && healingCap < max) return "Сначала вылечите ограничивающую травму.";
  if (value >= healingCap) return "Здоровье уже восстановлено до доступного предела.";
  return "";
}

function snapshotImplantItems(actor, source = "target") {
  return getActorItemsByType(actor, "gear")
    .filter(item => hasItemFunction(item, ITEM_FUNCTIONS.implant))
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
  return getActorItemsByType(actor, "gear")
    .filter(item => hasItemFunction(item, ITEM_FUNCTIONS.prosthesis))
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
  for (const item of getActorItemsByType(actor, "gear")) {
    if (!item.system?.equipped) continue;
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
  for (const item of getActorItemsByType(actor, "gear")) {
    if (!item.system?.equipped) continue;
    if (!hasItemFunction(item, ITEM_FUNCTIONS.prosthesis)) continue;
    if (String(item.system?.placement?.mode ?? "") !== "prosthesis") continue;
    const limbKey = String(item.system?.placement?.limbKey ?? "");
    if (limbKey) map.set(limbKey, item);
  }
  return map;
}

function snapshotTrauma(item) {
  const system = item.system ?? {};
  const limbKeys = Array.from(new Set([
    system.limbKey,
    ...(Array.isArray(system.sources) ? system.sources : []).map(source => source?.limbKey)
  ].map(key => String(key ?? "").trim()).filter(Boolean)));
  return {
    id: item.id,
    type: "trauma",
    name: item.name,
    img: normalizeImagePath(item.img, "icons/svg/blood.svg"),
    limbKey: String(system.limbKey ?? "").trim(),
    limbKeys,
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

async function requestMedicineSocket(action, payload = {}, gm = getResponsibleGM(), { requestId = "" } = {}) {
  if (!gm) throw new Error("нет активного GM");
  const resolvedRequestId = String(requestId ?? "").trim() || foundry.utils.randomID();
  const requesterUserId = game.user?.id ?? "";

  const promise = new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingMedicineSocketRequests.delete(resolvedRequestId);
      const error = new Error("GM не ответил на запрос медицины");
      error.code = "authority-timeout";
      reject(error);
    }, MEDICINE_SOCKET_TIMEOUT);
    pendingMedicineSocketRequests.set(resolvedRequestId, {
      resolve,
      reject,
      timeout,
      gmUserId: String(gm.id ?? "")
    });
  });

  game.socket.emit(MEDICINE_SOCKET, {
    scope: MEDICINE_SOCKET_SCOPE,
    type: "request",
    action,
    requestId: resolvedRequestId,
    requesterUserId,
    gmUserId: gm.id,
    payload
  });
  return promise;
}

async function handleMedicineSocketMessage(message = {}, senderUserId = "") {
  if (message?.scope !== MEDICINE_SOCKET_SCOPE) return;
  const authenticatedSenderId = String(senderUserId ?? "").trim();

  if (message.type === "response") {
    if (message.recipientUserId && message.recipientUserId !== game.user?.id) return;
    const pending = pendingMedicineSocketRequests.get(message.requestId);
    if (!pending) return;
    if (!authenticatedSenderId || authenticatedSenderId !== pending.gmUserId) return;
    window.clearTimeout(pending.timeout);
    pendingMedicineSocketRequests.delete(message.requestId);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error || "ошибка GM-сокета медицины"));
    return;
  }

  if (message.type !== "request") return;
  if (!game.user?.isGM || message.gmUserId !== game.user.id) return;
  if (!authenticatedSenderId || authenticatedSenderId !== String(message.requesterUserId ?? "")) return;

  try {
    const result = await handleMedicineSocketRequestOnce(message);
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

function handleMedicineSocketRequestOnce(message = {}) {
  const requestId = String(message.requestId ?? "").trim();
  const requesterUserId = String(message.requesterUserId ?? "").trim();
  if (!requestId || !requesterUserId) throw new Error("некорректный запрос медицины");
  const key = `${requesterUserId}:${requestId}`;
  const existing = handledMedicineSocketRequests.get(key);
  if (existing) return existing.promise;

  const entry = { promise: null, settled: false };
  entry.promise = Promise.resolve().then(() => handleMedicineSocketRequest(
    message.action,
    message.payload ?? {},
    requesterUserId,
    `medicine-socket:${requesterUserId}:${requestId}`
  ));
  handledMedicineSocketRequests.set(key, entry);
  entry.promise.then(
    () => settleHandledMedicineSocketRequest(key, entry),
    () => settleHandledMedicineSocketRequest(key, entry)
  );
  pruneHandledMedicineSocketRequests();
  return entry.promise;
}

function settleHandledMedicineSocketRequest(key, entry) {
  entry.settled = true;
  window.setTimeout(() => {
    if (handledMedicineSocketRequests.get(key) === entry) handledMedicineSocketRequests.delete(key);
  }, MEDICINE_SOCKET_RECEIPT_TTL);
}

function pruneHandledMedicineSocketRequests() {
  if (handledMedicineSocketRequests.size <= MAX_HANDLED_MEDICINE_SOCKET_REQUESTS) return;
  for (const [key, entry] of handledMedicineSocketRequests) {
    if (!entry.settled) continue;
    handledMedicineSocketRequests.delete(key);
    if (handledMedicineSocketRequests.size <= MAX_HANDLED_MEDICINE_SOCKET_REQUESTS) break;
  }
}

async function handleMedicineSocketRequest(action, payload = {}, requesterUserId = "", operationId = "") {
  const actor = await fromUuid(String(payload.actorUuid ?? payload.targetActorUuid ?? ""));
  if (!actor) throw new Error("цель не найдена");

  if (action === "getTargetContext") {
    const sourceActor = await getMedicineSocketSourceActor(payload.sourceActorUuid, requesterUserId);
    const targetToken = await resolveMedicineTokenForActor(payload.targetTokenUuid, actor, { required: true });
    return {
      targetContext: buildTargetContext(actor, targetToken),
      sourceActorUuid: sourceActor.uuid
    };
  }

  if (action === "performTreatment") {
    const sourceActor = await getMedicineSocketSourceActor(payload.sourceActorUuid, requesterUserId);
    const [sourceToken, targetToken] = await Promise.all([
      resolveMedicineTokenForActor(payload.sourceTokenUuid, sourceActor, { required: true }),
      resolveMedicineTokenForActor(payload.targetTokenUuid, actor, { required: true })
    ]);
    return {
      resolution: await resolveTreatmentOnAuthority({
        sourceActor,
        sourceToken,
        targetActor: actor,
        targetToken,
        treatmentType: payload.treatmentType ?? "trauma",
        treatmentId: payload.treatmentId ?? payload.traumaId,
        instrumentId: payload.instrumentId,
        toolKey: payload.toolKey,
        operationId
      })
    };
  }

  if (action === "performMassTreatment") {
    const sourceActor = await getMedicineSocketSourceActor(payload.sourceActorUuid, requesterUserId);
    const [sourceToken, targetToken] = await Promise.all([
      resolveMedicineTokenForActor(payload.sourceTokenUuid, sourceActor, { required: true }),
      resolveMedicineTokenForActor(payload.targetTokenUuid, actor, { required: true })
    ]);
    return {
      resolution: await resolveMassTreatmentOnAuthority({
        sourceActor,
        sourceToken,
        targetActor: actor,
        targetToken,
        toolKey: payload.toolKey,
        options: payload.options,
        operationId
      })
    };
  }

  if (action === "performImplantInstallation") {
    const sourceActor = await getMedicineSocketSourceActor(payload.sourceActorUuid, requesterUserId);
    const [sourceToken, targetToken] = await Promise.all([
      resolveMedicineTokenForActor(payload.sourceTokenUuid, sourceActor, { required: true }),
      resolveMedicineTokenForActor(payload.targetTokenUuid, actor, { required: true })
    ]);
    return {
      resolution: await resolveImplantInstallationOnAuthority({
        sourceActor,
        sourceToken,
        targetActor: actor,
        targetToken,
        limbKey: payload.limbKey,
        implantSource: payload.implantSource,
        itemId: payload.itemId
      })
    };
  }

  if (action === "removeImplant") {
    const sourceActor = await getMedicineSocketSourceActor(payload.sourceActorUuid, requesterUserId);
    const targetToken = await resolveMedicineTokenForActor(payload.targetTokenUuid, actor, { required: true });
    return {
      targetContext: await runWithMedicineAuthorityLocks(
        [sourceActor, actor],
        () => applyImplantRemovalLocally({
          sourceActor,
          targetActor: actor,
          targetToken,
          limbKey: payload.limbKey,
          itemId: payload.itemId
        })
      )
    };
  }

  if (action === "performProsthesisInstallation") {
    const sourceActor = await getMedicineSocketSourceActor(payload.sourceActorUuid, requesterUserId);
    const [sourceToken, targetToken] = await Promise.all([
      resolveMedicineTokenForActor(payload.sourceTokenUuid, sourceActor, { required: true }),
      resolveMedicineTokenForActor(payload.targetTokenUuid, actor, { required: true })
    ]);
    return {
      resolution: await resolveProsthesisInstallationOnAuthority({
        sourceActor,
        sourceToken,
        targetActor: actor,
        targetToken,
        limbKey: payload.limbKey,
        prosthesisSource: payload.prosthesisSource,
        itemId: payload.itemId
      })
    };
  }

  if (action === "removeProsthesis") {
    const sourceActor = await getMedicineSocketSourceActor(payload.sourceActorUuid, requesterUserId);
    const targetToken = await resolveMedicineTokenForActor(payload.targetTokenUuid, actor, { required: true });
    return {
      targetContext: await runWithMedicineAuthorityLocks(
        [sourceActor, actor],
        () => applyProsthesisRemovalLocally({
          sourceActor,
          targetActor: actor,
          targetToken,
          limbKey: payload.limbKey,
          itemId: payload.itemId
        })
      )
    };
  }

  throw new Error(`неизвестное действие медицины: ${action}`);
}

function assertMedicineSocketActorOwner(actor, requesterUserId) {
  const user = game.users?.get?.(String(requesterUserId ?? ""))
    ?? (game.users?.contents ?? []).find(entry => entry.id === requesterUserId);
  if (!user || (!user.isGM && !actor?.testUserPermission?.(user, "OWNER"))) {
    throw new Error("нет прав на использование инструмента");
  }
}

async function getMedicineSocketSourceActor(actorUuid = "", requesterUserId = "") {
  const actor = await fromUuid(String(actorUuid ?? "").trim());
  if (!actor || actor.documentName !== "Actor") throw new Error("источник медицины не найден");
  assertMedicineSocketActorOwner(actor, requesterUserId);
  return actor;
}

function getMedicineTokenUuid(token = null) {
  const document = token?.document ?? token;
  return document?.documentName === "Token" ? String(document.uuid ?? "") : "";
}

async function resolveMedicineTokenForActor(tokenUuid = "", actor = null, { required = false } = {}) {
  const uuid = String(tokenUuid ?? "").trim();
  if (!uuid) {
    if (required) throw new Error("токен участника медицины не найден");
    return null;
  }
  const token = await fromUuid(uuid);
  if (
    token?.documentName !== "Token"
    || !token.actor
    || String(token.actor.uuid ?? "") !== String(actor?.uuid ?? "")
  ) {
    throw new Error("токен не соответствует участнику медицины");
  }
  return token;
}

function getTargetLimbLabel(targetContext, limbKey = "") {
  return targetContext?.limbs?.find(limb => limb.key === limbKey)?.label ?? limbKey;
}

function mixRgb(from, to, ratio) {
  const amount = Math.max(0, Math.min(1, Number(ratio) || 0));
  const channels = from.map((channel, index) => Math.round(channel + ((to[index] - channel) * amount)));
  return `rgb(${channels[0]}, ${channels[1]}, ${channels[2]})`;
}

async function postTreatmentResultChat(actor, { treatment, instrument, initialProgress, finalProgress, maxProgress, spentCharges, entries, completed }) {
  const progressOffset = treatment.type === "limb" ? toInteger(treatment.min) : 0;
  const displayProgress = value => toInteger(value) + progressOffset;
  const completionLabel = treatment.type === "disease"
    ? "Болезнь вылечена."
    : treatment.type === "limb"
      ? "Конечность восстановлена до доступного предела."
      : "Травма полностью вылечена.";
  const rows = entries.map(entry => `
    <li>
      Проверка ${entry.index}/${entry.total}: ${entry.resultLabel},
      +${entry.progress} прогресса,
      запас ${entry.charges},
      эффективность ${formatNumber(entry.efficiency)}%,
      итог ${displayProgress(entry.currentProgress)}/${displayProgress(maxProgress)}
    </li>
  `).join("");
  await postMedicineChat(actor, {
    title: `Лечение: ${treatment.name}`,
    tone: completed ? "success" : "standard",
    lines: [
      `Инструмент: ${instrument.name}`,
      `Прогресс: ${displayProgress(initialProgress)}/${displayProgress(maxProgress)} -> ${displayProgress(finalProgress)}/${displayProgress(maxProgress)}`,
      `Потрачено запаса: ${spentCharges}`,
      `<ul>${rows}</ul>`,
      completed ? completionLabel : ""
    ].filter(Boolean)
  });
}

async function postMassTreatmentChat(actor, summary = {}) {
  const reasons = Array.isArray(summary.reasons) ? summary.reasons.filter(Boolean) : [];
  const reasonList = reasons.length
    ? `<ul>${reasons.map(reason => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>`
    : "";
  await postMedicineChat(actor, {
    title: "Массовое лечение",
    tone: summary.stopped ? "failure" : toInteger(summary.skipped) > 0 ? "standard" : "success",
    lines: [
      summary.targetName ? `Цель: ${summary.targetName}` : "",
      `Последовательных операций: ${Math.max(0, toInteger(summary.attempted))}`,
      `Полностью вылечено травм: ${Math.max(0, toInteger(summary.completedTraumas))}`,
      `Получено прогресса лечения травм: ${Math.max(0, toInteger(summary.restoredTraumaProgress))}`,
      `Частей тела восстановлено до доступного предела: ${Math.max(0, toInteger(summary.completedLimbs))}`,
      `Восстановлено здоровья частей тела: ${Math.max(0, toInteger(summary.restoredLimbHealth))}`,
      `Потрачено запаса инструментов: ${Math.max(0, toInteger(summary.charges))}`,
      `Пропущено целей: ${Math.max(0, toInteger(summary.skipped))}`,
      reasonList
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

function escapeAttribute(value) {
  return escapeHtml(value);
}

function getTreatmentResultLabel(resultKey) {
  if (resultKey === "criticalSuccess") return "критический успех";
  if (resultKey === "success") return "успех";
  if (resultKey === "criticalFailure") return "критический провал";
  return "провал";
}

function isSuccessfulSkillResult(resultKey = "") {
  return resultKey === "success" || resultKey === "criticalSuccess";
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

function getMedicineResolutionMode() {
  return getCraftingSettings().medicine.mode;
}

function getMedicineSkillResolution(
  actor,
  treatment = {},
  medicineMode = getMedicineResolutionMode()
) {
  return evaluateMedicineSkillResolution(actor, {
    skillKey: treatment.healingSkillKey,
    difficulty: Math.max(1, toInteger(treatment.healingDifficulty)),
    thresholdMode: isSkillThresholdMode(medicineMode)
  });
}

function getMedicineSkillThresholdMessage(resolution = {}, treatmentName = "") {
  const name = String(treatmentName ?? "").trim();
  const skillLabel = getHealingSkillLabel(resolution.skillKey) || "требуемого навыка";
  return `Для лечения${name ? ` «${name}»` : ""} нужно ${toInteger(resolution.difficulty)} ${skillLabel} (сейчас ${toInteger(resolution.skillValue)}).`;
}

function getMedicineInstallationSkillThresholdMessage(
  resolution = {},
  installationType = "",
  itemName = ""
) {
  const type = String(installationType ?? "").trim();
  const name = String(itemName ?? "").trim();
  const skillLabel = getHealingSkillLabel(resolution.skillKey) || "требуемого навыка";
  return `Для установки${type ? ` ${type}` : ""}${name ? ` «${name}»` : ""} нужно ${toInteger(resolution.difficulty)} ${skillLabel} (сейчас ${toInteger(resolution.skillValue)}).`;
}

function getActorItemsByType(actor, type = "") {
  const typed = actor?.itemTypes?.[type];
  if (Array.isArray(typed)) return typed;
  return actor?.items?.filter?.(item => item?.type === type)
    ?? Array.from(actor?.items ?? []).filter(item => item?.type === type);
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

function validateConfiguredMedicineToolKey(value = "") {
  const configured = String(
    getSystemActionSettings().find(entry => entry.key === "medicine")?.toolKey ?? "medical"
  ).trim() || "medical";
  if (
    configured.includes(".")
    || !getToolSettings().some(entry => entry.key === configured)
  ) {
    throw new Error("в настройках медицины указан некорректный тип инструмента");
  }
  const requested = String(value ?? configured).trim() || configured;
  if (requested !== configured) {
    throw new Error("тип медицинского инструмента не соответствует настройкам действия");
  }
  return configured;
}

function assertMedicineTokenMatchesActor(token = null, actor = null) {
  if (!token) return;
  if (
    token.documentName !== "Token"
    || !token.actor
    || String(token.actor.uuid ?? "") !== String(actor?.uuid ?? "")
  ) {
    throw new Error("токен не соответствует участнику медицины");
  }
}

function runWithMedicineAuthorityLocks(actors, operation, chainRef = null, index = 0) {
  const ordered = index === 0
    ? Array.from(new Map((actors ?? [])
      .filter(Boolean)
      .map(actor => [String(actor.uuid ?? actor.id ?? ""), actor]))
      .values())
      .sort((left, right) => String(left.uuid ?? left.id ?? "").localeCompare(String(right.uuid ?? right.id ?? "")))
    : actors;
  if (index >= ordered.length) return operation();
  return medicineAuthorityLock.run(
    ordered[index],
    chainRef,
    () => runWithMedicineAuthorityLocks(ordered, operation, chainRef, index + 1)
  );
}

function getResponsibleGM() {
  return game.users?.activeGM ?? null;
}

function isCurrentResponsibleGM(gm = getResponsibleGM()) {
  return Boolean(
    gm
    && game.user?.isGM
    && String(game.user.id ?? "") === String(gm.id ?? "")
  );
}
