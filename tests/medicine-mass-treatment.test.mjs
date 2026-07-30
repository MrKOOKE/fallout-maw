import assert from "node:assert/strict";
import test from "node:test";

import {
  getMassTreatmentTargetCounts,
  normalizeMassTreatmentOptions,
  runSequentialMassTreatment
} from "../src/apps/medicine-mass-treatment.mjs";

test("mass treatment resolves every trauma before newly-unlocked limb health", async () => {
  const calls = [];
  const initialContext = createContext({
    traumas: [createTrauma("fracture", 0, 1)],
    limbs: [createLimb("leftArm", 5, 10, {
      healingCap: 5,
      healingProgress: 5,
      healingProgressMax: 5,
      treatable: false
    })]
  });

  const result = await runSequentialMassTreatment({
    initialContext,
    chooseInstrument: ({ treatmentType }) => ({ instrumentId: `${treatmentType}-tool` }),
    resolveTreatment: async ({ targetContext, treatmentType, treatmentId }) => {
      calls.push(`${treatmentType}:${treatmentId}`);
      if (treatmentType === "trauma") {
        const targetContextAfterTrauma = createContext({
          traumas: [createTrauma("fracture", 1, 1)],
          limbs: [createLimb("leftArm", 5, 10, {
            healingCap: 10,
            healingProgress: 5,
            healingProgressMax: 10,
            treatable: true
          })]
        });
        return committedReceipt({
          initialProgress: 0,
          finalProgress: 1,
          maxProgress: 1,
          spentCharges: 1,
          targetContext: targetContextAfterTrauma
        });
      }

      assert.equal(targetContext.limbs[0].healingCap, 10);
      assert.equal(targetContext.limbs[0].treatable, true);
      return committedReceipt({
        initialProgress: 5,
        finalProgress: 10,
        maxProgress: 10,
        spentCharges: 2,
        targetContext: createContext({
          traumas: [createTrauma("fracture", 1, 1)],
          limbs: [createLimb("leftArm", 10, 10)]
        })
      });
    }
  });

  assert.deepEqual(calls, ["trauma:fracture", "limb:leftArm"]);
  assert.equal(result.summary.completedTraumas, 1);
  assert.equal(result.summary.completedLimbs, 1);
  assert.equal(result.summary.restoredTraumaProgress, 1);
  assert.equal(result.summary.restoredLimbHealth, 5);
  assert.equal(result.summary.charges, 3);
});

test("trauma and limb-health category flags operate independently", async t => {
  const cases = [
    {
      name: "traumas only",
      options: { includeTraumas: true },
      expected: ["trauma"]
    },
    {
      name: "limb health only",
      options: { includeLimbHealth: true },
      expected: ["limb"]
    },
    {
      name: "both explicitly enabled",
      options: { includeTraumas: true, includeLimbHealth: true },
      expected: ["trauma", "limb"]
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const calls = [];
      const result = await runSequentialMassTreatment({
        initialContext: createContext(),
        options: scenario.options,
        chooseInstrument: () => ({ instrumentId: "doctor-bag" }),
        resolveTreatment: async ({ targetContext, treatment, treatmentType }) => {
          calls.push(treatmentType);
          return committedReceipt({
            initialProgress: treatment.healingProgress,
            finalProgress: treatment.healingProgressMax,
            maxProgress: treatment.healingProgressMax,
            targetContext: completeTreatment(targetContext, treatmentType, treatment.id)
          });
        }
      });

      assert.deepEqual(calls, scenario.expected);
      assert.equal(result.summary.requestedTraumas, scenario.expected.includes("trauma") ? 1 : 0);
      assert.equal(result.summary.requestedLimbHealth, scenario.expected.includes("limb") ? 1 : 0);
    });
  }

  assert.deepEqual(normalizeMassTreatmentOptions({ includeTraumas: true }), {
    includeTraumas: true,
    includeLimbHealth: false,
    qualityMode: "matched",
    supplyMode: "depleted",
    allowedToolGroupKeys: []
  });
  assert.deepEqual(normalizeMassTreatmentOptions({ includeLimbHealth: true }), {
    includeTraumas: false,
    includeLimbHealth: true,
    qualityMode: "matched",
    supplyMode: "depleted",
    allowedToolGroupKeys: []
  });
});

