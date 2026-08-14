import { FLAG_PATH, FLAG_ROOT, FLAG_SCOPE, MODULE_ID, SYSTEM_PATH } from "../constants.js";
import { getSimpleQuestFlag, setSimpleQuestFlag } from "../flags.js";
import { getDefaultSetting, getSetting, setSetting, getTabNames } from "../settings.js";
import { createDemoQuest, createLoreFolder, showQuestNotification, showWelcomeMaps } from "../helpers.js";
import { MapImage } from "../mapImage.js";
import { Sortable } from "../lib/Sortable.js";
import { TabConfig } from "./tabConfig.js";
import { ThemeConfig } from "./themeConfig.js";
import { Socket } from "../lib/socket.js";
import {Timeline} from "./timeline.js";

const getHistory = () => {
    return getSimpleQuestFlag(game.user, "history") ?? [];
}

const setHistory = (history) => {
    return setSimpleQuestFlag(game.user, "history", history);
}

const CHECKBOX_STATE = {
    UNCHECKED: 0,
    CHECKED: 1,
    FAILED: 2,
};

const BESTIARY = {
    todo: "",
};

const TAB_SCROLL_STATES = {
    quests: { sel: ".quest-list", scroll: 0 },
    lore: { sel: ".quest-list", scroll: 0 },
    timeline: { sel: ".quest-list", scroll: 0 },
    map: { sel: ".maps-list", scroll: 0 },
    achievements: { sel: ".achievements-list", scroll: 0 },
    "my-journal": { sel: ".journal-container", scroll: 0 },
    "party-journal": { sel: ".journal-container", scroll: 0 },
};

const JOURNAL_DEFAULTS = {
    achievements: {
        name: "New Achievement",
        src: "icons/commodities/treasure/cup-trophy-gold.webp",
    },
};

let isPopOut = true;

let fowBrushSize = 50;

const STATES = {
    quests: {
        saveSelected: (uuid) => setSetting("lastQuest", uuid),
    },
    lore: {
        saveSelected: (uuid) => setSetting("lastLore", uuid),
    },
    map: {
        saveSelected: (uuid) => setSetting("lastMap", uuid),
    },
    "my-journal": {
        saveSelected: (uuid) => setSetting("lastMyJournal", uuid),
    },
    "party-journal": {
        saveSelected: (uuid) => setSetting("lastPartyJournal", uuid),
    },
    timeline: {
        saveSelected: (uuid) => setSetting("lastTimeline", uuid),
    },
    achievements: {
        saveSelected: (uuid) => setSetting("lastAchievements", uuid),
        selected: false,
    },
};

export function setWindowedMode() {
    isPopOut = getSetting("windowedMode");
}

export class SimpleQuest extends Application {
    constructor() {
        super();
        this._questScroll = {};
        SimpleQuest.setHooks();
        STATES.quests.selected = getSetting("lastQuest");
        STATES.map.selected = getSetting("lastMap");
        STATES.lore.selected = getSetting("lastLore");
        STATES["my-journal"].selected = getSetting("lastMyJournal");
        STATES["party-journal"].selected = getSetting("lastPartyJournal");
        this._search = {};
        this.updateStyle();
        this.refresh = foundry.utils.debounce(this.refresh.bind(this), 30);
    }

    static get APP_ID() {
        return this.name
            .split(/(?=[A-Z])/)
            .join("-")
            .toLowerCase();
    }

    get APP_ID() {
        return this.constructor.APP_ID;
    }

    get activeTab() {
        return this._tabs[0]?.active;
    }

