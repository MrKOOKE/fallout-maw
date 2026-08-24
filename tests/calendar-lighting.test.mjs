import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateCalendarDarkness,
  calculateSolarDarkness,
  combineMoonIllumination,
  getMoonLightContribution,
  getMoonPhaseIllumination,
  resolveCalendarLightingState
} from "../src/time/dynamic-lighting.mjs";

const HOUR = 60 * 60;
const DAY = 24 * HOUR;

test("calendar solar darkness follows sunrise, sunset, and smooth twilight", () => {
  const state = {
    sunriseSeconds: 6 * HOUR,
    sunsetSeconds: 18 * HOUR,
    secondsPerDay: DAY,
    twilightSeconds: 2 * HOUR
  };
  assert.equal(calculateSolarDarkness({ ...state, secondOfDay: 12 * HOUR }), 0);
  assert.equal(calculateSolarDarkness({ ...state, secondOfDay: 18 * HOUR }), 0);
  assert.equal(calculateSolarDarkness({ ...state, secondOfDay: 19 * HOUR }), 0.5);
  assert.equal(calculateSolarDarkness({ ...state, secondOfDay: 0 }), 1);
  assert.equal(calculateSolarDarkness({ ...state, secondOfDay: 5 * HOUR }), 0.5);
  assert.equal(calculateSolarDarkness({ ...state, secondOfDay: 6 * HOUR }), 0);
});

test("phase defaults and configured illumination produce a half-dark full-moon night", () => {
  assert.equal(getMoonPhaseIllumination({ icon: "new" }), 0);
  assert.equal(getMoonPhaseIllumination({ icon: "first-quarter" }), 0.5);
  assert.equal(getMoonPhaseIllumination({ icon: "full" }), 1);
  assert.equal(getMoonPhaseIllumination({ illumination: 80 }), 0.8);
  assert.equal(getMoonLightContribution({ currentPhase: { icon: "full" } }), 0.5);
  assert.equal(getMoonLightContribution({
    maxLightContribution: 0.2,
    currentPhase: { icon: "full" }
  }), 0.2);
  assert.equal(getMoonLightContribution({
    affectsLighting: false,
    currentPhase: { icon: "full" }
  }), 0);

  const darkness = calculateCalendarDarkness({
    secondOfDay: 0,
    sunriseSeconds: 6 * HOUR,
    sunsetSeconds: 18 * HOUR,
    secondsPerDay: DAY,
    twilightSeconds: 2 * HOUR,
    moons: [{ currentPhase: { icon: "full" } }]
  });
  assert.equal(darkness, 0.5);
});

test("multiple moons combine in O(moons) without allowing darkness below zero", () => {
  assert.equal(combineMoonIllumination([
    { currentPhase: { icon: "full" } },
    { currentPhase: { icon: "full" } }
  ]), 0.75);
  assert.equal(combineMoonIllumination([
    { maxLightContribution: 1, currentPhase: { illumination: 1 } },
    { currentPhase: { illumination: 0.5 } }
  ]), 1);
});

test("lighting state uses the calendar's time scale and season solar times", () => {
  const api = {
    getTimeConfiguration: () => ({ hoursInDay: 20, minutesInHour: 50, secondsInMinute: 40 }),
    getCurrentCalendar: () => ({ seasons: [{ name: "Test" }] }),
    timestampToDate: () => ({
      hour: 3,
      minute: 4,
      second: 5,
      currentSeason: { sunriseTime: 4_000, sunsetTime: 28_000 }
    }),
    getAllMoons: () => [{ currentPhase: { icon: "full" } }]
  };
  assert.deepEqual(resolveCalendarLightingState(api, null, 0), {
    secondOfDay: 6_165,
    sunriseSeconds: 4_000,
    sunsetSeconds: 28_000,
    secondsPerDay: 40_000,
    twilightSeconds: 4_000,
    moons: [{ currentPhase: { icon: "full" } }]
  });
});

test("lighting uses quarter-day solar defaults when no seasons are configured", () => {
  const api = {
    getTimeConfiguration: () => ({ hoursInDay: 24, minutesInHour: 60, secondsInMinute: 60 }),
    getCurrentCalendar: () => ({ seasons: [] }),
    timestampToDate: () => ({ hour: 0, minute: 0, second: 0, sunrise: 0, sunset: 0 }),
    getMoonLightingState: () => []
  };
  const state = resolveCalendarLightingState(api, null, 0);
  assert.equal(state.sunriseSeconds, 6 * HOUR);
  assert.equal(state.sunsetSeconds, 18 * HOUR);
});
