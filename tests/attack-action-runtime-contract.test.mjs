import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

let generatedId = 0;
globalThis.foundry = {
  utils: {
    randomID: () => `generated-${++generatedId}`,
    deepClone: value => structuredClone(value)
  }
};

const {
  getAbilityAttackActionKey,
  projectAbilityAttackData,
  resolveAttackSource
} = await import("../src/combat/attack-source.mjs");

const controllerSource = await readFile(
  new URL("../src/combat/weapon-attack-controller.mjs", import.meta.url),
  "utf8"
);
const hudSource = await readFile(
  new URL("../src/apps/token-action-hud.mjs", import.meta.url),
  "utf8"
);
const fixedFunctionsSource = await readFile(
  new URL("../src/abilities/fixed-functions.mjs", import.meta.url),
  "utf8"
);
const actorSheetSource = await readFile(
  new URL("../src/sheets/actor-sheet.mjs", import.meta.url),
  "utf8"
);
const itemDocumentSource = await readFile(
  new URL("../src/documents/item.mjs", import.meta.url),
  "utf8"
);
const itemSheetSource = await readFile(
  new URL("../src/sheets/item-sheet.mjs", import.meta.url),
  "utf8"
);
const attackModifierSource = await readFile(
  new URL("../src/combat/weapon-attack-modifiers.mjs", import.meta.url),
  "utf8"
);
const customTokenSelectionSource = await readFile(
  new URL("../src/canvas/custom-token-selection.mjs", import.meta.url),
  "utf8"
);

function sliceBetween(source, startText, endText, fromIndex = 0) {
  const start = source.indexOf(startText, fromIndex);
  assert.notEqual(start, -1, `Missing start marker: ${startText}`);
  const end = source.indexOf(endText, start + startText.length);
  assert.notEqual(end, -1, `Missing end marker: ${endText}`);
  return source.slice(start, end);
}

test("area attack actions project to the complete volley runtime shape", () => {
  const settings = {
    name: "Plasma storm",
    targeting: { mode: "area" },
    sequence: { count: 4, difficultyPerAttack: 7 },
    area: {
      damageRadius: "@skills.explosives.value / 2",
      regionRadius: "4",
      regionDamageEntries: [{ damageTypeKey: "fire", amount: "2d6" }],
      regionDurationSeconds: "18",
      regionDelaySeconds: "6",
      regionRadiusDeltaMeters: "-1",
      explosionAnimationKey: "blast",
      explosionSoundPath: "audio/blast.ogg"
    }
  };

  assert.equal(getAbilityAttackActionKey(settings), "volley");
  const projected = projectAbilityAttackData(settings);
  assert.equal(projected.availableActions.volley, true);
  assert.equal(projected.availableActions.burst, false);
  assert.equal(projected.volley.damageRadius, "@skills.explosives.value / 2");
  assert.equal(projected.volley.regionRadius, "4");
  assert.deepEqual(projected.volley.regionDamageEntries, [{
    damageTypeKey: "fire",
    amount: "2d6"
  }]);
  assert.equal(projected.volley.regionDurationSeconds, "18");
  assert.equal(projected.volley.regionDelaySeconds, "6");
  assert.equal(projected.volley.regionRadiusDeltaMeters, "-1");
  assert.equal(projected.volley.explosionAnimationKey, "blast");
  assert.equal(projected.volley.explosionSoundPath, "audio/blast.ogg");
});

test("ability attack sources resolve without a synthetic weapon Item", () => {
  const ability = {
    type: "ability",
    system: {
      functions: [{
        id: "attack-one",
        type: "attackAction",
        attackSettings: {
          name: "Needler",
          targeting: { mode: "selectedTargets", aimed: true },
          sequence: { count: 3, difficultyPerAttack: 5 },
          resourceCosts: [{
            id: "cost-one",
            resourceKey: "actionPoints",
            formula: "2"
          }]
        }
      }]
    }
  };

  const source = resolveAttackSource(ability, "attack-one");
  assert.equal(source?.kind, "abilityAttack");
  assert.equal(source?.actionKey, "aimedShot");
  assert.equal(source?.data.availableActions.aimedShot, true);
  assert.equal(source?.data.moduleSlots.length, 0);
  assert.deepEqual(source?.data.resourceCosts, [{
    id: "cost-one",
    type: "actorResource",
    resourceKey: "actionPoints",
    formula: "2",
    amount: 0,
    overloadAmount: 0,
    overloadDurationSeconds: 0
  }]);
});

