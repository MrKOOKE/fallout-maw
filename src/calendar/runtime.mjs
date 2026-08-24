import { setWorldTime } from "../time/world-time-queue.mjs";
import {
  getTimeMechanicsIgnored,
  getTimeNeedsPlayersOnly,
  getTimeRestMode,
  setTimeMechanicsIgnored,
  setTimeNeedsPlayersOnly,
  setTimeRestMode
} from "../settings/accessors.mjs";
import { installNativeCalendarBridge } from "./native-calendar.mjs";

const CALENDAR_CONFIGURATION_SETTING = "fallout-maw.calendar.configuration";
const ACTIVE_CALENDAR_SETTING = "fallout-maw.calendar.active";
let hooksRegistered = false;
let settingRefreshScheduled = false;
let lastNativeStructureSignature = "";

export function registerCalendarRuntimeHooks() {
  if (hooksRegistered) return;
  Hooks.on("fallout-maw.calendar.init", initializeCalendarRuntime);
  Hooks.on("fallout-maw.calendar.ready", initializeCalendarRuntime);
  Hooks.on("fallout-maw.calendar.configuration-change", initializeCalendarRuntime);
  Hooks.on("updateSetting", scheduleCalendarSettingRefresh);
  Hooks.once("ready", () => {
    if (resolveCalendarApi()) initializeCalendarRuntime();
  });
  installCalendarAdvanceApi();
  hooksRegistered = true;
}

export function initializeCalendarRuntime() {
  const api = resolveCalendarApi();
  if (!api) return false;
  installCalendarAdvanceApi();
  try {
    const configuration = api.getCurrentCalendar();
    const signature = calendarStructureSignature(configuration);
    if (signature === lastNativeStructureSignature) return true;
    installNativeCalendarBridge(api, configuration);
    lastNativeStructureSignature = signature;
    return true;
  } catch (error) {
    console.error("Fallout MaW | Native calendar bridge initialization failed", error);
    return false;
  }
}

function calendarStructureSignature(configuration = {}) {
  return JSON.stringify({
    id: configuration?.id,
    name: configuration?.name,
    description: configuration?.description,
    year: configuration?.year,
    months: configuration?.months,
    weekdays: configuration?.weekdays,
    seasons: configuration?.seasons,
    time: configuration?.time
  });
}

/**
 * Add the system-owned absolute-time writer to the calendar's public surface.
 * The bundled surface is frozen, so replace that small namespace object rather
 * than mutating Foundry's global game.time methods.
 */
export function installCalendarAdvanceApi() {
  const root = globalThis.game?.falloutMaW;
  const calendar = root?.calendar;
  if (!calendar) return false;
  if (calendar.setWorldTime === setCalendarWorldTime && calendar.getTimeOptions === getCalendarTimeOptions) return true;
  root.calendar = Object.freeze({
    ...calendar,
    setWorldTime: setCalendarWorldTime,
    getTimeOptions: getCalendarTimeOptions,
    setTimeOptions: setCalendarTimeOptions
  });
  return true;
}

export function resolveCalendarApi() {
  const api = globalThis.game?.falloutMaW?.calendar?.api;
  return typeof api?.timestampToDate === "function" ? api : null;
}

async function setCalendarWorldTime(absoluteTarget, options = {}) {
  return setWorldTime(absoluteTarget, {
    ...options,
    restMode: options.restMode ?? getTimeRestMode(),
    source: "calendar"
  });
}

function getCalendarTimeOptions() {
  return Object.freeze({
    restMode: getTimeRestMode(),
    ignoreTimeMechanics: getTimeMechanicsIgnored(),
    needsPlayersOnly: getTimeNeedsPlayersOnly()
  });
}

async function setCalendarTimeOptions(changes = {}) {
  const writes = [];
  if (Object.hasOwn(changes, "restMode")) writes.push(setTimeRestMode(Boolean(changes.restMode)));
  if (Object.hasOwn(changes, "ignoreTimeMechanics")) writes.push(setTimeMechanicsIgnored(Boolean(changes.ignoreTimeMechanics)));
  if (Object.hasOwn(changes, "needsPlayersOnly")) writes.push(setTimeNeedsPlayersOnly(Boolean(changes.needsPlayersOnly)));
  await Promise.all(writes);
  return getCalendarTimeOptions();
}

function scheduleCalendarSettingRefresh(setting) {
  const key = String(setting?.key ?? "");
  if (key !== CALENDAR_CONFIGURATION_SETTING && key !== ACTIVE_CALENDAR_SETTING) return;
  if (settingRefreshScheduled) return;
  settingRefreshScheduled = true;
  globalThis.queueMicrotask(() => {
    settingRefreshScheduled = false;
    initializeCalendarRuntime();
  });
}
