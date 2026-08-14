import { MODULE_ID, SYSTEM_PATH } from "./constants.js";
import { getSimpleQuestFlag } from "./flags.js";
import { getSetting, setSetting } from "./settings.js";

export async function createDefaultStructure() {
    const folderName = getSetting("folderName");
    const folder = Array.from(game.folders).find((f) => f.name === folderName && f.type === "JournalEntry");
    if (folder) return createPlayerJournal(folder);

    //create folder

    const folderDocument = await Folder.create({
        name: folderName,
        color: "#03bafc",
        sorting: "m",
        type: "JournalEntry",
        folder: null,
    });

    //create lore folder

    const loreFolder = await createLoreFolder();

    //create default quest journals

    const IN_PROGRESS = game.i18n.localize(`${MODULE_ID}.default-structure.in-progress`);
    const COMPLETED = game.i18n.localize(`${MODULE_ID}.default-structure.completed`);
    const FAILED = game.i18n.localize(`${MODULE_ID}.default-structure.failed`);

    const defaultJournalNames = [IN_PROGRESS, COMPLETED, FAILED];

    for (const name of defaultJournalNames) {
        const j = await JournalEntry.create({
            name: name,
            folder: folderDocument.id,
            ownership: {
                default: 0,
            },
        });

        if (name === IN_PROGRESS) {
            await j.createEmbeddedDocuments("JournalEntryPage", [getDemoPage("quest")]);
        }
    }

    //create default lore journals

    const LOCATIONS = game.i18n.localize(`${MODULE_ID}.default-structure.locations`);
    const NPCS = game.i18n.localize(`${MODULE_ID}.default-structure.npcs`);
    const ORGANIZATIONS = game.i18n.localize(`${MODULE_ID}.default-structure.organizations`);
    const HISTORY = game.i18n.localize(`${MODULE_ID}.default-structure.history`);
    const BESTIARY = game.i18n.localize(`${MODULE_ID}.default-structure.bestiary`);

    const defaultLoreNames = [LOCATIONS, NPCS, ORGANIZATIONS, HISTORY, BESTIARY];

    for (const name of defaultLoreNames) {
        const j = await JournalEntry.create({
            name: name,
            folder: loreFolder.id,
            ownership: {
                default: 0,
            },
        });

        if (name === LOCATIONS) {
            await j.createEmbeddedDocuments("JournalEntryPage", [getDemoPage("lore")]);
        }
    }

    //create party journal
    await createPlayerJournal(folderDocument);

    ui.notifications.info(game.i18n.localize(`${MODULE_ID}.notifications.defaultStructureCreated`));
}

