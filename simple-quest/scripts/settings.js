import { MODULE_ID, SYSTEM_ID, SYSTEM_PATH } from "./constants.js";
import { TabConfig } from "./app/tabConfig.js";
import { ThemeConfig } from "./app/themeConfig.js";
import { setTTM } from "./app/theaterOfTheMind.js";

const DEFAULT_TAB_NAMES = {
    quests: "simple-quest.simple-quest.tabs.quests",
    map: "simple-quest.simple-quest.tabs.map",
    timeline: "simple-quest.simple-quest.tabs.timeline",
    lore: "simple-quest.simple-quest.tabs.lore",
    achievements: "simple-quest.simple-quest.tabs.achievements",
    "my-journal": "simple-quest.simple-quest.tabs.my-journal",
    "party-journal": "simple-quest.simple-quest.tabs.party-journal",
};

const toSettingKey = (key) => `simpleQuest.${key}`;
const toSettingId = (key) => `${SYSTEM_ID}.${toSettingKey(key)}`;
const SettingsConfig = foundry.applications.settings.SettingsConfig;

const QUEST_SETTING_SECTIONS = [
    {
        id: "general",
        label: `${MODULE_ID}.settings.questMenu.sections.general`,
        keys: ["showHistory", "hideCheckboxAutoHide", "hideFolderFromPlayers"],
    },
    {
        id: "structure",
        label: `${MODULE_ID}.settings.questMenu.sections.structure`,
        keys: ["folderName", "loreFolderName", "mapsJournalName", "timelineJournalName", "achievementsJournalName", "partyJournalName", "sharedJournalName"],
    },
    {
        id: "tabs",
        label: `${MODULE_ID}.settings.questMenu.sections.tabs`,
        menu: "tabConfig",
        keys: ["enableQuests", "enablePartyJournal", "enableMyJournal", "enableMaps", "enableLore", "enableTimeline", "enableAchievements"],
    },
    {
        id: "appearance",
        label: `${MODULE_ID}.settings.questMenu.sections.appearance`,
        menu: "themeConfig",
        keys: ["backgroundColor", "textColor", "secretColor", "failedColor", "labelColor", "invertTheme", "matchJournalStyle", "fontFamily", "headerOnlyFont", "imagePageMask"],
    },
    {
        id: "notifications",
        label: `${MODULE_ID}.settings.questMenu.sections.notifications`,
        keys: ["useMessageTheme", "showQuestNotifications", "newQuestSoundEffect", "updateQuestSoundEffect"],
    },
    {
        id: "access",
        label: `${MODULE_ID}.settings.questMenu.sections.access`,
        keys: ["openJournalPinsAsModals", "matchJournalPermission"],
    },
];

const STRUCTURE_SETTING_KEYS = {
    folderName: "folderName",
    loreFolderName: "loreFolderName",
    mapsJournalName: "mapsJournalName",
    timelineJournalName: "timelineJournalName",
    achievementsJournalName: "achievementsJournalName",
    partyJournalName: "partyJournalName",
    sharedJournalName: "sharedJournalName",
};

