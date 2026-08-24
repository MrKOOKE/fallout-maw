import Sockets from "./sockets";
import { GameSettings } from "./foundry-interfacing/game-settings";
import {
    CombatPauseRules,
    ModuleName,
    NoteReminderNotificationType,
    SettingNames,
    FalloutMaWCalendarHooks,
    SocketTypes,
    Themes,
    TimeKeeperStatus
} from "../constants";
import { Logger } from "./logging";
import { CalManager, MainApplication, NManager, SC } from "./index";
import ConfigurationApp from "./applications/configuration-app";
import MainApp from "./applications/main-app";
import UserPermissions from "./configuration/user-permissions";
import { canUser } from "./utilities/permissions";
import GameSockets from "./foundry-interfacing/game-sockets";
import MultiSelect from "./renderer/multi-select";
import { GetThemeName } from "./utilities/visual";
import { FoundryVTTGameData } from "./foundry-interfacing/game-data";
import { Hook } from "./api/hook";
import { ChatTimestamp } from "./chat/chat-timestamp";
import { foundryGetRoute } from "./foundry-interfacing/utilities";

/**
 * The global Simple Calendar Controller class
 */
export default class SCController {
    /** Foundry's deterministic active GM is the sole calendar writer. */
    public get primary(): boolean {
        return !!(<Game>game).users?.activeGM?.isSelf;
    }
    /**
     * Gets the current active calendar
     */
    public get activeCalendar() {
        return CalManager.getActiveCalendar();
    }
    /**
     * The sockets class for communicating with the connected players over our own socket
     */
    sockets: Sockets;
    /**
     * The client specific settings for Simple Calendar
     */
    public clientSettings: FalloutMaWCalendar.ClientSettingsData;
    /**
     * The global configuration settings for Simple Calendar
     */
    public globalConfiguration: FalloutMaWCalendar.GlobalConfigurationData;

    constructor() {
        this.sockets = new Sockets();
        this.clientSettings = {
            id: "",
            theme: Themes[0].key,
            openOnLoad: true,
            openCompact: false,
            rememberPosition: true,
            rememberCompactPosition: false,
            appPosition: {},
            noteReminderNotification: NoteReminderNotificationType.whisper,
            sideDrawerDirection: "fallout-maw-calendar-right",
            alwaysShowNoteList: false,
            persistentOpen: false,
            compactViewScale: 100
        };
        this.globalConfiguration = {
            id: "",
            version: "",
            calendarsSameTimestamp: false,
            combatPauseRule: CombatPauseRules.Active,
            permissions: new UserPermissions(),
            secondsInCombatRound: 6,
            syncCalendars: false,
            showNotesFolder: false,
            inGameChatTimestamp: false
        };
    }

    /**
     * Called when the theme being used has changed and all currently open dialogs need to be updated to the new theme
     */
    public static ThemeChange() {
        this.LoadThemeCSS();
        const newTheme = GetThemeName();
        const themes = Themes.map((t) => {
            return t.key;
        });
        //Update the main app
        const mainApp = document.getElementById(MainApp.appWindowId);
        if (mainApp) {
            mainApp.classList.remove(...themes);
            mainApp.classList.add(newTheme);
        }
        //Update the configuration (if open)
        const configApp = document.getElementById(ConfigurationApp.appWindowId);
        if (configApp) {
            configApp.classList.remove(...themes);
            configApp.classList.add(newTheme);
        }
        //Update Open Journals
        document.querySelectorAll(".journal-sheet.fallout-maw-calendar").forEach((j) => {
            j.classList.remove(...themes);
            j.classList.add(newTheme);
        });
    }

    /**
     * Loads any extra css files required for the specified theme
     */
    public static LoadThemeCSS(setTheme: string = "") {
        const theme = setTheme ? setTheme : GetThemeName();
        this.addCSSImageURLPaths(theme);
        const styleId = `fallout-maw-calendar-theme-${theme}`;
        const cssExists = document.head.querySelector(`#${styleId}`);
        if (cssExists === null) {
            const newStyle = document.createElement("link");
            newStyle.setAttribute("id", styleId);
            newStyle.setAttribute("rel", "stylesheet");
            newStyle.setAttribute("type", "text/css");
            newStyle.setAttribute("href", foundryGetRoute(`systems/${ModuleName}/calendar/styles/themes/${theme}.css`));
            document.head.append(newStyle);
        }
    }

