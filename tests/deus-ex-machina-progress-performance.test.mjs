import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEUS_EX_MACHINA_PROGRESS_OPTION,
  isDeusExMachinaProgressItemUpdate
} from "../src/abilities/deus-ex-machina-progress-runtime.mjs";
import {
  classifyItemUpdate,
  registerFoundryDocumentSystemEventHooks
} from "../src/events/foundry-document-events.mjs";
import { itemUpdateInvalidatesEventReactionIndex } from "../src/events/event-reaction-index.mjs";

const runtimeOptions = {
  [DEUS_EX_MACHINA_PROGRESS_OPTION]: true
};
const progressChanges = {
  _id: "ability-1",
  "flags.fallout-maw.abilityFixedFunctionState.function-1:deusExMachina": {
    fixedKey: "deusExMachina",
    damage: 10,
    readyNotified: false
  }
};

test("Deus Ex progress marker is accepted only for its exact runtime flag subtree", () => {
  assert.equal(isDeusExMachinaProgressItemUpdate(progressChanges, runtimeOptions), true);
  assert.equal(isDeusExMachinaProgressItemUpdate({
    flags: {
      "fallout-maw": {
        abilityFixedFunctionState: {
          "function-1:deusExMachina": { damage: 10 }
        }
      }
    }
  }, runtimeOptions), true);
  assert.equal(isDeusExMachinaProgressItemUpdate(progressChanges, {}), false);
  assert.equal(isDeusExMachinaProgressItemUpdate({}, runtimeOptions), false);
  assert.equal(isDeusExMachinaProgressItemUpdate({
    ...progressChanges,
    "system.functions": []
  }, runtimeOptions), false);
});

test("runtime-only progress cannot emit document events or invalidate reaction subscriptions", () => {
  const actor = { uuid: "Actor.1" };
  const item = {
    id: "ability-1",
    uuid: "Actor.1.Item.ability-1",
    type: "ability",
    actor,
    parent: actor,
    toObject: () => {
      throw new Error("runtime progress classification must not serialize the Item");
    }
  };

  assert.deepEqual(classifyItemUpdate(item, progressChanges, {
    options: runtimeOptions
  }), []);
  assert.equal(itemUpdateInvalidatesEventReactionIndex(progressChanges, runtimeOptions), false);
  assert.equal(itemUpdateInvalidatesEventReactionIndex({
    ...progressChanges,
    "system.functions": []
  }, runtimeOptions), true);
});

test("Foundry adapter skips the preUpdate snapshot and post-commit root for runtime progress", async () => {
  const callbacks = new Map();
  let randomIdCalls = 0;
  let roots = 0;
  registerFoundryDocumentSystemEventHooks({
    hooks: {
      on(name, callback) {
        callbacks.set(name, callback);
        return callbacks.size;
      }
    },
    isActiveGM: () => true,
    randomId: () => {
      randomIdCalls += 1;
      return "unexpected";
    },
    withRoot: async (_meta, operation) => {
      roots += 1;
      return operation({ emit: async () => undefined });
    }
  });
  const actor = { uuid: "Actor.1" };
  const item = {
    id: "ability-1",
    uuid: "Actor.1.Item.ability-1",
    type: "ability",
    actor,
    parent: actor,
    toObject: () => {
      throw new Error("runtime progress must not allocate a before snapshot");
    }
  };
  const options = { ...runtimeOptions };

  assert.doesNotThrow(() => callbacks.get("preUpdateItem")(item, progressChanges, options));
  assert.doesNotThrow(() => callbacks.get("updateItem")(item, progressChanges, options, "gm"));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(randomIdCalls, 0);
  assert.equal(roots, 0);
  assert.deepEqual(options, runtimeOptions);
});

