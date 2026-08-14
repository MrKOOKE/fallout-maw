import { FLAG_ROOT, FLAG_SCOPE, MODULE_ID, SYSTEM_PATH } from "../constants.js";
import { getSimpleQuestFlag } from "../flags.js";
import { getSetting, setSetting } from "../settings.js";

let YEAR_SEPARATOR = `<i class="fa-thin fa-arrow-right"></i>`;

export class Timeline extends Application {
    constructor(container) {
        super();
        this.container = container;
        const journalName = getSetting("timelineJournalName");
        this.journal = Array.from(game.journal).find((j) => j.name === journalName);
        this.scrollPosition = getSetting("timelineScroll") ?? 0;
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
            closeOnSubmit: false,
        });
    }

    async getData() {
        YEAR_SEPARATOR = game.i18n.localize(`${MODULE_ID}.timeline-config.to`);
        const YEAR_PIXEL_SCALE = Math.max(getSimpleQuestFlag(this.journal, "timeScale") ?? 10, 0.1);
        const USE_DYNAMIC = getSimpleQuestFlag(this.journal, "dynamicTimeScale") ?? false;
        const ERA_SCALES = {};

        const pages = Array.from(this.journal.pages);
        const negativeAbb = getSimpleQuestFlag(this.journal, "negativeAbb") ?? "BC";
        const positiveAbb = getSimpleQuestFlag(this.journal, "positiveAbb") ?? "AC";
        const showMinus = getSimpleQuestFlag(this.journal, "showMinus") ?? false;

        const erasData = [];
        const eventsData = {
            left: [],
            right: [],
        };

        const scrollbarDots = [];

        const eras = pages.filter((p) => p.flags[FLAG_SCOPE]?.[FLAG_ROOT]?.timeline?.isEra).sort((a, b) => getSimpleQuestFlag(a, "timeline").eraStart - getSimpleQuestFlag(b, "timeline").eraStart);

        const events = pages.filter((p) => !p.flags[FLAG_SCOPE]?.[FLAG_ROOT]?.timeline?.isEra && (p.flags[FLAG_SCOPE]?.[FLAG_ROOT]?.hidden !== true || game.user.isGM)).sort((a, b) => a.flags[FLAG_SCOPE]?.[FLAG_ROOT]?.timeline?.year - b.flags[FLAG_SCOPE]?.[FLAG_ROOT]?.timeline?.year);

        let erasCssGradient = "";

        eras.forEach((era) => {
            const eraEventsCount = events.filter((e) => e.flags[FLAG_SCOPE]?.[FLAG_ROOT]?.timeline?.year >= era.flags[FLAG_SCOPE]?.[FLAG_ROOT]?.timeline?.eraStart && e.flags[FLAG_SCOPE]?.[FLAG_ROOT]?.timeline?.year <= era.flags[FLAG_SCOPE]?.[FLAG_ROOT]?.timeline?.eraEnd).length;
            const eraLength = era.flags[FLAG_SCOPE]?.[FLAG_ROOT]?.timeline?.eraEnd - era.flags[FLAG_SCOPE]?.[FLAG_ROOT]?.timeline?.eraStart;
            if (USE_DYNAMIC) {
                ERA_SCALES[era.uuid] = (eraEventsCount + 1) * 300 * YEAR_PIXEL_SCALE;
            } else {
                ERA_SCALES[era.uuid] = eraLength * YEAR_PIXEL_SCALE;
            }
        });

        const totalHeight = Object.values(ERA_SCALES).reduce((a, b) => a + b, 0);

        for (let i = 0; i < eras.length; i++) {
            const era = eras[i];

            const nextEra = eras[i + 1];
            const eraStart = era.flags[FLAG_SCOPE]?.[FLAG_ROOT]?.timeline?.eraStart;
            const eraEnd = era.flags[FLAG_SCOPE]?.[FLAG_ROOT]?.timeline?.eraEnd || nextEra?.flags[FLAG_SCOPE]?.[FLAG_ROOT]?.timeline?.eraStart;
            const color = era.flags[FLAG_SCOPE]?.[FLAG_ROOT]?.timeline?.color;

            const prevEndPx = erasData[i - 1]?.endPx;
            const startPx = prevEndPx ?? 0;
            const endPx = ERA_SCALES[era.uuid] + startPx;
            const startPercent = startPx / totalHeight;
            const endPercent = (endPx / totalHeight) * 100;

            erasCssGradient += `${color} ${startPercent}%, ${color} ${endPercent}%, `;

            let startText = eraStart > 0 ? `${eraStart} ${positiveAbb}` : `${Math.abs(eraStart)} ${negativeAbb}`;
            let endText = eraEnd > 0 ? `${eraEnd} ${positiveAbb}` : `${Math.abs(eraEnd)} ${negativeAbb}`;
            if (eraStart < 0 && (!negativeAbb || showMinus)) startText = "-" + startText;
            if (eraEnd < 0 && (!negativeAbb || showMinus)) endText = "-" + endText;

            erasData.push({
                start: startText,
                end: endText,
                name: era.name,
                top: startPx,
                endPx: endPx,
                content: await foundry.applications.ux.TextEditor.implementation.enrichHTML(era.text.content, { secrets: game.user.isGM, relativeTo: era, async: true }),
                banner: era.flags[FLAG_SCOPE]?.[FLAG_ROOT]?.timeline?.banner,
                color: era.flags[FLAG_SCOPE]?.[FLAG_ROOT]?.timeline?.color,
                uuid: era.uuid,
                label: era.flags[FLAG_SCOPE]?.[FLAG_ROOT]?.timeline?.label,
            });
        }

        for (let i = 0; i < events.length; i++) {
            const event = events[i];
            const year = event.flags[FLAG_SCOPE]?.[FLAG_ROOT]?.timeline?.year;
            const era = eras.find((e) => year >= e.flags[FLAG_SCOPE]?.[FLAG_ROOT]?.timeline?.eraStart && year < e.flags[FLAG_SCOPE]?.[FLAG_ROOT]?.timeline?.eraEnd);
            if (!era) continue;
            const color = era.flags[FLAG_SCOPE]?.[FLAG_ROOT]?.timeline?.color;
            const percentYearInEra = (year - era.flags[FLAG_SCOPE]?.[FLAG_ROOT]?.timeline?.eraStart) / (era.flags[FLAG_SCOPE]?.[FLAG_ROOT]?.timeline?.eraEnd - era.flags[FLAG_SCOPE]?.[FLAG_ROOT]?.timeline?.eraStart);
            const duration = event.flags[FLAG_SCOPE]?.[FLAG_ROOT]?.timeline?.duration ?? 0;
            const percentYearInEraEnd = (year + duration - era.flags[FLAG_SCOPE]?.[FLAG_ROOT]?.timeline?.eraStart) / (era.flags[FLAG_SCOPE]?.[FLAG_ROOT]?.timeline?.eraEnd - era.flags[FLAG_SCOPE]?.[FLAG_ROOT]?.timeline?.eraStart);
            const top = ERA_SCALES[era.uuid] * percentYearInEra + erasData.find((e) => e.uuid === era.uuid).top;
            const percent = (top / totalHeight) * 100;
            const durationTop = ERA_SCALES[era.uuid] * percentYearInEraEnd + erasData.find((e) => e.uuid === era.uuid).top;
            const durationDelta = Math.round(durationTop - top);

            const yearText = year > 0 ? `${year} ${positiveAbb}` : `${showMinus ? "-" : ""}${Math.abs(year)} ${negativeAbb}`;
            const yearEndText = year + duration > 0 ? `${year + duration} ${positiveAbb}` : `${showMinus ? "-" : ""}${Math.abs(year + duration)} ${negativeAbb}`;
            const content = await foundry.applications.ux.TextEditor.implementation.enrichHTML(event.text.content, { secrets: game.user.isGM, relativeTo: era, async: true });
            const banner = event.flags[FLAG_SCOPE]?.[FLAG_ROOT]?.timeline?.banner;
            const uuid = event.uuid;
            const data = {
                name: event.name,
                content,
                banner,
                color,
                uuid,
                top: top + (event.flags[FLAG_SCOPE]?.[FLAG_ROOT]?.timeline?.offset ?? 0),
                year: yearText,
                yearEnd: duration ? yearEndText : null,
                era: era.name,
                eraUuid: era.uuid,
                hidden: event.flags[FLAG_SCOPE]?.[FLAG_ROOT]?.hidden,
                icon: event.flags[FLAG_SCOPE]?.[FLAG_ROOT]?.timeline?.icon,
                flipped: event.flags[FLAG_SCOPE]?.[FLAG_ROOT]?.timeline?.flipped,
                duration: durationDelta,
                label: event.flags[FLAG_SCOPE]?.[FLAG_ROOT]?.timeline?.label,
            };
            if (i % 2 === 0) {
                eventsData.left.push(data);
            } else {
                eventsData.right.push(data);
            }

            scrollbarDots.push({
                top: percent,
                uuid: event.uuid,
            });
        }

        erasCssGradient = erasCssGradient.slice(0, -2);

        const contentSetting = getSimpleQuestFlag(this.journal, "content") ?? "always";
        const showContentToggle = contentSetting !== "always";
        const collapsed = contentSetting === "toggleOff";
        return { height: totalHeight, erasData, eventsData, erasCssGradient, scrollbarDots, isGM: game.user.isGM, showContentToggle, collapsed, YEAR_SEPARATOR };
    }

    activateListeners(html) {
        super.activateListeners(html);
        html = html[0] ?? html;
        this.container.appendChild(html);
        html.querySelector("main section").scrollTo({ top: this.scrollPosition });
        html.querySelectorAll(".event-era").forEach((era) => {
            const uuid = era.dataset.uuid;
            era.addEventListener("click", (e) => {
                e.preventDefault();
                this.goTo(uuid);
            });
        });
        html.querySelectorAll(".timeline-scrollbar-dot").forEach((event) => {
            const uuid = event.dataset.uuid;
            event.addEventListener("click", (e) => {
                e.preventDefault();
                this.goTo(uuid);
            });
        });
        html.querySelectorAll(".content-collapse").forEach((el) => {
            const content = el.closest(".timeline-era, .timeline-event").querySelector(".timeline-content");
            el.addEventListener("click", (e) => {
                e.preventDefault();
                content.classList.toggle("collapsed");
            });
        });
        html.querySelectorAll(".timeline-event, .timeline-era").forEach((el) => {
            el.addEventListener("click", (e) => {
                const closestContainer = e.target.closest(".timeline-center, .timeline-right, .timeline-left");
                if (!closestContainer) return;
                //remove on-top class from all elements
                closestContainer.querySelectorAll(".on-top").forEach((el) => el.classList.remove("on-top"));
                //add on-top class to the clicked element
                el.classList.add("on-top");
            });
        });
        if (!game.user.isGM) return;
        html.querySelector("#add-timeline").addEventListener("click", async (e) => {
            const page = await this.journal.createEmbeddedDocuments("JournalEntryPage", [{
                name: game.i18n.localize(`${MODULE_ID}.timeline-config.newEvent`),
                type: "text",
            }]);
            new TimelineConfig(page[0]).render(true);
        });
        this.addConfigIcons(html);
    }

    addConfigIcons(html) {
        html.querySelectorAll(".timeline-era, .timeline-event").forEach((el) => {
            let target = el.querySelector("header");
            if (!target) return;
            const cogIcon = document.createElement("i");
            cogIcon.classList.add("fas", "fa-cog", "timeline-config-icon");
            cogIcon.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                const page = fromUuidSync(e.currentTarget.closest(".timeline-era, .timeline-event").dataset.uuid);
                new TimelineConfig(page).render(true);
            });
            target.appendChild(cogIcon);
        });
    }

    goTo(pageUuid) {
        const target = this.element[0].querySelector(`.timeline-era[data-uuid="${pageUuid}"], .timeline-event[data-uuid="${pageUuid}"]`);
        this.element[0].querySelector("main section").scrollTo({ top: target.offsetTop - target.offsetHeight, behavior: "smooth" });
    }

    configTimeline(uuid) {
        const page = fromUuidSync(uuid);
        new TimelineConfig(page).render(true);
    }

    saveScrollPosition() {
        const scroll = this.element[0].querySelector("main section").scrollTop;
        setSetting("timelineScroll", scroll);
    }
}

