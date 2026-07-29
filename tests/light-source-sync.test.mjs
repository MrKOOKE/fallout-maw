import assert from "node:assert/strict";
import test from "node:test";

globalThis.foundry = {
  applications: {
    api: {
      DialogV2: class {}
    },
    ux: {
      FormDataExtended: class {}
    },
    handlebars: {
      renderTemplate: async () => ""
    }
  }
};

const { syncTokenLightSources } = await import("../src/items/light-source.mjs");

test("canvas light reconciliation ignores Tokens never managed by the light runtime", async () => {
  let updates = 0;
  const token = {
    actor: {},
    light: {
      dim: 30,
      bright: 10,
      angle: 180,
      color: "#ffcc88"
    },
    getFlag() {
      return undefined;
    },
    async update() {
      updates += 1;
    }
  };

  await syncTokenLightSources(token);

  assert.equal(updates, 0);
  assert.deepEqual(token.light, {
    dim: 30,
    bright: 10,
    angle: 180,
    color: "#ffcc88"
  });
});
