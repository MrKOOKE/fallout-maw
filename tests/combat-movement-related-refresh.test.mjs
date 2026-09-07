import assert from "node:assert/strict";
import test from "node:test";

const calls = {
  native: 0,
  prepareBars: 0,
  animateBars: 0,
  tokenHud: 0,
  combatResource: 0,
  combatRender: 0
};

class NativeTokenDocument {
  _onRelatedUpdate() {
    calls.native += 1;
    return "native";
  }
}

function flattenObject(value, prefix = "", result = {}) {
  for (const [key, entry] of Object.entries(value ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (entry && typeof entry === "object" && !Array.isArray(entry)) flattenObject(entry, path, result);
    else result[path] = entry;
  }
  return result;
}

globalThis.TokenDocument = NativeTokenDocument;
globalThis.foundry = {
  abstract: {},
  documents: {},
  utils: { flattenObject },
  canvas: { animation: { CanvasAnimation: { easeInOutCosine: value => value } } },
  applications: { sheets: { TokenConfig: { instances: () => [] } } }
};
globalThis.canvas = { tokens: { hud: { render: () => { calls.tokenHud += 1; } } } };
globalThis.ui = { combat: { render: () => { calls.combatRender += 1; } } };
globalThis.game = {
  combat: { settings: { resource: "resources.health.value" } },
  release: { version: "14.361" }
};

const { COMBAT_MOVEMENT_RESOURCE_UPDATE_OPTION } = await import("../src/constants.mjs");
const { FalloutMaWTokenDocument } = await import("../src/documents/token.mjs");

function resetCalls() {
  for (const key of Object.keys(calls)) calls[key] = 0;
}

function createToken() {
  const token = new FalloutMaWTokenDocument();
  token.parent = { isView: true };
  token.bar1 = { attribute: "resources.health", value: 10, max: 10 };
  token.bar2 = { attribute: null };
  token.object = {
    objectId: "Token.test",
    hasActiveHUD: false,
    animate(attributes) {
      calls.animateBars += 1;
      this.lastAttributes = attributes;
    }
  };
  token.combatant = { updateResource: () => { calls.combatResource += 1; } };
  token._prepareBars = () => {
    calls.prepareBars += 1;
    token.bar1 = { ...token.bar1, value: 9 };
  };
  return token;
}

test("movement resource updates skip unrelated native token redraw work", () => {
  resetCalls();
  const token = createToken();
  token._onRelatedUpdate({
    "system.resources.movementPoints.value": 7,
    "flags.fallout-maw.movementResourceSpending": []
  }, {
    [COMBAT_MOVEMENT_RESOURCE_UPDATE_OPTION]: true,
    parent: token
  });

  assert.deepEqual(calls, {
    native: 0,
    prepareBars: 0,
    animateBars: 0,
    tokenHud: 0,
    combatResource: 0,
    combatRender: 0
  });
});

test("a token bar bound to movement points still receives its native bar animation", () => {
  resetCalls();
  const token = createToken();
  token.bar1.attribute = "resources.movementPoints";
  token.object.hasActiveHUD = true;
  token._onRelatedUpdate({ system: { resources: { movementPoints: { value: 7 } } } }, {
    [COMBAT_MOVEMENT_RESOURCE_UPDATE_OPTION]: true,
    parent: token
  });

  assert.equal(calls.prepareBars, 1);
  assert.equal(calls.animateBars, 1);
  assert.equal(calls.tokenHud, 1);
  assert.deepEqual(Object.keys(token.object.lastAttributes), ["bar1"]);
  assert.equal(calls.combatRender, 0);
});

test("a Combat Tracker bound to movement points remains synchronized", () => {
  resetCalls();
  const token = createToken();
  game.combat.settings.resource = "resources.movementPoints.value";
  try {
    token._onRelatedUpdate({ "system.resources.movementPoints.value": 7 }, {
      [COMBAT_MOVEMENT_RESOURCE_UPDATE_OPTION]: true,
      parent: token
    });
  } finally {
    game.combat.settings.resource = "resources.health.value";
  }

  assert.equal(calls.combatResource, 1);
  assert.equal(calls.combatRender, 1);
  assert.equal(calls.animateBars, 0);
});

test("all non-movement Actor updates keep the complete Foundry lifecycle", () => {
  resetCalls();
  const token = createToken();
  assert.equal(token._onRelatedUpdate({ name: "Changed" }, {}), "native");
  assert.equal(calls.native, 1);
});
