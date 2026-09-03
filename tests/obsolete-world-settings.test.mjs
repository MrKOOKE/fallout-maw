import assert from "node:assert/strict";
import test from "node:test";

import {
  removeObsoleteReactiveEvolutionExample,
  removeObsoleteWorldSettings,
  SETTINGS_MIGRATION_TESTING
} from "../src/migrations/obsolete-world-settings.mjs";

test.afterEach(() => {
  delete globalThis.game;
});

test("active GM removes only the obsolete animation index Setting", async () => {
  const deleted = [];
  const obsolete = {
    delete: async options => deleted.push(options)
  };
  globalThis.game = {
    user: { isActiveGM: true },
    settings: {
      storage: new Map([["world", {
        getSetting: (key, user) => {
          assert.equal(key, SETTINGS_MIGRATION_TESTING.OBSOLETE_ANIMATION_LIBRARY_SETTING);
          assert.equal(user, null);
          return obsolete;
        }
      }]])
    }
  };

  assert.deepEqual(await removeObsoleteWorldSettings(), { removed: 1 });
  assert.deepEqual(deleted, [{ render: false }]);
});

test("cleanup is a no-op for other clients and after the Setting is gone", async () => {
  let lookups = 0;
  globalThis.game = {
    user: { isActiveGM: false },
    settings: {
      storage: new Map([["world", {
        getSetting: () => { lookups += 1; return null; }
      }]])
    }
  };
  assert.deepEqual(await removeObsoleteWorldSettings(), { removed: 0 });
  assert.equal(lookups, 0);

  game.user.isActiveGM = true;
  assert.deepEqual(await removeObsoleteWorldSettings(), { removed: 0 });
  assert.equal(lookups, 1);
});

test("the one-time catalog migration removes only the bundled Reactive example", () => {
  const catalog = {
    categories: [{
      abilities: [{
        id: "440oqDWdqC2Rha9Y",
        system: {
          functions: [{
            enabled: false,
            fixedKey: "reactive",
            fixedSettings: { actionPointsPerThreshold: 1 }
          }],
          evolution: {
            nodes: [
              { id: "ZE3wVZrKgRxUVkcw", ability: { id: "ZE3wVZrKgRxUVkcw" } },
              { id: "user-copy", ability: { id: "user-copy" } }
            ],
            links: [
              { fromId: "440oqDWdqC2Rha9Y", toId: "ZE3wVZrKgRxUVkcw" },
              { fromId: "440oqDWdqC2Rha9Y", toId: "user-copy" }
            ],
            viewport: { x: 10, y: 20, zoom: 1 }
          }
        }
      }]
    }]
  };

  const migrated = removeObsoleteReactiveEvolutionExample(catalog);
  const reactive = migrated.categories[0].abilities[0];
  assert.deepEqual(reactive.system.evolution.nodes.map(node => node.id), ["user-copy"]);
  assert.deepEqual(reactive.system.evolution.links.map(link => link.toId), ["user-copy"]);
  assert.equal(reactive.system.functions[0].enabled, true);
  assert.equal(catalog.categories[0].abilities[0].system.evolution.nodes.length, 2);
  assert.equal(removeObsoleteReactiveEvolutionExample(migrated), null);
});