test("damage workflow awaits one batched DEx persistence step before legacy observers", async () => {
  const [damageHub, fixedFunctions, effects] = await Promise.all([
    readFile(new URL("../src/combat/damage-hub.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/abilities/fixed-functions.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/abilities/effects.mjs", import.meta.url), "utf8")
  ]);
  const notifyStart = damageHub.indexOf("async function notifyDamageApplied");
  const notifyEnd = damageHub.indexOf("function buildDamageSummaryViewContext", notifyStart);
  const notifySource = damageHub.slice(notifyStart, notifyEnd);
  const dexStart = fixedFunctions.indexOf("async function advanceDeusExMachinaProgressFromDamage");
  const dexEnd = fixedFunctions.indexOf("async function useDeusExMachina", dexStart);
  const dexSource = fixedFunctions.slice(dexStart, dexEnd);
  const itemHookStart = effects.indexOf('Hooks.on("updateItem"');
  const itemHookEnd = effects.indexOf('Hooks.on("deleteItem"', itemHookStart);
  const itemHookSource = effects.slice(itemHookStart, itemHookEnd);

  assert.match(damageHub, /export function registerDamageAppliedHandler/);
  assert.match(notifySource, /await handler\(context\)/);
  assert.ok(
    notifySource.indexOf("await handler(context)")
      < notifySource.indexOf("Hooks.callAll(DAMAGE_APPLIED_HOOK, context)")
  );
  assert.equal((damageHub.match(/await notifyDamageApplied\(/g) ?? []).length, 7);

  assert.match(fixedFunctions, /registerDamageAppliedHandler\(/);
  assert.doesNotMatch(fixedFunctions, /Hooks\.on\(DAMAGE_APPLIED_HOOK/);
  assert.match(dexSource, /actor\.updateEmbeddedDocuments\("Item", updates/);
  assert.match(dexSource, /\[DEUS_EX_MACHINA_PROGRESS_OPTION\]: true/);
  assert.match(dexSource, /DEUS_EX_MACHINA_PROGRESS_FLAG_ROOT\}\.\$\{stateKey\}/);
  assert.doesNotMatch(dexSource, /\.setFlag\(/);

  assert.ok(
    itemHookSource.indexOf("isDeusExMachinaProgressItemUpdate")
      < itemHookSource.indexOf("shouldRefreshEnvironmentConditionIndex")
  );
  assert.match(fixedFunctions, /!hasActiveApplicationEffects\(actor\)/);
  assert.match(fixedFunctions, /!hasActiveApplicationEffects\(currentActor\)/);
});

test("runtime-only DEx progress bypasses UI branches which do not display it", async () => {
  const [equipmentHud, actorContainers, actionHud] = await Promise.all([
    readFile(new URL("../src/canvas/token-equipment-hud.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/canvas/actor-containers.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/apps/token-action-hud.mjs", import.meta.url), "utf8")
  ]);

  assert.match(equipmentHud, /Hooks\.on\("updateItem"[\s\S]{0,180}?isDeusExMachinaProgressItemUpdate/);
  assert.match(equipmentHud, /if \(tokenEquipmentHudRefreshTimer !== null\) return/);

  assert.match(actorContainers, /Hooks\.on\("updateItem"[\s\S]{0,180}?isDeusExMachinaProgressItemUpdate/);
  const highlightStart = actorContainers.indexOf("function refreshActorContainerHighlights()");
  const highlightEnd = actorContainers.indexOf("function refreshActorContainerExitPreview()", highlightStart);
  const highlightSource = actorContainers.slice(highlightStart, highlightEnd);
  assert.ok(
    highlightSource.indexOf("if (!activeBoardingMode && !actorContainerHighlightsDrawn) return")
      < highlightSource.indexOf("getHighlightLayer")
  );

  const reloadStart = actionHud.indexOf("function bindReloadDialogLiveUpdates");
  const reloadEnd = actionHud.indexOf("async function requestWeaponReloadOperation", reloadStart);
  const reloadSource = actionHud.slice(reloadStart, reloadEnd);
  assert.match(reloadSource, /Hooks\.on\("updateItem"[\s\S]{0,180}?isDeusExMachinaProgressItemUpdate/);
});
