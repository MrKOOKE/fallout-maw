import { TEMPLATES } from "../constants.mjs";
import {
  getTimeMechanicsIgnored,
  getTimeNeedsPlayersOnly,
  setTimeMechanicsIgnored,
  setTimeNeedsPlayersOnly
} from "../settings/accessors.mjs";
import { FalloutMaWFormApplicationV2 } from "./base-form-application-v2.mjs";

const CONTROL_ID = "fallout-maw-world-time-control";
const UNIT_SECONDS = Object.freeze({
  hours: 60 * 60,
  minutes: 60,
  seconds: 1
});

let hooksRegistered = false;
let clockInterval = null;
let lastClockTick = 0;
let clockTickInFlight = false;
let resumeClockAfterCombat = false;
let selectedUnit = "hours";

export function registerWorldTimeControlHooks() {
  if (hooksRegistered) return;
  Hooks.on("renderSceneControls", injectWorldTimeControlButton);
  Hooks.on("updateWorldTime", rerenderWorldTimeControl);
  Hooks.on("combatStart", pauseWorldClockForCombat);
  Hooks.on("deleteCombat", scheduleResumeWorldClockAfterCombat);
  Hooks.on("updateCombat", (_combat, changes) => {
    if (foundry.utils.hasProperty(changes ?? {}, "started")) scheduleResumeWorldClockAfterCombat();
  });
  hooksRegistered = true;
}

function injectWorldTimeControlButton(_app, element) {
  if (!game.user?.isGM) return;
  const root = element instanceof HTMLElement ? element : element?.[0];
  const menu = root?.matches?.("#scene-controls-layers")
    ? root
    : root?.querySelector("#scene-controls-layers");
  if (!menu || menu.querySelector("[data-fallout-maw-world-time-control]")) return;

  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "control ui-control layer icon fa-solid fa-clock fallout-maw-world-time-main-control";
  button.dataset.falloutMawWorldTimeControl = "true";
  button.dataset.tooltip = "";
  button.setAttribute("aria-label", "Управление временем");
  button.setAttribute("aria-pressed", "false");
  button.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    toggleWorldTimeControl();
    updateWorldTimeControlButtonState();
  });
  item.append(button);

  const notesItem = menu.querySelector("[data-control='notes']")?.closest("li");
  if (notesItem?.nextSibling) notesItem.parentElement.insertBefore(item, notesItem.nextSibling);
  else menu.append(item);
  updateWorldTimeControlButtonState();
}

function toggleWorldTimeControl() {
  const existing = foundry.applications.instances.get(CONTROL_ID);
  if (existing) return existing.close();
  return new WorldTimeControl().render({ force: true });
}

function rerenderWorldTimeControl() {
  const app = foundry.applications.instances.get(CONTROL_ID);
  if (app?.rendered) void app.render({ force: true });
  updateWorldTimeControlButtonState();
}

export class WorldTimeControl extends FalloutMaWFormApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: CONTROL_ID,
    classes: ["fallout-maw", "fallout-maw-world-time-control"],
    position: {
      left: 92,
      top: 258,
      width: 520,
      height: "auto"
    },
    window: {
      resizable: false
    },
    form: {
      handler: WorldTimeControl.handleFormSubmit,
      submitOnChange: true,
      closeOnSubmit: false
    },
    actions: {
      toggleClock: WorldTimeControl.#onToggleClock,
      advanceTime: WorldTimeControl.#onAdvanceTime
    }
  };

  static PARTS = {
    form: {
      template: TEMPLATES.worldTimeControl
    }
  };

  get title() {
    return "Управление временем";
  }

  async _prepareContext(options) {
    return {
      ...(await super._prepareContext(options)),
      currentTime: formatWorldTime(Number(game.time?.worldTime) || 0),
      running: isClockRunning(),
      combatActive: isCombatActive(),
      ignoreTimeMechanics: getTimeMechanicsIgnored(),
      needsPlayersOnly: getTimeNeedsPlayersOnly(),
      unitOptions: getUnitOptions(selectedUnit)
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.#positionNearControl();
    updateWorldTimeControlButtonState();
  }

  _onClose(options) {
    super._onClose(options);
    updateWorldTimeControlButtonState();
  }

  async _processFormData(_event, _form, formData) {
    const unit = String(formData.object?.unit ?? selectedUnit);
    selectedUnit = Object.hasOwn(UNIT_SECONDS, unit) ? unit : "hours";
    await setTimeMechanicsIgnored(Boolean(formData.object?.ignoreTimeMechanics));
    await setTimeNeedsPlayersOnly(Boolean(formData.object?.needsPlayersOnly));
    return undefined;
  }

  static async #onToggleClock(event) {
    event.preventDefault();
    if (isClockRunning()) stopWorldClock();
    else startWorldClock({ notifyBlocked: true });
    return this.forceRender();
  }

  static async #onAdvanceTime(event, target) {
    event.preventDefault();
    const direction = Number(target.dataset.direction) || 1;
    const multiplier = Math.max(1, Number(target.dataset.multiplier) || 1);
    await advanceWorldTime(direction * multiplier * getSelectedUnitSeconds());
    return this.forceRender();
  }

  #positionNearControl() {
    const button = document.querySelector("[data-fallout-maw-world-time-control]");
    const element = this.element;
    if (!button || !element) return;

    const rect = button.getBoundingClientRect();
    const left = Math.round(rect.right + 8);
    const top = Math.round(rect.top);
    this.setPosition({ left, top });
  }
}