    /**
     * Adds a style tag to the header that includes borrowed image path variables for themes to use
     * @param theme The theme to add image paths for
     */
    public static addCSSImageURLPaths(theme: string) {
        const styleTagExists = document.head.querySelector(`#fallout-maw-calendar-image-urls`);
        const cssVars = [
            `--ui-denim075: url("${foundryGetRoute("/ui/denim075.png")}");`,
            `--ui-parchment: url("${foundryGetRoute("/ui/parchment.jpg")}");`
        ];
        const themeData = Themes.find((t) => {
            return t.key === theme;
        });
        if (themeData && themeData.images) {
            for (const [key, value] of Object.entries(themeData.images)) {
                cssVars.push(`${key}: url("${foundryGetRoute(value)}");`);
            }
        }
        const styles = `.fallout-maw-calendar {${cssVars.join("")}}`;
        if (styleTagExists) {
            styleTagExists.textContent = styles;
        } else {
            const styleTag = document.createElement("style");
            styleTag.setAttribute("id", `fallout-maw-calendar-image-urls`);
            styleTag.appendChild(document.createTextNode(styles));
            document.head.append(styleTag);
        }
    }

    public PersistenceChange() {
        this.clientSettings.persistentOpen = GameSettings.GetBooleanSettings(SettingNames.PersistentOpen);
        const mainApp = document.getElementById(MainApp.appWindowId);
        if (mainApp) {
            if (this.clientSettings.persistentOpen) {
                mainApp.classList.add("fallout-maw-calendar-persistent");
            } else {
                mainApp.classList.remove("fallout-maw-calendar-persistent");
            }
        }
    }

    public CompactScaleChange() {
        this.clientSettings.compactViewScale = GameSettings.GetNumericSettings(SettingNames.CompactViewScale);
        const mainApp = document.getElementById(MainApp.appWindowId);
        if (mainApp) {
            for (let i = mainApp.classList.length - 1; i >= 0; i--) {
                if (mainApp.classList[i].startsWith("fallout-maw-calendar-scale")) {
                    mainApp.classList.remove(mainApp.classList[i]);
                }
            }
            mainApp.classList.add(`fallout-maw-calendar-scale-${SC.clientSettings.compactViewScale}`);
        }
    }

    /**
     * When the side drawer direction client setting has changed re-render the main application.
     */
    public static SideDrawerDirectionChange() {
        MainApplication.updateApp();
    }

    public static AlwaysShowNoteListChange() {
        MainApplication.initialize();
        MainApplication.updateApp();
    }

    /**
     * Initialize the sockets
     * Check for note reminders
     */
    public initialize() {
        this.sockets.initialize();
        NManager.checkNoteTriggers(this.activeCalendar.id, true);
        //Close all open multi selects except the one being interacted with
        document.body.addEventListener("click", MultiSelect.BodyEventListener);
        this.checkCombatActive();
        Hook.emit(FalloutMaWCalendarHooks.Init, CalManager.getActiveCalendar());
    }

