import { MODULE_ID } from "./constants.js";
import { getSimpleQuestFlag } from "./flags.js";

export function initEnrichers() {
    const questEnricher = (icon) => {
        return (match, content) => {
            let [uuid, heading] = match[1].split("#");
            uuid = fromUuidSync(uuid, { relative: content.relativeTo })?.uuid;
            const name = match[2] || game.i18n.localize(`${MODULE_ID}.enricher.quest`);

            const a = document.createElement("a");
            a.classList.add("simple-quest-content-link");
            a.draggable = false;
            /*const hasPermission = ui.simpleQuest.hasPermission(uuid);
            if (!hasPermission) icon = "fa-lock";*/
            a.dataset.uuid = uuid;
            a.dataset.id = uuid;
            a.dataset.anchor = heading;
            a.dataset.tooltip = name;
            a.dataset.tooltipDirection = "UP";
            a.innerHTML = `<i class="fas ${uuid ? icon : "fa-link-slash"}"></i>${name}`;

            return a;
        };
    };

    CONFIG.TextEditor.enrichers.push(
        {
            id: MODULE_ID,
            pattern: /@time\[(.*?)\]/g,
            enricher: (match, content) => {
                try {
                    const a = document.createElement("a");
                    a.classList.add("simple-quest-time");
                    a.draggable = false;

                    if (!window.SimpleCalendar) {
                        a.innerHTML = `<i class="fa-duotone fa-hourglass-start"></i> ${game.i18n.localize(`${MODULE_ID}.time-enricher.calendar-not-installed`)}`;
                        return a;
                    }

                    let time;

                    const matchedTime = match[1];

                    const isOnlyNumbers = /^\d+$/.test(matchedTime);

                    if (isOnlyNumbers) {
                        time = parseInt(match[1]);
                    } else {
                        time = Date.parse(match[1]);
                        if (window.SimpleCalendar) {
                            //parse string, this is the format yyyy/mm/dd, hh:mm
                            const dateTimeParts = matchedTime.split(",");
                            const dateParts = dateTimeParts[0].trim().split("/");
                            const timeParts = (dateTimeParts[1] || "00:00").trim().split(":");
                            const year = parseInt(dateParts[0]);
                            const month = parseInt(dateParts[1]) - 1;
                            const day = parseInt(dateParts[2]) - 1;
                            const hour = parseInt(timeParts[0]);
                            const minute = parseInt(timeParts[1]);

                            time = window.SimpleCalendar.api.dateToTimestamp({ year: year, month: month, day: day, hour: hour, minute: minute });
                        }
                    }

                    const scDateTime = window.SimpleCalendar.api.timestampToDate(time);
                    a.dataset.tooltip = `${scDateTime.display.date} ${scDateTime.display.time}`;
                    a.dataset.tooltipDirection = "UP";

                    const delta = time - window.SimpleCalendar.api.timestamp();

                    if (delta < 0) {
                        a.innerHTML = `<i class="fa-duotone fa-hourglass-start"></i> ${game.i18n.localize(`${MODULE_ID}.time-enricher.expired`)}`;
                        return a;
                    }

                    const interval = window.SimpleCalendar.api.secondsToInterval(delta);
                    let timeString = ``;
                    if (interval.year) timeString += `${interval.year}y `;
                    if (interval.month || interval.year) timeString += `${interval.month}m `;
                    if (interval.day || interval.month || interval.year) timeString += `${interval.day}d `;
                    if (interval.hour || interval.day || interval.month || interval.year) timeString += `${interval.hour}h `;
                    if (interval.minute || interval.hour || interval.day || interval.month || interval.year) timeString += `${interval.minute}m `;

                    a.innerHTML = `<i class="fa-duotone fa-hourglass-start"></i> ${timeString}`;
                    return a;
                } catch (e) {
                    console.error(e);
                    const a = document.createElement("a");
                    a.innerHTML = `<i class="fa-duotone fa-hourglass-start"></i> ${game.i18n.localize(`${MODULE_ID}.time-enricher.parse-error`)}`;
                    return a;
                }
            },
        },
        {
            id: MODULE_ID + "-quest",
            pattern: /@QUEST\[(.*?)\]{(.*?)\}/g,
            enricher: questEnricher("fa-scroll-old"),
        },
        {
            id: MODULE_ID + "-map",
            pattern: /@MAP\[(.*?)\]{(.*?)\}/g,
            enricher: questEnricher("fa-map"),
        },
        {
            id: MODULE_ID + "-lore",
            pattern: /@LORE\[(.*?)\]{(.*?)\}/g,
            enricher: questEnricher("fa-books"),
        },
        {
            id: MODULE_ID + "-ttm",
            pattern: /@TTM\[(.*?)\]{(.*?)\}/g,
            enricher: (match, content) => {
                let src = match[1];
                //get first part of the src to determine if it's a local file or not, we need to split by /
                const srcParts = src.split("/");
                if (srcParts[0].includes(".")) src = "https://" + src;
                const titles = match[2].split("|");
                const title = titles[0];
                const displayTitle = titles[1] || "";
                const a = document.createElement("a");
                a.classList.add("simple-quest-ttm");
                a.dataset.src = src;
                if (game.user.isGM) a.dataset.tooltip = displayTitle + `<img src="${src}">`;
                a.dataset.tooltipDirection = "UP";
                a.dataset.title = displayTitle;
                a.draggable = false;
                a.innerHTML = `<i class="fas fa-theater-masks"></i> ${title}`;
                return a;
            },
        },
        {
            id: MODULE_ID + "-counter",
            pattern: /@COUNT\[(.*?)\]{(.*?)\}/g,
            enricher: (match, content) => {
                const id = match[1];
                const count = parseInt(match[2]);
                const page = content.relativeTo;
                const flag = getSimpleQuestFlag(page, "counters") ?? {};
                const value = flag[id] ?? 0;
                const a = document.createElement("a");
                a.classList.add("simple-quest-counter");
                a.dataset.uuid = page.uuid;
                a.dataset.id = id;
                a.dataset.count = count;
                a.draggable = false;
                a.innerHTML = `(${value} / ${count})`;
                return a;
            },
        },
        {
            id: MODULE_ID + "-counter-rep",
            pattern: /@REPUTATION\[(.*?)\]{(.*?)\}/g,
            enricher: (match, content) => {
                let [id, color, fa] = match[1].split(",");
                const isBar = id.includes("$bar");
                if (isBar) {
                    id = id.replace("$bar", "");
                }
                if (!isBar && fa && !fa.trim().includes(" ")) fa = `fas fa-${fa.trim()}`;
                let [min, max] = match[2].split(",");
                if (!max) {
                    max = min;
                    min = 0;
                }
                min = parseInt(min);
                max = parseInt(max);
                const count = max;
                const page = content.relativeTo;
                const flag = getSimpleQuestFlag(page, "counters") ?? {};
                const value = flag[id] ?? 0;
                const repContainer = document.createElement("div");
                repContainer.classList.add("simple-quest-counter");
                repContainer.classList.add("reputation-container");
                repContainer.dataset.uuid = page.uuid;
                repContainer.dataset.id = id;
                repContainer.dataset.count = count;
                repContainer.dataset.min = min;
                repContainer.dataset.tooltip = `${value} / ${count}`;
                repContainer.draggable = false;

                //create a div element for each reputation point
                if (isBar) {
                    const rep = document.createElement("div");
                    rep.classList.add("reputation-bar");
                    const percentage = (value - min) / (max - min);
                    rep.style.width = `${percentage * 100}%`;
                    const startGradientColor = "rgb(255, 0, 0)";
                    const endGradientColor = `rgb(${percentage < 0.5 ? 255 : Math.floor(255 - (percentage - 0.5) * 2 * 255)}, ${percentage > 0.5 ? 255 : Math.floor(percentage * 2 * 255)}, 0)`;
                    if (color && fa) {
                        const color1 = getRGBfromCSSColor(color);
                        const color2 = getRGBfromCSSColor(fa);
                        const interpolatedColor = `rgb(${Math.floor(lerp(color1.r, color2.r, percentage))}, ${Math.floor(lerp(color1.g, color2.g, percentage))}, ${Math.floor(lerp(color1.b, color2.b, percentage))})`;
                        const customGradient = `linear-gradient(to right, ${color}, ${interpolatedColor})`;
                        color = customGradient;
                    }

                    rep.style.background = color || `linear-gradient(to right, ${startGradientColor}, ${endGradientColor})`;
                    repContainer.appendChild(rep);
                    const barText = `${value} / ${count}`;
                    const i = document.createElement("i");
                    i.classList.add("reputation-bar-text");
                    i.innerText = barText;
                    //add a second text
                    const i2 = document.createElement("i");
                    i2.classList.add("reputation-bar-text");
                    i2.classList.add("overlay-text");
                    i2.innerText = barText;
                    repContainer.appendChild(i);
                    repContainer.appendChild(i2);
                } else {
                    for (let i = min; i < max; i++) {
                        const rep = fa ? document.createElement("i") : document.createElement("div");
                        rep.classList.add("reputation-point");
                        if (fa) rep.classList.add(...fa.split(" "), "is-fontawesome");
                        //min can be negative, so we need to normalize the value to be between 0 and 1
                        const percentage = (i - min) / (max - min);
                        const pipColor = color || `rgb(${percentage < 0.5 ? 255 : Math.floor(255 - (percentage - 0.5) * 2 * 255)}, ${percentage > 0.5 ? 255 : Math.floor(percentage * 2 * 255)}, 0)`;
                        rep.style.setProperty("--reputation-color", i < value ? pipColor : "inherit");

                        if (i < value) {
                            rep.classList.add("active");
                            if (!fa) rep.style.backgroundColor = pipColor;
                        }
                        repContainer.appendChild(rep);
                    }
                }

                return repContainer;
            },
        },
    );
}

function lerp(start, end, t) {
    return start * (1 - t) + end * t;
}

function getRGBfromCSSColor(color) {
    const temp = document.createElement("div");
    temp.style.color = color;
    document.body.appendChild(temp);
    const computedColor = window.getComputedStyle(temp).color;
    document.body.removeChild(temp);

    const matchRGB = computedColor.match(/\d+/g);

    return { r: parseInt(matchRGB[0]), g: parseInt(matchRGB[1]), b: parseInt(matchRGB[2]) };
}
