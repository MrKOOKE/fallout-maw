import { SYSTEM_ID, TEMPLATES } from "../constants.mjs";
import { requestSkillCheck } from "../rolls/skill-check.mjs";
import { getToolSettings } from "../settings/accessors.mjs";
import { getEnabledToolFunctions } from "../utils/item-functions.mjs";
import { toInteger } from "../utils/numbers.mjs";

const { ApplicationV2, DialogV2, HandlebarsApplicationMixin } = foundry.applications.api;
const HACKING_SOCKET = `system.${SYSTEM_ID}`;
const HACKING_SOCKET_SCOPE = "fallout-maw.hacking";
const HACKING_FLAG_PATH = `flags.${SYSTEM_ID}.hacking`;
const HACKING_SOCKET_TIMEOUT = 10000;
const TOOL_CLASS_RANKS = Object.freeze({ D: 0, C: 1, B: 2, A: 3, S: 4 });
const pendingHackingRequests = new Map();
let doorControlPatched = false;

export function registerHackingHooks() {
  Hooks.on("renderWallConfig", activateWallHackingConfig);
  Hooks.on("preUpdateWall", prepareWallHackingUpdate);
  patchDoorControl();
}

export function registerHackingSocket() {
  game.socket.on(HACKING_SOCKET, handleHackingSocketMessage);
}

export async function openHackingSettings(actor) {
  if (!game.user?.isGM || !actor) return undefined;
  const state = normalizeActorHackingState(actor.system?.hacking);
  const result = await DialogV2.input({
    window: { title: `Настройки взлома — ${actor.name}` },
    content: buildHackingSettingsContent(state.methods, {
      includeEnabled: true,
      enabled: state.enabled
    }),
    position: { width: 720 },
    rejectClose: false,
    render: (_event, dialog) => activateHackingMethodsEditor(dialog.element),
    ok: {
      label: "Сохранить",
      icon: "fa-solid fa-floppy-disk"
    }
  });
  if (!result) return undefined;

  // DialogV2.input returns FormDataExtended.object, whose dotted field names
  // (for example, methods.0.toolKey) are still flat keys.
  const formData = foundry.utils.expandObject(result);
  const enabled = formData.enabled === true;
  const methods = normalizeHackingMethods(formData.methods);
  if (enabled && !state.enabled) {
    for (const method of methods) method.attemptsRemaining = method.attempts;
  }
  return actor.update({
    "system.hacking.enabled": enabled,
    "system.hacking.methods": methods
  });
}

export function requestActorHacking({ hackerActor, targetActor, onUnlocked = null } = {}) {
  return requestTargetHacking({ hackerActor, target: targetActor, onUnlocked });
}

function requestWallHacking({ hackerActor, wall } = {}) {
  return requestTargetHacking({ hackerActor, target: wall });
}

function requestTargetHacking({ hackerActor, target, onUnlocked = null } = {}) {
  if (!hackerActor?.isOwner || !target) return undefined;
  if (!isHackingTargetLocked(target)) return onUnlocked?.();
  return new HackingDialog({ hackerActor, target, onUnlocked }).render({ force: true });
}

class HackingDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  #hackerActor = null;
  #target = null;
  #selectedCandidateKey = "";
  #localMethods = null;
  #unlocked = false;
  #attemptInFlight = false;
  #onUnlocked = null;

  constructor({ hackerActor, target, onUnlocked = null } = {}) {
    super();
    this.#hackerActor = hackerActor;
    this.#target = target;
    this.#onUnlocked = onUnlocked;
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-hacking-dialog",
    classes: ["fallout-maw", "fallout-maw-trap-disarm-dialog", "fallout-maw-hacking-dialog"],
    position: { width: 900, height: "auto" },
    window: { resizable: true },
    actions: {
      selectTool: this.#onSelectTool,
      attemptHack: this.#onAttemptHack,
      closeDialog: this.#onCloseDialog
    }
  };

  static PARTS = {
    body: { template: TEMPLATES.hackingDialog }
  };

  get title() {
    return `Взлом — ${getHackingTargetName(this.#target)}`;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const methods = this.#localMethods ?? getHackingTargetMethods(this.#target);
    const unlocked = this.#unlocked || !isHackingTargetLocked(this.#target);
    const candidates = getHackingToolCandidates(this.#hackerActor, methods);
    if (!this.#selectedCandidateKey || !candidates.some(candidate => candidate.candidateKey === this.#selectedCandidateKey)) {
      this.#selectedCandidateKey = String(candidates[0]?.candidateKey ?? "");
    }
    const selectedCandidate = candidates.find(candidate => candidate.candidateKey === this.#selectedCandidateKey) ?? null;
    const selectedMethod = methods.find(method => method.id === selectedCandidate?.methodId) ?? null;
    const availableMethods = methods.filter(method => method.attemptsRemaining > 0);
    return {
      ...context,
      targetName: getHackingTargetName(this.#target),
      difficulty: selectedMethod?.difficulty ?? "—",
      requiredClass: selectedMethod?.toolClass ?? "—",
      methodLabel: selectedMethod ? getToolLabel(selectedMethod.toolKey) : "Метод не выбран",
      attemptsRemaining: selectedMethod?.attemptsRemaining ?? 0,
      attemptsTotal: selectedMethod?.attempts ?? 0,
      statusLabel: unlocked
        ? "Замок вскрыт"
        : (availableMethods.length ? "Объект заперт" : "Попытки исчерпаны"),
      statusClass: unlocked ? "status-ok" : (availableMethods.length ? "status-warn" : "status-bad"),
      tools: candidates.map(candidate => ({
        ...candidate,
        selected: candidate.candidateKey === this.#selectedCandidateKey
      })),
      hasTools: candidates.length > 0,
      hackDisabled: unlocked || !selectedCandidate || selectedMethod?.attemptsRemaining <= 0 || !this.#hackerActor?.isOwner
    };
  }

  static #onSelectTool(event, target) {
    event.preventDefault();
    this.#selectedCandidateKey = String(target.dataset.hackingCandidate ?? "");
    return this.render({ force: true });
  }

  static async #onAttemptHack(event) {
    event.preventDefault();
    if (this.#attemptInFlight || !isHackingTargetLocked(this.#target)) return undefined;
    const methods = this.#localMethods ?? getHackingTargetMethods(this.#target);
    const selectedCandidate = getHackingToolCandidates(this.#hackerActor, methods)
      .find(candidate => candidate.candidateKey === this.#selectedCandidateKey);
    const selectedMethod = methods.find(method => method.id === selectedCandidate?.methodId);
    if (!selectedCandidate || !selectedMethod || selectedMethod.attemptsRemaining <= 0) {
      ui.notifications.warn("Нет доступного метода и инструмента для взлома.");
      return this.render({ force: true });
    }

    this.#attemptInFlight = true;
    try {
      const outcome = await requestSkillCheck({
        actor: this.#hackerActor,
        skillKey: "lockpicking",
        data: {
          difficulty: selectedMethod.difficulty,
          allowImplicitTarget: false,
          targetActor: this.#target?.documentName === "Actor" ? this.#target : null
        },
        animate: false,
        createMessage: true,
        prompt: false,
        requester: "hacking"
      });
      if (!outcome) return undefined;

      const result = await requestApplyHackingResult({
        hackerActor: this.#hackerActor,
        target: this.#target,
        methodId: selectedMethod.id,
        toolItemId: selectedCandidate.itemId,
        success: isSkillCheckSuccess(outcome)
      });
      if (!result) return undefined;
      this.#localMethods = normalizeHackingMethods(result.methods);
      if (result.unlocked) {
        this.#unlocked = true;
        await this.close();
        return this.#onUnlocked?.();
      }
    } finally {
      this.#attemptInFlight = false;
    }
    return this.render({ force: true });
  }

  static #onCloseDialog(event) {
    event.preventDefault();
    return this.close();
  }
}

function activateWallHackingConfig(application, element) {
  if (!game.user?.isGM || !application?.document || element?.querySelector?.("[data-hacking-methods-editor]")) return;
  const wall = application.document;
  const body = element.querySelector(".standard-form.scrollable");
  const doorAnimation = body?.querySelector(".door-animation");
  if (!body || !doorAnimation) return;

  const wrapper = document.createElement("div");
  wrapper.innerHTML = buildWallHackingFieldset(getHackingTargetMethods(wall));
  const fieldset = wrapper.firstElementChild;
  doorAnimation.before(fieldset);
  activateHackingMethodsEditor(element);

  const doorSelect = application.form?.elements?.door;
  const syncVisibility = () => {
    fieldset.hidden = Number(doorSelect?.value ?? wall.door) <= CONST.WALL_DOOR_TYPES.NONE;
  };
  doorSelect?.addEventListener("change", syncVisibility);
  syncVisibility();
  application.setPosition();
}

function buildWallHackingFieldset(methods) {
  return `
    <fieldset data-hacking-methods-editor data-hacking-field-prefix="${HACKING_FLAG_PATH}.methods">
      <legend>Методы взлома</legend>
      <input type="hidden" name="${HACKING_FLAG_PATH}.editorSubmitted" value="true">
      <p class="hint">Каждый метод использует отдельный тип инструмента и имеет собственные параметры.</p>
      <div data-hacking-method-list>
        ${methods.map((method, index) => buildHackingMethodRow(method, index, `${HACKING_FLAG_PATH}.methods`)).join("")}
      </div>
      <button type="button" data-action="addHackingMethod">
        <i class="fa-solid fa-plus"></i> Добавить
      </button>
    </fieldset>`;
}

function buildHackingSettingsContent(methods, { includeEnabled = false, enabled = false } = {}) {
  return `
    <div class="standard-form" data-hacking-methods-editor data-hacking-field-prefix="methods">
      ${includeEnabled ? `
        <label class="form-group">
          <span>Объект заперт</span>
          <input type="checkbox" name="enabled" ${enabled ? "checked" : ""}>
        </label>` : ""}
      <fieldset>
        <legend>Методы взлома</legend>
        <p class="hint">Добавьте один или несколько способов вскрытия объекта.</p>
        <div data-hacking-method-list>
          ${methods.map((method, index) => buildHackingMethodRow(method, index, "methods")).join("")}
        </div>
        <button type="button" data-action="addHackingMethod">
          <i class="fa-solid fa-plus"></i> Добавить
        </button>
      </fieldset>
    </div>`;
}

function buildHackingMethodRow(method, index, prefix) {
  const normalized = normalizeHackingMethod(method);
  const toolOptions = getToolSettings().map(tool => `
    <option value="${escapeAttribute(tool.key)}" ${tool.key === normalized.toolKey ? "selected" : ""}>
      ${escapeHTML(tool.label)}
    </option>`).join("");
  const classOptions = Object.keys(TOOL_CLASS_RANKS).map(toolClass => `
    <option value="${toolClass}" ${toolClass === normalized.toolClass ? "selected" : ""}>${toolClass}</option>`).join("");
  return `
    <div class="fallout-maw-hacking-method" data-hacking-method-row data-hacking-method-index="${index}">
      <input type="hidden" name="${prefix}.${index}.id" value="${escapeAttribute(normalized.id)}">
      <div class="fallout-maw-hacking-method-grid">
        <label class="fallout-maw-hacking-method-tool">
          <span>Инструмент</span>
          <select name="${prefix}.${index}.toolKey">${toolOptions}</select>
        </label>
        <label>
          <span>Класс</span>
          <select name="${prefix}.${index}.toolClass">${classOptions}</select>
        </label>
        <label>
          <span>Сложность</span>
          <input type="number" name="${prefix}.${index}.difficulty" value="${normalized.difficulty}" min="0" step="1">
        </label>
        <label>
          <span>Расход за попытку</span>
          <input type="number" name="${prefix}.${index}.toolCost" value="${normalized.toolCost}" min="1" step="1">
        </label>
        <label>
          <span>Всего попыток</span>
          <input type="number" name="${prefix}.${index}.attempts" value="${normalized.attempts}" min="0" step="1">
        </label>
        <label>
          <span>Осталось</span>
          <input type="number" name="${prefix}.${index}.attemptsRemaining" value="${normalized.attemptsRemaining}" min="0" step="1">
        </label>
        <button type="button" class="fallout-maw-hacking-method-delete" data-action="deleteHackingMethod" aria-label="Удалить метод">
          <i class="fa-solid fa-trash"></i>
        </button>
      </div>
    </div>`;
}

function activateHackingMethodsEditor(root) {
  for (const editor of root.querySelectorAll("[data-hacking-methods-editor]")) {
    if (editor.dataset.hackingEditorActive === "true") continue;
    editor.dataset.hackingEditorActive = "true";
    editor.addEventListener("click", event => {
      const action = event.target.closest("[data-action]")?.dataset.action;
      if (action === "deleteHackingMethod") {
        event.preventDefault();
        event.stopPropagation();
        event.target.closest("[data-hacking-method-row]")?.remove();
        return;
      }
      if (action !== "addHackingMethod") return;
      event.preventDefault();
      event.stopPropagation();
      const list = editor.querySelector("[data-hacking-method-list]");
      const prefix = editor.dataset.hackingFieldPrefix || "methods";
      const indexes = Array.from(list?.querySelectorAll("[data-hacking-method-row]") ?? [])
        .map(row => toInteger(row.dataset.hackingMethodIndex));
      const index = indexes.length ? Math.max(...indexes) + 1 : 0;
      list?.insertAdjacentHTML("beforeend", buildHackingMethodRow(createHackingMethod(), index, prefix));
    });
  }
}

function prepareWallHackingUpdate(wall, changes) {
  const editorMarker = foundry.utils.getProperty(changes, `${HACKING_FLAG_PATH}.editorSubmitted`);
  const editorSubmitted = editorMarker === true || editorMarker === "true";
  const locking = changes.ds === CONST.WALL_DOOR_STATES.LOCKED && wall.ds !== CONST.WALL_DOOR_STATES.LOCKED;
  if (!editorSubmitted && !locking) return;

  if (editorSubmitted) foundry.utils.deleteProperty(changes, `${HACKING_FLAG_PATH}.editorSubmitted`);
  const submitted = foundry.utils.getProperty(changes, `${HACKING_FLAG_PATH}.methods`);
  const methods = normalizeHackingMethods(editorSubmitted ? submitted : getHackingTargetMethods(wall));
  if (locking) {
    for (const method of methods) method.attemptsRemaining = method.attempts;
  }
  foundry.utils.setProperty(changes, `${HACKING_FLAG_PATH}.methods`, methods);
}

function patchDoorControl() {
  if (doorControlPatched) return;
  const DoorControlClass = CONFIG.Canvas?.doorControlClass;
  if (!DoorControlClass?.prototype?._onMouseDown) return;
  const original = DoorControlClass.prototype._onMouseDown;
  DoorControlClass.prototype._onMouseDown = function(event) {
    const wall = this.wall?.document;
    const methods = getHackingTargetMethods(wall);
    if (event?.button !== 0 || wall?.ds !== CONST.WALL_DOOR_STATES.LOCKED || !methods.length) {
      return original.call(this, event);
    }
    event.stopPropagation();
    if (!game.user?.can("WALL_DOORS")) return false;
    if (game.paused && !game.user?.isGM) {
      ui.notifications.warn("GAME.PausedWarning", { localize: true });
      return false;
    }
    const hackerActor = getDoorHackerActor();
    if (!hackerActor) {
      ui.notifications.warn("Для взлома двери нужен выбранный актёр.");
      return false;
    }
    void requestWallHacking({ hackerActor, wall });
    return false;
  };
  doorControlPatched = true;
}

async function requestApplyHackingResult({ hackerActor, target, methodId, toolItemId, success }) {
  const payload = {
    hackerActorUuid: hackerActor?.uuid ?? "",
    targetUuid: target?.uuid ?? "",
    methodId: String(methodId ?? ""),
    toolItemId: String(toolItemId ?? ""),
    success: Boolean(success)
  };
  if (!payload.hackerActorUuid || !payload.targetUuid || !payload.methodId) return null;
  if (game.user?.isGM) return applyHackingResultNow(payload);

  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("Нет активного GM для взлома.");
    return null;
  }
  const requestId = foundry.utils.randomID();
  const promise = new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingHackingRequests.delete(requestId);
      reject(new Error("GM did not answer hacking request."));
    }, HACKING_SOCKET_TIMEOUT);
    pendingHackingRequests.set(requestId, { resolve, reject, timeout });
  });
  game.socket.emit(HACKING_SOCKET, {
    scope: HACKING_SOCKET_SCOPE,
    type: "request",
    requestId,
    requesterUserId: game.user?.id ?? "",
    gmUserId: gm.id,
    payload
  });
  try {
    return await promise;
  } catch (error) {
    console.error(`${SYSTEM_ID} | Hacking request failed`, error);
    ui.notifications.warn("GM не ответил на запрос взлома.");
    return null;
  }
}

