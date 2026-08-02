import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyCreatureActorConfiguration,
  buildCreatureActorDocument,
  buildCreatureActorFolderDocuments,
  buildCreatureDevelopmentPackage,
  buildCreatureGeneratorBlocks,
  buildCreaturePersonalGenerator,
  buildExpandedCreatureOptions,
  buildGeneratedNaturalArmorSpec,
  buildNaturalArmorItem,
  deterministicWorldId,
  estimateCreatureCombatProfile,
  validateExpandedCreatureOptions
} from "../scripts/rebalance/apply-creature-fauna.mjs";
import {
  CREATURE_RACE_SPECS,
  CREATURE_TYPE_SPECS,
  NATURAL_WEAPON_STOCK_IMG,
  RETIRED_ROBOT_CREATURE_RACE_IDS,
  RETIRED_ROBOT_CREATURE_TYPE_IDS,
  resolveCreatureCatalogStorageId
} from "../scripts/rebalance/creature-fauna-catalog.mjs";
import {
  CREATURE_DAMAGE_TYPES,
  CREATURE_LIMB_KEYS,
  NATURAL_ARMOR_SPECS
} from "../scripts/rebalance/creature-natural-armor-catalog.mjs";
import { CREATURE_ACTOR_SPECS } from "../scripts/rebalance/creature-actor-catalog.mjs";
import { DEFAULT_CHARACTERISTICS } from "../src/config/defaults.mjs";
import { evaluateFormula } from "../src/formulas/index.mjs";
import { planInventoryRepair } from "../src/inventory/repair.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_ROOT = path.resolve(TEST_DIR, "..");
const preset = JSON.parse(await fs.readFile(
  path.join(SYSTEM_ROOT, "storage", "settings-presets", "fallout-maw.json"),
  "utf8"
));
const currentOptions = preset.settings.find(entry => entry.id === "fallout-maw.creatureOptions")?.value;

test("creature settings preserve an explicit absence of ordinary weapon slots", async () => {
  globalThis.foundry ??= {
    applications: {
      api: { DialogV2: class {} },
      ux: { FormDataExtended: class {} },
      handlebars: { renderTemplate: async () => "" }
    },
    documents: { modifyBatch: async () => [] },
    utils: {
      deepClone: value => structuredClone(value),
      randomID: () => "testNaturalItem1",
      mergeObject: (original, other) => ({ ...original, ...other }),
      setProperty: (object, path, value) => {
        const parts = String(path).split(".");
        const last = parts.pop();
        let target = object;
        for (const part of parts) target = target[part] ??= {};
        target[last] = value;
        return true;
      },
      unsetProperty: (object, path) => {
        const parts = String(path).split(".");
        const last = parts.pop();
        const target = parts.reduce((value, part) => value?.[part], object);
        return target ? delete target[last] : false;
      }
    }
  };
  const { normalizeCreatureOptions } = await import("../src/settings/creature-options.mjs");
  const baseRace = {
    id: "beast",
    typeId: "animal",
    name: "Beast",
    limbs: [{ key: "head", label: "Head" }]
  };
  const normalizeRace = race => normalizeCreatureOptions({
    types: [{ id: "animal", name: "Animal" }],
    races: [race]
  }).races[0];

  assert.deepEqual(normalizeRace({ ...baseRace, weaponSets: [] }).weaponSets, []);
  assert.deepEqual(
    normalizeRace({
      ...baseRace,
      weaponSets: [{ key: "empty", label: "Empty", slots: [] }]
    }).weaponSets,
    [{ key: "empty", label: "Empty", slots: [] }]
  );
  assert.ok(normalizeRace(baseRace).weaponSets.length > 0);
});

