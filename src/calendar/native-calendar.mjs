const FALLBACK_MONTH = Object.freeze({
  name: "Year",
  abbreviation: "Yr",
  numberOfDays: 365,
  numberOfLeapYearDays: 365
});

const FALLBACK_WEEKDAY = Object.freeze({ name: "Day", abbreviation: "Day" });

/** Convert the bundled public calendar configuration into Foundry V14's schema. */
export function buildFoundryCalendarConfig(calendarConfiguration = {}) {
  const time = calendarConfiguration?.time ?? {};
  const year = calendarConfiguration?.year ?? {};
  const sourceMonths = nonEmptyArray(calendarConfiguration?.months, [FALLBACK_MONTH]);
  const sourceWeekdays = nonEmptyArray(calendarConfiguration?.weekdays, [FALLBACK_WEEKDAY]);
  const months = sourceMonths.map((month, index) => {
    const days = positiveInteger(month?.numberOfDays, 1);
    return {
      name: nonBlankString(month?.name, `Month ${index + 1}`),
      abbreviation: String(month?.abbreviation ?? ""),
      ordinal: index + 1,
      days,
      leapDays: nonNegativeInteger(month?.numberOfLeapYearDays, days)
    };
  });
  const weekdays = sourceWeekdays.map((weekday, index) => ({
    name: nonBlankString(weekday?.name, `Day ${index + 1}`),
    abbreviation: String(weekday?.abbreviation ?? ""),
    ordinal: index + 1
  }));
  const daysPerYear = months.reduce((total, month) => total + month.days, 0);
  const seasons = buildFoundrySeasons(calendarConfiguration?.seasons, months, daysPerYear);

  return {
    name: nonBlankString(calendarConfiguration?.name, "Fallout MaW Calendar"),
    description: String(calendarConfiguration?.description ?? ""),
    years: {
      yearZero: finiteInteger(year?.yearZero, 0),
      firstWeekday: modulo(finiteInteger(year?.firstWeekday, 0), weekdays.length),
      // The bundle supports leap rules (including Gregorian century rules)
      // which cannot be expressed by Foundry's interval-only schema.
      leapYear: null
    },
    months: { values: months },
    days: {
      values: weekdays,
      daysPerYear,
      hoursPerDay: positiveInteger(time?.hoursInDay, 24),
      minutesPerHour: positiveInteger(time?.minutesInHour, 60),
      secondsPerMinute: positiveInteger(time?.secondsInMinute, 60)
    },
    // CalendarData.timeToComponents iterates seasons.values without a null
    // guard in Foundry V14, so an empty collection is safer than schema-null.
    seasons: { values: seasons }
  };
}

/**
 * Create a CalendarData subclass backed by the bundle's exact conversion API.
 * A factory keeps this module importable in Node tests without Foundry globals.
 */
export function createFalloutMaWCalendarDataClass(
  api,
  CalendarDataBase = globalThis.foundry?.data?.CalendarData,
  calendarConfiguration = api?.getCurrentCalendar?.()
) {
  if (typeof CalendarDataBase !== "function") throw new TypeError("Foundry CalendarData is unavailable");
  assertCalendarApi(api);

  return class FalloutMaWCalendarData extends CalendarDataBase {
    static calendarApi = api;
    static calendarConfiguration = calendarConfiguration;

    timeToComponents(time = 0) {
      const date = safeTimestampToDateParts(this.constructor.calendarApi, time);
      if (!date) return super.timeToComponents(time);

      const month = clampInteger(date.month, 0, this.months.values.length - 1);
      const dayOfMonth = Math.max(0, finiteInteger(date.day, 0));
      let day = dayOfMonth;
      for (let index = 0; index < month; index += 1) {
        const configuredMonth = this.months.values[index];
        day += date.isLeapYear ? (configuredMonth.leapDays ?? configuredMonth.days) : configuredMonth.days;
      }

      return {
        day,
        dayOfMonth,
        dayOfWeek: modulo(finiteInteger(date.dayOfTheWeek, 0), this.days.values.length),
        hour: Math.max(0, finiteInteger(date.hour, 0)),
        leapYear: Boolean(date.isLeapYear),
        minute: Math.max(0, finiteInteger(date.minute, 0)),
        month,
        season: findSeasonIndex(this.constructor.calendarConfiguration?.seasons, date.currentSeason),
        second: Math.max(0, Number(date.second) || 0),
        year: finiteInteger(date.year, this.years.yearZero) - this.years.yearZero
      };
    }

    componentsToTime(components = {}) {
      const api = this.constructor.calendarApi;
      const year = finiteInteger(components.year, 0);
      const absoluteYear = year + this.years.yearZero;
      const secondsPerHour = this.days.minutesPerHour * this.days.secondsPerMinute;
      const secondsPerDay = this.days.hoursPerDay * secondsPerHour;
      const yearStart = safeDateToTimestamp(api, {
        year: absoluteYear,
        month: 0,
        day: 0,
        hour: 0,
        minute: 0,
        seconds: 0
      });
      if (yearStart === null) return super.componentsToTime(components);

      let day = Number(components.day);
      if (!Number.isFinite(day)) {
        day = dayOfYearFromMonth(
          this.months.values,
          finiteInteger(components.month, 0),
          finiteInteger(components.dayOfMonth, 0),
          this.isLeapYear(year)
        );
      }
      return Number(yearStart)
        + (day * secondsPerDay)
        + ((Number(components.hour) || 0) * secondsPerHour)
        + ((Number(components.minute) || 0) * this.days.secondsPerMinute)
        + (Number(components.second) || 0);
    }

    isLeapYear(year) {
      const absoluteYear = finiteInteger(year, 0) + this.years.yearZero;
      const start = safeDateToTimestamp(this.constructor.calendarApi, {
        year: absoluteYear,
        month: 0,
        day: 0,
        hour: 0,
        minute: 0,
        seconds: 0
      });
      if (start === null) return super.isLeapYear(year);
      const date = safeTimestampToDateParts(this.constructor.calendarApi, start);
      return date ? Boolean(date.isLeapYear) : super.isLeapYear(year);
    }

    sunrise(time = globalThis.game?.time?.components) {
      return this.#solarHour(time, "sunrise");
    }

    sunset(time = globalThis.game?.time?.components) {
      return this.#solarHour(time, "sunset");
    }

    #solarHour(time, property) {
      const timestamp = typeof time === "number" ? time : this.componentsToTime(time ?? {});
      const date = safeTimestampToDate(this.constructor.calendarApi, timestamp);
      if (!date || !Number.isFinite(Number(date[property]))) {
        return property === "sunrise" ? this.days.hoursPerDay * 0.25 : this.days.hoursPerDay * 0.75;
      }
      const secondsPerHour = this.days.minutesPerHour * this.days.secondsPerMinute;
      const secondsPerDay = this.days.hoursPerDay * secondsPerHour;
      return modulo(Number(date[property]), secondsPerDay) / secondsPerHour;
    }
  };
}

