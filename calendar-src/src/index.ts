import SCController from "./classes/s-c-controller";
import * as API from "./classes/api";
import { Logger } from "./classes/logging";
import { FalloutMaWCalendarHooks } from "./constants";
import {
    CalManager,
    MainApplication,
    NManager,
    SC,
    updateCalManager,
    updateConfigurationApplication,
    updateMainApplication,
    updateNManager,
    updateSC
} from "./classes";
import { HandlebarsHelpers } from "./classes/api/handlebars-helpers";
import GameSettingsRegistration from "./classes/foundry-interfacing/game-settings-registration";
import CalendarManager from "./classes/calendar/calendar-manager";
import MainApp from "./classes/applications/main-app";
import ConfigurationApp from "./classes/applications/configuration-app";
import NoteManager from "./classes/notes/note-manager";
import { NoteSheet } from "./classes/notes/note-sheet";
import PF2E from "./classes/systems/pf2e";
import { CheckRemScaling } from "./classes/utilities/visual";
import { Hook } from "./classes/api/hook";
import KeyBindings from "./classes/key-bindings";
import { Chat } from "./classes/chat";
import { ChatTimestamp } from "./classes/chat/chat-timestamp";

updateCalManager(new CalendarManager());
updateSC(new SCController());
updateMainApplication(new MainApp());
updateConfigurationApplication(new ConfigurationApp());
updateNManager(new NoteManager());

let wasPrimaryGM = false;
let calendarReady = false;
let initializationPromise: Promise<void> = Promise.resolve();

//Add body click events
document.body.addEventListener("click", SCController.HideContextMenus);

const systemCalendar = Object.freeze({ api: API, Hooks: FalloutMaWCalendarHooks });

CheckRemScaling();

Hooks.on("init", () => {
    // The calendar is part of the system, so its public surface lives under the
    // system namespace instead of pretending to be an installed module.
    const systemApi = ((game as any).falloutMaW ??= {});
    systemApi.calendar = systemCalendar;
    //Register Handlebar Helpers and our game settings
    HandlebarsHelpers.Register();
    GameSettingsRegistration.Register();
    initializationPromise = initializeCalendar();
});

async function initializeCalendar() {
    //Initialize the calendar manager (loads the calendars and their settings)
    await CalManager.initialize();
    //Load the global configuration settings
    SC.load();
    //Initialize the main application (Pre-set values before render)
    MainApplication.initialize();
    KeyBindings.register();
    Chat.init();
}
Hooks.on("ready", async () => {
    // Foundry does not await async init listeners. Explicitly join the single
    // initialization promise before any ready-time calendar access.
    await initializationPromise;
    if (PF2E.isPF2E) {
        PF2E.updatePF2EVariables(true);
        ChatTimestamp.updateChatMessageTimestamps();
    }
    await NManager.initialize();
    SC.initialize();
    await MainApplication.timeKeepingCheck();
    CalManager.getActiveCalendar().timeKeeper.restorePersistedState();
    MainApplication.clockClass = CalManager.getActiveCalendar().timeKeeper.getStatus();
    wasPrimaryGM = SC.primary;
    calendarReady = true;
    Hook.emit(FalloutMaWCalendarHooks.PrimaryGM, CalManager.getActiveCalendar());
    if (SC.clientSettings.openOnLoad) {
        MainApplication.render();
    }
    Hook.emit(FalloutMaWCalendarHooks.Ready, CalManager.getActiveCalendar());
});
function reconcilePrimaryGmAuthority() {
    if (!calendarReady) return;
    const isPrimaryGM = SC.primary;
    if (isPrimaryGM === wasPrimaryGM) return;
    wasPrimaryGM = isPrimaryGM;
    if (isPrimaryGM) {
        CalManager.getActiveCalendar().timeKeeper.restorePersistedState();
    } else {
        for (const calendar of CalManager.getAllCalendars()) calendar.timeKeeper.relinquishAuthority();
    }
    Hook.emit(FalloutMaWCalendarHooks.PrimaryGM, CalManager.getActiveCalendar());
}

// Foundry V14 reports connection/election changes through userConnected.
// updateUser remains relevant when a role change alters the active GM.
Hooks.on("userConnected", reconcilePrimaryGmAuthority);
Hooks.on("updateUser", reconcilePrimaryGmAuthority);
Hooks.on("canvasInit", SC.canvasInit.bind(SC));
Hooks.on("renderSceneControls", SC.renderSceneControls.bind(SC));
Hooks.on("renderJournalDirectory", SC.renderJournalDirectory.bind(SC));
Hooks.on("renderJournalSheet", SC.renderJournalSheet.bind(SC));
Hooks.on("updateWorldTime", SC.worldTimeUpdate.bind(SC));
Hooks.on("createCombatant", SC.createCombatant.bind(SC));
Hooks.on("updateCombat", (SC.combatUpdate.bind(SC)));
Hooks.on("deleteCombat", SC.combatDelete.bind(SC));
Hooks.on("pauseGame", SC.gamePaused.bind(SC));
Hooks.on("updateScene", SC.updateScene.bind(SC));
Hooks.on("preCreateChatMessage", Chat.createChatMessage);
Hooks.on("renderChatMessage", Chat.onRenderChatMessage);
Hooks.on("renderMainApp", MainApp.setWidthHeight);
Hooks.on("renderNoteSheet", NoteSheet.SetHeight);
Hooks.on("createJournalEntry", NManager.journalEntryUpdate.bind(NManager, 0));
Hooks.on("updateJournalEntry", NManager.journalEntryUpdate.bind(NManager, 1));
Hooks.on("deleteJournalEntry", NManager.journalEntryUpdate.bind(NManager, 2));
Hooks.on("renderSceneConfig", SC.renderSceneConfig.bind(SC));

Logger.debugMode = false;

//Hooks.on(FalloutMaWCalendarHooks.DateTimeChange, (...args: any) => {console.log(...args);});
//Hooks.on(FalloutMaWCalendarHooks.Ready, (...args: any) => {console.log('SC Ready!');});
