import { MODULE_ID } from "./constants.js";

const AUTO_IMPORT_STRING = "SimpleQuestAutoImport$";

export function initAutoImport() {
    if(!game.user.isGM) return;
    Hooks.on("createJournalEntry", (journal) => {
        if (journal.pack || !journal.name.startsWith(AUTO_IMPORT_STRING)) return;
        const [name, silent] = journal.name.replace(AUTO_IMPORT_STRING, "").split("|");
        ui.simpleQuest.importQuests(journal, name, {silent: silent === "silent"});
    });
}
