import { SYSTEM_ID, TEMPLATES } from "../constants.mjs";
import { requestSkillCheck } from "../rolls/skill-check.mjs";
import { getHackingSettings, getSkillSettings, getToolSettings } from "../settings/accessors.mjs";
import { getEnabledToolFunctions, getToolResourceState } from "../utils/item-functions.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { executeInventoryMutation } from "../inventory/mutation.mjs";
import { createActorOperationLock } from "../utils/actor-operation-lock.mjs";
import { getActorToolSupplyCost } from "../utils/tool-supply-cost.mjs";
import { buildHackingDialogState, getHackingCandidateBlockReason } from "./hacking-dialog-state.mjs";
import { syncHackingDOM } from "./hacking-dialog-dom.mjs";

const { ApplicationV2, DialogV2, HandlebarsApplicationMixin } = foundry.applications.api;
const HACKING_SOCKET = `system.${SYSTEM_ID}`;
const HACKING_SOCKET_SCOPE = "fallout-maw.hacking";
const HACKING_FLAG_PATH = `flags.${SYSTEM_ID}.hacking`;
const HACKING_SOCKET_TIMEOUT = 10000;
const TOOL_CLASS_RANKS = Object.freeze({ D: 0, C: 1, B: 2, A: 3, S: 4 });
const pendingHackingRequests = new Map();
const hackingMutationLock = createActorOperationLock();
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
  #selectedMethodId = "";
  #localMethods = null;
  #unlocked = false;
  #attemptInFlight = false;
  #onUnlocked = null;
  #busy = "";
  #feedback = null;
  #hookIds = [];
  #refreshTimer = null;
  #closed = false;
  #targetAvailable = true;
  #viewState = null;
  #choosingMethod = false;
  #focusAfterRender = "";
  #isMechanical = false;
  #keyboardMenu = null;

  constructor({ hackerActor, target, onUnlocked = null } = {}) {
    super();
    this.#hackerActor = hackerActor;
    this.#target = target;
    this.#onUnlocked = onUnlocked;
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-hacking-dialog",
    classes: ["fallout-maw", "fallout-maw-hacking-dialog"],
    position: { width: 740, height: "auto" },
    window: { resizable: true },
    actions: {
      chooseMethod: this.#onChooseMethod,
      showTools: this.#onShowTools,
      selectMethod: this.#onSelectMethod,
      selectTool: this.#onSelectTool,
      attemptHack: this.#onAttemptHack,
      closeDialog: this.#onCloseDialog
    }
  };

  static PARTS = {
    body: { template: TEMPLATES.hackingDialog }
  };

  get title() {
    return this.#isMechanical ? "Взлом // Механика" : "Взлом // Терминал доступа";
  }

  _configureRenderOptions(options) {
    const explicitHeight = Object.hasOwn(options.position ?? {}, "height");
    super._configureRenderOptions(options);
    if (options.isFirstRender || explicitHeight) return;
    // ApplicationV2 otherwise re-applies DEFAULT_OPTIONS.height="auto" on every
    // update, changing the frame size as busy messages and results appear.
    if (options.position?.height === "auto") {
      delete options.position.height;
      if (!Object.keys(options.position).length) delete options.position;
    }
    if (this.minimized) return;
    const scale = Number(this.position?.scale) || 1;
    const height = this.element?.getBoundingClientRect?.().height / scale || this.element?.offsetHeight;
    if (height > 0) {
      this.setPosition({ height });
      options.position = { ...options.position, height };
    }
  }

  _replaceHTML(result, content, options) {
    const current = this.parts?.body;
    const next = result.body;
    if (current?.isConnected && next && current.className === next.className) {
      // There are no part-level forms/listeners here. Keeping the registered
      // part in place also keeps focus, scrolling and frame-delegated actions.
      syncHackingDOM(current, next);
      return;
    }
    super._replaceHTML(result, content, options);
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const methods = this.#localMethods ?? getHackingTargetMethods(this.#target);
    const unlocked = this.#unlocked || !isHackingTargetLocked(this.#target);
    const candidates = getHackingToolCandidates(this.#hackerActor, methods, this.#target, { includeUnavailable: true });
    const skillKey = getHackingSettings().skillKey;
    const state = buildHackingDialogState({
      methods: methods.map(method => ({ ...method, label: getToolLabel(method.toolKey) })),
      candidates,
      selectedMethodId: this.#selectedMethodId,
      selectedCandidateKey: this.#selectedCandidateKey,
      unlocked,
      isOwner: Boolean(this.#hackerActor?.isOwner),
      hasSkill: Boolean(this.#hackerActor?.system?.skills?.[skillKey]),
      hasGM: Boolean(game.user?.isGM || getResponsibleGM()),
      targetAvailable: this.#targetAvailable,
      busy: this.#busy
    });
    this.#selectedMethodId = state.selectedMethodId;
    this.#isMechanical = state.isMechanical;
    this.#selectedCandidateKey = state.selectedCandidateKey;
    return {
      ...context,
      ...state,
      targetName: getHackingTargetName(this.#target),
      choosingMethod: this.#choosingMethod,
      canChooseMethod: methods.length > 1,
      hackerName: this.#hackerActor?.name ?? "Персонаж",
      skillLabel: getSkillSettings().find(skill => skill.key === skillKey)?.label ?? skillKey,
      feedback: this.#feedback
    };
  }

  async _preRender(context, options) {
    const root = this.element;
    const active = root?.contains(document.activeElement) ? document.activeElement : null;
    this.#viewState = {
      focusKey: active?.dataset?.focusKey,
      scrolls: Array.from(root?.querySelectorAll("[data-hack-scroll]") ?? [])
        .map(element => [element.dataset.hackScroll, element.scrollTop])
    };
    await super._preRender(context, options);
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    if (this.#closed) return;
    const root = this.element;
    root.classList?.toggle("is-mechanical", context.isMechanical);
    const title = root.querySelector?.(".window-title");
    if (title) title.textContent = this.title;
    for (const element of root.querySelectorAll("[data-hack-scroll]")) {
      element.scrollTop = this.#focusAfterRender ? 0
        : this.#viewState?.scrolls.find(([key]) => key === element.dataset.hackScroll)?.[1] ?? 0;
    }
    const focus = Array.from(root.querySelectorAll("[data-focus-key]"))
      .find(element => element.dataset.focusKey === this.#viewState?.focusKey);
    if (focus && !focus.disabled) focus.focus({ preventScroll: true });
    if (this.#focusAfterRender) {
      const action = this.#focusAfterRender;
      const menuFocus = root.querySelector?.(`[data-action="${action}"][aria-pressed="true"]`)
        ?? root.querySelector?.(`[data-action="${action}"]:not(:disabled)`)
        ?? root.querySelector?.('[data-action="closeDialog"]');
      menuFocus?.focus({ preventScroll: true });
      this.#focusAfterRender = "";
    }
    const menu = root.querySelector?.("[data-hack-options]");
    if (menu && menu !== this.#keyboardMenu) menu.addEventListener("keydown", event => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const buttons = Array.from(event.currentTarget.querySelectorAll("button:not(:disabled)"));
      const index = buttons.indexOf(event.target);
      if (index < 0 || !buttons.length) return;
      event.preventDefault();
      event.stopPropagation();
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus();
    });
    this.#keyboardMenu = menu;
    if (!this.#hookIds.length) this.#bindDocumentHooks();
  }

  #bindDocumentHooks() {
    const refresh = (document, deleted = false) => {
      const isTarget = document?.uuid === this.#target?.uuid;
      const isHacker = document?.uuid === this.#hackerActor?.uuid;
      const isTool = document?.parent?.uuid === this.#hackerActor?.uuid;
      if (!isTarget && !isHacker && !isTool && document?.documentName !== "User") return;
      if (isTarget || isHacker) {
        this.#localMethods = null;
        if (deleted) this.#targetAvailable = false;
      }
      this.#scheduleRefresh();
    };
    for (const hook of ["updateActor", "updateWall", "createItem", "updateItem", "updateUser"]) {
      this.#hookIds.push([hook, Hooks.on(hook, document => refresh(document))]);
    }
    for (const hook of ["deleteActor", "deleteWall", "deleteItem"]) {
      this.#hookIds.push([hook, Hooks.on(hook, document => refresh(document, true))]);
    }
    this.#hookIds.push(["userConnected", Hooks.on("userConnected", () => this.#scheduleRefresh())]);
  }

  #scheduleRefresh() {
    if (this.#closed || this.#attemptInFlight) return;
    clearTimeout(this.#refreshTimer);
    this.#refreshTimer = setTimeout(() => {
      if (!this.#closed && !this.#attemptInFlight) void this.render();
    }, 60);
  }

  async close(options = {}) {
    this.#closed = true;
    clearTimeout(this.#refreshTimer);
    for (const [hook, id] of this.#hookIds) Hooks.off(hook, id);
    this.#hookIds = [];
    return super.close(options);
  }

  static #onSelectMethod(event, target) {
    event.preventDefault();
    if (this.#attemptInFlight) return;
    this.#selectedMethodId = String(target.dataset.hackingMethod ?? "");
    this.#selectedCandidateKey = "";
    this.#choosingMethod = false;
    this.#focusAfterRender = "selectTool";
    return this.render();
  }

  static #onChooseMethod(event) {
    event.preventDefault();
    if (this.#attemptInFlight) return;
    this.#choosingMethod = true;
    this.#focusAfterRender = "selectMethod";
    return this.render();
  }

  static #onShowTools(event) {
    event.preventDefault();
    if (this.#attemptInFlight) return;
    this.#choosingMethod = false;
    this.#focusAfterRender = "chooseMethod";
    return this.render();
  }

  static #onSelectTool(event, target) {
    event.preventDefault();
    if (this.#attemptInFlight) return;
    const candidateKey = String(target.dataset.hackingCandidate ?? "");
    if (candidateKey === this.#selectedCandidateKey) return;
    this.#selectedCandidateKey = candidateKey;
    return this.render();
  }

  static async #onAttemptHack(event) {
    event.preventDefault();
    if (this.#attemptInFlight || this.#closed || !this.#targetAvailable || !this.#hackerActor?.isOwner
      || !isHackingTargetLocked(this.#target)) return undefined;
    if (!game.user?.isGM && !getResponsibleGM()) return this.render();
    const methods = this.#localMethods ?? getHackingTargetMethods(this.#target);
    const selectedCandidate = getHackingToolCandidates(this.#hackerActor, methods, this.#target)
      .find(candidate => candidate.candidateKey === this.#selectedCandidateKey);
    const selectedMethod = methods.find(method => method.id === selectedCandidate?.methodId);
    if (!selectedCandidate || !selectedMethod || selectedMethod.attemptsRemaining <= 0) {
      ui.notifications.warn("Нет доступного метода и инструмента для взлома.");
      return this.render();
    }

    this.#attemptInFlight = true;
    this.#feedback = null;
    this.#busy = "Проверка…";
    try {
      await this.render();
      const skillKey = getHackingSettings().skillKey;
      if (!this.#hackerActor?.system?.skills?.[skillKey]) {
        ui.notifications.warn("У актёра нет выбранного для взлома навыка.");
        return undefined;
      }
      const outcome = await requestSkillCheck({
        actor: this.#hackerActor,
        skillKey,
        data: {
          difficulty: selectedMethod.difficulty,
          allowImplicitTarget: false,
          targetActor: this.#target?.documentName === "Actor" ? this.#target : null,
          toolContext: {
            itemId: selectedCandidate.itemId,
            itemUuid: selectedCandidate.itemUuid,
            toolKey: selectedMethod.toolKey,
            toolClass: selectedCandidate.toolClass,
            requiredClass: selectedMethod.toolClass
          }
        },
        animate: false,
        createMessage: true,
        prompt: false,
        requester: "hacking"
      });
      if (!outcome) {
        this.#feedback = { tone: "neutral", title: "Проверка отменена", text: "Попытка взлома не применена." };
        return undefined;
      }

      this.#busy = "Применение результата…";
      if (!this.#closed) await this.render();
      const result = await requestApplyHackingResult({
        hackerActor: this.#hackerActor,
        target: this.#target,
        methodId: selectedMethod.id,
        toolItemId: selectedCandidate.itemId,
        success: isSkillCheckSuccess(outcome)
      });
      if (!result) throw new Error("Результат взлома не подтверждён. Проверьте состояние объекта перед следующей попыткой.");
      this.#localMethods = normalizeHackingMethods(result.methods);
      if (result.unlocked) {
        this.#unlocked = true;
        await this.close();
        return this.#onUnlocked?.();
      }
      const remaining = this.#localMethods.find(method => method.id === selectedMethod.id)?.attemptsRemaining ?? 0;
      this.#feedback = {
        tone: "bad",
        title: "Замок не поддался",
        text: `${getToolLabel(selectedMethod.toolKey)}. Израсходовано: ${selectedCandidate.toolCost}. Осталось попыток: ${remaining}.`
      };
    } catch (error) {
      console.error(`${SYSTEM_ID} | Hacking attempt failed`, error);
      this.#localMethods = null;
      this.#feedback = { tone: "bad", title: "Не удалось подтвердить результат", text: error.message || "Проверьте состояние объекта перед следующей попыткой." };
    } finally {
      this.#attemptInFlight = false;
      this.#busy = "";
      if (!this.#closed) await this.render();
    }
    return undefined;
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
        <label class="fallout-maw-hacking-method-interface">
          <span>Интерфейс</span>
          <select name="${prefix}.${index}.interfaceType">
            <option value="terminal" ${normalized.interfaceType === "terminal" ? "selected" : ""}>Терминал</option>
            <option value="mechanical" ${normalized.interfaceType === "mechanical" ? "selected" : ""}>Механика</option>
          </select>
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
  return runWithHackingMutationLocks([hackerActor, target], () => applyHackingResultLocked({
    hackerActor,
    target,
    methodId,
    toolItemId,
    success
  }));
}

async function applyHackingResultLocked({
  hackerActor,
  target,
  methodId,
  toolItemId,
  success
}) {
  if (!hackerActor || !target || !isHackingTargetLocked(target)) throw new Error("Цель взлома недоступна.");

  const methods = getHackingTargetMethods(target);
  const method = methods.find(entry => entry.id === methodId);
  if (!method || method.attemptsRemaining <= 0) throw new Error("Попытки этого метода исчерпаны.");
  const candidate = getHackingToolCandidates(hackerActor, [method], target)
    .find(entry => entry.itemId === toolItemId);
  if (!candidate) {
    throw new Error("Подходящий инструмент больше недоступен.");
  }

  const toolItem = hackerActor.items?.get(toolItemId);
  const toolFunction = getEnabledToolFunctions(toolItem)
    .find(tool => String(tool.toolKey ?? "") === method.toolKey);
  const toolResource = toolFunction?.resource ?? getToolResourceState(toolItem, toolFunction);
  const currentSupply = toolResource.available ? toolResource.value : 0;
  const toolCost = candidate.toolCost;
  if (!toolItem || !toolFunction || currentSupply < toolCost) {
    throw new Error("Запаса инструмента недостаточно для попытки.");
  }
  const remainingSupply = currentSupply - toolCost;
  const previousMethods = foundry.utils.deepClone(methods);
  const previousDoorState = target.ds;
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
  const toolUpdate = {
    _id: toolItem.id,
    [toolResource.updatePath]: remainingSupply
  };
  if (isWallHackingTarget(target)) {
    await commitWallHackingBatch([{
      action: "update",
      documentName: "Item",
      parent: hackerActor,
      updates: [toolUpdate],
      render: false
    }, {
      action: "update",
      documentName: "Wall",
      parent: target.parent,
      updates: [{ _id: target.id, ...updates }],
      render: false
    }], {
      hackerActor,
      target,
      toolItem,
      toolKey: method.toolKey,
      toolResourcePath: toolResource.updatePath,
      previousSupply: currentSupply,
      appliedSupply: remainingSupply,
      previousDoorState,
      appliedDoorState: updates.ds,
      previousMethods,
      appliedMethods: methods
    });
  } else {
    await executeInventoryMutation([
      {
        actor: hackerActor,
        updates: [toolUpdate]
      },
      {
        actor: target,
        actorUpdates: [updates]
      }
    ], { reason: "hacking-attempt" });
  }

  const resultText = success
    ? `вскрывает замок на объекте <strong>${escapeHTML(getHackingTargetName(target))}</strong>`
    : `не смог вскрыть замок на объекте <strong>${escapeHTML(getHackingTargetName(target))}</strong> методом «${escapeHTML(getToolLabel(method.toolKey))}». Осталось попыток: ${method.attemptsRemaining}`;
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: hackerActor }),
    content: `<p><strong>${escapeHTML(hackerActor.name)}</strong> ${resultText}. Расход инструмента: ${toolCost}; осталось: ${remainingSupply}.</p>`
  });
  if (success) ui.notifications.info(`${getHackingTargetName(target)}: замок вскрыт.`);
  else if (method.attemptsRemaining <= 0) ui.notifications.warn(`${getToolLabel(method.toolKey)}: попытки закончились.`);
  return { unlocked: Boolean(success), methods };
}

function runWithHackingMutationLocks(documents, operation, index = 0) {
  const ordered = index === 0
    ? Array.from(new Map(
      documents
        .filter(Boolean)
        .map(document => [String(document.uuid ?? document.id ?? ""), document])
        .filter(([key]) => key)
    ).values()).sort((left, right) => (
      String(left.uuid ?? left.id).localeCompare(String(right.uuid ?? right.id))
    ))
    : documents;
  if (index >= ordered.length) return operation();
  return hackingMutationLock.run(
    ordered[index],
    null,
    () => runWithHackingMutationLocks(ordered, operation, index + 1)
  );
}

async function commitWallHackingBatch(operations, state) {
  try {
    const results = await foundry.documents.modifyBatch(operations);
    assertCompleteHackingBatch(results, operations.length);
    if (
      getHackingToolSupply(state.toolItem, state.toolKey) !== state.appliedSupply
      || state.target.ds !== state.appliedDoorState
      || !hackingMethodsEqual(getHackingTargetMethods(state.target), state.appliedMethods)
    ) {
      throw new Error("Foundry did not persist the complete hacking operation.");
    }
  } catch (error) {
    const recoveryError = await recoverWallHackingBatch(state);
    if (recoveryError) {
      const aggregate = new AggregateError(
        [error, recoveryError],
        "Hacking failed and its previous state could not be fully restored."
      );
      aggregate.cause = error;
      throw aggregate;
    }
    throw error;
  }
}

async function recoverWallHackingBatch(state) {
  const operations = [];
  if (getHackingToolSupply(state.toolItem, state.toolKey) === state.appliedSupply) {
    operations.push({
      action: "update",
      documentName: "Item",
      parent: state.hackerActor,
      updates: [{
        _id: state.toolItem.id,
        [state.toolResourcePath]: state.previousSupply
      }],
      render: false,
      falloutMawHackingRecovery: true
    });
  }
  if (
    state.target.ds === state.appliedDoorState
    && hackingMethodsEqual(getHackingTargetMethods(state.target), state.appliedMethods)
  ) {
    operations.push({
      action: "update",
      documentName: "Wall",
      parent: state.target.parent,
      updates: [{
        _id: state.target.id,
        ds: state.previousDoorState,
        [`${HACKING_FLAG_PATH}.methods`]: state.previousMethods
      }],
      render: false,
      falloutMawHackingRecovery: true
    });
  }
  if (!operations.length) {
    const alreadyRestored = (
      getHackingToolSupply(state.toolItem, state.toolKey) === state.previousSupply
      && state.target.ds === state.previousDoorState
      && hackingMethodsEqual(getHackingTargetMethods(state.target), state.previousMethods)
    );
    return alreadyRestored ? null : new Error("Hacking state changed concurrently during recovery.");
  }

  try {
    const results = await foundry.documents.modifyBatch(operations);
    assertCompleteHackingBatch(results, operations.length);
    if (
      getHackingToolSupply(state.toolItem, state.toolKey) !== state.previousSupply
      || state.target.ds !== state.previousDoorState
      || !hackingMethodsEqual(getHackingTargetMethods(state.target), state.previousMethods)
    ) {
      throw new Error("Hacking recovery did not restore the previous state.");
    }
    return null;
  } catch (error) {
    return error;
  }
}

function assertCompleteHackingBatch(results, expectedLength) {
  if (
    !Array.isArray(results)
    || results.length !== expectedLength
    || results.some(result => !Array.isArray(result) || result.length !== 1)
  ) {
    throw new Error("Foundry returned an incomplete hacking operation batch.");
  }
}

function getHackingToolSupply(item, toolKey) {
  const tool = getEnabledToolFunctions(item)
    .find(entry => String(entry.toolKey ?? "") === String(toolKey ?? ""));
  const resource = tool?.resource ?? getToolResourceState(item, tool);
  return resource.available ? resource.value : 0;
}

function hackingMethodsEqual(left, right) {
  return JSON.stringify(normalizeHackingMethods(left)) === JSON.stringify(normalizeHackingMethods(right));
}

function getHackingToolCandidates(actor, methods, target = null, { includeUnavailable = false } = {}) {
  if (!actor) return [];
  const tools = actor.items?.contents ?? [];
  return methods.flatMap(method => {
    if (!method.toolKey) return [];
    const toolCost = getActorToolSupplyCost(actor, method.toolKey, method.toolCost, {
      requester: "hacking",
      targetActor: target?.documentName === "Actor" ? target : target?.actor ?? null,
      targetToken: target?.actor ? target : null
    });
    return tools.flatMap(item => getEnabledToolFunctions(item)
      .filter(tool => String(tool.toolKey ?? "") === method.toolKey)
      .map(tool => {
        const resource = tool.resource ?? getToolResourceState(item, tool);
        const supplyMax = resource.max;
        const supplyValue = resource.available ? resource.value : 0;
        return {
          candidateKey: `${method.id}:${item.id}`,
          methodId: method.id,
          methodLabel: getToolLabel(method.toolKey),
          attemptsRemaining: method.attemptsRemaining,
          toolCost,
          baseToolCost: method.toolCost,
          itemId: item.id,
          itemUuid: item.uuid,
          name: item.name,
          img: item.img || "icons/svg/item-bag.svg",
          toolClass: normalizeToolClass(tool.toolClass),
          blockReason: getHackingCandidateBlockReason({
            attemptsRemaining: method.attemptsRemaining,
            toolClass: normalizeToolClass(tool.toolClass),
            requiredClass: method.toolClass,
            resourceConfigured: resource.configured,
            supplyValue,
            toolCost
          }),
          resourceMode: resource.mode,
          supplyValue,
          supplyMax
        };
      })
      .filter(tool => includeUnavailable || !tool.blockReason));
  }).sort((left, right) => {
    const availabilityDelta = Number(Boolean(left.blockReason)) - Number(Boolean(right.blockReason));
    if (availabilityDelta) return availabilityDelta;
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
    interfaceType: value?.interfaceType === "mechanical" ? "mechanical" : "terminal",
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
