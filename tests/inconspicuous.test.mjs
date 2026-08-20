import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ABILITY_FIXED_FUNCTION_KEYS,
  normalizeInconspicuousSettings
} from "../src/settings/abilities.mjs";
import {
  buildInconspicuousRoundStateUpdate,
  getInconspicuousRoundState,
  getInconspicuousStateKey,
  isInconspicuousRoundStateCurrent
} from "../src/abilities/inconspicuous-state.mjs";

test("inconspicuous defaults match the passive ability design", () => {
  assert.equal(ABILITY_FIXED_FUNCTION_KEYS.inconspicuous, "inconspicuous");
  assert.deepEqual(normalizeInconspicuousSettings(), {
    attackStealthBonus: 20,
    stealthBonus: 20,
    stealthBonusDurationSeconds: 6
  });
  assert.deepEqual(normalizeInconspicuousSettings({
    attackStealthBonus: -3,
    stealthBonus: 12.9,
    stealthBonusDurationSeconds: -1
  }), {
    attackStealthBonus: 0,
    stealthBonus: 12,
    stealthBonusDurationSeconds: 0
  });
  assert.equal(normalizeInconspicuousSettings({ detectionDifficultyBonus: 17 }).attackStealthBonus, 17);
});

test("inconspicuous round state lives on the ability item and is addressed by combat round", () => {
  const abilityFunction = { id: "fn-1", fixedKey: ABILITY_FIXED_FUNCTION_KEYS.inconspicuous };
  const combat = { uuid: "Combat.c1", round: 4 };
  const stateKey = getInconspicuousStateKey(abilityFunction);
  const abilityItem = {
    flags: {
      "fallout-maw": {
        abilityFixedFunctionState: {
          [stateKey]: {
            combatUuid: combat.uuid,
            round: combat.round,
            attacked: true
          }
        }
      }
    }
  };
  const state = getInconspicuousRoundState(abilityItem, abilityFunction);
  assert.equal(state.attacked, true);
  assert.equal(isInconspicuousRoundStateCurrent(state, combat), true);
  assert.equal(isInconspicuousRoundStateCurrent(state, { ...combat, round: 5 }), false);
  assert.deepEqual(buildInconspicuousRoundStateUpdate(abilityFunction, {
    combat,
    attacked: false
  }), {
    [`flags.fallout-maw.abilityFixedFunctionState.${stateKey}.fixedKey`]: "inconspicuous",
    [`flags.fallout-maw.abilityFixedFunctionState.${stateKey}.combatUuid`]: combat.uuid,
    [`flags.fallout-maw.abilityFixedFunctionState.${stateKey}.round`]: 4,
    [`flags.fallout-maw.abilityFixedFunctionState.${stateKey}.attacked`]: false
  });
});

test("inconspicuous runtime is wired to grouped detection and resolved attack targets", async () => {
  const [fixedSource, noiseSource, stealthSource, actionSource, actorSheetSource, itemSheetSource, itemTemplateSource] = await Promise.all([
    readFile(new URL("../src/abilities/fixed-functions.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/stealth/weapon-noise.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/stealth/controller.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/abilities/ability-actions.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/sheets/actor-sheet.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/sheets/item-sheet.mjs", import.meta.url), "utf8"),
    readFile(new URL("../templates/item/item-sheet.hbs", import.meta.url), "utf8")
  ]);
  assert.match(fixedSource, /registerCombatRoundStartHandler\([\s\S]*processInconspicuousRoundStart/);
  assert.match(fixedSource, /registerWeaponAttackResolvedHandler\([\s\S]*fallout-maw\.fixed\.inconspicuous/);
  assert.match(fixedSource, /markInconspicuousTargetsAttacked/);
  assert.match(fixedSource, /buildInconspicuousRoundStateUpdate\(entry\.abilityFunction, \{[\s\S]*attacked: true/);
  assert.match(fixedSource, /key: "system\.skills\.stealth\.bonus"/);
  assert.match(noiseSource, /getInconspicuousAttackStealthBonus\(hiddenToken\.actor\)/);
  assert.match(noiseSource, /checks\.push\(\{ sourceToken: hiddenToken, targetToken: observerToken, skillBonus \}\)/);
  assert.match(stealthSource, /situationalModifier: check\.skillBonus/);
  assert.match(actionSource, /situationalModifier: Math\.trunc\(Number\(inherited\?\.situationalModifier\) \|\| 0\)/);
  assert.match(actorSheetSource, /getInconspicuousTooltipStateRows\(item, actor\)/);
  assert.match(actorSheetSource, /"Атакован в текущем раунде", attacked \? "Да" : "Нет"/);
  assert.match(itemSheetSource, /#onInconspicuousRoundStatusChange/);
  assert.match(itemTemplateSource, /data-fixed-inconspicuous-attacked/);
});