    getActiveJournal(type) {
        if (STATES[type].active) return STATES[type].active;
        if (!STATES[type].selected) return STATES[type].active ?? STATES[type].journals?.[0] ?? STATES[type].journal;
        const activePage = fromUuidSync(STATES[type].selected);
        if (!activePage) return STATES[type].active ?? STATES[type].journals[0];
        return activePage.parent;
    }

    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: this.APP_ID,
            template: `${SYSTEM_PATH}/templates/${this.APP_ID}.hbs`,
            popOut: isPopOut,
            resizable: isPopOut,
            minimizable: isPopOut,
            width: isPopOut ? window.innerWidth * 0.6 : window.innerWidth,
            height: isPopOut ? window.innerHeight * 0.8 : window.innerHeight,
            title: game.i18n.localize(`${MODULE_ID}.${this.APP_ID}.title`),
            tabs: [{ navSelector: ".tabs", contentSelector: ".content", initial: "quests" }],
            scrollY: [".quest-list", ".quest-contents", ".maps-list"],
        });
    }

    _getHeaderButtons() {
        const buttons = super._getHeaderButtons();
        buttons.unshift({
            class: "windowed-mode",
            icon: "fas fa-expand",
            onclick: () => this.toggleWindowedMode(),
            title: game.i18n.localize(`${MODULE_ID}.${this.APP_ID}.windowedModeToggle`),
        });
        return buttons;
    }

    async getData() {
        const detailsStatus = getSetting("detailsStatus");
        const seenQuests = getSetting("seenQuests");
        const folderName = getSetting("folderName");
        const loreFolder = await createLoreFolder();
        const matchJournalPermission = getSetting("matchJournalPermission");
        const simpleQuestFolder = Array.from(game.folders).find((f) => f.name === folderName && f.type === "JournalEntry");
        const partyFolder = Array.from(game.folders).find((f) => f.name === getSetting("partyJournalName") && f.type === "JournalEntry" && f.folder === simpleQuestFolder);
        let mapsJournal = Array.from(game.journal).find((j) => j.folder === simpleQuestFolder && j.name === getSetting("mapsJournalName"));
        let timelineJournal = Array.from(game.journal).find((j) => j.folder === simpleQuestFolder && j.name === getSetting("timelineJournalName"));
        let achievementsJournal = Array.from(game.journal).find((j) => j.folder === simpleQuestFolder && j.name === getSetting("achievementsJournalName"));

        const questJournals = Array.from(game.journal)
            .filter((j) => j.folder === simpleQuestFolder && j.name !== mapsJournal?.name && j.name !== timelineJournal?.name && j.name !== achievementsJournal?.name)
            .sort((a, b) => a.sort - b.sort);
        const loreJournals = Array.from(game.journal)
            .filter((j) => j.folder === loreFolder && j.name !== mapsJournal?.name)
            .sort((a, b) => a.sort - b.sort);

        if (!mapsJournal) {
            mapsJournal = await JournalEntry.create({
                name: getSetting("mapsJournalName"),
                folder: simpleQuestFolder.id,
            });
        }
        if (!timelineJournal) {
            timelineJournal = await JournalEntry.create({
                name: getSetting("timelineJournalName"),
                folder: simpleQuestFolder.id,
            });
        }
        if (!achievementsJournal) {
            achievementsJournal = await JournalEntry.create({
                name: getSetting("achievementsJournalName"),
                folder: simpleQuestFolder.id,
            });
        }
        const myFolder = Array.from(game.folders).find((f) => f.name === game.user.name && f.type === "JournalEntry" && f.folder === partyFolder);
        const myJournals = Array.from(game.journal)
            .filter((j) => j.folder === myFolder)
            .sort((a, b) => a.sort - b.sort);
        const sharedFolder = Array.from(game.folders).find((j) => j.folder === partyFolder && j.name === getSetting("sharedJournalName"));
        const sharedJournals = Array.from(game.journal)
            .filter((j) => j.folder === sharedFolder)
            .sort((a, b) => a.sort - b.sort);

        this._questJournals = questJournals;
        this._questFolder = simpleQuestFolder;
        this._loreFolder = loreFolder;
        this._mapsJournal = mapsJournal;
        this._loreJournals = loreJournals;
        this._achievementsJournal = achievementsJournal;

        STATES.quests.journals = questJournals;
        STATES.lore.journals = loreJournals;
        STATES.quests.folder = simpleQuestFolder;
        STATES.lore.folder = loreFolder;
        STATES["my-journal"].journals = myJournals;
        STATES["party-journal"].journals = sharedJournals;
        STATES["my-journal"].folder = myFolder;
        STATES["party-journal"].folder = sharedFolder;
        STATES.map.journal = mapsJournal;
        STATES.timeline.journal = timelineJournal;
        STATES.achievements.journal = achievementsJournal;

        timelineJournal.sortedPages = Array.from(timelineJournal.pages).sort((a, b) => a.sort - b.sort);

        let defaultQuest = "";

        for (const j of questJournals) {
            let count = 0;
            j._simpleQuestDetails = detailsStatus[j.uuid] ?? true;
            const pages = Array.from(j.pages);
            pages.forEach((p) => {
                const isSecret = getSimpleQuestFlag(p, "hidden");
                const completedSubquests = getSimpleQuestFlag(p, "completedSubquests") ?? {};
                if (!isSecret) {
                    if (!defaultQuest) defaultQuest = p.uuid;
                }
                p._seen = !!seenQuests[p.uuid];
                p.canUserSee = matchJournalPermission ? p.testUserPermission(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER) : true;
                if (p.canUserSee && !isSecret) count++;
                const lastUpdated = getSimpleQuestFlag(p, "lastUpdated");
                if (seenQuests[p.uuid] && lastUpdated) {
                    p._seen = seenQuests[p.uuid] > lastUpdated;
                }
                p._tocArray = Object.values(p.toc);
                p._tocArray.forEach((t) => {
                    t._hidden = getSimpleQuestFlag(p, `secret.${t.slug}`) ?? false;
                    t._completed = completedSubquests[t.slug] ?? false;
                });
                p._simpleQuestDetails = detailsStatus[p.uuid] ?? true;
            });
            j.questCount = count;
            j.sortedPages = Array.from(j.pages).sort((a, b) => a.sort - b.sort);
        }

        for (const j of loreJournals) {
            const pages = Array.from(j.pages);
            let isOnePageVisible = false;
            pages.forEach((p) => {
                p.canPlayerSee = this.getDefaultUserPermission(p) >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;
                p.canUserSee = p.testUserPermission(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER);
                if (p.canUserSee) isOnePageVisible = true;
                const lastUpdated = getSimpleQuestFlag(p, "lastUpdated") ?? 1;
                if (seenQuests[p.uuid] && lastUpdated) {
                    p._seen = seenQuests[p.uuid] > lastUpdated;
                }
                p._tocArray = Object.values(p.toc);
                p._simpleQuestDetails = detailsStatus[p.uuid] ?? true;
            });
            j.sortedPages = Array.from(j.pages).sort((a, b) => a.sort - b.sort);
            j._simpleQuestDetails = detailsStatus[j.uuid] ?? true;
            j.canUserSee = j.testUserPermission(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER) || isOnePageVisible;
        }

        for (const j of myJournals.concat(sharedJournals)) {
            const pages = Array.from(j.pages);
            pages.forEach((p) => {
                p._simpleQuestDetails = detailsStatus[p.uuid] ?? true;
                p._tocArray = Object.values(p.toc);
                j._simpleQuestDetails = detailsStatus[j.uuid] ?? true;
            });
            j.sortedPages = Array.from(j.pages).sort((a, b) => a.sort - b.sort);
            j._simpleQuestDetails = detailsStatus[j.uuid] ?? true;
        }

        if (mapsJournal) {
            mapsJournal.sortedPages = Array.from(mapsJournal.pages).sort((a, b) => a.sort - b.sort);
            const pages = Array.from(mapsJournal.pages);
            pages.forEach((p) => {
                p.canPlayerSee = this.getDefaultUserPermission(p) >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER || !game.user.isGM;
                p.canUserSee = p.testUserPermission(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER);
            });
        }

        if (achievementsJournal) {
            achievementsJournal.sortedPages = Array.from(achievementsJournal.pages).sort((a, b) => a.sort - b.sort);
            achievementsJournal.sortedPages = achievementsJournal.sortedPages.sort((a, b) => {
                if (a.isOwner && !b.isOwner) return -1;
                if (!a.isOwner && b.isOwner) return 1;
                return a.sort - b.sort;
            });
            const users = Array.from(game.users).filter((u) => !u.isGM && u.character);
            for (const page of achievementsJournal.sortedPages) {
                const isLimited = !page.isOwner && page.getUserLevel(game.user) === CONST.DOCUMENT_OWNERSHIP_LEVELS.LIMITED;
                page.enrichedText = await foundry.applications.ux.TextEditor.implementation.enrichHTML(page.text.content, { secrets: game.user.isGM, relativeTo: page, async: true });
                page.canUserSee = this.getUserPermission(page) >= CONST.DOCUMENT_OWNERSHIP_LEVELS.LIMITED;
                page.isAwarded = !game.user.isGM && this.getUserPermission(page) >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
                page.isHiddenAchievement = isLimited;
                const color = getSimpleQuestFlag(page, "color") ?? "#000000";
                page.achievementColor = color === "#000000" ? "var(--simple-quest-text-4)" : color;
                const userOwnership = [];
                for (const user of users) {
                    const userPermission = this.getUserPermission(page, user);
                    const userPagePermission = Math.max(page.ownership[user.id] ?? 0, userPermission);
                    const isOwner = userPagePermission >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
                    const isObserver = userPagePermission >= CONST.DOCUMENT_OWNERSHIP_LEVELS.LIMITED;
                    userOwnership.push({ user, isOwner, isObserver, isLimited });
                }
                page._userOwnership = userOwnership;
            }
        }

        if (!STATES.quests.selected) STATES.quests.selected = defaultQuest;

        return { showHistory: getSetting("showHistory"), history: getHistory(), hideCheckboxAutoHide: getSetting("hideCheckboxAutoHide"), matchJournalStyle: getSetting("matchJournalStyle"), achievementsJournal, timelineJournal, questJournals, myJournals, sharedJournals, mapsJournal, isGM: game.user.isGM, popOut: isPopOut, loreJournals, enableQuests: getSetting("enableQuests"), enablePartyJournal: getSetting("enablePartyJournal"), enableMyJournal: getSetting("enableMyJournal"), enableMaps: getSetting("enableMaps"), enableLore: getSetting("enableLore"), enableTimeline: getSetting("enableTimeline"), enableAchievements: getSetting("enableAchievements"), matchJournalPermission: getSetting("matchJournalPermission"), tabNames: getTabNames(), showCompleted: getSetting("showCompleted") };
    }

    getDefaultUserPermission(page, user) {
        const isInherited = page.ownership.default === CONST.DOCUMENT_OWNERSHIP_LEVELS.INHERIT;
        return isInherited ? page.parent.ownership.default : page.ownership.default;
    }

    getUserPermission(page, user) {
        return page.getUserLevel(user ?? game.user);
    }

    _onChangeTab(event, tabs, active) {
        setSetting("lastTab", active);
        if (!game.user.isGM && active == "map") showWelcomeMaps();
        if (game.user.isGM) this.checkTour(active);
        const res = super._onChangeTab(event, tabs, active);
        if (STATES.map.selected) {
            this._onSelectMap(null, STATES.map.selected);
        }
        const tScroll = TAB_SCROLL_STATES[active].scroll;
        if (tScroll) {
            this.element[0].querySelector(`.tab[data-tab='${active}'] ${TAB_SCROLL_STATES[active].sel}`).scrollTop = tScroll;
            TAB_SCROLL_STATES[active].scroll = 0;
        }
        return res;
    }

    async activateListeners(html) {
        super.activateListeners(html);
        html = html[0] ?? html;
        const timelineContainer = html.querySelector(`.tab[data-tab='timeline'] .quest-details`);
        this.timeline = new Timeline(timelineContainer);
        this.timeline.render(true);
        if (this._storedScrollPositions) {
            this._scrollPositions = this._storedScrollPositions;
            delete this._storedScrollPositions;
        }

        if (game.user.isGM) {
            if (!getSetting("themeConfigShown") && game.tours.get(MODULE_ID + ".interface")?.status !== foundry.nue.Tour.STATUS.UNSTARTED) new ThemeConfig().render(true);
            html.querySelectorAll(".item").forEach((el) => {
                el.addEventListener("contextmenu", async (e) => {
                    new TabConfig().render(true);
                });
            });
        }

        html.querySelectorAll(".quest-item").forEach((el) => {
            if (!el.classList.contains("has-details")) el.addEventListener("click", this._onSelectQuest.bind(this));
        });
        html.querySelectorAll(".timeline-item").forEach((el) => {
            el.addEventListener("click", this._onSelectTimeline.bind(this));
        });
        html.querySelectorAll("input[type='search']").forEach((el) => {
            //select all on focus
            el.addEventListener("focus", (e) => {
                e.currentTarget.select();
            });
            el.addEventListener("input", this._onSearch.bind(this));
        });
        html.querySelector("#toggle-completed").addEventListener("click", async (e) => {
            setSetting("showCompleted", !getSetting("showCompleted"));
            this.render(true);
        });
        if (STATES.quests.selected) {
            await this._onSelectQuest(null, STATES.quests.selected, true);
        }
        if (STATES.map.selected) {
            await this._onSelectMap(null, STATES.map.selected, true);
        }
        if (STATES.lore.selected) {
            await this._onSelectQuest(null, STATES.lore.selected, true);
        }
        if (STATES["my-journal"].selected) {
            await this._onSelectQuest(null, STATES["my-journal"].selected, true);
        }
        if (STATES["party-journal"].selected) {
            await this._onSelectQuest(null, STATES["party-journal"].selected, true);
        }
        html.querySelectorAll("#edit").forEach((el) => {
            el.addEventListener("click", async (e) => {
                const tab = e.currentTarget.closest(".tab").dataset.tab;
                const uuid = STATES[tab].selected;
                const page = await fromUuid(uuid);
                page.sheet.render(true);
            });
        });

        html.querySelector("#configure-lore-permissions").addEventListener("click", async (e) => {
            const uuid = e.currentTarget.closest(".quest-controls").dataset.uuid;
            const page = await fromUuid(uuid);
            new foundry.applications.apps.DocumentOwnershipConfig({document: page}).render(true);
        });

        html.querySelector("#mark-updated").addEventListener("click", async (e) => {
            const uuid = e.currentTarget.closest(".quest-controls").dataset.uuid;
            const page = await fromUuid(uuid);
            await setSimpleQuestFlag(page, "lastUpdated", Date.now());
        });

        html.querySelector("#share-quest").addEventListener("click", async (e) => {
            const uuid = e.currentTarget.closest(".quest-controls").dataset.uuid;
            const page = await fromUuid(uuid);
            if (!page) return;
            const response = await Dialog.confirm({
                title: game.i18n.localize(`${MODULE_ID}.shareQuest.title`),
                content: game.i18n.localize(`${MODULE_ID}.shareQuest.content`),
                yes: async () => {
                    await ChatMessage.create({
                        content: `<div class="dnd5e2"><h2 id="simple-quest-image-override" class="${getSetting("useMessageTheme") ? "simple-quest-message" : ""}">${game.i18n.localize(`${MODULE_ID}.shareQuest.chatMessage`)}</h2><hr><button data-uuid="${uuid}" class="share-quest-button"><i style="pointer-events: none;" class="fa-duotone fa-scroll-old"></i> ${page.name}</button><hr></div>`,
                        speaker: { alias: "Simple Quest" },
                        flags: {
                            [FLAG_SCOPE]: {
                                [FLAG_ROOT]: {
                                    simpleQuestMessage: uuid,
                                },
                            },
                        },
                    });
                },
                no: () => {},
                defaultYes: false,
            });
        });

        html.querySelectorAll("#delete").forEach((el) => {
            el.addEventListener("click", async (e) => {
                const tab = e.currentTarget.closest(".tab").dataset.tab;
                const uuid = STATES[tab].selected || el.dataset.uuid;
                const page = await fromUuid(uuid);
                if (!page) return ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.notifications.noPage`));
                const journal = page.parent;

                const response = await Dialog.confirm({
                    title: game.i18n.localize(`${MODULE_ID}.deletePage.title`) + ` ${page.name}`,
                    content: game.i18n.localize(`${MODULE_ID}.deletePage.content`),
                    yes: async () => {
                        await journal.deleteEmbeddedDocuments("JournalEntryPage", [page.id]);
                        this.render(true);
                    },
                    no: () => {},
                    defaultYes: false,
                });
            });
        });

        html.querySelectorAll(".simple-quest-show-players").forEach((el) => {
            el.addEventListener("click", async (e) => {
                const uuid = e.currentTarget.closest(".quest-controls").dataset.uuid;
                this.showQuest(uuid);
            });
        });

        html.querySelectorAll("#duplicate").forEach((el) => {
            el.addEventListener("click", async (e) => {
                const tab = e.currentTarget.closest(".tab").dataset.tab;
                const uuid = STATES[tab].selected;
                const page = await fromUuid(uuid);
                const journal = page.parent;
                const newPage = await journal.createEmbeddedDocuments("JournalEntryPage", [page.toObject()]);
                this.render(true);
            });
        });

        html.querySelectorAll("#move").forEach((el) => {
            el.addEventListener("change", async (e) => {
                const tab = e.currentTarget.closest(".tab").dataset.tab;
                const selected = e.currentTarget.value;
                if (selected === "none") return;
                const page = await fromUuid(STATES[tab].selected);
                const pageJournal = page.parent;
                const newJournal = STATES[tab].journals.find((j) => j.name === selected);
                if (!newJournal) return;
                if (!newJournal.isOwner && !pageJournal.isOwner) return ui.notifications.error(game.i18n.localize(`${MODULE_ID}.${MODULE_ID}.moveQuest.error`));
                const moved = await newJournal.createEmbeddedDocuments("JournalEntryPage", [page.toObject()]);
                if (!moved[0]) return;
                await pageJournal.deleteEmbeddedDocuments("JournalEntryPage", [page.id]);
                STATES[tab].selected = moved[0].uuid;
                this.render(true);
            });
        });

        html.querySelectorAll("#add-category").forEach((el) => {
            el.addEventListener("click", async (e) => {
                const tab = e.currentTarget.closest(".tab").dataset.tab;
                const isPartyJournal = tab === "party-journal";
                const journals = STATES[tab].journals;
                const highestSort = journals.reduce((acc, j) => Math.max(acc, j.sort), 0);
                const newJournal = await JournalEntry.create({ name: "New Category", folder: STATES[tab].folder, sort: highestSort + 1000, ownership: isPartyJournal ? { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER } : null });
                newJournal.sheet.render(true);
                STATES[tab].selected = newJournal.uuid;
                this.render(true);
            });
        });

        html.querySelectorAll("#add-page").forEach((el) => {
            el.addEventListener("click", async (e) => {
                const tab = e.currentTarget.closest(".tab").dataset.tab;
                const journal = this.getActiveJournal(tab);
                if (!journal) return;
                const baseData = { name: "New Page", sort: Math.max(0, ...Array.from(journal.pages).map((p) => p.sort)) + 1000 };
                const specialData = JOURNAL_DEFAULTS[tab] ?? {};
                const newPage = await journal.createEmbeddedDocuments("JournalEntryPage", [foundry.utils.mergeObject(baseData, specialData)]);
                newPage[0].sheet.render(true);
                if (STATES[tab].selected !== false) STATES[tab].selected = newPage[0].uuid;
                this.render(true);
            });
        });

        html.querySelector("#add-map").addEventListener("click", async (e) => {
            const journal = this._mapsJournal;
            if (!journal) return;
            const newPage = await journal.createEmbeddedDocuments("JournalEntryPage", [{ name: "New Map", type: "image" }]);
            newPage[0].sheet.render(true);
        });

        html.querySelector("#map-help").addEventListener("click", async (e) => {
            showWelcomeMaps(true);
        });

        html.querySelectorAll(".quest-category-summary").forEach((el) => {
            el.addEventListener("click", async (e) => {
                const tab = el.closest(".tab").dataset.tab;
                const uuid = el.dataset.uuid;
                STATES[tab].active = fromUuidSync(uuid);
                this._setSelectedCategory();
            });
        });

        html.querySelectorAll(".tab[data-tab='quests'] .quest-item .quest-checkbox.secret").forEach((el) => {
            el.addEventListener("click", async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const uuid = e.currentTarget.dataset.uuid;
                const anchor = e.currentTarget.dataset.anchor;
                const page = await fromUuid(uuid);
                const checked = !e.currentTarget.classList.contains("checked");
                if (anchor) {
                    const oldChecked = getSimpleQuestFlag(page, `secret`) ?? {};
                    oldChecked[anchor] = checked;
                    await setSimpleQuestFlag(page, `secret`, oldChecked);
                } else {
                    await setSimpleQuestFlag(page, "hidden", checked);
                }
            });
        });

        html.querySelectorAll(".tab[data-tab='lore'] .quest-item .quest-checkbox.secret, .tab[data-tab='map'] .map-item .quest-checkbox.secret, .timeline-item .quest-checkbox.secret").forEach((el) => {
            el.addEventListener("click", async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const uuid = e.currentTarget.dataset.uuid;
                const page = await fromUuid(uuid);
                const playerPermission = this.getDefaultUserPermission(page) >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;
                page.update({
                    ownership: {
                        default: playerPermission ? CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE : CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER,
                    },
                });
            });
        });

        html.querySelector("#windowed-mode").addEventListener("click", async (e) => {
            this.toggleWindowedMode();
        });

        html.querySelector("#font-size-decrease").addEventListener("click", async (e) => {
            const fontSize = getSetting("fontSize");
            if (fontSize > 1) {
                await setSetting("fontSize", fontSize - 0.25);
            }
        });

        html.querySelector("#font-size-increase").addEventListener("click", async (e) => {
            const fontSize = getSetting("fontSize");
            if (fontSize < 3) {
                await setSetting("fontSize", fontSize + 0.25);
            }
        });

        html.querySelector("#theme-config").addEventListener("click", async (e) => {
            new ThemeConfig().render(true);
        });

        html.querySelectorAll("details").forEach((el) => {
            el.addEventListener("toggle", async (e) => {
                const details = e.currentTarget;
                if (details._temporarilyOpen) {
                    delete details._temporarilyOpen;
                    return;
                }
                const isOpen = details.open;
                const uuid = details.dataset.uuid;
                if (!uuid) return;
                const sett = getSetting("detailsStatus");
                sett[uuid] = isOpen;
                await setSetting("detailsStatus", sett);
            });
        });

        html.querySelectorAll(".map-item").forEach((el) => {
            el.addEventListener("click", async (e) => {
                const uuid = e.currentTarget.dataset.uuid;
                this._onSelectMap(e, uuid);
            });
        });

        html.querySelectorAll(".journal-toc").forEach((el) => {
            el.addEventListener("click", async (e) => {
                const journalContainer = el.closest(".tab").querySelector(".journal-container");
                const anchor = el.dataset.slug;
                const tocText = el.dataset.toc;
                //find h1 h2 or h3 with the same text
                const headers = journalContainer.querySelectorAll("h1, h2, h3");
                let header;
                const sameNameHeaderIndex = anchor.includes("$") ? parseInt(anchor.split("$")[1]) : 0;
                const matchingHeaders = Array.from(headers).filter((h) => h.innerText.trim() === tocText);
                header = matchingHeaders[sameNameHeaderIndex];
                //scroll to anchor
                if (header) {
                    header.scrollIntoView({ behavior: "smooth", block: "start" });
                }
            });
        });

        html.addEventListener("click", (e) => {
            if (!e.target.classList.contains("content-link") || e.ctrlKey || e.metaKey) return;
            const isSimpleQuestPage = this.isSimpleQuestPage(e.target.dataset.uuid);
            if (!isSimpleQuestPage) return;
            e.preventDefault();
            e.stopPropagation();
            if (this.activeTab === "map" && isSimpleQuestPage === "lore" && this._mapImage) {
                this._mapImage.openModalJournal(fromUuidSync(e.target.dataset.uuid));
            } else {
                this.openToPage(e.target.dataset.uuid);
            }
        });
        if (game.user.isGM) {
            html.querySelectorAll(".user-image-wrapper img").forEach((el) => {
                el.style.cursor = "pointer";
                el.addEventListener("click", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const pageUuid = el.closest(".achievement-item").dataset.uuid;
                    const page = fromUuidSync(pageUuid);
                    new foundry.applications.apps.DocumentOwnershipConfig({document: page}).render(true);
                });
            });
            html.querySelectorAll(".quest-header").forEach((el) => {
                el.style.cursor = "pointer";
                el.addEventListener("click", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const pageUuid = el.closest(".achievement-item").dataset.uuid;
                    const page = fromUuidSync(pageUuid);
                    page.sheet.render(true);
                });
            });
        }

        //close on escape
        document.addEventListener("keydown", this._onEscape.bind(this));

        this._makeSortable(html);

        this._setSelectedCategory();

        this.restoreSearch();

        this.updateHistory();

        if (this._initialTab) {
            this._skipFirstTourCheck = true;
            this.activateTab(this._initialTab);
            this._initialTab = null;
        }

        this.element[0].querySelector(".achievements-list").scrollTop = TAB_SCROLL_STATES.achievements.scroll;

        this.checkTour(null, "interface");
        if (!this.element[0].dataset.hasContextMenu) {
            new foundry.applications.ux.ContextMenu.implementation(this.element[0], "[data-uuid]:not(.simple-quest-counter)", this._getContextEntries(), {jQuery: false});
            this.element[0].dataset.hasContextMenu = true;
        }
    }

    _getContextEntries() {
        const getDocument = (el) => fromUuidSync(el.dataset.uuid);
        return [
            {
                name: "OWNERSHIP.Configure",
                icon: '<i class="far fa-lock"></i>',
                condition: () => game.user.isGM,
                callback: (el) => new foundry.applications.apps.DocumentOwnershipConfig({document: getDocument(el)}).render(true),
            },
            {
                name: "SIDEBAR.Edit",
                icon: '<i class="far fa-edit"></i>',
                condition: (el) => getDocument(el).isOwner,
                callback: (el) => getDocument(el).sheet.render(true),
            },
            {
                name: "SIDEBAR.Delete",
                icon: '<i class="far fa-trash"></i>',
                condition: (el) => getDocument(el).isOwner,
                callback: (el) => getDocument(el).deleteDialog(),
            },
            {
                name: "SIDEBAR.Duplicate",
                icon: '<i class="far fa-copy"></i>',
                condition: (el) => getDocument(el).isOwner,
                callback: (el) => getDocument(el).clone({ name: `${getDocument(el)._source.name} (Copy)` }, { save: true, addSource: true }),
            },
        ];
    }

    checkTour(tab, tourId) {
        if (this._skipFirstTourCheck) {
            delete this._skipFirstTourCheck;
            return;
        }
        const tourName = tab ? `${MODULE_ID}.${tab}-tab` : `${MODULE_ID}.${tourId}`;
        const t = game.tours.get(tourName);
        if (t?.status === foundry.nue.Tour.STATUS.UNSTARTED) {
            t.start();
        }
    }

    _makeSortable(html) {
        if (!game.user.isGM) return;

        html.querySelectorAll(".quest-category-list").forEach((el) => {
            new Sortable(el, {
                dragSelector: ".quest-item",
                dropSelector: ".quest-item",
                animation: 100,
                onEnd: this._sortQuestListAndSave.bind(this),
            });
        });

        html.querySelectorAll(".quest-list").forEach((el) => {
            new Sortable(el, {
                dragSelector: ".quest-category",
                dropSelector: ".quest-category",
                animation: 100,
                onEnd: this._sortCategoryListAndSave.bind(this),
            });
        });

        new Sortable(html.querySelector(".maps-list-element"), {
            dragSelector: ".map-item",
            dropSelector: ".map-item",
            animation: 100,
            onEnd: this._sortMapListAndSave.bind(this),
        });

        new Sortable(html.querySelector(".achievements-wrapper"), {
            dragSelector: ".achievement-item",
            dropSelector: ".achievement-item",
            animation: 100,
            onEnd: this._sortAchievementListAndSave.bind(this),
        });
    }

    restoreSearch() {
        const searchInputs = this.element[0].querySelectorAll("input[type='search']");
        searchInputs.forEach((s) => {
            s.value = this._search[s.closest(".tab").dataset.tab] ?? "";
            if (s.value) s.dispatchEvent(new Event("input"));
        });
    }

    _onSearch(e) {
        const term = e.currentTarget.value.toLowerCase();
        const html = e.currentTarget.parentElement.parentElement;
        const tab = html.closest(".tab").dataset.tab;
        if (tab == "lore") this.updateGlobalSearch(term, e.currentTarget);
        this._search[tab] = term;
        //loop through all the list elements and details elements, hide the ones which text content doesn't match - make sure to show the parent category if any of the children match as we have multiple levels of nesting

        //store the details open status

        const listItems = html.querySelectorAll("li");
        listItems.forEach((li) => {
            const text = li.textContent.toLowerCase();
            const isMatch = text.includes(term);
            li.classList.toggle("not-match", !isMatch);
            if (isMatch) {
                const cd = li.closest("details");
                if (cd) {
                    cd._temporarilyOpen = true;
                    cd.open = true;
                }
            }
        });

        const details = html.querySelectorAll("details");

        details.forEach((d) => {
            const text = d.textContent.toLowerCase();
            const isMatch = text.includes(term);
            d.classList.toggle("not-match", !isMatch);
        });

        if (!term) this.refresh();
    }

    updateGlobalSearch(term, input) {
        const oldResults = input.parentElement.parentElement.querySelectorAll(".global-search-results");
        if (oldResults.length) oldResults.forEach((r) => r.remove());
        if (!term) return;
        term = term.toLowerCase();
        const global = new GlobalSearch(term, this._loreJournals);
        if (term.length < 4) return;
        const res = global.getResults();
        const resultsEl = document.createElement("ul");
        resultsEl.classList.add("global-search-results");
        resultsEl.style.display = term ? null : "none";
        res.forEach((r) => {
            const li = document.createElement("li");
            const text = r.bestMatch;
            //highlight the search term
            const index = text.toLowerCase().indexOf(term);
            const before = text.substring(0, index);
            const after = text.substring(index + term.length);
            li.innerHTML = `<h3>${r.page.name}</h3><p>${before}<span class="highlight">${term}</span>${after}</p>`;
            resultsEl.append(li);
            li.addEventListener("click", async (e) => {
                await this._onSelectQuest(null, r.page.uuid);
                const journalContainer = input.closest(".tab").querySelector(".quest-details");
                const allEls = journalContainer.querySelectorAll("h1, h2, h3, h4, h5, h6, p");
                let el = [];
                allEls.forEach((e) => {
                    const inner = e.textContent.toLowerCase();
                    (inner.match(new RegExp(term, "g")) || []).forEach((m) => {
                        el.push(e);
                    });
                });
                if (!el.length) return;
                const targetEl = el[r.matchIndex];
                setTimeout(() => {
                    //highlight the element
                    targetEl.classList.add("search-highlight");
                    targetEl.scrollIntoView({ behavior: "smooth", block: "center" });
                }, 300);
                //scroll the li element so it's at the center of the screen
                li.scrollIntoView({ behavior: "smooth", block: "center" });
            });
        });
        resultsEl.style.width = input.clientWidth + "px";
        input.parentElement.after(resultsEl);
    }

    async _sortQuestListAndSave(sortEvent) {
        const list = sortEvent.from;

        const pages = Array.from(list.children).map((li) => li.dataset.uuid);

        const journal = await fromUuid(list.dataset.uuid);

        const updates = journal.pages.map((p) => {
            return {
                _id: p.id,
                sort: pages.indexOf(p.uuid) * 1000,
            };
        });

        await journal.updateEmbeddedDocuments("JournalEntryPage", updates);
    }

    async _sortCategoryListAndSave(sortEvent) {
        const list = sortEvent.from;
        const tab = list.closest(".tab").dataset.tab;

        const journals = Array.from(list.children).map((li) => li.dataset.uuid);

        const updates = STATES[tab].journals.map((j) => {
            return {
                _id: j.id,
                sort: journals.indexOf(j.uuid) * 1000,
            };
        });

        await JournalEntry.updateDocuments(updates);
    }

    async _sortMapListAndSave(sortEvent) {
        const list = sortEvent.from;

        const pages = Array.from(list.children).map((li) => li.dataset.uuid);

        const journal = this._mapsJournal;

        const updates = journal.pages.map((p) => {
            return {
                _id: p.id,
                sort: pages.indexOf(p.uuid) * 1000,
            };
        });

        await journal.updateEmbeddedDocuments("JournalEntryPage", updates);
    }

    async _sortAchievementListAndSave(sortEvent) {
        const list = sortEvent.from;

        const pages = Array.from(list.children).map((li) => li.dataset.uuid);

        const journal = this._achievementsJournal;

        const updates = journal.pages.map((p) => {
            return {
                _id: p.id,
                sort: pages.indexOf(p.uuid) * 1000,
            };
        });

        await journal.updateEmbeddedDocuments("JournalEntryPage", updates);
    }

    _onEscape(e) {
        if (e.key === "Escape" && this.rendered) {
            e.preventDefault();
            e.stopPropagation();
            this.close();
        }
    }

    async _setSelectedCategory() {
        const html = this.element[0];
        const categories = html.querySelectorAll(".quest-category-summary");
        //remove selected from all categories
        categories.forEach((c) => c.classList.remove("selected"));

        const selected = this.getActiveJournal("quests");

        if (!selected) return;

        const category = html.querySelector(`.quest-category-summary[data-uuid="${selected.uuid}"]`);
        if (!category) return;
        category.classList.add("selected");
    }

    _addCheckboxes(html, page) {
        const listItems = html.querySelectorAll("li");
        listItems.forEach((li) => {
            const checkbox = document.createElement("div");
            if (!page.isOwner) checkbox.style.pointerEvents = "none";
            checkbox.classList.add("quest-checkbox");
            const marker = document.createElement("div");
            marker.classList.add("quest-checkbox-marker");
            checkbox.append(marker);
            //remove spaces and pick only the first 50 characters
            const key = SimpleQuest.getKeyFromLi(li);
            const checked = getSimpleQuestFlag(page, `checkboxes.${key}`);
            if (checked) {
                checkbox.classList.add("checked");
                li.classList.add("checked");
                if (checked === CHECKBOX_STATE.FAILED) {
                    checkbox.classList.add("failed");
                    li.classList.add("failed");
                }
            }
            checkbox.addEventListener("mouseup", async (e) => {
                const isLeftClick = e.button === 0;
                const isRightClick = e.button === 2;
                if (!isLeftClick && !isRightClick) return;
                let checked = !checkbox.classList.contains("checked");
                if (checked && isRightClick) checked = CHECKBOX_STATE.FAILED;
                if (checked && isLeftClick) checked = CHECKBOX_STATE.CHECKED;
                checkbox.classList.toggle("checked");
                checkbox.classList.toggle("failed", checked === CHECKBOX_STATE.FAILED);
                const keysToUpdate = { [`${key}`]: checked };
                const parentLi = checkbox.closest("ul, ol").closest("li");
                const childLis = checkbox.closest("li").querySelectorAll("li");
                if (parentLi) {
                    const siblings = checkbox.closest("ul").querySelectorAll("li");
                    const allChecked = Array.from(siblings).every((s) => s.querySelector(".quest-checkbox:not(.secret)").classList.contains("checked"));
                    const allFailed = Array.from(siblings).every((s) => s.querySelector(".quest-checkbox:not(.secret)").classList.contains("failed"));
                    const parentKey = SimpleQuest.getKeyFromLi(parentLi);
                    if (allChecked) {
                        keysToUpdate[parentKey] = allFailed ? CHECKBOX_STATE.FAILED : CHECKBOX_STATE.CHECKED;
                    } else {
                        keysToUpdate[parentKey] = CHECKBOX_STATE.UNCHECKED;
                    }
                    parentLi.querySelector(".quest-checkbox:not(.secret)").classList.toggle("checked", allChecked);
                }
                checkbox.classList.toggle("checked");
                if (childLis.length && checked) {
                    childLis.forEach((li) => {
                        const childKey = SimpleQuest.getKeyFromLi(li);
                        keysToUpdate[childKey] = checked;
                        li.querySelector(".quest-checkbox:not(.secret)").classList.toggle("checked", checked !== CHECKBOX_STATE.UNCHECKED);
                    });
                }
                const oldChecked = getSimpleQuestFlag(page, `checkboxes`) ?? {};
                const update = { [`${FLAG_PATH}.checkboxes`]: foundry.utils.mergeObject(oldChecked, keysToUpdate) };
                const isSecretUpdate = checkbox.closest(".secret");
                if (!isSecretUpdate) update[`${FLAG_PATH}.lastUpdated`] = Date.now();

                //check if all the checkboxes between the nearest headers are checked
                //traverse to the furthest ol or ul
                let furtherList = li.closest("ol, ul");
                for (let i = 0; i < 10; i++) {
                    const isUlorOl = furtherList.tagName === "UL" || furtherList.tagName === "OL";
                    const closest = !isUlorOl ? furtherList.closest("ol, ul") : furtherList.parentElement?.closest("ol, ul");
                    if (closest) furtherList = closest;
                }
                const _furthestList = furtherList;
                let upperBoundHeader;
                while (furtherList.previousElementSibling) {
                    upperBoundHeader = furtherList.previousElementSibling;
                    if (upperBoundHeader.tagName.startsWith("H")) break;
                    furtherList = furtherList.previousElementSibling;
                }
                if (!upperBoundHeader.tagName.startsWith("H")) upperBoundHeader = null;
                checkbox.classList.toggle("checked");
                const allChecked = Array.from(_furthestList.querySelectorAll("li")).every((li) => li.querySelector(".quest-checkbox:not(.secret)").classList.contains("checked"));
                if (upperBoundHeader) {
                    const headerKey = upperBoundHeader.innerText.slugify({ strict: true });
                    const oldCompleted = getSimpleQuestFlag(page, `completedSubquests`) ?? {};
                    update[`${FLAG_PATH}.completedSubquests`] = foundry.utils.mergeObject(oldCompleted, { [headerKey]: allChecked });
                }

                //check if all the checkboxes on the quest are checked

                const allCheckedOnQuest = Array.from(html.querySelectorAll("li")).every((li) => li.querySelector(".quest-checkbox:not(.secret)").classList.contains("checked"));
                checkbox.classList.toggle("checked");

                update[`${FLAG_PATH}.completed`] = allCheckedOnQuest;

                await page.update(update);
            });
            li.prepend(checkbox);

            const secretCheckbox = document.createElement("div");
            secretCheckbox.classList.add("quest-checkbox");
            secretCheckbox.classList.add("secret");
            const secretMarker = document.createElement("div");
            const secretMarkerIcon = document.createElement("i");
            secretMarkerIcon.classList.add("fas");
            secretMarkerIcon.classList.add("fa-eye-slash");
            secretMarker.append(secretMarkerIcon);
            secretMarker.classList.add("quest-checkbox-marker");
            secretCheckbox.append(secretMarker);
            const secretKey = key;
            const secretChecked = getSimpleQuestFlag(page, `secret.${secretKey}`);
            if (secretChecked) {
                secretCheckbox.classList.add("checked");
                li.classList.add("secret");
                if (!game.user.isGM) {
                    li.style.display = "none";
                }
            }
            secretCheckbox.addEventListener("click", async (e) => {
                const checked = !secretCheckbox.classList.contains("checked");
                const keysToUpdate = { [`${secretKey}`]: checked };
                let oldChecked = getSimpleQuestFlag(page, `secret`) ?? {};
                if (typeof oldChecked === "boolean") oldChecked = {};
                const isAnyUnSecret = Object.values(keysToUpdate).some((v) => !v);
                const update = { [`${FLAG_PATH}.secret`]: foundry.utils.mergeObject(oldChecked, keysToUpdate) };
                const isSecretUpdate = checkbox.classList.contains("secret") ?? checkbox.closest(".secret");
                if (isAnyUnSecret && !isSecretUpdate) {
                    update[`${FLAG_PATH}.lastUpdated`] = Date.now();
                }
                await page.update(update);
            });
            if (game.user.isGM) li.prepend(secretCheckbox);
        });
    }

    async _onSelectQuest(event, uuid, firstRender = false) {
        const pageUuid = uuid ?? event.currentTarget.dataset.uuid;
        const page = await fromUuid(pageUuid);
        if (!page) return;
        const pageType = this.isSimpleQuestPage(pageUuid);
        if (!pageType) return;
        const usePermission = (pageType === "quests" && getSetting("matchJournalPermission")) || pageType !== "quests";
        const hiddenFlag = getSimpleQuestFlag(page, "hidden");
        if(!usePermission && hiddenFlag && !game.user.isGM) return;
        const canView = page.isOwner || page.testUserPermission(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER);
        if(!canView && usePermission) return;
        const html = this.element[0].querySelector(`.tab[data-tab="${pageType}"]`);

        STATES[pageType].active = page.parent;

        await this._setSelectedCategory();
        html.querySelectorAll(".quest-selected").forEach((el) => el.classList.remove("quest-selected"));
        if (event) event.currentTarget.classList.add("quest-selected");
        else {
            const el = html.querySelector(`summary.quest-item[data-uuid="${pageUuid}"]`) ?? html.querySelector(`.quest-item[data-uuid="${pageUuid}"]`);
            if (el) el.classList.add("quest-selected");
        }
        STATES[pageType].selected = pageUuid;
        const container = html.querySelector(".quest-contents");
        container.innerHTML = "";
        let content;
        if (page.type === "text") {
            content = await foundry.applications.ux.TextEditor.implementation.enrichHTML(page.text.content, { secrets: page.isOwner, relativeTo: page, async: true });
        } else if (page.type === "image") {
            const maskImage = getSetting("imagePageMask");
            const maskImageStyle = maskImage ? `style="mask-image: url('${maskImage}');-webkit-mask-image: url('${maskImage}');"` : "";
            content = `<div class="simple-quest-image-journal"><img ${maskImageStyle} src="${page.src}" alt="${page.name}"><p>${page.image.caption}</p></div>`;
        } else if (page.type === "pdf") {
            console.log("Loading PDF");
            const params = page.sheet._getViewerParams();
            const frame = `<iframe src="scripts/pdfjs/web/viewer.html?${params}" style="width: 100%; height: 95%;"></iframe>`;
            content = frame;
        } else {
            //Fall back to embed enricher
            content = await foundry.applications.ux.TextEditor.implementation.enrichHTML(`@Embed[${page.uuid}]`, { secrets: page.isOwner, relativeTo: page, async: true });
            //content = `<p>This Page Type is not Supported in Simple Quest</p>`;
        }
        container.innerHTML = `<h1 class="quest-header">${page.name}</h1>` + content;
        container.querySelectorAll("secret-block").forEach(s => s.addEventListener("change", (event) => {
            page.update({ "text.content": event.target.toggleRevealed(page.text.content) });
        }))

        if (!uuid) {
            html.querySelector(".quest-details").scrollTop = this._questScroll[pageUuid] ?? 0;
        }

        html.querySelectorAll("img").forEach((img) =>
            img.addEventListener("click", (event) => {
                const src = event.currentTarget.getAttribute("src");
                new foundry.applications.apps.ImagePopout({ src }).render({ force: true });
            }),
        );

        const questControls = html.querySelector(".quest-controls");
        questControls.classList.toggle("simple-quest-hidden", !page.isOwner);
        questControls.dataset.uuid = pageUuid;
        STATES[pageType].saveSelected(pageUuid);
        const seenQuests = getSetting("seenQuests");
        seenQuests[pageUuid] = Date.now();
        await setSetting("seenQuests", seenQuests);

        if (pageType === "quests") this._addCheckboxes(container, page);

        const onOpenAnchor = STATES[pageType].anchor;

        const anchor = onOpenAnchor ?? event?.currentTarget?.dataset?.anchor;

        this.updateHistory(pageUuid, anchor);

        if ((event && event.currentTarget?.classList.contains("sub-quest")) || (onOpenAnchor && page.toc[anchor])) {
            STATES[pageType].anchor = null;
            const toc = page.toc[anchor];
            const tocText = toc.text.trim();
            //find h1 h2 or h3 with the same text
            const headers = container.querySelectorAll("h1, h2, h3");
            let header;
            const sameNameHeaderIndex = anchor.includes("$") ? parseInt(anchor.split("$")[1]) : 0;
            const matchingHeaders = Array.from(headers).filter((h) => h.innerText.trim() === tocText);
            header = matchingHeaders[sameNameHeaderIndex];
            //scroll to anchor
            if (header) {
                setTimeout(()=>header.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
            }
        }

        //hide hidden toc
        const toc = page._tocArray;
        if (toc?.some((t) => t._hidden)) {
            const h1h2h3 = container.querySelectorAll("h1, h2, h3");
            //hide everything after a hidden toc until the next h1, h2 or h3
            const hiddenTocInnerText = toc.filter((t) => t._hidden).map((t) => t.text);
            const toHide = Array.from(h1h2h3).filter((h) => hiddenTocInnerText.includes(h.innerText));
            for (const h of toHide) {
                let next = h.nextElementSibling;
                while (next && !next.matches("h1, h2, h3")) {
                    next.style.display = "none";
                    next = next.nextElementSibling;
                }
                h.style.display = "none";
            }
        }
        if (firstRender) {
            html.querySelector(".quest-details").scrollTop = this._questScroll[STATES[pageType].selected] ?? 0;
        }
        Hooks.callAll(`${MODULE_ID}.onSelectQuest`, page, container);
    }

    async _onSelectMap(event, uuid, firstRender = false) {
        const pageUuid = uuid ?? event.currentTarget.dataset.uuid;
        const page = await fromUuid(pageUuid);
        const html = this.element[0];
        if (!page) return;

        this.updateHistory(pageUuid);

        const mapContainer = html.querySelector(".map-details");

        const tempDiv = document.createElement("div");
        tempDiv.innerHTML = page.text.content;
        const firstImageSrc = page.src || tempDiv.querySelector("img")?.src;

        const multiSource = Array.from(tempDiv.querySelectorAll("img")).map((i) => i.src);

        const mapImage = new MapImage(firstImageSrc, page, multiSource, getSimpleQuestFlag(page, "pinsLocked") ?? false);
        this._mapImage = mapImage;
        mapContainer.innerHTML = "";
        mapContainer.append(mapImage.element);
        const measureFlag = getSimpleQuestFlag(page, "measure") || "1mi";
        const numericPart = parseFloat(measureFlag) || 1;
        const unitPart = measureFlag.match(/[a-z]+/)?.[0] ?? "mi";
        mapImage._measureUnits = unitPart;
        mapImage._measure = numericPart;
        if (page.isOwner) {
            const buttonContainer = document.createElement("div");
            buttonContainer.classList.add("map-controls");
            mapContainer.append(buttonContainer);

            if (game.user.isGM) {
                //add reset fow button and fow brush size slider
                const resetFowButton = document.createElement("i");
                resetFowButton.classList.add("fa-duotone");
                resetFowButton.classList.add("fa-cloud");
                resetFowButton.id = "reset-fow";
                resetFowButton.dataset.tooltip = "simple-quest.simple-quest.tooltip.reset-fow";
                resetFowButton.dataset.tooltipDirection = "UP";
                resetFowButton.addEventListener("click", async (e) => {
                    mapImage.resetFow();
                });

                const fowBrushSizeSlider = document.createElement("input");
                fowBrushSizeSlider.type = "range";
                fowBrushSizeSlider.min = 0;
                fowBrushSizeSlider.max = 100;
                fowBrushSizeSlider.value = fowBrushSize;
                fowBrushSizeSlider.id = "fow-brush-size";
                fowBrushSizeSlider.dataset.tooltip = "simple-quest.simple-quest.tooltip.fow-brush-size";
                fowBrushSizeSlider.dataset.tooltipDirection = "UP";
                fowBrushSizeSlider.addEventListener("change", async (e) => {
                    fowBrushSize = e.currentTarget.value;
                });

                const measureInput = document.createElement("input");
                measureInput.type = "text";
                measureInput.id = "measure-input";
                measureInput.dataset.tooltip = "simple-quest.simple-quest.tooltip.measure";
                measureInput.dataset.tooltipDirection = "UP";
                measureInput.placeholder = "simple-quest.simple-quest.tooltip.measure";
                measureInput.value = getSimpleQuestFlag(page, "measure") ?? "1mi";
                measureInput.style.width = "8rem";
                measureInput.addEventListener("change", async (e) => {
                    const value = e.currentTarget.value;
                    setSimpleQuestFlag(page, "measure", value);
                });

                const pinsLocked = getSimpleQuestFlag(page, "pinsLocked") ?? false;

                const lockPins = document.createElement("i");
                lockPins.classList.add("fa-duotone");
                lockPins.classList.add(pinsLocked ? "fa-location-pin-slash" : "fa-location-pin");
                lockPins.id = "lock-pins";
                lockPins.style.minWidth = "2.2rem";
                lockPins.style.textAlign = "center";
                lockPins.dataset.tooltip = "simple-quest.simple-quest.tooltip.lock-pins";
                lockPins.dataset.tooltipDirection = "UP";
                lockPins.addEventListener("click", async (e) => {
                    setSimpleQuestFlag(page, "pinsLocked", !pinsLocked);
                });

                const showPlayersButton = document.createElement("i");
                showPlayersButton.classList.add("fa-duotone");
                showPlayersButton.classList.add("fa-eye");
                showPlayersButton.id = "show-players";
                showPlayersButton.dataset.tooltip = "simple-quest.simple-quest.tooltip.show-players";
                showPlayersButton.dataset.tooltipDirection = "UP";
                showPlayersButton.addEventListener("click", async (e) => {
                    this.showQuest(pageUuid);
                });

                buttonContainer.append(measureInput);
                buttonContainer.append(lockPins);
                buttonContainer.append(fowBrushSizeSlider);
                buttonContainer.append(resetFowButton);
                buttonContainer.append(showPlayersButton);

                Object.defineProperty(mapImage, "fowBrushSize", {
                    get: () => fowBrushSize,
                });

                mapImage._fowBrushSizeInput = fowBrushSizeSlider;
            }

            const editButton = document.createElement("i");
            editButton.classList.add("fa-duotone");
            editButton.classList.add("fa-pen-to-square");
            editButton.id = "edit-map";
            editButton.dataset.tooltip = "simple-quest.simple-quest.tooltip.edit-map";
            editButton.dataset.tooltipDirection = "UP";
            editButton.addEventListener("click", async (e) => {
                page.sheet.render(true);
            });
            buttonContainer.append(editButton);
        }
        setSetting("lastMap", pageUuid);
        html.querySelectorAll(".map-selected").forEach((el) => el.classList.remove("map-selected"));
        const mapEl = this.element[0].querySelector(`.map-item[data-uuid="${pageUuid}"]`);
        if (mapEl) mapEl.classList.add("map-selected");
        STATES.map.selected = pageUuid;
    }

    async _onSelectTimeline(event, uuid) {
        const pageUuid = uuid ?? event.currentTarget.dataset.uuid;
        const page = await fromUuid(pageUuid);
        if (!page) return;
        STATES.timeline.selected = pageUuid;
        this.timeline.goTo(pageUuid);
    }

    toggle(tab = null) {
        if (this.rendered) {
            if (STATES.quests.selected) {
                this._questScroll[STATES.quests.selected] = this.element[0].querySelector(".quest-details").scrollTop;
            }
            this.close();
        } else {
            this._initialTab = tab ?? getSetting("lastTab");
            this.render(true);
        }
    }

    async toggleWindowedMode() {
        await this.close();
        setSetting("windowedMode", !getSetting("windowedMode"));
        isPopOut = !isPopOut;
        ui.simpleQuest = new SimpleQuest();
        ui.simpleQuest._initialTab = getSetting("lastTab");
        ui.simpleQuest.render(true);
    }

    openToTab(tab) {
        this._initialTab = tab;
        this.render(true);
    }

    openToPage(uuid, anchor, options = {}) {
        const isSimpleQuestPage = this.isSimpleQuestPage(uuid);
        const hasPermission = this.hasPermission(uuid);
        if (!hasPermission) return ui.notifications.error(game.i18n.localize(`${MODULE_ID}.noPermission`));
        if (STATES[isSimpleQuestPage]) {
            STATES[isSimpleQuestPage].selected = uuid;
            if (anchor) STATES[isSimpleQuestPage].anchor = anchor;
        }
        this._initialTab = isSimpleQuestPage;
        this.updateHistory(uuid, anchor);
        this.render(true);
    }

    updateHistory(uuid, anchor) {
        const history = getHistory();
        if (uuid) {
            const existing = history.find((h) => h.uuid === uuid && h.anchor === anchor);
            if (!existing) {                
                history.unshift({ uuid: uuid, label: fromUuidSync(uuid).name, anchor: anchor });
                history.splice(10);
            }else{
                existing.label = fromUuidSync(uuid).name;
                existing.anchor = anchor;
                existing.uuid = uuid;
            }
            setHistory(history);
        }
        if(!this.element[0]) return;
        const historyEl = this.element[0].querySelector("#history");
        if (!historyEl) return;
        historyEl.innerHTML = "";
        for (const h of history) {
            const isLast = history.findIndex(i => i === h) === history.length - 1;
            const el = document.createElement("div");
            el.classList.add("history-item");
            el.innerHTML = `<span>${h.label}${h.anchor ? ` (${h.anchor.split("-").map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(" ")})` : ""}</span>`;
            historyEl.append(el);
            el.addEventListener("click", () => {
                this.openToPage(h.uuid, h.anchor);
            });
            if (!isLast) {
                const arrow = document.createElement("i");
                arrow.classList.add("fa-thin");
                arrow.classList.add("fa-chevron-right");
                historyEl.append(arrow);
            }
        }
    }

    async showQuest(uuid) {
        const users = Array.from(game.users).filter((u) => u.active && u !== game.user);
        const template = await renderTemplate(`${SYSTEM_PATH}/templates/show-quest.hbs`, { users: users });
        Dialog.prompt({
            title: game.i18n.localize(`${MODULE_ID}.showQuest.title`),
            content: template,
            label: game.i18n.localize(`JOURNAL.ActionShow`),
            render: (html) => {
                html = html[0];
                const all = html.querySelector(`input[name="allPlayers"]`);
                const otherCheckboxes = html.querySelectorAll(`input[name="players"]`);
                all.addEventListener("change", (e) => {
                    const disabled = e.currentTarget.checked;
                    otherCheckboxes.forEach((c) => (c.disabled = disabled));
                });
                html.closest(".app").classList.add("simple-quest-dialog");
            },
            callback: async (html) => {
                html = html[0];
                const all = html.querySelector(`input[name="allPlayers"]`).checked;
                const allUsers = users.map((u) => u.id);
                const selected = Array.from(html.querySelectorAll(`input[name="players"]:checked`)).map((i) => i.value);

                Socket.openToPage({ uuid: uuid }, { users: all ? allUsers : selected });
            },
            close: () => {},
        });
    }

    isSimpleQuestPage(uuid) {
        let page;
        try {
            page = fromUuidSync(uuid);
        } catch (e) {
            return false;
        }
        if (!page) return false;
        if (!(page instanceof JournalEntryPage)) return false;
        const journal = page.parent;
        const folder = Array.from(game.folders).find((f) => f.name === getSetting("folderName") && f.type === "JournalEntry");
        const loreFolder = Array.from(game.folders).find((f) => f.name === getSetting("loreFolderName") && f.type === "JournalEntry");
        const mapsJournal = Array.from(game.journal).find((j) => j.folder === folder && j.name === getSetting("mapsJournalName"));
        const isMap = Array.from(mapsJournal.pages).some((p) => p.uuid === uuid);
        const isLore = journal.folder === loreFolder;
        const isQuest = journal.folder === folder;
        const isAchievements = journal.folder === folder && journal.name === getSetting("achievementsJournalName");
        if (isAchievements) return "achievements";
        if (isMap) return "map";
        if (isLore) return "lore";
        if (isQuest) return "quests";

        const partyFolder = Array.from(game.folders).find((f) => f.name === getSetting("partyJournalName") && f.type === "JournalEntry" && f.folder === folder);
        const sharedFolder = Array.from(game.folders).find((f) => f.name === getSetting("sharedJournalName") && f.type === "JournalEntry" && f.folder === partyFolder);
        const playerFolder = Array.from(game.folders).find((f) => f.name === game.user.name && f.type === "JournalEntry" && f.folder === partyFolder);

        if (journal.folder === sharedFolder) return "party-journal";
        if (journal.folder === playerFolder) return "my-journal";

        return false;
    }

    hasPermission(uuid) {
        if (game.user.isGM) return true;
        const page = fromUuidSync(uuid);
        if (!page) return false;
        const type = this.isSimpleQuestPage(uuid);
        const isValid = type === "quests";
        const simpleQuestHidden = getSimpleQuestFlag(page, "hidden");
        if (simpleQuestHidden && isValid) return false;
        if (isValid && !simpleQuestHidden) return true;
        if (page.isOwner) return true;
        const journal = page.parent;
        const journalDefaultPermission = journal.permission;
        return page.permission === CONST.DOCUMENT_OWNERSHIP_LEVELS.INHERIT ? journalDefaultPermission : page.permission;
    }

    sceneToMap() {
        const scene = canvas.scene;
        const img = scene.background.src;
        const distance = 100 / scene.dimensions.distancePixels;
        const markers = {};
        const origin = { x: scene.dimensions.sceneX, y: scene.dimensions.sceneY };
        const size = { x: scene.dimensions.sceneWidth, y: scene.dimensions.sceneHeight };

        canvas.notes.placeables.forEach((n) => {
            const pos = n.center;
            const x = (pos.x - origin.x) / size.x;
            const y = (pos.y - origin.y) / size.y;
            const d = n.document;
            markers[foundry.utils.randomID()] = {
                title: d.label,
                icon: d.texture.src,
                journal: d.page?.uuid ?? d.entry?.uuid,
                x: x,
                y: y,
                hidden: false,
                color: d.texture.tint || "#ff0000",
            };
        });

        const mapsJournal = Array.from(game.journal).find((j) => j.folder === this._questFolder && j.name === getSetting("mapsJournalName"));

        const newPage = mapsJournal.createEmbeddedDocuments("JournalEntryPage", [
            {
                name: scene.name,
                type: "image",
                src: img,
                flags: {
                    [FLAG_SCOPE]: {
                        [FLAG_ROOT]: {
                            markers: markers,
                            measure: `${distance}${scene.grid.units}`,
                        },
                    },
                },
            },
        ]);
    }

    refresh() {
        if (this.rendered) {
            this.timeline?.saveScrollPosition();
            this.render(true);
        }
    }

    updateStyle() {
        const backgroundColor = getSetting("backgroundColor") || getDefaultSetting("backgroundColor");
        const textColor = getSetting("textColor") || getDefaultSetting("textColor");
        const secretColor = getSetting("secretColor") || getDefaultSetting("secretColor");
        const failedColor = getSetting("failedColor") || getDefaultSetting("failedColor");
        const fontSize = getSetting("fontSize");
        const fontFamily = getSetting("fontFamily");
        const headerOnlyFont = getSetting("headerOnlyFont") === "default" ? fontFamily : getSetting("headerOnlyFont");
        const invertTheme = getSetting("invertTheme");

        const computedBackground = backgroundColor.length > 10 ? backgroundColor : backgroundColor + "eb";
        //in the event the background setting contains a complex background scene, extract the first hex color using regex
        const computedBackgroundColorOnly = backgroundColor.length > 10 ? computedBackground.match(/#(?:[0-9a-fA-F]{3}){1,2}/g)?.[0] ?? "#ffffff" : computedBackground;
        document.documentElement.style.setProperty("--simple-quest-font-family", fontFamily);
        document.documentElement.style.setProperty("--simple-quest-header-font-family", headerOnlyFont);
        document.documentElement.style.setProperty("--simple-quest-background", computedBackground);
        document.documentElement.style.setProperty("--simple-quest-background-color", computedBackgroundColorOnly);
        document.documentElement.style.setProperty("--simple-quest-hidden-color", secretColor);
        document.documentElement.style.setProperty("--simple-quest-failed-color", failedColor);
        document.documentElement.style.setProperty("--simple-quest-font-size", fontSize + "rem");
        document.documentElement.style.setProperty("--simple-quest-invert", invertTheme ? 1 : 0);

        //generate other colors
        const baseTextColor = new ColorHelper(textColor);
        const isDark = baseTextColor.l < 0.5;
        const textDesaturated = isDark ? baseTextColor.saturate(1.5) : baseTextColor.saturate(0.5);
        const textBright = isDark ? baseTextColor.brightness(0.7) : baseTextColor.brightness(1.3);
        const textDark = isDark ? baseTextColor.brightness(1.5) : baseTextColor.brightness(0.5);
        const textSaturated = isDark ? baseTextColor.saturate(0.5) : baseTextColor.saturate(1.5);

        document.documentElement.style.setProperty("--simple-quest-text-0", textBright);
        document.documentElement.style.setProperty("--simple-quest-text-1", textColor);
        document.documentElement.style.setProperty("--simple-quest-text-2", textDesaturated);
        document.documentElement.style.setProperty("--simple-quest-text-3", textSaturated);
        document.documentElement.style.setProperty("--simple-quest-text-4", textDark);
    }

    async render(...args) {
        for (const tabType of Object.keys(STATES)) {
            if (STATES[tabType].selected && this.element[0]) {
                const el = this.element[0].querySelector(`.tab[data-tab="${tabType}"] .quest-details`);
                if (el) {
                    this._questScroll[STATES[tabType].selected] = el.scrollTop;
                }
            }
        }
        if (this.element[0]) {
            TAB_SCROLL_STATES.achievements.scroll = this.element[0].querySelector(".achievements-list").scrollTop;
        }
        return super.render(...args);
    }

    async close(options = {}) {
        this.element[0].querySelectorAll(".tab").forEach((t) => t.classList.add("active"));
        this._saveScrollPositions(this.element);
        this._storedScrollPositions = this._scrollPositions;
        this.timeline?.saveScrollPosition();
        for (const [tabId, scrollData] of Object.entries(TAB_SCROLL_STATES)) {
            const tabEl = this.element[0].querySelector(`.tab[data-tab="${tabId}"] ${scrollData.sel}`);
            TAB_SCROLL_STATES[tabId].scroll = tabEl ? tabEl.scrollTop : 0;
        }

        document.removeEventListener("keydown", this._onEscape.bind(this));

        const states = Application.RENDER_STATES;
        if (!options.force && ![states.RENDERED, states.ERROR].includes(this._state)) return;
        this._state = states.CLOSING;

        // Get the element
        let el = this.element;
        if (!el) return (this._state = states.CLOSED);

        // Dispatch Hooks for closing the base and subclass applications
        for (let cls of this.constructor._getInheritanceChain()) {
            Hooks.call(`close${cls.name}`, this, el);
        }

        const html = this.element[0];
        return new Promise((resolve) => {
            html.animate([{ opacity: 1 }, { opacity: 0 }], {
                duration: 200,
                easing: "ease-in-out",
                fill: "forwards",
            }).onfinish = () => {
                html.remove();
                this._element = null;
                delete ui.windows[this.appId];
                this._minimized = false;
                this._state = states.CLOSED;
                resolve();
            };
        });
    }

    createDemoQuest() {
        createDemoQuest();
    }

    async importQuests(journal, name, { silent = false } = {}) {
        await this.getData();
        const existing = this._questJournals.find((j) => j.name === name);
        const proceed = silent || (await foundry.applications.api.DialogV2.confirm({ window: { title: game.i18n.localize(`${MODULE_ID}.importQuests.title`) + name }, content: game.i18n.localize(`${MODULE_ID}.importQuests.content`) }));
        if (!proceed) return;
        const folder = this._questFolder;
        const targetJournal = existing ?? (await JournalEntry.create({ name: name, folder: folder }));
        const pages = Array.from(journal.pages).map((p) => p.toObject());
        const createdPages = await targetJournal.createEmbeddedDocuments("JournalEntryPage", pages);
        await journal.delete();
        this.openToPage(createdPages[0].uuid);
    }

    static getKeyFromLi(li) {
        return li.innerText.replace(/\s/g, "").replace(/\./g, "").substring(0, 50);
    }

    static setHooks() {
        if (this._hooksRegistered) return;

        this._hooksRegistered = true;

        Hooks.on("createJournalEntry", (document, options) => {
            ui.simpleQuest.refresh();
        });

        Hooks.on("deleteJournalEntry", (document, options) => {
            ui.simpleQuest.refresh();
        });

        Hooks.on("createJournalEntryPage", (document, options) => {
            ui.simpleQuest.refresh();
        });

        Hooks.on("deleteJournalEntryPage", (document, options) => {
            ui.simpleQuest.refresh();
        });

        Hooks.on("updateJournalEntry", (document, updates) => {
            ui.simpleQuest.refresh();
        });
        Hooks.on("preUpdateJournalEntryPage", (document, updates) => {
            if (updates.text) document.updateSource({ flags: { [FLAG_SCOPE]: { [FLAG_ROOT]: { lastUpdated: Date.now() } } } });
        });
        Hooks.on("updateJournalEntryPage", (document, updates) => {
            ui.simpleQuest.refresh();
            const ownershipUpdate = updates?.ownership ?? updates?.["==ownership"];
            if (ownershipUpdate?.default >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER) {
                const isLore = ui.simpleQuest.isSimpleQuestPage(document.uuid) === "lore";
                isLore && showQuestNotification(document, true, true);
            }
            if (ownershipUpdate?.[game.user.id] >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER || ownershipUpdate?.default >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) {
                const isAchievements = ui.simpleQuest.isSimpleQuestPage(document.uuid) === "achievements";
                !game.user.isGM && isAchievements && showQuestNotification(document, true, false, true);
            }
            if (updates?.flags?.[FLAG_SCOPE]?.[FLAG_ROOT]?.lastUpdated) {
                const isQuest = ui.simpleQuest.isSimpleQuestPage(document.uuid) === "quests";
                isQuest && showQuestNotification(document);
            }
        });

        document.addEventListener("click", async (e) => {
            if (!e.target?.classList?.contains("share-quest-button")) return;
            e.preventDefault();
            const uuid = e.target.dataset.uuid;
            ui.simpleQuest.openToPage(uuid);
        });

        Hooks.on("createChatMessage", async (document, updates) => {
            const simpleQuestMessage = document.flags?.[FLAG_SCOPE]?.[FLAG_ROOT]?.simpleQuestMessage;
            if (simpleQuestMessage) {
                const page = await fromUuid(simpleQuestMessage);
                showQuestNotification(page, true);
            }
        });

        Hooks.on("renderJournalEntryPageTextSheet", (app, html, data) => {
            if (!data.editable) return;
            const journal = app.document.parent;
            if (journal !== STATES.achievements.journal) return;
            const filePickerInput = document.createElement("file-picker");
            filePickerInput.type = "image";
            filePickerInput.name = "src";
            filePickerInput._value = app.document.src || "icons/commodities/treasure/cup-trophy-gold.webp";
            filePickerInput.style.display = "none";
            const imagePreview = document.createElement("img");
            imagePreview.src = app.document.src || "icons/commodities/treasure/cup-trophy-gold.webp";
            imagePreview.style.height = "50px";
            imagePreview.style.maxWidth = "50px";
            imagePreview.style.marginRight = "0.5rem";
            imagePreview.style.cursor = "pointer";
            imagePreview.style.borderRadius = "5px";
            imagePreview.addEventListener("click", async (e) => {
                filePickerInput.button.click();
            });
            filePickerInput.addEventListener("change", async (e) => {
                const image = filePickerInput.value;
                imagePreview.src = image || "icons/commodities/treasure/cup-trophy-gold.webp";
            });
            const colorPicker = document.createElement("input");
            colorPicker.type = "color";
            colorPicker.name = `${FLAG_PATH}.color`;
            colorPicker.value = getSimpleQuestFlag(app.document, "color") || "#000000";
            colorPicker.style.maxWidth = "50px";
            colorPicker.style.minHeight = "50px";
            colorPicker.style.marginRight = "0.5rem";
            const header = html.querySelector(".journal-header .heading-level");
            header.before(filePickerInput, imagePreview, colorPicker);
        });
    }
}

class ColorHelper {
    constructor(hexColor) {
        this._color = new PIXI.Color(hexColor);
        this.r = this._color.red;
        this.g = this._color.green;
        this.b = this._color.blue;
        this.a = this._color.alpha;
        this._hsl = ColorHelper.rgbToHsl(this.r, this.g, this.b);
        this.h = this._hsl[0];
        this.s = this._hsl[1];
        this.l = this._hsl[2];
    }

    saturate(n) {
        return ColorHelper.rgbToHexString(...ColorHelper.hslToRgb(this.h, Math.min(1, this.s * n), this.l));
    }

    brightness(n) {
        return ColorHelper.rgbToHexString(...ColorHelper.hslToRgb(this.h, this.s, Math.min(1, this.l * n)));
    }

    static rgbToHsl(r, g, b) {
        let max = Math.max(r, g, b),
            min = Math.min(r, g, b);
        let h,
            s,
            l = (max + min) / 2;

        if (max == min) {
            h = s = 0; // achromatic
        } else {
            let d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

            switch (max) {
                case r:
                    h = (g - b) / d + (g < b ? 6 : 0);
                    break;
                case g:
                    h = (b - r) / d + 2;
                    break;
                case b:
                    h = (r - g) / d + 4;
                    break;
            }

            h /= 6;
        }

        return [h, s, l];
    }

    static hslToRgb(h, s, l) {
        let r, g, b;

        if (s == 0) {
            r = g = b = l; // achromatic
        } else {
            function hue2rgb(p, q, t) {
                if (t < 0) t += 1;
                if (t > 1) t -= 1;
                if (t < 1 / 6) return p + (q - p) * 6 * t;
                if (t < 1 / 2) return q;
                if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
                return p;
            }

            let q = l < 0.5 ? l * (1 + s) : l + s - l * s;
            let p = 2 * l - q;

            r = hue2rgb(p, q, h + 1 / 3);
            g = hue2rgb(p, q, h);
            b = hue2rgb(p, q, h - 1 / 3);
        }

        return [r, g, b];
    }

    static rgbToHexString(r, g, b) {
        (r *= 255), (g *= 255), (b *= 255);
        return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).substring(0, 6);
    }
}

class GlobalSearch {
    constructor(term, journals) {
        this.term = term.toLowerCase();
        this.journals = journals;
        this.textContentIndex = GlobalSearch.textContentIndex ?? new Map();
        if (!GlobalSearch.textContentIndex || this.expired) this.buildIndex();
    }

    get expired() {
        if (!GlobalSearch._lastIndex) return true;
        return Date.now() - GlobalSearch._lastIndex > 120000;
    }

    async buildIndex() {
        if (GlobalSearch._indexing) return;
        GlobalSearch._indexing = true;
        const newIndex = new Map();
        for (const j of this.journals) {
            const pages = j.pages;
            for (const p of pages) {
                //make sure the user has permission
                if (!p.isOwner) {
                    const perm = ui.simpleQuest.hasPermission(p.uuid);
                    if (!perm) continue;
                }
                const el = document.createElement("div");
                el.innerHTML = await foundry.applications.ux.TextEditor.implementation.enrichHTML(p.text.content, { secrets: game.user.isGM, relativeTo: p, async: true });
                const textContent = el.textContent.toLowerCase();
                newIndex.set(p, textContent);
            }
        }
        GlobalSearch.textContentIndex = newIndex;
        GlobalSearch._indexing = false;
        GlobalSearch._lastIndex = Date.now();
    }

    getResults() {
        if (GlobalSearch._indexing || GlobalSearch._indexing === undefined) {
            return [{ page: { name: game.i18n.localize(`${MODULE_ID}.search.indexing`) }, bestMatch: "", matchIndex: -1 }];
        }
        //find each match and it's surrounding text, take into consideration that a page can have multiple matches
        const results = [];
        for (const [page, text] of this.textContentIndex) {
            const matches = this.getMatches(text);
            if (matches.length) {
                matches.forEach((m) => {
                    const start = Math.max(0, m.index - 100);
                    const end = Math.min(text.length, m.index + 100);
                    let surroundingText = text.substring(start, end);
                    //remove first and last word
                    const firstSpace = surroundingText.indexOf(" ");
                    const lastSpace = surroundingText.lastIndexOf(" ");
                    surroundingText = surroundingText.substring(firstSpace, lastSpace);
                    surroundingText = surroundingText.trim();
                    surroundingText = `...${surroundingText}...`;
                    results.push({ page: page, bestMatch: surroundingText, matchIndex: matches.indexOf(m) });
                });
            }
            //exit early if results are more than 50
            if (results.length > 50) break;
        }
        return results;
    }

    getMatches(text) {
        //get the matches and the index of the occurence
        const matches = [];
        const regex = new RegExp(this.term, "gi");
        let match;
        while ((match = regex.exec(text)) !== null) {
            matches.push(match);
        }
        return matches;
    }
}