test("expanded creature options preserve anchors and contain the complete practical catalog", () => {
  const expanded = buildExpandedCreatureOptions(currentOptions);
  const summary = validateExpandedCreatureOptions(expanded);
  const expectedSubtypeCount = CREATURE_RACE_SPECS.reduce((sum, race) => sum + race.subtypes.length, 0);
  const expectedAttackCount = CREATURE_RACE_SPECS.reduce(
    (sum, race) => sum + race.subtypes.reduce((subtotal, subtype) => subtotal + subtype.naturalAttacks.length, 0),
    0
  );

  assert.equal(summary.typeCount, CREATURE_TYPE_SPECS.length);
  assert.equal(summary.raceCount, CREATURE_RACE_SPECS.length);
  assert.equal(summary.attackCount, expectedAttackCount);
  assert.equal(expanded.races.reduce((sum, race) => sum + race.naturalItemSets.length, 0), expectedSubtypeCount);
  assert.ok(expanded.types.some(type => type.id === "MIZppvewG3PKNEhG"));
  assert.ok(expanded.races.some(race => race.id === "newRace3"));
  assert.ok(CREATURE_RACE_SPECS
    .filter(spec => !spec.legacyId)
    .every(spec => expanded.races.find(race => race.id === spec.id)?.limbSilhouette === null));
  assert.ok(expanded.races.filter(race => {
    const floraType = CREATURE_TYPE_SPECS.find(type => type.key === "flora");
    return race.typeId === resolveCreatureCatalogStorageId(floraType);
  }).length >= 4);
  assert.ok(RETIRED_ROBOT_CREATURE_TYPE_IDS.every(id => !expanded.types.some(type => type.id === id)));
  assert.ok(RETIRED_ROBOT_CREATURE_RACE_IDS.every(id => !expanded.races.some(race => race.id === id)));
  assert.equal(expanded.races.some(race => RETIRED_ROBOT_CREATURE_TYPE_IDS.includes(race.typeId)), false);

  for (const race of expanded.races) {
    for (const subtype of race.naturalItemSets) {
      for (const attack of subtype.naturalWeapons) {
        const system = attack.item.system;
        assert.equal(attack.item.type, "gear");
        assert.equal(attack.item.img, NATURAL_WEAPON_STOCK_IMG);
        assert.equal(system.description, "");
        assert.equal(system.functions.weapon.enabled, true);
        assert.equal(system.placement.mode, "weapon");
        assert.equal(system.placement.weaponSet, "naturalRaceWeapons");
        assert.equal(system.placement.weaponSlot, attack.id);
        assert.equal(system.equipped, false);
        assert.equal(system.weight, 0);
      }
    }
  }

  const humanSlotLabels = expanded.races
    .find(race => race.id === resolveCreatureCatalogStorageId(CREATURE_RACE_SPECS.find(spec => spec.key === "human")))
    ?.equipmentSlots.map(slot => slot.label);
  const humanLimbs = expanded.races
    .find(race => race.id === resolveCreatureCatalogStorageId(CREATURE_RACE_SPECS.find(spec => spec.key === "human")))
    ?.limbs.map(limb => ({ key: limb.key, label: limb.label }));
  const humanWeaponSets = expanded.races
    .find(race => race.id === resolveCreatureCatalogStorageId(CREATURE_RACE_SPECS.find(spec => spec.key === "human")))
    ?.weaponSets;
  for (const spec of CREATURE_RACE_SPECS) {
    const race = expanded.races.find(entry => entry.id === resolveCreatureCatalogStorageId(spec));
    if (["human", "ghoul", "super-mutant", "zetan"].includes(spec.key)) {
      assert.deepEqual(race.equipmentSlots.map(slot => slot.label), humanSlotLabels);
      assert.deepEqual(race.limbs.map(limb => ({ key: limb.key, label: limb.label })), humanLimbs);
      assert.deepEqual(race.weaponSets, humanWeaponSets);
    } else {
      assert.deepEqual(race.equipmentSlots, [{ key: "back", label: "\u0421\u043f\u0438\u043d\u0430" }]);
      assert.deepEqual(race.weaponSets, []);
    }
  }
});

