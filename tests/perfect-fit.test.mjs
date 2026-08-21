import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { SYSTEM_ID } from "../src/constants.mjs";
import {
  ABILITY_FIXED_FUNCTION_KEYS,
  ABILITY_FUNCTION_TYPES,
  normalizeAbilityFunctions,
  normalizePerfectFitSettings
} from "../src/settings/abilities.mjs";
import {
  PERFECT_FIT_GRANT_FLAG_KEY,
  PERFECT_FIT_HOLD_FLAG_KEY,
  buildPerfectFitGrantEffectData,
  buildPerfectFitHoldEffectData,
  findPerfectFitGrant,
  getPerfectFitHoldData,
  getPerfectFitHolds
} from "../src/abilities/perfect-fit.mjs";
import { getActorAvailableEnergy } from "../src/combat/energy-resource.mjs";
import { calculateEquipmentRequirementMovementPointPenalty } from "../src/items/equipment-requirements.mjs";
import {
  EQUIPMENT_REQUIREMENT_PERCENT_EFFECT_KEY,
  WEAPON_REQUIREMENT_PERCENT_EFFECT_KEY,
  getAdjustedEquipmentRequirement,
  getAdjustedWeaponRequirement
} from "../src/items/requirement-modifiers.mjs";

test("perfect fit settings preserve the requested passive and hold defaults", () => {
  assert.deepEqual(normalizePerfectFitSettings(), {
    equipmentRequirementPercent: -50,
    weaponRequirementPercent: -50,
    holdEnergy: 10
  });
  assert.deepEqual(normalizePerfectFitSettings({
    equipmentRequirementPercent: -150,
    weaponRequirementPercent: -25,
    holdEnergy: -5
  }), {
    equipmentRequirementPercent: -100,
    weaponRequirementPercent: -25,
    holdEnergy: 0
  });
});

test("general requirement keys modify every equipment and weapon requirement", () => {
  const actor = {
    system: {
      requirements: { equipmentPercent: -50, weaponPercent: -50 },
      skills: { repair: { value: 30 } },
      characteristics: {}
    }
  };
  assert.deepEqual(getAdjustedEquipmentRequirement(actor, {
    type: "characteristic",
    key: "strength",
    value: 81
  }), {
    type: "characteristic",
    key: "strength",
    baseRequired: 81,
    required: 41,
    modifierPercent: -50
  });
  assert.deepEqual(getAdjustedWeaponRequirement(actor, {
    type: "skill",
    key: "repair",
    value: 81
  }), {
    type: "skill",
    key: "repair",
    baseRequired: 81,
    required: 41,
    modifierPercent: -50
  });

  const armor = {
    type: "gear",
    system: {
      equipped: true,
      placement: { mode: "equipment" },
      functions: {
        damageMitigation: {
          enabled: true,
          requirements: [{ type: "skill", key: "repair", value: 80 }]
        }
      }
    }
  };
  assert.equal(calculateEquipmentRequirementMovementPointPenalty(actor, armor), 2);
});

test("perfect fit fixed functions project the two ordinary effect keys", () => {
  const [abilityFunction] = normalizeAbilityFunctions([{
    id: "function",
    type: ABILITY_FUNCTION_TYPES.fixed,
    fixedKey: ABILITY_FIXED_FUNCTION_KEYS.perfectFit,
    fixedSettings: normalizePerfectFitSettings()
  }]);
  assert.deepEqual(abilityFunction.changes.map(change => [change.key, change.value]), [
    [EQUIPMENT_REQUIREMENT_PERCENT_EFFECT_KEY, "-50"],
    [WEAPON_REQUIREMENT_PERCENT_EFFECT_KEY, "-50"]
  ]);
});

test("holds use their current functionId directly", () => {
  const effect = {
    disabled: false,
    active: true,
    flags: {
      [SYSTEM_ID]: {
        [PERFECT_FIT_HOLD_FLAG_KEY]: {
          abilityItemId: "ability",
          functionId: "function",
          equipmentRequirementPercent: -50,
          weaponRequirementPercent: -50
        }
      }
    }
  };
  assert.equal(getPerfectFitHoldData(effect).functionId, "function");
  assert.equal(getPerfectFitHoldData(effect).equipmentRequirementPercent, -50);
  assert.equal(getPerfectFitHolds({ effects: [effect] }, {
    abilityItemId: "ability",
    functionId: "function"
  }).length, 1);
});

