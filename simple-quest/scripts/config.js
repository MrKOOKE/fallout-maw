import { FLAG_PATH, MODULE_ID } from "./constants.js";
import { getSimpleQuestFlag } from "./flags.js";
import { getSetting } from "./settings.js";

export function initConfig() {
    Hooks.on("getSceneControlButtons", (buttons) => {
        if (!buttons.notes?.tools || buttons.notes.tools.toggleSimpleQuest) return;
        buttons.notes.tools.toggleSimpleQuest ={
                name: "toggleSimpleQuest",
                title: game.i18n.localize(`${MODULE_ID}.hotkeys.toggleSimpleQuest.name`),
                icon: "fas fa-scroll-old",
                button: true,
                onChange: () => {
                    ui.simpleQuest.toggle();
                },
            }
    });

    Hooks.on("renderJournalDirectory", (app, html) => {
        const buttonContainer = html.querySelector(".header-actions.action-buttons");
        if (!buttonContainer || buttonContainer.querySelector(`.${MODULE_ID}-open-quest-app`)) return;
        const button = document.createElement("button");
        button.classList.add(`${MODULE_ID}-open-quest-app`);
        button.type = "button";
        button.innerHTML = `<i class="fas fa-scroll-old"></i><span>${game.i18n.localize(`${MODULE_ID}.simple-quest.title`)}</span>`;
        button.onclick = () => {
            ui.simpleQuest.toggle();
        };
        buttonContainer.appendChild(button);

        if (game.user.isGM) return;
        const hideForPlayers = getSetting("hideFolderFromPlayers");
        if (!hideForPlayers) return;
        const folder = Array.from(game.folders).find((f) => f.name === getSetting("folderName") && f.type === "JournalEntry");
        if (!folder) return;
        const folderEl = html.querySelector(`li[data-uuid="${folder.uuid}"]`);
        if (folderEl) folderEl.classList.add("simple-quest-hide-folder");
    });

    const PROSE_MIRROR_MENUS = {
        CALLOUT: [
            {
                id: "callout-lore",
                class: "notification lore",
            },
            {
                id: "callout-creature",
                class: "notification creature",
            },
            {
                id: "callout-npc",
                class: "notification npc",
            },
            {
                id: "callout-location",
                class: "notification location",
            },
            {
                id: "callout-magic",
                class: "notification magic",
            },
            {
                id: "callout-item",
                class: "notification item",
            },
            {
                id: "callout-event",
                class: "notification event",
            },
            {
                id: "callout-time",
                class: "notification time",
            },
        ],
        PAGE_INSERT: [
            {
                id: "parchment-note-1",
                class: "parchment-note-1",
            },
            {
                id: "parchment-note-2",
                class: "parchment-note-2",
            },
            {
                id: "parchment-note-3",
                class: "parchment-note-3",
            },
            {
                id: "parchment-note-4",
                class: "parchment-note-4",
            },
            {
                id: "parchment-book-1",
                class: "parchment-book-1",
            },
            {
                id: "parchment-book-2",
                class: "parchment-book-2",
            },
            {
                id: "parchment-scroll-1",
                class: "parchment-scroll-1",
            },
        ],
        TEXT: [
            {
                id: "paragraph-initial",
                class: "initial",
            },
        ],
    };

    const ALL_CLASSES = {
        CALLOUT: PROSE_MIRROR_MENUS.CALLOUT.map((c) => c.class),
        PAGE_INSERT: PROSE_MIRROR_MENUS.PAGE_INSERT.map((c) => c.class),
        COMBINED: [...PROSE_MIRROR_MENUS.CALLOUT.map((c) => c.class), ...PROSE_MIRROR_MENUS.PAGE_INSERT.map((c) => c.class)],
    };

    Hooks.on("getProseMirrorMenuDropDowns", (proseMirrorMenu, menus) => {
        const calloutMenu = {
            action: `${MODULE_ID}-callout`,
            title: `${MODULE_ID}.proseMirrorMenu.callout.title`,
            children: PROSE_MIRROR_MENUS.CALLOUT.map((c) => {
                return {
                    action: c.id,
                    title: `${MODULE_ID}.proseMirrorMenu.callout.${c.id}`,
                    priority: 3,
                    cmd: () => {
                        handleToggleClass(
                            proseMirrorMenu,
                            c.class,
                            ALL_CLASSES.COMBINED.filter((cc) => cc !== c.class),
                        );
                    },
                };
            }),
        };

        const pageInsertMenu = {
            action: `${MODULE_ID}-page-insert`,
            title: `${MODULE_ID}.proseMirrorMenu.pageInsert.title`,
            children: PROSE_MIRROR_MENUS.PAGE_INSERT.map((c) => {
                return {
                    action: c.id,
                    title: `${MODULE_ID}.proseMirrorMenu.pageInsert.${c.id}`,
                    priority: 3,
                    cmd: () => {
                        handleToggleClass(
                            proseMirrorMenu,
                            c.class,
                            ALL_CLASSES.COMBINED.filter((cc) => cc !== c.class),
                        );
                    },
                };
            }),
        };

        menus.format.entries.push(calloutMenu, pageInsertMenu);

        const inline = menus.format.entries.find((e) => e.action === "inline");
        inline.children.push({
            action: `${MODULE_ID}-initial`,
            title: `${MODULE_ID}.proseMirrorMenu.text.initial`,
            priority: 3,
            cmd: () => {
                handleToggleClass(proseMirrorMenu, "initial");
            },
        });
    });

    function handleToggleClass(menu, className, removeClasses = []) {
        const view = menu.view;
        const { state, dispatch } = view;
        const { from, to, $from } = state.selection;

        const paragraphInfo = findClosestAncestorOfType(state.doc.resolve(from), state.schema.nodes.paragraph);

        if (!paragraphInfo) return false;
        let currentClass = (paragraphInfo.node.attrs._preserve.class || "")
            .split(" ")
            .filter((c) => c)
            .join(" ");
        removeClasses.forEach((c) => {
            currentClass = currentClass.replace(c, "");
        });

        currentClass = currentClass
            .split(" ")
            .filter((c) => c)
            .join(" ");

        const newClass = currentClass.includes(className) ? currentClass.replace(className, "") : currentClass + " " + className;
        const prevAttrs = foundry.utils.deepClone(paragraphInfo.node.attrs);
        const prevAttrsClone = foundry.utils.deepClone(paragraphInfo.node.attrs);
        const newState = foundry.utils.mergeObject(prevAttrs, { _preserve: { class: newClass.trim() } });

        const tr = state.tr.setNodeMarkup(paragraphInfo.pos, undefined, newState);
        dispatch(tr);
        state.tr.setNodeMarkup(paragraphInfo.pos, undefined, foundry.utils.mergeObject(prevAttrsClone, { _preserve: { class: "" } }));
        //menu._handleSave.bind(menu)();
        //clear the classes
        return true;
    }

    function findClosestAncestorOfType($pos, nodeType) {
        for (let depth = $pos.depth; depth > 0; depth--) {
            const node = $pos.node(depth);
            if (node.type === nodeType) {
                return { pos: $pos.before(depth), node, originalPos: depth };
            }
        }
        return null;
    }

    Hooks.on("renderJournalEntryPageImageSheet", (app, html, data) => {
        const isMapPage = ui.simpleQuest.isSimpleQuestPage(app.document.uuid) === "map";
        if (!isMapPage) return;
        if(isMapPage && !game.user.isGM) return app.close();
        //find last form-group
        const formGroups = html.querySelectorAll(".form-group");
        const lastFormGroup = formGroups[formGroups.length - 1];
        const currentMask = getSimpleQuestFlag(app.document, "fowMask") || "";
        lastFormGroup.insertAdjacentHTML(
            "afterend",
            `<div class="form-group">
        <label>${game.i18n.localize(`${MODULE_ID}.injected.fowMask.label`)}</label>
        <file-picker name="${FLAG_PATH}.fowMask" type="image" value="${currentMask}"></file-picker>
    </div>`,
        );
        app.setPosition({ height: "auto" });
    });

    Hooks.on("renderJournalEntryPageTextSheet", (app, html, data) => {
        const isMapPage = ui.simpleQuest.isSimpleQuestPage(app.document.uuid) === "map";
        if (!isMapPage) return;
        if(isMapPage && !game.user.isGM) return app.close();
     });
}
