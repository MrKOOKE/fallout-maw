import assert from "node:assert/strict";
import test from "node:test";

const events = [];
const snapshots = [];
class ClientDocument {
  _preUpdateDescendantDocuments(...args) {
    events.push({ name: "inherited", scene: this, args });
  }
}
class NativeScene extends ClientDocument {
  _preUpdateDescendantDocuments(...args) {
    events.push({ name: "native", scene: this, args });
    return "native-result";
  }
}
class NativeToken {
  constructor(id, x = 10, y = 20) {
    this._source = { _id: id, x, y, elevation: 0, rotation: 90 };
    Object.defineProperty(this._source, "delta", {
      enumerable: true,
      get() { throw new Error("Movement history must not traverse ActorDelta inventory"); }
    });
  }

  toObject() {
    throw new Error("Movement history must not serialize the whole Token");
  }
}
globalThis.foundry = {
  documents: {
    Scene: NativeScene,
    TokenDocument: NativeToken
  },
  utils: { deepClone: structuredClone }
};
globalThis.TokenDocument = NativeToken;
NativeToken._addTeleportAndForcedShims = options => {
  events.push({ name: "shims", options });
  Object.defineProperty(options, "teleport", { configurable: true, get: () => false });
};
globalThis.game = { release: { generation: 14 }, userId: "user" };
globalThis.canvas = {
  getCollectionLayer(collection) {
    assert.equal(collection, "tokens");
    return { storeHistory: (...args) => snapshots.push(args) };
  }
};

const { FalloutMaWScene } = await import("../src/documents/scene.mjs");
const { FalloutMaWTokenDocument } = await import("../src/documents/token.mjs");
function createScene() {
  events.length = 0;
  snapshots.length = 0;
  const scene = new FalloutMaWScene();
  scene.isView = true;
  scene.tokens = new Map([["one", new NativeToken("one")], ["two", new NativeToken("two", 50, 60)]]);
  scene.getEmbeddedCollection = collection => {
    assert.equal(collection, "tokens");
    return scene.tokens;
  };
  return scene;
}

test("moving a heavy Token records an independent undo snapshot without visiting its inventory", () => {
  const scene = createScene();
  const changes = [{ _id: "one", x: 200, y: 300 }];
  const options = { _movement: { one: {} } };
  scene._preUpdateDescendantDocuments(scene, "tokens", changes, options, "user");
  assert.deepEqual(snapshots, [["update", [{ _id: "one", x: 10, y: 20 }], options]]);
  assert.deepEqual(events.map(event => event.name), ["shims", "inherited"]);
  assert.equal(events[0].options, options);
  assert.equal(events[1].scene, scene);
  assert.equal(events[1].args[2], changes);
  assert.equal(events[1].args[3], options);
  assert.equal(snapshots[0][2], options);
  assert.equal(Object.hasOwn(options, "isUndo"), false);
  assert.equal(options.teleport, false);
  scene.tokens.get("one")._source.x = 200;
  changes[0].y = 400;
  assert.deepEqual(snapshots[0][1], [{ _id: "one", x: 10, y: 20 }]);
});

test("multiple moves, rotations and elevation changes retain only their original changed coordinates", () => {
  const scene = createScene();
  scene._preUpdateDescendantDocuments(scene, "tokens", [
    { x: -100, _id: "one" },
    { _id: "two", y: 90, rotation: 180, elevation: 5 }
  ], {}, "user");
  assert.deepEqual(snapshots[0][1], [
    { _id: "one", x: 10 },
    { _id: "two", y: 60, rotation: 90, elevation: 0 }
  ]);
});

test("the system serializer and inline diagnostic retain coordinate history without visiting inventory", () => {
  const scene = createScene();
  const document = new FalloutMaWTokenDocument("one");
  scene.tokens.set("one", document);
  const serializer = document.toObject;
  let recorded = 0;
  globalThis.__falloutMawGameplayProbe = {
    tokenSerialization() {throw new Error("Coordinate history must not serialize a Token even with diagnostics active");},
    count(name, _hypothesis, n) {if (name === "movement.coordinateHistory") recorded += n;}
  };
  try {
    scene._preUpdateDescendantDocuments(scene, "tokens", [{_id: "one", x: 500}], {}, "user");
    assert.deepEqual(snapshots[0][1], [{_id: "one", x: 10}]);
    assert.equal(recorded, 1);
    assert.equal(document.toObject, serializer);
  } finally {delete globalThis.__falloutMawGameplayProbe;}
});

