import test from "node:test";
import assert from "node:assert/strict";

import { SYSTEM_ID } from "../src/constants.mjs";
import {
  ABILITY_CONDITION_TYPES,
  createAbilityCondition
} from "../src/settings/abilities.mjs";
import {
  LIMITED_EFFECT_COPY_FLAG_KEY,
  getLimitedEffectCopyCapacity,
  releaseLimitedEffectCopyReservation,
  reserveLimitedEffectCopySlot,
  resolveLimitedEffectCopyLimit
} from "../src/abilities/limited-effect-copies.mjs";
import {
  createEventReactionEffectManager,
  getEventReactionEffectFlag,
  hasEventReactionEffectInstance
} from "../src/events/reaction-effects.mjs";

test("limited effect copies normalize as non-OR metadata", () => {
  const previousFoundry = globalThis.foundry;
  globalThis.foundry = { utils: { randomID: () => "copy-limit" } };
  try {
    const condition = createAbilityCondition(ABILITY_CONDITION_TYPES.limitedEffectCopies);
    assert.deepEqual(condition, {
      id: "copy-limit",
      groupId: "",
      type: ABILITY_CONDITION_TYPES.limitedEffectCopies,
      limit: 1,
      limitFormula: "1",
      refresh: false
    });
  } finally {
    globalThis.foundry = previousFoundry;
  }
});

test("limited effect copies use the smallest configured source formula", () => {
  const actor = { uuid: "Actor.Source" };
  const seen = [];
  const limit = resolveLimitedEffectCopyLimit([
    { type: ABILITY_CONDITION_TYPES.limitedEffectCopies, limitFormula: "first" },
    { type: ABILITY_CONDITION_TYPES.limitedEffectCopies, limitFormula: "second" }
  ], actor, {
    evaluateLimit: (formula, evaluatedActor) => {
      seen.push([formula, evaluatedActor]);
      return formula === "first" ? 3 : 2;
    }
  });
  assert.equal(limit, 2);
  assert.deepEqual(seen, [["first", actor], ["second", actor]]);
});

test("limited effect copies count the same library function and free capacity after removal", () => {
  const sourceItem = {
    uuid: "Actor.Source.Item.Ability",
    flags: { [SYSTEM_ID]: { abilitySource: { id: "library-ability" } } }
  };
  const abilityFunction = {
    id: "function-a",
    conditions: [{
      type: ABILITY_CONDITION_TYPES.limitedEffectCopies,
      limitFormula: "2"
    }]
  };
  const recipientActor = {
    effects: [
      managedEffect("library-ability", "function-a"),
      managedEffect("other-ability", "function-a"),
      managedEffect("library-ability", "function-b")
    ]
  };
  const context = { recipientActor, sourceActor: {}, sourceItem, abilityFunction };
  assert.equal(getLimitedEffectCopyCapacity(context).allowed, true);

  const disabledCopy = managedEffect("library-ability", "function-a");
  disabledCopy.disabled = true;
  recipientActor.effects.push(disabledCopy);
  assert.deepEqual(
    getLimitedEffectCopyCapacity(context),
    {
      limited: true,
      allowed: false,
      count: 2,
      limit: 2,
      identity: { sourceKey: "ability:library-ability", functionId: "function-a" }
    }
  );

  recipientActor.effects.shift();
  assert.equal(getLimitedEffectCopyCapacity(context).allowed, true);
});

test("limited effect copy reservations atomically occupy and release the final slot", () => {
  const sourceItem = { uuid: "Actor.Source.Item.Ability" };
  const abilityFunction = {
    id: "function-a",
    conditions: [{
      type: ABILITY_CONDITION_TYPES.limitedEffectCopies,
      limitFormula: "1"
    }]
  };
  const context = {
    recipientActor: { uuid: "Actor.Target", effects: [] },
    sourceActor: {},
    sourceItem,
    abilityFunction
  };
  const first = reserveLimitedEffectCopySlot(context);
  try {
    assert.equal(first.allowed, true);
    assert.equal(reserveLimitedEffectCopySlot(context).allowed, false);
  } finally {
    releaseLimitedEffectCopyReservation(first);
  }
  assert.equal(getLimitedEffectCopyCapacity(context).allowed, true);
});

