import assert from "node:assert/strict";
import test from "node:test";

globalThis.foundry = {
  utils: {
    deepClone: value => structuredClone(value),
    mergeObject(original, other) {
      return mergeRecords(structuredClone(original), other);
    }
  }
};

const {
  DEFAULT_COMBAT_SETTINGS,
  LIMB_DESTRUCTION_MODES,
  canActorLimbBeAutomaticallyDestroyed,
  createDefaultCombatSettings,
  getActorLimbDestructionMode,
  normalizeCombatSettings
} = await import("../src/settings/combat.mjs");

const EXPECTED_DEFAULTS = Object.freeze({
  nonPlayerMode: LIMB_DESTRUCTION_MODES.standard,
  playerOwnedMode: LIMB_DESTRUCTION_MODES.standard
});

test("combat settings default both actor ownership groups to standard limb destruction", () => {
  assert.deepEqual(DEFAULT_COMBAT_SETTINGS.limbDestruction, EXPECTED_DEFAULTS);
  assert.deepEqual(createDefaultCombatSettings().limbDestruction, EXPECTED_DEFAULTS);
  assert.deepEqual(normalizeCombatSettings({}).limbDestruction, EXPECTED_DEFAULTS);
});

test("combat settings normalize limb destruction modes independently", () => {
  assert.deepEqual(normalizeCombatSettings({
    limbDestruction: {
      nonPlayerMode: LIMB_DESTRUCTION_MODES.nonCriticalOnly,
      playerOwnedMode: LIMB_DESTRUCTION_MODES.disabled
    }
  }).limbDestruction, {
    nonPlayerMode: LIMB_DESTRUCTION_MODES.nonCriticalOnly,
    playerOwnedMode: LIMB_DESTRUCTION_MODES.disabled
  });

  assert.deepEqual(normalizeCombatSettings({
    limbDestruction: {
      nonPlayerMode: "unknown-mode",
      playerOwnedMode: null
    }
  }).limbDestruction, EXPECTED_DEFAULTS);

  assert.deepEqual(normalizeCombatSettings({
    limbDestruction: {
      nonPlayerMode: " disabled ",
      playerOwnedMode: " nonCriticalOnly "
    }
  }).limbDestruction, {
    nonPlayerMode: LIMB_DESTRUCTION_MODES.disabled,
    playerOwnedMode: LIMB_DESTRUCTION_MODES.nonCriticalOnly
  });
});

const EXPECTED_DESTRUCTION = Object.freeze({
  [LIMB_DESTRUCTION_MODES.standard]: Object.freeze({
    nonCritical: true,
    critical: true
  }),
  [LIMB_DESTRUCTION_MODES.nonCriticalOnly]: Object.freeze({
    nonCritical: true,
    critical: false
  }),
  [LIMB_DESTRUCTION_MODES.disabled]: Object.freeze({
    nonCritical: false,
    critical: false
  })
});

for (const ownership of [
  { label: "non-player actor", hasPlayerOwner: false, settingKey: "nonPlayerMode" },
  { label: "player-owned actor", hasPlayerOwner: true, settingKey: "playerOwnedMode" }
]) {
  for (const mode of Object.values(LIMB_DESTRUCTION_MODES)) {
    test(`${ownership.label} uses ${mode} limb destruction for critical and non-critical limbs`, () => {
      const otherSettingKey = ownership.settingKey === "playerOwnedMode"
        ? "nonPlayerMode"
        : "playerOwnedMode";
      const settings = {
        limbDestruction: {
          [ownership.settingKey]: mode,
          [otherSettingKey]: mode === LIMB_DESTRUCTION_MODES.disabled
            ? LIMB_DESTRUCTION_MODES.standard
            : LIMB_DESTRUCTION_MODES.disabled
        }
      };
      const actor = { hasPlayerOwner: ownership.hasPlayerOwner };

      assert.equal(getActorLimbDestructionMode(actor, settings), mode);
      assert.equal(
        canActorLimbBeAutomaticallyDestroyed(actor, { critical: false }, settings),
        EXPECTED_DESTRUCTION[mode].nonCritical
      );
      assert.equal(
        canActorLimbBeAutomaticallyDestroyed(actor, { critical: true }, settings),
        EXPECTED_DESTRUCTION[mode].critical
      );
    });
  }
}

function mergeRecords(target, source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return target;
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const base = target[key] && typeof target[key] === "object" && !Array.isArray(target[key])
        ? target[key]
        : {};
      target[key] = mergeRecords(base, value);
    } else {
      target[key] = structuredClone(value);
    }
  }
  return target;
}
