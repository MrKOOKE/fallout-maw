import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildFirstAidApplicationCardContext } from "../src/items/first-aid-chat-card.mjs";

test("zero first-aid effectiveness still produces factual zero card values", () => {
  const context = buildFirstAidApplicationCardContext({
    item: { name: "Стимулятор", img: "stim.webp" },
    sourceActor: { name: "Доктор" },
    targetActor: { name: "Пациент" },
    resultKey: "success",
    resultLabel: "Успех",
    firstAid: {
      healing: 20,
      healingIsPercentage: false,
      durationSeconds: 30,
      changes: [
        {
          key: "system.characteristics.endurance",
          type: "add",
          value: "2"
        },
        {
          key: "fallout-maw.healing",
          type: "add",
          value: "4"
        }
      ],
      withdrawal: [],
      withdrawalDurationSeconds: 0,
      needs: [],
      removeEffects: []
    },
    scaling: {
      effect: 0,
      healing: 0,
      withdrawalEffect: 0,
      withdrawalHealing: 0
    },
    healing: 0,
    appliedDurationSeconds: 0,
    spentCharges: 1,
    pathLabels: new Map([
      ["system.characteristics.endurance", "Выносливость"]
    ]),
    labels: {
      directHealing: "Прямое лечение",
      periodicHealing: "Заживление",
      zeroDuration: "0 сек."
    }
  });

  assert.equal(context.effectiveness, "0%");
  assert.deepEqual(context.duration, {
    configured: "30 сек.",
    applied: "0 сек.",
    appliedZero: true
  });
  assert.equal(context.spentCharges, 1);
  assert.deepEqual(context.mainEffects, [
    {
      label: "Прямое лечение",
      configured: "20",
      applied: "0",
      appliedZero: true
    },
    {
      label: "Выносливость",
      configured: "+2",
      applied: "0",
      appliedZero: true
    },
    {
      label: "Заживление",
      configured: "+4",
      applied: "0",
      appliedZero: true
    }
  ]);
});

test("first-aid card uses the same rounded effect values as application runtime", () => {
  const context = buildFirstAidApplicationCardContext({
    firstAid: {
      healing: 5,
      durationSeconds: 60,
      changes: [{
        key: "system.characteristics.endurance",
        type: "add",
        value: "5"
      }],
      needs: [{ needKey: "addiction", value: -5 }],
      withdrawal: [],
      removeEffects: []
    },
    scaling: {
      effect: 0.7,
      healing: 0.7,
      withdrawalEffect: 0,
      withdrawalHealing: 0
    },
    healing: 3,
    appliedDurationSeconds: 45,
    pathLabels: new Map([
      ["system.characteristics.endurance", "Выносливость"]
    ]),
    needLabels: new Map([
      ["addiction", "Зависимость"]
    ]),
    labels: {
      directHealing: "Прямое лечение",
      needs: "Потребности",
      zeroDuration: "0 сек."
    }
  });

  assert.equal(context.effectiveness, "70%");
  assert.equal(context.duration.applied, "45 сек.");
  assert.deepEqual(context.mainEffects.map(row => [row.label, row.configured, row.applied]), [
    ["Прямое лечение", "5", "3"],
    ["Потребности: Зависимость", "-5", "-3"],
    ["Выносливость", "+5", "+3"]
  ]);
});

test("zero duration reports timed changes as unapplied even with nonzero effectiveness", () => {
  const context = buildFirstAidApplicationCardContext({
    firstAid: {
      healing: 0,
      durationSeconds: 30,
      changes: [{
        key: "system.characteristics.endurance",
        type: "add",
        value: "5"
      }],
      needs: [],
      withdrawal: [],
      removeEffects: []
    },
    scaling: {
      effect: 0.7,
      healing: 0.7,
      withdrawalEffect: 0,
      withdrawalHealing: 0
    },
    appliedDurationSeconds: 0,
    pathLabels: new Map([
      ["system.characteristics.endurance", "Выносливость"]
    ]),
    labels: { zeroDuration: "0 сек." }
  });

  assert.equal(context.effectiveness, "70%");
  assert.equal(context.duration.applied, "0 сек.");
  assert.deepEqual(context.mainEffects[0], {
    label: "Выносливость",
    configured: "+5",
    applied: "0",
    appliedZero: true
  });
});