test("actor-specific natural armor is locked, equipped and complete on every limb", () => {
  const donor = {
    _id: "donorArmor000001",
    name: "Donor",
    type: "gear",
    img: "icons/svg/shield.svg",
    system: {
      functions: {
        condition: { enabled: true, value: 10, max: 10 },
        damageMitigation: { enabled: false, mode: "defense", limbSetIds: [], entries: {} },
        weapon: { enabled: false },
        damageSource: { enabled: false }
      }
    },
    flags: {},
    effects: []
  };

  for (const spec of NATURAL_ARMOR_SPECS) {
    const item = buildNaturalArmorItem(donor, spec, { img: spec.images[0] });
    assert.equal(item._id, deterministicWorldId(`natural-armor:${spec.actorId}`));
    assert.equal(item.system.locked, true);
    assert.equal(item.system.equipped, true);
    assert.equal(item.system.description, "");
    assert.equal(item.system.weight, 0);
    assert.equal(item.system.placement.mode, "equipment");
    assert.equal(item.system.functions.condition.enabled, false);
    assert.equal(item.system.functions.damageMitigation.enabled, true);
    assert.equal(item.system.functions.damageMitigation.mode, "defense");
    assert.deepEqual(item.system.functions.damageMitigation.requirements, []);
    assert.deepEqual(Object.keys(item.system.functions.damageMitigation.entries).sort(), [...CREATURE_LIMB_KEYS].sort());
    assert.deepEqual(
      planInventoryRepair([item], { columns: 1, rows: 1 }, {
        isNonInventoryPlacementValid: () => true
      }).updates,
      [],
      `${spec.name}: repair must preserve a valid equipped lock`
    );
    for (const limbKey of CREATURE_LIMB_KEYS) {
      assert.deepEqual(
        Object.keys(item.system.functions.damageMitigation.entries[limbKey]).sort(),
        [...CREATURE_DAMAGE_TYPES].sort()
      );
    }
  }
});

test("creature generators use multiple mandatory small-variation blocks and only the base portrait", () => {
  const expanded = buildExpandedCreatureOptions(currentOptions);
  const actorSpec = CREATURE_ACTOR_SPECS.find(spec => spec.key === "spore-plant:ordinary");
  const raceSpec = CREATURE_RACE_SPECS.find(spec => spec.key === actorSpec.raceKey);
  const configuredRace = expanded.races.find(race => race.id === resolveCreatureCatalogStorageId(raceSpec));
  const armorSpec = buildGeneratedNaturalArmorSpec(actorSpec, configuredRace);
  const config = buildCreaturePersonalGenerator({
    enabled: true,
    name: { enabled: true },
    images: { enabled: true, paths: ["wrong/alternate.webp"] },
    items: {
      enabled: true,
      blocks: [{
        id: deterministicWorldId("personal-generator:creature-deviations"),
        name: "Телесные девиации",
        pick: "0-1",
        entries: []
      }]
    }
  }, armorSpec, actorSpec);

  assert.equal(config.name.enabled, false);
  assert.equal(config.images.enabled, false);
  assert.deepEqual(config.images.paths, actorSpec.images);
  assert.equal(config.items.blocks.some(block => block.name === "Телесные девиации"), false);
  assert.ok(config.items.blocks.length >= 7);
  assert.ok(config.items.blocks.some(block => block.name === "Ближний бой"));
  assert.ok(config.items.blocks.some(block => block.name === "Дальний бой"));
  assert.ok(config.items.blocks.some(block => block.name === "Скрытность"));
  for (const block of config.items.blocks) {
    assert.equal(block.pick, "1");
    assert.equal(block.pickMode, "count");
    assert.ok(block.entries.length > 0);
    for (const entry of block.entries) assert.match(entry.uuid, /^Item\.[A-Za-z0-9]{16}$/u);
  }
});

test("every generated creature has a calculated attack profile that can hit peer dodge", () => {
  const checks = CREATURE_ACTOR_SPECS
    .filter(spec => !spec.preserveGenerator)
    .flatMap(spec => {
      const profile = estimateCreatureCombatProfile(spec);
      const blocks = buildCreatureGeneratorBlocks(spec);
      assert.ok(blocks.every(block => block.pick === "1" && block.entries.length > 0), spec.key);
      return Object.entries(profile.attackChances).map(([skillKey, chance]) => ({ spec: spec.key, skillKey, chance }));
    });
  assert.ok(checks.length > CREATURE_ACTOR_SPECS.length);
  assert.ok(checks.every(entry => entry.chance >= 55), JSON.stringify(checks.filter(entry => entry.chance < 55)));
});

