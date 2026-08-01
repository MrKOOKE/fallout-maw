import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [
  runtimeSource,
  controllerSource,
  abilityActionsSource,
  movementSource,
  effectKeysSource,
  effectTokensSource,
  activeUseKeysSource,
  actorModelSource,
  ru,
  en
] = await Promise.all([
  readFile(new URL("../src/combat/attack-action-point-movement-loss.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/combat/weapon-attack-controller.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/abilities/ability-actions.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/combat/movement-resources.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/utils/active-effect-keys.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/utils/effect-key-tokens.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/abilities/active-use-keys.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/data/models/actor-data-models.mjs", import.meta.url), "utf8"),
  readFile(new URL("../lang/ru.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../lang/en.json", import.meta.url), "utf8").then(JSON.parse)
]);

test("attack MP loss is a serialized post-spend consequence without an affordability gate", () => {
  assert.match(movementSource, /export async function runMovementResourceSpendingSerially/);
  assert.match(runtimeSource, /runMovementResourceSpendingSerially\(actor,/);
  assert.match(runtimeSource, /Math\.min\(current, requested\)/);
  assert.match(runtimeSource, /Number\(disabledValue\) > DISABLED_EFFECT_THRESHOLD/);
  assert.doesNotMatch(runtimeSource, /\bcanSpend[A-Z]|\bquote[A-Z]/u);

  const ordinary = sliceBetween(
    controllerSource,
    "async spendCurrentAttackCosts",
    "async executeAgainstToken"
  );
  const weaponSpend = ordinary.indexOf("await spendWeaponResources");
  const movementLoss = ordinary.indexOf("await applyAttackActionPointMovementLoss");
  const finalize = ordinary.indexOf("await finalizeCommittedWeaponActionPointSpend");
  assert.ok(weaponSpend >= 0);
  assert.ok(movementLoss > weaponSpend);
  assert.ok(finalize > movementLoss);
  assert.doesNotMatch(ordinary.slice(0, weaponSpend), /movementPoints|AttackActionPointMovementLoss/);
});

test("ordinary attacks convert only actual AP receipts and committed actor-resource AP costs", () => {
  const ordinary = sliceBetween(
    controllerSource,
    "async spendCurrentAttackCosts",
    "async executeAgainstToken"
  );
  assert.match(ordinary, /committedActionPointSpend\?\.receipt\?\.resourceKey === "actionPoints"/);
  assert.match(ordinary, /getPaidActorResourceAmount\(committedActorResourceCosts, "actionPoints"\)/);
  assert.match(ordinary, /await applyAttackActionPointMovementLoss\(this\.token\.actor, spentAttackActionPoints,/);

  const weaponResources = sliceBetween(
    controllerSource,
    "async function spendWeaponResources",
    "function collectWeaponResourceSpendTotals"
  );
  assert.match(weaponResources, /actorCosts: payment\.execution\?\.spendReceipt\?\.costs \?\? \[\]/);
});

test("dual, commanded, generic ability and ability-action attack routes convert their committed AP", () => {
  const dual = sliceBetween(
    controllerSource,
    "export function startDualWeaponAttack",
    "function validateDualWeaponAttackResources"
  );
  assert.match(dual, /spendCombatActionPointsWithReceipt/);
  assert.match(dual, /transaction\.receipt\.resourceKey === "actionPoints"/);
  assert.match(dual, /applyAttackActionPointMovementLoss/);

  const commanded = sliceBetween(
    controllerSource,
    "async function spendCommandedActionPointCosts",
    "async function validateCommandedAbilityAuthority"
  );
  assert.match(commanded, /spendStrictActionPointsWithReceipt/);
  assert.match(commanded, /refundStrictActionPointReceipt/);
  assert.match(commanded, /receipt\?\.resourceKey !== "actionPoints"/);
  assert.match(commanded, /applyAttackActionPointMovementLoss/);

  const genericAbility = sliceBetween(
    controllerSource,
    "const payCosts = async () =>",
    "const label ="
  );
  assert.match(genericAbility, /getPaidActorResourceAmount\(payment, "actionPoints"\)/);
  assert.match(genericAbility, /applyAttackActionPointMovementLoss/);

  const abilityAction = sliceBetween(
    abilityActionsSource,
    "async function executeAbilityActionAttackQuery",
    "function pickRandomAbilityAttackOption"
  );
  assert.match(abilityAction, /spendStrictActionPointsWithReceipt/);
  assert.match(abilityAction, /applyAttackActionPointMovementLoss/);
  assert.match(abilityAction, /skipActionPointCost:\s*true/);
});

test("conversion and disable keys are prepared, selectable and consumable active-use keys", () => {
  for (const key of [
    "ATTACK_ACTION_POINT_MOVEMENT_LOSS_PERCENT_BONUS_EFFECT_KEY",
    "ATTACK_ACTION_POINT_MOVEMENT_LOSS_DISABLED_EFFECT_KEY"
  ]) {
    assert.match(effectKeysSource, new RegExp(`export const ${key}`));
    assert.match(activeUseKeysSource, new RegExp(`\\b${key}\\b`));
  }
  assert.match(effectTokensSource, /attackActionPointMovementLossPercentBonus/);
  assert.match(effectTokensSource, /attackActionPointMovementLossDisabled/);
  assert.match(actorModelSource, /attackActionPointMovementLossPercentBonus:[\s\S]*?persisted: false/);
  assert.match(actorModelSource, /attackActionPointMovementLossDisabled:[\s\S]*?persisted: false/);
});

test("all attack MP-loss settings and effect labels are localized", () => {
  const settingKeys = [
    "AttackActionPointMovementLossTitle",
    "AttackActionPointMovementLossHint",
    "AttackActionPointMovementLossMode",
    "AttackActionPointMovementLossPercent",
    "AttackActionPointMovementLossPercentHint",
    "AttackActionPointMovementLossModePercent",
    "AttackActionPointMovementLossModeDisabled",
    "AttackActionPointMovementLossModeFullLoss"
  ];
  const effectKeys = [
    "AttackActionPointMovementLossPercentBonus",
    "AttackActionPointMovementLossDisabled"
  ];
  for (const language of [ru, en]) {
    for (const key of settingKeys) {
      assert.ok(language.FALLOUTMAW.Settings.Combat[key]?.trim(), key);
    }
    for (const key of effectKeys) {
      assert.ok(language.FALLOUTMAW.Effects[key]?.trim(), key);
    }
  }
});

function sliceBetween(source, startText, endText) {
  const start = source.indexOf(startText);
  assert.notEqual(start, -1, `Missing start marker: ${startText}`);
  const end = source.indexOf(endText, start + startText.length);
  assert.notEqual(end, -1, `Missing end marker: ${endText}`);
  return source.slice(start, end);
}
