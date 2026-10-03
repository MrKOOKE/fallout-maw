import { localize as auditLocalize, format as auditFormat } from "../utils/i18n.mjs";
import { SYSTEM_ID, TEMPLATES } from "../constants.mjs";
import { requestCustomActorTokenSelection } from "../canvas/custom-token-selection.mjs";
import { isActorAtPhysicalToken, getActorTargetName } from "../utils/actor-target-context.mjs";
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
import {
  applyToolSupplyCostPercent,
  getActorToolSupplyCostPercent
} from "../utils/tool-supply-cost.mjs";
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
import {
  GOOD_ENOUGH_NO_TOOL_ID,
  getGoodEnoughEnergyCost,
  getGoodEnoughHealingCapacity,
  isGoodEnoughHealingFree
} from "./medicine-good-enough.mjs";
import {
  getActorActiveFixedAbilityFunctionEntry,
  getActorFixedAbilityFunction,
  getActorFixedAbilityFunctionEntry,
  getActorPendingFixedAbilityFunctionEntry,
  getAbilityFixedFunctionState,
  getAbilityFixedFunctionStateKey
} from "../abilities/runtime-state.mjs";
import {
  ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY,
  ABILITY_FIXED_FUNCTION_KEYS,
  normalizeEmergencyOperationsSettings,
  normalizeExperimentalSurgerySettings,
  normalizeGoodEnoughSettings
} from "../settings/abilities.mjs";
import {
  ANATOMY_STUDY_BONUS_KEYS,
  getActorAnatomyStudyBonus
} from "../abilities/anatomy-study.mjs";
import {
  ENERGY_RESOURCE_KEY,
  canActorSpendEnergy,
  getActorAvailableEnergy,
  prepareActorEnergySpend,
  runActorEnergyMutation
} from "../combat/energy-resource.mjs";
import { analyzeMedicineToolAvailability } from "./medicine-tool-availability.mjs";
import {
  calculateExperimentalSurgeryPatientDamage,
  calculateExperimentalSurgerySupplyCost,
  getExperimentalSurgeryEffectiveToolClass,
  isExperimentalSurgeryTreatmentType,
  rollExperimentalSurgeryChance
} from "./medicine-experimental-surgery.mjs";
import {
  bindMassOperationDialogSubmitState,
  getMassOperationDialogSelectionState
} from "./mass-operation-dialog-state.mjs";
import { applyEmergencyOperationsToolEfficiency } from "./medicine-emergency-operations.mjs";
import {
  getCombatActionPointState,
  isActorInActiveCombat,
  refundCombatActionPointReceipt,
  spendCombatActionPointsWithReceipt
} from "../combat/reaction-resources.mjs";
import { notifyCombatResourcesSpent } from "../combat/resource-spending.mjs";

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

