import assert from "node:assert/strict";
import test from "node:test";

globalThis.foundry = {
  applications: {
    api: { DialogV2: class DialogV2 {} },
    ux: { FormDataExtended: class FormDataExtended {} },
    handlebars: { renderTemplate: async () => "" }
  },
  utils: {
    deepClone: value => structuredClone(value),
    getProperty: () => undefined,
    hasProperty: () => false,
    mergeObject: (target, source) => ({ ...target, ...source }),
    randomID: () => "test-id",
    setProperty: () => true
  }
};

const { NEED_THRESHOLDS_TESTING } = await import("../src/needs/need-thresholds.mjs");

test("need threshold effects always expose their icon on tokens", () => {
  const effect = NEED_THRESHOLDS_TESTING.buildNeedPenaltyEffectData(
    { key: "hunger", label: "Голод" },
    {
      id: "at-50",
      percent: 50,
      effects: [{
        key: "system.characteristics.strength",
        type: "add",
        value: "-2",
        phase: "initial"
      }]
    }
  );

  assert.equal(effect.showIcon, 2);
  assert.equal(effect.img, "icons/svg/downgrade.svg");
  assert.equal(effect.disabled, false);
  assert.deepEqual(
    JSON.parse(effect.flags["fallout-maw"].needEffect.signature),
    {
      thresholdId: "at-50",
      changes: [{
        key: "system.characteristics.strength",
        type: "add",
        value: "-2",
        phase: "initial"
      }],
      showIcon: 2
    }
  );
});

test("need thresholds without changes do not create empty token effects", () => {
  assert.equal(
    NEED_THRESHOLDS_TESTING.buildNeedPenaltyEffectData(
      { key: "radcont", label: "Рад. Заражение" },
      { id: "at-25", percent: 25, effects: [] }
    ),
    null
  );
});

test("changing a need threshold updates the same Active Effect document", async () => {
  const operations = {
    creates: [],
    updates: [],
    deletes: []
  };
  const effect = createNeedEffectDocument({
    id: "need-effect-1",
    needKey: "addiction",
    signature: "old-threshold"
  });
  const actor = createActorWithEffects([effect], operations);

  await NEED_THRESHOLDS_TESTING.syncNeedPenaltyEffect(
    actor,
    { key: "addiction", label: "Зависимость" },
    {
      id: "at-100",
      percent: 100,
      effects: [{
        key: "system.firstAid.incomingEffectivenessPercent",
        type: "add",
        value: "-100",
        phase: "initial"
      }]
    }
  );

  assert.equal(operations.creates.length, 0);
  assert.equal(operations.deletes.length, 0);
  assert.equal(operations.updates.length, 1);
  assert.equal(operations.updates[0]._id, "need-effect-1");
  assert.equal(operations.updates[0].name, "Зависимость: 100%");
  assert.equal(operations.updates[0].showIcon, 2);
  assert.equal(
    operations.updates[0].flags["fallout-maw"].needEffect.thresholdId,
    "at-100"
  );
});

test("need effect is deleted only when no configured threshold penalty remains", async () => {
  const operations = {
    creates: [],
    updates: [],
    deletes: []
  };
  const effect = createNeedEffectDocument({
    id: "need-effect-1",
    needKey: "hunger",
    signature: "at-50"
  });
  const actor = createActorWithEffects([effect], operations);

  await NEED_THRESHOLDS_TESTING.syncNeedPenaltyEffect(
    actor,
    { key: "hunger", label: "Голод" },
    null
  );

  assert.equal(operations.creates.length, 0);
  assert.equal(operations.updates.length, 0);
  assert.deepEqual(operations.deletes, ["need-effect-1"]);
});

function createNeedEffectDocument({ id, needKey, signature }) {
  return {
    id,
    type: "base",
    name: "Старый порог",
    img: "icons/svg/downgrade.svg",
    transfer: false,
    disabled: false,
    showIcon: 1,
    getFlag(namespace, key) {
      if (namespace !== "fallout-maw" || key !== "needEffect") return null;
      return { needKey, signature };
    }
  };
}

function createActorWithEffects(effects, operations) {
  return {
    effects,
    async createEmbeddedDocuments(_type, documents) {
      operations.creates.push(...documents);
      return documents;
    },
    async updateEmbeddedDocuments(_type, documents) {
      operations.updates.push(...documents);
      return documents;
    },
    async deleteEmbeddedDocuments(_type, ids) {
      operations.deletes.push(...ids);
      return ids;
    }
  };
}