async function handleHackingSocketMessage(message = {}) {
  if (message?.scope !== HACKING_SOCKET_SCOPE) return;
  if (message.type === "response") {
    if (message.recipientUserId && message.recipientUserId !== game.user?.id) return;
    const pending = pendingHackingRequests.get(message.requestId);
    if (!pending) return;
    window.clearTimeout(pending.timeout);
    pendingHackingRequests.delete(message.requestId);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error || "Hacking request failed."));
    return;
  }
  if (message.type !== "request" || !game.user?.isGM || message.gmUserId !== game.user.id) return;
  try {
    const result = await applyHackingResultNow(message.payload);
    game.socket.emit(HACKING_SOCKET, {
      scope: HACKING_SOCKET_SCOPE,
      type: "response",
      requestId: message.requestId,
      recipientUserId: message.requesterUserId,
      ok: true,
      result
    });
  } catch (error) {
    console.error(`${SYSTEM_ID} | Hacking result failed`, error);
    game.socket.emit(HACKING_SOCKET, {
      scope: HACKING_SOCKET_SCOPE,
      type: "response",
      requestId: message.requestId,
      recipientUserId: message.requesterUserId,
      ok: false,
      error: error.message
    });
  }
}

async function applyHackingResultNow({
  hackerActorUuid = "",
  targetUuid = "",
  methodId = "",
  toolItemId = "",
  success = false
} = {}) {
  const hackerActor = await fromUuid(hackerActorUuid);
  const target = await fromUuid(targetUuid);
  if (!hackerActor || !target || !isHackingTargetLocked(target)) throw new Error("Цель взлома недоступна.");

  const methods = getHackingTargetMethods(target);
  const method = methods.find(entry => entry.id === methodId);
  if (!method || method.attemptsRemaining <= 0) throw new Error("Попытки этого метода исчерпаны.");
  const candidate = getHackingToolCandidates(hackerActor, [method])
    .find(entry => entry.itemId === toolItemId);
  if (!candidate) {
    throw new Error("Подходящий инструмент больше недоступен.");
  }

  const toolItem = hackerActor.items?.get(toolItemId);
  const toolFunction = getEnabledToolFunctions(toolItem)
    .find(tool => String(tool.toolKey ?? "") === method.toolKey);
  const currentSupply = Math.max(0, toInteger(toolFunction?.supply?.value));
  if (!toolItem || !toolFunction || currentSupply < method.toolCost) {
    throw new Error("Запаса инструмента недостаточно для попытки.");
  }
  const remainingSupply = currentSupply - method.toolCost;
  await toolItem.update({
    [`system.functions.tools.${method.toolKey}.supply.value`]: remainingSupply
  }, { render: false });

  method.attemptsRemaining = Math.max(0, method.attemptsRemaining - 1);
  const updates = isWallHackingTarget(target)
    ? {
        ds: success ? CONST.WALL_DOOR_STATES.CLOSED : target.ds,
        [`${HACKING_FLAG_PATH}.methods`]: methods
      }
    : {
        "system.hacking.enabled": success ? false : true,
        "system.hacking.methods": methods
      };
  await target.update(updates, { render: false });

  const resultText = success
    ? `вскрывает замок на объекте <strong>${escapeHTML(getHackingTargetName(target))}</strong>`
    : `не смог вскрыть замок на объекте <strong>${escapeHTML(getHackingTargetName(target))}</strong> методом «${escapeHTML(getToolLabel(method.toolKey))}». Осталось попыток: ${method.attemptsRemaining}`;
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: hackerActor }),
    content: `<p><strong>${escapeHTML(hackerActor.name)}</strong> ${resultText}. Расход инструмента: ${method.toolCost}; осталось: ${remainingSupply}.</p>`
  });
  if (success) ui.notifications.info(`${getHackingTargetName(target)}: замок вскрыт.`);
  else if (method.attemptsRemaining <= 0) ui.notifications.warn(`${getToolLabel(method.toolKey)}: попытки закончились.`);
  return { unlocked: Boolean(success), methods };
}