export class TimelineConfig extends FormApplication {
    constructor(document) {
        super();
        this.document = document;
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
            closeOnSubmit: false,
        });
    }

    async getData() {
        const timelineFlag = getSimpleQuestFlag(this.document, "timeline") ?? {};
        const hidden = getSimpleQuestFlag(this.document, "hidden") ?? false;
        const timeScale = getSimpleQuestFlag(this.document.parent, "timeScale") ?? 10;
        const negativeAbb = getSimpleQuestFlag(this.document.parent, "negativeAbb") ?? "BC";
        const positiveAbb = getSimpleQuestFlag(this.document.parent, "positiveAbb") ?? "AC";
        const dynamicTimeScale = getSimpleQuestFlag(this.document.parent, "dynamicTimeScale") ?? false;
        const content = getSimpleQuestFlag(this.document.parent, "content");
        const showMinus = getSimpleQuestFlag(this.document.parent, "showMinus") ?? false;
        timelineFlag.color = timelineFlag.color || "#ff0000";

        const contentChoices = {
            always: `${MODULE_ID}.timeline-config.contentChoices.always`,
            toggleOff: `${MODULE_ID}.timeline-config.contentChoices.toggleOff`,
            toggleOn: `${MODULE_ID}.timeline-config.contentChoices.toggleOn`,
        };

        return { ...timelineFlag, title: this.document.name, hidden, negativeAbb, positiveAbb, timeScale, dynamicTimeScale, content, contentChoices, showMinus };
    }

    activateListeners(html) {
        super.activateListeners(html);
        html = html[0] ?? html;
        html.querySelector("#edit-contents").addEventListener("click", (e) => {
            this.document.sheet.render(true);
        });
        html.querySelector("#delete").addEventListener("click", async (e) => {
            Dialog.confirm({
                title: game.i18n.localize(`${MODULE_ID}.deletePage.title`) + ` ${this.document.name}`,
                content: game.i18n.localize(`${MODULE_ID}.deletePage.content`),
                yes: async () => {
                    await this.document.parent.deleteEmbeddedDocuments("JournalEntryPage", [this.document.id]);
                    this.close();
                },
                no: () => {},
                defaultYes: false,
            });
        });
        html.querySelectorAll(".era-event-switch span").forEach((el) => {
            el.addEventListener("click", (e) => {
                e.preventDefault();
                html.querySelector(".era-event-switch .selected").classList.remove("selected");
                el.classList.add("selected");
                this.setTypeVisibility();
            });
        });
        this.setTypeVisibility();
    }

    setTypeVisibility() {
        const selectedType = this.element[0].querySelector(".era-event-switch .selected").dataset.type;
        const targetFieldset = this.element[0].querySelector(`fieldset.${selectedType === "era" ? "event" : "era"}-fieldset`);
        const otherFieldset = this.element[0].querySelector(`fieldset.${selectedType}-fieldset`);
        targetFieldset.style.filter = "grayscale(1)";
        targetFieldset.style.pointerEvents = "none";
        targetFieldset.style.opacity = "0.5";
        otherFieldset.style.filter = "none";
        otherFieldset.style.pointerEvents = "auto";
        otherFieldset.style.opacity = "1";
    }

    async _updateObject(event, formData) {
        formData = foundry.utils.expandObject(formData);
        //get the isEra
        formData.isEra = this.element[0].querySelector(".era-event-switch .selected").dataset.type === "era";
        if (!formData.ignoreDataValidation) {
            try {
                this.validateData(formData);
            } catch (error) {
                console.error(error);
                return;
            }
        }
        delete formData.ignoreDataValidation;
        const journalFlags = ["negativeAbb", "positiveAbb", "timeScale", "dynamicTimeScale", "content", "showMinus"];
        await this.document.parent.update({
            flags: {
                [FLAG_SCOPE]: {
                    [FLAG_ROOT]: journalFlags.reduce((acc, flag) => {
                        acc[flag] = formData[flag];
                        return acc;
                    }, {}),
                },
            },
        });
        journalFlags.forEach((flag) => delete formData[flag]);
        const hidden = formData.hidden;
        delete formData.hidden;
        await this.document.update({
            name: formData.title,
            flags: {
                [FLAG_SCOPE]: {
                    [FLAG_ROOT]: {
                        timeline: formData,
                        hidden: hidden,
                    },
                },
            },
        });
        //sort pages by year
        const updates = [];
        const journal = this.document.parent;
        const pages = Array.from(journal.pages);
        for (const page of pages) {
            const flagData = getSimpleQuestFlag(page, "timeline") ?? {};
            const sort = flagData.isEra ? flagData.eraStart : flagData.year;
            updates.push({ _id: page.id, sort });
        }
        await journal.updateEmbeddedDocuments("JournalEntryPage", updates);
        this.close();
    }

    validateData(expanded) {
        //Check that at least one era is present or that the data is an era
        const eras = Array.from(this.document.parent.pages)
            .filter((p) => getSimpleQuestFlag(p, "timeline")?.isEra)
            .filter((p) => p.id !== this.document.id);
        if (eras.length === 0 && !expanded.isEra) {
            const errorString = game.i18n.localize(`${MODULE_ID}.timeline-config.errors.noEra`);
            ui.notifications.error(errorString);
            throw new Error(errorString);
        }
        const isFirstEra = eras.length === 0 && expanded.isEra;
        //if the entry is not an era, check that it has a year and that it is within the bounds of the eras
        if (!expanded.isEra) {
            const year = expanded.year;
            if (year === undefined || year === null || year === "") {
                const errorString = game.i18n.localize(`${MODULE_ID}.timeline-config.errors.noYear`);
                ui.notifications.error(errorString);
                throw new Error(errorString);
            }
            const era = eras.find((e) => getSimpleQuestFlag(e, "timeline").eraStart <= year && getSimpleQuestFlag(e, "timeline").eraEnd >= year);
            if (!era) {
                const errorString = game.i18n.localize(`${MODULE_ID}.timeline-config.errors.yearOutOfBounds`);
                ui.notifications.error(errorString);
                throw new Error(errorString);
            }
        }

        //if it's an era, check that it has a start year and that it is less than the end year
        if (expanded.isEra) {
            const eraStart = expanded.eraStart;
            const eraEnd = expanded.eraEnd;
            if (eraStart === undefined || eraStart === null || eraStart === "") {
                const errorString = game.i18n.localize(`${MODULE_ID}.timeline-config.errors.noEraStart`);
                ui.notifications.error(errorString);
                throw new Error(errorString);
            }
            if (eraEnd === undefined || eraEnd === null || eraEnd === "") {
                const errorString = game.i18n.localize(`${MODULE_ID}.timeline-config.errors.noEraEnd`);
                ui.notifications.error(errorString);
                throw new Error(errorString);
            }
            if (eraStart >= eraEnd) {
                const errorString = game.i18n.localize(`${MODULE_ID}.timeline-config.errors.eraStartAfterEnd`);
                ui.notifications.error(errorString);
                throw new Error(errorString);
            }

            if (!isFirstEra) {
                //check that the start of the era matches with the end of another era or that the end of the era matches with the start of another era
                const previousEra = eras.find((e) => getSimpleQuestFlag(e, "timeline").eraEnd === eraStart);
                const nextEra = eras.find((e) => getSimpleQuestFlag(e, "timeline").eraStart === eraEnd);
                if (!previousEra && !nextEra) {
                    const errorString = game.i18n.localize(`${MODULE_ID}.timeline-config.errors.eraNotConnected`);
                    ui.notifications.error(errorString);
                    throw new Error(errorString);
                }

                //check that the era doesn't overlap with another era
                const overlappingEra = eras.find((e) => (getSimpleQuestFlag(e, "timeline").eraStart < eraStart && getSimpleQuestFlag(e, "timeline").eraEnd > eraStart) || (getSimpleQuestFlag(e, "timeline").eraStart < eraEnd && getSimpleQuestFlag(e, "timeline").eraEnd > eraEnd));
                if (overlappingEra) {
                    const errorString = game.i18n.localize(`${MODULE_ID}.timeline-config.errors.eraOverlap`);
                    ui.notifications.error(errorString);
                    throw new Error(errorString);
                }
            }
        }
    }
}