test("mass treatment rejects an empty category selection before choosing a tool", async () => {
  let selections = 0;
  await assert.rejects(
    runSequentialMassTreatment({
      initialContext: createContext(),
      options: { includeTraumas: false, includeLimbHealth: false },
      chooseInstrument: () => {
        selections += 1;
        return { instrumentId: "kit" };
      },
      resolveTreatment: () => assert.fail("no treatment may run")
    }),
    /Выберите хотя бы один вид/
  );
  assert.equal(selections, 0);
});

test("missing, prosthetic, healthy, and trauma-capped limbs never reach treatment resolution", async () => {
  const calls = [];
  const result = await runSequentialMassTreatment({
    initialContext: createContext({
      traumas: [],
      limbs: [
        createLimb("missing", 0, 10, { missing: true }),
        createLimb("prosthetic", 0, 10, { prosthesis: { id: "prosthesis" } }),
        createLimb("healthy", 10, 10),
        createLimb("capped", 5, 10, {
          healingCap: 5,
          healingProgress: 5,
          healingProgressMax: 5,
          treatable: false,
          unavailableReason: "Сначала вылечите ограничивающую травму."
        }),
        createLimb("healable", 2, 10)
      ]
    }),
    options: { includeLimbHealth: true },
    chooseInstrument: ({ treatment }) => ({ instrumentId: `tool-${treatment.id}` }),
    resolveTreatment: async ({ targetContext, treatment }) => {
      calls.push(treatment.id);
      return committedReceipt({
        initialProgress: treatment.healingProgress,
        finalProgress: treatment.healingProgressMax,
        maxProgress: treatment.healingProgressMax,
        targetContext: completeTreatment(targetContext, "limb", treatment.id)
      });
    }
  });

  assert.deepEqual(calls, ["healable"]);
  assert.equal(result.summary.completedLimbs, 1);
  assert.equal(result.summary.skipped, 0);
});

test("a limb already at its trauma healing cap is not advertised as a mass target", () => {
  const context = createContext({
    traumas: [],
    limbs: [createLimb("capped", 5, 10, {
      healingCap: 5,
      healingProgress: 5,
      healingProgressMax: 5,
      treatable: false
    })]
  });

  assert.deepEqual(getMassTreatmentTargetCounts(context), {
    traumas: 0,
    limbHealth: 0
  });
});

test("mass treatment is strictly sequential with maximum treatment concurrency of one", async () => {
  let active = 0;
  let maximumActive = 0;
  const completionOrder = [];
  const initialContext = createContext({
    traumas: [
      createTrauma("first", 0, 1),
      createTrauma("second", 0, 1),
      createTrauma("third", 0, 1)
    ],
    limbs: []
  });

  const result = await runSequentialMassTreatment({
    initialContext,
    options: { includeTraumas: true },
    chooseInstrument: ({ treatment }) => ({ instrumentId: `tool-${treatment.id}` }),
    resolveTreatment: async ({ targetContext, treatment, treatmentId }) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise(resolve => setTimeout(resolve, treatmentId === "first" ? 8 : 1));
      completionOrder.push(treatmentId);
      active -= 1;
      return committedReceipt({
        initialProgress: treatment.healingProgress,
        finalProgress: treatment.healingProgressMax,
        maxProgress: treatment.healingProgressMax,
        targetContext: completeTreatment(targetContext, "trauma", treatmentId)
      });
    }
  });

  assert.equal(maximumActive, 1);
  assert.deepEqual(completionOrder, ["first", "second", "third"]);
  assert.equal(result.summary.attempted, 3);
  assert.equal(result.summary.completedTraumas, 3);
});