function startWorldClock({ notifyBlocked = false } = {}) {
  if (!game.user?.isGM || clockInterval) return;
  if (isCombatActive()) {
    if (notifyBlocked) ui.notifications.warn("Во время боя обычный ход времени недоступен.");
    return;
  }
  resumeClockAfterCombat = false;
  lastClockTick = Date.now();
  clockInterval = window.setInterval(tickWorldClock, 1000);
  rerenderWorldTimeControl();
}

function stopWorldClock() {
  if (!clockInterval) return;
  window.clearInterval(clockInterval);
  clockInterval = null;
  lastClockTick = 0;
  clockTickInFlight = false;
  resumeClockAfterCombat = false;
  rerenderWorldTimeControl();
}

function updateWorldTimeControlButtonState() {
  const button = document.querySelector("[data-fallout-maw-world-time-control]");
  if (!button) return;
  const active = Boolean(foundry.applications.instances.get(CONTROL_ID)?.rendered);
  button.classList.toggle("active", active);
  button.setAttribute("aria-pressed", String(active));
}

function isClockRunning() {
  return Boolean(clockInterval);
}

async function tickWorldClock() {
  if (clockTickInFlight) return;
  if (!game.user?.isGM) {
    stopWorldClock();
    return;
  }
  if (isCombatActive()) {
    pauseWorldClockForCombat();
    return;
  }

  const now = Date.now();
  const elapsedSeconds = Math.floor((now - lastClockTick) / 1000);
  if (elapsedSeconds <= 0) return;
  lastClockTick += elapsedSeconds * 1000;
  clockTickInFlight = true;
  try {
    await advanceWorldTime(elapsedSeconds);
  } finally {
    clockTickInFlight = false;
  }
}

function pauseWorldClockForCombat() {
  if (!game.user?.isGM) return;
  if (!isClockRunning()) {
    rerenderWorldTimeControl();
    return;
  }
  resumeClockAfterCombat = true;
  window.clearInterval(clockInterval);
  clockInterval = null;
  lastClockTick = 0;
  clockTickInFlight = false;
  rerenderWorldTimeControl();
}

function scheduleResumeWorldClockAfterCombat() {
  if (!game.user?.isGM || !resumeClockAfterCombat) return;
  window.setTimeout(() => {
    if (!resumeClockAfterCombat || isCombatActive()) return;
    resumeClockAfterCombat = false;
    startWorldClock();
  }, 0);
}

function isCombatActive() {
  if (game.combat?.started) return true;
  return Array.from(game.combats ?? []).some(combat => combat?.started);
}

async function advanceWorldTime(seconds) {
  const amount = Math.trunc(Number(seconds) || 0);
  if (!amount || !game.user?.isGM) return;
  await game.time.advance(amount);
}

function getSelectedUnitSeconds() {
  return UNIT_SECONDS[selectedUnit] ?? UNIT_SECONDS.hours;
}

function getUnitOptions(current = "hours") {
  return [
    ["hours", "Часы"],
    ["minutes", "Минуты"],
    ["seconds", "Секунды"]
  ].map(([value, label]) => ({
    value,
    label,
    selected: value === current
  }));
}

function formatWorldTime(seconds) {
  const sign = seconds < 0 ? "-" : "";
  let remaining = Math.abs(Math.trunc(seconds));
  const days = Math.floor(remaining / 86400);
  remaining -= days * 86400;
  const hours = Math.floor(remaining / 3600);
  remaining -= hours * 3600;
  const minutes = Math.floor(remaining / 60);
  remaining -= minutes * 60;
  return `${sign}${days} д. ${pad(hours)}:${pad(minutes)}:${pad(remaining)}`;
}

function pad(value) {
  return String(value).padStart(2, "0");
}
