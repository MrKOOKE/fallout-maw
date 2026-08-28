import assert from "node:assert/strict";
import test from "node:test";

class FieldStub {
  constructor(fields = {}, ...options) {
    this.fields = fields;
    this.options = options;
  }
}

globalThis.foundry = {
  abstract: { TypeDataModel: class {} },
  applications: {
    api: { DialogV2: class {} },
    ux: { FormDataExtended: class {} },
    handlebars: { renderTemplate: () => "" }
  },
  data: {
    fields: Object.fromEntries([
      "ArrayField",
      "BooleanField",
      "HTMLField",
      "NumberField",
      "ObjectField",
      "SchemaField",
      "StringField",
      "TypedObjectField"
    ].map(name => [name, class extends FieldStub {}]))
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
    localize: key => String(key ?? ""),
    format: key => String(key ?? "")
  },
  settings: {
    get() {
      throw new Error("Settings are unavailable in this unit test.");
    }
  }
};

const {
  getSkillCheckActionEffectKeys,
  getSkillCheckActionId,
  isSkillCheckActionEffectKey,
  SKILL_CHECK_ACTIONS
} = await import("../src/rolls/skill-check-action-effects.mjs");
const { BaseActorDataModel } = await import("../src/data/models/actor-data-models.mjs");
const { buildSkillCheckActionEffectKeyTokens } = await import("../src/utils/effect-key-tokens.mjs");

const RESISTANCE_ACTIONS = Object.freeze([
  {
    id: "grappleResistance",
    label: "Сопротивление захвату",
    aliases: ["grappleResistance", "grappleEscape"]
  },
  {
    id: "knockdownResistance",
    label: "Сопротивление опрокидыванию",
    aliases: ["knockdownResistance"]
  },
  {
    id: "knockbackResistance",
    label: "Сопротивление отталкиванию",
    aliases: [
      "knockbackResistance",
      "activePushResistance",
      "weaponPushResistance",
      "keepAwayResistance"
    ]
  }
]);

test("resistance requester aliases resolve to canonical skill-check actions and keys", () => {
  for (const expected of RESISTANCE_ACTIONS) {
    const action = SKILL_CHECK_ACTIONS.find(entry => entry.id === expected.id);
    assert.equal(action?.label, expected.label);
    assert.deepEqual(action?.requesterAliases, expected.aliases);

    for (const alias of expected.aliases) {
      assert.equal(getSkillCheckActionId(alias), expected.id);
      assert.equal(getSkillCheckActionId(alias.toUpperCase()), expected.id);
    }

    const keys = getSkillCheckActionEffectKeys(expected.aliases.at(-1));
    assert.deepEqual(keys, [
      `system.skillCheck.actions.${expected.id}.bonus`,
      `system.skillCheck.actions.${expected.id}.advantage`,
      `system.skillCheck.actions.${expected.id}.disadvantage`
    ]);
    assert.equal(keys.every(isSkillCheckActionEffectKey), true);
  }
});

test("resistance actions are exposed by the actor schema and effect-key autocomplete", () => {
  const actionFields = BaseActorDataModel.defineSchema().skillCheck.fields.actions.fields;
  const tokensByPath = new Map(buildSkillCheckActionEffectKeyTokens().map(token => [token.path, token]));

  for (const { id, label } of RESISTANCE_ACTIONS) {
    assert.deepEqual(Object.keys(actionFields[id].fields), ["bonus", "advantage", "disadvantage"]);
    for (const [field, fieldLabel] of [
      ["bonus", "Изменение навыка"],
      ["advantage", "Преимущество"],
      ["disadvantage", "Помеха"]
    ]) {
      const path = `system.skillCheck.actions.${id}.${field}`;
      const token = tokensByPath.get(path);
      assert.equal(token?.label, `${fieldLabel}: ${label}`);
      assert.equal(token?.group, "Проверки действий");
    }
  }
});