export function registerSettings() {
    game.settings.registerMenu(SYSTEM_ID, toSettingKey("questConfig"), {
        name: `${MODULE_ID}.settings.questMenu.name`,
        label: `${MODULE_ID}.settings.questMenu.label`,
        hint: `${MODULE_ID}.settings.questMenu.hint`,
        icon: "fa-solid fa-scroll",
        type: QuestSettingsConfig,
        restricted: true,
    });

    const settings = {
        showHistory: {
            name: `${MODULE_ID}.settings.showHistory.name`,
            hint: `${MODULE_ID}.settings.showHistory.hint`,
            scope: "world",
            config: true,
            type: Boolean,
            default: true,
        },
        hideCheckboxAutoHide: {
            name: `${MODULE_ID}.settings.hideCheckboxAutoHide.name`,
            hint: `${MODULE_ID}.settings.hideCheckboxAutoHide.hint`,
            scope: "world",
            config: true,
            type: Boolean,
            default: false,
        },
        folderName: {
            name: `${MODULE_ID}.settings.folderName.name`,
            hint: `${MODULE_ID}.settings.folderName.hint`,
            scope: "world",
            config: true,
            type: String,
            default: game.i18n.localize(`${MODULE_ID}.settings.folderName.default`),
        },
        loreFolderName: {
            name: `${MODULE_ID}.settings.loreFolderName.name`,
            hint: `${MODULE_ID}.settings.loreFolderName.hint`,
            scope: "world",
            config: true,
            type: String,
            default: game.i18n.localize(`${MODULE_ID}.settings.loreFolderName.default`),
        },
        mapsJournalName: {
            name: `${MODULE_ID}.settings.mapsJournalName.name`,
            hint: `${MODULE_ID}.settings.mapsJournalName.hint`,
            scope: "world",
            config: true,
            type: String,
            default: game.i18n.localize(`${MODULE_ID}.settings.mapsJournalName.default`),
        },
        timelineJournalName: {
            name: `${MODULE_ID}.settings.timelineJournalName.name`,
            hint: `${MODULE_ID}.settings.timelineJournalName.hint`,
            scope: "world",
            config: true,
            type: String,
            default: game.i18n.localize(`${MODULE_ID}.settings.timelineJournalName.default`),
        },
        achievementsJournalName: {
            name: `${MODULE_ID}.settings.achievementsJournalName.name`,
            hint: `${MODULE_ID}.settings.achievementsJournalName.hint`,
            scope: "world",
            config: true,
            type: String,
            default: game.i18n.localize(`${MODULE_ID}.settings.achievementsJournalName.default`),
        },
        partyJournalName: {
            name: `${MODULE_ID}.settings.partyJournalName.name`,
            hint: `${MODULE_ID}.settings.partyJournalName.hint`,
            scope: "world",
            config: true,
            type: String,
            default: game.i18n.localize(`${MODULE_ID}.settings.partyJournalName.default`),
        },
        sharedJournalName: {
            name: `${MODULE_ID}.settings.sharedJournalName.name`,
            hint: `${MODULE_ID}.settings.sharedJournalName.hint`,
            scope: "world",
            config: true,
            type: String,
            default: game.i18n.localize(`${MODULE_ID}.settings.sharedJournalName.default`),
        },
        backgroundColor: {
            name: `${MODULE_ID}.settings.backgroundColor.name`,
            hint: `${MODULE_ID}.settings.backgroundColor.hint`,
            scope: "world",
            config: true,
            type: String,
            default: "#1b130d",
            onChange: () => {
                ui.simpleQuest.updateStyle();
            },
        },
        textColor: {
            name: `${MODULE_ID}.settings.textColor.name`,
            hint: `${MODULE_ID}.settings.textColor.hint`,
            scope: "world",
            config: true,
            type: String,
            default: "#f5deb3",
            onChange: () => {
                ui.simpleQuest.updateStyle();
            },
        },
        secretColor: {
            name: `${MODULE_ID}.settings.secretColor.name`,
            hint: `${MODULE_ID}.settings.secretColor.hint`,
            scope: "world",
            config: true,
            type: String,
            default: "#ff00ff",
            onChange: () => {
                ui.simpleQuest.updateStyle();
            },
        },
        failedColor: {
            name: `${MODULE_ID}.settings.failedColor.name`,
            hint: `${MODULE_ID}.settings.failedColor.hint`,
            scope: "world",
            config: true,
            type: String,
            default: "#ff0000",
            onChange: () => {
                ui.simpleQuest.updateStyle();
            },
        },
        labelColor: {
            name: `${MODULE_ID}.settings.labelColor.name`,
            hint: `${MODULE_ID}.settings.labelColor.hint`,
            scope: "world",
            config: true,
            type: String,
            default: "none",
            onChange: () => {
                ui.simpleQuest.refresh();
            },
        },
        invertTheme: {
            name: `${MODULE_ID}.settings.invertTheme.name`,
            hint: `${MODULE_ID}.settings.invertTheme.hint`,
            scope: "world",
            config: true,
            type: Boolean,
            default: false,
            onChange: () => {
                ui.simpleQuest.updateStyle();
            },
        },
        matchJournalStyle: {
            name: `${MODULE_ID}.settings.matchJournalStyle.name`,
            hint: `${MODULE_ID}.settings.matchJournalStyle.hint`,
            scope: "world",
            config: true,
            type: Boolean,
            default: false,
            onChange: () => {
                ui.simpleQuest.updateStyle();
            },
        },
        hideFolderFromPlayers: {
            name: `${MODULE_ID}.settings.hideFolderFromPlayers.name`,
            hint: `${MODULE_ID}.settings.hideFolderFromPlayers.hint`,
            scope: "world",
            config: true,
            type: Boolean,
            default: true,
        },
        useMessageTheme: {
            name: `${MODULE_ID}.settings.useMessageTheme.name`,
            hint: `${MODULE_ID}.settings.useMessageTheme.hint`,
            scope: "world",
            config: true,
            type: Boolean,
            default: true,
        },
        showQuestNotifications: {
            name: `${MODULE_ID}.settings.showQuestNotifications.name`,
            hint: `${MODULE_ID}.settings.showQuestNotifications.hint`,
            scope: "world",
            config: true,
            type: Boolean,
            default: true,
        },
        newQuestSoundEffect: {
            name: `${MODULE_ID}.settings.newQuestSoundEffect.name`,
            hint: `${MODULE_ID}.settings.newQuestSoundEffect.hint`,
            scope: "world",
            config: true,
            type: String,
            filePicker: "audio",
            default: "",
        },
        updateQuestSoundEffect: {
            name: `${MODULE_ID}.settings.updateQuestSoundEffect.name`,
            hint: `${MODULE_ID}.settings.updateQuestSoundEffect.hint`,
            scope: "world",
            config: true,
            type: String,
            filePicker: "audio",
            default: "",
        },
        openJournalPinsAsModals: {
            name: `${MODULE_ID}.settings.openJournalPinsAsModals.name`,
            hint: `${MODULE_ID}.settings.openJournalPinsAsModals.hint`,
            scope: "world",
            config: true,
            type: Boolean,
            default: true,
        },
        enableQuests: {
            name: `${MODULE_ID}.settings.enableQuests.name`,
            hint: `${MODULE_ID}.settings.enableQuests.hint`,
            scope: "world",
            config: true,
            type: Boolean,
            default: true,
        },
        enablePartyJournal: {
            name: `${MODULE_ID}.settings.enablePartyJournal.name`,
            hint: `${MODULE_ID}.settings.enablePartyJournal.hint`,
            scope: "world",
            config: true,
            type: Boolean,
            default: true,
        },
        enableMyJournal: {
            name: `${MODULE_ID}.settings.enableMyJournal.name`,
            hint: `${MODULE_ID}.settings.enableMyJournal.hint`,
            scope: "world",
            config: true,
            type: Boolean,
            default: true,
        },
        enableMaps: {
            name: `${MODULE_ID}.settings.enableMaps.name`,
            hint: `${MODULE_ID}.settings.enableMaps.hint`,
            scope: "world",
            config: true,
            type: Boolean,
            default: true,
        },
        enableLore: {
            name: `${MODULE_ID}.settings.enableLore.name`,
            hint: `${MODULE_ID}.settings.enableLore.hint`,
            scope: "world",
            config: true,
            type: Boolean,
            default: true,
        },
        enableTimeline: {
            name: `${MODULE_ID}.settings.enableTimeline.name`,
            hint: `${MODULE_ID}.settings.enableTimeline.hint`,
            scope: "world",
            config: true,
            type: Boolean,
            default: true,
        },
        enableAchievements: {
            name: `${MODULE_ID}.settings.enableAchievements.name`,
            hint: `${MODULE_ID}.settings.enableAchievements.hint`,
            scope: "world",
            config: true,
            type: Boolean,
            default: true,
        },
        imagePageMask: {
            name: `${MODULE_ID}.settings.imagePageMask.name`,
            hint: `${MODULE_ID}.settings.imagePageMask.hint`,
            scope: "world",
            config: true,
            type: String,
            filePicker: "image",
            default: `${SYSTEM_PATH}/assets/mask/mask1.webp`,
        },
        matchJournalPermission: {
            name: `${MODULE_ID}.settings.matchJournalPermission.name`,
            hint: `${MODULE_ID}.settings.matchJournalPermission.hint`,
            scope: "world",
            config: true,
            type: Boolean,
            default: false,
        },
        ttmSrc: {
            scope: "world",
            config: false,
            type: Object,
            default: null,
            onChange: (val) => setTTM(val),
        },
        lastQuest: {
            scope: "client",
            config: false,
            type: String,
            default: "",
        },
        lastMap: {
            scope: "client",
            config: false,
            type: String,
            default: "",
        },
        lastLore: {
            scope: "client",
            config: false,
            type: String,
            default: "",
        },
        lastAchievements: {
            scope: "client",
            config: false,
            type: String,
            default: "",
        },
        lastTimeline: {
            scope: "client",
            config: false,
            type: String,
            default: "",
        },
        lastMyJournal: {
            scope: "client",
            config: false,
            type: String,
            default: "",
        },
        lastPartyJournal: {
            scope: "client",
            config: false,
            type: String,
            default: "",
        },
        timelineScroll: {
            scope: "client",
            config: false,
            type: Number,
            default: 0,
        },
        lastTab: {
            scope: "client",
            config: false,
            type: String,
            default: "quests",
        },
        seenQuests: {
            scope: "client",
            config: false,
            type: Object,
            default: {},
        },
        showCompleted: {
            scope: "client",
            config: false,
            type: Boolean,
            default: true,
        },
        welcomeMessage: {
            scope: "client",
            config: false,
            type: Boolean,
            default: false,
        },
        welcomeMaps: {
            scope: "client",
            config: false,
            type: Boolean,
            default: false,
        },
        detailsStatus: {
            scope: "client",
            config: false,
            type: Object,
            default: {},
        },
        windowedMode: {
            scope: "client",
            config: false,
            type: Boolean,
            default: false,
        },
        themeConfigShown: {
            scope: "client",
            config: false,
            type: Boolean,
            default: false,
        },
        fontSize: {
            scope: "client",
            config: false,
            type: Number,
            default: 1.5,
            onChange: () => {
                ui.simpleQuest.updateStyle();
            },
        },
        tabNames: {
            scope: "world",
            config: false,
            type: Object,
            default: { ...DEFAULT_TAB_NAMES },
            onChange: () => {
                ui.simpleQuest.refresh();
            },
        }
    };

    registerSettingsArray(settings);

}