test("creatures use direct NPC stat blocks instead of the player 33-point creation pool", () => {
  const characteristicTotals = new Set();
  for (const spec of CREATURE_ACTOR_SPECS) {
    const plan = buildCreatureDevelopmentPackage(spec);
    assert.equal(plan.development.initialized, true, spec.key);
    assert.equal(plan.development.points.characteristics, 0, spec.key);
    assert.equal(
      Object.values(plan.development.characteristics).reduce((sum, value) => sum + value, 0),
      0,
      spec.key
    );
    characteristicTotals.add(Object.values(plan.characteristics).reduce((sum, value) => sum + value, 0));
    assert.ok(
      Object.values(plan.proficiencies).reduce((sum, entry) => sum + Number(entry?.value || 0), 0) > 0,
      spec.key
    );
    assert.ok(
      Object.keys(plan.skills).some(skillKey => (
        Number(plan.skills?.[skillKey]?.bonus || 0)
        + Number(plan.generatorSkillBonuses?.[skillKey] || 0)
      ) > 0),
      spec.key
    );
  }
  assert.ok(characteristicTotals.size > 20);

  const deathclaw = buildCreatureDevelopmentPackage(
    CREATURE_ACTOR_SPECS.find(spec => spec.key === "deathclaw:ordinary")
  );
  assert.deepEqual(deathclaw.characteristics, {
    strength: 40,
    dexterity: 30,
    endurance: 50,
    perception: 24,
    intelligence: 16,
    charisma: 10,
    luck: 10
  });
});

test("race anatomy formulas produce distinct health scales and armor has weak zones", () => {
  const expanded = buildExpandedCreatureOptions(currentOptions);
  const totalHealth = actorKey => {
    const actorSpec = CREATURE_ACTOR_SPECS.find(entry => entry.key === actorKey);
    const raceSpec = CREATURE_RACE_SPECS.find(entry => entry.key === actorSpec.raceKey);
    const configuredRace = expanded.races.find(entry => entry.id === resolveCreatureCatalogStorageId(raceSpec));
    const characteristics = estimateCreatureCombatProfile(actorSpec).characteristics;
    return configuredRace.limbs.reduce((sum, limb) => sum + evaluateFormula(limb.stateMax, {
      characteristicSettings: DEFAULT_CHARACTERISTICS,
      characteristics
    }), 0);
  };

  assert.ok(totalHealth("rodent:rat") < totalHealth("canine:wolf"));
  assert.ok(totalHealth("canine:wolf") < totalHealth("deathclaw:ordinary"));

  for (const actorSpec of CREATURE_ACTOR_SPECS) {
    const raceSpec = CREATURE_RACE_SPECS.find(entry => entry.key === actorSpec.raceKey);
    const configuredRace = expanded.races.find(entry => entry.id === resolveCreatureCatalogStorageId(raceSpec));
    const armor = buildGeneratedNaturalArmorSpec(actorSpec, configuredRace);
    const firearmValues = Object.values(armor.profile).map(entry => Number(entry?.firearm) || 0);
    assert.ok(Math.min(...firearmValues) < Math.max(...firearmValues), actorSpec.key);
  }
});

test("creature assignment changes taxonomy and generator only, leaving current and maximum health untouched", () => {
  const armorSpec = NATURAL_ARMOR_SPECS.find(spec => spec.actorId === "WRH3J5n3KRdVV71A");
  const expanded = buildExpandedCreatureOptions(currentOptions);
  const actor = {
    _id: armorSpec.actorId,
    name: "Светящийся гуль",
    system: {
      creature: { typeId: "newType", raceId: "newRace", subtypeId: "naturalSet" },
      resources: { health: { value: 137, max: 211 } }
    },
    flags: { "fallout-maw": { personalGenerator: { enabled: true, items: { blocks: [] } } } }
  };
  const result = applyCreatureActorConfiguration(actor, armorSpec, expanded);
  const ghoul = CREATURE_RACE_SPECS.find(spec => spec.key === "ghoul");
  const glowing = ghoul.subtypes.find(spec => spec.key === "glowing");

  assert.deepEqual(result.system.resources.health, { value: 137, max: 211 });
  assert.equal(result.system.creature.raceId, resolveCreatureCatalogStorageId(ghoul));
  assert.equal(result.system.creature.subtypeId, resolveCreatureCatalogStorageId(glowing));
});

