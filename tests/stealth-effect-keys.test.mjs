import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [russian, english] = await Promise.all([
  readLocale("../lang/ru.json"),
  readLocale("../lang/en.json")
]);

globalThis.foundry = {
  applications: {
    api: { DialogV2: class {} },
    ux: { FormDataExtended: class {} },
    handlebars: { renderTemplate: () => "" }
  },
  documents: {
    ActiveEffect: {
      implementation: {
        CHANGE_TYPES: {
          add: { defaultPriority: 20 },
          multiply: { defaultPriority: 10 },
          subtract: { defaultPriority: 20 },
          override: { defaultPriority: 30 },
          upgrade: { defaultPriority: 40 },
          downgrade: { defaultPriority: 40 }
        }
      }
    }
  },
  utils: {
    deepClone: value => structuredClone(value),
    getProperty: (object, path) => String(path ?? "").split(".").reduce((value, key) => value?.[key], object),
    mergeObject: (original, other) => ({ ...structuredClone(original), ...structuredClone(other) }),
    randomID: () => "generated"
  }
};
globalThis.game = {
  i18n: {
    localize(key) {
      return String(key ?? "").split(".").reduce((value, part) => value?.[part], russian) ?? key;
    },
    format(key, data = {}) {
      return String(this.localize(key)).replace(/\{([^}]+)\}/g, (_match, name) => String(data[name] ?? ""));
    }
  },
  settings: {
    get() {
      throw new Error("settings are unavailable in this unit test");
    }
  }
};

const {
  STEALTH_ATTACK_ACCURACY_EFFECT_KEY,
  STEALTH_ATTACK_BONUS_EFFECT_KEYS,
  STEALTH_ATTACK_CRITICAL_CHANCE_EFFECT_KEY,
  STEALTH_ATTACK_CRITICAL_DAMAGE_PERCENT_EFFECT_KEY,
  STEALTH_ATTACK_DAMAGE_PERCENT_EFFECT_KEY
} = await import("../src/stealth/effect-keys.mjs");
const {
  buildSmokePerceptionEffectKeyToken,
  buildStealthAttackBonusEffectKeyTokens
} = await import("../src/utils/effect-key-tokens.mjs");
const {
  SMOKE_PERCEPTION_PERCENT_EFFECT_KEY
} = await import("../src/canvas/smoke-perception.mjs");

const EXPECTED_KEYS = Object.freeze({
  accuracy: "system.stealth.attackBonuses.accuracy",
  criticalChance: "system.stealth.attackBonuses.criticalChance",
  damagePercent: "system.stealth.attackBonuses.damagePercent",
  criticalDamagePercent: "system.stealth.attackBonuses.criticalDamagePercent"
});

test("stealth attack effect keys use a dedicated namespace", () => {
  assert.deepEqual(STEALTH_ATTACK_BONUS_EFFECT_KEYS, EXPECTED_KEYS);
  assert.equal(STEALTH_ATTACK_ACCURACY_EFFECT_KEY, EXPECTED_KEYS.accuracy);
  assert.equal(STEALTH_ATTACK_CRITICAL_CHANCE_EFFECT_KEY, EXPECTED_KEYS.criticalChance);
  assert.equal(STEALTH_ATTACK_DAMAGE_PERCENT_EFFECT_KEY, EXPECTED_KEYS.damagePercent);
  assert.equal(STEALTH_ATTACK_CRITICAL_DAMAGE_PERCENT_EFFECT_KEY, EXPECTED_KEYS.criticalDamagePercent);
  assert.equal(Object.values(EXPECTED_KEYS).some(key => key.startsWith("system.combat.")), false);
});

test("stealth attack effect keys are available in autocomplete with localized labels", () => {
  const tokens = buildStealthAttackBonusEffectKeyTokens();
  assert.deepEqual(tokens.map(token => token.path), Object.values(EXPECTED_KEYS));
  assert.deepEqual(tokens.map(token => token.code), [
    "stealthAccuracy",
    "stealthCriticalChance",
    "stealthDamagePercent",
    "stealthCriticalDamagePercent"
  ]);
  assert.equal(tokens.every(token => token.group === "Атака из скрытности"), true);
  assert.equal(tokens.every(token => token.label.startsWith("Атака из скрытности:")), true);
});

test("actor schema exposes four transient signed stealth attack deltas", async () => {
  const source = await readFile(new URL("../src/data/models/actor-data-models.mjs", import.meta.url), "utf8");
  const block = source.match(/stealth:\s*new SchemaField\(\{[\s\S]*?\r?\n\s{6}\}\),\r?\n\s{6}healing:/)?.[0] ?? "";

  assert.ok(block);
  for (const field of Object.keys(EXPECTED_KEYS)) {
    assert.match(
      block,
      new RegExp(`${field}: new NumberField\\(\\{ required: true, integer: true, initial: 0, persisted: false \\}\\)`)
    );
  }
  assert.doesNotMatch(block, /min:\s*0/);
});

test("stealth attack effect labels exist in Russian and English", () => {
  for (const locale of [russian, english]) {
    const effects = locale.FALLOUTMAW.Effects;
    assert.ok(effects.StealthAttackGroup);
    assert.ok(effects.StealthAttackAccuracy);
    assert.ok(effects.StealthAttackCriticalChance);
    assert.ok(effects.StealthAttackDamagePercent);
    assert.ok(effects.StealthAttackCriticalDamagePercent);
  }
});

test("smoke perception modifier is available as a localized actor effect key", () => {
  const token = buildSmokePerceptionEffectKeyToken();
  assert.equal(SMOKE_PERCEPTION_PERCENT_EFFECT_KEY, "fallout-maw.smoke.perceptionPercent");
  assert.equal(token.path, SMOKE_PERCEPTION_PERCENT_EFFECT_KEY);
  assert.equal(token.code, "smokePerceptionPercent");
  assert.equal(token.group, russian.FALLOUTMAW.Effects.PerceptionGroup);
  assert.equal(token.label, russian.FALLOUTMAW.Effects.SmokePerceptionPercent);
  for (const locale of [russian, english]) {
    assert.ok(locale.FALLOUTMAW.Effects.PerceptionGroup);
    assert.ok(locale.FALLOUTMAW.Effects.SmokePerceptionPercent);
  }
});

async function readLocale(path) {
  return JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
}