export function registerOnReadySettings() {
    const settings = {
        fontFamily: {
            name: `${MODULE_ID}.settings.fontFamily.name`,
            hint: `${MODULE_ID}.settings.fontFamily.hint`,
            scope: "world",
            config: true,
            type: String,
            choices: foundry.applications.settings.menus.FontConfig.getAvailableFontChoices(), //Object.keys(CONFIG.fontDefinitions).reduce((obj, key) => {obj[key] = key; return obj}, {}),
            default: "Times New Roman",
            onChange: () => {
                ui.simpleQuest.updateStyle();
            },
        },
        headerOnlyFont: {
            name: `${MODULE_ID}.settings.headerOnlyFont.name`,
            hint: `${MODULE_ID}.settings.headerOnlyFont.hint`,
            scope: "world",
            config: true,
            type: String,
            choices: { default: `${MODULE_ID}.theme-config.themes.default`, ...foundry.applications.settings.menus.FontConfig.getAvailableFontChoices() },
            default: "default",
            onChange: () => {
                ui.simpleQuest.updateStyle();
            },
        },
    };

    registerSettingsArray(settings);
}

export function getSetting(key) {
    return game.settings.get(SYSTEM_ID, toSettingKey(key));
}

export async function setSetting(key, value) {
    return await game.settings.set(SYSTEM_ID, toSettingKey(key), value);
}

