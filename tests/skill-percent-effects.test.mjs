import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const SKILLS = Object.freeze([
  { key: "naturalist", abbr: "nat", label: "Натуралист", formula: "100", img: "" },
  { key: "fieldLore", abbr: "fld", label: "Полевые знания", formula: "50", img: "" }
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
    localize: key => String(key ?? ""),
    format: (key, data = {}) => `${key}:${String(data.label ?? "")}`
  },
  settings: {
    get(_namespace, key) {
      if (key === "skillSettings") return { entries: SKILLS };
      throw new Error(`Setting ${key} is unavailable in this unit test`);
    }
  }
};

const {
  ALL_SKILLS_BONUS_PERCENT_EFFECT_KEY,
  getReverseEffectKey,
  isSkillBonusPercentEffectKey
} = await import("../src/utils/active-effect-keys.mjs");
const {
  expandActorEffectChangeKeys,
  prepareActorEffectChangeForApplication
} = await import("../src/utils/active-effect-changes.mjs");
const {
  buildAllSkillsBonusPercentEffectKeyToken,
  buildEffectKeyTokens,
  buildReverseInteractionEffectKeyTokens,
  buildSkillBonusPercentEffectKeyTokens
} = await import("../src/utils/effect-key-tokens.mjs");
const {
  getSkillCheckActiveUseKeys,
  getWeaponActionActiveUseKeys,
  isActiveUseEffectKey
} = await import("../src/abilities/active-use-keys.mjs");
const {
  formulaUsesPreparedActorReferences,
  getActorFormulaApplicationPhase
} = await import("../src/utils/actor-formulas.mjs");

test("actor skill schema exposes only derived fields for the percentage layer", () => {
  const source = readFileSync(
    new URL("../src/data/models/actor-data-models.mjs", import.meta.url),
    "utf8"
  );

  assert.match(
    source,
    /bonusPercent:\s*new NumberField\(\{\s*required:\s*true,\s*integer:\s*true,\s*initial:\s*0,\s*persisted:\s*false\s*\}\)/
  );
  assert.match(
    source,
    /pureValue:\s*new NumberField\(\{\s*required:\s*true,\s*integer:\s*true,\s*min:\s*0,\s*initial:\s*0,\s*persisted:\s*false\s*\}\)/
  );
  assert.match(
    source,
    /developmentLimitPureOnly:\s*new BooleanField\(\{\s*required:\s*true,\s*initial:\s*true,\s*persisted:\s*false\s*\}\)/
  );
  assert.match(
    source,
    /valueBeforePercent:\s*new NumberField\(\{\s*required:\s*true,\s*integer:\s*true,\s*initial:\s*0,\s*persisted:\s*false\s*\}\)/
  );
});

test("configured skills receive one canonical percentage effect key each", () => {
  const tokens = buildSkillBonusPercentEffectKeyTokens();
  const completePaths = new Set(buildEffectKeyTokens().map(token => token.path));

  assert.deepEqual(
    tokens.map(token => token.path),
    SKILLS.map(skill => `system.skills.${skill.key}.bonusPercent`)
  );
  assert.equal(new Set(tokens.map(token => token.path)).size, SKILLS.length);
  assert.equal(tokens.every(token => completePaths.has(token.path)), true);
  assert.equal(
    buildAllSkillsBonusPercentEffectKeyToken().path,
    "system.skills.all.bonusPercent"
  );
  assert.equal(completePaths.has(ALL_SKILLS_BONUS_PERCENT_EFFECT_KEY), true);
});

test("all-skills percentage change expands across configured and actor-owned dynamic skills", () => {
  const actor = {
    system: {
      skills: {
        naturalist: {},
        archivedLore: {}
      }
    }
  };
  const changes = expandActorEffectChangeKeys(actor, {
    key: ALL_SKILLS_BONUS_PERCENT_EFFECT_KEY,
    type: "add",
    value: "20"
  });

  assert.deepEqual(
    new Set(changes.map(change => change.key)),
    new Set([
      "system.skills.naturalist.bonusPercent",
      "system.skills.fieldLore.bonusPercent",
      "system.skills.archivedLore.bonusPercent"
    ])
  );
  assert.equal(changes.every(change => change.type === "add" && change.value === "20"), true);
  assert.equal(changes.some(change => change.key === ALL_SKILLS_BONUS_PERCENT_EFFECT_KEY), false);
});