test("ability critical-damage properties survive runtime projection with their outcome identity", () => {
  const projected = projectAbilityAttackData({
    specialProperties: [{
      type: "criticalDamage",
      criticalDamage: {
        outcomeId: "target-failure",
        percentFormula: "150 + ene + @target.energy"
      }
    }]
  });

  assert.deepEqual(projected.specialProperties, [{
    type: "criticalDamage",
    criticalDamage: {
      outcomeId: "target-failure",
      percentFormula: "150 + ene + @target.energy"
    }
  }]);
});

test("area sequences use the configured exact count and per-attack difficulty", () => {
  const count = sliceBetween(
    controllerSource,
    "export function getActionAttackCount",
    "function getWeaponBurstDifficultyPerShot"
  );
  assert.match(count, /actionKey === VOLLEY_ACTION_KEY/);
  assert.match(count, /abilitySettings\?\.targeting\?\.mode === "area"/);
  assert.match(count, /abilitySettings\.sequence\?\.count/);

  const difficulty = sliceBetween(
    controllerSource,
    "function getBurstShotDifficultyBonus",
    "function getWeaponPelletCount"
  );
  assert.match(difficulty, /isSequencedAbilityArea/);
  assert.match(difficulty, /attackIndex[\s\S]*getEffectiveWeaponBurstDifficultyPerShot/);

  const duplicates = sliceBetween(
    controllerSource,
    "async prepareDuplicateAttackPlan",
    "onMove(event)"
  );
  assert.match(duplicates, /getAbilityAttackSettings\(this\.weapon, this\.weaponFunctionId\)/);
  assert.match(duplicates, /duplicateCount:\s*0/);
  assert.match(duplicates, /totalAttackCount:\s*baseAttackCount/);
});