export async function requestMedicineTarget(sourceToken, sourceActor = sourceToken?.actor) {
  if (!sourceActor) return undefined;

  const action = getSystemActionSettings().find(entry => entry.key === "medicine");
  const selected = await requestCustomActorTokenSelection({
    sourceActor,
    sourceToken,
    includeSelf: true,
    title: auditLocalize("FALLOUTMAW.Events.Groups.medicine.Label", "Медицина"),
    noneWarning: auditLocalize("FALLOUTMAW.AuditApps.ThereAreNoSuitableMedicalTargets", "Нет подходящих целей для медицины."),
    instructions: auditLocalize("FALLOUTMAW.AuditApps.MedicineSelectATargetEscRightClickCancels", "Медицина: выберите цель. Esc/ПКМ отменяет.")
  });
  const targetToken = selected?.token ?? null;
  if (!selected?.actor || !targetToken) return undefined;

  const targetContext = await getMedicineTargetContext(targetToken, sourceActor, selected.actor);
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
    return auditLocalize("FALLOUTMAW.Events.Groups.medicine.Label", "Медицина");
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const combatAccess = getMedicineCombatOperationAccess(this.#sourceActor);
    const emergencyTreatment = getPendingEmergencyOperationsTreatment(this.#sourceActor);
    const medicineOperationsUsable = combatAccess.usable;
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
          medicineMode,
          medicineOperationsUsable,
          emergencyTreatment?.settings.toolEfficiencyPercentBonus ?? 0
        );
        hasMassTreatments = medicineOperationsUsable && hasMassTreatmentTargets(this.#targetContext);
      } else {
        diseases = prepareTargetTreatments(
          this.#targetContext?.diseases ?? [],
          instruments,
          this.#activeTreatmentType === "disease" ? this.#activeTreatmentId : "",
          instrumentRowsByClass,
          this.#sourceActor,
          medicineMode,
          medicineOperationsUsable,
          emergencyTreatment?.settings.toolEfficiencyPercentBonus ?? 0
        );
      }
    } else if (this.#activeTab === "implant") {
      implants = prepareImplantMedicineContext(
        this.#sourceActor,
        this.#targetContext,
        this.#activeImplantLimbKey,
        medicineOperationsUsable
      );
      this.#activeImplantLimbKey = implants.activeLimbKey;
    } else if (this.#activeTab === "prosthesis") {
      prostheses = prepareProsthesisMedicineContext(
        this.#sourceActor,
        this.#targetContext,
        this.#activeProsthesisLimbKey,
        medicineOperationsUsable
      );
      this.#activeProsthesisLimbKey = prostheses.activeLimbKey;
    }
    return {
      ...context,
      sourceActor: this.#sourceActor,
      isSelfTreatment: this.#isSelfTreatment(),
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
      medicineOperationsUsable,
      medicineCombatStatus: combatAccess.inCombat ? {
        blocked: !combatAccess.usable,
        icon: combatAccess.usable ? "fa-solid fa-bolt" : "fa-solid fa-ban",
        text: combatAccess.message
      } : null,
      emergencyTreatmentStatus: emergencyTreatment ? {
        bonus: emergencyTreatment.settings.toolEfficiencyPercentBonus,
        text: auditFormat("FALLOUTMAW.AuditApps.NextTreatmentWithThisToolEffectiveness", { v0: (formatNumber(emergencyTreatment.settings.toolEfficiencyPercentBonus)) }, "Следующее лечение инструментом: +{v0}% эффективности")
      } : null,
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
    return Boolean(this.#sourceActor?.uuid && this.#targetContext?.actorUuid === this.#sourceActor.uuid);
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
      ui.notifications.error(auditFormat("FALLOUTMAW.AuditApps.MedicalOperationFailed", { v0: (error.message) }, "Медицинская операция не выполнена: {v0}"));
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
        ui.notifications.info(auditLocalize("FALLOUTMAW.AuditApps.WaitingAgainForTheBulkTreatmentAlreadyIn", "Повторное ожидание уже запущенного массового лечения."));
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

async function getMedicineTargetContext(targetToken, sourceActor = null, targetActor = targetToken?.actor) {
  const actor = targetActor;
  if (!actor) return null;
  if (canUseActorLocally(actor)) return buildTargetContext(actor, targetToken);

  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn(auditLocalize("FALLOUTMAW.AuditApps.ThereIsNoActiveGMToAccessThe", "Нет активного GM для доступа к цели медицины."));
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
    ui.notifications.error(auditFormat("FALLOUTMAW.AuditApps.FailedToRetrieveMedicalTargetData", { v0: (error.message) }, "Не удалось получить данные цели медицины: {v0}"));
    return null;
  }
}

function getActorGoodEnoughSettings(sourceActor) {
  const entry = getActorFixedAbilityFunction(sourceActor, ABILITY_FIXED_FUNCTION_KEYS.goodEnough);
  return entry ? normalizeGoodEnoughSettings(entry.fixedSettings) : null;
}

function getMedicineCombatOperationAccess(sourceActor) {
  if (!isActorInActiveCombat(sourceActor)) {
    return { inCombat: false, allowed: true, usable: true, cost: 0, entry: null, settings: null, message: "" };
  }
  const entry = getActorFixedAbilityFunctionEntry(
    sourceActor,
    ABILITY_FIXED_FUNCTION_KEYS.emergencyOperations
  );
  if (!entry) {
    return {
      inCombat: true,
      allowed: false,
      usable: false,
      cost: 0,
      entry: null,
      settings: null,
      message: auditLocalize("FALLOUTMAW.AuditApps.MedicalOperationsAreBlockedDuringCombat", "Медицинские операции в бою заблокированы.")
    };
  }
  const settings = normalizeEmergencyOperationsSettings(entry.abilityFunction.fixedSettings);
  const cost = settings.combatActionPointCost;
  const actionPointState = getCombatActionPointState(sourceActor);
  const usable = cost <= 0 || Boolean(actionPointState && actionPointState.value >= cost);
  return {
    inCombat: true,
    allowed: true,
    usable,
    cost,
    entry,
    settings,
    actionPointState,
    message: usable
      ? auditFormat("FALLOUTMAW.AuditApps.EmergencyOperationsEachMedicalOperationCosts", { v0: (cost), v1: (actionPointState?.label ?? auditLocalize("FALLOUTMAW.Common.ActionPointsShort", "ОД")) }, "Экстренные операции: каждая медицинская операция стоит {v0} {v1}.")
      : auditFormat("FALLOUTMAW.AuditApps.NotEnoughTheMedicalOperationRequires", { v0: (actionPointState?.label ?? auditLocalize("FALLOUTMAW.Common.ActionPointsShort", "ОД")), v1: (cost) }, "Недостаточно {v0}: для медицинской операции требуется {v1}.")
  };
}

function getPendingEmergencyOperationsTreatment(sourceActor) {
  const entry = getActorPendingFixedAbilityFunctionEntry(
    sourceActor,
    ABILITY_FIXED_FUNCTION_KEYS.emergencyOperations
  );
  if (!entry) return null;
  return {
    ...entry,
    settings: normalizeEmergencyOperationsSettings(entry.abilityFunction.fixedSettings)
  };
}

async function executeMedicineCombatOperation(sourceActor, {
  label = auditLocalize("FALLOUTMAW.AuditApps.MedicalOperation", "медицинской операции"),
  operation,
  didStart = () => true
} = {}) {
  if (typeof operation !== "function") throw new TypeError("Medicine operation callback is required.");
  const access = getMedicineCombatOperationAccess(sourceActor);
  if (!access.allowed) throw new Error(access.message);
  if (!access.usable) throw new Error(access.message);
  if (!access.inCombat || access.cost <= 0) return operation();

  const transaction = await spendCombatActionPointsWithReceipt(sourceActor, access.cost, {
    suppressResourceNotification: true,
    label
  });
  if (transaction.spent !== access.cost) {
    throw new Error(auditFormat("FALLOUTMAW.AuditApps.FailedToSpendAPOn", { v0: (access.cost), v1: (label) }, "Не удалось потратить {v0} ОД для {v1}."));
  }

  let result;
  try {
    result = await operation();
  } catch (error) {
    await refundCombatActionPointReceipt(sourceActor, transaction.receipt, { label });
    throw error;
  }
  if (!didStart(result)) {
    await refundCombatActionPointReceipt(sourceActor, transaction.receipt, { label });
    return result;
  }
  if (transaction.receipt?.resourceKey) {
    await notifyCombatResourcesSpent(sourceActor, {
      [transaction.receipt.resourceKey]: transaction.spent
    }, { label });
  }
  return result;
}

function getActorSpendableEnergy(actor) {
  const minimum = Math.max(0, toInteger(actor?.system?.resources?.[ENERGY_RESOURCE_KEY]?.min));
  return Math.max(0, getActorAvailableEnergy(actor) - minimum);
}

function getGoodEnoughNoToolInstrument(
  limb,
  settings,
  skillRequirementMet = true,
  energy = 0,
  energyCapacity = 0,
  medicineOperationsUsable = true
) {
  const free = isGoodEnoughHealingFree(limb, settings);
  const usable = medicineOperationsUsable && skillRequirementMet && (free || energy > 0);
  return {
    id: GOOD_ENOUGH_NO_TOOL_ID,
    name: auditLocalize("FALLOUTMAW.AuditApps.GoodEnoughWithoutTools", "И так сойдет — без инструмента"),
    img: "systems/fallout-maw/assets/System/Abilities/ability-default.webp",
    toolLabel: auditLocalize("FALLOUTMAW.AuditApps.GoodEnough", "И так сойдет"),
    toolClass: "D",
    efficiency: 100,
    efficiencyLabel: "100%",
    classAccepted: true,
    usable,
    requirementMet: true,
    skillRequirement: free
      ? auditFormat("FALLOUTMAW.AuditApps.FreeConditionAbove", { v0: (settings.freeConditionThreshold) }, "Бесплатно: состояние выше {v0}%")
      : auditFormat("FALLOUTMAW.AuditApps.1EnergyHealth", { v0: (settings.healthPerEnergy) }, "1 энергия = {v0} здоровья"),
    supplyValue: free ? "∞" : energy,
    supplyMax: free ? "∞" : energyCapacity,
    noTool: true,
    free
  };
}

function prepareLimbTreatmentGroups(
  targetContext,
  instruments,
  activeTreatmentType = "trauma",
  activeTreatmentId = "",
  instrumentRowsByClass = new Map(),
  sourceActor = null,
  medicineMode = getMedicineResolutionMode(),
  medicineOperationsUsable = true,
  emergencyEfficiencyBonus = 0
) {
  const goodEnoughSettings = getActorGoodEnoughSettings(sourceActor);
  const goodEnoughEnergy = goodEnoughSettings ? getActorSpendableEnergy(sourceActor) : 0;
  const energyResource = goodEnoughSettings
    ? sourceActor?.system?.resources?.[ENERGY_RESOURCE_KEY]
    : null;
  const goodEnoughEnergyCapacity = energyResource
    ? Math.max(0, toInteger(energyResource.max) - toInteger(energyResource.min))
    : 0;
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
      medicineMode,
      medicineOperationsUsable,
      emergencyEfficiencyBonus
    );
    const [limbTreatment] = prepareTargetTreatments(
      [limb],
      instruments,
      activeTreatmentType === "limb" ? activeTreatmentId : "",
      instrumentRowsByClass,
      sourceActor,
      medicineMode,
      medicineOperationsUsable,
      emergencyEfficiencyBonus
    );
    if (!limbTreatment || (!limb.damaged && !traumas.length)) continue;
    if (goodEnoughSettings) {
      limbTreatment.availableInstruments = [
        ...(limbTreatment.availableInstruments ?? []),
        getGoodEnoughNoToolInstrument(
          limb,
          goodEnoughSettings,
          limbTreatment.treatable && limbTreatment.treatmentSkillThresholdMet,
          goodEnoughEnergy,
          goodEnoughEnergyCapacity,
          medicineOperationsUsable
        )
      ];
    }
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
    medicineMode,
    medicineOperationsUsable,
    emergencyEfficiencyBonus
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
  medicineMode = getMedicineResolutionMode(),
  medicineOperationsUsable = true,
  emergencyEfficiencyBonus = 0
) {
  return treatments.map(treatment => {
    const requiredClass = String(treatment.healingToolClass ?? "D");
    const experimentalSurgery = getActorExperimentalSurgeryContext(sourceActor, treatment?.type);
    const allowedToolClassDeficit = experimentalSurgery?.settings.allowedToolClassDeficit ?? 0;
    const effectiveToolClass = getExperimentalSurgeryEffectiveToolClass(
      requiredClass,
      allowedToolClassDeficit
    );
    const instrumentCacheKey = `${requiredClass}:${allowedToolClassDeficit}:${emergencyEfficiencyBonus}`;
    let baseInstrumentRows = instrumentRowsByClass.get(instrumentCacheKey);
    if (!baseInstrumentRows) {
      baseInstrumentRows = instruments.map(instrument => {
        const classAccepted = isToolClassAccepted(
          instrument.toolClass,
          requiredClass,
          allowedToolClassDeficit
        );
        const efficiency = applyEmergencyOperationsToolEfficiency(
          calculateBaseEfficiency(instrument.toolClass, requiredClass),
          emergencyEfficiencyBonus
        );
        return {
          ...instrument,
          efficiency,
          efficiencyLabel: `${formatNumber(efficiency)}%`,
          classAccepted,
          usable: classAccepted && instrument.supplyValue > 0 && instrument.requirementMet
        };
      });
      instrumentRowsByClass.set(instrumentCacheKey, baseInstrumentRows);
    }
    const skillResolution = getMedicineSkillResolution(sourceActor, treatment, medicineMode);
    const hasTreatmentEnergy = !experimentalSurgery
      || canActorSpendEnergy(sourceActor, experimentalSurgery.settings.treatmentEnergyCost);
    const availableInstruments = baseInstrumentRows.map(instrument => ({
      ...instrument,
      treatmentSkillThresholdMet: skillResolution.met,
      usable: instrument.usable && skillResolution.met && hasTreatmentEnergy && medicineOperationsUsable,
      unavailableReason: !medicineOperationsUsable
        ? auditLocalize("FALLOUTMAW.AuditApps.TheMedicalOperationIsCurrentlyUnavailable", "Медицинская операция сейчас недоступна.")
        : !hasTreatmentEnergy
        ? auditFormat("FALLOUTMAW.AuditApps.RequiresEnergy", { v0: (experimentalSurgery.settings.treatmentEnergyCost) }, "Нужно {v0} энергии.")
        : ""
    }));
    const treatable = treatment.treatable !== false
      && toInteger(treatment.healingProgress) < Math.max(1, toInteger(treatment.healingProgressMax));
    return {
      ...treatment,
      healingToolClassOriginal: requiredClass,
      healingToolClassEffective: effectiveToolClass,
      healingToolClassReduced: effectiveToolClass !== requiredClass,
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
        skillRequirement: skillKey ? `${skillValue} ${skillLabel}` : auditLocalize("FALLOUTMAW.AuditApps.NoSkill", "Без навыка"),
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
    ui.notifications.warn(auditLocalize("FALLOUTMAW.AuditApps.ThereAreNoTraumasOrDamagedBodyParts", "Нет травм или повреждённых частей тела для массового лечения."));
    return null;
  }

  const availability = getMassTreatmentAvailability(sourceActor, targetContext, toolKey);
  if (!availability.ok) {
    ui.notifications.warn(availability.message);
    return null;
  }
  const instruments = availability.instruments;

  const toolGroups = groupToolSelectionOptions(instruments);
  const instrumentRows = toolGroups.map(group => auditFormat("FALLOUTMAW.AuditApps.ClassItemsTotalSupplies", { v0: (escapeAttribute(group.key)), v1: (escapeHtml(group.toolLabel)), v2: (escapeHtml(group.toolClass)), v3: (group.count), v4: (group.supplyValue), v5: (group.supplyMax) }, "\n    <label class=\"fallout-maw-mass-operation-instrument\">\n      <input type=\"checkbox\" name=\"toolGroup\" value=\"{v0}\" checked>\n      <span>{v1}</span>\n      <strong>Класс {v2}</strong>\n      <em>{v3} шт., общий запас {v4}/{v5}</em>\n    </label>\n  ")).join("");
  const content = auditFormat("FALLOUTMAW.AuditApps.TreatmentIsPerformedSequentiallyTraumasFirstThenBody", { v0: (counts.traumas > 0 ? "checked" : "disabled"), v1: (counts.traumas), v2: (counts.limbHealth > 0 ? "checked" : "disabled"), v3: (counts.limbHealth), v4: (instrumentRows) }, "\n    <div class=\"fallout-maw-mass-operation-dialog fallout-maw-mass-treatment-dialog\">\n      <p>Лечение выполняется последовательно: сначала травмы, затем здоровье частей тела.</p>\n      <div class=\"fallout-maw-mass-operation-categories\">\n        <label>\n          <input type=\"checkbox\" name=\"includeTraumas\" {v0}>\n          <span>Лечить травмы</span>\n          <strong>{v1}</strong>\n        </label>\n        <label>\n          <input type=\"checkbox\" name=\"includeLimbHealth\" {v2}>\n          <span>Восстанавливать здоровье частей тела</span>\n          <strong>{v3}</strong>\n        </label>\n      </div>\n      <fieldset class=\"fallout-maw-mass-operation-modes\">\n        <legend>Выбор класса</legend>\n        <label>\n          <input type=\"radio\" name=\"qualityMode\" value=\"matched\" checked>\n          <span>Минимально достаточный класс</span>\n        </label>\n        <label>\n          <input type=\"radio\" name=\"qualityMode\" value=\"best\">\n          <span>Лучший доступный класс</span>\n        </label>\n      </fieldset>\n      <fieldset class=\"fallout-maw-mass-operation-modes\">\n        <legend>Распределение запаса</legend>\n        <label>\n          <input type=\"radio\" name=\"supplyMode\" value=\"depleted\" checked>\n          <span>Сначала наиболее израсходованные наборы</span>\n        </label>\n        <label>\n          <input type=\"radio\" name=\"supplyMode\" value=\"balanced\">\n          <span>Выравнивать остаток между наборами</span>\n        </label>\n      </fieldset>\n      <div class=\"fallout-maw-mass-operation-instruments\">\n        {v4}\n      </div>\n    </div>\n  ");

  return DialogV2.input({
    modal: true,
    window: { title: auditLocalize("FALLOUTMAW.AuditApps.BulkTreatment", "Массовое лечение") },
    content,
    render: (_event, dialog) => bindMassOperationDialogSubmitState(dialog, {
      categoryNames: ["includeTraumas", "includeLimbHealth"]
    }),
    ok: {
      label: auditLocalize("FALLOUTMAW.AuditApps.StartTreatment", "Начать лечение"),
      icon: "fa-solid fa-kit-medical",
      callback: (_event, button) => {
        const form = button.form;
        const selectionState = getMassOperationDialogSelectionState(form, {
          categoryNames: ["includeTraumas", "includeLimbHealth"]
        });
        if (!selectionState.hasCategorySelection) {
          ui.notifications.warn(auditLocalize("FALLOUTMAW.AuditApps.SelectTraumasBodyPartHealthOrBoth", "Выберите травмы, здоровье частей тела или оба варианта."));
          return "cancel";
        }
        const includeTraumas = Boolean(form.querySelector("input[name='includeTraumas']")?.checked);
        const includeLimbHealth = Boolean(form.querySelector("input[name='includeLimbHealth']")?.checked);
        const allowedToolGroupKeys = Array.from(form.querySelectorAll("input[name='toolGroup']:checked"))
          .map(input => String(input.value ?? "").trim())
          .filter(Boolean);
        if (!selectionState.hasToolGroupSelection || !allowedToolGroupKeys.length) {
          ui.notifications.warn(auditLocalize("FALLOUTMAW.AuditApps.SelectAtLeastOneGroupOfMedicalTools", "Выберите хотя бы одну группу медицинских инструментов."));
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
    buttons: [{ action: "cancel", label: auditLocalize("FALLOUTMAW.Common.Cancel", "Отмена") }],
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
    requiredToolClass: treatment?.healingToolClass,
    allowedToolClassDeficit: getActorExperimentalSurgeryContext(sourceActor, treatment?.type)
      ?.settings.allowedToolClassDeficit ?? 0
  }, normalizedOptions);
  return selected
    ? { instrumentId: selected.id }
    : { reason: auditLocalize("FALLOUTMAW.AuditApps.TheSelectedMedicalToolsAreNoLongerSuitable", "Выбранные медицинские инструменты больше не подходят для этой цели.") };
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
  const experimentalSurgery = getActorExperimentalSurgeryContext(sourceActor, treatment?.type);
  return {
    ...treatment,
    allowedToolClassDeficit: experimentalSurgery?.settings.allowedToolClassDeficit ?? 0,
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

function prepareProsthesisMedicineContext(sourceActor, targetContext, activeLimbKey = "", medicineOperationsUsable = true) {
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
        usable: medicineOperationsUsable && !limb.prosthesis && limb.missing && isProsthesisSnapshotInstallable(item),
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
        ? auditFormat("FALLOUTMAW.AuditApps.Prosthesis", { v0: (limb.prosthesis.name) }, "Протез: {v0}")
        : auditLocalize("FALLOUTMAW.Item.FunctionNone", "Отсутствует"),
      conditionLabel: limb.prosthesis?.conditionLabel ?? "",
      displayValue: limb.prosthesis ? (limb.prosthesis.hasCondition ? limb.prosthesis.conditionValue : "∞") : auditLocalize("FALLOUTMAW.Item.FunctionNone", "Отсутствует"),
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

function prepareImplantMedicineContext(sourceActor, targetContext, activeLimbKey = "", medicineOperationsUsable = true) {
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
        usable: medicineOperationsUsable && slotsAvailable && isImplantSnapshotInstallable(item),
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
      statusLabel: auditFormat("FALLOUTMAW.AuditApps.Implants", { v0: (installed.length), v1: (implantLimit) }, "Импланты: {v0} / {v1}"),
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
    ui.notifications.warn(auditFormat("FALLOUTMAW.AuditApps.YouDoNotHavePermissionToUseS", { v0: (sourceActor?.name ?? "") }, "Нет прав на использование инструментов {v0}."));
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
    experimentalSurgery = null,
    emergencyOperations = null,
    reason = "",
    alreadyHealed = false
  } = resolution;
  if (alreadyHealed) {
    await postMedicineChat(sourceActor, {
      title: auditLocalize("FALLOUTMAW.Events.Groups.medicine.Label", "Медицина"),
      tone: "success",
      lines: [auditFormat("FALLOUTMAW.AuditApps.HasAlreadyBeenTreated", { v0: (treatment?.name ?? auditLocalize("FALLOUTMAW.AuditApps.TreatmentTarget", "Цель лечения")) }, "\"{v0}\" уже вылечено.")]
    });
    return { targetContext: updatedTargetContext ?? targetContext };
  }
  if (!entries.length) {
    await postMedicineChat(sourceActor, {
      title: auditFormat("FALLOUTMAW.AuditApps.Treatment", { v0: (treatment?.name ?? auditLocalize("FALLOUTMAW.AuditApps.Target", "цель")) }, "Лечение: {v0}"),
      tone: "failure",
      lines: [reason || auditLocalize("FALLOUTMAW.AuditApps.TreatmentFailed", "Лечение не выполнено.")]
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
    completed,
    experimentalSurgery,
    emergencyOperations
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
    ui.notifications.warn(auditFormat("FALLOUTMAW.AuditApps.YouDoNotHavePermissionToUseS", { v0: (sourceActor?.name ?? "") }, "Нет прав на использование инструментов {v0}."));
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
    ui.notifications.warn(auditLocalize("FALLOUTMAW.AuditApps.FailedToIdentifyTheBulkTreatmentTarget", "Не удалось определить цель массового лечения."));
    return null;
  }
  const normalizedOptions = normalizeMassTreatmentOptions(options);
  const stableRequestId = String(requestId ?? "").trim();
  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn(auditLocalize("FALLOUTMAW.AuditApps.ThereIsNoActiveGMForBulkTreatment", "Нет активного GM для массового лечения."));
    return null;
  }
  if (isCurrentResponsibleGM(gm)) {
    try {
      const actor = await fromUuid(actorUuid);
      if (!actor || String(actor.uuid ?? "") !== actorUuid) {
        throw new Error(auditLocalize("FALLOUTMAW.AuditApps.BulkTreatmentTargetNotFound", "цель массового лечения не найдена"));
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
      ui.notifications.error(auditFormat("FALLOUTMAW.AuditApps.FailedToPerformBulkTreatment", { v0: (error.message) }, "Не удалось выполнить массовое лечение: {v0}"));
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
      ui.notifications.warn(auditLocalize("FALLOUTMAW.AuditApps.TheGMIsContinuingBulkTreatmentClickingAgain", "GM продолжает массовое лечение. Повторное нажатие будет ожидать ту же операцию."));
      return { pending: true, requestId: stableRequestId };
    }
    ui.notifications.error(auditFormat("FALLOUTMAW.AuditApps.FailedToPerformBulkTreatment", { v0: (error.message) }, "Не удалось выполнить массовое лечение: {v0}"));
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
  if (!sourceActor || !targetActor) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.BulkTreatmentParticipantsNotFound", "участники массового лечения не найдены"));
  const normalizedToolKey = validateConfiguredMedicineToolKey(toolKey);

  const normalizedOptions = normalizeMassTreatmentOptions(options);
  if (!normalizedOptions.includeTraumas && !normalizedOptions.includeLimbHealth) {
    throw new Error(auditLocalize("FALLOUTMAW.AuditApps.SelectAtLeastOneTypeOfBulkTreatment", "Выберите хотя бы один вид массового лечения."));
  }
  if (!normalizedOptions.allowedToolGroupKeys.length) {
    throw new Error(auditLocalize("FALLOUTMAW.AuditApps.SelectAtLeastOneGroupOfMedicalTools", "Выберите хотя бы одну группу медицинских инструментов."));
  }

  const initialContext = buildTargetContext(targetActor, targetToken);
  if (!canActorReceiveHealing(targetActor)) {
    return {
      targetContext: initialContext,
      summary: createEmptyMassTreatmentSummary(initialContext, normalizedOptions, {
        stopped: true,
        reason: auditLocalize("FALLOUTMAW.AuditApps.TheTargetCannotReceiveTreatmentRightNow", "Цель сейчас не может получать лечение.")
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
  reason = auditLocalize("FALLOUTMAW.AuditApps.TreatmentFailed", "Лечение не выполнено.")
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
    reason: String(reason || auditLocalize("FALLOUTMAW.AuditApps.TreatmentFailed", "Лечение не выполнено."))
  };
}

async function performImplantInstallation({ sourceActor, sourceToken = null, targetContext, targetToken = null, limbKey = "", implantSource = "", itemId = "" } = {}) {
  if (!sourceActor?.isOwner && !game.user?.isGM) {
    ui.notifications.warn(auditFormat("FALLOUTMAW.AuditApps.YouDoNotHavePermissionToUseS_559", { v0: (sourceActor?.name ?? "") }, "Нет прав на использование инвентаря {v0}."));
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

  const title = auditFormat("FALLOUTMAW.AuditApps.ImplantInstallation", { v0: (resolution.itemName ?? auditLocalize("FALLOUTMAW.AuditApps.Implant", "имплант")) }, "Установка импланта: {v0}");
  if (resolution.resultKey === "criticalFailure") {
    await postMedicineChat(sourceActor, {
      title,
      tone: "failure",
      lines: [resolution.criticalDamage > 0
        ? auditFormat("FALLOUTMAW.AuditApps.CriticalFailureTheImplantTookDamageAndWas", { v0: (resolution.criticalDamage) }, "Критический провал. Имплант повреждён на {v0} и не установлен.")
        : auditLocalize("FALLOUTMAW.AuditApps.CriticalFailureTheImplantWasNotInstalled", "Критический провал. Имплант не установлен.")]
    });
    return { targetContext: resolution.targetContext ?? targetContext };
  }
  if (!isSuccessfulSkillResult(resolution.resultKey)) {
    await postMedicineChat(sourceActor, {
      title,
      tone: "failure",
      lines: [resolution.reason || auditLocalize("FALLOUTMAW.AuditApps.CheckFailedTheImplantWasNotInstalled", "Проверка провалена. Имплант не установлен.")]
    });
    return { targetContext: resolution.targetContext ?? targetContext };
  }

  await postMedicineChat(sourceActor, {
    title,
    tone: "success",
    lines: [auditFormat("FALLOUTMAW.AuditApps.AnImplantWasInstalledIn", { v0: (resolution.targetName ?? targetContext?.name ?? auditLocalize("FALLOUTMAW.Research.Target", "Цель")), v1: (resolution.limbLabel ?? getTargetLimbLabel(targetContext, limbKey)) }, "{v0}: {v1} получила имплант.")]
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
  const targetActor = await fromUuid(targetActorUuid);
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
    ui.notifications.warn(auditLocalize("FALLOUTMAW.AuditApps.ThereIsNoActiveGMToInstallThe", "Нет активного GM для установки импланта."));
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
    ui.notifications.error(auditFormat("FALLOUTMAW.AuditApps.FailedToInstallTheImplant", { v0: (error.message) }, "Не удалось выполнить установку импланта: {v0}"));
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
  if (!sourceActor || !targetActor) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.ImplantInstallationParticipantsNotFound", "участники установки импланта не найдены"));
  if (!["source", "target"].includes(implantSource)) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.InvalidImplantSource", "некорректный источник импланта"));

  const targetContext = buildTargetContext(targetActor, targetToken);
  const targetLimb = targetContext.limbs.find(limb => limb.key === limbKey);
  if (!targetLimb) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.BodyPartForImplantInstallationNotFound", "часть тела для установки импланта не найдена"));
  const implantLimit = Math.max(0, toInteger(targetLimb.implantLimit));
  if ((targetLimb.implants ?? []).length >= implantLimit) {
    throw new Error(auditLocalize("FALLOUTMAW.AuditApps.TheSelectedBodyPartHasNoFreeImplant", "на выбранной части тела нет свободного места для импланта"));
  }

  const sourceContainer = implantSource === "source" ? sourceActor : targetActor;
  const implant = sourceContainer.items?.get(String(itemId ?? ""));
  if (!implant || implant.type !== "gear" || !isImplantForLimb(implant, limbKey)) {
    throw new Error(auditLocalize("FALLOUTMAW.AuditApps.ImplantNotFoundOrIncompatibleWithTheSelected", "имплант не найден или не подходит к выбранной части тела"));
  }
  if (!isImplantItemInstallable(implant)) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.ABrokenImplantCannotBeInstalled", "сломанный имплант нельзя установить"));

  const data = getImplantFunction(implant);
  const skillKey = String(data.skillKey ?? "doctor") || "doctor";
  const difficulty = Math.max(0, toInteger(data.difficulty ?? 60));
  const skillResolution = await executeMedicineCombatOperation(sourceActor, {
    label: auditLocalize("FALLOUTMAW.AuditApps.ImplantInstallation_575", "установки импланта"),
    operation: () => resolveMedicineSkillAction(sourceActor, {
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
    }),
    didStart: resolution => Boolean(resolution?.met && resolution?.outcome)
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
        auditLocalize("FALLOUTMAW.AuditApps.Implant_576", "импланта"),
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
  const targetActor = await fromUuid(targetActorUuid);
  const sourceActorUuid = sourceActor?.uuid ?? "";
  const sourceActorDocument = sourceActorUuid ? await fromUuid(sourceActorUuid) : sourceActor;
  if (
    targetActor
    && String(targetActor.uuid ?? "") === targetActorUuid
    && sourceActorDocument
    && canUseActorLocally(targetActor)
    && canUseActorLocally(sourceActorDocument)
  ) {
    return resolveImplantRemovalOnAuthority({
      sourceActor: sourceActorDocument,
      targetActor,
      targetToken,
      limbKey,
      itemId
    });
  }
  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn(auditLocalize("FALLOUTMAW.AuditApps.ThereIsNoActiveGMToRemoveThe", "Нет активного GM для снятия импланта."));
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

async function resolveImplantRemovalOnAuthority(args = {}) {
  return runWithMedicineAuthorityLocks(
    [args.sourceActor, args.targetActor],
    () => executeMedicineCombatOperation(args.sourceActor, {
      label: auditLocalize("FALLOUTMAW.AuditApps.ImplantRemoval", "извлечения импланта"),
      operation: () => applyImplantRemovalLocally(args)
    })
  );
}

async function applyImplantInstallLocally({ sourceActor, targetActor, limbKey = "", implantSource = "", itemId = "" } = {}) {
  const sourceContainer = implantSource === "source" ? sourceActor : targetActor;
  const item = sourceContainer?.items?.get(itemId);
  if (!item || item.type !== "gear" || !isImplantForLimb(item, limbKey)) {
    throw createTreatmentStaleError(auditLocalize("FALLOUTMAW.AuditApps.TheImplantHasChangedOrIsNoLonger", "Имплант изменился или больше не доступен."));
  }
  if (!isImplantItemInstallable(item)) {
    throw createTreatmentStaleError(auditLocalize("FALLOUTMAW.AuditApps.TheImplantBrokeBeforeInstallationWasCompleted", "Имплант сломан до завершения установки."));
  }

  const implantLimit = getActorLimbImplantLimit(targetActor, limbKey);
  const installedBefore = getInstalledTargetImplants(targetActor, limbKey).length;
  if (installedBefore >= implantLimit) {
    throw createTreatmentStaleError(auditLocalize("FALLOUTMAW.AuditApps.TheFreeImplantSpaceIsAlreadyOccupied", "Свободное место для импланта уже занято."));
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
      throw new Error(auditLocalize("FALLOUTMAW.AuditApps.FoundryDidNotConfirmImplantInstallation", "Foundry не подтвердил установку импланта."));
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
    throw new Error(auditLocalize("FALLOUTMAW.AuditApps.FoundryDidNotConfirmImplantInstallation", "Foundry не подтвердил установку импланта."));
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
  ) throw createTreatmentStaleError(auditLocalize("FALLOUTMAW.AuditApps.TheInstalledImplantHasChangedOrHasAlready", "Установленный имплант изменился или уже снят."));

  const receivingActor = sourceActor && sourceActor.uuid !== targetActor.uuid ? sourceActor : targetActor;
  const returnPlan = planActorInventoryGrant(receivingActor, createReturnedImplantItemData(item), {
    quantity: 1,
    merge: false
  });
  if (!returnPlan) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.TheRecipientSInventoryHasNoSpaceFor", "В инвентаре получателя нет места для снятого импланта."));
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
    throw createTreatmentStaleError(auditLocalize("FALLOUTMAW.AuditApps.TheImplantChangedBeforeTheCriticalFailureWas", "Имплант изменился до применения критического провала."));
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
    ui.notifications.warn(auditFormat("FALLOUTMAW.AuditApps.YouDoNotHavePermissionToUseS_559", { v0: (sourceActor?.name ?? "") }, "Нет прав на использование инвентаря {v0}."));
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

  const title = auditFormat("FALLOUTMAW.AuditApps.ProsthesisInstallation", { v0: (resolution.itemName ?? auditLocalize("FALLOUTMAW.AuditApps.Prosthesis_587", "протез")) }, "Установка протеза: {v0}");
  if (resolution.resultKey === "criticalFailure") {
    await postMedicineChat(sourceActor, {
      title,
      tone: "failure",
      lines: [resolution.criticalDamage > 0
        ? auditFormat("FALLOUTMAW.AuditApps.CriticalFailureTheProsthesisTookDamageAndWas", { v0: (resolution.criticalDamage) }, "Критический провал. Протез повреждён на {v0} и не установлен.")
        : auditLocalize("FALLOUTMAW.AuditApps.CriticalFailureTheProsthesisWasNotInstalled", "Критический провал. Протез не установлен.")]
    });
    return { targetContext: resolution.targetContext ?? targetContext };
  }
  if (!isSuccessfulSkillResult(resolution.resultKey)) {
    await postMedicineChat(sourceActor, {
      title,
      tone: "failure",
      lines: [resolution.reason || auditLocalize("FALLOUTMAW.AuditApps.CheckFailedTheProsthesisWasNotInstalled", "Проверка провалена. Протез не установлен.")]
    });
    return { targetContext: resolution.targetContext ?? targetContext };
  }

  await postMedicineChat(sourceActor, {
    title,
    tone: "success",
    lines: [auditFormat("FALLOUTMAW.AuditApps.WasReplacedWithAProsthesis", { v0: (resolution.targetName ?? targetContext?.name ?? auditLocalize("FALLOUTMAW.Research.Target", "Цель")), v1: (resolution.limbLabel ?? getTargetLimbLabel(targetContext, limbKey)) }, "{v0}: {v1} заменена протезом.")]
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
  const targetActor = await fromUuid(targetActorUuid);
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
    ui.notifications.warn(auditLocalize("FALLOUTMAW.AuditApps.ThereIsNoActiveGMToInstallThe_592", "Нет активного GM для установки протеза."));
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
    ui.notifications.error(auditFormat("FALLOUTMAW.AuditApps.FailedToInstallTheProsthesis", { v0: (error.message) }, "Не удалось выполнить установку протеза: {v0}"));
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
  if (!sourceActor || !targetActor) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.ProsthesisInstallationParticipantsNotFound", "участники установки протеза не найдены"));
  if (!["source", "target"].includes(prosthesisSource)) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.InvalidProsthesisSource", "некорректный источник протеза"));

  const targetContext = buildTargetContext(targetActor, targetToken);
  const targetLimb = targetContext.limbs.find(limb => limb.key === limbKey);
  if (!targetLimb) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.BodyPartForProsthesisInstallationNotFound", "часть тела для установки протеза не найдена"));
  if (!targetLimb.missing || targetLimb.prosthesis) {
    throw new Error(auditLocalize("FALLOUTMAW.AuditApps.AProsthesisCanOnlyBeInstalledInAn", "протез можно установить только на отсутствующую свободную часть тела"));
  }

  const sourceContainer = prosthesisSource === "source" ? sourceActor : targetActor;
  const prosthesis = sourceContainer.items?.get(String(itemId ?? ""));
  if (!prosthesis || prosthesis.type !== "gear" || !isProsthesisForLimb(prosthesis, limbKey)) {
    throw new Error(auditLocalize("FALLOUTMAW.AuditApps.ProsthesisNotFoundOrIncompatibleWithTheSelected", "протез не найден или не подходит к выбранной части тела"));
  }
  if (!isProsthesisItemInstallable(prosthesis)) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.ABrokenProsthesisCannotBeInstalled", "сломанный протез нельзя установить"));

  const data = getProsthesisFunction(prosthesis);
  const skillKey = String(data.skillKey ?? "doctor") || "doctor";
  const difficulty = Math.max(0, toInteger(data.difficulty ?? 60));
  const skillResolution = await executeMedicineCombatOperation(sourceActor, {
    label: auditLocalize("FALLOUTMAW.AuditApps.ProsthesisInstallation_600", "установки протеза"),
    operation: () => resolveMedicineSkillAction(sourceActor, {
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
    }),
    didStart: resolution => Boolean(resolution?.met && resolution?.outcome)
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
        auditLocalize("FALLOUTMAW.AuditApps.Prosthesis_601", "протеза"),
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
  const targetActor = await fromUuid(targetActorUuid);
  const sourceActorUuid = sourceActor?.uuid ?? "";
  const sourceActorDocument = sourceActorUuid ? await fromUuid(sourceActorUuid) : sourceActor;
  if (
    targetActor
    && String(targetActor.uuid ?? "") === targetActorUuid
    && sourceActorDocument
    && canUseActorLocally(targetActor)
    && canUseActorLocally(sourceActorDocument)
  ) {
    return resolveProsthesisRemovalOnAuthority({
      sourceActor: sourceActorDocument,
      targetActor,
      targetToken,
      limbKey,
      itemId
    });
  }
  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn(auditLocalize("FALLOUTMAW.AuditApps.ThereIsNoActiveGMToRemoveThe_602", "Нет активного GM для снятия протеза."));
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

async function resolveProsthesisRemovalOnAuthority(args = {}) {
  return runWithMedicineAuthorityLocks(
    [args.sourceActor, args.targetActor],
    () => executeMedicineCombatOperation(args.sourceActor, {
      label: auditLocalize("FALLOUTMAW.AuditApps.ProsthesisRemoval", "снятия протеза"),
      operation: () => applyProsthesisRemovalLocally(args)
    })
  );
}

async function applyProsthesisInstallLocally({ sourceActor, targetActor, limbKey = "", prosthesisSource = "", itemId = "" } = {}) {
  const sourceContainer = prosthesisSource === "source" ? sourceActor : targetActor;
  const item = sourceContainer?.items?.get(itemId);
  if (!item || item.type !== "gear" || !isProsthesisForLimb(item, limbKey)) {
    throw createTreatmentStaleError(auditLocalize("FALLOUTMAW.AuditApps.TheProsthesisHasChangedOrIsNoLonger", "Протез изменился или больше не доступен."));
  }
  if (!isProsthesisItemInstallable(item)) {
    throw createTreatmentStaleError(auditLocalize("FALLOUTMAW.AuditApps.TheProsthesisBrokeBeforeInstallationWasCompleted", "Протез сломан до завершения установки."));
  }

  if (!targetActor?.system?.limbs?.[limbKey]?.missing) {
    throw createTreatmentStaleError(auditLocalize("FALLOUTMAW.AuditApps.TheBodyPartIsNoLongerMissing", "Часть тела больше не отсутствует."));
  }
  const existing = getInstalledTargetProsthesis(targetActor, limbKey);
  if (existing) throw createTreatmentStaleError(auditLocalize("FALLOUTMAW.AuditApps.TheBodyPartAlreadyHasAProsthesisInstalled", "На части тела уже установлен протез."));
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
      throw new Error(auditLocalize("FALLOUTMAW.AuditApps.FoundryDidNotConfirmProsthesisInstallation", "Foundry не подтвердил установку протеза."));
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
    throw new Error(auditLocalize("FALLOUTMAW.AuditApps.FoundryDidNotConfirmProsthesisInstallation", "Foundry не подтвердил установку протеза."));
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
  ) throw createTreatmentStaleError(auditLocalize("FALLOUTMAW.AuditApps.TheInstalledProsthesisHasChangedOrHasAlready", "Установленный протез изменился или уже снят."));

  const receivingActor = sourceActor && sourceActor.uuid !== targetActor.uuid ? sourceActor : targetActor;
  const returnPlan = planActorInventoryGrant(receivingActor, createReturnedProsthesisItemData(item), {
    quantity: 1,
    merge: false
  });
  if (!returnPlan) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.TheRecipientSInventoryHasNoSpaceFor_610", "В инвентаре получателя нет места для снятого протеза."));
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
    throw createTreatmentStaleError(auditLocalize("FALLOUTMAW.AuditApps.TheProsthesisChangedBeforeTheCriticalFailureWas", "Протез изменился до применения критического провала."));
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
  medicineMode = getMedicineResolutionMode(),
  toolEfficiencyPercentBonus = 0
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
      attemptedChecks: 0,
      reason: getMedicineSkillThresholdMessage(skillResolution, treatment?.name)
    };
  }
  const progressPerCheck = Math.max(1, Math.ceil(maxProgress * TREATMENT_PROGRESS_STEP_RATIO));
  const missingProgress = Math.max(0, maxProgress - initialProgress);
  const totalChecks = Math.max(1, Math.ceil(missingProgress / progressPerCheck));
  const noTool = tool.noTool === true;
  const freeEnergy = noTool && tool.freeEnergy === true;
  const healthPerEnergy = Math.max(1, Number(tool.healthPerEnergy) || 10);
  const initialEnergy = noTool ? Math.max(0, toInteger(tool.energyAvailable)) : 0;
  let currentProgress = initialProgress;
  let availableCharges = noTool ? initialEnergy : toInteger(tool.resourceValue);
  let energyHealing = 0;
  let availableHealing = noTool && !freeEnergy
    ? getGoodEnoughHealingCapacity(initialEnergy, { healthPerEnergy })
    : Number.MAX_SAFE_INTEGER;
  let spentCharges = 0;
  const entries = [];
  let attemptedChecks = 0;
  const targetActor = (String(targetContext?.actorUuid ?? "")
    ? await fromUuid(String(targetContext.actorUuid))
    : targetToken?.actor);
  const toolSupplyCostPercent = noTool ? 0 : getActorToolSupplyCostPercent(
    sourceActor,
    tool.toolKey,
    {
      requester: "medicine",
      actorToken: sourceToken?.object ?? sourceToken,
      targetActor,
      targetToken: targetToken?.object ?? targetToken,
      chanceOperationId: operationId
    }
  );

  for (let index = 1; index <= totalChecks; index += 1) {
    const remainingProgress = Math.max(0, maxProgress - currentProgress);
    if (!remainingProgress) break;
    if ((!noTool && availableCharges <= 0) || (noTool && !freeEnergy && availableHealing <= 0)) break;

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
        attemptedChecks,
        reason: auditLocalize("FALLOUTMAW.AuditApps.TreatmentSkillCheckFailed", "Проверка навыка лечения не выполнена.")
      };
    }
    attemptedChecks += 1;

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
      availableCharges: noTool ? Number.MAX_SAFE_INTEGER : availableCharges,
      progressForCheck,
      missingProgress: remainingProgress,
      resultKey: String(outcome.result?.key ?? "failure"),
      toolEfficiencyPercentBonus,
      toolSupplyCostPercent,
      healingMultiplier: getTreatmentHealingMultiplier(sourceActor, targetActor, targetContext, {
        sourceToken,
        targetToken,
        chanceOperationId: healingOperationId
      })
    });
    if (treatmentResult.chargesUsed <= 0) break;

    const progress = noTool
      ? Math.min(treatmentResult.progress, availableHealing)
      : treatmentResult.progress;
    if (progress <= 0) break;
    let chargesUsed = treatmentResult.chargesUsed;
    if (noTool) {
      if (freeEnergy) chargesUsed = 0;
      else {
        const previousCost = Math.ceil(energyHealing / healthPerEnergy);
        energyHealing += progress;
        const totalCost = Math.ceil(energyHealing / healthPerEnergy);
        chargesUsed = totalCost - previousCost;
        availableCharges = Math.max(0, initialEnergy - totalCost);
        availableHealing = Math.max(0, (initialEnergy * healthPerEnergy) - energyHealing);
      }
    }

    if (activeUsePreparations.length) {
      try {
        await commitPreparedActiveUseOperations(activeUsePreparations, {
          operationId: healingOperationId
        });
      } catch (error) {
        console.error(`${SYSTEM_ID} | Medicine healing active-use commit failed`, error);
      }
    }

    if (!noTool) availableCharges -= chargesUsed;
    spentCharges += chargesUsed;
    currentProgress = Math.min(maxProgress, currentProgress + progress);
    entries.push({
      index,
      total: totalChecks,
      resultLabel,
      progress,
      charges: chargesUsed,
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
    attemptedChecks,
    reason: noTool
      ? (!freeEnergy && availableHealing <= 0 && currentProgress < maxProgress
        ? auditLocalize("FALLOUTMAW.AuditApps.ThereWasNotEnoughEnergyToCompleteThe", "Энергии не хватило для полного лечения.")
        : "")
      : (availableCharges <= 0 ? auditLocalize("FALLOUTMAW.AuditApps.TheToolDidNotHaveEnoughSuppliesFor", "Запаса инструмента не хватило для лечения.") : "")
  };
}

function validateInstrumentForTreatment(actor, treatment, tool, { allowedToolClassDeficit = 0 } = {}) {
  if (treatment?.treatable === false) {
    return { ok: false, message: treatment.unavailableReason || auditLocalize("FALLOUTMAW.AuditApps.ThisTargetCannotBeTreatedRightNow", "Эту цель сейчас нельзя лечить.") };
  }
  if (!tool?.enabled) return { ok: false, message: auditLocalize("FALLOUTMAW.AuditApps.TheToolIsNotSuitableForTreatment", "Инструмент не подходит для лечения.") };
  if (toInteger(tool.resourceValue) <= 0) return { ok: false, message: auditLocalize("FALLOUTMAW.AuditApps.TheToolSResourceIsDepleted", "Ресурс инструмента исчерпан.") };

  const requiredClass = String(treatment.healingToolClass ?? "D");
  const toolClass = String(tool.toolClass ?? "D");
  if (!isToolClassAccepted(toolClass, requiredClass, allowedToolClassDeficit)) {
    const deficit = Math.max(0, toInteger(allowedToolClassDeficit));
    return {
      ok: false,
      message: deficit > 0
        ? auditFormat("FALLOUTMAW.AuditApps.RequiresAToolNoMoreThanClassBelow", { v0: (deficit), v1: (requiredClass) }, "Нужен инструмент не более чем на {v0} класс ниже {v1}.")
        : auditFormat("FALLOUTMAW.AuditApps.RequiresAToolOfClassOrHigher", { v0: (requiredClass) }, "Нужен инструмент класса {v0} или выше.")
    };
  }

  const skillKey = String(tool.skillKey ?? "");
  const skillValue = toInteger(tool.skillValue);
  if (skillKey && toInteger(actor.system?.skills?.[skillKey]?.value) < skillValue) {
    const label = getSkillSettings().find(skill => skill.key === skillKey)?.label ?? skillKey;
    return { ok: false, message: auditFormat("FALLOUTMAW.AuditApps.Requires", { v0: (skillValue), v1: (label) }, "Нужно {v0} {v1}.") };
  }

  return { ok: true, message: "" };
}

function calculateTreatmentResult({ treatmentTarget, tool, availableCharges, progressForCheck, missingProgress, resultKey, healingMultiplier = 1, toolEfficiencyPercentBonus = 0, toolSupplyCostPercent = 0 }) {
  const targetProgress = Math.min(progressForCheck, missingProgress);
  let efficiency = applyEmergencyOperationsToolEfficiency(
    calculateBaseEfficiency(tool.toolClass, treatmentTarget.healingToolClass),
    toolEfficiencyPercentBonus
  );
  if (resultKey === "criticalSuccess") efficiency *= 1.5;
  else if (resultKey === "failure") efficiency *= 0.5;

  const productiveChargesNeeded = Math.max(1, Math.ceil(targetProgress * (100 / Math.max(1, efficiency))));
  const chargesNeeded = applyToolSupplyCostPercent(productiveChargesNeeded, toolSupplyCostPercent);
  const chargesUsed = Math.min(chargesNeeded, availableCharges);
  const productiveChargesUsed = productiveChargesNeeded * Math.min(1, chargesUsed / chargesNeeded);
  const normalProgress = Math.max(0, Math.ceil(productiveChargesUsed * (efficiency / 100)));
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
  const outgoingContext = {
    actorToken: sourceToken?.object ?? sourceToken,
    targetActor,
    targetToken: targetToken?.object ?? targetToken,
    chanceOperationId
  };
  const anatomyBonus = getActorAnatomyStudyBonus(
    sourceActor,
    targetActor,
    ANATOMY_STUDY_BONUS_KEYS.treatmentEffectiveness
  );
  const outgoing = Math.max(0, 1 + ((
    getActorHealingModifierPercent(sourceActor, "outgoing", outgoingContext)
    + anatomyBonus
  ) / 100));
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
    ui.notifications.warn(auditLocalize("FALLOUTMAW.AuditApps.FailedToIdentifyTheTreatmentTarget", "Не удалось определить цель лечения."));
    return null;
  }

  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn(auditLocalize("FALLOUTMAW.AuditApps.ThereIsNoActiveGMToApplyTreatment", "Нет активного GM для применения лечения."));
    return null;
  }
  if (isCurrentResponsibleGM(gm)) {
    try {
      const actor = await fromUuid(actorUuid);
      if (!actor || String(actor.uuid ?? "") !== actorUuid) {
        throw new Error(auditLocalize("FALLOUTMAW.AuditApps.TreatmentTargetNotFound", "цель лечения не найдена"));
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
      ui.notifications.error(auditFormat("FALLOUTMAW.AuditApps.FailedToApplyTreatment", { v0: (error.message) }, "Не удалось применить лечение: {v0}"));
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
    ui.notifications.error(auditFormat("FALLOUTMAW.AuditApps.FailedToApplyTreatment", { v0: (error.message) }, "Не удалось применить лечение: {v0}"));
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
  const supply = String(instrumentId ?? "") === GOOD_ENOUGH_NO_TOOL_ID
    ? getActorAvailableEnergy(sourceActor)
    : getEffectiveMedicineToolFunction(instrument, toolKey)?.resourceValue;
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
    reason: String(reason || auditLocalize("FALLOUTMAW.AuditApps.TreatmentCanceled", "Лечение отменено."))
  };
}

function getExternalMedicineHealingFailureReason(result = {}) {
  if (result.cancelled) return auditLocalize("FALLOUTMAW.AuditApps.TreatmentCanceledBeforeApplication", "Лечение отменено до применения.");
  if (result.reason === "healing-blocked") return auditLocalize("FALLOUTMAW.AuditApps.TheTargetCannotReceiveTreatmentRightNow", "Цель сейчас не может получать лечение.");
  return auditLocalize("FALLOUTMAW.AuditApps.TreatmentCouldNotBeApplied", "Лечение не удалось применить.");
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
  if (!sourceActor || !targetActor) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.TreatmentParticipantsNotFound", "участники лечения не найдены"));
  if (!["limb", "trauma", "disease"].includes(treatmentType)) {
    throw new Error(auditLocalize("FALLOUTMAW.AuditApps.InvalidTreatmentTargetType", "некорректный тип цели лечения"));
  }
  if (!String(treatmentId ?? "").trim() || !String(instrumentId ?? "").trim()) {
    throw new Error(auditLocalize("FALLOUTMAW.AuditApps.TreatmentTargetOrToolNotSpecified", "цель или инструмент лечения не указаны"));
  }

  const currentTargetContext = buildTargetContext(targetActor, targetToken);
  const treatment = getTargetTreatments(currentTargetContext, treatmentType)
    .find(item => item.id === String(treatmentId ?? ""));
  const normalizedToolKey = validateConfiguredMedicineToolKey(toolKey);
  let instrument = null;
  let tool = null;
  let noTool = false;
  if (String(instrumentId ?? "") === GOOD_ENOUGH_NO_TOOL_ID) {
    if (treatmentType !== "limb") throw new Error(auditLocalize("FALLOUTMAW.AuditApps.GoodEnoughCanOnlyBeUsedToTreat", "Способность «И так сойдет» применима только к лечению конечностей."));
    if (!treatment) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.TreatmentTargetNotFound", "цель лечения не найдена"));
    const settings = getActorGoodEnoughSettings(sourceActor);
    if (!settings) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.TheGoodEnoughAbilityIsUnavailable", "Способность «И так сойдет» недоступна."));
    if (treatment.treatable === false) {
      throw new Error(treatment.unavailableReason || auditLocalize("FALLOUTMAW.AuditApps.ThisTargetCannotBeTreatedRightNow", "Эту цель сейчас нельзя лечить."));
    }
    noTool = true;
    const freeEnergy = isGoodEnoughHealingFree(treatment, settings);
    const energyAvailable = getActorSpendableEnergy(sourceActor);
    if (!freeEnergy && energyAvailable <= 0) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.NotEnoughEnergyForTreatment", "Недостаточно энергии для лечения."));
    tool = {
      toolKey: normalizedToolKey,
      toolClass: "D",
      resourceValue: energyAvailable,
      healthPerEnergy: settings.healthPerEnergy,
      energyAvailable,
      freeEnergy,
      noTool: true
    };
  } else {
    instrument = sourceActor.items?.get(String(instrumentId ?? ""));
    if (
      !treatment
      || !instrument
      || instrument.type !== "gear"
      || !hasItemFunction(instrument, createToolFunctionKey(normalizedToolKey))
    ) {
      throw new Error(auditLocalize("FALLOUTMAW.AuditApps.TreatmentTargetOrFunctioningToolNotFound", "цель или исправный инструмент лечения не найдены"));
    }
    tool = getEffectiveMedicineToolFunction(instrument, normalizedToolKey);
  }

  const experimentalSurgery = getActorExperimentalSurgeryContext(sourceActor, treatmentType);
  if (
    experimentalSurgery
    && !canActorSpendEnergy(sourceActor, experimentalSurgery.settings.treatmentEnergyCost)
  ) {
    throw new Error(auditFormat("FALLOUTMAW.AuditApps.NotEnoughEnergyForTreatmentRequired", { v0: (experimentalSurgery.settings.treatmentEnergyCost) }, "Недостаточно энергии для лечения: нужно {v0}."));
  }
  const validation = noTool
    ? { ok: true }
    : validateInstrumentForTreatment(sourceActor, treatment, tool, {
        allowedToolClassDeficit: experimentalSurgery?.settings.allowedToolClassDeficit ?? 0
      });
  if (!validation.ok) throw new Error(validation.message);

  const maxProgress = Math.max(1, toInteger(treatment.healingProgressMax));
  const initialProgress = Math.min(maxProgress, Math.max(0, toInteger(treatment.healingProgress)));
  const receiptBase = {
    version: 1,
    status: "pending",
    operationId,
    targetContext: currentTargetContext,
    treatment,
    instrument: noTool
      ? {
        id: GOOD_ENOUGH_NO_TOOL_ID,
        name: auditLocalize("FALLOUTMAW.AuditApps.GoodEnoughWithoutTools", "И так сойдет — без инструмента"),
        img: "systems/fallout-maw/assets/System/Abilities/ability-default.webp",
        noTool: true
      }
      : {
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
      reason: auditLocalize("FALLOUTMAW.AuditApps.TheTargetCannotReceiveTreatmentRightNow", "Цель сейчас не может получать лечение.")
    };
  }
  if (initialProgress >= maxProgress) {
    return { ...receiptBase, status: "alreadyComplete", alreadyHealed: true };
  }

  const medicineMode = getMedicineResolutionMode();
  const emergencyOperations = noTool ? null : getPendingEmergencyOperationsTreatment(sourceActor);
  const emergencyOperationsResult = emergencyOperations ? {
    abilityItemId: String(emergencyOperations.abilityItem.id ?? ""),
    functionId: String(emergencyOperations.abilityFunction.id ?? ""),
    toolEfficiencyPercentBonus: emergencyOperations.settings.toolEfficiencyPercentBonus
  } : null;
  const result = await executeMedicineCombatOperation(sourceActor, {
    label: auditLocalize("FALLOUTMAW.Item.TooltipBreakdownHealingUnit", "лечения"),
    operation: () => runTreatmentChecks({
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
      medicineMode,
      toolEfficiencyPercentBonus: emergencyOperationsResult?.toolEfficiencyPercentBonus ?? 0
    }),
    didStart: treatmentResult => Math.max(0, toInteger(treatmentResult?.attemptedChecks)) > 0
  });
  if (!result.entries.length) {
    if (emergencyOperationsResult && Math.max(0, toInteger(result.attemptedChecks)) > 0) {
      const consumption = prepareEmergencyOperationsConsumption(sourceActor, emergencyOperationsResult);
      await consumption.abilityItem.update(consumption.update);
    }
    return {
      ...receiptBase,
      status: "failed",
      reason: result.reason || auditLocalize("FALLOUTMAW.AuditApps.TreatmentFailed", "Лечение не выполнено.")
    };
  }

  let experimentalSurgeryResult = null;
  if (experimentalSurgery) {
    const normalSupplySpent = result.spentCharges;
    const extraSupplyTriggered = rollExperimentalSurgeryChance(
      experimentalSurgery.settings.extraSupplyChancePercent
    );
    const supplyCost = calculateExperimentalSurgerySupplyCost({
      normalSpent: result.spentCharges,
      currentSupply: tool.resourceValue,
      multiplier: experimentalSurgery.settings.supplyCostMultiplier,
      triggered: extraSupplyTriggered
    });
    const patientDamageTriggered = rollExperimentalSurgeryChance(
      experimentalSurgery.settings.patientDamageChancePercent
    );
    const patientDamage = patientDamageTriggered
      ? calculateExperimentalSurgeryPatientDamage(
          targetActor.system?.resources?.health?.max,
          experimentalSurgery.settings.patientHealthDamagePercent
        )
      : 0;
    result.spentCharges = supplyCost.spent;
    result.remainingCharges = supplyCost.remaining;
    experimentalSurgeryResult = {
      abilityItemId: String(experimentalSurgery.abilityItem.id ?? ""),
      functionId: String(experimentalSurgery.abilityFunction.id ?? ""),
      energyCost: experimentalSurgery.settings.treatmentEnergyCost,
      allowedToolClassDeficit: experimentalSurgery.settings.allowedToolClassDeficit,
      normalSupplySpent,
      extraSupplyTriggered: supplyCost.triggered,
      extraSupplySpent: supplyCost.extraSpent,
      supplyCostMultiplier: experimentalSurgery.settings.supplyCostMultiplier,
      patientDamageTriggered,
      patientDamage
    };
  }

  const finalProgress = Math.min(maxProgress, result.finalProgress);
  const completed = finalProgress >= maxProgress;
  const commitRequest = {
    sourceActor,
    targetActor,
    targetToken,
    operationId,
    treatmentType,
    treatmentId,
    instrumentId: noTool ? GOOD_ENOUGH_NO_TOOL_ID : instrument.id,
    toolKey: normalizedToolKey,
    expectedProgress: initialProgress,
    finalProgress,
    completed,
    expectedSupply: noTool ? 0 : toInteger(tool.resourceValue),
    remainingSupply: noTool ? 0 : result.remainingCharges,
    expectedEnergyCost: noTool ? result.spentCharges : 0,
    expectedMedicineMode: medicineMode,
    experimentalSurgery: experimentalSurgeryResult,
    emergencyOperations: emergencyOperationsResult,
    noTool,
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
        sourceItemUuid: String(instrument?.uuid ?? ""),
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
    experimentalSurgery: experimentalSurgeryResult
      ? {
          ...experimentalSurgeryResult,
          patientDamage: commitResult.patientDamageApplied ?? 0
        }
      : null,
    emergencyOperations: emergencyOperationsResult,
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
  expectedEnergyCost = 0,
  expectedMedicineMode,
  experimentalSurgery = null,
  emergencyOperations = null,
  operationId = "",
  noTool = false,
  chainRef = null
}) {
  const normalizedToolKey = String(toolKey ?? "").trim();
  let instrument = null;
  let tool = null;
  let goodEnoughSettings = null;
  if (noTool) {
    if (treatmentType !== "limb" || instrumentId !== GOOD_ENOUGH_NO_TOOL_ID) {
      throw new Error(auditLocalize("FALLOUTMAW.AuditApps.InvalidTreatmentMethodWithoutTools", "Некорректный способ лечения без инструмента."));
    }
    goodEnoughSettings = getActorGoodEnoughSettings(sourceActor);
    if (!goodEnoughSettings) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.TheGoodEnoughAbilityIsUnavailable", "Способность «И так сойдет» недоступна."));
  } else {
    instrument = sourceActor?.items?.get(String(instrumentId ?? ""));
    tool = getEffectiveMedicineToolFunction(instrument, normalizedToolKey);
  }
  if (getMedicineResolutionMode() !== expectedMedicineMode) {
    throw createTreatmentStaleError(auditLocalize("FALLOUTMAW.AuditApps.MedicineModeChangedDuringTreatment", "Режим медицины изменился во время лечения."));
  }
  let currentExperimentalSurgery = null;
  if (experimentalSurgery) {
    currentExperimentalSurgery = getActorExperimentalSurgeryContext(sourceActor, treatmentType);
    if (
      !currentExperimentalSurgery
      || String(currentExperimentalSurgery.abilityItem.id ?? "") !== String(experimentalSurgery.abilityItemId ?? "")
      || String(currentExperimentalSurgery.abilityFunction.id ?? "") !== String(experimentalSurgery.functionId ?? "")
    ) {
      throw createTreatmentStaleError(auditLocalize("FALLOUTMAW.AuditApps.ExperimentalSurgeryWasDisabledDuringTreatment", "Эксперементальная хирургия была выключена во время лечения."));
    }
    const settings = currentExperimentalSurgery.settings;
    if (
      settings.treatmentEnergyCost !== Math.max(0, toInteger(experimentalSurgery.energyCost))
      || settings.allowedToolClassDeficit !== Math.max(0, toInteger(experimentalSurgery.allowedToolClassDeficit))
      || settings.supplyCostMultiplier !== Math.max(1, toInteger(experimentalSurgery.supplyCostMultiplier))
    ) {
      throw createTreatmentStaleError(auditLocalize("FALLOUTMAW.AuditApps.ExperimentalSurgerySettingsChangedDuringTreatment", "Настройки эксперементальной хирургии изменились во время лечения."));
    }
    if (!canActorSpendEnergy(sourceActor, settings.treatmentEnergyCost)) {
      throw createTreatmentStaleError(auditLocalize("FALLOUTMAW.AuditApps.NotEnoughEnergyForTreatment", "Недостаточно энергии для лечения."));
    }
    const expectedPatientDamage = experimentalSurgery.patientDamageTriggered
      ? calculateExperimentalSurgeryPatientDamage(
          targetActor.system?.resources?.health?.max,
          settings.patientHealthDamagePercent
        )
      : 0;
    if (expectedPatientDamage !== Math.max(0, toInteger(experimentalSurgery.patientDamage))) {
      throw createTreatmentStaleError(auditLocalize("FALLOUTMAW.AuditApps.ThePatientSMaximumHealthChangedDuringTreatment", "Максимум здоровья пациента изменился во время лечения."));
    }
  }
  const emergencyOperationsConsumption = emergencyOperations
    ? prepareEmergencyOperationsConsumption(sourceActor, emergencyOperations)
    : null;
  let remaining = 0;
  if (!noTool) {
    const currentSupply = Math.max(0, toInteger(tool?.resourceValue));
    const expected = Math.max(0, toInteger(expectedSupply));
    remaining = Math.max(0, toInteger(remainingSupply));
    if (
      !instrument
      || instrument.type !== "gear"
      || !hasItemFunction(instrument, createToolFunctionKey(normalizedToolKey))
      || !tool?.enabled
    ) {
      throw new Error(auditLocalize("FALLOUTMAW.AuditApps.TreatmentToolNotFound", "инструмент лечения не найден"));
    }
    if (currentSupply !== expected) {
      throw createTreatmentStaleError(auditLocalize("FALLOUTMAW.AuditApps.ToolSuppliesHaveChanged", "Запас инструмента изменился."));
    }
    if (currentExperimentalSurgery) {
      const expectedSupplyCost = calculateExperimentalSurgerySupplyCost({
        normalSpent: experimentalSurgery.normalSupplySpent,
        currentSupply,
        multiplier: currentExperimentalSurgery.settings.supplyCostMultiplier,
        triggered: experimentalSurgery.extraSupplyTriggered
      });
      if (
        remaining !== expectedSupplyCost.remaining
        || Math.max(0, toInteger(experimentalSurgery.extraSupplySpent)) !== expectedSupplyCost.extraSpent
      ) {
        throw createTreatmentStaleError(auditLocalize("FALLOUTMAW.AuditApps.ToolConsumptionChangedDuringTreatment", "Расход инструмента изменился во время лечения."));
      }
    }
    if (remaining >= currentSupply) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.TreatmentMustConsumeToolSupplies", "Лечение должно расходовать запас инструмента."));
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
  if (!noTool) {
    const authoritativeValidation = validateInstrumentForTreatment(
      sourceActor,
      treatmentCommit.treatmentTarget,
      tool,
      {
        allowedToolClassDeficit: currentExperimentalSurgery?.settings.allowedToolClassDeficit ?? 0
      }
    );
    if (!authoritativeValidation.ok) throw new Error(authoritativeValidation.message);
  }
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
  if (noTool) {
    const energyCost = getGoodEnoughEnergyCost(
      treatmentCommit.treatmentTarget,
      treatmentCommit.healing?.appliedHealing,
      goodEnoughSettings
    );
    if (energyCost !== Math.max(0, toInteger(expectedEnergyCost))) {
      throw createTreatmentStaleError(auditLocalize("FALLOUTMAW.AuditApps.TreatmentCostHasChanged", "Стоимость лечения изменилась."));
    }
    if (!canActorSpendEnergy(sourceActor, energyCost)) {
      throw createTreatmentStaleError(auditLocalize("FALLOUTMAW.AuditApps.NotEnoughEnergyForTreatment", "Недостаточно энергии для лечения."));
    }
    await runActorEnergyMutation(sourceActor, async () => {
      const targetUpdate = Object.assign({}, ...treatmentCommit.targetPlan.actorUpdates);
      const targetDocumentOptions = {
        falloutMawSkipDamageStatusSync: true,
        falloutMawLimbCapSync: true,
        falloutMawMedicineNoTool: true
      };
      const updateEntries = [];
      if (energyCost > 0) {
        const energyPlan = prepareActorEnergySpend(sourceActor, energyCost);
        if (!energyPlan) throw createTreatmentStaleError(auditLocalize("FALLOUTMAW.AuditApps.NotEnoughEnergyForTreatment", "Недостаточно энергии для лечения."));
        if (sourceActor === targetActor) Object.assign(targetUpdate, energyPlan.updates);
        else {
          updateEntries.push({
            document: sourceActor,
            updates: energyPlan.updates,
            documentOptions: { falloutMawMedicineNoTool: true }
          });
        }
      }
      if (Object.keys(targetUpdate).length) {
        updateEntries.unshift({
          document: targetActor,
          updates: targetUpdate,
          documentOptions: targetDocumentOptions
        });
      }
      await executeAtomicActorItemUpdates(updateEntries, {
        reason: "medicine-limb-treatment-no-tool",
        chainRef
      });
    });
  } else {
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
        { document: instrument, updates: instrumentUpdate },
        ...(emergencyOperationsConsumption ? [{
          document: emergencyOperationsConsumption.abilityItem,
          updates: emergencyOperationsConsumption.update
        }] : [])
      ], {
        reason: "medicine-limb-treatment-with-tool",
        chainRef
      });
    } else {
      await runActorEnergyMutation(sourceActor, async () => {
        const sourceActorUpdates = [];
        if (currentExperimentalSurgery?.settings.treatmentEnergyCost > 0) {
          const energyCost = currentExperimentalSurgery.settings.treatmentEnergyCost;
          const energyPlan = prepareActorEnergySpend(sourceActor, energyCost);
          if (!energyPlan) throw createTreatmentStaleError(auditLocalize("FALLOUTMAW.AuditApps.NotEnoughEnergyForTreatment", "Недостаточно энергии для лечения."));
          sourceActorUpdates.push(energyPlan.updates);
        }
        await executeInventoryMutation([
          treatmentCommit.targetPlan,
          {
            actor: sourceActor,
            updates: [
              { _id: instrument.id, ...instrumentUpdate },
              ...(emergencyOperationsConsumption ? [{
                _id: emergencyOperationsConsumption.abilityItem.id,
                ...emergencyOperationsConsumption.update
              }] : [])
            ],
            actorUpdates: sourceActorUpdates
          }
        ], {
          reason: "medicine-treatment-with-tool",
          documentOptions: {
            falloutMawSkipDamageStatusSync: true,
            falloutMawLimbCapSync: true,
            ...(chainRef ? { chainRef, falloutMawSystemEventChainRef: chainRef } : {})
          }
        });
      });
    }
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
      ui.notifications.warn(auditLocalize("FALLOUTMAW.AuditApps.TheDiseaseWasCuredButTheImmunityEffect", "Болезнь вылечена, но эффект иммунитета создать не удалось."));
    }
  }
  let patientDamageApplied = 0;
  if (currentExperimentalSurgery && experimentalSurgery?.patientDamageTriggered) {
    patientDamageApplied = Math.max(0, toInteger(experimentalSurgery.patientDamage));
    if (patientDamageApplied > 0) {
      try {
        await requestDamageApplication({
          actor: targetActor,
          amount: patientDamageApplied,
          mode: "damage",
          scope: "health",
          applyMitigation: false,
          processDamageTypeSettings: false,
          source: {
            requester: "experimentalSurgery",
            operationId: String(operationId ?? ""),
            sourceActorUuid: String(sourceActor.uuid ?? ""),
            sourceItemUuid: String(currentExperimentalSurgery.abilityItem.uuid ?? "")
          }
        });
      } catch (error) {
        patientDamageApplied = 0;
        console.error(`${SYSTEM_ID} | Experimental surgery patient damage failed`, error);
        ui.notifications.warn(auditLocalize("FALLOUTMAW.AuditApps.TreatmentCompletedButTheSideEffectDamageFrom", "Лечение завершено, но побочный урон эксперементальной хирургии применить не удалось."));
      }
    }
  }
  return {
    targetContext: buildTargetContext(targetActor, targetToken),
    healing: treatmentCommit.healing ?? null,
    patientDamageApplied
  };
}

function prepareEmergencyOperationsConsumption(sourceActor, expected = {}) {
  const current = getPendingEmergencyOperationsTreatment(sourceActor);
  if (
    !current
    || String(current.abilityItem.id ?? "") !== String(expected.abilityItemId ?? "")
    || String(current.abilityFunction.id ?? "") !== String(expected.functionId ?? "")
    || current.settings.toolEfficiencyPercentBonus !== Math.max(0, Number(expected.toolEfficiencyPercentBonus) || 0)
  ) {
    throw createTreatmentStaleError(auditLocalize("FALLOUTMAW.AuditApps.EmergencyOperationPreparationChangedDuringTreatment", "Подготовка экстренной операции изменилась во время лечения."));
  }
  const state = foundry.utils.deepClone(getAbilityFixedFunctionState(current.abilityItem));
  const stateKey = getAbilityFixedFunctionStateKey(current.abilityFunction);
  state[stateKey] = {
    ...state[stateKey],
    fixedKey: current.abilityFunction.fixedKey,
    pending: false
  };
  return {
    abilityItem: current.abilityItem,
    update: {
      [`flags.${SYSTEM_ID}.${ABILITY_FIXED_FUNCTION_STATE_FLAG_KEY}`]: state
    }
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
  if (!limb || targetActor?.type === "construct") throw new Error(auditLocalize("FALLOUTMAW.AuditApps.TreatmentTargetNotFound", "цель лечения не найдена"));

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
    throw createTreatmentStaleError(auditLocalize("FALLOUTMAW.AuditApps.TheLimbCanNoLongerBeTreated", "Конечность больше не подлежит лечению."));
  }
  const maxProgress = Math.max(1, healingCap - min);
  const currentProgress = Math.min(maxProgress, Math.max(0, currentLimbValue - min));
  const nextProgress = Math.min(maxProgress, Math.max(0, toInteger(finalProgress)));
  assertTreatmentProgressIsCurrent(currentProgress, expectedProgress);
  if (nextProgress < currentProgress) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.TreatmentCannotReduceLimbHealth", "Лечение не может уменьшать здоровье конечности."));
  assertTreatmentCompletionIsCurrent(nextProgress, maxProgress, completed);

  const expectedLimbValue = Math.min(healingCap, min + nextProgress);
  const healing = prepareTargetedLimbHealingActorUpdate(
    targetActor,
    limbKey,
    expectedLimbValue - currentLimbValue,
    limbHealthContext
  );
  if (healing.previousValue !== currentLimbValue || healing.finalValue !== expectedLimbValue) {
    throw createTreatmentStaleError(auditLocalize("FALLOUTMAW.AuditApps.TheLimbSStateHasChangedOrIt", "Состояние конечности изменилось или она больше не подлежит лечению."));
  }

  const targetPlan = createEmptyTreatmentPlan(targetActor);
  if (Object.keys(healing.updateData).length) targetPlan.actorUpdates.push(healing.updateData);
  return {
    targetPlan,
    treatmentTarget: {
      type: "limb",
      name: String(limb.label ?? limbKey),
      value: currentLimbValue,
      min,
      max: Math.max(0, toInteger(limb.max)),
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
    throw new Error(auditLocalize("FALLOUTMAW.AuditApps.TreatmentTargetNotFound", "цель лечения не найдена"));
  }

  const maxProgress = Math.max(1, toInteger(treatment.system?.healingProgressMax));
  const currentProgress = Math.min(maxProgress, Math.max(0, toInteger(treatment.system?.healingProgress)));
  const nextProgress = Math.min(maxProgress, Math.max(0, toInteger(finalProgress)));
  assertTreatmentProgressIsCurrent(currentProgress, expectedProgress);
  if (nextProgress < currentProgress) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.TreatmentCannotReduceProgress", "Лечение не может уменьшать прогресс."));
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
    throw createTreatmentStaleError(auditLocalize("FALLOUTMAW.AuditApps.TreatmentProgressHasChanged", "Прогресс лечения изменился."));
  }
}

function assertTreatmentCompletionIsCurrent(nextProgress, maxProgress, completed) {
  const treatmentCompleted = nextProgress >= maxProgress;
  if (Boolean(completed) !== treatmentCompleted) {
    throw createTreatmentStaleError(auditLocalize("FALLOUTMAW.AuditApps.TheTreatmentResultNoLongerMatchesTheTarget", "Результат лечения больше не соответствует состоянию цели."));
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
    name: getActorTargetName(actor, token),
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
      name: auditFormat("FALLOUTMAW.AuditApps.Health_656", { v0: (String(limb?.label ?? key)) }, "Здоровье: {v0}"),
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
      statusLabel: unavailableReason || (healingCap < max ? auditFormat("FALLOUTMAW.AuditApps.AvailableLimit", { v0: (healingCap) }, "Доступный предел: {v0}") : auditLocalize("FALLOUTMAW.AuditApps.CanBeTreated", "Можно лечить")),
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
  if (actorType === "construct") return auditLocalize("FALLOUTMAW.AuditApps.MechanicalTargetsRequireRepair", "Для механизмов используется ремонт.");
  if (missing) return auditLocalize("FALLOUTMAW.AuditApps.TheLimbIsMissing", "Конечность отсутствует.");
  if (prosthesis) return auditLocalize("FALLOUTMAW.AuditApps.AnInstalledProsthesisCannotBeTreated", "Установленный протез лечению не подлежит.");
  if (value >= healingCap && healingCap < max) return auditLocalize("FALLOUTMAW.AuditApps.TreatTheLimitingTraumaFirst", "Сначала вылечите ограничивающую травму.");
  if (value >= healingCap) return auditLocalize("FALLOUTMAW.AuditApps.HealthHasAlreadyBeenRestoredToTheAvailable", "Здоровье уже восстановлено до доступного предела.");
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
    img: normalizeImagePath(item.img, "systems/fallout-maw/assets/System/Traumas/trauma-default.webp"),
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
      summary: auditFormat("FALLOUTMAW.AuditApps.Level", { v0: (system.needLabel ?? system.needKey), v1: (thresholdPercent), v2: (level) }, "{v0}: {v1}% / уровень {v2}")
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
  if (!gm) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.NoActiveGM", "нет активного GM"));
  const resolvedRequestId = String(requestId ?? "").trim() || foundry.utils.randomID();
  const requesterUserId = game.user?.id ?? "";

  const promise = new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingMedicineSocketRequests.delete(resolvedRequestId);
      const error = new Error(auditLocalize("FALLOUTMAW.AuditApps.TheGMDidNotRespondToTheMedical", "GM не ответил на запрос медицины"));
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
    else pending.reject(new Error(message.error || auditLocalize("FALLOUTMAW.AuditApps.MedicalGMSocketError", "ошибка GM-сокета медицины")));
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
  if (!requestId || !requesterUserId) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.InvalidMedicalRequest", "некорректный запрос медицины"));
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
  if (!actor) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.TargetNotFound", "цель не найдена"));

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
      targetContext: await resolveImplantRemovalOnAuthority({
        sourceActor,
        targetActor: actor,
        targetToken,
        limbKey: payload.limbKey,
        itemId: payload.itemId
      })
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
      targetContext: await resolveProsthesisRemovalOnAuthority({
        sourceActor,
        targetActor: actor,
        targetToken,
        limbKey: payload.limbKey,
        itemId: payload.itemId
      })
    };
  }

  throw new Error(auditFormat("FALLOUTMAW.AuditApps.UnknownMedicalAction", { v0: (action) }, "неизвестное действие медицины: {v0}"));
}

function assertMedicineSocketActorOwner(actor, requesterUserId) {
  const user = game.users?.get?.(String(requesterUserId ?? ""))
    ?? (game.users?.contents ?? []).find(entry => entry.id === requesterUserId);
  if (!user || (!user.isGM && !actor?.testUserPermission?.(user, "OWNER"))) {
    throw new Error(auditLocalize("FALLOUTMAW.AuditApps.NoPermissionToUseTheTool", "нет прав на использование инструмента"));
  }
}

async function getMedicineSocketSourceActor(actorUuid = "", requesterUserId = "") {
  const actor = await fromUuid(String(actorUuid ?? "").trim());
  if (!actor || actor.documentName !== "Actor") throw new Error(auditLocalize("FALLOUTMAW.AuditApps.MedicalSourceNotFound", "источник медицины не найден"));
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
    if (required) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.MedicalParticipantTokenNotFound", "токен участника медицины не найден"));
    return null;
  }
  const token = await fromUuid(uuid);
  if (
    token?.documentName !== "Token"
    || !token.actor
    || !isActorAtPhysicalToken(actor, token)
  ) {
    throw new Error(auditLocalize("FALLOUTMAW.AuditApps.TheTokenDoesNotMatchTheMedicalParticipant", "токен не соответствует участнику медицины"));
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

async function postTreatmentResultChat(actor, { treatment, instrument, initialProgress, finalProgress, maxProgress, spentCharges, entries, completed, experimentalSurgery = null, emergencyOperations = null }) {
  const progressOffset = treatment.type === "limb" ? toInteger(treatment.min) : 0;
  const displayProgress = value => toInteger(value) + progressOffset;
  const resourceLabel = instrument?.noTool ? auditLocalize("FALLOUTMAW.AuditApps.Energy", "энергия") : auditLocalize("FALLOUTMAW.AuditApps.Supplies", "запас");
  const spentLabel = instrument?.noTool ? auditLocalize("FALLOUTMAW.AuditApps.EnergySpent", "Потрачено энергии") : auditLocalize("FALLOUTMAW.AuditApps.SuppliesConsumed", "Потрачено запаса");
  const completionLabel = treatment.type === "disease"
    ? auditLocalize("FALLOUTMAW.AuditApps.DiseaseCured", "Болезнь вылечена.")
    : treatment.type === "limb"
      ? auditLocalize("FALLOUTMAW.AuditApps.LimbRestoredToTheAvailableLimit", "Конечность восстановлена до доступного предела.")
      : auditLocalize("FALLOUTMAW.AuditApps.TraumaFullyTreated", "Травма полностью вылечена.");
  const rows = entries.map(entry => auditFormat("FALLOUTMAW.AuditApps.CheckProgressEffectivenessTotal", { v0: (entry.index), v1: (entry.total), v2: (entry.resultLabel), v3: (entry.progress), v4: (resourceLabel), v5: (entry.charges), v6: (formatNumber(entry.efficiency)), v7: (displayProgress(entry.currentProgress)), v8: (displayProgress(maxProgress)) }, "\n    <li>\n      Проверка {v0}/{v1}: {v2},\n      +{v3} прогресса,\n      {v4} {v5},\n      эффективность {v6}%,\n      итог {v7}/{v8}\n    </li>\n  ")).join("");
  await postMedicineChat(actor, {
    title: auditFormat("FALLOUTMAW.AuditApps.Treatment", { v0: (treatment.name) }, "Лечение: {v0}"),
    tone: completed ? "success" : "standard",
    lines: [
      auditFormat("FALLOUTMAW.AuditApps.Tool", { v0: (instrument.name) }, "Инструмент: {v0}"),
      auditFormat("FALLOUTMAW.AuditApps.Progress", { v0: (displayProgress(initialProgress)), v1: (displayProgress(maxProgress)), v2: (displayProgress(finalProgress)), v3: (displayProgress(maxProgress)) }, "Прогресс: {v0}/{v1} -> {v2}/{v3}"),
      `${spentLabel}: ${spentCharges}`,
      experimentalSurgery
        ? auditFormat("FALLOUTMAW.AuditApps.ExperimentalSurgeryEnergy", { v0: (Math.max(0, toInteger(experimentalSurgery.energyCost))) }, "Эксперементальная хирургия: -{v0} энергии.")
        : "",
      experimentalSurgery?.extraSupplyTriggered
        ? auditFormat("FALLOUTMAW.AuditApps.IncreasedToolConsumptionXAdditional", { v0: (Math.max(1, toInteger(experimentalSurgery.supplyCostMultiplier))), v1: (Math.max(0, toInteger(experimentalSurgery.extraSupplySpent))) }, "Повышенный расход инструмента: x{v0} (дополнительно {v1}).")
        : "",
      experimentalSurgery?.patientDamage > 0
        ? auditFormat("FALLOUTMAW.AuditApps.ComplicationThePatientLostHealth", { v0: (Math.max(0, toInteger(experimentalSurgery.patientDamage))) }, "Осложнение: пациент потерял {v0} здоровья.")
        : "",
      emergencyOperations
        ? auditFormat("FALLOUTMAW.AuditApps.EmergencyOperationsToolEffectiveness", { v0: (formatNumber(emergencyOperations.toolEfficiencyPercentBonus)) }, "Экстренные операции: +{v0}% эффективности инструмента.")
        : "",
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
    title: auditLocalize("FALLOUTMAW.AuditApps.BulkTreatment", "Массовое лечение"),
    tone: summary.stopped ? "failure" : toInteger(summary.skipped) > 0 ? "standard" : "success",
    lines: [
      summary.targetName ? auditFormat("FALLOUTMAW.AuditApps.Target_689", { v0: (summary.targetName) }, "Цель: {v0}") : "",
      auditFormat("FALLOUTMAW.AuditApps.SequentialOperations", { v0: (Math.max(0, toInteger(summary.attempted))) }, "Последовательных операций: {v0}"),
      auditFormat("FALLOUTMAW.AuditApps.TraumasFullyTreated", { v0: (Math.max(0, toInteger(summary.completedTraumas))) }, "Полностью вылечено травм: {v0}"),
      auditFormat("FALLOUTMAW.AuditApps.TraumaTreatmentProgressGained", { v0: (Math.max(0, toInteger(summary.restoredTraumaProgress))) }, "Получено прогресса лечения травм: {v0}"),
      auditFormat("FALLOUTMAW.AuditApps.BodyPartsRestoredToTheAvailableLimit", { v0: (Math.max(0, toInteger(summary.completedLimbs))) }, "Частей тела восстановлено до доступного предела: {v0}"),
      auditFormat("FALLOUTMAW.AuditApps.BodyPartHealthRestored", { v0: (Math.max(0, toInteger(summary.restoredLimbHealth))) }, "Восстановлено здоровья частей тела: {v0}"),
      auditFormat("FALLOUTMAW.AuditApps.ToolSuppliesConsumed", { v0: (Math.max(0, toInteger(summary.charges))) }, "Потрачено запаса инструментов: {v0}"),
      auditFormat("FALLOUTMAW.AuditApps.TargetsSkipped", { v0: (Math.max(0, toInteger(summary.skipped))) }, "Пропущено целей: {v0}"),
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
  if (resultKey === "criticalSuccess") return auditLocalize("FALLOUTMAW.AuditApps.CriticalSuccess", "критический успех");
  if (resultKey === "success") return auditLocalize("FALLOUTMAW.AuditApps.Success", "успех");
  if (resultKey === "criticalFailure") return auditLocalize("FALLOUTMAW.AuditApps.CriticalFailure", "критический провал");
  return auditLocalize("FALLOUTMAW.AuditApps.Failure", "провал");
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
  const skillLabel = getHealingSkillLabel(resolution.skillKey) || auditLocalize("FALLOUTMAW.AuditApps.RequiredSkill", "требуемого навыка");
  return auditFormat("FALLOUTMAW.AuditApps.TreatmentRequiresCurrently", { v0: (name ? ` «${name}»` : ""), v1: (toInteger(resolution.difficulty)), v2: (skillLabel), v3: (toInteger(resolution.skillValue)) }, "Для лечения{v0} нужно {v1} {v2} (сейчас {v3}).");
}

function getMedicineInstallationSkillThresholdMessage(
  resolution = {},
  installationType = "",
  itemName = ""
) {
  const type = String(installationType ?? "").trim();
  const name = String(itemName ?? "").trim();
  const skillLabel = getHealingSkillLabel(resolution.skillKey) || auditLocalize("FALLOUTMAW.AuditApps.RequiredSkill", "требуемого навыка");
  return auditFormat("FALLOUTMAW.AuditApps.InstallationRequiresCurrently", { v0: (type ? ` ${type}` : ""), v1: (name ? ` «${name}»` : ""), v2: (toInteger(resolution.difficulty)), v3: (skillLabel), v4: (toInteger(resolution.skillValue)) }, "Для установки{v0}{v1} нужно {v2} {v3} (сейчас {v4}).");
}

function getActorItemsByType(actor, type = "") {
  const typed = actor?.itemTypes?.[type];
  if (Array.isArray(typed)) return typed;
  return actor?.items?.filter?.(item => item?.type === type)
    ?? Array.from(actor?.items ?? []).filter(item => item?.type === type);
}

function isToolClassAccepted(actual, required, allowedDeficit = 0) {
  return toToolClassRank(actual) >= Math.max(
    0,
    toToolClassRank(required) - Math.max(0, toInteger(allowedDeficit))
  );
}

function getActorExperimentalSurgeryContext(actor, treatmentType = "") {
  if (!isExperimentalSurgeryTreatmentType(treatmentType)) return null;
  const entry = getActorActiveFixedAbilityFunctionEntry(
    actor,
    ABILITY_FIXED_FUNCTION_KEYS.experimentalSurgery
  );
  if (!entry) return null;
  return {
    ...entry,
    settings: normalizeExperimentalSurgerySettings(entry.abilityFunction.fixedSettings)
  };
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
    throw new Error(auditLocalize("FALLOUTMAW.AuditApps.InvalidToolTypeInMedicineSettings", "в настройках медицины указан некорректный тип инструмента"));
  }
  const requested = String(value ?? configured).trim() || configured;
  if (requested !== configured) {
    throw new Error(auditLocalize("FALLOUTMAW.AuditApps.MedicalToolTypeDoesNotMatchActionSettings", "тип медицинского инструмента не соответствует настройкам действия"));
  }
  return configured;
}

function assertMedicineTokenMatchesActor(token = null, actor = null) {
  if (!token) return;
  if (
    token.documentName !== "Token"
    || !token.actor
    || !isActorAtPhysicalToken(actor, token)
  ) {
    throw new Error(auditLocalize("FALLOUTMAW.AuditApps.TheTokenDoesNotMatchTheMedicalParticipant", "токен не соответствует участнику медицины"));
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
