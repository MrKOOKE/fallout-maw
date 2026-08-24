import { GameSettings } from "../foundry-interfacing/game-settings";

const DISPLAY_TERM_KEYS: Readonly<Record<string, string>> = Object.freeze({
    Default: "FALLOUTMAW.Calendar.Date.DefaultCalendar",
    January: "FALLOUTMAW.Calendar.Date.January",
    February: "FALLOUTMAW.Calendar.Date.February",
    March: "FALLOUTMAW.Calendar.Date.March",
    April: "FALLOUTMAW.Calendar.Date.April",
    May: "FALLOUTMAW.Calendar.Date.May",
    June: "FALLOUTMAW.Calendar.Date.June",
    July: "FALLOUTMAW.Calendar.Date.July",
    August: "FALLOUTMAW.Calendar.Date.August",
    September: "FALLOUTMAW.Calendar.Date.September",
    October: "FALLOUTMAW.Calendar.Date.October",
    November: "FALLOUTMAW.Calendar.Date.November",
    December: "FALLOUTMAW.Calendar.Date.December",
    Sunday: "FALLOUTMAW.Calendar.Date.Sunday",
    Monday: "FALLOUTMAW.Calendar.Date.Monday",
    Tuesday: "FALLOUTMAW.Calendar.Date.Tuesday",
    Wednesday: "FALLOUTMAW.Calendar.Date.Wednesday",
    Thursday: "FALLOUTMAW.Calendar.Date.Thursday",
    Friday: "FALLOUTMAW.Calendar.Date.Friday",
    Saturday: "FALLOUTMAW.Calendar.Date.Saturday",
    Spring: "FALLOUTMAW.Calendar.Date.Spring",
    Summer: "FALLOUTMAW.Calendar.Date.Summer",
    Fall: "FALLOUTMAW.Calendar.Date.Fall",
    Winter: "FALLOUTMAW.Calendar.Date.Winter",
    Moon: "FALLOUTMAW.Calendar.Date.Moon",
    "New Moon": "FALLOUTMAW.Calendar.Moon.Phase.New",
    "Waxing Crescent": "FALLOUTMAW.Calendar.Moon.Phase.WaxingCrescent",
    "First Quarter": "FALLOUTMAW.Calendar.Moon.Phase.FirstQuarter",
    "Waxing Gibbous": "FALLOUTMAW.Calendar.Moon.Phase.WaxingGibbous",
    "Full Moon": "FALLOUTMAW.Calendar.Moon.Phase.Full",
    "Waning Gibbous": "FALLOUTMAW.Calendar.Moon.Phase.WaningGibbous",
    "Last Quarter": "FALLOUTMAW.Calendar.Moon.Phase.LastQuarter",
    "Waning Crescent": "FALLOUTMAW.Calendar.Moon.Phase.WaningCrescent"
});

const DISPLAY_ABBREVIATION_KEYS: Readonly<Record<string, string>> = Object.freeze({
    January: "FALLOUTMAW.Calendar.Date.JanuaryShort",
    February: "FALLOUTMAW.Calendar.Date.FebruaryShort",
    March: "FALLOUTMAW.Calendar.Date.MarchShort",
    April: "FALLOUTMAW.Calendar.Date.AprilShort",
    May: "FALLOUTMAW.Calendar.Date.MayShort",
    June: "FALLOUTMAW.Calendar.Date.JuneShort",
    July: "FALLOUTMAW.Calendar.Date.JulyShort",
    August: "FALLOUTMAW.Calendar.Date.AugustShort",
    September: "FALLOUTMAW.Calendar.Date.SeptemberShort",
    October: "FALLOUTMAW.Calendar.Date.OctoberShort",
    November: "FALLOUTMAW.Calendar.Date.NovemberShort",
    December: "FALLOUTMAW.Calendar.Date.DecemberShort",
    Sunday: "FALLOUTMAW.Calendar.Date.SundayShort",
    Monday: "FALLOUTMAW.Calendar.Date.MondayShort",
    Tuesday: "FALLOUTMAW.Calendar.Date.TuesdayShort",
    Wednesday: "FALLOUTMAW.Calendar.Date.WednesdayShort",
    Thursday: "FALLOUTMAW.Calendar.Date.ThursdayShort",
    Friday: "FALLOUTMAW.Calendar.Date.FridayShort",
    Saturday: "FALLOUTMAW.Calendar.Date.SaturdayShort"
});

/** Localize only stock Gregorian labels; custom calendar vocabulary is preserved verbatim. */
export function LocalizeCalendarDisplayTerm(value: string): string {
    return localizeMappedValue(value, DISPLAY_TERM_KEYS);
}

/** Localize a stock month/weekday abbreviation while preserving custom abbreviations. */
export function LocalizeCalendarDisplayAbbreviation(name: string, abbreviation: string): string {
    const key = DISPLAY_ABBREVIATION_KEYS[name];
    return key ? localizeKey(key, abbreviation) : abbreviation;
}

function localizeMappedValue(value: string, keys: Readonly<Record<string, string>>): string {
    const key = keys[value];
    return key ? localizeKey(key, value) : value;
}

function localizeKey(key: string, fallback: string): string {
    const localized = GameSettings.Localize(key);
    return localized && localized !== key ? localized : fallback;
}
