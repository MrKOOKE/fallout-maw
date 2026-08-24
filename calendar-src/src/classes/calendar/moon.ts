import { Icons, MoonYearResetOptions } from "../../constants";
import { GameSettings } from "../foundry-interfacing/game-settings";
import ConfigurationItemBase from "../configuration/configuration-item-base";
import Calendar from "./index";

const DEFAULT_MAX_LIGHT_CONTRIBUTION = 0.5;

/**
 * Keeps user supplied lighting values inside the range understood by Foundry's
 * scene darkness controls.
 */
export function normalizeMoonLightingValue(value: unknown, fallback: number): number {
    const numericValue = typeof value === "number" ? value : Number(value);
    return Number.isFinite(numericValue) ? Math.min(1, Math.max(0, numericValue)) : fallback;
}

/**
 * Returns a useful illumination default for calendar data created before moon
 * lighting was supported.
 */
export function defaultMoonPhaseIllumination(icon: Icons | string): number {
    switch (icon) {
        case Icons.WaxingCrescent:
        case Icons.WaningCrescent:
            return 0.25;
        case Icons.FirstQuarter:
        case Icons.LastQuarter:
            return 0.5;
        case Icons.WaxingGibbous:
        case Icons.WaningGibbous:
            return 0.75;
        case Icons.Full:
            return 1;
        case Icons.NewMoon:
        default:
            return 0;
    }
}

/**
 * Class for representing a moon
 */
export default class Moon extends ConfigurationItemBase {
    /**
     * How long in calendar days the moon takes to do 1 revolution
     * @type {number}
     */
    cycleLength: number;
    /**
     * The different phases of the moon
     * @type {Array<MoonPhase>}
     */
    phases: FalloutMaWCalendar.MoonPhase[] = [];
    /**
     * When the first new moon took place. Used as a reference for calculating the position of the current cycle
     */
    firstNewMoon: FalloutMaWCalendar.FirstNewMoonDate = {
        /**
         * The year reset options for the first new moon
         * @type {number}
         */
        yearReset: MoonYearResetOptions.None,
        /**
         * How often the year should reset
         * @type {number}
         */
        yearX: 0,
        /**
         * The year of the first new moon
         * @type {number}
         */
        year: 0,
        /**
         * The month of the first new moon
         * @type {number}
         */
        month: 1,
        /**
         * The day of the first new moon
         * @type {number}
         */
        day: 1
    };
    /**
     * A color to associate with the moon when displaying it on the calendar
     */
    color: string = "#ffffff";
    /**
     * The amount of days to adjust the current cycle day by
     * @type {number}
     */
    cycleDayAdjust: number = 0;
    /** If this moon contributes light to scene darkness calculations. */
    affectsLighting: boolean = true;
    /** The maximum amount (0-1) this moon can reduce peak darkness. */
    maxLightContribution: number = DEFAULT_MAX_LIGHT_CONTRIBUTION;

    /**
     * The moon constructor
     * @param {string} name The name of the moon
     * @param {number} cycleLength The length of the moons cycle
     */
    constructor(name: string = "", cycleLength: number = 0) {
        super(name);
        this.cycleLength = cycleLength;

        this.phases.push({
            name: GameSettings.Localize("FALLOUTMAW.Calendar.Moon.Phase.New"),
            length: 3.69,
            icon: Icons.NewMoon,
            singleDay: true,
            illumination: defaultMoonPhaseIllumination(Icons.NewMoon)
        });
    }

    /**
     * Creates a clone of this moon object
     * @return {Moon}
     */
    clone(): Moon {
        const c = new Moon(this.name, this.cycleLength);
        c.id = this.id;
        c.phases = this.phases.map((p) => {
            return {
                name: p.name,
                length: p.length,
                icon: p.icon,
                singleDay: p.singleDay,
                illumination: normalizeMoonLightingValue(p.illumination, defaultMoonPhaseIllumination(p.icon))
            };
        });
        c.firstNewMoon.yearReset = this.firstNewMoon.yearReset;
        c.firstNewMoon.yearX = this.firstNewMoon.yearX;
        c.firstNewMoon.year = this.firstNewMoon.year;
        c.firstNewMoon.month = this.firstNewMoon.month;
        c.firstNewMoon.day = this.firstNewMoon.day;
        c.color = this.color;
        c.cycleDayAdjust = this.cycleDayAdjust;
        c.affectsLighting = this.affectsLighting;
        c.maxLightContribution = normalizeMoonLightingValue(this.maxLightContribution, DEFAULT_MAX_LIGHT_CONTRIBUTION);
        return c;
    }

