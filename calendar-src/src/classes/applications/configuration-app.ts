import { Logger } from "../logging";
import { GameSettings } from "../foundry-interfacing/game-settings";
import Month from "../calendar/month";
import { Weekday } from "../calendar/weekday";
import {
    CombatPauseRules,
    CompactViewDateTimeControlDisplay,
    ConfigurationDateSelectors,
    FalloutMaWCalendarHooks,
    GameWorldTimeIntegrations,
    Icons,
    LeapYearRules,
    ModuleName,
    MoonYearResetOptions,
    NoteReminderNotificationType,
    PredefinedCalendars,
    Themes,
    YearNamingRules
} from "../../constants";
import Season from "../calendar/season";
import Moon, { defaultMoonPhaseIllumination, normalizeMoonLightingValue } from "../calendar/moon";
import { saveAs } from "file-saver";
import PredefinedCalendar from "../configuration/predefined-calendar";
import Calendar from "../calendar";
import DateSelectorManager from "../date-selector/date-selector-manager";
import { animateElement, animateFormGroup, ConvertPxBasedOnRemSize, GetContrastColor, GetThemeList, GetThemeName } from "../utilities/visual";
import { CalManager, ConfigurationApplication, NManager, SC } from "../index";
import UserPermissions from "../configuration/user-permissions";
import { deepMerge, isObjectEmpty } from "../utilities/object";
import { getCheckBoxGroupValues, getCheckBoxInputValue, getNumericInputValue, getTextInputValue } from "../utilities/inputs";
import { FormatDateTime } from "../utilities/date-time";
import { generateUniqueId } from "../utilities/string";
import PF2E from "../systems/pf2e";
import { FoundryVTTGameData } from "../foundry-interfacing/game-data";
import { foundryGetRoute } from "../foundry-interfacing/utilities";
import { GetDataReturnType } from "@league-of-foundry-developers/foundry-vtt-types/utils";
import { Hook } from "../api/hook";

export default class ConfigurationApp extends FormApplication {
    /**
     * ID used for the application window when rendered on the page
     */
    public static appWindowId: string = "fallout-maw-calendar-configuration-application-form";
    /**
     * The HTML element representing the application window
     * @private
     */
    private appWindow: HTMLElement | null = null;
    /**
     * A list of temporary calendars to be edited in the configuration dialog.
     * @private
     */
    private calendars: Calendar[] = [];