test("zero main result still reports full unresisted withdrawal", () => {
  const context = buildFirstAidApplicationCardContext({
    firstAid: {
      healing: 0,
      durationSeconds: 18,
      changes: [{
        key: "system.resources.reaction.value",
        type: "add",
        value: "5"
      }],
      withdrawalDurationSeconds: 900,
      withdrawal: [{
        key: "system.resources.action.value",
        type: "add",
        value: "-3"
      }],
      needs: [],
      removeEffects: []
    },
    scaling: {
      effect: 0,
      healing: 0,
      withdrawalEffect: 1,
      withdrawalHealing: 1
    },
    appliedDurationSeconds: 0,
    appliedWithdrawalDurationSeconds: 900,
    pathLabels: new Map([
      ["system.resources.reaction.value", "Reaction points"],
      ["system.resources.action.value", "Action points"]
    ]),
    labels: { zeroDuration: "0 sec." }
  });

  assert.equal(context.duration.applied, "0 sec.");
  assert.equal(context.mainEffects[0].applied, "0");
  assert.equal(context.withdrawalDuration.applied, context.withdrawalDuration.configured);
  assert.deepEqual(context.withdrawalEffects[0], {
    label: "Action points",
    configured: "-3",
    applied: "-3",
    appliedZero: false
  });
});

test("critical failure resolves independently calculated withdrawal", async () => {
  const source = await readFile(new URL("../src/items/first-aid.mjs", import.meta.url), "utf8");
  const withdrawalIndex = source.indexOf("const hasWithdrawal =");
  const criticalFailureIndex = source.indexOf('if (resultKey === "criticalFailure")', withdrawalIndex);
  const healingIndex = source.indexOf("if (healing > 0)", criticalFailureIndex);
  const criticalFailureSegment = source.slice(criticalFailureIndex, healingIndex);

  assert.ok(withdrawalIndex >= 0);
  assert.ok(criticalFailureIndex > withdrawalIndex);
  assert.ok(healingIndex > criticalFailureIndex);
  assert.match(criticalFailureSegment, /requestFirstAidWithdrawalEffect/);
});

test("resolved zero-output first aid reaches item consumption instead of returning early", async () => {
  const source = await readFile(new URL("../src/items/first-aid.mjs", import.meta.url), "utf8");
  const resolvedOutputIndex = source.indexOf("const hasTimedEffect =");
  const consumptionIndex = source.indexOf("await spendFirstAidItem(", resolvedOutputIndex);
  const resolvedSegment = source.slice(resolvedOutputIndex, consumptionIndex);

  assert.ok(resolvedOutputIndex >= 0);
  assert.ok(consumptionIndex > resolvedOutputIndex);
  assert.doesNotMatch(resolvedSegment, /return false/);
});

test("first-aid effect labels use concise medication wording", async () => {
  const locale = JSON.parse(await readFile(
    new URL("../lang/ru.json", import.meta.url),
    "utf8"
  ));

  assert.equal(
    locale.FALLOUTMAW.Effects.FirstAidIncomingEffectiveness,
    "Входящая эффективность препаратов"
  );
  assert.equal(
    locale.FALLOUTMAW.Effects.FirstAidOutgoingEffectiveness,
    "Исходящая эффективность препаратов"
  );
  assert.equal(locale.FALLOUTMAW.Effects.FirstAidDuration, "Длительность препаратов");
});

test("first-aid card template exposes actual effectiveness, duration, effects, and spent charges", async () => {
  const template = await readFile(
    new URL("../templates/chat/first-aid-card.hbs", import.meta.url),
    "utf8"
  );

  assert.match(template, /FirstAidChatEffectiveness/);
  assert.match(template, /duration\.applied/);
  assert.match(template, /FirstAidChatEffects/);
  assert.match(template, /FirstAidChatChargesSpent/);
  assert.doesNotMatch(template, /first-aid-card-effect header/);
  assert.match(template, /first-aid-card-comparison/);
  assert.doesNotMatch(template, /причин|reason/i);
});