function getHackingToolCandidates(actor, methods) {
  if (!actor) return [];
  const tools = actor.items?.contents ?? [];
  return methods.flatMap(method => {
    if (method.attemptsRemaining <= 0 || !method.toolKey) return [];
    return tools.flatMap(item => getEnabledToolFunctions(item)
      .filter(tool => String(tool.toolKey ?? "") === method.toolKey)
      .map(tool => {
        const supplyMax = Math.max(0, toInteger(tool.supply?.max));
        const supplyValue = Math.max(0, Math.min(supplyMax || Number.MAX_SAFE_INTEGER, toInteger(tool.supply?.value)));
        return {
          candidateKey: `${method.id}:${item.id}`,
          methodId: method.id,
          methodLabel: getToolLabel(method.toolKey),
          attemptsRemaining: method.attemptsRemaining,
          toolCost: method.toolCost,
          itemId: item.id,
          name: item.name,
          toolClass: normalizeToolClass(tool.toolClass),
          supplyValue,
          supplyMax
        };
      })
      .filter(tool => isToolClassAtLeast(tool.toolClass, method.toolClass) && tool.supplyValue >= method.toolCost));
  }).sort((left, right) => {
    const methodDelta = left.methodLabel.localeCompare(right.methodLabel);
    if (methodDelta) return methodDelta;
    const rankDelta = TOOL_CLASS_RANKS[right.toolClass] - TOOL_CLASS_RANKS[left.toolClass];
    return rankDelta || String(left.name).localeCompare(String(right.name));
  });
}

