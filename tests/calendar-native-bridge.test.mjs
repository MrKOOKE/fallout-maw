import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFoundryCalendarConfig,
  createFalloutMaWCalendarDataClass
} from "../src/calendar/native-calendar.mjs";

const source = {
  name: "Test Calendar",
  description: "Bridge fixture",
  year: { yearZero: 1970, firstWeekday: 4 },
  months: [
    { id: "jan", name: "January", abbreviation: "Jan", numberOfDays: 31, numberOfLeapYearDays: 31 },
    { id: "feb", name: "February", abbreviation: "Feb", numberOfDays: 28, numberOfLeapYearDays: 29 }
  ],
  weekdays: [
    { name: "One", abbreviation: "1" },
    { name: "Two", abbreviation: "2" },
    { name: "Three", abbreviation: "3" },
    { name: "Four", abbreviation: "4" },
    { name: "Five", abbreviation: "5" },
    { name: "Six", abbreviation: "6" },
    { name: "Seven", abbreviation: "7" }
  ],
  seasons: [
    { id: "winter", name: "Winter", startingMonth: 0, startingDay: 0 },
    { id: "spring", name: "Spring", startingMonth: 1, startingDay: 0 }
  ],
  time: { hoursInDay: 24, minutesInHour: 60, secondsInMinute: 60 }
};

test("calendar configuration maps to Foundry V14 schema and exact season ranges", () => {
  const config = buildFoundryCalendarConfig(source);
  assert.equal(config.name, "Test Calendar");
  assert.equal(config.years.yearZero, 1970);
  assert.equal(config.years.leapYear, null);
  assert.equal(config.days.daysPerYear, 59);
  assert.deepEqual(config.months.values.map(month => month.ordinal), [1, 2]);
  assert.deepEqual(config.seasons.values.map(season => [season.dayStart, season.dayEnd]), [
    [1, 31],
    [32, 59]
  ]);
});

test("calendar configuration always supplies Foundry's iterable seasons collection", () => {
  const config = buildFoundryCalendarConfig({ ...source, seasons: [] });
  assert.deepEqual(config.seasons, { values: [] });
});

test("calendar configuration preserves a valid zero-day leap month", () => {
  const config = buildFoundryCalendarConfig({
    ...source,
    months: [{ name: "Intercalary", numberOfDays: 1, numberOfLeapYearDays: 0 }]
  });
  assert.equal(config.months.values[0].leapDays, 0);
});

test("native class delegates timestamp conversion and leap rules to calendar API", () => {
  const timestampToDate = timestamp => {
    if (timestamp === 0) {
      return {
        year: 1970, month: 0, day: 0, dayOfTheWeek: 4,
        hour: 0, minute: 0, second: 0, isLeapYear: false,
        currentSeason: source.seasons[0], sunrise: 21_600, sunset: 64_800
      };
    }
    if (timestamp === 97_445) {
      return {
        year: 1970, month: 0, day: 1, dayOfTheWeek: 5,
        hour: 3, minute: 4, second: 5, isLeapYear: false,
        currentSeason: source.seasons[0], sunrise: 108_000, sunset: 151_200
      };
    }
    return {
      year: 2024, month: 0, day: 0, dayOfTheWeek: 1,
      hour: 0, minute: 0, second: 0, isLeapYear: true,
      currentSeason: source.seasons[0], sunrise: timestamp + 21_600, sunset: timestamp + 64_800
    };
  };
  const api = {
    getCurrentCalendar: () => source,
    timestampToDate,
    timestampToDateParts: timestampToDate,
    dateToTimestamp: date => date.year === 1970 ? 0 : 1_704_067_200
  };
  class FakeCalendarData {
    constructor(config) {
      Object.assign(this, config);
    }
    timeToComponents() {
      return { fallback: true };
    }
    componentsToTime() {
      return -1;
    }
    isLeapYear() {
      return false;
    }
  }

  const CalendarClass = createFalloutMaWCalendarDataClass(api, FakeCalendarData);
  const calendar = new CalendarClass(buildFoundryCalendarConfig(source));
  assert.deepEqual(calendar.timeToComponents(97_445), {
    day: 1,
    dayOfMonth: 1,
    dayOfWeek: 5,
    hour: 3,
    leapYear: false,
    minute: 4,
    month: 0,
    season: 0,
    second: 5,
    year: 0
  });
  assert.equal(calendar.componentsToTime({ year: 0, day: 1, hour: 3, minute: 4, second: 5 }), 97_445);
  assert.equal(calendar.isLeapYear(54), true);
  assert.equal(calendar.sunrise(calendar.timeToComponents(0)), 6);
  assert.equal(calendar.sunset(calendar.timeToComponents(0)), 18);
});
