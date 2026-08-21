import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ABILITY_FIXED_FUNCTION_KEYS,
  ABILITY_FUNCTION_TYPES,
  normalizeCorrespondingToolApproachSettings
} from "../src/settings/abilities.mjs";
import { createCorrespondingToolApproachResolver } from "../src/abilities/corresponding-tool-approach.mjs";
import {
  applyToolWorkflowEfficiencyBonus,
  createToolWorkflowModifierResolver,
  registerToolWorkflowModifierProvider
} from "../src/utils/tool-workflow-modifiers.mjs";

test("corresponding tool approach defaults match the fixed ability design", () => {
  assert.deepEqual(normalizeCorrespondingToolApproachSettings(), {
    skillBonus: 20,
    repairEfficiencyPercentBonus: 20
  });
  assert.deepEqual(normalizeCorrespondingToolApproachSettings({
    skillBonus: -1,
    repairEfficiencyPercentBonus: -1
  }), {
    skillBonus: 0,
    repairEfficiencyPercentBonus: 0
  });
});

test("corresponding tool approach applies only to matching workflows with the exact required class", () => {
  const resolve = createCorrespondingToolApproachResolver(createActorWithAbility());

  assert.deepEqual(resolve(toolContext({ requester: "hacking", skillKey: "lockpicking" })), [{
    source: `${ABILITY_FIXED_FUNCTION_KEYS.correspondingToolApproach}:ability:function`,
    label: "Всему свой подход",
    skillBonus: 20
  }]);
  assert.equal(resolve(toolContext({ requester: "hacking", skillKey: "repair" })), null);
  assert.equal(resolve(toolContext({ requester: "hacking", skillKey: "lockpicking", toolClass: "D" })), null);
  assert.equal(resolve(toolContext({ requester: "hacking", skillKey: "lockpicking", toolClass: "A" })), null);

  assert.equal(resolve(toolContext({ requester: "trapDisarm", skillKey: "traps" }))[0].skillBonus, 20);
  assert.equal(resolve(toolContext({ requester: "repair", skillKey: "repair" }))[0].efficiencyPercentBonus, 20);
  assert.equal(resolve(toolContext({ requester: "craft", skillKey: "repair" })), null);
});

test("tool workflow providers compile actor state once for repeated resolutions", () => {
  let prepared = 0;
  const unregister = registerToolWorkflowModifierProvider("test:compile-once", actor => {
    prepared += 1;
    const value = Number(actor?.bonus) || 0;
    return context => context.requester === "repair" ? { skillBonus: value } : null;
  });

  try {
    const resolve = createToolWorkflowModifierResolver({ bonus: 7 });
    assert.equal(resolve({ requester: "repair" }).skillBonus, 7);
    assert.equal(resolve({ requester: "repair" }).skillBonus, 7);
    assert.equal(prepared, 1);
  } finally {
    unregister();
  }
});

test("repair efficiency bonus uses additive percentage points", () => {
  assert.equal(applyToolWorkflowEfficiencyBonus(100, 20), 120);
  assert.equal(applyToolWorkflowEfficiencyBonus(150, 20), 170);
  assert.equal(applyToolWorkflowEfficiencyBonus(10, -20), 0);
});

test("fixed ability is wired through selection, skill contexts, repair authority and both editors", async () => {
  const [fixed, skill, hacking, traps, repair, itemTemplate, catalogTemplate] = await Promise.all([
    readFile(new URL("../src/abilities/fixed-functions.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/rolls/skill-check.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/apps/hacking-dialog.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/canvas/traps.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/apps/repair-dialog.mjs", import.meta.url), "utf8"),
    readFile(new URL("../templates/item/item-sheet.hbs", import.meta.url), "utf8"),
    readFile(new URL("../templates/settings/ability-catalog-item-editor.hbs", import.meta.url), "utf8")
  ]);

  assert.match(fixed, /key:\s*ABILITY_FIXED_FUNCTION_KEYS\.correspondingToolApproach/);
  assert.match(fixed, /registerToolWorkflowModifierProvider\(/);
  assert.match(skill, /resolveToolWorkflowModifiers\(actor, context\)/);
  assert.match(hacking, /skillKey:\s*"lockpicking"[\s\S]*?toolContext:/);
  assert.match(traps, /requester:\s*"trapDisarm"[\s\S]*?toolContext:|toolContext:[\s\S]*?requester:\s*"trapDisarm"/);
  assert.match(repair, /efficiencyPercentBonus:\s*toolWorkflowModifiers\.efficiencyPercentBonus/);
  assert.match(repair, /toolWorkflowModifiers:\s*\{[\s\S]*?efficiencyPercentBonus/);
  assert.match(itemTemplate, /fixedCorrespondingToolApproachSettings/);
  assert.match(catalogTemplate, /fixed\.correspondingToolApproach\.repairEfficiencyPercentBonus/);
});

function createActorWithAbility() {
  return {
    items: [{
      id: "ability",
      name: "Всему свой подход",
      type: "ability",
      system: {
        functions: [{
          id: "function",
          type: ABILITY_FUNCTION_TYPES.fixed,
          fixedKey: ABILITY_FIXED_FUNCTION_KEYS.correspondingToolApproach,
          fixedSettings: {}
        }]
      }
    }]
  };
}

function toolContext({ requester, skillKey, toolClass = "B", requiredClass = "B" } = {}) {
  return {
    requester,
    skillKey,
    toolContext: {
      toolKey: "repair",
      toolClass,
      requiredClass
    }
  };
}
