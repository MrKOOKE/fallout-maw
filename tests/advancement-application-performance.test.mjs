import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const applicationPath = new URL("../src/advancement/application.mjs", import.meta.url);
const abilitiesTemplatePath = new URL("../templates/actor/advancement-abilities.hbs", import.meta.url);
const applicationSource = await readFile(applicationPath, "utf8");
const abilitiesTemplate = await readFile(abilitiesTemplatePath, "utf8");

function sourceBetween(start, end) {
  const startIndex = applicationSource.indexOf(start);
  const endIndex = applicationSource.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `Missing source marker: ${end}`);
  return applicationSource.slice(startIndex, endIndex);
}

test("advancement context exits into page-specific preparation before development work", () => {
  const prepareContext = sourceBetween("  async _prepareContext(options)", "  async #prepareProficienciesPageContext(options)");
  const abilityBranch = prepareContext.indexOf('this.#page === "abilities"');
  const proficiencyBranch = prepareContext.indexOf('this.#page === "proficiencies"');
  const developmentSettings = prepareContext.indexOf("const characteristicSettings = getCharacteristicSettings()");
  assert.ok(abilityBranch >= 0 && abilityBranch < developmentSettings);
  assert.ok(proficiencyBranch >= 0 && proficiencyBranch < developmentSettings);
});

test("ability catalog preparation is synchronous and uses precomputed indexes", () => {
  const prepareCategories = sourceBetween("  #prepareAbilityCategories(", "  #prepareSelectedAbility()");
  assert.doesNotMatch(prepareCategories, /Promise\.all|actorHasAbility\(/);
  assert.match(prepareCategories, /ownedAbilityIds = new Set/);
  assert.match(prepareCategories, /researchBySourceId = new Map/);
  assert.match(prepareCategories, /this\.#abilityById = new Map/);
  assert.doesNotMatch(applicationSource, /getCreatureOptions/);
  assert.match(applicationSource, /getCreatureRaceSummaries/);
});

test("ability entries do not enrich every description during page render", () => {
  const prepareEntry = sourceBetween("  #prepareAbilityEntry(", "  #getAbilityResearch(");
  assert.doesNotMatch(prepareEntry, /TextEditor\.enrichHTML|renderAbilityDescriptionTooltipHTML/);
  assert.match(prepareEntry, /hasDescriptionTooltip/);
  assert.match(abilitiesTemplate, /data-ability-description-source-id/);
  assert.doesNotMatch(abilitiesTemplate, /data-ability-description-tooltip/);
});

test("ability selection and category toggles do not render the full application", () => {
  const localActions = sourceBetween("  static #onToggleAbilityCategory(", "  static async #onSpendAbilityResearch(");
  assert.doesNotMatch(localActions, /forceRender\(/);
  assert.match(localActions, /classList\.toggle/);
  assert.match(localActions, /#renderAbilityDetails/);
});

test("incremental draft commits suppress unrelated document application renders", () => {
  const commit = sourceBetween("  async #applyDraftToActor(", "  #scheduleRepeatCommit()");
  assert.match(commit, /render:\s*false/);
});