export async function createPlayerJournal(folder) {
    const partyFolderName = getSetting("partyJournalName");
    let partyFolder = Array.from(game.folders).find((f) => f.name === partyFolderName && f.type === "JournalEntry" && f.folder === folder);
    if (!partyFolder) {
        partyFolder = await Folder.create({ name: partyFolderName, type: "JournalEntry", color: "#1fa87f", sorting: "m", folder: folder });
    }

    let updated = false;

    //create a page for each player

    const players = Array.from(game.users);
    const oldPlayerJournal = Array.from(game.journal).find((j) => j.name === partyFolderName && j.folder === folder);

    let migrated = false;

    for (const player of players) {
        let playerFolder = Array.from(game.folders).find((f) => f.name === player.name && f.type === "JournalEntry" && f.folder === partyFolder);
        if (!playerFolder) {
            updated = true;
            playerFolder = await Folder.create({ name: player.name, type: "JournalEntry", color: player.color, sorting: "m", folder: partyFolder.id });
            if (oldPlayerJournal) {
                const oldPage = oldPlayerJournal.pages.getName(player.name);
                const defaultJournal = await JournalEntry.create({
                    name: game.i18n.localize(`${MODULE_ID}.default-structure.default-journal`),
                    folder: playerFolder,
                    ownership: {
                        default: 0,
                        [player.id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
                    },
                    pages: [oldPage.toObject()],
                });
                migrated = true;
            }
        }
    }

    //create shared page for the party

    const sharedFolderName = getSetting("sharedJournalName");

    let sharedFolder = Array.from(game.folders).find((f) => f.name === sharedFolderName && f.type === "JournalEntry" && f.folder === partyFolder);
    if (!sharedFolder) {
        updated = true;
        sharedFolder = await Folder.create({ name: sharedFolderName, type: "JournalEntry", sorting: "m", folder: partyFolder.id });
        if (oldPlayerJournal) {
            const oldSharedPage = oldPlayerJournal.pages.getName(sharedFolderName);
            const sharedJournal = await JournalEntry.create({
                name: game.i18n.localize(`${MODULE_ID}.default-structure.default-journal`),
                folder: sharedFolder,
                ownership: {
                    default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
                },
                pages: [oldSharedPage.toObject()],
            });
        }
    }

    if (migrated) {
        oldPlayerJournal.update({ folder: null });
        ui.notifications.info("Simple Quest: Old Party and Player Journals were migrated to the new structure. You can delete the old journal now. It has been moved to the Root folder. You can delete it after checking that the migration was successful.", { permanent: true });
    }
    if (updated) ui.notifications.info(game.i18n.localize(`${MODULE_ID}.notifications.playerJournalUpdated`));
}

export async function createLoreFolder() {
    const loreFolderName = getSetting("loreFolderName");
    let loreFolder = Array.from(game.folders).find((f) => f.name === loreFolderName && f.type === "JournalEntry");
    if (!loreFolder) {
        loreFolder = await Folder.create({ name: loreFolderName, type: "JournalEntry", color: "#a85d1f", sorting: "m" });
    }
    return loreFolder;
}

export function showWelcomeScreen(force = false) {
    const welcomeMessage = getSetting("welcomeMessage");
    if (welcomeMessage && !force) return;
    Dialog.prompt({
        title: game.i18n.localize(`${MODULE_ID}.welcomeScreen.title`),
        content: game.i18n.localize(`${MODULE_ID}.welcomeScreen.content`),
        callback: () => {
            setSetting("welcomeMessage", true);
        },
        render: (html) => {
            html[0].closest(".app").classList.add("simple-quest-welcome-screen");
        },
    });
}

export function showWelcomeMaps(force = false) {
    const welcomeMaps = getSetting("welcomeMaps");
    if (welcomeMaps && !force) return;
    Dialog.prompt({
        title: game.i18n.localize(`${MODULE_ID}.welcomeMaps.title`),
        content: game.i18n.localize(`${MODULE_ID}.welcomeMaps.content`),
        options: {
            width: 600,
        },
        callback: () => {
            setSetting("welcomeMaps", true);
        },
        render: (html) => {
            html[0].closest(".app").classList.add("simple-quest-welcome-screen");
            html[0].closest(".app").classList.add("simple-quest-welcome-maps");
        },
        close: () => {},
    });
}

export function createDemoQuest() {
    const j = game.journal.getName(game.i18n.localize(`${MODULE_ID}.default-structure.in-progress`));
    if (!j) return;
    j.createEmbeddedDocuments("JournalEntryPage", [getDemoPage("quest")]);
}

export function showQuestNotification(page, newQuest = false, isLore = false, isAchievement = false) {
    if (!getSetting("showQuestNotifications")) return;
    const isHidden = getSimpleQuestFlag(page, "hidden");
    if (isHidden) return;

    const existing = document.querySelector(`.simple-quest-notification[data-uuid="${page.uuid}"]`);
    if (existing) return;

    const notificationContainer = document.getElementById("simple-quest-notification-container") || document.createElement("div");
    notificationContainer.id = "simple-quest-notification-container";

    document.body.appendChild(notificationContainer);

    const notification = document.createElement("div");
    notification.dataset.uuid = page.uuid;
    notification.classList.add("simple-quest-notification");
    const questName = `<span class="simple-quest-notification-quest-name">${page.name}</span>`;
    if (newQuest) {
        const sound = getSetting("newQuestSoundEffect");
        if (sound) foundry.audio.AudioHelper.play({src: sound, volume: game.settings.get("core", "globalInterfaceVolume"), loop: false});
        if (isLore) {
            notification.innerHTML = `<i class="fas fa-scroll-old"></i> ${game.i18n.localize(`${MODULE_ID}.shareLore.chatMessage`) + " " + questName}`;
        } else if (isAchievement) {
            notification.innerHTML = `<i class="fas fa-trophy"></i> ${game.i18n.localize(`${MODULE_ID}.shareAchievement.chatMessage`) + " " + questName}`;
        } else {
            notification.innerHTML = `<i class="fas fa-exclamation"></i> ${game.i18n.localize(`${MODULE_ID}.shareQuest.chatMessage`) + " " + questName}`;
        }
    } else {
        const sound = getSetting("updateQuestSoundEffect");
        if (sound) foundry.audio.AudioHelper.play({ src: sound, volume: game.settings.get("core", "globalInterfaceVolume"), loop: false });
        notification.innerHTML = `<i class="fas fa-exclamation"></i> ${game.i18n.localize(`${MODULE_ID}.questNotification.text`).replace("%q", questName)}`;
    }
    notificationContainer.appendChild(notification);

    const fontSize = getSetting("fontSize") * 2.5 + "rem";

    //animate opacity and scaleY to 1
    notification.animate(
        [
            { opacity: 0, height: "0rem" },
            { opacity: 1, height: fontSize },
        ],
        {
            duration: 500,
            easing: "ease-in-out",
        },
    );

    let dismissed = false;

    const dismiss = () => {
        if (dismissed) return;
        dismissed = true;
        notification.animate(
            [
                { opacity: 1, height: fontSize },
                { opacity: 0, height: "0rem" },
            ],
            {
                duration: 500,
                easing: "ease-in-out",
            },
        ).onfinish = () => {
            notificationContainer.removeChild(notification);
            if (notificationContainer.children.length === 0) {
                notificationContainer.remove();
            }
        };
    };

    notification.onmouseup = (e) => {
        //dismiss notification
        dismiss();
        //if left click, open quest
        if (e.button === 0) {
            ui.simpleQuest.openToPage(page.uuid);
        }
    };

    setTimeout(
        () => {
            dismiss();
        },
        newQuest ? 10000 : 5000,
    );
}

function getDemoPage(type) {
    return {
        name: game.i18n.localize(`${MODULE_ID}.demo.${type}.name`),
        "text.content": game.i18n.localize(`${MODULE_ID}.demo.${type}.content`),
    };
}
