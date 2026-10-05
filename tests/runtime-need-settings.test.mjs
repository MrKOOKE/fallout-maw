import assert from "node:assert/strict";
import test from "node:test";
function mergeObject(target, source, { inplace = true } = {}) {
  const result = inplace ? target : structuredClone(target);
  for (const [key, value] of Object.entries(source ?? {})) {
    result[key] = value && typeof value === "object" && !Array.isArray(value)
      ? mergeObject(result[key] ?? {}, value) : structuredClone(value);
  }
  return result;
}
globalThis.foundry = {
  applications: { api: { DialogV2: class {} }, ux: { FormDataExtended: class {} }, handlebars: {} },
  utils: { deepClone: structuredClone, mergeObject }
};
const { getActorNeedSettings, invalidatePreparedRuntimeSettingsCache } = await import("../src/settings/accessors.mjs");

test("repeated actor need reads reuse normalized world settings, isolate edits and honor invalidation", () => {
  let reads = 0;
  let label = "Hunger";
  globalThis.game = {
    i18n: { localize: key => key },
    settings: { get(_scope, key) {
      if (key !== "creatureOptions") return undefined;
      reads++;
      return { types: [{ id: "human" }], races: [{ id: "human", typeId: "human",
        needSettings: [{ key: "hunger", label }] }] };
    } }
  };
  invalidatePreparedRuntimeSettingsCache();
  const actor = { type: "character", system: { creature: { raceId: "human" } } };
  const first = getActorNeedSettings(actor);
  assert.equal(first.find(need => need.key === "hunger")?.label, "Hunger");
  first.find(need => need.key === "hunger").label = "Local edit";
  for (let index = 0; index < 20; index++) {
    assert.equal(getActorNeedSettings(actor).find(need => need.key === "hunger")?.label, "Hunger");
  }
  assert.equal(reads, 1);
  label = "Changed";
  invalidatePreparedRuntimeSettingsCache();
  assert.equal(getActorNeedSettings(actor).find(need => need.key === "hunger")?.label, "Changed");
  assert.equal(reads, 2);
  invalidatePreparedRuntimeSettingsCache();
});