test("skill percentage keys are recognized in ordinary and reverse form", () => {
  const exact = "system.skills.naturalist.bonusPercent";
  const reverse = getReverseEffectKey(exact);

  assert.equal(isSkillBonusPercentEffectKey(exact), true);
  assert.equal(isSkillBonusPercentEffectKey(ALL_SKILLS_BONUS_PERCENT_EFFECT_KEY), true);
  assert.equal(isSkillBonusPercentEffectKey(reverse), true);
  assert.equal(isSkillBonusPercentEffectKey("system.skills.naturalist.bonus"), false);
  assert.equal(isSkillBonusPercentEffectKey("system.skills.naturalist.bonusPercent.extra"), false);
});

test("actor percentage changes are forced into the derived-data phase without rerouting reverse formulas", () => {
  const exact = "system.skills.naturalist.bonusPercent";

  assert.equal(getActorFormulaApplicationPhase({
    key: exact,
    phase: "final",
    value: "50"
  }), "initial");
  assert.equal(getActorFormulaApplicationPhase({
    key: ALL_SKILLS_BONUS_PERCENT_EFFECT_KEY,
    phase: "final",
    value: "@skills.naturalist.value / 10"
  }), "initial");
  assert.equal(getActorFormulaApplicationPhase({
    key: getReverseEffectKey(exact),
    phase: "final",
    value: "@skills.naturalist.value / 10"
  }), "final");
});

test("characteristic aliases keep evaluator priority over colliding prepared indicator aliases", () => {
  const formulaData = {
    characteristicSettings: [{ key: "endurance", abbr: "con", label: "Endurance" }],
    characteristics: { endurance: 10 },
    skillSettings: [],
    formulaVariables: {
      con: 99,
      consciousnessValue: 99
    },
    formulaReferences: {}
  };
  const limbBonusChange = {
    key: "system.limbs.all.maxBonus",
    phase: "initial",
    value: "con"
  };

  assert.equal(formulaUsesPreparedActorReferences("con", formulaData), false);
  assert.equal(
    getActorFormulaApplicationPhase(limbBonusChange, null, { formulaData }),
    "initial"
  );
  assert.equal(
    prepareActorEffectChangeForApplication({}, limbBonusChange, { formulaData }).value,
    10
  );
  assert.equal(formulaUsesPreparedActorReferences("consciousnessValue", formulaData), true);
  assert.equal(
    getActorFormulaApplicationPhase({ ...limbBonusChange, value: "consciousnessValue" }, null, { formulaData }),
    "final"
  );
});

test("reverse interaction autocomplete exposes specific and all-skills percentage keys", () => {
  const paths = new Set(buildReverseInteractionEffectKeyTokens().map(token => token.path));

  for (const skill of SKILLS) {
    assert.equal(
      paths.has(getReverseEffectKey(`system.skills.${skill.key}.bonusPercent`)),
      true,
      skill.key
    );
  }
  assert.equal(paths.has(getReverseEffectKey(ALL_SKILLS_BONUS_PERCENT_EFFECT_KEY)), true);
});

test("skill checks and weapon checks declare percentage keys as active-use dependencies", () => {
  const exact = "system.skills.naturalist.bonusPercent";
  const reverse = getReverseEffectKey(exact);
  const skillKeys = getSkillCheckActiveUseKeys("naturalist");

  assert.equal(skillKeys.has(exact), true);
  assert.equal(skillKeys.has(ALL_SKILLS_BONUS_PERCENT_EFFECT_KEY), true);
  assert.equal(isActiveUseEffectKey(exact), true);
  assert.equal(isActiveUseEffectKey(reverse), true);
  assert.equal(
    isActiveUseEffectKey(getReverseEffectKey(ALL_SKILLS_BONUS_PERCENT_EFFECT_KEY)),
    true
  );

  const weaponKeys = getWeaponActionActiveUseKeys({
    actionKey: "aimedShot",
    activeUseStages: { action: false, check: true, damage: false },
    weaponData: { skillKey: "naturalist" }
  });
  assert.equal(weaponKeys.has(exact), true);
  assert.equal(weaponKeys.has(ALL_SKILLS_BONUS_PERCENT_EFFECT_KEY), true);
});
