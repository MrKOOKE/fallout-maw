import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import {pathToFileURL} from "node:url";

const core = process.env.FALLOUT_MAW_FOUNDRY_CORE;
test("Token source serialization matches Foundry without its discarded inventory copy", {skip: !core}, async t => {
  await import(pathToFileURL(path.join(core, "common/server.mjs")));
  globalThis.logger = {warn() {}, error() {}, info() {}, debug() {}};
  foundry.applications = {api: {DialogV2: class {}}, ux: {FormDataExtended: class {}}, handlebars: {renderTemplate: async () => ""}};
  globalThis.game = {release: {version: "14.361"}, actors: new Map(), settings: {get: () => ({base: {}, types: {}})},
    i18n: {localize: x => x, format: x => x},
    system: {id: "fallout-maw", version: "0.2.1", grid: {type: 1, distance: 1, units: "m"}, documentTypes: {Item: {gear: {}, ability: {}, trauma: {}, disease: {}}}},
    model: {Actor: {character: {}}, Item: {gear: {}, ability: {}, trauma: {}, disease: {}}, ActiveEffect: {base: {}}}};
  const models = await import("../../src/data/models/item-data-models.mjs");
  const {BaseToken, BaseActor, BaseActorDelta, BaseItem, BaseActiveEffect, BaseScene} = foundry.documents;
  globalThis.TokenDocument = BaseToken;
  const {FalloutMaWTokenDocument: Token} = await import("../../src/documents/token.mjs");
  globalThis.CONFIG = {Token: {documentClass: Token}, Actor: {documentClass: BaseActor, dataModels: {}},
    ActorDelta: {documentClass: BaseActorDelta}, Scene: {documentClass: BaseScene},
    Item: {documentClass: BaseItem, dataModels: {gear: models.GearDataModel, ability: models.AbilityDataModel,
      trauma: models.TraumaDataModel, disease: models.DiseaseDataModel}},
    ActiveEffect: {documentClass: BaseActiveEffect, dataModels: {}}, Folder: {}};
  globalThis.getDocumentClass = name => CONFIG[name]?.documentClass ?? foundry.documents[`Base${name}`];
  let copies = 0;
  globalThis.__falloutMawGameplayProbe = {count: name => {if (name === "token.sourceSingleCopy") copies++;}};
  const source = {_id: "token00000000000", actorId: "actor00000000000", actorLink: false, x: 20, y: 30,
    flags: {"fallout-maw": {nested: {values: [1, 2]}}},
    delta: {_id: "token00000000000", name: null, system: {hp: 7}, items: [
      {_id: "gear00000000000", name: "Gear", type: "gear", system: {quantity: 3}},
      {_id: "ability000000000", name: "Ability", type: "ability", system: {}},
      {_id: "deleted000000000", _tombstone: true}
    ], effects: [{_id: "effect0000000000", name: "Effect", type: "base", disabled: true, changes: []}]}};
  const scene = new BaseScene({_id: "scene00000000000", name: "Serialization fixture"});
  const make = (data = source) => new Token(foundry.utils.deepClone(data), {parent: scene});
  const native = (document, mode = true) => BaseToken.prototype.toObject.call(document, mode);

  await t.test("complete source, optional delta fields, tombstones, effects and independent copies", () => {
    const token = make(); token.delta;
    copies = 0;
    const data = token.toObject(), reference = native(token);
    assert.equal(copies, 1, "the optimized path actually ran");
    assert.deepEqual(data, reference);
    assert.equal(Object.hasOwn(data.delta, "name"), false);
    assert.equal(Object.hasOwn(data, "hexagonalShape"), Object.hasOwn(reference, "hexagonalShape"));
    assert.equal(Object.getOwnPropertyDescriptor(data, "hexagonalShape")?.enumerable, false);
    data.delta.items[0].system.quantity = 99;
    data.flags["fallout-maw"].nested.values.push(3);
    assert.deepEqual(token.toObject(), reference);
    token._source.delta.system.hp = 4;
    assert.deepEqual(token.toObject(), native(token), "there is no stale cached snapshot");
    assert.equal(token.toObject().delta.system.hp, 4);
  });
  await t.test("prepared data and an unmaterialized delta keep native behavior", () => {
    const token = make(); copies = 0;
    assert.equal(typeof Object.getOwnPropertyDescriptor(token, "delta").get, "function");
    assert.deepEqual(token.toObject(), native(token));
    assert.equal(copies, 0, "lazy initialization retains native call order");
    assert.deepEqual(token.toObject(false), native(token, false));
    assert.equal(copies, 0);
  });
  await t.test("linked or absent delta, other versions and custom serializers keep native behavior", () => {
    for (const data of [{...source, actorLink: true}, {...source, delta: null}]) {
      const token = make(data); token.delta; copies = 0;
      assert.deepEqual(token.toObject(), native(token)); assert.equal(copies, 0);
    }
    const token = make(); token.delta;
    game.release.version = "14.999"; copies = 0;
    try {assert.deepEqual(token.toObject(), native(token)); assert.equal(copies, 0);}
    finally {game.release.version = "14.361";}
    const original = BaseToken.prototype.toObject;
    try {
      BaseToken.prototype.toObject = function (...args) {return {...original.apply(this, args), extension: true};};
      copies = 0; assert.equal(token.toObject().extension, true); assert.equal(copies, 0);
    } finally {BaseToken.prototype.toObject = original;}
  });
  await t.test("custom embedded compatibility shims and subclass shims retain their native calls", () => {
    const token = make(); token.delta;
    let shimCalls = 0;
    class CustomItem extends BaseItem {
      static shimData(...args) {shimCalls++; return super.shimData(...args);}
    }
    CONFIG.Item.documentClass = CustomItem; copies = 0;
    try {
      const data = token.toObject(), reference = native(token);
      assert.deepEqual(data, reference); assert.ok(shimCalls > 0); assert.equal(copies, 0);
    } finally {CONFIG.Item.documentClass = BaseItem;}
    class CustomToken extends Token {
      static shimData(data, ...args) {super.shimData(data, ...args); data.x = 999; return data;}
    }
    const customized = new CustomToken(foundry.utils.deepClone(source), {parent: scene}); customized.delta; copies = 0;
    assert.deepEqual(customized.toObject(), native(customized)); assert.equal(customized.toObject().x, 999); assert.equal(copies, 0);
  });
  await t.test("800 Items serialize identically with bounded timing diagnostics", () => {
    const data = foundry.utils.deepClone(source);
    data.delta.items = Array.from({length: 800}, (_, i) => ({...foundry.utils.deepClone(source.delta.items[0]), _id: String(i).padStart(16, "0")}));
    const token = make(data); token.delta;
    const times = {native: [], candidate: []};
    for (let i = 0; i < 5; i++) {
      let start = performance.now(); const reference = native(token); times.native.push(performance.now() - start);
      start = performance.now(); const candidate = token.toObject(); times.candidate.push(performance.now() - start);
      assert.deepEqual(candidate, reference);
    }
    t.diagnostic(`Source serialization only, milliseconds: ${JSON.stringify(times)}`);
  });
  delete globalThis.__falloutMawGameplayProbe;
});
