import assert from "node:assert/strict";
import test from "node:test";

test("Reaction Hub timeout follows combat settings and keeps 20 seconds only as the default", async () => {
  globalThis.foundry = {
    applications: {
      api: { DialogV2: {} },
      ux: { FormDataExtended: class {} },
      handlebars: { renderTemplate: () => "" }
    },
    utils: {
      deepClone: value => structuredClone(value),
      mergeObject: (base, update) => ({
        ...structuredClone(base),
        ...structuredClone(update),
        reactions: {
          ...structuredClone(base?.reactions ?? {}),
          ...structuredClone(update?.reactions ?? {})
        }
      }),
      randomID: () => "test-id"
    }
  };
  let storedCombatSettings = { reactions: { timeoutSeconds: 37 } };
  globalThis.game = {
    settings: {
      get: () => storedCombatSettings
    }
  };

  const {
    REACTION_HUB_TESTING,
    registerReactionEventSemanticAdapter,
    requestReactionEvent
  } = await import("../src/combat/reaction-hub.mjs");
  assert.equal(REACTION_HUB_TESTING.getReactionTimeoutMs(), 37_000);

  storedCombatSettings = { reactions: { timeoutSeconds: 91 } };
  assert.equal(REACTION_HUB_TESTING.getReactionTimeoutMs(), 91_000);

  game.settings.get = () => {
    throw new Error("setting unavailable");
  };
  assert.equal(REACTION_HUB_TESTING.getReactionTimeoutMs(), 20_000);
  assert.equal(REACTION_HUB_TESTING.normalizeReactionTimeoutMs(250), 1_000);
  assert.equal(REACTION_HUB_TESTING.normalizeReactionTimeoutMs(999_999), 600_000);

  game.user = { id: "gm" };
  game.users = { activeGM: { id: "gm" } };
  assert.equal(
    (await requestReactionEvent("weaponAttackTargeted", {})).reason,
    "semanticAdapterUnavailable"
  );
  const unregister = registerReactionEventSemanticAdapter(async () => undefined);
  assert.equal(
    (await requestReactionEvent("weaponAttackTargeted", {})).reason,
    "semanticEventUnavailable"
  );
  unregister();
  const originalConsoleError = console.error;
  console.error = () => undefined;
  const unregisterBroken = registerReactionEventSemanticAdapter(async () => {
    throw new Error("adapter failure");
  });
  try {
    assert.equal(
      (await requestReactionEvent("weaponAttackTargeted", {})).reason,
      "semanticAdapterError"
    );
  } finally {
    unregisterBroken();
    console.error = originalConsoleError;
  }
});
