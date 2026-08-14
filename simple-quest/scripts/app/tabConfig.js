import { MODULE_ID, SYSTEM_PATH } from "../constants.js";
import { getTabNames, setSetting } from "../settings.js";

export class TabConfig extends FormApplication {
    constructor() {
        super();
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
            popOut: true,
            minimizable: true,
            title: game.i18n.localize(`${MODULE_ID}.${this.APP_ID}.title`),
            closeOnSubmit: true,
            width: 400,
        });
    }

    async getData() {
        return { ...getTabNames() };
    }

    async _updateObject(event, formData) {
        formData = foundry.utils.expandObject(formData);
        return setSetting("tabNames", formData);
    }
}