export function getDefaultSetting(key) {
    return game.settings.settings.get(toSettingId(key)).default;
}

export function getTabNames() {
    //merge the default with the user's settings so that empty values are replaced with the default
    const setting = getSetting("tabNames");
    for (const [key, value] of Object.entries(DEFAULT_TAB_NAMES)) {
        if (!setting[key]) setting[key] = value;
    }
    return setting;
}

function registerSettingsArray(settings) {
    for (const [key, value] of Object.entries(settings)) {
        game.settings.register(SYSTEM_ID, toSettingKey(key), {
            ...value,
            questConfig: value.config === true,
            config: false,
        });
    }
}

export class QuestSettingsConfig extends SettingsConfig {
    static TABS = {};

    static DEFAULT_OPTIONS = {
        id: `${SYSTEM_ID}-simple-quest-settings`,
        classes: ["category-browser", "fallout-maw", "fallout-maw-simple-quest-settings"],
        window: {
            title: `${MODULE_ID}.settings.questMenu.title`,
            icon: "fa-solid fa-scroll",
        },
        position: {
            width: 820,
            height: 720,
        },
        initialCategory: "general",
        actions: {
            openSubmenu: QuestSettingsConfig.openSubmenu,
            resetSimpleQuest: QuestSettingsConfig.resetSimpleQuest,
        },
        subtemplates: {
            sidebarFooter: `${SYSTEM_PATH}/templates/quest-settings-reset.hbs`,
        },
    };

    _prepareCategoryData() {
        const categories = {};
        for (const section of QUEST_SETTING_SECTIONS) {
            const entries = [];
            if (section.menu) entries.push(prepareQuestMenuEntry(section.menu));
            for (const key of section.keys) {
                const setting = game.settings.settings.get(toSettingId(key));
                if (setting?.questConfig) entries.push(prepareQuestSettingEntry(setting));
            }
            categories[section.id] = { id: section.id, label: section.label, entries };
        }
        return categories;
    }