    /**
     * Load the global configuration and apply it
     */
    public load() {
        SCController.LoadThemeCSS();
        const globalConfiguration = <FalloutMaWCalendar.GlobalConfigurationData>GameSettings.GetObjectSettings(SettingNames.GlobalConfiguration);
        this.globalConfiguration.permissions.loadFromSettings(globalConfiguration.permissions);
        this.globalConfiguration.secondsInCombatRound = globalConfiguration.secondsInCombatRound;
        this.globalConfiguration.calendarsSameTimestamp = globalConfiguration.calendarsSameTimestamp;
        this.globalConfiguration.syncCalendars = globalConfiguration.syncCalendars;
        this.globalConfiguration.showNotesFolder = globalConfiguration.showNotesFolder;
        if (Object.prototype.hasOwnProperty.call(globalConfiguration, "combatPauseRule")) {
            this.globalConfiguration.combatPauseRule = globalConfiguration.combatPauseRule;
        }
        if (Object.prototype.hasOwnProperty.call(globalConfiguration, "inGameChatTimestamp")) {
            this.globalConfiguration.inGameChatTimestamp = globalConfiguration.inGameChatTimestamp;
        }
        this.clientSettings.theme = GetThemeName();
        this.clientSettings.openOnLoad = GameSettings.GetBooleanSettings(SettingNames.OpenOnLoad);
        this.clientSettings.openCompact = GameSettings.GetBooleanSettings(SettingNames.OpenCompact);
        this.clientSettings.rememberPosition = GameSettings.GetBooleanSettings(SettingNames.RememberPosition);
        this.clientSettings.rememberCompactPosition = GameSettings.GetBooleanSettings(SettingNames.RememberCompactPosition);
        this.clientSettings.appPosition = <FalloutMaWCalendar.AppPosition>GameSettings.GetObjectSettings(SettingNames.AppPosition);
        this.clientSettings.noteReminderNotification = <NoteReminderNotificationType>(
            GameSettings.GetStringSettings(SettingNames.NoteReminderNotification)
        );
        this.clientSettings.sideDrawerDirection = GameSettings.GetStringSettings(SettingNames.NoteListOpenDirection);
        this.clientSettings.alwaysShowNoteList = GameSettings.GetBooleanSettings(SettingNames.AlwaysShowNoteList);
        this.clientSettings.persistentOpen = GameSettings.GetBooleanSettings(SettingNames.PersistentOpen);
        this.clientSettings.compactViewScale = GameSettings.GetNumericSettings(SettingNames.CompactViewScale);
    }

    /**
     * Reloads certain portions of the client and global configuration after a change has been made.
     */
    public reload() {
        SCController.LoadThemeCSS();
        this.clientSettings.theme = GetThemeName();
    }

    /**
     * Save the global configuration and the calendar configuration
     */
    public async save(globalConfig: FalloutMaWCalendar.GlobalConfigurationData | null = null, clientConfig: FalloutMaWCalendar.ClientSettingsData | null = null) {
        const writes: Promise<unknown>[] = [CalManager.saveCalendars()];
        const renderChatLog = globalConfig
            ? this.globalConfiguration.inGameChatTimestamp !== globalConfig.inGameChatTimestamp
            : false;

        if (clientConfig) {
            //Save the client settings
            writes.push(
                GameSettings.SaveStringSetting(`${FoundryVTTGameData.worldId}.${SettingNames.Theme}`, clientConfig.theme, false),
                GameSettings.SaveBooleanSetting(SettingNames.OpenOnLoad, clientConfig.openOnLoad, false),
                GameSettings.SaveBooleanSetting(SettingNames.OpenCompact, clientConfig.openCompact, false),
                GameSettings.SaveBooleanSetting(SettingNames.RememberPosition, clientConfig.rememberPosition, false),
                GameSettings.SaveBooleanSetting(SettingNames.RememberCompactPosition, clientConfig.rememberCompactPosition, false),
                GameSettings.SaveObjectSetting(SettingNames.AppPosition, clientConfig.appPosition, false),
                GameSettings.SaveStringSetting(SettingNames.NoteReminderNotification, clientConfig.noteReminderNotification, false),
                GameSettings.SaveStringSetting(SettingNames.NoteListOpenDirection, clientConfig.sideDrawerDirection, false),
                GameSettings.SaveBooleanSetting(SettingNames.AlwaysShowNoteList, clientConfig.alwaysShowNoteList, false),
                GameSettings.SaveBooleanSetting(SettingNames.PersistentOpen, clientConfig.persistentOpen, false),
                GameSettings.SaveNumericSetting(SettingNames.CompactViewScale, clientConfig.compactViewScale, false)
            );
        }

        if (globalConfig) {
            const gc: FalloutMaWCalendar.GlobalConfigurationData = {
                id: "",
                version: GameSettings.GetModuleVersion(),
                permissions: globalConfig.permissions,
                secondsInCombatRound: globalConfig.secondsInCombatRound,
                calendarsSameTimestamp: globalConfig.calendarsSameTimestamp,
                syncCalendars: globalConfig.syncCalendars,
                showNotesFolder: globalConfig.showNotesFolder,
                combatPauseRule: globalConfig.combatPauseRule,
                inGameChatTimestamp: globalConfig.inGameChatTimestamp
            };
            //Save the global configuration (triggers the load function)
            writes.push(GameSettings.SaveObjectSetting(SettingNames.GlobalConfiguration, gc));
        }
        await Promise.all(writes);
        if (clientConfig) this.reload();
        if (globalConfig) {
            if (renderChatLog) {
                ChatTimestamp.updateChatMessageTimestamps();
                await GameSockets.emit({ type: SocketTypes.renderChatLog, data: renderChatLog });
            }
            await GameSockets.emit({ type: SocketTypes.mainAppUpdate, data: {} });
        }
    }

