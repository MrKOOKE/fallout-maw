import assert from "node:assert/strict";
import test from "node:test";

globalThis.foundry = {
  utils: {
    deepClone: value => structuredClone(value),
    randomID: () => "generated-id"
  }
};

const {
  ABILITY_EVOLUTION_LAYOUT_TOP_DOWN,
  findAbilityInEvolutionFamily,
  getAbilityEvolutionFamilyIds,
  normalizeAbilityEntry,
  prepareAbilityItemData
} = await import("../src/settings/abilities.mjs");

test("legacy left-to-right evolution coordinates migrate once to top-down", () => {
  const legacy = normalizeAbilityEntry({
    id: "root",
    system: {
      evolution: {
        nodes: [{ id: "child", x: 270, y: 0, ability: { id: "child" } }],
        links: [{ fromId: "root", toId: "child" }],
        viewport: { x: -262, y: -93, zoom: 1 }
      }
    }
  });
  assert.equal(legacy.system.evolution.layoutDirection, ABILITY_EVOLUTION_LAYOUT_TOP_DOWN);
  assert.deepEqual(
    { x: legacy.system.evolution.nodes[0].x, y: legacy.system.evolution.nodes[0].y },
    { x: 0, y: 150 }
  );
  assert.deepEqual(legacy.system.evolution.viewport, { x: 0, y: 0, zoom: 1 });

  const normalizedAgain = normalizeAbilityEntry(legacy);
  assert.deepEqual(
    { x: normalizedAgain.system.evolution.nodes[0].x, y: normalizedAgain.system.evolution.nodes[0].y },
    { x: 0, y: 150 }
  );
});

test("evolution nodes keep independent summary and purchased description", () => {
  const normalized = normalizeAbilityEntry({
    id: "root",
    name: "Реактивный",
    description: "Базовое полное описание",
    system: {
      evolution: {
        nodes: [{
          id: "evolved",
          ability: {
            id: "evolved",
            name: "Реактивный II",
            evolutionSummary: "Теперь 4 ОП дают 2 ОД",
            description: "Каждые 4 потраченных ОП дают +2 ОД."
          }
        }],
        links: [{ fromId: "root", toId: "evolved" }]
      }
    }
  });

  const found = findAbilityInEvolutionFamily(normalized, "evolved");
  assert.equal(found.ability.evolutionSummary, "Теперь 4 ОП дают 2 ОД");
  assert.equal(found.ability.description, "Каждые 4 потраченных ОП дают +2 ОД.");
  assert.deepEqual(found.incomingSourceIds, ["root"]);
  assert.deepEqual([...getAbilityEvolutionFamilyIds(normalized)], ["root", "evolved"]);

  const itemData = prepareAbilityItemData(found.ability, {
    categoryId: "athletics",
    evolutionRootId: "root",
    evolutionParentIds: found.incomingSourceIds
  });
  assert.equal(itemData.system.description, "Каждые 4 потраченных ОП дают +2 ОД.");
  assert.equal(Object.hasOwn(itemData.system, "evolution"), false);
  assert.equal(JSON.stringify(itemData).includes("Теперь 4 ОП дают 2 ОД"), false);
});

test("evolution normalization resolves duplicate IDs even with a constant randomID", () => {
  const normalized = normalizeAbilityEntry({
    id: "root",
    system: {
      evolution: {
        nodes: [
          { id: "duplicate", ability: { id: "duplicate" } },
          { id: "duplicate", ability: { id: "duplicate" } },
          { ability: {} },
          { ability: {} }
        ]
      }
    }
  });
  const ids = normalized.system.evolution.nodes.map(node => node.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, ["duplicate", "duplicate-2", "generated-id", "generated-id-2"]);
  assert.deepEqual(ids, normalized.system.evolution.nodes.map(node => node.ability.id));
});

test("evolution graph accepts one parent per node and rejects cycles or links into root", () => {
  const normalized = normalizeAbilityEntry({
    id: "root",
    system: {
      evolution: {
        nodes: [
          { id: "a", ability: { id: "a" } },
          { id: "b", ability: { id: "b" } }
        ],
        links: [
          { id: "root-a", fromId: "root", toId: "a" },
          { id: "b-a-second-parent", fromId: "b", toId: "a" },
          { id: "a-b", fromId: "a", toId: "b" },
          { id: "b-root", fromId: "b", toId: "root" },
          { id: "b-a-cycle", fromId: "b", toId: "a" }
        ]
      }
    }
  });
  assert.deepEqual(
    normalized.system.evolution.links.map(link => [link.fromId, link.toId]),
    [["root", "a"], ["a", "b"]]
  );
});

test("disabled fixed functions stay in the catalog but never enter actor runtime snapshots", () => {
  const ability = normalizeAbilityEntry({
    id: "disabled-base",
    system: {
      functions: [{
        id: "reactive-function",
        type: "fixed",
        enabled: false,
        fixedKey: "reactive",
        fixedSettings: { movementPointsPerActionPoint: 4 }
      }]
    }
  });
  assert.equal(ability.system.functions[0].enabled, false);
  assert.deepEqual(prepareAbilityItemData(ability).system.functions, []);
});