    _sortCategories(left, right) {
        const order = new Map(QUEST_SETTING_SECTIONS.map((section, index) => [section.id, index]));
        return order.get(left.id) - order.get(right.id);
    }

    static openSubmenu(_event, button) {
        const applications = {
            tabConfig: TabConfig,
            themeConfig: ThemeConfig,
        };
        const ApplicationClass = applications[button.dataset.key];
        if (ApplicationClass) new ApplicationClass().render(true);
    }

    static async resetSimpleQuest(_event) {
        const folderNames = new Set([getSetting("folderName"), getSetting("loreFolderName")]);
        for (const key of ["folderName", "loreFolderName"]) {
            const localizationKey = `${MODULE_ID}.settings.${STRUCTURE_SETTING_KEYS[key]}.default`;
            folderNames.add(game.i18n.localize(localizationKey));
            folderNames.add(foundry.utils.getProperty(game.i18n._fallback, localizationKey));
        }
        folderNames.delete(undefined);
        const roots = game.folders.filter((folder) => folder.type === "JournalEntry" && !folder.folder && folderNames.has(folder.name));
        const escapedNames = roots.length
            ? roots.map((folder) => `<li>${foundry.utils.escapeHTML(folder.name)}</li>`).join("")
            : `<li>${game.i18n.localize(`${MODULE_ID}.settings.questMenu.resetNoFolders`)}</li>`;

        const confirmed = await foundry.applications.api.DialogV2.confirm({
            window: { title: game.i18n.localize(`${MODULE_ID}.settings.questMenu.resetTitle`) },
            content: game.i18n.format(`${MODULE_ID}.settings.questMenu.resetConfirm`, { folders: `<ul>${escapedNames}</ul>` }),
            modal: true,
        });
        if (!confirmed) return;

        await this.close();
        await ui.simpleQuest?.close?.();
        ui.notifications.info(game.i18n.localize(`${MODULE_ID}.settings.questMenu.resetting`));

        for (const folder of roots) {
            await folder.delete({ deleteSubfolders: true, deleteContents: true });
        }

        const settings = Array.from(game.settings.settings.values()).filter(
            (setting) => setting.namespace === SYSTEM_ID && setting.key.startsWith("simpleQuest."),
        );
        for (const setting of settings) {
            const current = game.settings.get(SYSTEM_ID, setting.key);
            if (foundry.utils.equals(current, setting.default)) continue;
            await game.settings.set(SYSTEM_ID, setting.key, foundry.utils.deepClone(setting.default));
        }

        game.socket.emit("reload");
        foundry.utils.debouncedReload();
    }
}

function prepareQuestMenuEntry(key) {
    return {
        key,
        icon: key === "tabConfig" ? "fa-solid fa-table-columns" : "fa-solid fa-palette",
        label: `${MODULE_ID}.settings.${key}.name`,
        hint: `${MODULE_ID}.settings.${key}.hint`,
        menu: true,
        buttonText: `${MODULE_ID}.settings.${key}.label`,
    };
}

function prepareQuestSettingEntry(setting) {
    const fields = foundry.data.fields;
    const options = { required: true, initial: setting.default };
    let field;
    let folderPicker = false;

    if (["backgroundColor", "textColor", "secretColor", "failedColor"].includes(setting.key.split(".").at(-1))) {
        field = new fields.ColorField(options);
    } else if (setting.type === Boolean) {
        field = new fields.BooleanField(options);
    } else if (setting.type === Number) {
        const { min, max, step } = setting.range ?? {};
        field = new fields.NumberField({ ...options, choices: setting.choices, min, max, step });
    } else if (setting.filePicker) {
        const categories = {
            audio: ["AUDIO"],
            folder: [],
            font: ["FONT"],
            graphics: ["GRAPHICS"],
            image: ["IMAGE"],
            imagevideo: ["IMAGE", "VIDEO"],
            text: ["TEXT"],
            video: ["VIDEO"],
        }[setting.filePicker] ?? Object.keys(CONST.FILE_CATEGORIES).filter((category) => category !== "HTML");
        if (categories.length) field = new fields.FilePathField({ ...options, blank: true, categories });
        else {
            field = new fields.StringField(options);
            folderPicker = true;
        }
    } else {
        field = new fields.StringField({ ...options, choices: setting.choices });
    }

    field.name = setting.id;
    field.label = game.i18n.localize(setting.name ?? "");
    field.hint = game.i18n.localize(setting.hint ?? "");
    return {
        field,
        folderPicker,
        menu: false,
        value: game.settings.get(setting.namespace, setting.key),
    };
}