/** Install or rebuild the active native Foundry calendar bridge. */
export function installNativeCalendarBridge(
  api = globalThis.game?.falloutMaW?.calendar?.api,
  calendarConfiguration = api?.getCurrentCalendar?.()
) {
  assertCalendarApi(api);
  const config = buildFoundryCalendarConfig(calendarConfiguration);
  const CalendarClass = createFalloutMaWCalendarDataClass(
    api,
    globalThis.foundry?.data?.CalendarData,
    calendarConfiguration
  );
  globalThis.CONFIG.time.worldCalendarConfig = config;
  globalThis.CONFIG.time.worldCalendarClass = CalendarClass;
  globalThis.game?.time?.initializeCalendar?.();
  return globalThis.game?.time?.calendar ?? null;
}

function buildFoundrySeasons(sourceSeasons, months, daysPerYear) {
  if (!Array.isArray(sourceSeasons) || !sourceSeasons.length) return [];
  const starts = sourceSeasons.map(season => {
    const month = clampInteger(season?.startingMonth, 0, months.length - 1);
    const day = clampInteger(season?.startingDay, 0, Math.max(0, months[month].days - 1));
    let dayStart = day + 1;
    for (let index = 0; index < month; index += 1) dayStart += months[index].days;
    return dayStart;
  });
  return sourceSeasons.map((season, index) => {
    const nextStart = starts[(index + 1) % starts.length];
    return {
      name: nonBlankString(season?.name, `Season ${index + 1}`),
      abbreviation: String(season?.abbreviation ?? ""),
      monthStart: null,
      monthEnd: null,
      dayStart: starts[index],
      dayEnd: nextStart > 1 ? nextStart - 1 : daysPerYear
    };
  });
}

function dayOfYearFromMonth(months, monthIndex, dayOfMonth, leapYear) {
  const month = clampInteger(monthIndex, 0, months.length - 1);
  let day = Math.max(0, dayOfMonth);
  for (let index = 0; index < month; index += 1) {
    day += leapYear ? (months[index].leapDays ?? months[index].days) : months[index].days;
  }
  return day;
}

function findSeasonIndex(seasons, currentSeason) {
  if (!Array.isArray(seasons) || !seasons.length || !currentSeason) return undefined;
  let index = currentSeason.id ? seasons.findIndex(season => season?.id === currentSeason.id) : -1;
  if (index < 0 && currentSeason.name) index = seasons.findIndex(season => season?.name === currentSeason.name);
  return index < 0 ? undefined : index;
}

function safeTimestampToDate(api, timestamp) {
  try {
    return api.timestampToDate(Number(timestamp) || 0) ?? null;
  } catch (_error) {
    return null;
  }
}

function safeTimestampToDateParts(api, timestamp) {
  try {
    return api.timestampToDateParts(Number(timestamp) || 0) ?? null;
  } catch (_error) {
    return null;
  }
}

function safeDateToTimestamp(api, date) {
  try {
    const timestamp = Number(api.dateToTimestamp(date));
    return Number.isFinite(timestamp) ? timestamp : null;
  } catch (_error) {
    return null;
  }
}

function assertCalendarApi(api) {
  if (typeof api?.getCurrentCalendar !== "function"
    || typeof api?.timestampToDate !== "function"
    || typeof api?.timestampToDateParts !== "function"
    || typeof api?.dateToTimestamp !== "function") {
    throw new TypeError("Fallout MaW calendar API is not ready");
  }
}

function nonEmptyArray(value, fallback) {
  return Array.isArray(value) && value.length ? value : fallback;
}

function nonBlankString(value, fallback) {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function positiveInteger(value, fallback) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function nonNegativeInteger(value, fallback) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function finiteInteger(value, fallback) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) ? number : fallback;
}

function clampInteger(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, finiteInteger(value, minimum)));
}

function modulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}
