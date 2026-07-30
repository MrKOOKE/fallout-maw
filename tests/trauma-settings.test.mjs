import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

let randomId = 0;
globalThis.foundry = {
  utils: {
    randomID: () => `generated-${++randomId}`
  }
};

const {
  createDefaultTraumaSettings,
  getTraumaGroupForActor,
  getUniqueTraumaLimbs,
  normalizeTraumaSettings
} = await import("../src/settings/traumas.mjs");

const creatureOptions = {
  races: [
    {
      id: "human",
      name: "Человек",
      limbs: [
        { key: "head", label: "Голова", stateMax: "100" },
        { key: "leftArm", label: "Левая рука", stateMax: "100" }
      ]
    },
    {
      id: "mutant",
      name: "Мутант",
      limbs: [
        { key: "head", label: "Голова", stateMax: "120" },
        { key: "tail", label: "Хвост", stateMax: "80" }
      ]
    }
  ]
};

const damageTypes = [
  { key: "fire", label: "Огненный" },
  { key: "slashing", label: "Режущий" },
  { key: "bleeding", label: "Кровотечение" }
];

test("trauma defaults and normalized storage are keyed by unique limbs", () => {
  assert.deepEqual(createDefaultTraumaSettings(), { limbs: {} });
  assert.deepEqual(
    getUniqueTraumaLimbs(creatureOptions).map(limb => limb.key),
    ["head", "leftArm", "tail"]
  );

  const normalized = normalizeTraumaSettings({}, creatureOptions, damageTypes);
  assert.deepEqual(Object.keys(normalized), ["limbs"]);
  assert.deepEqual(Object.keys(normalized.limbs).sort(), ["head", "leftArm", "tail"]);
  assert.deepEqual(
    normalized.limbs.head.thresholds.map(entry => entry.thresholdPercent),
    [60, 0]
  );
  assert.equal(normalized.limbs.head.stages[0].profiles.bleeding, undefined);
});

test("one limb configuration is used independently from actor race limb sets", () => {
  const settings = normalizeTraumaSettings({
    limbs: {
      head: {
        thresholds: [{ id: "head-35", thresholdPercent: 35 }],
        stages: [{
          id: "head-35",
          thresholdPercent: 35,
          profiles: {
            fire: {
              name: "Обожжённая голова",
              img: "head-fire.webp",
              healingDifficulty: 75,
              healingToolClass: "C",
              healingProgress: 130,
              healingSkillKey: "doctor",
              effects: [{
                key: "system.characteristics.endurance",
                type: "add",
                value: "-2"
              }]
            }
          }
        }]
      }
    }
  }, creatureOptions, damageTypes);

  for (const raceId of ["human", "mutant"]) {
    const resolved = getTraumaGroupForActor({
      system: { creature: { raceId } }
    }, settings, creatureOptions, damageTypes);
    const head = resolved.config.limbs.head;
    assert.equal(head.stages.length, 1);
    assert.equal(head.stages[0].thresholdPercent, 35);
    assert.equal(head.stages[0].profiles.fire.name, "Обожжённая голова");
  }
});

test("legacy grouped settings are consolidated by limb key without dropping configured profiles", () => {
  const normalized = normalizeTraumaSettings({
    groups: {
      "head|leftArm": {
        thresholds: [{ id: "old-60", thresholdPercent: 60 }],
        limbs: {
          head: {
            stages: [{
              id: "old-60",
              thresholdPercent: 60,
              profiles: {}
            }]
          }
        }
      },
      "head|tail": {
        thresholds: [{ id: "old-30", thresholdPercent: 30 }],
        limbs: {
          head: {
            stages: [{
              id: "old-30",
              thresholdPercent: 30,
              profiles: {
                slashing: {
                  name: "Рассечённая голова",
                  img: "head-slash.webp",
                  healingDifficulty: 80,
                  healingToolClass: "B",
                  healingProgress: 150,
                  healingSkillKey: "doctor",
                  effects: [{
                    key: "system.characteristics.perception",
                    type: "add",
                    value: "-3"
                  }]
                }
              }
            }]
          }
        }
      }
    }
  }, creatureOptions, damageTypes);

  assert.deepEqual(
    normalized.limbs.head.thresholds.map(entry => entry.thresholdPercent),
    [60, 30]
  );
  const stage = normalized.limbs.head.stages.find(entry => entry.thresholdPercent === 30);
  assert.equal(stage.profiles.slashing.name, "Рассечённая голова");
  assert.equal(stage.profiles.slashing.healingDifficulty, 80);
  assert.equal(stage.profiles.slashing.effects[0].value, "-3");
});

test("trauma settings UI is a unique limb list without race-set group blocks", async () => {
  const [listTemplate, limbTemplate] = await Promise.all([
    readFile(new URL("../templates/settings/trauma-settings-config.hbs", import.meta.url), "utf8"),
    readFile(new URL("../templates/settings/trauma-group-settings-config.hbs", import.meta.url), "utf8")
  ]);

  assert.match(listTemplate, /data-trauma-limb/);
  assert.match(listTemplate, /data-action="openLimb"/);
  assert.doesNotMatch(listTemplate, /data-trauma-group|openGroup|Рас в наборе/);
  assert.match(limbTemplate, /data-trauma-limb/);
  assert.doesNotMatch(limbTemplate, /data-trauma-group/);
});

test("new trauma effects are permanently visible on actor tokens", async () => {
  const source = await readFile(
    new URL("../src/combat/damage-hub.mjs", import.meta.url),
    "utf8"
  );
  const traumaBuilderStart = source.indexOf("function buildTraumaItemData(");
  const traumaBuilderEnd = source.indexOf("function prepareEffectChange(", traumaBuilderStart);
  const traumaBuilder = source.slice(traumaBuilderStart, traumaBuilderEnd);

  assert.ok(traumaBuilderStart >= 0);
  assert.ok(traumaBuilderEnd > traumaBuilderStart);
  assert.match(traumaBuilder, /transfer:\s*true/);
  assert.match(traumaBuilder, /showIcon:\s*ACTIVE_EFFECT_SHOW_ICON_ALWAYS/);
  assert.match(traumaBuilder, /traumaItem:\s*true/);
});
