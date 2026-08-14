import { MODULE_ID, SYSTEM_PATH } from "../constants.js";
import { setSetting } from "../settings.js";

const getSystemAssetRoute = (path) => foundry.utils.getRoute(`${SYSTEM_PATH}/assets/${path}`);

const THEMES = {
    default: {
        backgroundColor: "#1b130d",
        textColor: "#f5deb3",
        secretColor: "#ff00ff",
        failedColor: "#ff0000",
        fontFamily: "Times New Roman",
    },
    redDragon: {
        backgroundColor: "#1b130d",
        textColor: "#e6415a",
        secretColor: "#0091ff",
        failedColor: "#ff7b00",
        fontFamily: "Signika",
        headerOnlyFont: "Modesto Condensed",
    },
    whiteDragon: {
        backgroundColor: "#f1ebe8",
        textColor: "#1c1c1c",
        secretColor: "#0091ff",
        failedColor: "#ff0000",
        fontFamily: "Signika",
        headerOnlyFont: "Modesto Condensed",
    },
    "D&D": {
        backgroundColor: `url("${getSystemAssetRoute("dnd5e-theme/texture1.webp")}") no-repeat top center / 150% auto, #f1ebe8 url("${getSystemAssetRoute("dnd5e-theme/texture2.webp")}") no-repeat bottom center / 150% auto`,
        textColor: "#1c1c1c",
        secretColor: "#0091ff",
        failedColor: "#ff0000",
        fontFamily: "Roboto Condensed",
        headerOnlyFont: "Modesto Condensed",
    },
    typewriter: {
        backgroundColor: "#d9ccc4",
        textColor: "#1c1c1c",
        secretColor: "#834b16",
        failedColor: "#ff0000",
        fontFamily: "Courier New",
    },
    postApocalypticWasteland: {
        backgroundColor: "#5c5c5c",
        textColor: "#bfbfbf",
        secretColor: "#008080",
        failedColor: "#cc3300",
        fontFamily: "Courier New",
    },
    cyberpunkCity: {
        backgroundColor: "#000000",
        textColor: "#00ffcc",
        secretColor: "#ff66b2",
        failedColor: "#ff3300",
        fontFamily: "Modesto Condensed",
    },
    galacticAdventure: {
        backgroundColor: "#0e0e0e",
        textColor: "#ffffff",
        secretColor: "#00ffcc",
        failedColor: "#ff0000",
        fontFamily: "Signika",
        headerOnlyFont: "Bruno Ace",
    },
    steampunkWorkshop: {
        backgroundColor: "#2b2b2b",
        textColor: "#b98946",
        secretColor: "#00ccff",
        failedColor: "#a52a2a",
        fontFamily: "Modesto Condensed",
    },
    dystopianFuture: {
        backgroundColor: "#333333",
        textColor: "#ff6666",
        secretColor: "#00ccff",
        failedColor: "#990000",
        fontFamily: "Currier New",
    },
    virtualRealityOasis: {
        backgroundColor: "#111111",
        textColor: "#00ffcc",
        secretColor: "#ff00ff",
        failedColor: "#ff3300",
        fontFamily: "Modesto Condensed",
    },
    mysticForest: {
        backgroundColor: "#003300",
        textColor: "#99cc66",
        secretColor: "#9933ff",
        failedColor: "#cc0000",
        fontFamily: "Amiri",
    },
    vintageFilmNoir: {
        backgroundColor: "#000000",
        textColor: "#ffffff",
        secretColor: "#9900cc",
        failedColor: "#cc0000",
        fontFamily: "Signika",
        headerOnlyFont: "Courier New",
    },
    sciFiConsole: {
        backgroundColor: "#000000",
        textColor: "#00ffcc",
        secretColor: "#ff66b2",
        failedColor: "#ff3300",
        fontFamily: "Courier",
    },
    futuristicTech: {
        backgroundColor: "#1a1a1a",
        textColor: "#99cc66",
        secretColor: "#3366ff",
        failedColor: "#cc0000",
        fontFamily: "Roboto",
    },
    alienInvasion: {
        backgroundColor: "#0a0a0a",
        textColor: "#00ccff",
        secretColor: "#ff00ff",
        failedColor: "#ff3300",
        fontFamily: "Signika",
    },
    ancientScrolls: {
        backgroundColor: "#f5e6cc",
        textColor: "#663300",
        secretColor: "#9933ff",
        failedColor: "#cc0000",
        fontFamily: "Times",
    },
    steampunkAdventure: {
        backgroundColor: "#2b2b2b",
        textColor: "#ffd700",
        secretColor: "#00ccff",
        failedColor: "#a52a2a",
        fontFamily: "Roboto Slab",
    },
};

export class ThemeConfig extends FormApplication {
    constructor() {
        super();
        ui.simpleQuest.render(true);
        setSetting("themeConfigShown", true);
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

    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: MODULE_ID + "-" + this.APP_ID,
            template: `${SYSTEM_PATH}/templates/${this.APP_ID}.hbs`,
            popOut: true,
            minimizable: true,
            title: game.i18n.localize(`${MODULE_ID}.${this.APP_ID}.title`),
            closeOnSubmit: true,
            width: 400,
        });
    }

    activateListeners(html) {
        super.activateListeners(html);
        html = html[0];
        html.querySelectorAll("button").forEach((button) => {
            button.addEventListener("click", (event) => {
                const theme = event.target.dataset.theme;
                this.setTheme(theme);
            });
        });
    }

    async setTheme(theme) {
        const themeConfig = THEMES[theme];
        if (themeConfig.headerOnlyFont === undefined) themeConfig.headerOnlyFont = "default";
        for (let key of Object.keys(themeConfig)) {
            await setSetting(key, themeConfig[key]);
        }
        this.setPosition({ height: "auto" });
    }

    async getData() {
        return {
            themes: Object.keys(THEMES).map((theme) => {
                return {
                    id: theme,
                    label: game.i18n.localize(`${MODULE_ID}.${this.APP_ID}.themes.${theme}`),
                };
            }),
        };
    }

    async _updateObject(event, formData) {}
}