test("systematic Actor folders keep deathclaws under mutants and robots under constructs", () => {
  const plan = buildCreatureActorFolderDocuments({ flags: {}, _stats: {} });
  assert.equal(Object.keys(plan.typeFolderIds).length, CREATURE_TYPE_SPECS.length);
  assert.equal(Object.keys(plan.familyFolderIds).length, CREATURE_RACE_SPECS.length - 1);
  assert.equal(Object.keys(plan.constructFolderIds).length, 6);

  const ghoulFolder = plan.documents.find(entry => entry._id === plan.familyFolderIds.ghoul);
  const deathclawFolder = plan.documents.find(entry => entry._id === plan.familyFolderIds.deathclaw);
  assert.equal(ghoulFolder.folder, plan.typeFolderIds.humanoid);
  assert.equal(deathclawFolder.folder, plan.typeFolderIds.mutant);
  for (const folderId of Object.values(plan.constructFolderIds)) {
    assert.equal(plan.documents.find(entry => entry._id === folderId).folder, "8t9v8aE9Ed6ZsCf8");
  }
});

test("new creature Actor records are complete while natural weapons remain subtype-managed", () => {
  const expanded = buildExpandedCreatureOptions(currentOptions);
  const actorSpec = CREATURE_ACTOR_SPECS.find(spec => spec.key === "parasite:ordinary");
  const raceSpec = CREATURE_RACE_SPECS.find(spec => spec.key === actorSpec.raceKey);
  const configuredRace = expanded.races.find(race => race.id === resolveCreatureCatalogStorageId(raceSpec));
  const armorSpec = buildGeneratedNaturalArmorSpec(actorSpec, configuredRace);
  const donor = {
    _id: "donorActor000001",
    name: "Donor",
    type: "character",
    img: "icons/svg/mystery-man.svg",
    folder: null,
    items: ["donorItem000001"],
    effects: ["donorEffect0001"],
    flags: { "fallout-maw": { actorMigration: { oldId: "old" } } },
    ownership: { default: 0 },
    prototypeToken: { actorLink: true, texture: { src: "icons/svg/mystery-man.svg", scaleX: 1, scaleY: 1 } },
    system: {
      description: "",
      attributes: { level: 1, initiativeBonus: 3 },
      creature: { typeId: "", raceId: "", subtypeId: "" },
      characteristics: { strength: 2, dexterity: 4, endurance: 3, perception: 3, intelligence: 0, charisma: 0, luck: 2 },
      resources: { health: { min: 0, spent: 4, bonus: 3, value: 137, max: 211 } },
      needs: { hunger: { min: 0, spent: 0, bonus: 0, value: 470, max: 1000 } },
      limbs: { head: { missing: true, maxBonus: 3, spent: 5, value: 20, damageAccumulation: { fire: 4 } } },
      currencies: { caps: 10 },
      skills: { meleeCombat: { bonus: 20 } },
      researches: [{ id: "donor" }],
      proficiencies: { natural: { min: 0, spent: 0, bonus: 0, value: 0, max: 1000 } },
      development: { initialized: true }
    }
  };
  const actor = buildCreatureActorDocument(donor, actorSpec, expanded, "familyFolder0001", armorSpec);
  assert.equal(actor._id, actorSpec.actorId);
  assert.equal(actor.prototypeToken.actorLink, false);
  assert.deepEqual(actor.items, []);
  assert.deepEqual(actor.effects, []);
  assert.equal(actor.system.resources.health.value, 137);
  assert.equal(actor.system.resources.health.max, 211);
  assert.equal(actor.system.resources.health.spent, 0);
  assert.equal(actor.system.limbs.head.spent, 0);
  assert.equal(actor.system.limbs.head.missing, false);
  assert.equal(actor.flags["fallout-maw"].naturalRaceItem, undefined);
  assert.equal(actor.system.creature.raceId, resolveCreatureCatalogStorageId(raceSpec));
  assert.equal(actor.system.development.initialized, true);
  assert.equal(
    Object.values(actor.system.development.characteristics).reduce((sum, value) => sum + value, 0),
    0
  );
  assert.ok(Object.values(actor.system.skills).some(entry => Number(entry?.bonus) > 0));
});