test("perfect fit hold blocks energy through the native resourceBlock channel", () => {
  const fixture = createEffectFixture();
  const grant = buildPerfectFitGrantEffectData(fixture);
  const hold = buildPerfectFitHoldEffectData({ ...fixture, targetEffectId: "grant", holdEnergy: 10 });

  assert.equal(grant.showIcon, 0);
  assert.equal(hold.showIcon, 0);
  assert.equal(grant.name, "Идеальная подгонка");
  assert.equal("sourceActorName" in grant.flags[SYSTEM_ID][PERFECT_FIT_GRANT_FLAG_KEY], false);
  assert.deepEqual(grant.system.changes.map(change => [change.key, change.value]), [
    [EQUIPMENT_REQUIREMENT_PERCENT_EFFECT_KEY, "-50"],
    [WEAPON_REQUIREMENT_PERCENT_EFFECT_KEY, "-50"]
  ]);
  assert.equal(grant.flags[SYSTEM_ID][PERFECT_FIT_GRANT_FLAG_KEY].equipmentRequirementPercent, -50);
  assert.equal(hold.flags[SYSTEM_ID].damageEffect.kind, "resourceBlock");
  assert.equal(hold.flags[SYSTEM_ID].damageEffect.resources.power, 10);
  assert.equal(hold.flags[SYSTEM_ID][PERFECT_FIT_HOLD_FLAG_KEY].targetEffectId, "grant");
  assert.equal(getActorAvailableEnergy({
    system: { resources: { power: { value: 50, min: 0 } } },
    effects: [{
      disabled: false,
      getFlag: (scope, key) => hold.flags?.[scope]?.[key]
    }]
  }), 40);
});

test("perfect fit grants are unique by ability type rather than by their source actor", () => {
  const grant = buildPerfectFitGrantEffectData(createEffectFixture());
  const effect = { id: "grant", active: true, disabled: false, ...grant };
  const target = { effects: [effect] };
  assert.equal(findPerfectFitGrant(target), effect);
  assert.equal(findPerfectFitGrant(target, { sourceActorUuid: "Actor.other" }), null);
  assert.equal(findPerfectFitGrant(target, { sourceActorUuid: "Actor.source" }), effect);
});

test("perfect fit is wired through passive requirements, the management window and GM authority", async () => {
  const [fixed, app, equipment, weapon, sheet, effects, evaluation, actorModel, effectTokens, main, itemTemplate, catalogTemplate] = await Promise.all([
    readFile(new URL("../src/abilities/fixed-functions.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/apps/perfect-fit.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/items/equipment-requirements.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/combat/weapon-attack-controller.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/sheets/actor-sheet.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/abilities/effects.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/abilities/evaluation.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/data/models/actor-data-models.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/utils/effect-key-tokens.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/main.mjs", import.meta.url), "utf8"),
    readFile(new URL("../templates/item/item-sheet.hbs", import.meta.url), "utf8"),
    readFile(new URL("../templates/settings/ability-catalog-item-editor.hbs", import.meta.url), "utf8")
  ]);

  assert.match(fixed, /key:\s*ABILITY_FIXED_FUNCTION_KEYS\.perfectFit[\s\S]*?active:\s*true[\s\S]*?passive:\s*true/);
  assert.match(fixed, /isActorInActiveCombat\(sourceActor\)/);
  assert.match(fixed, /action:\s*"manageMaintainedTarget"/);
  assert.match(fixed, /buildPerfectFitHoldEffectData/);
  assert.match(fixed, /maintainedTargetOperationLock\.runMany\(\[sourceActor, targetActor\]/);
  assert.match(fixed, /definition\.effects\.findGrant\(targetActor\)/);
  assert.match(fixed, /Hooks\.on\("deleteActor"[\s\S]*?cleanupMaintainedTargetDeletedActorLinks/);
  assert.match(fixed, /Hooks\.on\("deleteToken"[\s\S]*?cleanupMaintainedTargetDeletedActorLinks/);
  assert.match(app, /requestCustomActorTokenSelection/);
  assert.match(app, /findPerfectFitGrant\(actor\)/);
  assert.match(app, /data-action="release"|#onRelease/);
  assert.match(equipment, /getAdjustedEquipmentRequirement/);
  assert.match(weapon, /getAdjustedWeaponRequirement/);
  assert.match(sheet, /getAdjustedEquipmentRequirement/);
  assert.match(sheet, /getAdjustedWeaponRequirement/);
  assert.match(effects, /PERFECT_FIT_GRANT_FLAG_KEY/);
  assert.match(evaluation, /ABILITY_FUNCTION_TYPES\.effectChanges, ABILITY_FUNCTION_TYPES\.fixed/);
  assert.match(actorModel, /equipmentPercent:[\s\S]*?weaponPercent:/);
  assert.match(effectTokens, /EQUIPMENT_REQUIREMENT_PERCENT_EFFECT_KEY/);
  assert.match(effectTokens, /WEAPON_REQUIREMENT_PERCENT_EFFECT_KEY/);
  assert.doesNotMatch(main, /syncLoadedPerfectFitHolds/);
  assert.match(itemTemplate, /fixedPerfectFitSettings\.holdEnergy/);
  assert.match(catalogTemplate, /fixed\.perfectFit\.equipmentRequirementPercent/);
  assert.match(catalogTemplate, /fixed\.perfectFit\.weaponRequirementPercent/);
});

function createEffectFixture() {
  return {
    sourceActor: { uuid: "Actor.source", name: "Source" },
    abilityItem: { id: "ability", uuid: "Actor.source.Item.ability", name: "Идеальная подгонка", img: "ability.webp" },
    abilityFunction: { id: "function" },
    targetActor: { uuid: "Actor.target", name: "Target", img: "target.webp" },
    equipmentRequirementPercent: -50,
    weaponRequirementPercent: -50
  };
}