test("partial progress repeats the same target, reselects a tool, and sums charges", async () => {
  const selectedAtProgress = [];
  const usedInstrumentIds = [];
  const initialContext = createContext({
    traumas: [createTrauma("deep-wound", 0, 10)],
    limbs: []
  });

  const result = await runSequentialMassTreatment({
    initialContext,
    options: { includeTraumas: true },
    chooseInstrument: ({ treatment }) => {
      selectedAtProgress.push(treatment.healingProgress);
      return {
        instrumentId: treatment.healingProgress === 0 ? "nearly-empty-kit" : "fresh-kit"
      };
    },
    resolveTreatment: async ({ targetContext, treatment, instrumentId }) => {
      usedInstrumentIds.push(instrumentId);
      const nextProgress = treatment.healingProgress === 0 ? 4 : 10;
      const nextContext = updateTraumaProgress(targetContext, treatment.id, nextProgress);
      return committedReceipt({
        initialProgress: treatment.healingProgress,
        finalProgress: nextProgress,
        maxProgress: treatment.healingProgressMax,
        spentCharges: nextProgress === 4 ? 2 : 3,
        targetContext: nextContext
      });
    }
  });

  assert.deepEqual(selectedAtProgress, [0, 4]);
  assert.deepEqual(usedInstrumentIds, ["nearly-empty-kit", "fresh-kit"]);
  assert.equal(result.summary.attempted, 2);
  assert.equal(result.summary.completedTraumas, 1);
  assert.equal(result.summary.restoredTraumaProgress, 10);
  assert.equal(result.summary.charges, 5);
});

test("a committed step without progress is guarded against an infinite retry", async () => {
  let selections = 0;
  let resolutions = 0;

  const result = await runSequentialMassTreatment({
    initialContext: createContext({
      traumas: [createTrauma("stalled", 2, 10)],
      limbs: []
    }),
    options: { includeTraumas: true },
    chooseInstrument: () => {
      selections += 1;
      return { instrumentId: "broken-kit" };
    },
    resolveTreatment: async ({ targetContext }) => {
      resolutions += 1;
      return committedReceipt({
        completed: false,
        initialProgress: 2,
        finalProgress: 2,
        maxProgress: 10,
        spentCharges: 1,
        targetContext
      });
    }
  });

  assert.equal(selections, 1);
  assert.equal(resolutions, 1);
  assert.equal(result.summary.attempted, 1);
  assert.equal(result.summary.completedTraumas, 0);
  assert.equal(result.summary.skipped, 1);
  assert.equal(result.summary.stopped, false);
  assert.equal(result.summary.charges, 1);
  assert.equal(result.summary.reasons.length, 1);
});

test("an unavailable instrument preserves its concrete reason and skips only that target", async () => {
  const resolved = [];
  const initialContext = createContext({
    traumas: [
      createTrauma("blocked", 0, 1),
      createTrauma("available", 0, 1)
    ],
    limbs: []
  });

  const result = await runSequentialMassTreatment({
    initialContext,
    options: { includeTraumas: true },
    chooseInstrument: ({ treatment }) => treatment.id === "blocked"
      ? { reason: "Для использования «Аптечка» нужно 80 Доктор (сейчас 50)." }
      : { instrumentId: "doctor-bag" },
    resolveTreatment: async ({ targetContext, treatment }) => {
      resolved.push(treatment.id);
      return committedReceipt({
        initialProgress: treatment.healingProgress,
        finalProgress: treatment.healingProgressMax,
        maxProgress: treatment.healingProgressMax,
        targetContext: completeTreatment(targetContext, "trauma", treatment.id)
      });
    }
  });

  assert.deepEqual(resolved, ["available"]);
  assert.equal(result.summary.skipped, 1);
  assert.equal(result.summary.stopped, false);
  assert.deepEqual(result.summary.reasons, [
    "Для использования «Аптечка» нужно 80 Доктор (сейчас 50)."
  ]);
});