    private predefindCalendars: any[] = [];
    /**
     * A copy of the global configuration options to be edited in the configuration dialog.
     * @private
     */
    private globalConfiguration: FalloutMaWCalendar.GlobalConfigurationData = {
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
    /**
     * A copy of the client settings to be edited in the configuration dialog.
     * @private
     */
    private clientSettings: FalloutMaWCalendar.ClientSettingsData = {
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
    /**
     * A list of different states for the UI
     * @private
     */
    private uiElementStates = {
        chatFormatExample: "",
        dateFormatExample: "",
        dateFormatTableExpanded: false,
        monthYearFormatExample: "",
        qsNextClicked: false,
        qsAddNotes: true,
        selectedPredefinedCalendar: "",
        timeFormatExample: "",
        disabledControls: {
            pf2e: false
        }
    };
    /**
     * The Calendar configuration constructor
     */
    constructor() {
        super({});
    }

    render(force?: boolean, options?: Application.RenderOptions<FormApplication.Options>): this {
        // Check to see if the object is empty, if it is this is likely the user clicking the button in
        // FoundryVTTs module settings, and we need to initialize and show the actual configuration dialog
        if (isObjectEmpty(this.object)) {
            ConfigurationApplication.initializeAndShowDialog().catch(Logger.error);
            return this;
        } else {
            options = options ? options : {};
            options.classes = ["fallout-maw-calendar", "fallout-maw-calendar-configuration", GetThemeName()];
            return super.render(force, options);
        }
    }

    /**
     * Sets up the data for the dialog and shows it
     */
    async initializeAndShowDialog() {
        this.calendars = CalManager.cloneCalendars();
        this.object = this.calendars[0]; //Temp until we get better calendar picking
        SC.load();
        this.globalConfiguration.permissions = SC.globalConfiguration.permissions.clone();
        this.globalConfiguration.secondsInCombatRound = SC.globalConfiguration.secondsInCombatRound;
        this.globalConfiguration.calendarsSameTimestamp = SC.globalConfiguration.calendarsSameTimestamp;
        this.globalConfiguration.syncCalendars = SC.globalConfiguration.syncCalendars;
        this.globalConfiguration.showNotesFolder = SC.globalConfiguration.showNotesFolder;
        this.globalConfiguration.combatPauseRule = SC.globalConfiguration.combatPauseRule;
        this.globalConfiguration.inGameChatTimestamp = SC.globalConfiguration.inGameChatTimestamp;
        this.clientSettings = deepMerge({}, SC.clientSettings);
        this._tabs[0].active = "globalSettings";

        if (this.predefindCalendars.length === 0) {
            try {
                const prefRes = await fetch(foundryGetRoute(`systems/${ModuleName}/calendar/predefined-calendars/calendar-list.json`));
                this.predefindCalendars = await prefRes.json();
            } catch (e: any) {
                Logger.error(e);
                this.predefindCalendars = [];
            }
        }

        if (!this.rendered) {
            this.showApp();
        } else {
            this.bringToTop();
        }
    }

    /**
     * Returns the default options for this application
     */
    static get defaultOptions() {
        const options = super.defaultOptions;
        options.template = "systems/fallout-maw/calendar/templates/configuration.html";
        options.title = "FALLOUTMAW.Calendar.Configuration.Title";
        options.id = this.appWindowId;
        options.classes = ["fallout-maw-calendar", "fallout-maw-calendar-configuration"];
        options.resizable = true;
        options.tabs = [{ navSelector: ".tabs", contentSelector: "form", initial: "yearSettings" }];
        options.height = ConvertPxBasedOnRemSize(700);
        options.width = ConvertPxBasedOnRemSize(1005);
        options.scrollY = [".fallout-maw-calendar-tab-wrapper", ".fallout-maw-calendar-sheet-tabs"];
        return options;
    }

    /**
     * Shows the application window
     */
    public showApp() {
        this.render(true);
    }

    /**
     * Closes the application window
     */
    public closeApp() {
        this.close().catch(Logger.error);
    }

    /**
     * When closing the app make sure all date selectors are removed from the list so we don't keep around what we don't need
     * @param options
     */
    close(options?: FormApplication.CloseOptions): Promise<void> {
        CalManager.clearClones();
        (<Calendar>this.object).seasons.forEach((s) => {
            DateSelectorManager.RemoveSelector(`fallout_maw_calendar_season_start_date_${s.id}`);
            DateSelectorManager.RemoveSelector(`fallout_maw_calendar_season_sunrise_time_${s.id}`);
        });
        DateSelectorManager.DeactivateSelector("quick-setup-predefined-calendar");
        this.appWindow = null;
        return super.close(options);
    }

    /**
     * Re-renders the application window
     * @private
     */
    private updateApp() {
        this.render(false);
    }

    /**
     * Gets the data object to be used by Handlebars when rending the HTML template
     */
    async getData(options?: Application.RenderOptions): Promise<GetDataReturnType<FormApplication.FormApplicationData>> {
        const currDate = (<Calendar>this.object).getCurrentDate();
        this.uiElementStates.dateFormatExample = FormatDateTime(
            { year: currDate.year, month: currDate.month, day: currDate.day, hour: 13, minute: 36, seconds: 42 },
            (<Calendar>this.object).generalSettings.dateFormat.date,
            <Calendar>this.object
        );
        this.uiElementStates.timeFormatExample = FormatDateTime(
            { year: currDate.year, month: currDate.month, day: currDate.day, hour: 13, minute: 36, seconds: 42 },
            (<Calendar>this.object).generalSettings.dateFormat.time,
            <Calendar>this.object
        );
        this.uiElementStates.monthYearFormatExample = FormatDateTime(
            { year: currDate.year, month: currDate.month, day: currDate.day, hour: 13, minute: 36, seconds: 42 },
            (<Calendar>this.object).generalSettings.dateFormat.monthYear,
            <Calendar>this.object
        );
        this.uiElementStates.chatFormatExample = FormatDateTime(
            { year: currDate.year, month: currDate.month, day: currDate.day, hour: 13, minute: 36, seconds: 42 },
            (<Calendar>this.object).generalSettings.dateFormat.chatTime,
            <Calendar>this.object
        );

        this.uiElementStates.disabledControls.pf2e = PF2E.isPF2E && (<Calendar>this.object).generalSettings.pf2eSync;

        const data = {
            ...(await super.getData(options)),
            activeCalendarId: (<Calendar>this.object).id,
            images: {
                compactViewLayoutFull: foundryGetRoute("/systems/fallout-maw/calendar/assets/fallout-maw-calendar-v2-theme-dark-comp.png"),
                compactViewLayoutQuickIncrement: foundryGetRoute("/systems/fallout-maw/calendar/assets/fallout-maw-calendar-v2-theme-dark-comp-qi.png")
            },
            calendars: this.calendars,
            clientSettings: {
                openOnLoad: this.clientSettings.openOnLoad,
                openInCompact: this.clientSettings.openCompact,
                rememberPos: this.clientSettings.rememberPosition,
                rememberCompactPos: this.clientSettings.rememberCompactPosition,
                theme: this.clientSettings.theme,
                themes: GetThemeList(),
                noteReminderNotification: this.clientSettings.noteReminderNotification,
                noteReminderNotifications: {
                    whisper: "FALLOUTMAW.Calendar.Configuration.Client.NoteReminderNotification.Whisper",
                    render: "FALLOUTMAW.Calendar.Configuration.Client.NoteReminderNotification.Render"
                },
                sideDrawerDirection: this.clientSettings.sideDrawerDirection,
                sideDrawerDirections: {
                    "fallout-maw-calendar-right": "FALLOUTMAW.Calendar.Right",
                    "fallout-maw-calendar-left": "FALLOUTMAW.Calendar.Left",
                    "fallout-maw-calendar-down": "FALLOUTMAW.Calendar.Down"
                },
                alwaysShowNoteList: this.clientSettings.alwaysShowNoteList,
                persistentOpen: this.clientSettings.persistentOpen,
                compactViewScale: this.clientSettings.compactViewScale
            },
            combatPauseRules: {
                active: "FALLOUTMAW.Calendar.Configuration.CombatPauseRule.Active",
                current: "FALLOUTMAW.Calendar.Configuration.CombatPauseRule.Current"
            },
            currentYear: (<Calendar>this.object).year,
            gameSystem: FoundryVTTGameData.systemID,
            generalSettings: (<Calendar>this.object).generalSettings,
            globalConfiguration: this.globalConfiguration,
            isGM: GameSettings.IsGm(),
            leapYearRule: (<Calendar>this.object).year.leapYearRule,
            leapYearRules: {
                none: "FALLOUTMAW.Calendar.Configuration.LeapYear.Rules.None",
                gregorian: "FALLOUTMAW.Calendar.Configuration.LeapYear.Rules.Gregorian",
                custom: "FALLOUTMAW.Calendar.Configuration.LeapYear.Rules.Custom"
            },
            months: (<Calendar>this.object).months.map((m) => {
                const mt = m.toTemplate();
                mt.startingWeekday = mt.startingWeekday === null ? "null" : mt.startingWeekday.toString();
                return mt;
            }),
            monthStartingWeekdays: <{ [key: string]: string }>{},
            moons: (<Calendar>this.object).moons.map((m) => {
                return m.toTemplate();
            }),
            moonIcons: <{ [key: string]: string }>{},
            moonYearReset: {
                none: "FALLOUTMAW.Calendar.Configuration.Moon.YearResetNo",
                "leap-year": "FALLOUTMAW.Calendar.Configuration.Moon.YearResetLeap",
                "x-years": "FALLOUTMAW.Calendar.Configuration.Moon.YearResetX"
            },
            noteCategories: <FalloutMaWCalendar.NoteCategory[]>[],
            predefined: this.predefindCalendars,
            qsCalDate: { year: 1, month: 0, day: 0, hour: 0, minute: 0, allDay: true },
            seasonColors: [
                {
                    value: "#ffffff",
                    display: GameSettings.Localize("FALLOUTMAW.Calendar.Configuration.Season.ColorWhite")
                },
                {
                    value: "#46B946",
                    display: GameSettings.Localize("FALLOUTMAW.Calendar.Configuration.Season.ColorSpring")
                },
                {
                    value: "#E0C40B",
                    display: GameSettings.Localize("FALLOUTMAW.Calendar.Configuration.Season.ColorSummer")
                },
                {
                    value: "#FF8E47",
                    display: GameSettings.Localize("FALLOUTMAW.Calendar.Configuration.Season.ColorFall")
                },
                {
                    value: "#479DFF",
                    display: GameSettings.Localize("FALLOUTMAW.Calendar.Configuration.Season.ColorWinter")
                }
            ],
            seasonIcons: <{ [key: string]: string }>{},
            seasons: (<Calendar>this.object).seasons.map((s) => {
                return s.toTemplate();
            }),
            showLeapYearCustomMod: (<Calendar>this.object).year.leapYearRule.rule === LeapYearRules.Custom,
            showLeapYearMonths: (<Calendar>this.object).year.leapYearRule.rule !== LeapYearRules.None,
            time: (<Calendar>this.object).time,
            timeTrackers: {
                none: "FALLOUTMAW.Calendar.Configuration.General.None",
                self: "FALLOUTMAW.Calendar.Configuration.General.Self",
                "third-party": "FALLOUTMAW.Calendar.Configuration.General.ThirdParty",
                mixed: "FALLOUTMAW.Calendar.Configuration.General.Mixed"
            },
            uiElementStates: this.uiElementStates,
            weekdays: (<Calendar>this.object).weekdays.map((w) => {
                return w.toTemplate();
            }),
            yearNameBehaviourOptions: {
                default: "Default",
                repeat: "PLAYLIST.SoundRepeat",
                random: "FALLOUTMAW.Calendar.Random"
            }
        };

        data.seasonIcons[Icons.None] = GameSettings.Localize("FALLOUTMAW.Calendar.Configuration.LeapYear.Rules.None");
        data.seasonIcons[Icons.Spring] = GameSettings.Localize("FALLOUTMAW.Calendar.Configuration.Season.ColorSpring");
        data.seasonIcons[Icons.Summer] = GameSettings.Localize("FALLOUTMAW.Calendar.Configuration.Season.ColorSummer");
        data.seasonIcons[Icons.Fall] = GameSettings.Localize("FALLOUTMAW.Calendar.Configuration.Season.ColorFall");
        data.seasonIcons[Icons.Winter] = GameSettings.Localize("FALLOUTMAW.Calendar.Configuration.Season.ColorWinter");
        data.seasonIcons[Icons.Sunrise] = GameSettings.Localize("FALLOUTMAW.Calendar.Dawn");
        data.seasonIcons[Icons.Sunset] = GameSettings.Localize("FALLOUTMAW.Calendar.Dusk");

        data.moonIcons[Icons.NewMoon] = GameSettings.Localize("FALLOUTMAW.Calendar.Moon.Phase.New");
        data.moonIcons[Icons.WaxingCrescent] = GameSettings.Localize("FALLOUTMAW.Calendar.Moon.Phase.WaxingCrescent");
        data.moonIcons[Icons.FirstQuarter] = GameSettings.Localize("FALLOUTMAW.Calendar.Moon.Phase.FirstQuarter");
        data.moonIcons[Icons.WaxingGibbous] = GameSettings.Localize("FALLOUTMAW.Calendar.Moon.Phase.WaxingGibbous");
        data.moonIcons[Icons.Full] = GameSettings.Localize("FALLOUTMAW.Calendar.Moon.Phase.Full");
        data.moonIcons[Icons.WaningGibbous] = GameSettings.Localize("FALLOUTMAW.Calendar.Moon.Phase.WaningGibbous");
        data.moonIcons[Icons.LastQuarter] = GameSettings.Localize("FALLOUTMAW.Calendar.Moon.Phase.LastQuarter");
        data.moonIcons[Icons.WaningCrescent] = GameSettings.Localize("FALLOUTMAW.Calendar.Moon.Phase.WaningCrescent");

        data.monthStartingWeekdays["null"] = GameSettings.Localize("Default");
        for (let i = 0; i < (<Calendar>this.object).weekdays.length; i++) {
            data.monthStartingWeekdays[(<Calendar>this.object).weekdays[i].numericRepresentation.toString()] = (<Calendar>this.object).weekdays[
                i
            ].name;
        }

        data.qsCalDate.year = currDate.year;
        data.qsCalDate.month = currDate.month;
        data.qsCalDate.day = currDate.day;

        data.noteCategories = (<Calendar>this.object).noteCategories;
        return data;
    }

    /**
     * Updates the data object
     * @protected
     */
    protected _updateObject(): Promise<unknown> {
        return Promise.resolve(undefined);
    }

    /**
     * Adds any event listeners to the application DOM
     * @param {JQuery<HTMLElement>} html The root HTML of the application window
     * @protected
     */
    public activateListeners(html: JQuery<HTMLElement>) {
        super.activateListeners(html);
        (<Calendar>this.object).seasons.forEach((s) => {
            DateSelectorManager.GetSelector(`fallout_maw_calendar_season_start_date_${s.id}`, {
                onDateSelect: this.dateSelectorChange.bind(this, s.id, ConfigurationDateSelectors.seasonStartingDate)
            }).activateListeners();
            DateSelectorManager.GetSelector(`fallout_maw_calendar_season_sunrise_time_${s.id}`, {
                onDateSelect: this.dateSelectorChange.bind(this, s.id, ConfigurationDateSelectors.seasonSunriseSunsetTime)
            }).activateListeners();
        });
        (<Calendar>this.object).moons.forEach((m) => {
            DateSelectorManager.GetSelector(`fallout_maw_calendar_first_new_moon_date_${m.id}`, {
                onDateSelect: this.dateSelectorChange.bind(this, m.id, ConfigurationDateSelectors.moonFirstNewMoonDate)
            }).activateListeners();
        });
        this.appWindow = document.getElementById(ConfigurationApp.appWindowId);
        if (this.appWindow) {
            DateSelectorManager.ActivateSelector("quick-setup-predefined-calendar");

            // Click anywhere in the app
            this.appWindow.addEventListener("click", this.toggleCalendarSelector.bind(this, true));
            //---------------------
            // Calendar Picker / Add new calendar
            //---------------------
            this.appWindow
                .querySelector(".tabs .fallout-maw-calendar-calendar-selector .fallout-maw-calendar-heading")
                ?.addEventListener("click", this.toggleCalendarSelector.bind(this, false));
            this.appWindow.querySelectorAll(".tabs .fallout-maw-calendar-calendar-selector ul li[data-calendar]").forEach((e) => {
                e.addEventListener("click", this.calendarClick.bind(this));
            });
            this.appWindow.querySelectorAll(".tabs .fallout-maw-calendar-calendar-selector ul li[data-calendar] .fallout-maw-calendar-control").forEach((e) => {
                e.addEventListener("click", this.removeCalendarClick.bind(this));
            });
            this.appWindow.querySelector(".fallout-maw-calendar-tab-wrapper .fallout-maw-calendar-new-calendar .fallout-maw-calendar-save")?.addEventListener("click", this.addNewCalendar.bind(this));
            //---------------------
            // Quick Setup
            //---------------------
            //Predefined Calendar clicked
            this.appWindow.querySelectorAll(".fallout-maw-calendar-quick-setup .fallout-maw-calendar-predefined-list .fallout-maw-calendar-predefined-calendar").forEach((e) => {
                e.addEventListener("click", this.predefinedCalendarClick.bind(this));
            });
            //Next button clicked
            this.appWindow
                .querySelector(".fallout-maw-calendar-quick-setup .fallout-maw-calendar-control-section .fallout-maw-calendar-qs-next")
                ?.addEventListener("click", this.quickSetupNextClick.bind(this));
            //Back button clicked
            this.appWindow
                .querySelector(".fallout-maw-calendar-quick-setup .fallout-maw-calendar-control-section .fallout-maw-calendar-qs-back")
                ?.addEventListener("click", this.quickSetupBackClick.bind(this));
            //Save button clicked
            this.appWindow
                .querySelector(".fallout-maw-calendar-quick-setup .fallout-maw-calendar-control-section .fallout-maw-calendar-qs-save")
                ?.addEventListener("click", this.quickSetupSaveClick.bind(this));

            //---------------------
            // Show/Hide Advanced
            //---------------------
            this.appWindow.querySelectorAll(".fallout-maw-calendar-show-advanced").forEach((e) => {
                e.addEventListener("click", this.toggleShowAdvanced.bind(this));
            });
            //---------------------
            // Input Changes
            //---------------------
            this.appWindow.querySelectorAll("input, select, textarea").forEach((e) => {
                e.addEventListener("change", this.inputChange.bind(this));
                e.addEventListener("keyup", this.inputChange.bind(this));
            });
            //---------------------
            // Date Format Table open/close
            //---------------------
            this.appWindow.querySelector(".fallout-maw-calendar-date-format-token-show")?.addEventListener("click", this.dateFormatTableClick.bind(this));
            //---------------------
            // Add To/Remove From Table
            //---------------------
            this.appWindow.querySelectorAll(`.fallout-maw-calendar-table-actions .fallout-maw-calendar-save`).forEach((e) => {
                e.addEventListener("click", this.addToTable.bind(this));
            });
            this.appWindow.querySelectorAll(`.fallout-maw-calendar-control.fallout-maw-calendar-delete`).forEach((e) => {
                e.addEventListener("click", this.removeFromTable.bind(this));
            });
            //---------------------
            // Import/Export buttons
            //---------------------
            this.appWindow.querySelector("#exportCalendar")?.addEventListener("click", this.exportCalendar.bind(this));
            this.appWindow.querySelector("#falloutMawCalendarImportCalendarPicker")?.addEventListener("change", this.importCalendarFileChange.bind(this));
            //---------------------
            // Save Button
            //---------------------
            this.appWindow.querySelector("#falloutMawCalendarSave")?.addEventListener("click", this.saveClick.bind(this, true));
        }
    }

    /**
     * Processes changes to any input field
     * @private
     */
    private inputChange() {
        this.writeInputValuesToObjects();
        this.updateUIFromObject();
    }

    /**
     * Toggles the visibility of the calendar selector
     * @param forceHide Force the selector to hide
     * @private
     */
    private toggleCalendarSelector(forceHide: boolean = false) {
        if (this.appWindow) {
            const cList = this.appWindow.querySelector(".tabs .fallout-maw-calendar-calendar-selector ul");
            if (cList) {
                animateElement(cList, 500, forceHide);
            }
        }
    }

    /**
     * Process when a calendar is clicked on the calendar list
     * @param e The click event
     * @private
     */
    private calendarClick(e: Event) {
        const target = <HTMLElement>e.currentTarget;
        if (target) {
            const calId = target.getAttribute("data-calendar");
            if (calId && calId !== (<Calendar>this.object).id) {
                const clickedCal = this.calendars.find((c) => {
                    return c.id === calId;
                });
                if (clickedCal) {
                    this.object = clickedCal;
                    this._tabs[0].active = "generalSettings";
                    this.updateApp();
                }
            }
        }
    }

    /**
     * Process the remove calendar button click
     * @param e The click event
     * @private
     */
    private removeCalendarClick(e: Event) {
        e.preventDefault();
        e.stopPropagation();
        const target = <HTMLElement>e.currentTarget;
        if (target) {
            const calId = target.getAttribute("data-calendar");
            if (calId) {
                const clickedCal = this.calendars.find((c) => {
                    return c.id === calId;
                });
                if (clickedCal) {
                    this.confirmationDialog("remove-calendar", "remove-calendar", { id: clickedCal.id, name: clickedCal.name });
                }
            }
        }
    }

    /**
     * Process the confirmation of removing a calendar
     * @param args The arguments from the dialog that contain details on which calendar to remove
     * @private
     */
    private removeCalendarConfirm(args: any) {
        if (args["id"]) {
            CalManager.removeCalendar(args["id"]);
            this.calendars = CalManager.getAllCalendars(true);
            this.object = this.calendars[0];
            this.updateApp();
        }
    }

    /**
     * Process the adding of a new calendar
     * @param e The click event
     * @private
     */
    private async addNewCalendar(e: Event) {
        e.preventDefault();
        const calNameElement = <HTMLInputElement>document.getElementById("falloutMawCalendarAddCalendarName");
        if (calNameElement && calNameElement.value) {
            const newCal = CalManager.addTempCalendar(calNameElement.value);
            await PredefinedCalendar.setToPredefined(newCal, PredefinedCalendars.Gregorian);
            this.calendars.push(newCal);
            this.object = newCal;
            this._tabs[0].active = "quickSetup";
            this.updateApp();
        }
    }

    /**
     * Process when a predefined calendar is clicked in the list of predefined calendars
     * @param e The Click Event
     * @private
     */
    private predefinedCalendarClick(e: Event) {
        const element = (<HTMLElement>e.target)?.closest(".fallout-maw-calendar-predefined-calendar");
        if (element && this.appWindow) {
            const allReadySelected = element.classList.contains("fallout-maw-calendar-selected");
            this.appWindow.querySelectorAll(`.fallout-maw-calendar-quick-setup .fallout-maw-calendar-predefined-list .fallout-maw-calendar-predefined-calendar`).forEach((e) => {
                e.classList.remove("fallout-maw-calendar-selected");
            });
            const nextBttn = this.appWindow.querySelector(".fallout-maw-calendar-quick-setup .fallout-maw-calendar-control-section .fallout-maw-calendar-qs-next");
            if (!allReadySelected) {
                element.classList.add("fallout-maw-calendar-selected");
                const cal = element.getAttribute("data-calendar");
                if (cal) {
                    this.uiElementStates.selectedPredefinedCalendar = cal;
                    if (nextBttn) {
                        (<HTMLElement>nextBttn).style.display = "block";
                    }
                    //PredefinedCalendar.setToPredefined((<Calendar>this.object).year, <PredefinedCalendars>cal);
                }
            } else {
                this.uiElementStates.selectedPredefinedCalendar = "";
                if (nextBttn) {
                    (<HTMLElement>nextBttn).style.display = "none";
                }
            }
        }
    }

    /**
     * Process when the next button is clicked in the quick setup tab
     * @param e The Click Event
     * @private
     */
    private quickSetupNextClick(e: Event) {
        e.preventDefault();
        this.confirmationDialog("overwrite", "predefined", { name: (<Calendar>this.object).name });
    }

    /**
     * Process the confirmation click of the next confirmation dialog
     * @private
     */
    private async quickSetupNextConfirm() {
        this.uiElementStates.qsNextClicked = !this.uiElementStates.qsNextClicked;
        await PredefinedCalendar.setToPredefined(
            <Calendar>this.object,
            <PredefinedCalendars>this.uiElementStates.selectedPredefinedCalendar,
            this.uiElementStates.qsAddNotes
        );
        this.updateApp();
    }

    /**
     * Process when the back button is clicked in the quick setup tab
     * @param e The Click Event
     * @private
     */
    private quickSetupBackClick(e: Event) {
        e.preventDefault();
        this.uiElementStates.qsNextClicked = !this.uiElementStates.qsNextClicked;
        if (this.appWindow) {
            const step1 = this.appWindow.querySelector(".fallout-maw-calendar-quick-setup .fallout-maw-calendar-predefined");
            const step2 = this.appWindow.querySelector(".fallout-maw-calendar-quick-setup .fallout-maw-calendar-settings");
            if (step1 && step2) {
                animateElement(step1, 500);
                animateElement(step2, 500);
            }
        }
    }

    /**
     * Process when the save button is clicked in the quick setup tab
     * @param e The Click Event
     * @private
     */
    private quickSetupSaveClick(e: Event) {
        e.preventDefault();
        this.uiElementStates.selectedPredefinedCalendar = "";
        this.uiElementStates.qsNextClicked = false;
        this.uiElementStates.qsAddNotes = true;
        const ds = DateSelectorManager.GetSelector("quick-setup-predefined-calendar", {});
        (<Calendar>this.object).year.numericRepresentation = ds.selectedDate.start.year;
        (<Calendar>this.object).year.visibleYear = ds.selectedDate.start.year;
        (<Calendar>this.object).year.selectedYear = ds.selectedDate.start.year;
        (<Calendar>this.object).updateMonth(ds.selectedDate.start.month, "current", true, ds.selectedDate.start.day);
        this._tabs[0].active = "generalSettings";
        this.save(false, false).catch(Logger.error);
    }

    /**
     * Toggle the display of the advanced settings for a specific month
     * @param e The Click Event
     * @private
     */
    private toggleShowAdvanced(e: Event) {
        e.preventDefault();
        const target = <HTMLElement>e.currentTarget;
        if (target) {
            const row = <HTMLElement>target.closest(".fallout-maw-calendar-row");
            if (row) {
                const index = parseInt(row.getAttribute("data-index") || "");
                const type = row.getAttribute("data-type");
                if (!isNaN(index) && index >= 0) {
                    if (type === "month" && index < (<Calendar>this.object).months.length) {
                        (<Calendar>this.object).months[index].showAdvanced = !(<Calendar>this.object).months[index].showAdvanced;
                    } else if (type === "weekday" && index < (<Calendar>this.object).weekdays.length) {
                        (<Calendar>this.object).weekdays[index].showAdvanced = !(<Calendar>this.object).weekdays[index].showAdvanced;
                    } else if (type === "season" && index < (<Calendar>this.object).seasons.length) {
                        (<Calendar>this.object).seasons[index].showAdvanced = !(<Calendar>this.object).seasons[index].showAdvanced;
                    }
                    this.updateUIFromObject();
                }
            }
        }
    }

    /**
     * Write the current values from all the input fields in the configuration dialog into the calendar object.
     * @private
     */
    private writeInputValuesToObjects() {
        if (this.appWindow) {
            //----------------------------------
            // Global Config: Settings
            //----------------------------------
            this.globalConfiguration.secondsInCombatRound = <number>getNumericInputValue("#falloutMawCalendarSecondsInCombatRound", 6, false, this.appWindow);
            this.globalConfiguration.combatPauseRule = <CombatPauseRules>(
                getTextInputValue("#falloutMawCalendarCombatPauseClockRule", <string>CombatPauseRules.Active, this.appWindow)
            );
            this.globalConfiguration.calendarsSameTimestamp = getCheckBoxInputValue("#falloutMawCalendarCalendarsSameTimestamp", false, this.appWindow);
            this.globalConfiguration.syncCalendars = getCheckBoxInputValue("#falloutMawCalendarSyncCalendars", false, this.appWindow);
            this.globalConfiguration.showNotesFolder = getCheckBoxInputValue("#falloutMawCalendarShowNoteFolder", false, this.appWindow);
            this.globalConfiguration.inGameChatTimestamp = getCheckBoxInputValue("#falloutMawCalendarInGameChatTimestamp", false, this.appWindow);

            //----------------------------------
            // Global Config: Client Settings
            //----------------------------------
            this.clientSettings.theme = getTextInputValue("#falloutMawCalendarTheme", Themes[0].key, this.appWindow);
            this.clientSettings.openOnLoad = getCheckBoxInputValue("#falloutMawCalendarOpenOnLoad", true, this.appWindow);
            this.clientSettings.openCompact = getCheckBoxInputValue("#falloutMawCalendarOpenInCompact", false, this.appWindow);
            this.clientSettings.rememberPosition = getCheckBoxInputValue("#falloutMawCalendarRememberPos", true, this.appWindow);
            this.clientSettings.rememberCompactPosition = getCheckBoxInputValue("#falloutMawCalendarRememberCompactPos", true, this.appWindow);
            this.clientSettings.noteReminderNotification = <NoteReminderNotificationType>(
                getTextInputValue("#falloutMawCalendarNoteReminderNotification", <string>NoteReminderNotificationType.whisper, this.appWindow)
            );
            this.clientSettings.sideDrawerDirection = getTextInputValue("#falloutMawCalendarSideDrawerDirection", "fallout-maw-calendar-right", this.appWindow);
            this.clientSettings.alwaysShowNoteList = getCheckBoxInputValue("#falloutMawCalendarAlwaysOpenNoteList", false, this.appWindow);
            this.clientSettings.persistentOpen = getCheckBoxInputValue("#falloutMawCalendarPersistentOpen", false, this.appWindow);
            this.clientSettings.compactViewScale = getNumericInputValue('input[name="falloutMawCalendarCompactViewScale"]', 100, false, this.appWindow) || 100;

            //----------------------------------
            // Global Config: Permissions
            //----------------------------------
            this.globalConfiguration.permissions.viewCalendar.player = getCheckBoxInputValue("#falloutMawCalendarCalendarVisibleP", true, this.appWindow);
            this.globalConfiguration.permissions.viewCalendar.trustedPlayer = getCheckBoxInputValue("#falloutMawCalendarCalendarVisibleTP", true, this.appWindow);
            this.globalConfiguration.permissions.viewCalendar.assistantGameMaster = getCheckBoxInputValue(
                "#falloutMawCalendarCalendarVisibleAGM",
                true,
                this.appWindow
            );
            this.globalConfiguration.permissions.addNotes.player = getCheckBoxInputValue("#falloutMawCalendarAddNotesP", false, this.appWindow);
            this.globalConfiguration.permissions.addNotes.trustedPlayer = getCheckBoxInputValue("#falloutMawCalendarAddNotesTP", false, this.appWindow);
            this.globalConfiguration.permissions.addNotes.assistantGameMaster = getCheckBoxInputValue("#falloutMawCalendarAddNotesAGM", false, this.appWindow);
            this.globalConfiguration.permissions.changeDateTime.player = getCheckBoxInputValue("#falloutMawCalendarChangeDateTimeP", false, this.appWindow);
            this.globalConfiguration.permissions.changeDateTime.trustedPlayer = getCheckBoxInputValue("#falloutMawCalendarChangeDateTimeTP", false, this.appWindow);
            this.globalConfiguration.permissions.changeDateTime.assistantGameMaster = getCheckBoxInputValue(
                "#falloutMawCalendarChangeDateTimeAGM",
                false,
                this.appWindow
            );
            this.globalConfiguration.permissions.reorderNotes.player = getCheckBoxInputValue("#falloutMawCalendarReorderNotesP", false, this.appWindow);
            this.globalConfiguration.permissions.reorderNotes.trustedPlayer = getCheckBoxInputValue("#falloutMawCalendarReorderNotesTP", false, this.appWindow);
            this.globalConfiguration.permissions.reorderNotes.assistantGameMaster = getCheckBoxInputValue(
                "#falloutMawCalendarReorderNotesAGM",
                false,
                this.appWindow
            );
            this.globalConfiguration.permissions.changeActiveCalendar.player = getCheckBoxInputValue("#falloutMawCalendarChangeActiveCalP", false, this.appWindow);
            this.globalConfiguration.permissions.changeActiveCalendar.trustedPlayer = getCheckBoxInputValue(
                "#falloutMawCalendarChangeActiveCalTP",
                false,
                this.appWindow
            );
            this.globalConfiguration.permissions.changeActiveCalendar.assistantGameMaster = getCheckBoxInputValue(
                "#falloutMawCalendarChangeActiveCalAGM",
                false,
                this.appWindow
            );

            //----------------------------------
            // Calendar: Quick Setup
            //----------------------------------
            this.uiElementStates.qsAddNotes = getCheckBoxInputValue("#falloutMawCalendarQSAddNotes", true, this.appWindow);

            //----------------------------------
            // Calendar: General Settings
            //----------------------------------
            (<Calendar>this.object).name = getTextInputValue(
                "#falloutMawCalendarCalendarName",
                GameSettings.Localize("FALLOUTMAW.Calendar.NewCalendar"),
                this.appWindow
            );
            (<Calendar>this.object).generalSettings.gameWorldTimeIntegration = <GameWorldTimeIntegrations>(
                getTextInputValue("#falloutMawCalendarGameWorldTime", <string>GameWorldTimeIntegrations.Mixed, this.appWindow)
            );
            (<Calendar>this.object).generalSettings.pf2eSync = getCheckBoxInputValue("#falloutMawCalendarPF2ESync", true, this.appWindow);

            //----------------------------------
            // Calendar: Display Options
            //----------------------------------
            (<Calendar>this.object).generalSettings.dateFormat.date = getTextInputValue("#falloutMawCalendarDateFormatsDate", "MMMM DD, YYYY", this.appWindow);
            (<Calendar>this.object).generalSettings.dateFormat.time = getTextInputValue("#falloutMawCalendarDateFormatsTime", "HH:mm:ss", this.appWindow);
            (<Calendar>this.object).generalSettings.dateFormat.monthYear = getTextInputValue(
                "#falloutMawCalendarDateFormatsMonthYear",
                "MMMM YAYYYYYZ",
                this.appWindow
            );
            (<Calendar>this.object).generalSettings.dateFormat.chatTime = getTextInputValue(
                "#falloutMawCalendarDateFormatsChatTime",
                "MMM DD, YYYY HH:mm",
                this.appWindow
            );
            (<Calendar>this.object).generalSettings.compactViewOptions.controlLayout = <CompactViewDateTimeControlDisplay>(
                (getCheckBoxGroupValues("falloutMawCalendarCompactControlLayout", this.appWindow)[0] || "full")
            );

            //----------------------------------
            // Calendar: Year Settings
            //----------------------------------
            (<Calendar>this.object).year.numericRepresentation = <number>getNumericInputValue("#falloutMawCalendarCurrentYear", 0, false, this.appWindow);
            (<Calendar>this.object).year.prefix = getTextInputValue("#falloutMawCalendarYearPreFix", "", this.appWindow);
            (<Calendar>this.object).year.postfix = getTextInputValue("#falloutMawCalendarYearPostFix", "", this.appWindow);
            (<Calendar>this.object).year.yearZero = <number>getNumericInputValue("#falloutMawCalendarYearZero", 0, false, this.appWindow);

            (<Calendar>this.object).year.yearNamingRule = <YearNamingRules>(
                getTextInputValue("#falloutMawCalendarYearNameBehaviour", <string>YearNamingRules.Default, this.appWindow)
            );
            (<Calendar>this.object).year.yearNamesStart = <number>getNumericInputValue("#falloutMawCalendarYearNamesStart", 0, false, this.appWindow);
            this.appWindow.querySelectorAll(".fallout-maw-calendar-year-settings .fallout-maw-calendar-year-names>.fallout-maw-calendar-row:not(.fallout-maw-calendar-head)").forEach((e) => {
                const index = parseInt((<HTMLElement>e).getAttribute("data-index") || "");
                if (!isNaN(index) && index >= 0 && index < (<Calendar>this.object).year.yearNames.length) {
                    (<Calendar>this.object).year.yearNames[index] = getTextInputValue(
                        ".fallout-maw-calendar-year-name",
                        GameSettings.Localize("FALLOUTMAW.Calendar.Defaults.NamedYear"),
                        e
                    );
                }
            });

            //----------------------------------
            // Calendar: Month Settings
            //----------------------------------
            this.appWindow.querySelectorAll(".fallout-maw-calendar-month-settings .fallout-maw-calendar-months>.fallout-maw-calendar-row:not(.fallout-maw-calendar-head)").forEach((e) => {
                const index = parseInt((<HTMLElement>e).getAttribute("data-index") || "");
                if (!isNaN(index) && index >= 0 && index < (<Calendar>this.object).months.length) {
                    const name = getTextInputValue(
                        ".fallout-maw-calendar-month-name",
                        GameSettings.Localize("FALLOUTMAW.Calendar.Defaults.Month"),
                        e
                    );
                    if (name !== (<Calendar>this.object).months[index].name) {
                        (<Calendar>this.object).months[index].abbreviation = name.substring(0, 3);
                    } else {
                        (<Calendar>this.object).months[index].abbreviation = getTextInputValue(
                            ".fallout-maw-calendar-month-abbreviation",
                            GameSettings.Localize("FALLOUTMAW.Calendar.Defaults.Month").substring(0, 3),
                            e
                        );
                    }
                    (<Calendar>this.object).months[index].description = getTextInputValue(".fallout-maw-calendar-month-description", "", e);
                    (<Calendar>this.object).months[index].name = name;
                    const days = <number>getNumericInputValue(".fallout-maw-calendar-month-days", 1, false, e);
                    if (days !== (<Calendar>this.object).months[index].numberOfDays) {
                        (<Calendar>this.object).months[index].numberOfDays = days;
                        if ((<Calendar>this.object).year.leapYearRule.rule === LeapYearRules.None) {
                            (<Calendar>this.object).months[index].numberOfLeapYearDays = days;
                        }
                        this.updateMonthDays((<Calendar>this.object).months[index]);
                    }
                    const intercalary = getCheckBoxInputValue(".fallout-maw-calendar-month-intercalary", false, e);
                    if (intercalary !== (<Calendar>this.object).months[index].intercalary) {
                        (<Calendar>this.object).months[index].intercalary = intercalary;
                        this.rebaseMonthNumbers();
                    }
                    const intercalaryInclude = getCheckBoxInputValue(".fallout-maw-calendar-month-intercalary-include", false, e);
                    if (intercalaryInclude !== (<Calendar>this.object).months[index].intercalaryInclude) {
                        (<Calendar>this.object).months[index].intercalaryInclude = intercalaryInclude;
                        this.rebaseMonthNumbers();
                    }
                    (<Calendar>this.object).months[index].numericRepresentationOffset = <number>(
                        getNumericInputValue(".fallout-maw-calendar-month-numeric-representation-offset", 0, false, e)
                    );
                    (<Calendar>this.object).months[index].startingWeekday = getNumericInputValue(".fallout-maw-calendar-month-starting-weekday", null, false, e);
                }
            });
            //----------------------------------
            // Calendar: Weekday Settings
            //----------------------------------
            (<Calendar>this.object).year.showWeekdayHeadings = getCheckBoxInputValue("#falloutMawCalendarShowWeekdayHeaders", true, this.appWindow);
            (<Calendar>this.object).year.firstWeekday = <number>getNumericInputValue("#falloutMawCalendarWeekdayFirstDay", 0, false, this.appWindow);
            this.appWindow.querySelectorAll(".fallout-maw-calendar-weekday-settings .fallout-maw-calendar-weekdays>.fallout-maw-calendar-row:not(.fallout-maw-calendar-head)").forEach((e) => {
                const index = parseInt((<HTMLElement>e).getAttribute("data-index") || "");
                if (!isNaN(index) && index >= 0 && index < (<Calendar>this.object).weekdays.length) {
                    const name = getTextInputValue(
                        ".fallout-maw-calendar-weekday-name",
                        GameSettings.Localize("FALLOUTMAW.Calendar.Defaults.Weekday"),
                        e
                    );
                    if (name !== (<Calendar>this.object).weekdays[index].name) {
                        (<Calendar>this.object).weekdays[index].name = name;
                        (<Calendar>this.object).weekdays[index].abbreviation = name.substring(0, 2);
                    } else {
                        (<Calendar>this.object).weekdays[index].abbreviation = getTextInputValue(
                            ".fallout-maw-calendar-weekday-abbreviation",
                            GameSettings.Localize("FALLOUTMAW.Calendar.Defaults.Weekday").substring(0, 2),
                            e
                        );
                    }
                    (<Calendar>this.object).weekdays[index].description = getTextInputValue(".fallout-maw-calendar-weekday-description", "", e);
                    (<Calendar>this.object).weekdays[index].restday = getCheckBoxInputValue(".fallout-maw-calendar-weekday-weekend", false, e);
                }
            });

            //----------------------------------
            // Calendar: Leap Year Settings
            //----------------------------------
            (<Calendar>this.object).year.leapYearRule.rule = <LeapYearRules>getTextInputValue("#falloutMawCalendarLeapYearRule", "none", this.appWindow);
            (<Calendar>this.object).year.leapYearRule.customMod = <number>getNumericInputValue("#falloutMawCalendarLeapYearCustomMod", 0, false, this.appWindow);
            (<Calendar>this.object).year.leapYearRule.startingYear = <number>getNumericInputValue("#falloutMawCalendarLeapStartingYear", 0, false, this.appWindow);
            this.appWindow.querySelectorAll(".fallout-maw-calendar-leapyear-settings .fallout-maw-calendar-months>.fallout-maw-calendar-row:not(.fallout-maw-calendar-head)").forEach((e) => {
                const index = parseInt((<HTMLElement>e).getAttribute("data-index") || "");
                if (!isNaN(index) && index >= 0 && index < (<Calendar>this.object).months.length) {
                    const days = <number>getNumericInputValue(".fallout-maw-calendar-month-leap-days", 0, false, e);
                    if (days !== (<Calendar>this.object).months[index].numberOfLeapYearDays) {
                        (<Calendar>this.object).months[index].numberOfLeapYearDays = days;
                        this.updateMonthDays((<Calendar>this.object).months[index]);
                    }
                }
            });

            //----------------------------------
            // Calendar: Season Settings
            //----------------------------------
            this.appWindow.querySelectorAll(".fallout-maw-calendar-season-settings .fallout-maw-calendar-seasons>.fallout-maw-calendar-row:not(.fallout-maw-calendar-head)").forEach((e) => {
                const index = parseInt((<HTMLElement>e).getAttribute("data-index") || "");
                if (!isNaN(index) && index >= 0 && index < (<Calendar>this.object).seasons.length) {
                    (<Calendar>this.object).seasons[index].name = getTextInputValue(
                        ".fallout-maw-calendar-season-name",
                        GameSettings.Localize("FALLOUTMAW.Calendar.Defaults.Season"),
                        e
                    );
                    (<Calendar>this.object).seasons[index].icon = <Icons>getTextInputValue(".fallout-maw-calendar-season-icon", Icons.None, e);
                    (<Calendar>this.object).seasons[index].color = getTextInputValue(".fallout-maw-calendar-season-color", "#FFFFFF", e);
                    (<Calendar>this.object).seasons[index].description = getTextInputValue(".fallout-maw-calendar-season-description", "", e);
                }
            });

            //----------------------------------
            // Calendar: Moon Settings
            //----------------------------------
            this.appWindow.querySelectorAll(".fallout-maw-calendar-moon-settings .fallout-maw-calendar-moons>.fallout-maw-calendar-row:not(.fallout-maw-calendar-head)").forEach((e) => {
                const index = parseInt((<HTMLElement>e).getAttribute("data-index") || "");
                if (!isNaN(index) && index >= 0 && index < (<Calendar>this.object).moons.length) {
                    (<Calendar>this.object).moons[index].name = getTextInputValue(
                        ".fallout-maw-calendar-moon-name",
                        GameSettings.Localize("FALLOUTMAW.Calendar.Defaults.Moon"),
                        e
                    );
                    (<Calendar>this.object).moons[index].cycleLength = <number>getNumericInputValue(".fallout-maw-calendar-moon-cycle-length", 29.53059, true, e);
                    (<Calendar>this.object).moons[index].cycleDayAdjust = <number>getNumericInputValue(".fallout-maw-calendar-moon-cycle-adjustment", 0, true, e);
                    (<Calendar>this.object).moons[index].color = getTextInputValue(".fallout-maw-calendar-moon-color", "#FFFFFF", e);
                    (<Calendar>this.object).moons[index].affectsLighting = getCheckBoxInputValue(".fallout-maw-calendar-moon-affects-lighting", true, e);
                    (<Calendar>this.object).moons[index].maxLightContribution = normalizeMoonLightingValue(
                        getNumericInputValue(".fallout-maw-calendar-moon-max-light-contribution", 0.5, true, e),
                        0.5
                    );
                    (<Calendar>this.object).moons[index].firstNewMoon.yearReset = <MoonYearResetOptions>(
                        getTextInputValue(".fallout-maw-calendar-moon-year-reset", "none", e)
                    );
                    (<Calendar>this.object).moons[index].firstNewMoon.year = <number>getNumericInputValue(".fallout-maw-calendar-moon-year", 0, false, e);
                    (<Calendar>this.object).moons[index].firstNewMoon.yearX = <number>getNumericInputValue(".fallout-maw-calendar-moon-year-x", 0, false, e);

                    e.querySelectorAll(".fallout-maw-calendar-phases>.fallout-maw-calendar-row:not(.fallout-maw-calendar-head)").forEach((p) => {
                        const phaseIndex = parseInt((<HTMLElement>p).getAttribute("data-index") || "");
                        if (!isNaN(phaseIndex) && phaseIndex >= 0 && phaseIndex < (<Calendar>this.object).moons[index].phases.length) {
                            (<Calendar>this.object).moons[index].phases[phaseIndex].name = getTextInputValue(
                                ".fallout-maw-calendar-moon-phase-name",
                                GameSettings.Localize("FALLOUTMAW.Calendar.Defaults.MoonPhase"),
                                p
                            );
                            (<Calendar>this.object).moons[index].phases[phaseIndex].singleDay = getCheckBoxInputValue(
                                ".fallout-maw-calendar-moon-phase-single-day",
                                false,
                                p
                            );
                            (<Calendar>this.object).moons[index].phases[phaseIndex].icon = <Icons>getTextInputValue(".fallout-maw-calendar-moon-phase-icon", "new", p);
                            (<Calendar>this.object).moons[index].phases[phaseIndex].illumination = normalizeMoonLightingValue(
                                getNumericInputValue(
                                    ".fallout-maw-calendar-moon-phase-illumination",
                                    defaultMoonPhaseIllumination((<Calendar>this.object).moons[index].phases[phaseIndex].icon),
                                    true,
                                    p
                                ),
                                defaultMoonPhaseIllumination((<Calendar>this.object).moons[index].phases[phaseIndex].icon)
                            );
                        }
                    });

                    (<Calendar>this.object).moons[index].updatePhaseLength();
                }
            });

            //----------------------------------
            // Calendar: Time Settings
            //----------------------------------
            (<Calendar>this.object).time.hoursInDay = <number>getNumericInputValue("#falloutMawCalendarHoursInDay", 24, false, this.appWindow);
            (<Calendar>this.object).time.minutesInHour = <number>getNumericInputValue("#falloutMawCalendarMinutesInHour", 60, false, this.appWindow);
            (<Calendar>this.object).time.secondsInMinute = <number>getNumericInputValue("#falloutMawCalendarSecondsInMinute", 60, false, this.appWindow);
            (<Calendar>this.object).generalSettings.showClock = getCheckBoxInputValue("#falloutMawCalendarShowClock", true, this.appWindow);
            (<Calendar>this.object).time.gameTimeRatio = <number>getNumericInputValue("#falloutMawCalendarGameTimeRatio", 1, true, this.appWindow);
            (<Calendar>this.object).time.updateFrequency = <number>getNumericInputValue("#falloutMawCalendarTimeUpdateFrequency", 1, true, this.appWindow);
            (<Calendar>this.object).time.unifyGameAndClockPause = getCheckBoxInputValue("#falloutMawCalendarUnifyClockWithFoundryPause", false, this.appWindow);

            if ((<Calendar>this.object).time.hoursInDay <= 0) {
                (<Calendar>this.object).time.hoursInDay = 1;
            }
            if ((<Calendar>this.object).time.minutesInHour <= 0) {
                (<Calendar>this.object).time.minutesInHour = 1;
            }
            if ((<Calendar>this.object).time.secondsInMinute <= 0) {
                (<Calendar>this.object).time.secondsInMinute = 1;
            }
            if ((<Calendar>this.object).time.updateFrequency <= 0) {
                (<Calendar>this.object).time.updateFrequency = 1;
            }

            //----------------------------------
            // Calendar: Note Settings
            //----------------------------------
            (<Calendar>this.object).generalSettings.noteDefaultVisibility = getCheckBoxInputValue("#falloutMawCalendarDefaultPlayerVisibility", true, this.appWindow);
            (<Calendar>this.object).generalSettings.postNoteRemindersOnFoundryLoad = getCheckBoxInputValue(
                "#falloutMawCalendarPostNoteRemindersOnFoundryLoad",
                true,
                this.appWindow
            );
            this.appWindow.querySelectorAll(".fallout-maw-calendar-note-settings .fallout-maw-calendar-note-categories .fallout-maw-calendar-row:not(.fallout-maw-calendar-head)").forEach((e) => {
                const index = parseInt((<HTMLElement>e).getAttribute("data-index") || "");
                if (!isNaN(index) && index >= 0 && index < (<Calendar>this.object).noteCategories.length) {
                    (<Calendar>this.object).noteCategories[index].name = getTextInputValue(
                        ".fallout-maw-calendar-note-category-name",
                        GameSettings.Localize("FALLOUTMAW.Calendar.Defaults.NoteCategory"),
                        e
                    );
                    (<Calendar>this.object).noteCategories[index].color = getTextInputValue(".fallout-maw-calendar-note-category-color", "#b13737", e);
                    (<Calendar>this.object).noteCategories[index].textColor = GetContrastColor((<Calendar>this.object).noteCategories[index].color);
                }
            });
        }
    }

    /**
     * Update the configuration dialog based on data in the calendar
     * @private
     */
    private updateUIFromObject() {
        if (this.appWindow) {
            //----------------------------------
            // Calendar Config: Display Options
            //----------------------------------
            const currDate = (<Calendar>this.object).getCurrentDate();
            this.uiElementStates.dateFormatExample = FormatDateTime(
                { year: currDate.year, month: currDate.month, day: currDate.day, hour: 13, minute: 36, seconds: 42 },
                (<Calendar>this.object).generalSettings.dateFormat.date,
                <Calendar>this.object
            );
            this.uiElementStates.timeFormatExample = FormatDateTime(
                { year: currDate.year, month: currDate.month, day: currDate.day, hour: 13, minute: 36, seconds: 42 },
                (<Calendar>this.object).generalSettings.dateFormat.time,
                <Calendar>this.object
            );
            this.uiElementStates.monthYearFormatExample = FormatDateTime(
                { year: currDate.year, month: currDate.month, day: currDate.day, hour: 13, minute: 36, seconds: 42 },
                (<Calendar>this.object).generalSettings.dateFormat.monthYear,
                <Calendar>this.object
            );
            this.uiElementStates.chatFormatExample = FormatDateTime(
                { year: currDate.year, month: currDate.month, day: currDate.day, hour: 13, minute: 36, seconds: 42 },
                (<Calendar>this.object).generalSettings.dateFormat.chatTime,
                <Calendar>this.object
            );

            let df = this.appWindow.querySelector(`#falloutMawCalendarDateFormatsDate`)?.closest(".form-group")?.querySelector(".fallout-maw-calendar-example");
            if (df) {
                (<HTMLElement>df).innerHTML = `<strong>${GameSettings.Localize("FALLOUTMAW.Calendar.Example")}</strong>: ${this.uiElementStates.dateFormatExample}`;
            }
            df = this.appWindow.querySelector(`#falloutMawCalendarDateFormatsTime`)?.closest(".form-group")?.querySelector(".fallout-maw-calendar-example");
            if (df) {
                (<HTMLElement>df).innerHTML = `<strong>${GameSettings.Localize("FALLOUTMAW.Calendar.Example")}</strong>: ${this.uiElementStates.timeFormatExample}`;
            }
            df = this.appWindow.querySelector(`#falloutMawCalendarDateFormatsMonthYear`)?.closest(".form-group")?.querySelector(".fallout-maw-calendar-example");
            if (df) {
                (<HTMLElement>df).innerHTML = `<strong>${GameSettings.Localize("FALLOUTMAW.Calendar.Example")}</strong>: ${
                    this.uiElementStates.monthYearFormatExample
                }`;
            }
            df = this.appWindow.querySelector(`#falloutMawCalendarDateFormatsChatTime`)?.closest(".form-group")?.querySelector(".fallout-maw-calendar-example");
            if (df) {
                (<HTMLElement>df).innerHTML = `<strong>${GameSettings.Localize("FALLOUTMAW.Calendar.Example")}</strong>: ${this.uiElementStates.chatFormatExample}`;
            }
            //----------------------------------
            // Calendar Config: Year
            //----------------------------------
            animateFormGroup("#falloutMawCalendarYearNamesStart", (<Calendar>this.object).year.yearNamingRule !== YearNamingRules.Random);

            //----------------------------------
            // Calendar Config: Month
            //----------------------------------
            for (let i = 0; i < (<Calendar>this.object).months.length; i++) {
                const row = this.appWindow.querySelector(`.fallout-maw-calendar-month-settings .fallout-maw-calendar-months>.fallout-maw-calendar-row[data-index="${i}"]`);
                if (row) {
                    this.showAdvancedSection(row, (<Calendar>this.object).months[i].showAdvanced);
                    //Intercalary Stuff
                    animateFormGroup(".fallout-maw-calendar-month-intercalary-include", (<Calendar>this.object).months[i].intercalary, row);

                    //Month Number
                    const mn = row.querySelector(".fallout-maw-calendar-month-number");
                    if (mn) {
                        (<HTMLElement>mn).innerText =
                            (<Calendar>this.object).months[i].numericRepresentation < 0
                                ? "IC"
                                : (<Calendar>this.object).months[i].numericRepresentation.toString();
                    }
                }
            }
            //----------------------------------
            // Calendar Config: Weekday
            //----------------------------------
            for (let i = 0; i < (<Calendar>this.object).weekdays.length; i++) {
                const row = this.appWindow.querySelector(`.fallout-maw-calendar-weekday-settings .fallout-maw-calendar-weekdays>.fallout-maw-calendar-row[data-index="${i}"]`);
                if (row) {
                    this.showAdvancedSection(row, (<Calendar>this.object).weekdays[i].showAdvanced);
                }
            }

            //----------------------------------
            // Calendar Config: Leap Year
            //----------------------------------
            animateFormGroup("#falloutMawCalendarLeapYearCustomMod", (<Calendar>this.object).year.leapYearRule.rule === LeapYearRules.Custom);
            const fg = this.appWindow.querySelector("#falloutMawCalendarLeapYearMonthList");
            if (fg) {
                if (
                    (fg.classList.contains("fallout-maw-calendar-closed") && (<Calendar>this.object).year.leapYearRule.rule !== LeapYearRules.None) ||
                    (fg.classList.contains("fallout-maw-calendar-open") && (<Calendar>this.object).year.leapYearRule.rule === LeapYearRules.None)
                ) {
                    animateElement(fg, 400);
                } else if ((<Calendar>this.object).year.leapYearRule.rule !== LeapYearRules.None) {
                    fg.classList.remove("fallout-maw-calendar-closed");
                    fg.classList.add("fallout-maw-calendar-open");
                } else {
                    fg.classList.add("fallout-maw-calendar-closed");
                    fg.classList.remove("fallout-maw-calendar-open");
                }
            }
            //----------------------------------
            // Calendar Config: Seasons
            //----------------------------------
            for (let i = 0; i < (<Calendar>this.object).seasons.length; i++) {
                const row = this.appWindow.querySelector(`.fallout-maw-calendar-season-settings .fallout-maw-calendar-seasons>.fallout-maw-calendar-row[data-index="${i}"]`);
                if (row) {
                    this.showAdvancedSection(row, (<Calendar>this.object).seasons[i].showAdvanced);
                }
            }

            //----------------------------------
            // Calendar Config: Moons
            //----------------------------------
            for (let i = 0; i < (<Calendar>this.object).moons.length; i++) {
                const row = this.appWindow.querySelector(`.fallout-maw-calendar-moon-settings .fallout-maw-calendar-moons>.fallout-maw-calendar-row[data-index="${i}"]`);
                if (row) {
                    animateFormGroup(".fallout-maw-calendar-moon-year", (<Calendar>this.object).moons[i].firstNewMoon.yearReset === MoonYearResetOptions.None, row);
                    animateFormGroup(
                        ".fallout-maw-calendar-moon-year-x",
                        (<Calendar>this.object).moons[i].firstNewMoon.yearReset === MoonYearResetOptions.XYears,
                        row
                    );
                    for (let p = 0; p < (<Calendar>this.object).moons[i].phases.length; p++) {
                        const pl = row.querySelector(`.fallout-maw-calendar-phases>.fallout-maw-calendar-row[data-index="${p}"] .fallout-maw-calendar-moon-phase-length`);
                        if (pl) {
                            (<HTMLElement>pl).innerText = `${(<Calendar>this.object).moons[i].phases[p].length} ${GameSettings.Localize("FALLOUTMAW.Calendar.Days")}`;
                        }
                    }
                }
            }
        }
    }

    private showAdvancedSection(row: Element, showAdvanced: boolean) {
        //Show Advanced Stuff
        const button = row.querySelector(".fallout-maw-calendar-show-advanced");
        const options = row.querySelector(".fallout-maw-calendar-options");
        if (button && options) {
            if ((options.classList.contains("fallout-maw-calendar-closed") && showAdvanced) || (options.classList.contains("fallout-maw-calendar-open") && !showAdvanced)) {
                animateElement(options, 400);
            }
            if (showAdvanced) {
                (<HTMLElement>button).innerHTML = `<i class="fa fa-chevron-up"></i><span>${GameSettings.Localize("FALLOUTMAW.Calendar.HideAdvanced")}</span>`;
            } else {
                (<HTMLElement>button).innerHTML = `<i class="fa fa-chevron-down"></i><span>${GameSettings.Localize("FALLOUTMAW.Calendar.ShowAdvanced")}</span>`;
            }
        }
    }

    /**
     * When the date format table header is clicked, will expand/collapse the table of information
     */
    private dateFormatTableClick() {
        this.uiElementStates.dateFormatTableExpanded = !this.uiElementStates.dateFormatTableExpanded;
        if (this.appWindow) {
            const collapseArea = this.appWindow.querySelector(`.fallout-maw-calendar-display-options .fallout-maw-calendar-tokens .fallout-maw-calendar-collapse-data`);
            if (collapseArea) {
                (<HTMLElement>collapseArea).style.display = this.uiElementStates.dateFormatTableExpanded ? "block" : "none";
            }
            const a = this.appWindow.querySelector(`.fallout-maw-calendar-display-options .fallout-maw-calendar-tokens .fallout-maw-calendar-date-format-token-show .fa`);
            if (a) {
                (<HTMLElement>a).className = `fa ${this.uiElementStates.dateFormatTableExpanded ? "fa-chevron-up" : "fa-chevron-down"}`;
            }
        }
    }

    /**
     * Looks at all the months and updates their numeric representation depending on if they are intercalary or not
     */
    public rebaseMonthNumbers() {
        let lastMonthNumber = 0;
        let icMonths = 0;
        for (let i = 0; i < (<Calendar>this.object).months.length; i++) {
            const month = (<Calendar>this.object).months[i];
            if (month.intercalary) {
                icMonths++;
                month.numericRepresentation = -1 * icMonths;
            } else {
                month.numericRepresentation = lastMonthNumber + 1;
                lastMonthNumber = month.numericRepresentation;
            }
        }
    }

    /**
     * Adds to the specified table.
     * @param {Event} e The click event
     */
    public addToTable(e: Event) {
        e.preventDefault();
        const target = <HTMLElement>e.currentTarget;
        if (target) {
            const filteredSetting = target.getAttribute("data-type");
            switch (filteredSetting) {
                case "month":
                    (<Calendar>this.object).months.push(
                        new Month(GameSettings.Localize("FALLOUTMAW.Calendar.Defaults.Month"), (<Calendar>this.object).months.length + 1, 0, 30)
                    );
                    this.rebaseMonthNumbers();
                    break;
                case "weekday":
                    (<Calendar>this.object).weekdays.push(
                        new Weekday((<Calendar>this.object).weekdays.length + 1, GameSettings.Localize("FALLOUTMAW.Calendar.Defaults.Weekday"))
                    );
                    break;
                case "season":
                    (<Calendar>this.object).seasons.push(new Season(GameSettings.Localize("FALLOUTMAW.Calendar.Defaults.Season"), 1, 1));
                    break;
                case "moon": {
                    const newMoon = new Moon(GameSettings.Localize("FALLOUTMAW.Calendar.Defaults.Moon"), 29.53059);
                    newMoon.firstNewMoon = {
                        yearReset: MoonYearResetOptions.None,
                        yearX: 0,
                        year: 0,
                        month: 1,
                        day: 1
                    };
                    const phaseLength = Number(((newMoon.cycleLength - 4) / 4).toPrecision(5));
                    newMoon.phases = [
                        {
                            name: GameSettings.Localize("FALLOUTMAW.Calendar.Moon.Phase.New"),
                            length: 1,
                            icon: Icons.NewMoon,
                            singleDay: true,
                            illumination: defaultMoonPhaseIllumination(Icons.NewMoon)
                        },
                        {
                            name: GameSettings.Localize("FALLOUTMAW.Calendar.Moon.Phase.WaxingCrescent"),
                            length: phaseLength,
                            icon: Icons.WaxingCrescent,
                            singleDay: false,
                            illumination: defaultMoonPhaseIllumination(Icons.WaxingCrescent)
                        },
                        {
                            name: GameSettings.Localize("FALLOUTMAW.Calendar.Moon.Phase.FirstQuarter"),
                            length: 1,
                            icon: Icons.FirstQuarter,
                            singleDay: true,
                            illumination: defaultMoonPhaseIllumination(Icons.FirstQuarter)
                        },
                        {
                            name: GameSettings.Localize("FALLOUTMAW.Calendar.Moon.Phase.WaxingGibbous"),
                            length: phaseLength,
                            icon: Icons.WaxingGibbous,
                            singleDay: false,
                            illumination: defaultMoonPhaseIllumination(Icons.WaxingGibbous)
                        },
                        {
                            name: GameSettings.Localize("FALLOUTMAW.Calendar.Moon.Phase.Full"),
                            length: 1,
                            icon: Icons.Full,
                            singleDay: true,
                            illumination: defaultMoonPhaseIllumination(Icons.Full)
                        },
                        {
                            name: GameSettings.Localize("FALLOUTMAW.Calendar.Moon.Phase.WaningGibbous"),
                            length: phaseLength,
                            icon: Icons.WaningGibbous,
                            singleDay: false,
                            illumination: defaultMoonPhaseIllumination(Icons.WaningGibbous)
                        },
                        {
                            name: GameSettings.Localize("FALLOUTMAW.Calendar.Moon.Phase.LastQuarter"),
                            length: 1,
                            icon: Icons.LastQuarter,
                            singleDay: true,
                            illumination: defaultMoonPhaseIllumination(Icons.LastQuarter)
                        },
                        {
                            name: GameSettings.Localize("FALLOUTMAW.Calendar.Moon.Phase.WaningCrescent"),
                            length: phaseLength,
                            icon: Icons.WaningCrescent,
                            singleDay: false,
                            illumination: defaultMoonPhaseIllumination(Icons.WaningCrescent)
                        }
                    ];
                    (<Calendar>this.object).moons.push(newMoon);
                    break;
                }
                case "moon-phase": {
                    const dataMoonIndex = (<HTMLElement>e.currentTarget).getAttribute("data-moon-index");
                    if (dataMoonIndex) {
                        const moonIndex = parseInt(dataMoonIndex);
                        if (!isNaN(moonIndex) && moonIndex < (<Calendar>this.object).moons.length) {
                            (<Calendar>this.object).moons[moonIndex].phases.push({
                                name: GameSettings.Localize("FALLOUTMAW.Calendar.Defaults.MoonPhase"),
                                length: 1,
                                icon: Icons.NewMoon,
                                singleDay: false,
                                illumination: defaultMoonPhaseIllumination(Icons.NewMoon)
                            });
                            (<Calendar>this.object).moons[moonIndex].updatePhaseLength();
                        }
                    }
                    break;
                }
                case "year-name":
                    (<Calendar>this.object).year.yearNames.push(GameSettings.Localize("FALLOUTMAW.Calendar.Defaults.NamedYear"));
                    break;
                case "note-category":
                    (<Calendar>this.object).noteCategories.push({
                        id: generateUniqueId(),
                        name: GameSettings.Localize("FALLOUTMAW.Calendar.Defaults.NoteCategory"),
                        color: "#b13737 ",
                        textColor: "#ffffff"
                    });
                    break;
                default:
                    break;
            }
            this.updateApp();
        }
    }

    /**
     * Removes one or more row from the specified table.
     * @param {Event} e The click event
     */
    public removeFromTable(e: Event) {
        e.preventDefault();
        const target = <HTMLElement>e.currentTarget;
        if (target) {
            const filteredSetting = target.getAttribute("data-type");
            const row = target.closest(".fallout-maw-calendar-row");
            const dataIndex = target.getAttribute("data-index");
            if (row && !dataIndex) {
                const rowDataIndex = (<HTMLElement>row).getAttribute("data-index");
                if (rowDataIndex) {
                    const index = parseInt(rowDataIndex);
                    if (!isNaN(index)) {
                        switch (filteredSetting) {
                            case "month":
                                if (index < (<Calendar>this.object).months.length) {
                                    (<Calendar>this.object).months.splice(index, 1);
                                    if ((<Calendar>this.object).months.length === 0) {
                                        (<Calendar>this.object).months.push(
                                            new Month(GameSettings.Localize("FALLOUTMAW.Calendar.Defaults.Month"), 1, 0, 30)
                                        );
                                    }
                                    //Reindex the remaining months
                                    for (let i = 0; i < (<Calendar>this.object).months.length; i++) {
                                        (<Calendar>this.object).months[i].numericRepresentation = i + 1;
                                    }
                                    this.rebaseMonthNumbers();
                                }
                                break;
                            case "weekday":
                                if (index < (<Calendar>this.object).weekdays.length) {
                                    (<Calendar>this.object).weekdays.splice(index, 1);
                                    //Reindex the remaining months
                                    for (let i = 0; i < (<Calendar>this.object).weekdays.length; i++) {
                                        (<Calendar>this.object).weekdays[i].numericRepresentation = i + 1;
                                    }
                                }
                                break;
                            case "season":
                                if (index < (<Calendar>this.object).seasons.length) {
                                    (<Calendar>this.object).seasons.splice(index, 1);
                                }
                                break;
                            case "moon":
                                if (index < (<Calendar>this.object).moons.length) {
                                    (<Calendar>this.object).moons.splice(index, 1);
                                }
                                break;
                            case "moon-phase": {
                                const dataMoonIndex = target.getAttribute("data-moon-index");
                                if (dataMoonIndex) {
                                    const moonIndex = parseInt(dataMoonIndex);
                                    if (
                                        !isNaN(moonIndex) &&
                                        moonIndex < (<Calendar>this.object).moons.length &&
                                        index < (<Calendar>this.object).moons[moonIndex].phases.length
                                    ) {
                                        (<Calendar>this.object).moons[moonIndex].phases.splice(index, 1);
                                        (<Calendar>this.object).moons[moonIndex].updatePhaseLength();
                                    }
                                }
                                break;
                            }
                            case "year-name":
                                if (index < (<Calendar>this.object).year.yearNames.length) {
                                    (<Calendar>this.object).year.yearNames.splice(index, 1);
                                }
                                break;
                            case "note-category":
                                if (index < (<Calendar>this.object).noteCategories.length) {
                                    {
                                        (<Calendar>this.object).noteCategories.splice(index, 1);
                                    }
                                }
                                break;
                            default:
                                break;
                        }
                        this.updateApp();
                    }
                }
            } else if (dataIndex && dataIndex === "all") {
                switch (filteredSetting) {
                    case "month":
                        (<Calendar>this.object).months = [new Month(GameSettings.Localize("FALLOUTMAW.Calendar.Defaults.Month"), 1, 0, 30)];
                        break;
                    case "weekday":
                        (<Calendar>this.object).weekdays = [];
                        break;
                    case "season":
                        (<Calendar>this.object).seasons = [];
                        break;
                    case "moon":
                        (<Calendar>this.object).moons = [];
                        break;
                    case "moon-phase": {
                        const dataMoonIndex = (<HTMLElement>e.currentTarget).getAttribute("data-moon-index");
                        if (dataMoonIndex) {
                            const moonIndex = parseInt(dataMoonIndex);
                            if (!isNaN(moonIndex) && moonIndex < (<Calendar>this.object).moons.length) {
                                (<Calendar>this.object).moons[moonIndex].phases = [];
                            }
                        }
                        break;
                    }
                    case "year-name":
                        (<Calendar>this.object).year.yearNames = [];
                        break;
                    case "note-category":
                        (<Calendar>this.object).noteCategories = [];
                        break;
                    default:
                        break;
                }
                this.updateApp();
            }
        }
    }

    /**
     * Function called when ever a date selector in the configuration dialog is changed.
     * @param itemId The ID of the item changed
     * @param dateSelectorType The type of date selector that was changed
     * @param selectedDate The returned data from the date selector
     */
    public dateSelectorChange(
        itemId: string,
        dateSelectorType: ConfigurationDateSelectors,
        selectedDate: FalloutMaWCalendar.DateTimeSelector.SelectedDates
    ) {
        if (dateSelectorType === ConfigurationDateSelectors.seasonStartingDate) {
            const season = (<Calendar>this.object).seasons.find((s) => {
                return s.id === itemId;
            });
            if (season) {
                const sMonthIndex = !selectedDate.startDate.month || selectedDate.startDate.month < 0 ? 0 : selectedDate.startDate.month;
                const sDayIndex = !selectedDate.startDate.day || selectedDate.startDate.day < 0 ? 0 : selectedDate.startDate.day;
                season.startingMonth = sMonthIndex;
                season.startingDay = sDayIndex;
            }
        } else if (dateSelectorType === ConfigurationDateSelectors.seasonSunriseSunsetTime) {
            const season = (<Calendar>this.object).seasons.find((s) => {
                return s.id === itemId;
            });
            if (season) {
                const activeCalendar = CalManager.getActiveCalendar();
                season.sunriseTime =
                    (selectedDate.startDate.hour || 0) * activeCalendar.time.minutesInHour * activeCalendar.time.secondsInMinute +
                    (selectedDate.startDate.minute || 0) * activeCalendar.time.secondsInMinute;
                season.sunsetTime =
                    (selectedDate.endDate.hour || 0) * activeCalendar.time.minutesInHour * activeCalendar.time.secondsInMinute +
                    (selectedDate.endDate.minute || 0) * activeCalendar.time.secondsInMinute;
            }
        } else if (dateSelectorType === ConfigurationDateSelectors.moonFirstNewMoonDate) {
            const moon = (<Calendar>this.object).moons.find((m) => {
                return m.id === itemId;
            });
            if (moon) {
                moon.firstNewMoon.month = !selectedDate.startDate.month || selectedDate.startDate.month < 0 ? 0 : selectedDate.startDate.month;
                moon.firstNewMoon.day = !selectedDate.startDate.day || selectedDate.startDate.day < 0 ? 0 : selectedDate.startDate.day;
            }
        }
    }

    /**
     * Updates the month object to ensure the number of day objects it has matches any change values
     * @param {Month} month The month to check
     */
    public updateMonthDays(month: Month) {
        //Check to see if the number of days is less than 0 and set it to 0
        if (month.numberOfDays < 0) {
            month.numberOfDays = 0;
        }
        //Check if the leap year days was set to less than 0 and set it to equal the number of days
        if (month.numberOfLeapYearDays < 0) {
            month.numberOfLeapYearDays = month.numberOfDays;
        }
        //The number of day objects to create
        const daysShouldBe = month.numberOfLeapYearDays > month.numberOfDays ? month.numberOfLeapYearDays : month.numberOfDays;
        const monthCurrentDay = month.getDay();
        let currentDay = null;
        if (monthCurrentDay) {
            if (monthCurrentDay.numericRepresentation >= month.numberOfDays) {
                currentDay = 1;
            } else {
                currentDay = monthCurrentDay.numericRepresentation;
            }
        }
        month.days = [];
        month.populateDays(daysShouldBe, currentDay);
    }

    /**
     * Shows a confirmation dialog to the user to confirm that they want to do the action they chose
     * @param {string} dialogType
     * @param {string} contentType
     * @param {*} args
     */
    public confirmationDialog(dialogType: string, contentType: string, args: any) {
        let title = "",
            content = "";
        if (dialogType === "overwrite") {
            title = GameSettings.Localize("FALLOUTMAW.Calendar.ApplyPredefined");
            content = GameSettings.Localize("FALLOUTMAW.Calendar.ApplyPredefinedText").replace("${CAL_NAME}", args["name"]);
        } else if (dialogType === "remove-calendar") {
            title = GameSettings.Localize("FALLOUTMAW.Calendar.RemoveCalendar");
            content = GameSettings.Localize("FALLOUTMAW.Calendar.RemoveCalendarConfirmText").replace("${CAL_NAME}", args["name"]);
        }
        const dialog = new Dialog({
            title: title,
            content: content,
            buttons: {
                yes: {
                    icon: '<i class="fas fa-check"></i>',
                    label: GameSettings.Localize("FALLOUTMAW.Calendar.Confirm"),
                    callback: this.confirmationDialogYes.bind(this, contentType, args)
                },
                no: {
                    icon: '<i class="fas fa-times"></i>',
                    label: GameSettings.Localize("FALLOUTMAW.Calendar.Cancel")
                }
            },
            default: "no"
        });
        dialog.render(true);
    }

    /**
     * Based on the passed in types calls the correct functionality
     * @param {string} contentType The type of action being preformed
     * @param {*} args The sub type of the above type
     */
    public async confirmationDialogYes(contentType: string, args: any) {
        if (contentType === "predefined") {
            this.quickSetupNextConfirm();
        } else if (contentType === "remove-calendar") {
            this.removeCalendarConfirm(args);
        }
    }

    /**
     * When the save button is clicked, apply those changes to the game settings and re-load the calendars across all players
     * @param close If to close the dialog after save
     * @param e The click event
     */
    public async saveClick(close: boolean, e: Event) {
        e.preventDefault();
        await this.save(close);
    }

    /**
     * Saves the current settings
     * @param close If to close the application window after saving
     * @param updateFromForm If to update the data model from the form content
     */
    public async save(close: boolean, updateFromForm: boolean = true) {
        if (updateFromForm) {
            this.writeInputValuesToObjects();
        }
        if (GameSettings.IsGm()) {
            CalManager.mergeClonedCalendars();
            await SC.save(this.globalConfiguration, this.clientSettings);
            await CalManager.getActiveCalendar().syncTime(true);
            Hook.emit(FalloutMaWCalendarHooks.ConfigurationChange, CalManager.getActiveCalendar());
        } else {
            SC.save(null, this.clientSettings);
        }

        if (close) {
            this.closeApp();
        } else {
            this.calendars = CalManager.cloneCalendars();
            this.object = this.calendars[0];
            this.updateApp();
        }
    }

    /**
     * Exports the current calendar configuration to a JSON file. Users should be prompted with a save as dialog.
     * @param event
     */
    public exportCalendar(event: Event) {
        event.preventDefault();

        const options: Record<string, boolean> = {};
        this.appWindow?.querySelectorAll(`.fallout-maw-calendar-import-export .fallout-maw-calendar-calendar-list input`).forEach((e) => {
            const id = e.getAttribute("data-id");
            if (id) {
                options[id] = (<HTMLInputElement>e).checked;
            }
        });
        const data = {
            exportVersion: 2,
            globalConfig: options["global"]
                ? {
                      secondsInCombatRound: this.globalConfiguration.secondsInCombatRound,
                      calendarsSameTimestamp: this.globalConfiguration.calendarsSameTimestamp,
                      syncCalendars: this.globalConfiguration.syncCalendars,
                      showNotesFolder: this.globalConfiguration.showNotesFolder
                  }
                : {},
            permissions: options["permissions"] ? this.globalConfiguration.permissions.toConfig() : {},
            calendars: <FalloutMaWCalendar.CalendarData[]>[],
            notes: <Record<string, any[]>>{}
        };

        for (let i = 0; i < this.calendars.length; i++) {
            const config = this.calendars[i].toConfig();
            const realId = config.id.replace("_temp", "");

            if (options[`${config.id}-notes`]) {
                data.notes[realId] = [];
                (<Game>game).journal?.forEach((j) => {
                    const falloutMawCalendarFlag = <FalloutMaWCalendar.NoteData>j.getFlag(ModuleName, "noteData");
                    if (falloutMawCalendarFlag && falloutMawCalendarFlag.calendarId && falloutMawCalendarFlag.calendarId === realId) {
                        data.notes[realId].push(j.toObject());
                    }
                });
            }

            if (options[config.id]) {
                config.id = realId;
                data.calendars.push(config);
            }
        }
        saveAs(new Blob([JSON.stringify(data)], { type: "application/json" }), "fallout-maw-calendar-export.json");
    }

    /**
     * Called when a file is selected in the input file picker
     * @param event
     */
    public importCalendarFileChange(event: Event) {
        const target = <HTMLInputElement>event.target;
        if (target && target.files && target.files.length) {
            if (target.files[0].type === "application/json") {
                this.appWindow?.querySelector(`.fallout-maw-calendar-import-export .fallout-maw-calendar-progress`)?.classList.remove("fallout-maw-calendar-hide");
                const reader = new FileReader();
                reader.onprogress = this.importCalendarProgress.bind(this);
                reader.onload = this.importCalendarRead.bind(this);
                reader.readAsText(target.files[0]);
            }
        }
    }

    /**
     * Resize the progress bar to show how much of the file has been loaded in. 99% of cases this will never actually show lol
     * @param e
     */
    public importCalendarProgress(e: Event) {
        const bar = this.appWindow?.querySelector(`.fallout-maw-calendar-import-export .fallout-maw-calendar-progress .fallout-maw-calendar-progress-bar`);
        if (bar) {
            (<HTMLElement>bar).style.width = `${((<ProgressEvent>e).loaded / (<ProgressEvent>e).total) * 100}%`;
        }
    }

    /**
     * Called when a file has finished being read.
     * @param e
     */
    public importCalendarRead(e: Event) {
        this.importCalendarProgress(e);
        this.appWindow?.querySelector(`.fallout-maw-calendar-import-export .fallout-maw-calendar-progress`)?.classList.add("fallout-maw-calendar-hide");
        const reader = <FileReader>e.target;
        if (reader && reader.result && this.appWindow) {
            const fDetail = this.appWindow.querySelector(".fallout-maw-calendar-import-export .fallout-maw-calendar-importing .fallout-maw-calendar-file-details");
            if (fDetail) {
                let html = `<p>${GameSettings.Localize("FALLOUTMAW.Calendar.Configuration.ImportExport.ImportDetailsText")}</p><ul class="fallout-maw-calendar-calendar-list">`;
                let res: any;
                try {
                    res = JSON.parse(reader.result.toString());
                } catch (_error) {
                    GameSettings.UiNotification(GameSettings.Localize("FALLOUTMAW.Calendar.Importer.InvalidCalendarConfig"), "error");
                    return;
                }
                if (!res || typeof res !== "object" || Array.isArray(res) || res.exportVersion !== 2) {
                    GameSettings.UiNotification(GameSettings.Localize("FALLOUTMAW.Calendar.Importer.InvalidCalendarConfig"), "error");
                    return;
                }
                if (Object.prototype.hasOwnProperty.call(res, "globalConfig") && !isObjectEmpty(res.globalConfig)) {
                    html += `<li><label><input type="checkbox" data-id="global" checked /><span class="fa fa-cog"></span>&nbsp;${GameSettings.Localize(
                        "FALLOUTMAW.Calendar.Configuration.Global.Title"
                    )}</label></li>`;
                }
                if (Object.prototype.hasOwnProperty.call(res, "permissions") && !isObjectEmpty(res.permissions)) {
                    html += `<li><label><input type="checkbox" data-id="permissions" checked /><span class="fa fa-key"></span>&nbsp;${GameSettings.Localize(
                        "Permissions"
                    )}</label></li>`;
                }
                if (Object.prototype.hasOwnProperty.call(res, "calendars") && res.calendars.length) {
                    for (let i = 0; i < res.calendars.length; i++) {
                        html += `<li><label><input type="checkbox" data-id="${
                            res.calendars[i].id
                        }" checked /><strong><span class="fa fa-calendar"></span> ${res.calendars[i].name}</strong>: ${GameSettings.Localize(
                            "FALLOUTMAW.Calendar.CalendarConfiguration"
                        )}</label><label>${GameSettings.Localize("FALLOUTMAW.Calendar.ImportInto")}:&nbsp;<select data-for-cal="${res.calendars[i].id}">`;
                        const selectedIndex = this.calendars.findIndex((c) => {
                            return c.id.indexOf(res.calendars[i].id) === 0;
                        });
                        html += `<option value="new" ${selectedIndex === -1 ? "selected" : ""}>${GameSettings.Localize("FALLOUTMAW.Calendar.NewCalendar")}</option>`;
                        for (let i = 0; i < this.calendars.length; i++) {
                            html += `<option value="${this.calendars[i].id}" ${selectedIndex === i ? "selected" : ""}>${
                                this.calendars[i].name
                            }</option>`;
                        }
                        html += `</select></label></li>`;
                        if (
                            Object.prototype.hasOwnProperty.call(res, "notes") &&
                            Object.prototype.hasOwnProperty.call(res.notes, res.calendars[i].id)
                        ) {
                            html += `<li><label><input type="checkbox" data-id="${
                                res.calendars[i].id
                            }-notes" checked /><strong><span class="fa fa-sticky-note"></span> ${
                                res.calendars[i].name
                            }</strong>: ${GameSettings.Localize("FALLOUTMAW.Calendar.CalendarNotes")}</label></label></li>`;
                        }
                    }
                }
                if (Object.hasOwn(res, "notes")) {
                    for (const key in res.notes) {
                        if (Object.hasOwn(res.notes, key)) {
                            html += `<li><label><input type="checkbox" data-id="${key}-notes" checked /><strong><span class="fa fa-sticky-note"></span> ${
                                this.calendars.find((c) => {
                                    return c.id.indexOf(key) === 0;
                                })?.name || key
                            }</strong>: ${GameSettings.Localize("FALLOUTMAW.Calendar.CalendarNotes")}</label></label>`;

                            html += `<label>${GameSettings.Localize("FALLOUTMAW.Calendar.ImportInto")}:&nbsp;<select data-for-cal="${key}">`;
                            const selectedIndex = this.calendars.findIndex((c) => {
                                return c.id.indexOf(key) === 0;
                            });
                            //html += `<option value="new" ${selectedIndex === -1 ? "selected" : ""}>${GameSettings.Localize("FALLOUTMAW.Calendar.SameAsCalendarConfig")}</option>`;
                            for (let i = 0; i < this.calendars.length; i++) {
                                html += `<option value="${this.calendars[i].id}" ${selectedIndex === i ? "selected" : ""}>${
                                    this.calendars[i].name
                                }</option>`;
                            }
                            html += `</select></label></li>`;
                        }
                    }
                }
                html += `</ul><button class="fallout-maw-calendar-control fallout-maw-calendar-save" id="importCalendar"><i class="fa fa-file-import"></i> ${GameSettings.Localize(
                    "FALLOUTMAW.Calendar.Import"
                )}</button>`;
                fDetail.innerHTML = html;
                fDetail.querySelector("#importCalendar")?.addEventListener("click", this.importCalendarSave.bind(this, res));
            }
        }
    }

    /**
     * Saves the data from the file into the selected calendars
     * @param data
     * @param event
     */
    public async importCalendarSave(data: any, event: Event) {
        event.preventDefault();
        if (this.appWindow) {
            if (
                Object.prototype.hasOwnProperty.call(data, "globalConfig") &&
                !isObjectEmpty(data.globalConfig) &&
                getCheckBoxInputValue('.fallout-maw-calendar-import-export .fallout-maw-calendar-importing .fallout-maw-calendar-file-details input[data-id="global"]', true, this.appWindow)
            ) {
                this.globalConfiguration.secondsInCombatRound = data.globalConfig.secondsInCombatRound;
                this.globalConfiguration.calendarsSameTimestamp = data.globalConfig.calendarsSameTimestamp;
                this.globalConfiguration.syncCalendars = data.globalConfig.syncCalendars;
                this.globalConfiguration.showNotesFolder = data.globalConfig.showNotesFolder;
            }
            if (
                Object.prototype.hasOwnProperty.call(data, "permissions") &&
                !isObjectEmpty(data.permissions) &&
                getCheckBoxInputValue('.fallout-maw-calendar-import-export .fallout-maw-calendar-importing .fallout-maw-calendar-file-details input[data-id="permissions"]', true, this.appWindow)
            ) {
                this.globalConfiguration.permissions.loadFromSettings(data.permissions);
            }
            const idLookupTable: Record<string, string> = {};
            if (Object.prototype.hasOwnProperty.call(data, "calendars") && data.calendars.length) {
                //Ensure that the note directory exists and is correct
                await NManager.createJournalDirectory();
                for (let i = 0; i < data.calendars.length; i++) {
                    if (
                        getCheckBoxInputValue(
                            `.fallout-maw-calendar-import-export .fallout-maw-calendar-importing .fallout-maw-calendar-file-details input[data-id="${data.calendars[i].id}"]`,
                            true,
                            this.appWindow
                        )
                    ) {
                        const importInto = getTextInputValue(
                            `.fallout-maw-calendar-import-export .fallout-maw-calendar-importing .fallout-maw-calendar-file-details select[data-for-cal="${data.calendars[i].id}"]`,
                            "new",
                            this.appWindow
                        );
                        const importCalendar = this.calendars.find((c) => {
                            return c.id === importInto;
                        });
                        // Record the original id just in case we need to look it up later
                        const originalId = data.calendars[i].id;
                        delete data.calendars[i].id;
                        if (importCalendar) {
                            importCalendar.loadFromSettings(data.calendars[i]);
                        } else {
                            const newCalendar = CalManager.addTempCalendar(data.calendars[i].name);
                            newCalendar.loadFromSettings(data.calendars[i]);
                            this.calendars.push(newCalendar);
                            // map the old and new IDs so that notes can be mapped to the correct calendar later.
                            idLookupTable[originalId] = newCalendar.id;
                        }
                    }
                }
            }
            // Always check for imported notes regardless of if we are importing calendars. Fix Issue GH-30
            if (Object.prototype.hasOwnProperty.call(data, "notes")) {
                await NManager.createJournalDirectory();
                for (const noteName of Object.keys(data.notes)) {
                    const calId = noteName;
                    // Do not import the notes if the user did not check the box
                    if (
                        !getCheckBoxInputValue(
                            `.fallout-maw-calendar-import-export .fallout-maw-calendar-importing .fallout-maw-calendar-file-details input[data-id="${calId}-notes"]`,
                            true,
                            this.appWindow
                        )
                    )
                        continue;
                    let importInto = getTextInputValue(
                        `.fallout-maw-calendar-import-export .fallout-maw-calendar-importing .fallout-maw-calendar-file-details select[data-for-cal="${calId}"]`,
                        calId,
                        this.appWindow
                    ).replace("_temp", ""); // Sometimes will have "_temp" appended, need to normalize (GH-41)
                    // Handle the case where the user wants to import into a new calendar
                    if (importInto === "new") {
                        const mappedCalendarId = idLookupTable[calId];
                        if (!mappedCalendarId) {
                            console.warn(`Skipping notes for ${calId}: no new calendar was created for this import target.`);
                            continue;
                        }
                        importInto = mappedCalendarId.replace("_temp", "");
                        console.log(`Importing notes into new calendar: ${importInto}`);
                    }
                    const importCalendar = this.calendars.find((c) => {
                        return c.id.replace("_temp", "") === importInto;
                    });
                    if (!importCalendar) {
                        console.warn(`No calendar found for import into: ${importInto}`);
                        continue;
                    }
                    for (let n = 0; n < data.notes[calId].length; n++) {
                        const calendarId = (importCalendar?.id || calId).replace("_temp", "");
                        const journalEntryData = data.notes[calId][n];
                        const noteData = journalEntryData.flags[ModuleName]?.noteData;
                        if (noteData) {
                            const noteImportedIntoDifferentCalendar = !(noteData.calendarId === calendarId);
                            journalEntryData.flags[ModuleName].noteData.calendarId = calendarId;
                            journalEntryData.flags.core ??= {};
                            journalEntryData.flags.core.sheetClass = ModuleName + ".NoteSheet";
                            journalEntryData.folder = NManager.noteDirectory?.id;
                            if (noteImportedIntoDifferentCalendar || !(<Game>game).journal?.has(journalEntryData._id)) {
                                // import a note into a new calendar OR create one if it doesn't exist.
                                await JournalEntry.create(journalEntryData, { keepId: !noteImportedIntoDifferentCalendar });
                            } else {
                                // update existing journal entry.
                                (<Game>game).journal?.get(journalEntryData._id)?.update(journalEntryData);
                            }
                        }
                    }
                }
            }
            this._tabs[0].active = "generalSettings";
            this.save(false, false).catch(Logger.error);
        }
    }
}