test("ability trial critical damage is outcome-bound without changing ordinary weapon criticals", () => {
  const abilityTrialRuntime = sliceBetween(
    controllerSource,
    "async resolveAbilityTrialAttackAgainstTarget",
    "hasRequiredWeaponResources(multiplier"
  );
  assert.match(abilityTrialRuntime, /resolveAttackTrialOutcomeCriticalDamage\(\{/);
  assert.match(abilityTrialRuntime, /specialProperties:\s*settings\.specialProperties/);
  assert.match(abilityTrialRuntime, /evaluateFormula:\s*evaluateAbilityAttackFormula/);
  assert.match(abilityTrialRuntime, /criticalSuccess:\s*false/);
  assert.match(abilityTrialRuntime, /criticalDamageUsed:\s*criticalDamage\.applied/);
  assert.doesNotMatch(abilityTrialRuntime, /getCriticalDamageAmount\(/);

  const tracker = sliceBetween(
    controllerSource,
    "stampAttackDamageSources(requests",
    "createWeaponActionModifierContext"
  );
  assert.match(tracker, /source\?\.criticalDamageUsed === true/);

  const ordinaryWeaponCritical = sliceBetween(
    controllerSource,
    "function getCriticalDamageSnapshot",
    "function applyCriticalDamageSnapshot"
  );
  assert.match(ordinaryWeaponCritical, /isCriticalSuccessAttack\(outcome\)/);
  assert.match(ordinaryWeaponCritical, /criticalDamagePercent/);
  assert.match(ordinaryWeaponCritical, /getWeaponProficiencyInfluenceBonus\(weapon,\s*weaponFunctionId,\s*"criticalDamage"\)/);
});

test("ability trial source checks inherit the attacker's target-perception penalty", () => {
  const abilityTrialRuntime = sliceBetween(
    controllerSource,
    "async resolveAbilityTrialAttackAgainstTarget",
    "hasRequiredWeaponResources(multiplier"
  );
  assert.match(
    abilityTrialRuntime,
    /sourceCheckDataByMode:\s*\{[\s\S]*?once:\s*getUnseenAttackEdgeModifiers\(\s*sourceOnceUnperceivedTarget,[\s\S]*?perTarget:\s*getUnseenAttackEdgeModifiers\(\s*target,/
  );
  assert.match(abilityTrialRuntime, /const allTrialTargets = await this\.getAbilityTrialTargets\(target\)/);
});

test("HUD buttons and terminal ability dispatch include attack actions", () => {
  const buttons = sliceBetween(
    hudSource,
    "function prepareAbilityItemButtons",
    "function prepareAbilityGroups"
  );
  assert.match(buttons, /ABILITY_FUNCTION_TYPES\.attackAction/);
  assert.match(buttons, /functionId:\s*abilityFunction\.id/);
  assert.match(buttons, /abilityFunction\.attackSettings\?\.name/);
  assert.match(buttons, /hasAttackPowerControl:\s*attackPowerState\.active/);

  const activePredicate = sliceBetween(
    fixedFunctionsSource,
    "export function isActiveAbilityFunction",
    "export function isFixedAbilityFunctionToggleable"
  );
  assert.match(activePredicate, /isAttackActionAbilityFunction\(abilityFunction\)/);

  const dispatch = sliceBetween(
    fixedFunctionsSource,
    "export async function useAbilityFunctionItem",
    "async function useActiveApplicationAbilityFunction"
  );
  assert.match(dispatch, /startAbilityAttackActionAndWait\(\{/);
  assert.match(dispatch, /token:\s*sourceToken/);
  assert.match(dispatch, /functionId:\s*abilityFunction\.id/);
  assert.match(dispatch, /chainRef:\s*scope\.chainRef/);
  assert.match(dispatch, /onInteractionCancelled/);
});

test("Attack Power preserves actor-resource identity and formulas in runtime previews", () => {
  const runtime = sliceBetween(
    controllerSource,
    "function applyWeaponAttackPowerResourceCosts",
    "function addFormulaNumber"
  );
  assert.match(runtime, /getWeaponResourceCostIdentity\(\{ type, resourceKey \}\)/);
  assert.match(runtime, /`\$\{type\}:\$\{resourceKey\}`/);
  assert.match(runtime, /target\.formula = addFormulaTexts/);

  const hud = sliceBetween(
    hudSource,
    "function applyWeaponAttackPowerDialogResourceCosts",
    "function getWeaponAttackPowerPreviewStats"
  );
  assert.match(hud, /getWeaponAttackPowerPreviewResourceCostIdentity\(\{ type, resourceKey \}\)/);
  assert.match(hud, /target\.formula = addFormulaTexts/);

  const actorTooltip = sliceBetween(
    actorSheetSource,
    "function applyWeaponAttackPowerTooltipResourceCosts",
    "function addTooltipFormulaNumber"
  );
  assert.match(actorTooltip, /getWeaponTooltipResourceCostIdentity\(\{ type, resourceKey \}\)/);
  assert.match(actorTooltip, /target\.formula = addFormulaTexts/);
});

test("actor costs are once per action while item costs scale per attack", () => {
  const collect = sliceBetween(
    controllerSource,
    "function collectWeaponResourceSpendTotals",
    "function getMissingCollectedWeaponItemResourceCost"
  );
  const actorBranch = sliceBetween(
    collect,
    'if (type === "actorResource")',
    "continue;"
  );
  assert.doesNotMatch(actorBranch, /baseMultiplier/);
  assert.match(collect, /cost\?\.amount\) \* baseMultiplier/);

  const spend = sliceBetween(
    controllerSource,
    "async function spendWeaponResources",
    "function collectWeaponResourceSpendTotals"
  );
  assert.doesNotMatch(spend, /weapon-action-point-cost/);

  const currentAttack = sliceBetween(
    controllerSource,
    "async spendCurrentAttackCosts",
    "async executeAgainstToken"
  );
  assert.match(currentAttack, /canSpendCombinedWeaponActionPointCosts/);
  assert.match(currentAttack, /await commitWeaponActionPointSpend/);
  assert.match(currentAttack, /beforeItemCommit:\s*commitActionPointSpend/);
  assert.match(currentAttack, /rollbackBeforeItemCommit:\s*rollbackActionPointSpend/);
  assert.match(currentAttack, /await finalizeCommittedWeaponActionPointSpend/);
  assert.doesNotMatch(currentAttack, /actionPointCostAlreadySpent/);

  const combined = sliceBetween(
    controllerSource,
    "function canSpendCombinedWeaponActionPointCosts",
    "async function spendWeaponActionPoints"
  );
  assert.match(combined, /getStrictActionPointState/);
  assert.match(combined, /dynamicState\.ownTurn/);
  assert.match(combined, /dynamicState\.value - strictCost/);

  const dynamicSpend = sliceBetween(
    controllerSource,
    "async function spendWeaponActionPoints",
    "async function spendWeaponResources"
  );
  assert.match(dynamicSpend, /spendCombatActionPointsWithReceipt/);
  assert.match(dynamicSpend, /refundCombatActionPointReceipt/);
});

test("target sequence difficulty is a real difficulty bonus and Foundry dialogs are bound", () => {
  assert.match(controllerSource, /const \{ DialogV2 \} = foundry\.applications\.api/);
  const sequence = sliceBetween(
    controllerSource,
    "async function executeAbilityAttackTargetSequence",
    "async function requestAbilityAttackDirectionModifier"
  );
  assert.match(sequence, /difficultyBonus:\s*difficultyStep \* index/);
  assert.doesNotMatch(sequence, /accuracyModifier:\s*-\(difficultyStep/);
  assert.match(sequence, /requestCustomTokenSelection\(\{/);
  assert.match(sequence, /settings\.targeting\?\.targetLimitFormula/);
  assert.match(sequence, /settings\.maxRangeMeters/);
  assert.match(sequence, /allowRepeated:\s*allowRepeatedTargets/);
  assert.match(sequence, /executeWeaponAttackAgainstToken\(\{/);
  assert.match(sequence, /strictTargetResolution:\s*true/);
  assert.doesNotMatch(sequence, /captureCommandedWeaponAttackSelection\(/);
  assert.doesNotMatch(sequence, /executeCapturedWeaponAttack\(/);
  assert.doesNotMatch(sequence, /requestAbilityAttackSequenceReview\(/);
  assert.doesNotMatch(controllerSource, /function requestAbilityAttackSequenceReview\(/);
  assert.match(customTokenSelectionSource, /if \(selected\.length >= selectionLimit\) confirm\(\)/);
  assert.match(customTokenSelectionSource, /event\.key === "Escape"\) finish\(\[\]\);\s*else confirm\(\)/);
  assert.doesNotMatch(customTokenSelectionSource, /from\s+["']\.\.\/combat\/weapon-attack-controller\.mjs["']/);
  assert.match(customTokenSelectionSource, /from\s+["']\.\/physical-los\.mjs["']/);

  assert.match(attackModifierSource, /getWeaponAttackModifierDifficultyBonus/);
  assert.match(controllerSource, /getAttackModifierDifficultyBonus\(\)/);
});

test("ability Attack Power affects cone geometry and persists from the HUD", () => {
  const cone = sliceBetween(
    controllerSource,
    "function getActionAttackConeRadians",
    "function getActionMaxRangeMeters"
  );
  assert.match(cone, /!getAbilityAttackSettings\(weapon, weaponFunctionId\) && hasActionCone/);

  const dialog = sliceBetween(
    hudSource,
    "async function openWeaponAttackPowerDialog",
    "function buildWeaponAttackPowerPreviewContext"
  );
  assert.match(dialog, /getAbilityAttackSettings\(weapon, functionId\)/);
  assert.match(dialog, /projectAbilityAttackData\(abilitySettings\)/);
  assert.match(dialog, /createAbilityAttackUpdateData/);
});

test("an existing attack function type is locked by stable id at the document boundary", () => {
  const guard = sliceBetween(
    itemDocumentSource,
    "function preserveLockedAbilityAttackFunctionTypes",
    "async function getInventoryOperationActor"
  );
  assert.match(itemDocumentSource, /preserveLockedAbilityAttackFunctionTypes\(this, changes\)/);
  assert.match(guard, /entry\?\.type \?\? ""\) === "attackAction"/);
  assert.match(guard, /lockedById\.get\(String\(entry\?\.id/);
  assert.match(guard, /entry\.type = "attackAction"/);
  assert.match(guard, /entry\.attackSettings = foundry\.utils\.deepClone/);
});

test("ordinary weapon cost deletion reconciles dependent references immediately", () => {
  const deletion = sliceBetween(
    itemSheetSource,
    "#onDeleteWeaponResourceCost",
    "#onWeaponResourceCostTypeChange"
  );
  assert.match(deletion, /const previousCosts = foundry\.utils\.deepClone\(costs\)/);
  assert.match(deletion, /reconcileWeaponResourceCostReferences\(reconciled, previousCosts\)/);
  assert.match(deletion, /buildWeaponResourceReferenceUpdate\(path, reconciled\)/);
});