test("a hard failure stops later work without discarding the completed summary", async () => {
  const calls = [];
  const initialContext = createContext({
    traumas: [
      createTrauma("treated-first", 0, 3),
      createTrauma("fatal-second", 0, 4)
    ],
    limbs: [createLimb("rightLeg", 0, 5)]
  });

  const result = await runSequentialMassTreatment({
    initialContext,
    chooseInstrument: ({ treatment }) => ({ instrumentId: `tool-${treatment.id}` }),
    resolveTreatment: async ({ targetContext, treatment, treatmentType }) => {
      calls.push(`${treatmentType}:${treatment.id}`);
      if (treatment.id === "fatal-second") {
        return {
          status: "failed",
          reason: "authoritative failure",
          initialProgress: 0,
          finalProgress: 0,
          spentCharges: 0,
          targetContext
        };
      }
      return committedReceipt({
        initialProgress: 0,
        finalProgress: 3,
        maxProgress: 3,
        spentCharges: 2,
        targetContext: completeTreatment(targetContext, "trauma", treatment.id)
      });
    }
  });

  assert.deepEqual(calls, ["trauma:treated-first", "trauma:fatal-second"]);
  assert.equal(result.summary.attempted, 2);
  assert.equal(result.summary.completedTraumas, 1);
  assert.equal(result.summary.completedLimbs, 0);
  assert.equal(result.summary.restoredTraumaProgress, 3);
  assert.equal(result.summary.charges, 2);
  assert.equal(result.summary.skipped, 1);
  assert.equal(result.summary.stopped, true);
  assert.deepEqual(result.summary.reasons, ["authoritative failure"]);
});

function createContext({
  traumas = [createTrauma("trauma", 0, 1)],
  limbs = [createLimb("arm", 0, 1)],
  actorType = "character"
} = {}) {
  return {
    name: "Patient",
    actorType,
    traumas,
    limbs
  };
}

function createTrauma(id, healingProgress, healingProgressMax, overrides = {}) {
  return {
    id,
    type: "trauma",
    name: id,
    treatable: true,
    healingProgress,
    healingProgressMax,
    ...overrides
  };
}

function createLimb(id, value, max, overrides = {}) {
  const min = Number(overrides.min ?? 0);
  const healingCap = Number(overrides.healingCap ?? max);
  return {
    id,
    key: id,
    type: "limb",
    name: id,
    value,
    min,
    max,
    healingCap,
    healingProgress: value - min,
    healingProgressMax: Math.max(1, healingCap - min),
    treatable: value < healingCap,
    ...overrides
  };
}

function committedReceipt({
  completed,
  initialProgress,
  finalProgress,
  maxProgress,
  spentCharges = 0,
  targetContext
}) {
  return {
    status: "committed",
    completed: completed ?? finalProgress >= maxProgress,
    initialProgress,
    finalProgress,
    maxProgress,
    spentCharges,
    targetContext
  };
}

function completeTreatment(targetContext, treatmentType, treatmentId) {
  if (treatmentType === "limb") {
    return {
      ...targetContext,
      limbs: targetContext.limbs.map(limb => limb.id === treatmentId
        ? {
            ...limb,
            value: limb.max,
            healingProgress: limb.healingProgressMax,
            treatable: false
          }
        : limb)
    };
  }
  return updateTraumaProgress(
    targetContext,
    treatmentId,
    targetContext.traumas.find(trauma => trauma.id === treatmentId).healingProgressMax
  );
}

function updateTraumaProgress(targetContext, treatmentId, healingProgress) {
  return {
    ...targetContext,
    traumas: targetContext.traumas.map(trauma => trauma.id === treatmentId
      ? { ...trauma, healingProgress }
      : trauma)
  };
}