    /**
     * Returns the configuration for the moon
     */
    toConfig(): FalloutMaWCalendar.MoonData {
        return {
            id: this.id,
            name: this.name,
            cycleLength: this.cycleLength,
            firstNewMoon: {
                yearReset: this.firstNewMoon.yearReset,
                yearX: this.firstNewMoon.yearX,
                year: this.firstNewMoon.year,
                month: this.firstNewMoon.month,
                day: this.firstNewMoon.day
            },
            phases: this.phases.map((p) => {
                return {
                    name: p.name,
                    length: p.length,
                    icon: p.icon,
                    singleDay: p.singleDay,
                    illumination: normalizeMoonLightingValue(p.illumination, defaultMoonPhaseIllumination(p.icon))
                };
            }),
            color: this.color,
            cycleDayAdjust: this.cycleDayAdjust,
            affectsLighting: this.affectsLighting,
            maxLightContribution: normalizeMoonLightingValue(this.maxLightContribution, DEFAULT_MAX_LIGHT_CONTRIBUTION)
        };
    }

    /**
     * Converts this moon into a template used for displaying the moon in HTML
     */
    toTemplate(): FalloutMaWCalendar.HandlebarTemplateData.Moon {
        const data: FalloutMaWCalendar.HandlebarTemplateData.Moon = {
            ...super.toTemplate(),
            name: this.name,
            cycleLength: this.cycleLength,
            firstNewMoon: this.firstNewMoon,
            phases: this.phases,
            color: this.color,
            cycleDayAdjust: this.cycleDayAdjust,
            affectsLighting: this.affectsLighting,
            maxLightContribution: normalizeMoonLightingValue(this.maxLightContribution, DEFAULT_MAX_LIGHT_CONTRIBUTION),
            firstNewMoonDateSelectorId: `fallout_maw_calendar_first_new_moon_date_${this.id}`,
            firstNewMoonSelectedDate: { year: 0, month: this.firstNewMoon.month, day: this.firstNewMoon.day, hour: 0, minute: 0, seconds: 0 }
        };
        return data;
    }

    /**
     * Loads the moon data from the config object.
     * @param {MoonData} config The configuration object for this class
     */
    loadFromSettings(config: FalloutMaWCalendar.MoonData) {
        if (config && Object.keys(config).length) {
            super.loadFromSettings(config);
            this.cycleLength = config.cycleLength;
            if (Array.isArray(config.phases)) {
                this.phases = config.phases.map((phase) => ({
                    name: phase.name,
                    length: phase.length,
                    icon: phase.icon,
                    singleDay: phase.singleDay,
                    illumination: normalizeMoonLightingValue(phase.illumination, defaultMoonPhaseIllumination(phase.icon))
                }));
            }
            this.firstNewMoon = {
                yearReset: config.firstNewMoon.yearReset,
                yearX: config.firstNewMoon.yearX,
                year: config.firstNewMoon.year,
                month: config.firstNewMoon.month,
                day: config.firstNewMoon.day
            };
            this.color = config.color;
            this.cycleDayAdjust = config.cycleDayAdjust;
            this.affectsLighting = typeof config.affectsLighting === "boolean" ? config.affectsLighting : true;
            this.maxLightContribution = normalizeMoonLightingValue(config.maxLightContribution, DEFAULT_MAX_LIGHT_CONTRIBUTION);
        }
    }