function getHackingTargetMethods(target) {
  if (isWallHackingTarget(target)) {
    return normalizeHackingMethods(target.getFlag?.(SYSTEM_ID, "hacking")?.methods);
  }
  return normalizeHackingMethods(target?.system?.hacking?.methods);
}

function isHackingTargetLocked(target) {
  if (isWallHackingTarget(target)) return target.ds === CONST.WALL_DOOR_STATES.LOCKED;
  return target?.system?.hacking?.enabled === true;
}

function isWallHackingTarget(target) {
  return target?.documentName === "Wall";
}

function getHackingTargetName(target) {
  if (isWallHackingTarget(target)) return target.parent?.name ? `Дверь — ${target.parent.name}` : "Дверь";
  return String(target?.name ?? "Объект");
}

function getDoorHackerActor() {
  return (canvas?.tokens?.controlled ?? [])
    .map(token => token?.actor)
    .find(actor => actor?.isOwner)
    ?? (game.user?.character?.isOwner ? game.user.character : null);
}

function normalizeActorHackingState(value = {}) {
  return {
    enabled: value?.enabled === true,
    methods: normalizeHackingMethods(value?.methods)
  };
}

function normalizeHackingMethods(value) {
  const source = Array.isArray(value) ? value : Object.values(value ?? {});
  return source.map(normalizeHackingMethod).filter(method => method.toolKey);
}

