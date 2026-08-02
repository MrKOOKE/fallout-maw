import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CREATURE_ACTOR_SPECS,
  validateCreatureActorCatalog
} from "../scripts/rebalance/creature-actor-catalog.mjs";

const SYSTEM_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("every concrete non-human subtype has a physical Actor and combat roles may add distinct Actors", () => {
  const summary = validateCreatureActorCatalog();
  assert.equal(summary.actorCount, 90);
  assert.equal(summary.existingActorCount, 8);
  assert.equal(CREATURE_ACTOR_SPECS.some(spec => spec.raceKey === "human"), false);
  assert.equal(CREATURE_ACTOR_SPECS.some(spec => spec.tags.includes("robot")), false);
  assert.equal(CREATURE_ACTOR_SPECS.filter(spec => spec.raceKey === "super-mutant").length, 15);
  assert.ok(CREATURE_ACTOR_SPECS.some(spec => spec.key === "super-mutant:ordinary" && spec.name === "Супермутант"));
  const wolf = CREATURE_ACTOR_SPECS.find(spec => spec.key === "canine:wolf");
  const ordinarySuperMutant = CREATURE_ACTOR_SPECS.find(spec => spec.key === "super-mutant:ordinary");
  assert.deepEqual([wolf.threatClass, wolf.level], ["C", 12]);
  assert.deepEqual([ordinarySuperMutant.threatClass, ordinarySuperMutant.level], ["C", 14]);
});

test("all configured Actor portraits exist and subtype imagery stays separated", () => {
  for (const spec of CREATURE_ACTOR_SPECS) {
    assert.equal(spec.images.length, 1, `${spec.key}: only its base portrait belongs in the generator`);
    for (const image of spec.images) {
      assert.equal(image.startsWith("systems/fallout-maw/"), true, `${spec.key}: invalid image root`);
      const relative = image.slice("systems/fallout-maw/".length).replaceAll("/", path.sep);
      assert.equal(fs.existsSync(path.join(SYSTEM_ROOT, relative)), true, `${spec.key}: missing ${image}`);
    }
  }
  const ordinaryDeathclaw = CREATURE_ACTOR_SPECS.find(spec => spec.key === "deathclaw:ordinary");
  assert.equal(ordinaryDeathclaw.images.some(image => image.includes("ohotnik")), false);
  assert.equal(CREATURE_ACTOR_SPECS.find(spec => spec.key === "radroach:ordinary").images.length, 1);
  assert.equal(CREATURE_ACTOR_SPECS.find(spec => spec.key === "rodent:mole-rat").images.length, 1);
});
