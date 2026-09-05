import assert from "node:assert/strict";
import test from "node:test";
import {DEFAULT_RESOURCES} from "../src/config/defaults.mjs";
import {
  evaluateFormulaMap,
  evaluateNeedSettings,
  evaluateResourceSettings,
  evaluateSkillFormulas
} from "../src/formulas/evaluation.mjs";

globalThis.game = {i18n: {localize: key => key, format: key => key}};
globalThis.foundry = {utils: {
  deepClone: structuredClone,
  mergeObject: (base, update) => ({...base, ...update})
}};

const characteristics = [
  {key: "strength", abbr: "str", label: "Strength"},
  {key: "dexterity", abbr: "dex", label: "Dexterity"}
];
const skills = [{key: "medicine", abbr: "med", label: "Medicine", formula: "str*2+dex"}];

test("settings formulas reuse rules without retaining another Actor's values", () => {
  const first = {strength: 5, dexterity: 2};
  assert.deepEqual(evaluateSkillFormulas(skills, characteristics, first), {medicine: 12});
  assert.deepEqual(evaluateSkillFormulas(skills, characteristics, {strength: 3, dexterity: 7}), {medicine: 13});
  first.strength = 9;
  assert.deepEqual(evaluateSkillFormulas(skills, characteristics, first), {medicine: 20});
});

test("in-place formula and vocabulary changes invalidate compiled settings rules", () => {
  const vocabulary = structuredClone(characteristics);
  const rules = structuredClone(skills);
  const values = {strength: 3, dexterity: 8};
  assert.equal(evaluateSkillFormulas(rules, vocabulary, values).medicine, 14);
  rules[0].formula = "str*3";
  assert.equal(evaluateSkillFormulas(rules, vocabulary, values).medicine, 9);
  vocabulary[0].abbr = "power";
  vocabulary[1].abbr = "str";
  assert.equal(evaluateSkillFormulas(rules, vocabulary, values).medicine, 24);
});

test("needs and resource maxima read current skills and formula variables", () => {
  const needRules = [{key: "hunger", label: "Hunger", formula: "str+med/2"}];
  assert.equal(evaluateNeedSettings(needRules, characteristics, skills, {strength: 3}, {medicine: 8}).hunger, 7);
  assert.equal(evaluateNeedSettings(needRules, characteristics, skills, {strength: 6}, {medicine: 10}).hunger, 11);
  const resourceRules = [
    ...DEFAULT_RESOURCES.map(entry => ({...entry, formula: "0"})),
    {key: "energy", label: "Energy", formula: "str+med+limbs"}
  ];
  assert.equal(evaluateResourceSettings(resourceRules, characteristics, skills, {strength: 3}, {medicine: 8}, {limbs: 10, criticalLimbs: 5}).energy, 21);
  assert.equal(evaluateResourceSettings(resourceRules, characteristics, skills, {strength: 4}, {medicine: 9}, {limbs: 20, criticalLimbs: 5}).energy, 33);
  resourceRules.find(entry => entry.key === "energy").formula = "-str";
  assert.equal(evaluateResourceSettings(resourceRules, characteristics, skills, {strength: 4}, {}, {criticalLimbs: 5}).energy, 0);
});

test("formula maps preserve result order, truncation and negative values", () => {
  const definitions = [{key: "positive"}, {key: "negative"}, {key: "fraction"}];
  const formulas = {positive: "str+med", negative: "-str", fraction: "med/3"};
  assert.deepEqual(evaluateFormulaMap(formulas, definitions, characteristics, skills, {strength: 4}, {medicine: 8}), {
    positive: 12, negative: -4, fraction: 2
  });
  formulas.positive = "dex+med";
  assert.deepEqual(evaluateFormulaMap(formulas, definitions, characteristics, skills, {strength: 2, dexterity: 10}, {medicine: 7}), {
    positive: 17, negative: -2, fraction: 2
  });
});

test("invalid rules still warn individually and cannot poison later corrected rules", t => {
  const warnings = [];
  t.mock.method(console, "warn", message => warnings.push(message));
  const rules = [
    {key: "medicine", label: "Medicine", formula: "str/0"},
    {key: "repair", label: "Repair", formula: "unknownAlias"}
  ];
  assert.deepEqual(evaluateSkillFormulas(rules, characteristics, {strength: 3}), {medicine: 0, repair: 0});
  assert.equal(warnings.length, 2);
  rules[0].formula = "str/2";
  rules[1].formula = "str*2";
  assert.deepEqual(evaluateSkillFormulas(rules, characteristics, {strength: 3}), {medicine: 1, repair: 6});
  assert.equal(warnings.length, 2);
});