function normalizeHackingMethod(value = {}) {
  const attempts = Math.max(0, toInteger(value?.attempts ?? 3));
  const toolSettings = getToolSettings();
  const fallbackToolKey = String(toolSettings[0]?.key ?? "");
  const configuredToolKey = String(value?.toolKey ?? "").trim();
  return {
    id: String(value?.id ?? "").trim() || foundry.utils.randomID(),
    toolKey: toolSettings.some(tool => tool.key === configuredToolKey) ? configuredToolKey : fallbackToolKey,
    toolClass: normalizeToolClass(value?.toolClass),
    difficulty: Math.max(0, toInteger(value?.difficulty ?? 60)),
    toolCost: Math.max(1, toInteger(value?.toolCost ?? 1)),
    attempts,
    attemptsRemaining: Math.max(0, Math.min(attempts, toInteger(value?.attemptsRemaining ?? attempts)))
  };
}

function createHackingMethod() {
  return normalizeHackingMethod({});
}

function normalizeToolClass(value) {
  const key = String(value ?? "D").trim().toUpperCase();
  return Object.hasOwn(TOOL_CLASS_RANKS, key) ? key : "D";
}

function isToolClassAtLeast(actualClass, requiredClass) {
  return TOOL_CLASS_RANKS[normalizeToolClass(actualClass)] >= TOOL_CLASS_RANKS[normalizeToolClass(requiredClass)];
}

function getToolLabel(toolKey) {
  return getToolSettings().find(tool => tool.key === toolKey)?.label ?? toolKey;
}

function isSkillCheckSuccess(outcome) {
  return outcome?.result?.key === "success" || outcome?.result?.key === "criticalSuccess";
}

function getResponsibleGM() {
  return game.users?.activeGM ?? (game.users?.contents ?? [])
    .filter(user => user.active && user.isGM)
    .sort((left, right) => left.id.localeCompare(right.id))
    .at(0) ?? null;
}

function escapeHTML(value) {
  const div = document.createElement("div");
  div.textContent = String(value ?? "");
  return div.innerHTML;
}

function escapeAttribute(value) {
  return escapeHTML(value).replaceAll('"', "&quot;");
}
