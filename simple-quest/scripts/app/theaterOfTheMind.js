import { MODULE_ID, SYSTEM_PATH } from "../constants.js";
import { getSetting, setSetting } from "../settings.js";

export class TheaterOfTheMind extends Application {
    constructor(src) {
        super();
        this.src = src.src;
        this.ttmTitle = src.title;
        this.isVideo = this.src.toLowerCase().endsWith(".mp4") || this.src.toLowerCase().endsWith(".webm");
        ui.theaterOfTheMind?.close();
        ui.theaterOfTheMind = this;
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
            id: this.APP_ID,
            template: `${SYSTEM_PATH}/templates/${this.APP_ID}.hbs`,
            popOut: false,
            minimizable: false,
            title: game.i18n.localize(`${MODULE_ID}.${this.APP_ID}.title`),
        });
    }

    async getData() {
        return { src: this.src, isVideo: this.isVideo, title: this.ttmTitle };
    }

    activateListeners(html) {
        super.activateListeners(html);
        html = html[0] ?? html;
        document.querySelector("#interface").appendChild(html);
        html.onclick = () => html.classList.toggle("minimized");
        if (game.user.isGM) html.oncontextmenu = (e) => setSetting("ttmSrc", null);
    }

    async close() {
        ui.theaterOfTheMind = null;
        return super.close();
    }
}

export function setTTM(src) {
    src = src || getSetting("ttmSrc");
    if (!src?.src) return ui.theaterOfTheMind?.close();
    new TheaterOfTheMind(src).render(true);
}
