import { deepMerge } from "../utilities/object";
import { GameSettings } from "../foundry-interfacing/game-settings";
import { GetIcon } from "../utilities/visual";
import { CompactViewDateTimeControlDisplay, Icons } from "../../constants";

export class DateTimeControls {
    private static defaultOptions: FalloutMaWCalendar.Renderer.DateTimeControlOptions = {
        showDateControls: true,
        showTimeControls: true,
        showPresetTimeOfDay: true,
        displayType: CompactViewDateTimeControlDisplay.Full,
        fullDisplay: {
            unit: "",
            unitText: "",
            dateTimeUnitOpen: false
        },
        reverseTime: false,
        largerSteps: false
    };
    public static Render(options: FalloutMaWCalendar.Renderer.DateTimeControlOptions = {}): string {
        options = deepMerge({}, this.defaultOptions, options);
        let html = '<div class="fallout-maw-calendar-controls fallout-maw-calendar-unit-controls">';
        if (options.displayType === CompactViewDateTimeControlDisplay.Full) {
            html += `<div class="fallout-maw-calendar-control-group">
                        <button class="fallout-maw-calendar-control fallout-maw-calendar-primary" data-tooltip="${GameSettings.Localize("FALLOUTMAW.Calendar.MoveBackwardFive")}" data-type="${options
                            .fullDisplay?.unit}" data-amount="-5"><span class="fa fa-angle-double-left"></span></button>
                        <button class="fallout-maw-calendar-control fallout-maw-calendar-primary" data-tooltip="${GameSettings.Localize("FALLOUTMAW.Calendar.MoveBackwardOne")}" data-type="${options
                            .fullDisplay?.unit}" data-amount="-1"><span class="fa fa-angle-left"></span></button>
                        <button class="fallout-maw-calendar-control fallout-maw-calendar-primary fallout-maw-calendar-selector" data-unit="time">${GameSettings.Localize(
                            options.fullDisplay?.unitText || ""
                        )}&nbsp;</button>
                        <button class="fallout-maw-calendar-control fallout-maw-calendar-primary" data-tooltip="${GameSettings.Localize("FALLOUTMAW.Calendar.MoveForwardOne")}" data-type="${options
                            .fullDisplay?.unit}" data-amount="1"><span class="fa fa-angle-right"></span></button>
                        <button class="fallout-maw-calendar-control fallout-maw-calendar-primary" data-tooltip="${GameSettings.Localize("FALLOUTMAW.Calendar.MoveForwardFive")}" data-type="${options
                            .fullDisplay?.unit}" data-amount="5"><span class="fa fa-angle-double-right"></span></button>
                        <ul class="fallout-maw-calendar-unit-list fallout-maw-calendar-time-units fallout-maw-calendar-primary ${options.fullDisplay?.dateTimeUnitOpen ? "fallout-maw-calendar-open" : "fallout-maw-calendar-closed"}">`;
            if (options.showTimeControls) {
                html += `<li class="${options.fullDisplay?.unit === "seconds" ? "fallout-maw-calendar-selected" : ""}" data-unit="seconds">${GameSettings.Localize(
                    "FALLOUTMAW.Calendar.Second"
                )}</li>
                        <li class="${options.fullDisplay?.unit === "round" ? "fallout-maw-calendar-selected" : ""}" data-unit="round">${GameSettings.Localize(
                            "FALLOUTMAW.Calendar.Round"
                        )}</li>
                        <li class="${options.fullDisplay?.unit === "minute" ? "fallout-maw-calendar-selected" : ""}" data-unit="minute">${GameSettings.Localize(
                            "FALLOUTMAW.Calendar.Minute"
                        )}</li>
                        <li class="${options.fullDisplay?.unit === "hour" ? "fallout-maw-calendar-selected" : ""}" data-unit="hour">${GameSettings.Localize(
                            "FALLOUTMAW.Calendar.Hour"
                        )}</li>`;
            }
            if (options.showDateControls) {
                html += `<li class="${options.fullDisplay?.unit === "day" ? "fallout-maw-calendar-selected" : ""}" data-unit="day">${GameSettings.Localize(
                    "FALLOUTMAW.Calendar.Day"
                )}</li>
                        <li class="${options.fullDisplay?.unit === "month" ? "fallout-maw-calendar-selected" : ""}" data-unit="month">${GameSettings.Localize(
                            "FALLOUTMAW.Calendar.Month"
                        )}</li>
                        <li class="${options.fullDisplay?.unit === "year" ? "fallout-maw-calendar-selected" : ""}" data-unit="year">${GameSettings.Localize(
                            "FALLOUTMAW.Calendar.Year"
                        )}</li>`;
            }
            html += "</ul></div>";
        } else if (options.displayType === CompactViewDateTimeControlDisplay.QuickIncrement) {
            let btn: { type: string; amount: number; tooltip: string; text: string }[] = [];
            if (options.showTimeControls) {
                btn = [
                    {
                        type: "round",
                        amount: (options.largerSteps ? 5 : 1) * (options.reverseTime ? -1 : 1),
                        tooltip: GameSettings.Localize("FALLOUTMAW.Calendar.Round"),
                        text: GameSettings.Localize("FALLOUTMAW.Calendar.RoundShorthand")
                    },
                    {
                        type: "minute",
                        amount: (options.largerSteps ? 5 : 1) * (options.reverseTime ? -1 : 1),
                        tooltip: GameSettings.Localize("FALLOUTMAW.Calendar.Minute"),
                        text: GameSettings.Localize("FALLOUTMAW.Calendar.MinuteShorthand")
                    },
                    {
                        type: "minute",
                        amount: (options.largerSteps ? 20 : 5) * (options.reverseTime ? -1 : 1),
                        tooltip: GameSettings.Localize("FALLOUTMAW.Calendar.Minute"),
                        text: GameSettings.Localize("FALLOUTMAW.Calendar.MinuteShorthand")
                    },
                    {
                        type: "minute",
                        amount: (options.largerSteps ? 45 : 15) * (options.reverseTime ? -1 : 1),
                        tooltip: GameSettings.Localize("FALLOUTMAW.Calendar.Minute"),
                        text: GameSettings.Localize("FALLOUTMAW.Calendar.MinuteShorthand")
                    },
                    {
                        type: "hour",
                        amount: (options.largerSteps ? 5 : 1) * (options.reverseTime ? -1 : 1),
                        tooltip: GameSettings.Localize("FALLOUTMAW.Calendar.Hour"),
                        text: GameSettings.Localize("FALLOUTMAW.Calendar.HourShorthand")
                    }
                ];
            } else if (options.showDateControls) {
                btn = [
                    {
                        type: "day",
                        amount: (options.largerSteps ? 5 : 1) * (options.reverseTime ? -1 : 1),
                        tooltip: GameSettings.Localize("FALLOUTMAW.Calendar.Day"),
                        text: GameSettings.Localize("FALLOUTMAW.Calendar.Day")
                    },
                    {
                        type: "month",
                        amount: (options.largerSteps ? 5 : 1) * (options.reverseTime ? -1 : 1),
                        tooltip: GameSettings.Localize("FALLOUTMAW.Calendar.Month"),
                        text: GameSettings.Localize("FALLOUTMAW.Calendar.Month")
                    },
                    {
                        type: "year",
                        amount: (options.largerSteps ? 5 : 1) * (options.reverseTime ? -1 : 1),
                        tooltip: GameSettings.Localize("FALLOUTMAW.Calendar.Year"),
                        text: GameSettings.Localize("FALLOUTMAW.Calendar.Year")
                    }
                ];
            }
            html += `<div class="fallout-maw-calendar-control-group fallout-maw-calendar-adjustable-controls">`;
            for (let i = 0; i < btn.length; i++) {
                html += `<button class="fallout-maw-calendar-control fallout-maw-calendar-primary" data-tooltip="${btn[i].amount} ${btn[i].tooltip}" data-type="${btn[i].type}" data-amount="${btn[i].amount}">${btn[i].amount}&nbsp;${btn[i].text}</button>`;
            }
            html += `</div>`;
        }
        if (options.showTimeControls && options.showPresetTimeOfDay) {
            html += `<div class="fallout-maw-calendar-control-group">
                            <button class="fallout-maw-calendar-control fallout-maw-calendar-secondary" data-type="sunrise" data-tooltip="${GameSettings.Localize(
                                "FALLOUTMAW.Calendar.Dawn"
                            )}">${GetIcon(Icons.Sunrise)}</button>
                            <button class="fallout-maw-calendar-control fallout-maw-calendar-secondary" data-type="midday" data-tooltip="${GameSettings.Localize(
                                "FALLOUTMAW.Calendar.Midday"
                            )}">${GetIcon(Icons.Midday)}</button>
                            <button class="fallout-maw-calendar-control fallout-maw-calendar-secondary" data-type="sunset" data-tooltip="${GameSettings.Localize(
                                "FALLOUTMAW.Calendar.Dusk"
                            )}">${GetIcon(Icons.Sunset)}</button>
                            <button class="fallout-maw-calendar-control fallout-maw-calendar-secondary" data-type="midnight" data-tooltip="${GameSettings.Localize(
                                "FALLOUTMAW.Calendar.Midnight"
                            )}">${GetIcon(Icons.Midnight)}</button>
                        </div>`;
        }
        html += "</div>";

        return html;
    }
}