test("custom compatibility serialization on a system Token retains native history", () => {
  const scene = createScene();
  class CustomizedToken extends FalloutMaWTokenDocument {
    static shimData(data) {return {...data, x: 999};}
  }
  scene.tokens.set("one", new CustomizedToken("one"));
  assert.equal(scene._preUpdateDescendantDocuments(scene, "tokens", [{_id: "one", x: 500}], {}, "user"), "native-result");
  assert.equal(snapshots.length, 0);
});

test("undo, remote, invisible, indirect and non-Token operations keep the exact native call", () => {
  const scene = createScene();
  const changes = [{ _id: "one", x: 200 }];
  const cases = [
    [scene, "tokens", changes, { isUndo: true }, "user"],
    [scene, "tokens", changes, {}, "other-user"],
    [{}, "tokens", changes, {}, "user"],
    [scene, "tiles", changes, {}, "user"]
  ];
  for (const args of cases) {
    assert.equal(scene._preUpdateDescendantDocuments(...args), "native-result");
    assert.deepEqual(events.at(-1).args, args);
  }
  scene.isView = false;
  assert.equal(scene._preUpdateDescendantDocuments(scene, "tokens", changes, {}, "user"), "native-result");
  assert.equal(snapshots.length, 0);
  assert.ok(events.every(event => event.name === "native"));
});

test("complex, mixed or invalid patches always retain native history and flag/level handling", () => {
  const scene = createScene();
  for (const changes of [
    [], [{ _id: "one" }], [{ x: 200 }], [{ _id: "missing", x: 200 }],
    [{ _id: "one", x: 200, flags: {} }],
    [{ _id: "one", x: 200, delta: {} }],
    [{ _id: "one", x: 200, levels: [] }],
    [{ _id: "one", x: 200, level: "another" }],
    [{ _id: "one", x: 200 }, { _id: "two", hidden: true }],
    [{ _id: "one", "texture.scaleX": 2 }],
    [{ _id: "one", x: null }], [{ _id: "one", x: "200" }],
    [{ _id: "one", x: Infinity }], [{ _id: "one", x: { $add: 10 } }]
  ]) {
    assert.equal(scene._preUpdateDescendantDocuments(scene, "tokens", changes, {}, "user"), "native-result");
  }
  assert.equal(snapshots.length, 0);
  assert.ok(events.every(event => event.name === "native"));
});

test("unsupported generations and customized Token serialization retain their native behavior", () => {
  const scene = createScene();
  const changes = [{ _id: "one", x: 200 }];
  try {
    game.release.generation = 15;
    assert.equal(scene._preUpdateDescendantDocuments(scene, "tokens", changes, {}, "user"), "native-result");
  } finally {
    game.release.generation = 14;
  }
  scene.tokens.get("one").toObject = () => ({ _id: "one", x: 999 });
  assert.equal(scene._preUpdateDescendantDocuments(scene, "tokens", changes, {}, "user"), "native-result");
  assert.equal(snapshots.length, 0);
});

test("a replacement of native Scene history is respected", () => {
  const scene = createScene();
  const original = NativeScene.prototype._preUpdateDescendantDocuments;
  try {
    NativeScene.prototype._preUpdateDescendantDocuments = () => "module-hook";
    assert.equal(scene._preUpdateDescendantDocuments(scene, "tokens", [{ _id: "one", x: 200 }], {}, "user"), "module-hook");
    assert.equal(snapshots.length, 0);
  } finally {
    NativeScene.prototype._preUpdateDescendantDocuments = original;
  }
});

test("extensions of the inherited document hook retain the complete native Scene lifecycle", () => {
  const scene = createScene();
  const original = ClientDocument.prototype._preUpdateDescendantDocuments;
  const options = {};
  try {
    ClientDocument.prototype._preUpdateDescendantDocuments = function (...args) {
      original.apply(this, args);
      args[3].extensionRan = true;
    };
    assert.equal(scene._preUpdateDescendantDocuments(scene, "tokens", [{ _id: "one", x: 200 }], options, "user"), "native-result");
    assert.equal(events[0].args[3], options);
    assert.equal(snapshots.length, 0);
  } finally {
    ClientDocument.prototype._preUpdateDescendantDocuments = original;
  }
});