test("an existing copy preserves the stricter resolved limit of its source", () => {
  const sourceItem = { uuid: "Actor.Source.Item.Ability" };
  const abilityFunction = {
    id: "function-a",
    conditions: [{
      type: ABILITY_CONDITION_TYPES.limitedEffectCopies,
      limitFormula: "3"
    }]
  };
  const capacity = getLimitedEffectCopyCapacity({
    recipientActor: {
      uuid: "Actor.Target",
      effects: [limitedManagedEffect("item:Actor.Source.Item.Ability", "function-a", 1)]
    },
    sourceActor: {},
    sourceItem,
    abilityFunction
  });
  assert.equal(capacity.limit, 1);
  assert.equal(capacity.allowed, false);
});

test("module provenance uses its synthetic source UUID without resolving the host origin", () => {
  const previousFromUuidSync = globalThis.fromUuidSync;
  globalThis.fromUuidSync = () => {
    throw new Error("legacy source resolution must not run");
  };
  try {
    const moduleUuid = "Actor.Source.Item.Host.Module.slot-1";
    const sourceItem = { uuid: moduleUuid };
    const abilityFunction = {
      id: "function-a",
      conditions: [{
        type: ABILITY_CONDITION_TYPES.limitedEffectCopies,
        limitFormula: "1"
      }]
    };
    const recipientActor = {
      uuid: "Actor.Target",
      effects: [{
        origin: "Actor.Source.Item.Host",
        flags: {
          [SYSTEM_ID]: {
            abilityItemUseEffect: {
              sourceItemUuid: moduleUuid,
              functionId: "function-a"
            }
          }
        }
      }]
    };
    assert.equal(getLimitedEffectCopyCapacity({
      recipientActor,
      sourceActor: {},
      sourceItem,
      abilityFunction
    }).allowed, false);
  } finally {
    globalThis.fromUuidSync = previousFromUuidSync;
  }
});

test("event reaction effect creation respects the copy limit across roots", async () => {
  let nextId = 1;
  const actor = { uuid: "Actor.C", effects: [] };
  const manager = createEventReactionEffectManager({
    resolveActor: async () => actor,
    listActors: () => [actor],
    createEffects: async (subject, entries) => {
      const created = entries.map(data => effectDocument(`effect-${nextId++}`, data));
      subject.effects.push(...created);
      return created;
    },
    deleteEffects: async (subject, ids) => {
      subject.effects = subject.effects.filter(effect => !ids.includes(effect.id));
    }
  });
  const sourceItem = { uuid: "Actor.C.Item.ability", name: "Reaction", img: "reaction.webp" };
  const abilityFunction = {
    id: "reaction-function",
    type: "effectChanges",
    changes: [{ id: "change", key: "system.test", value: "1", type: "add", phase: "initial" }],
    penalties: [],
    conditions: [{
      id: "copy-limit",
      groupId: "",
      type: ABILITY_CONDITION_TYPES.limitedEffectCopies,
      limitFormula: "2"
    }]
  };
  const apply = rootId => manager.apply({
    actor,
    sourceItem,
    abilityFunction,
    envelope: { rootId, eventId: rootId, key: "fallout-maw.test" }
  });

  await apply("root-a");
  await apply("root-b");
  assert.equal(hasEventReactionEffectInstance({
    actor,
    sourceItem,
    abilityFunction,
    envelope: { rootId: "root-b", eventId: "root-b" }
  }), true);
  assert.ok(await apply("root-b"));
  assert.equal(await apply("root-c"), null);
  assert.equal(actor.effects.length, 2);

  await manager.cleanupRoot("root-a");
  await apply("root-c");
  assert.equal(actor.effects.length, 2);
  assert.deepEqual(actor.effects.map(effect => getEventReactionEffectFlag(effect).rootId).sort(), ["root-b", "root-c"]);
});

function managedEffect(abilitySourceId, functionId) {
  return {
    active: true,
    flags: {
      [SYSTEM_ID]: {
        activeApplication: {
          abilitySourceId,
          functionId,
          functionData: { id: functionId }
        }
      }
    }
  };
}

function limitedManagedEffect(sourceKey, functionId, limit) {
  return {
    flags: {
      [SYSTEM_ID]: {
        [LIMITED_EFFECT_COPY_FLAG_KEY]: { sourceKey, functionId, limit }
      }
    }
  };
}

function effectDocument(id, data) {
  return {
    id,
    ...structuredClone(data),
    getFlag(scope, key) {
      return this.flags?.[scope]?.[key];
    },
    async update(update) {
      Object.assign(this, structuredClone(update));
      return this;
    }
  };
}
