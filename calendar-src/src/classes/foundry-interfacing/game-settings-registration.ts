import { ModuleName, SettingNames } from "../../constants";
import ConfigurationApp from "../applications/configuration-app";
import { CalManager, SC } from "../index";
import { GameSettings } from "./game-settings";
import SCController from "../s-c-controller";
import { GetThemeList } from "../utilities/visual";
import MainAppConfigWrapper from "../applications/main-app-config-wrapper";

export default class GameSettingsRegistration {
    /**
     * Register the settings this module needs to use with the game
     */
    static Register() {
        // -------------------
        // Client Settings
        // -------------------
        game.settings?.register(ModuleName, `${game.world!.id}.${SettingNames.Theme}`, {
            name: "FALLOUTMAW.Calendar.Configuration.Theme.Title",
            hint: "FALLOUTMAW.Calendar.Configuration.Theme.Description",
            scope: "client",
            config: true,
            type: String,
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            choices: GetThemeList(),
            default: "",
            onChange: SCController.ThemeChange.bind(SCController)
        });
        game.settings?.register(ModuleName, SettingNames.Theme, {
            name: "FALLOUTMAW.Calendar.Configuration.Theme.Title",
            hint: "FALLOUTMAW.Calendar.Configuration.Theme.Description",
            scope: "client",
            config: false,
            type: String,
            default: "dark"
        });
        game.settings?.register(ModuleName, SettingNames.OpenOnLoad, {
            name: "FALLOUTMAW.Calendar.Configuration.Client.OpenOnLoad.Title",
            hint: "FALLOUTMAW.Calendar.Configuration.Client.OpenOnLoad.Description",
            scope: "client",
            config: true,
            type: Boolean,
            default: true
        });
        game.settings?.register(ModuleName, SettingNames.OpenCompact, {
            name: "FALLOUTMAW.Calendar.Configuration.Client.OpenCompact.Title",
            hint: "FALLOUTMAW.Calendar.Configuration.Client.OpenCompact.Description",
            scope: "client",
            config: true,
            type: Boolean,
            default: false
        });
        game.settings?.register(ModuleName, SettingNames.RememberPosition, {
            name: "FALLOUTMAW.Calendar.Configuration.Client.RememberPosition.Title",
            hint: "FALLOUTMAW.Calendar.Configuration.Client.RememberPosition.Description",
            scope: "client",
            config: true,
            type: Boolean,
            default: true
        });
        game.settings?.register(ModuleName, SettingNames.RememberCompactPosition, {
            name: "FALLOUTMAW.Calendar.Configuration.Client.RememberCompactPosition.Title",
            hint: "FALLOUTMAW.Calendar.Configuration.Client.RememberCompactPosition.Description",
            scope: "client",
            config: true,
            type: Boolean,
            default: false
        });
        game.settings?.register(ModuleName, SettingNames.AppPosition, {
            name: "Application Position",
            hint: "",
            scope: "client",
            config: false,
            type: Object,
            default: {}
        });
        game.settings?.register(ModuleName, SettingNames.AppCompactPosition, {
            name: "Application Compact Position",
            hint: "",
            scope: "client",
            config: false,
            type: Object,
            default: {}
        });
        game.settings?.register(ModuleName, SettingNames.NoteReminderNotification, {
            name: "FALLOUTMAW.Calendar.Configuration.Client.NoteReminderNotification.Title",
            hint: "FALLOUTMAW.Calendar.Configuration.Client.NoteReminderNotification.Description",
            scope: "client",
            config: true,
            type: String,
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            choices: {
                whisper: GameSettings.Localize("FALLOUTMAW.Calendar.Configuration.Client.NoteReminderNotification.Whisper"),
                render: GameSettings.Localize("FALLOUTMAW.Calendar.Configuration.Client.NoteReminderNotification.Render")
            },
            default: "whisper"
        });
        game.settings?.register(ModuleName, SettingNames.NoteListOpenDirection, {
            name: "FALLOUTMAW.Calendar.Configuration.Client.NoteListOpenDirection.Title",
            hint: "FALLOUTMAW.Calendar.Configuration.Client.NoteListOpenDirection.Description",
            scope: "client",
            config: true,
            type: String,
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            choices: {
                "fallout-maw-calendar-right": GameSettings.Localize("FALLOUTMAW.Calendar.Right"),
                "fallout-maw-calendar-left": GameSettings.Localize("FALLOUTMAW.Calendar.Left"),
                "fallout-maw-calendar-down": GameSettings.Localize("FALLOUTMAW.Calendar.Down")
            },
            default: "fallout-maw-calendar-right",
            onChange: SCController.SideDrawerDirectionChange.bind(SCController)
        });
        game.settings?.register(ModuleName, SettingNames.AlwaysShowNoteList, {
            name: "FALLOUTMAW.Calendar.Configuration.Client.AlwaysShowNoteList.Title",
            hint: "FALLOUTMAW.Calendar.Configuration.Client.AlwaysShowNoteList.Description",
            scope: "client",
            config: true,
            type: Boolean,
            default: false,
            onChange: SCController.AlwaysShowNoteListChange.bind(SCController)
        });
        game.settings?.register(ModuleName, SettingNames.PersistentOpen, {
            name: "FALLOUTMAW.Calendar.Configuration.Client.PersistentOpen.Title",
            hint: "FALLOUTMAW.Calendar.Configuration.Client.PersistentOpen.Description",
            scope: "client",
            config: true,
            type: Boolean,
            default: false,
            onChange: SC.PersistenceChange.bind(SC)
        });
        game.settings?.register(ModuleName, SettingNames.CompactViewScale, {
            name: "FALLOUTMAW.Calendar.Configuration.Client.CompactViewScale.Title",
            hint: "FALLOUTMAW.Calendar.Configuration.Client.CompactViewScale.Description",
            scope: "client",
            config: true,
            type: Number,
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            range: {
                min: 70,
                max: 200,
                step: 10
            },
            default: 100,
            onChange: SC.CompactScaleChange.bind(SC)
        });

        // -------------------
        // Configuration Button
        // -------------------
        game.settings?.registerMenu(ModuleName, SettingNames.CalendarMainApp, {
            name: "",
            label: "FALLOUTMAW.Calendar.Title",
            hint: "",
            icon: "fa fa-calendar",
            restricted: false,
            type: MainAppConfigWrapper
        });
        game.settings?.registerMenu(ModuleName, SettingNames.CalendarConfigurationMenu, {
            name: "",
            label: "FALLOUTMAW.Calendar.Configuration.Title",
            hint: "",
            icon: "fa fa-cog",
            restricted: false,
            type: ConfigurationApp
        });
        // -------------------
        // Core Settings
        // -------------------
        game.settings?.register(ModuleName, SettingNames.CalendarConfiguration, {
            name: "Calendar Configuration",
            scope: "world",
            config: false,
            type: Array,
            default: [],
            onChange: CalManager.loadCalendars.bind(CalManager)
        });
        game.settings?.register(ModuleName, SettingNames.ActiveCalendar, {
            name: "Active Calendar",
            scope: "world",
            config: false,
            type: String,
            default: "default",
            onChange: CalManager.loadActiveCalendar.bind(CalManager)
        });
        game.settings?.register(ModuleName, SettingNames.GlobalConfiguration, {
            name: "Global Configuration",
            scope: "world",
            config: false,
            type: Object,
            default: {},
            onChange: SC.load.bind(SC)
        });
        game.settings?.register(ModuleName, SettingNames.ClockState, {
            name: "Calendar Clock State",
            scope: "world",
            config: false,
            type: String,
            default: "stopped"
        });
        game.settings?.register(ModuleName, SettingNames.ClockTime, {
            name: "Calendar Clock Time",
            scope: "world",
            config: false,
            type: Object,
            default: {},
            onChange: CalManager.loadClockTimes.bind(CalManager)
        });

    }
}
