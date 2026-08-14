import {MODULE_ID} from "./constants.js";


const l = (key) => game.i18n.localize(key);

export function registerTours() {
    
    game.tours.register(MODULE_ID, "interface", new foundry.nue.Tour({
        title: `${MODULE_ID}.tours.interface.name`,
        description: `${MODULE_ID}.tours.interface.description`,
        canBeResumed: false,
        display: true,
        steps: [
            {
                id: `${MODULE_ID}.tours.interface.1`,
                title: `${MODULE_ID}.tours.interface.1.title`,
                content: `${MODULE_ID}.tours.interface.1.content`,
                selector: "#simple-quest .sheet-tabs.tabs",
            },
            {
                id: `${MODULE_ID}.tours.interface.2`,
                title: `${MODULE_ID}.tours.interface.2.title`,
                content: `${MODULE_ID}.tours.interface.2.content`,
                selector: "#simple-quest .tab[data-tab='quests'] .quest-list",
                tooltipDirection: "RIGHT",
            },
            {
                id: `${MODULE_ID}.tours.interface.3`,
                title: `${MODULE_ID}.tours.interface.3.title`,
                content: `${MODULE_ID}.tours.interface.3.content`,
                selector: "#simple-quest .tab[data-tab='quests'] .quest-details",
                tooltipDirection: "LEFT",
            },
            {
                id: `${MODULE_ID}.tours.interface.4`,
                title: `${MODULE_ID}.tours.interface.4.title`,
                content: `${MODULE_ID}.tours.interface.4.content`,
                selector: "#simple-quest .font-controls",
            }
        ]
    }))

    game.tours.register(MODULE_ID, "lore-tab", new foundry.nue.Tour({
        title: `${MODULE_ID}.tours.lore-tab.name`,
        description: `${MODULE_ID}.tours.lore-tab.description`,
        canBeResumed: false,
        display: true,
        steps: [
            {
                id: `${MODULE_ID}.tours.lore-tab.1`,
                title: `${MODULE_ID}.tours.lore-tab.1.title`,
                content: `${MODULE_ID}.tours.lore-tab.1.content`,
                selector: "#simple-quest-tabs",
                tooltipDirection: "UP",
            },
            {
                id: `${MODULE_ID}.tours.lore-tab.2`,
                title: `${MODULE_ID}.tours.lore-tab.2.title`,
                content: `${MODULE_ID}.tours.lore-tab.2.content`,
                selector: "#simple-quest .tab[data-tab='lore'] .quest-list",
                tooltipDirection: "RIGHT",
            },
            {
                id: `${MODULE_ID}.tours.lore-tab.3`,
                title: `${MODULE_ID}.tours.lore-tab.3.title`,
                content: `${MODULE_ID}.tours.lore-tab.3.content`,
                selector: "#simple-quest .tab[data-tab='lore'] .quest-details",
                tooltipDirection: "LEFT",
            }
        ]
    }))

    //map tour here

    game.tours.register(MODULE_ID, "map-tab", new foundry.nue.Tour({
        title: `${MODULE_ID}.tours.map-tab.name`,
        description: `${MODULE_ID}.tours.map-tab.description`,
        canBeResumed: false,
        display: true,
        steps: [
            {
                id: `${MODULE_ID}.tours.map-tab.1`,
                title: `${MODULE_ID}.tours.map-tab.1.title`,
                content: `${MODULE_ID}.tours.map-tab.1.content`,
                selector: "#simple-quest-tabs",
                tooltipDirection: "UP",
            },
            {
                id: `${MODULE_ID}.tours.map-tab.2`,
                title: `${MODULE_ID}.tours.map-tab.2.title`,
                content: `${MODULE_ID}.tours.map-tab.2.content`,
                selector: "#simple-quest .tab[data-tab='map'] .maps-list",
                tooltipDirection: "RIGHT",
            },
            {
                id: `${MODULE_ID}.tours.map-tab.3`,
                title: `${MODULE_ID}.tours.map-tab.3.title`,
                content: `${MODULE_ID}.tours.map-tab.3.content`,
                selector: "#simple-quest .tab[data-tab='map'] .map-details",
                tooltipDirection: "LEFT",
            },
            {
                id: `${MODULE_ID}.tours.map-tab.4`,
                title: `${MODULE_ID}.tours.map-tab.4.title`,
                content: `${MODULE_ID}.tours.map-tab.4.content`,
                selector: "#simple-quest .tab[data-tab='map'] .map-details",
                tooltipDirection: "LEFT",
            },
            {
                id: `${MODULE_ID}.tours.map-tab.5`,
                title: `${MODULE_ID}.tours.map-tab.5.title`,
                content: `${MODULE_ID}.tours.map-tab.5.content`,
                selector: "#simple-quest .tab[data-tab='map'] .map-details",
                tooltipDirection: "LEFT",
            },
            {
                id: `${MODULE_ID}.tours.map-tab.6`,
                title: `${MODULE_ID}.tours.map-tab.6.title`,
                content: `${MODULE_ID}.tours.map-tab.6.content`,
                selector: "#simple-quest .tab[data-tab='map'] .map-details",
                tooltipDirection: "LEFT",
            }
        ]
    }))





    game.tours.register(MODULE_ID, "my-journal-tab", new foundry.nue.Tour({
        title: `${MODULE_ID}.tours.my-journal-tab.name`,
        description: `${MODULE_ID}.tours.my-journal-tab.description`,
        canBeResumed: false,
        display: true,
        steps: [
            {
                id: `${MODULE_ID}.tours.my-journal-tab.1`,
                title: `${MODULE_ID}.tours.my-journal-tab.1.title`,
                content: `${MODULE_ID}.tours.my-journal-tab.1.content`,
                selector: "#simple-quest-tabs",
                tooltipDirection: "UP",
            },
            {
                id: `${MODULE_ID}.tours.my-journal-tab.2`,
                title: `${MODULE_ID}.tours.my-journal-tab.2.title`,
                content: `${MODULE_ID}.tours.my-journal-tab.2.content`,
                selector: "#simple-quest .tab[data-tab='my-journal'] .journal-toc-list",
                tooltipDirection: "RIGHT",
            },
            {
                id: `${MODULE_ID}.tours.my-journal-tab.3`,
                title: `${MODULE_ID}.tours.my-journal-tab.3.title`,
                content: `${MODULE_ID}.tours.my-journal-tab.3.content`,
                selector: "#simple-quest .tab[data-tab='my-journal'] .journal-container",
                tooltipDirection: "LEFT",
            }
        ]
    }))

    game.tours.register(MODULE_ID, "party-journal-tab", new foundry.nue.Tour({
        title: `${MODULE_ID}.tours.party-journal-tab.name`,
        description: `${MODULE_ID}.tours.party-journal-tab.description`,
        canBeResumed: false,
        display: true,
        steps: [
            {
                id: `${MODULE_ID}.tours.party-journal-tab.1`,
                title: `${MODULE_ID}.tours.party-journal-tab.1.title`,
                content: `${MODULE_ID}.tours.party-journal-tab.1.content`,
                selector: "#simple-quest-tabs",
                tooltipDirection: "UP",
            },
            {
                id: `${MODULE_ID}.tours.party-journal-tab.2`,
                title: `${MODULE_ID}.tours.party-journal-tab.2.title`,
                content: `${MODULE_ID}.tours.party-journal-tab.2.content`,
                selector: "#simple-quest .tab[data-tab='party-journal'] .journal-toc-list",
                tooltipDirection: "RIGHT",
            },
            {
                id: `${MODULE_ID}.tours.party-journal-tab.3`,
                title: `${MODULE_ID}.tours.party-journal-tab.3.title`,
                content: `${MODULE_ID}.tours.party-journal-tab.3.content`,
                selector: "#simple-quest .tab[data-tab='party-journal'] .journal-container",
                tooltipDirection: "LEFT",
            }
        ]
    }))

    //journal page tour

    game.tours.register(MODULE_ID, "journal-page", new foundry.nue.Tour({
        title: `${MODULE_ID}.tours.journal-page.name`,
        description: `${MODULE_ID}.tours.journal-page.description`,
        canBeResumed: false,
        display: true,
        steps: [
            {
                id: `${MODULE_ID}.tours.journal-page.1`,
                title: `${MODULE_ID}.tours.journal-page.1.title`,
                content: `${MODULE_ID}.tours.journal-page.1.content`,
                selector: ".simple-quest-page-template",
                tooltipDirection: "RIGHT",
            },
            {
                id: `${MODULE_ID}.tours.journal-page.2`,
                title: `${MODULE_ID}.tours.journal-page.2.title`,
                content: `${MODULE_ID}.tours.journal-page.2.content`,
                selector: ".pm-dropdown.format",
                tooltipDirection: "LEFT",
            }
        ]
    }))

    //timeline tab tour

    game.tours.register(MODULE_ID, "timeline-tab", new foundry.nue.Tour({
        title: `${MODULE_ID}.tours.timeline-tab.name`,
        description: `${MODULE_ID}.tours.timeline-tab.description`,
        canBeResumed: false,
        display: true,
        steps: [
            {
                id: `${MODULE_ID}.tours.timeline-tab.1`,
                title: `${MODULE_ID}.tours.timeline-tab.1.title`,
                content: `${MODULE_ID}.tours.timeline-tab.1.content`,
                selector: "#simple-quest-tabs",
                tooltipDirection: "UP",
            },
            {
                id: `${MODULE_ID}.tours.timeline-tab.2`,
                title: `${MODULE_ID}.tours.timeline-tab.2.title`,
                content: `${MODULE_ID}.tours.timeline-tab.2.content`,
                selector: "#simple-quest .tab[data-tab='timeline'] .quest-list",
                tooltipDirection: "RIGHT",
            },
            {
                id: `${MODULE_ID}.tours.timeline-tab.3`,
                title: `${MODULE_ID}.tours.timeline-tab.3.title`,
                content: `${MODULE_ID}.tours.timeline-tab.3.content`,
                selector: "#simple-quest .tab[data-tab='timeline'] nav",
                tooltipDirection: "LEFT",
                restricted: true,
            }
        ]
    }))


}
