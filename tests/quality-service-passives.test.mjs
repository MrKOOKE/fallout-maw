import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { SYSTEM_ID } from "../src/constants.mjs";
import {
  QUALITY_SERVICE_GRANT_FLAG_KEY,
  QUALITY_SERVICE_MAINTAINED_EFFECTS,
  getQualityServiceSelfTier,
  isQualityServiceSelfPassive,
  normalizeQualityServiceSettings
} from "../src/abilities/quality-service.mjs";
import {
  QUALITY_SERVICE_HOLD_GRANT_KIND,
  QUALITY_SERVICE_PASSIVE_GRANT_KIND,
  QUALITY_SERVICE_SELF_FLAG_KEY,
  buildQualityServiceSelfGrantEffectData,
  findQualityServiceSelfGrant,
  getQualityServiceSelfPassiveFunctions,
  qualityServiceFunctionIsSelfPassive
} from "../src/abilities/quality-service-passives.mjs";

const QUALITY_FUNCTION = Object.freeze({
  id: "function",
  type: "fixed",
  fixedKey: "qualityService",
  fixedSettings: { selfPassive: true },
  changes: []
});

test("the self-passive switch is a normal setting that stays off by default", () => {
  assert.equal(normalizeQualityServiceSettings({}).selfPassive, false);
  assert.equal(normalizeQualityServiceSettings({ selfPassive: "true" }).selfPassive, true);
  assert.equal(normalizeQualityServiceSettings({ selfPassive: true }).selfPassive, true);
  assert.equal(isQualityServiceSelfPassive({ selfPassive: true }), true);
  assert.equal(isQualityServiceSelfPassive({ selfPassive: false }), false);
  assert.equal(normalizeQualityServiceSettings({ selfPassive: true }).tiers.length, 3);
});

test("the passive owner bonus always uses the richest configured set", () => {
  const tier = getQualityServiceSelfTier({
    tiers: [
      { id: "10", holdEnergy: 10 },
      { id: "20", holdEnergy: 20 },
      { id: "40", holdEnergy: 40, damagePercent: 99 }
    ]
  });
  assert.equal(tier.id, "40");
  assert.equal(tier.holdEnergy, 40);
  assert.equal(tier.damagePercent, 99);
});

test("only a switched-on quality service function carries the owner bonus", () => {
  const abilityItem = {
    id: "ability",
    type: "ability",
    system: { functions: [QUALITY_FUNCTION] }
  };

  assert.deepEqual(getQualityServiceSelfPassiveFunctions(abilityItem).map(entry => entry.id), ["function"]);
  assert.equal(getQualityServiceSelfPassiveFunctions(abilityItem)[0].fixedSettings.selfPassive, true);
  assert.equal(getQualityServiceSelfPassiveFunctions({
    id: "plain",
    type: "ability",
    system: { functions: [{ ...QUALITY_FUNCTION, fixedSettings: {} }] }
  }).length, 0);
  assert.equal(getQualityServiceSelfPassiveFunctions({
    id: "other",
    type: "ability",
    system: { functions: [{ ...QUALITY_FUNCTION, fixedKey: "perfectFit" }] }
  }).length, 0);
  assert.equal(qualityServiceFunctionIsSelfPassive(QUALITY_FUNCTION), true);
  assert.equal(qualityServiceFunctionIsSelfPassive({ ...QUALITY_FUNCTION, fixedSettings: {} }), false);
  assert.equal(qualityServiceFunctionIsSelfPassive(null), false);
});

test("the passive owner bonus reuses the ordinary grant shape with the passive kind", () => {
  const abilityItem = {
    id: "ability",
    uuid: "Actor.owner.Item.ability",
    name: "Качественное обслуживание",
    img: "ability.webp"
  };
  const actor = { uuid: "Actor.owner", name: "Owner", img: "owner.webp" };

  const selfGrant = buildQualityServiceSelfGrantEffectData({
    sourceActor: actor,
    abilityItem,
    abilityFunction: QUALITY_FUNCTION
  });
  const data = selfGrant.flags[SYSTEM_ID][QUALITY_SERVICE_GRANT_FLAG_KEY];

  assert.equal(selfGrant.name, "Качественное обслуживание");
  assert.equal(selfGrant.transfer, false);
  assert.equal(selfGrant.showIcon, 0);
  assert.equal(data.kind, QUALITY_SERVICE_PASSIVE_GRANT_KIND);
  assert.equal(data.tierId, "40");
  assert.equal(data.tierLabel, "40 энергии");
  assert.equal(data.sourceActorUuid, "Actor.owner");
  assert.equal(data.targetActorUuid, "Actor.owner");
  assert.deepEqual(selfGrant.system.changes.map(change => change.key), [
    "system.combat.damagePercent",
    "system.combat.criticalChance",
    "system.combat.criticalDamagePercent",
    "system.combat.accuracy",
    "system.equipmentEffectiveness.protectionPercent",
    "system.equipmentEffectiveness.bonusPercent"
  ]);
});

