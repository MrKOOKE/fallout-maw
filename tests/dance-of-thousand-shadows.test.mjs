import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ABILITY_FIXED_FUNCTION_KEYS,
  normalizeDanceOfThousandShadowsSettings
} from "../src/settings/abilities.mjs";

test("dance of thousand shadows defaults match the fixed ability design", () => {
  assert.equal(ABILITY_FIXED_FUNCTION_KEYS.danceOfThousandShadows, "danceOfThousandShadows");
  assert.deepEqual(normalizeDanceOfThousandShadowsSettings(), {
    activationEnergyCost: 100,
    overloadEnergyCost: 200,
    overloadDurationSeconds: 43_200,
    durationSeconds: 18,
    radiusMeters: 20,
    swapPointCost: 1,
    stealthBonusPerKill: 10,
    damagePercentPerKill: 5,
    criticalChancePerKill: 2
  });
});

test("dance phantoms use one empty unlinked actor and bounded wall-aware native placement", async () => {
  const source = await readFile(new URL("../src/abilities/dance-of-thousand-shadows.mjs", import.meta.url), "utf8");
  assert.match(source, /Actor\.create\(buildDancePhantomActorData/);
  assert.match(source, /buildPhantomActorData\(sourceActor, data\)/);
  assert.match(source, /buildPhantomTokenData\(sourceToken, phantomActor, data\)/);
  assert.match(source, /if \(!token\?\.actor \|\| isPhantomEntity\(token\)\) return false/);
  assert.doesNotMatch(source, /PHANTOM_VISION_FLAG_KEY/);
  assert.match(source, /const MAX_PLACEMENT_RINGS = 6/);
  assert.match(source, /grid\.getAdjacentOffsets\(offset\)/);
  assert.match(source, /checkCollision\(destination, \{ origin, type: "move", mode: "any" \}\)/);
  assert.match(source, /hasAuraLineOfSight\(sourceObject, object\)/);
  assert.match(source, /checkCollision\(destination, \{ origin: sourceOrigin, type: "sight", mode: "any" \}\)/);
  assert.match(source, /occupancy\.some\(other => rectanglesOverlap\(rect, other\)\)/);
  assert.doesNotMatch(source, /for \([^\n]*scene\.width/);
});

test("dance lifecycle refreshes by round, respawns destroyed tokens and scales all three bonuses", async () => {
  const [dance, fixed, interruptions, movementEvents, stealth] = await Promise.all([
    readFile(new URL("../src/abilities/dance-of-thousand-shadows.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/abilities/fixed-functions.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/canvas/movement-interruptions.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/events/foundry-movement-events.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/stealth/movement.mjs", import.meta.url), "utf8")
  ]);
  assert.match(dance, /registerCombatRoundStartHandler\(processDanceRoundStart\)/);
  assert.match(dance, /reconcileDancePhantoms\(effect, \{ round \}\)/);
  assert.match(dance, /const staleIds = existing\.map\(token => token\.id\)/);
  assert.match(dance, /for \(const combatant of combat\?\.combatants \?\? \[\]\) addScene\(combatant\?\.sceneId\)/);
  assert.match(dance, /registerDamageAppliedHandler\(DANCE_DAMAGE_HANDLER_ID, processDanceDamageResults\)/);
  assert.match(dance, /registerWeaponAttackTerminalHandler\(DANCE_WEAPON_TERMINAL_HANDLER_ID, processDanceWeaponAttackTerminal\)/);
  assert.match(dance, /deleteDamagedDancePhantoms\(phantomTokenUuids\)/);
  assert.match(dance, /result\.phantomDestroyed !== true/);
  assert.match(dance, /deleteEmbeddedDocuments\("Token", tokenIds/);
  assert.doesNotMatch(dance, /phantomTokens\.values\(\), token => \(\s*token\.delete/);
  assert.doesNotMatch(dance, /defer\(removePhantoms/);
  assert.match(dance, /scene\.createEmbeddedDocuments\("Token", creates/);
  assert.match(dance, /system\.skills\.stealth\.bonus/);
  assert.match(dance, /system\.combat\.damagePercent/);
  assert.match(dance, /system\.combat\.criticalChance/);
  assert.match(fixed, /getCombatMovementResourceState\(actor\)/);
  assert.match(fixed, /swapWithDancePhantom\(\{ sourceActor: actor, sourceToken, phantomToken \}\)/);
  assert.match(dance, /scene\.moveTokens\(\{/);
  assert.match(dance, /action: "displace"/);
  assert.match(dance, /\[SYSTEM_RELOCATION_OPTION\]: true/);
  assert.match(interruptions, /if \(options\?\.\[SYSTEM_RELOCATION_OPTION\]\) \{\s*beginMovementEpoch\(tokenDocument\);\s*return true;/);
  assert.match(interruptions, /function onMoveToken[\s\S]*?if \(options\?\.\[SYSTEM_RELOCATION_OPTION\]\) return/);
  assert.match(movementEvents, /operation\?\.\[SYSTEM_RELOCATION_OPTION\]/);
  assert.match(stealth, /synchronizeStealthMovementStateAfterRelocation/);
  assert.match(stealth, /isInside \? \(baseline\.value \?\? 0\) : null/);
});

test("dance settings are available in both ability editors", async () => {
  const [catalog, item] = await Promise.all([
    readFile(new URL("../templates/settings/ability-catalog-item-editor.hbs", import.meta.url), "utf8"),
    readFile(new URL("../templates/item/item-sheet.hbs", import.meta.url), "utf8")
  ]);
  for (const source of [catalog, item]) {
    assert.match(source, /fixedDanceOfThousandShadowsSettings/);
    assert.match(source, /activationEnergyCost/);
    assert.match(source, /overloadDurationSeconds/);
    assert.match(source, /stealthBonusPerKill/);
    assert.match(source, /criticalChancePerKill/);
  }
});