    /**
     * Hides any open context menus
     */
    public static HideContextMenus() {
        document.querySelectorAll(".fallout-maw-calendar-context-menu").forEach((e) => {
            e.classList.add("fallout-maw-calendar-hide");
        });
    }

    private checkCombatActive() {
        if (GameSettings.shouldPauseForCombat()) {
            this.activeCalendar.time.combatRunning = true;
        }
    }

    //---------------------------
    // Foundry Hooks
    //---------------------------
    /** Adds the calendar as its own Scene Controls layer button after Notes. */
    public renderSceneControls(_app: unknown, element: HTMLElement | JQuery) {
        if (!canUser(game.user!, this.globalConfiguration.permissions.viewCalendar)) return;

        const root = element instanceof HTMLElement ? element : element?.[0];
        const layers = root?.matches?.("#scene-controls-layers") ? root : root?.querySelector?.("#scene-controls-layers");
        const menu = layers?.matches?.("menu") ? layers : layers?.querySelector?.("menu");
        if (!menu || menu.querySelector("[data-fallout-maw-calendar-control]")) return;

        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "control ui-control layer icon fa-solid fa-calendar fallout-maw-calendar-icon";
        button.dataset.falloutMawCalendarControl = "true";
        const title = GameSettings.Localize("FALLOUTMAW.Calendar.Title");
        button.dataset.tooltip = title;
        button.setAttribute("aria-label", title);
        button.setAttribute("aria-pressed", "false");
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            MainApplication.sceneControlButtonClick();
        });
        item.append(button);

        const notesItem = menu.querySelector('button[data-control="notes"]')?.closest("li");
        if (notesItem) notesItem.insertAdjacentElement("afterend", item);
        else menu.append(item);
    }

    /**
     * Checks settings to see if the note directory should be shown or hidden from the journal directory
     */
    public async renderJournalDirectory(tab: JournalDirectory, element: HTMLElement) {
        await NManager.createJournalDirectory();
        if (!this.globalConfiguration.showNotesFolder && NManager.noteDirectory) {
            const folder = element.querySelector(`.folder[data-folder-id='${NManager.noteDirectory.id}']`);
            folder?.remove();
        }
    }

    /**
     * Checks settings to see if the note directory should be shown or hidden from the journal sheet directory dropdown
     */
    public renderJournalSheet(sheet: JournalSheet, jquery: JQuery) {
        if (!this.globalConfiguration.showNotesFolder && NManager.noteDirectory) {
            const option = jquery.find(`option[value='${NManager.noteDirectory.id}']`);
            if (option) {
                option.remove();
            }
        }
    }

    /**
     * Checks to see if the Simple Calendar not directory should be shown and if not removes all Simple Calendar notes from the list of available journal entries.
     * @param config
     * @param jquery
     * @param data
     */
    public renderSceneConfig(config: SceneConfig, element: HTMLElement, data: SceneConfig.RenderContext, options: SceneConfig.RenderOptions) {
        if (this.globalConfiguration.showNotesFolder) return;
        
        const select = element.querySelector("select[name=journal]");
        if (!select) return;

        const noteJournals = game.journal?.filter((j) => !!j.getFlag(ModuleName, "noteData"));
        for (const journal of noteJournals ?? []) {
            const option = select.querySelector(`option[value='${journal.id}']`);
            option?.remove();
        }
    }

    /**
     * Triggered when the games pause state is changed.
     */
    public gamePaused() {
        if (this.activeCalendar.time.unifyGameAndClockPause) {
            if (!(<Game>game).paused) {
                this.activeCalendar.timeKeeper.start(true);
            } else {
                this.activeCalendar.timeKeeper.setStatus(TimeKeeperStatus.Paused);
            }
        }
    }

    /**
     * Triggered when anything updates the game world time
     * @param {number} newTime The total time in seconds
     * @param {number} delta How much the newTime has changed from the old time in seconds
     */
    public worldTimeUpdate(newTime: number, delta: number, options: Record<string, any> = {}) {
        this.activeCalendar.setFromTime(newTime, delta, options);
    }

    /**
     * Triggered when a combatant is added to a combat.
     * @param combatant The combatant details
     */
    public createCombatant(combatant: Combatant) {
        //If the combat has started and the current active scene is the scene for the combat then set that there is a combat running.
        if (GameSettings.shouldPauseForCombat()) {
            this.activeCalendar.time.combatRunning = true;
        }
    }

    /**
     * Triggered when a combat is creat/started/turn advanced
     * @param combat The specific combat data
     * @param round The current turns data
     * @param time The amount of time that has advanced
     */
    public combatUpdate(combat: Combat, round: Combat.UpdateData, options: any) {
        if (GameSettings.shouldPauseForCombat()) {
            this.activeCalendar.time.combatRunning = true;

            // Foundry V14 supplies combat time through updateOptions.worldTime.delta.
            const worldTimeDelta = Number(options?.worldTime?.delta);
            if (Number.isFinite(worldTimeDelta)) {
                if (worldTimeDelta !== 0) {
                    this.activeCalendar.combatChangeTriggered = true;
                } else {
                    // System does not advance time when combat rounds change, check our own settings
                    this.activeCalendar.processOwnCombatRoundTime(combat);
                }
            }
        }
    }

    /**
     * Triggered when a combat is finished and removed
     * @param combat The specific combat data
     */
    public combatDelete(combat: Combat) {
        if (!GameSettings.shouldPauseForCombat()) {
            this.activeCalendar.time.combatRunning = false;
        }
    }

    /**
     * Triggered when the canvas is initialized.
     * Using this to check if the user has changed Scenes.
     * @param canvas The canvas data
     */
    public canvasInit(canvas: Canvas) {
        if (GameSettings.IsGm() && this.primary) {
            this.activeCalendar.time.combatRunning = GameSettings.shouldPauseForCombat();
        }
    }

    /** Triggered when the scene is updated, and used to check when a scene has become active */
    public updateScene(scene: Scene) {
        if (scene.active && this.globalConfiguration.combatPauseRule === CombatPauseRules.Active) {
            this.activeCalendar.time.combatRunning = GameSettings.shouldPauseForCombat();
        }
    }

    /**
     * Triggered when a chat message is sent
     * @param chatLog
     * @param message
     * @param chatData
     */
    /*public onChatMessage(chatLog: ChatLog, message: string, chatData: ChatMessageData){
        return ParseChatCommand(message.trim());
    }*/

    /*public onRenderChatMessage(chatMessage: ChatMessage, html: JQuery, messageData: ChatMessageData){
        const element = html[0];
        if(element){
            const btn = element.querySelector('.fallout-maw-calendar-control[data-date]');
            if(btn){
                let dateParts = null;
                try{
                    dateParts = JSON.parse(btn.getAttribute('data-date') || '');
                } catch (e: any){
                    Logger.error(e);
                }
                btn.addEventListener('click', showCalendar.bind(null , dateParts, false, 'active'));
            }
        }
    }*/
}