    /**
     * Updates each phases length in days so the total length of all phases matches the cycle length
     */
    updatePhaseLength() {
        let pLength = 0,
            singleDays = 0;
        for (let i = 0; i < this.phases.length; i++) {
            if (this.phases[i].singleDay) {
                singleDays++;
            } else {
                pLength++;
            }
        }
        const phaseLength = Number(((this.cycleLength - singleDays) / pLength).toPrecision(6));

        this.phases.forEach((p) => {
            if (p.singleDay) {
                p.length = 1;
            } else {
                p.length = phaseLength;
            }
        });
    }

    /**
     * Returns the current phase of the moon based on a year month and day.
     * This phase will be within + or - 1 days of when the phase actually begins
     * @param calendar The year class to get the information from
     * @param {number} yearNum The year to use
     * @param {number} monthIndex The month to use
     * @param {number} dayIndex The day to use
     */
    getDateMoonPhase(calendar: Calendar, yearNum: number, monthIndex: number, dayIndex: number): FalloutMaWCalendar.MoonPhase {
        let firstNewMoonDays = calendar.dateToDays(this.firstNewMoon.year, this.firstNewMoon.month, this.firstNewMoon.day, true);
        let resetYearAdjustment = 0;
        if (this.firstNewMoon.yearReset === MoonYearResetOptions.LeapYear) {
            const lyYear = calendar.year.leapYearRule.previousLeapYear(yearNum);
            if (lyYear !== null) {
                firstNewMoonDays = calendar.dateToDays(lyYear, this.firstNewMoon.month, this.firstNewMoon.day, true);
                if (yearNum !== lyYear) {
                    resetYearAdjustment += calendar.year.leapYearRule.fraction(yearNum);
                }
            }
        } else if (this.firstNewMoon.yearReset === MoonYearResetOptions.XYears) {
            const resetMod = yearNum % this.firstNewMoon.yearX;
            if (resetMod !== 0) {
                const resetYear = yearNum - resetMod;
                firstNewMoonDays = calendar.dateToDays(resetYear, this.firstNewMoon.month, this.firstNewMoon.day, true);
                resetYearAdjustment += resetMod / this.firstNewMoon.yearX;
            }
        }

        const daysSoFar = calendar.dateToDays(yearNum, monthIndex, dayIndex, true);
        const daysSinceReferenceMoon = daysSoFar - firstNewMoonDays + resetYearAdjustment;
        const moonCycles = daysSinceReferenceMoon / this.cycleLength;
        const daysIntoCycle = (moonCycles - Math.floor(moonCycles)) * this.cycleLength + this.cycleDayAdjust;

        let phaseDays = 0;
        let phase: FalloutMaWCalendar.MoonPhase | null = null;
        for (let i = 0; i < this.phases.length; i++) {
            const newPhaseDays = phaseDays + this.phases[i].length;
            if (daysIntoCycle >= phaseDays && daysIntoCycle < newPhaseDays) {
                phase = this.phases[i];
                break;
            }
            phaseDays = newPhaseDays;
        }
        if (phase !== null) {
            return phase;
        } else {
            return this.phases[0];
        }
    }

    /**
     * Gets the moon phase based on the current, selected or visible date
     * @param calendar The year class used to get the year, month and day to use
     * @param property Which property to use when getting the year, month and day. Can be current, selected or visible
     * @param dayToUse The day to use instead of the day associated with the property
     */
    getMoonPhase(calendar: Calendar, property: string = "current", dayToUse: number = 0): FalloutMaWCalendar.MoonPhase {
        property = property.toLowerCase() as "current" | "selected" | "visible";
        const yearNum =
            property === "current"
                ? calendar.year.numericRepresentation
                : property === "selected"
                ? calendar.year.selectedYear
                : calendar.year.visibleYear;
        const monthIndex = calendar.getMonthIndex(property);
        if (monthIndex > -1) {
            const dayIndex = property !== "visible" ? calendar.months[monthIndex].getDayIndex(property) : dayToUse;
            return this.getDateMoonPhase(calendar, yearNum, monthIndex, dayIndex);
        }
        return this.phases[0];
    }
}
