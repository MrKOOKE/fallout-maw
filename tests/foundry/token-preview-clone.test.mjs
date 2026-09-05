import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {cloneTokenPreview, getPreviewActorContext, getPreviewItemValidationOptions, initializeValidatedPreviewActor, withTokenPreviewClone} from "../../src/documents/token-clone-initialization.mjs";

const core = process.env.FALLOUT_MAW_FOUNDRY_CORE;
test("visual clone keeps native independent documents and validation without repeated source cleaning", {skip: !core}, async t => {
  await import(pathToFileURL(path.join(core, "common/server.mjs")));
  globalThis.logger = {warn() {}, error() {}, info() {}, debug() {}};
  foundry.applications = {api: {DialogV2: class {}}, ux: {FormDataExtended: class {}}, handlebars: {renderTemplate: async () => ""}};
  globalThis.game = {release: {version: "14.361"}, settings: {get: () => ({base: {}, types: {}})},
    i18n: {localize: x => x, format: x => x},
    system: {id: "fallout-maw", version: "0.2.1", grid: {type: 1, distance: 1, units: "m"}, documentTypes: {Actor: {character: {}}, Item: {gear: {}, ability: {}, trauma: {}, disease: {}}}},
    model: {Actor: {character: {}}, Item: {gear: {}, ability: {}, trauma: {}, disease: {}}, ActiveEffect: {base: {}}}};
  const models = await import("../../src/data/models/item-data-models.mjs");
  const {getUnchangedItemSystemField} = await import("../../src/documents/item-model-initialization.mjs");
  const supportedModels = new Set([models.GearDataModel,models.AbilityDataModel,models.TraumaDataModel,models.DiseaseDataModel]);
  let itemCleans = 0, itemValidations = 0, itemJointValidations = 0, failJoint = false, base;
  const actorContexts = [];
  class Item extends foundry.documents.BaseItem {
    *_initializationOrder() {
      for(const [name,field] of super._initializationOrder()) yield [name,name==='system'?getUnchangedItemSystemField(this,field,supportedModels):field];
    }
    static validateJoint(data) {
      itemJointValidations++;
      if (failJoint) throw new Error("fixture joint validation");
      return super.validateJoint(data);
    }
    static cleanData(...args) { itemCleans++; return super.cleanData(...args); }
    validate(options = {}) { itemValidations++; return super.validate(getPreviewItemValidationOptions(this, options)); }
  }
  class Actor extends foundry.documents.BaseActor {
    _initialize(options = {}) { return initializeValidatedPreviewActor(this, options, () => super._initialize(options)); }
    _initializeSource(data, options) { actorContexts.push(options); return super._initializeSource(data, options); }
  }
  class Token extends foundry.documents.BaseToken {
    get baseActor() { return base; }
    get actor() { return this.actorLink ? base : this.delta?.syntheticActor; }
    get isLinked() { return this.actorLink; }
    clone(data = {}, context = {}) { return cloneTokenPreview(this, data, context, opts => super.clone(data, opts)); }
  }
  // Client ActorDelta's initial _configure/_createSyntheticActor/apply workflow,
  // using the actual common constructors and native applyDelta implementation.
  // This fixture has no canvas and performs no world database operations.
  class Delta extends foundry.documents.BaseActorDelta {
    _configure(options) {
      super._configure(options);
      Object.defineProperty(this, "syntheticActor", {value: this.apply({strict: true, dropInvalidEmbedded: true}), configurable: true});
    }
    apply(context = {}) { return this.constructor.applyDelta(this, this.parent.baseActor, getPreviewActorContext(this, context)); }
  }
  globalThis.CONFIG = {Actor: {documentClass: Actor, dataModels: {}}, Item: {documentClass: Item, dataModels: {
    gear: models.GearDataModel, ability: models.AbilityDataModel, trauma: models.TraumaDataModel, disease: models.DiseaseDataModel}},
    ActorDelta: {documentClass: Delta}, Token: {documentClass: Token}, Scene: {documentClass: foundry.documents.BaseScene}, ActiveEffect: {dataModels: {}}, Folder: {}};
  globalThis.getDocumentClass = name => CONFIG[name]?.documentClass ?? foundry.documents[`Base${name}`];
  base = new Actor({_id: "actor00000000000", name: "Clone fixture", type: "character", system: {hp: 10},
    ownership: {default: 0, player0000000000: 3}, items: [{_id: "baseitem00000000", name: "Base", type: "gear", system: {quantity: 2}}]});
  const data = {_id: "token00000000000", actorId: base.id, actorLink: false,
    delta: {_id: "token00000000000", system: {hp: 7}, items: [
      {_id: "deltaitem0000000", name: "Gear", type: "gear", system: {quantity: 3, functions: {weapon: {enabled: true}}}},
      {_id: "ability000000000", name: "Ability", type: "ability", system: {}}
    ], effects: [{_id: "effect0000000000", name: "Effect", type: "base", disabled: false, changes: []}]}};
  const scene = new foundry.documents.BaseScene({_id: "scene00000000000", name: "Clone fixture"});
  const source = new Token(foundry.utils.deepClone(data), {parent: scene});
  source.delta;
  const nativeClone = () => foundry.documents.BaseToken.prototype.clone.call(source, {}, {keepId: true});
  const fastClone = () => withTokenPreviewClone(source, () => source.clone({}, {keepId: true}));
  await t.test("same complete source and separate Actor, Item, effect and model instances", () => {
    const native = nativeClone();
    itemCleans = itemValidations = itemJointValidations = 0; actorContexts.length = 0;
    const candidate = fastClone();
    assert.equal(itemCleans, 0, "already cleaned Item sources are not cleaned again");
    assert.ok(itemValidations >= 3, "new native Item documents are still validated");
    assert.ok(itemJointValidations >= 3, "native joint validation still runs on each new Item");
    assert.equal(actorContexts.at(-1).clean, false);
    assert.deepEqual(candidate.toObject(), native.toObject());
    assert.deepEqual(candidate.actor.toObject(), native.actor.toObject());
    assert.deepEqual(candidate.actor.toObject(false), native.actor.toObject(false));
    assert.notEqual(candidate.actor, source.actor);
    for (const item of candidate.actor.items) {
      const original = source.actor.items.get(item.id);
      assert.notEqual(item, original);
      assert.notEqual(item.system, original.system);
      assert.notEqual(item._source, original._source);
      assert.equal(item.parent, candidate.actor);
    }
    assert.notEqual(candidate.actor.effects.contents[0], source.actor.effects.contents[0]);
    candidate.actor.items.get("deltaitem0000000").updateSource({"system.quantity": 17});
    assert.equal(source.actor.items.get("deltaitem0000000").system.quantity, 3);
    candidate.actor.effects.contents[0].updateSource({disabled: true});
    assert.equal(source.actor.effects.contents[0].disabled, false);
  });
  await t.test("ordinary clones, overrides and additional options retain native cleaning", () => {
    for (const clone of [() => source.clone({}, {keepId: true}),
      () => withTokenPreviewClone(source, () => source.clone({x: 10}, {keepId: true})),
      () => withTokenPreviewClone(source, () => source.clone({}, {keepId: true, save: false}))]) {
      itemCleans = 0; clone(); assert.ok(itemCleans > 0);
    }
  });
  await t.test("scope is restored after errors and normal later delta application", () => {
    assert.throws(() => withTokenPreviewClone(source, () => cloneTokenPreview(source, {}, {keepId: true}, () => {throw new Error("fixture");})), /fixture/);
    itemCleans = 0; nativeClone(); assert.ok(itemCleans > 0);
    const clone = fastClone(); actorContexts.length = 0; clone.delta.apply({strict: true, dropInvalidEmbedded: true});
    assert.notEqual(actorContexts.at(-1).clean, false);
  });
  await t.test("validation failures are retained and do not leave a trusted construction scope", () => {
    failJoint = true;
    try {
      const reference = nativeClone(), candidate = fastClone();
      assert.deepEqual(candidate.actor.items.invalidDocumentIds, reference.actor.items.invalidDocumentIds);
      assert.equal(candidate.actor.items.invalidDocumentIds.size, 3);
      assert.deepEqual(candidate.actor.toObject(), reference.actor.toObject());
    } finally { failJoint = false; }
    const clone = fastClone();
    const item = clone.actor.items.get("deltaitem0000000");
    item._source.system.quantity = -1;
    assert.throws(() => item.validate({strict: true}), /validation|quantity|non-negative|must be/i);
    item._source.system.quantity = 3;
    item.validate({strict: true});
    const reference = nativeClone();
    item.updateSource({"system.quantity": -1});
    reference.actor.items.get(item.id).updateSource({"system.quantity": -1});
    assert.deepEqual(clone.actor.toObject(), reference.actor.toObject());
  });
  await t.test("later preview resets validate changed sources and restore derived state", () => {
    const candidate=fastClone(), reference=nativeClone();
    for(const token of [candidate,reference]) {
      const item=token.actor.items.get('deltaitem0000000');
      item.system.quantity=999;
      item._source.system.quantity=17;
      token.actor.reset();
      assert.equal(item.system.quantity,17);
      assert.equal(source.actor.items.get(item.id).system.quantity,3);
    }
    assert.deepEqual(candidate.actor.toObject(false),reference.actor.toObject(false));
  });
  await t.test("other builds and linked tokens retain native construction", () => {
    game.release.version = "14.999"; itemCleans = 0; fastClone(); assert.ok(itemCleans > 0);
    game.release.version = "14.361";
    const linked = new Token({...foundry.utils.deepClone(data), actorLink: true}, {parent: scene});
    const copy = withTokenPreviewClone(linked, () => linked.clone({}, {keepId: true}));
    assert.equal(copy.actor, base);
  });
  await t.test("large inventory retains complete native data", () => {
    const heavyData = foundry.utils.deepClone(data);
    heavyData.delta.items = Array.from({length: 800}, (_, i) => ({...foundry.utils.deepClone(data.delta.items[0]), _id: String(i).padStart(16, "0")}));
    const heavy = new Token(heavyData, {parent: scene});
    heavy.delta;
    const timings = {native: [], candidate: []};
    let reference, candidate;
    for (let i = 0; i < 4; i++) {
      let start = performance.now();
      reference = foundry.documents.BaseToken.prototype.clone.call(heavy, {}, {keepId: true});
      timings.native.push(performance.now() - start);
      start = performance.now();
      candidate = withTokenPreviewClone(heavy, () => heavy.clone({}, {keepId: true}));
      timings.candidate.push(performance.now() - start);
    }
    assert.equal(candidate.actor.items.size, 801);
    assert.deepEqual(candidate.toObject(), reference.toObject());
    assert.deepEqual(candidate.actor.toObject(false), reference.actor.toObject(false));
    t.diagnostic(`Common document constructors only, milliseconds: ${JSON.stringify(timings)}`);
  });
});