test("the passive owner bonus is found through its own flag without hiding ordinary target holds", () => {
  const passive = createFlaggedEffect("passive", QUALITY_SERVICE_SELF_FLAG_KEY, {
    abilityItemId: "ability",
    functionId: "function",
    kind: QUALITY_SERVICE_PASSIVE_GRANT_KIND
  });
  const holdGrant = createFlaggedEffect("hold", QUALITY_SERVICE_GRANT_FLAG_KEY, {
    abilityItemId: "ability",
    functionId: "function",
    kind: QUALITY_SERVICE_HOLD_GRANT_KIND
  });
  const actor = { effects: [passive, holdGrant] };

  assert.equal(findQualityServiceSelfGrant(actor, { abilityItemId: "ability", functionId: "function" })?.id, "passive");
  assert.equal(
    QUALITY_SERVICE_MAINTAINED_EFFECTS.findGrant(actor, { kind: QUALITY_SERVICE_HOLD_GRANT_KIND })?.id,
    "hold"
  );
  assert.equal(QUALITY_SERVICE_MAINTAINED_EFFECTS.findGrant(actor)?.id, "hold");
  // The passive owner bonus lives under its own flag, so the maintained-target
  // grant API only ever sees ordinary holds and cannot hide them.
  assert.equal(QUALITY_SERVICE_MAINTAINED_EFFECTS.getGrantData(passive), null);
});

test("the runtime drives the owner bonus from the fixed-function switch", async () => {
  const [fixed, app, passives, maintainedEffects, catalogTemplate, itemTemplate, catalogEditor] = await Promise.all([
    readFile(new URL("../src/abilities/fixed-functions.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/apps/quality-service.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/abilities/quality-service-passives.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/abilities/maintained-target-effects.mjs", import.meta.url), "utf8"),
    readFile(new URL("../templates/settings/ability-catalog-item-editor.hbs", import.meta.url), "utf8"),
    readFile(new URL("../templates/item/item-sheet.hbs", import.meta.url), "utf8"),
    readFile(new URL("../src/apps/ability-catalog-item-editor.mjs", import.meta.url), "utf8")
  ]);

  assert.match(app, /includeSelf:\s*true/);
  assert.match(app, /qualityServiceFunctionIsSelfPassive\(this\.#abilityFunction\)/);
  assert.match(fixed, /reconcileQualityServicePassiveEffects\(item\)/);
  assert.match(fixed, /cleanupQualityServicePassiveEffects\(item\)/);
  assert.match(fixed, /reconcileQualityServicePassivesForKnownActors/);
  assert.match(fixed, /definition\.effects\.findGrant\(targetActor,\s*\{\s*kind:\s*grantKind\s*\}\)/);
  assert.match(passives, /deleteQualityServiceGrantForHold/);
  assert.match(maintainedEffects, /kind = ""/);
  // The owner stays a legal ordinary target; only the switch replaces self-holds.
  assert.match(fixed, /const targetsSelf = targetActor\.uuid === sourceActor\.uuid/);
  assert.doesNotMatch(fixed, /!targetActor \|\| targetActor\.uuid === sourceActor\.uuid/);
  assert.match(fixed, /targetsSelf && qualityServiceFunctionIsSelfPassive\(abilityFunction\)/);
  assert.doesNotMatch(fixed, /evolutionRootId|isQualityServiceEvolved/);
  assert.match(passives, /fixedSettings/);
  assert.doesNotMatch(passives, /ABILITY_SOURCE_FLAG|evolutionParentIds/);
  // The switch is authored in both fixed-function editors.
  assert.match(catalogTemplate, /data-field="fixed\.qualityService\.selfPassive"/);
  assert.match(itemTemplate, /\.fixedSettings\.selfPassive"/);
  assert.match(catalogEditor, /fixed\.qualityService\.selfPassive/);
});

function createFlaggedEffect(id, flagKey, data) {
  const flags = { [SYSTEM_ID]: { [flagKey]: data } };
  return {
    id,
    active: true,
    disabled: false,
    flags,
    getFlag: (systemId, key) => (systemId === SYSTEM_ID ? flags[SYSTEM_ID][key] : undefined)
  };
}
