import assert from "node:assert/strict";
import test from "node:test";

import {
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
