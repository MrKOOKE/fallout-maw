import { SYSTEM_ID } from "../constants.mjs";
import { ensureModularTankDemoAnatomy, prepareModularTankDemoCharacter, repairEmptyModularTankDemoCharacter } from "./modular-tank-demo-anatomy.mjs";
import { isActorInActorContainer } from "../utils/actor-containers.mjs";
import { getDamageTypeSettings } from "../settings/accessors.mjs";
import { ensureModularTankLibrary, replaceTankReferences } from "./modular-tank-library.mjs";
import { planModularTankProductionUpgrade, migrateTankVisualTrackReferences, consolidateTankChassisVisual } from "./modular-tank-production-upgrade.mjs";
import { planModularTankGunUpgrade } from "./modular-tank-gun-upgrade.mjs";
import { planModularTankSystemUpgrade } from "./modular-tank-systems-upgrade.mjs";
import { validateActorInventoryState } from "../inventory/mutation.mjs";
import { INVENTORY_ATOMIC_OPTION, INVENTORY_EXPECTED_IDS_OPTION } from "../inventory/constants.mjs";
import { BATCH_EXPECTED_IDS_OPTION } from "../utils/document-batch-integrity.mjs";

import { planTankTokenFootprint } from "./modular-tank-token-footprint.mjs";

export const MODULAR_TANK_DEMO_PACKAGE_ID = "fallout-heavy-tank-modular-v1";
export const MODULAR_TANK_DEMO_BLUEPRINT_URL = "systems/fallout-maw/assets/examples/modular-tank.json";

/** Create portable actors; a testing scene is an explicit, separate option.
 * Repeated calls preserve edits and add missing sample features once.
 * Boarding remains a gameplay action.
 */
export async function createModularTankDemo({ scene = null, createScene = false, populateCrew = false, createTarget = false, blueprint = null } = {}) {
  if (!globalThis.game?.user?.isGM) throw new Error("Создать танк может только ведущий.");
  const data = blueprint ?? await loadBlueprint();
  validateBlueprint(data);
  const created = [];
  try {
    const library = await ensureModularTankLibrary(data, { created });
    const { shell } = library;
    const demoRace = populateCrew || createTarget ? await ensureModularTankDemoAnatomy() : null;
    const source = completeSampleHullProtection(linkTankPrototypes(replaceTankReferences(data.tank,
      new Map([[data.shellUuidPlaceholder, shell.uuid], [data.fuelUuidPlaceholder, library.fuel?.uuid]])), library));
    let tank = findMarked(game.actors, "tank");
    if (!tank) {
      const tankSource = markSource(source, "tank", data.revision);
      if (library.actorFolder) tankSource.folder = library.actorFolder.id;
      tank = await Actor.create(tankSource, { keepEmbeddedIds: true });
      created.push(tank);
    } else {
      const upgrade = await upgradeTankConfiguration(tank, data, library);
      if (upgrade.updated && Number(data.revision) < 5) await renameLegacyTankTokens(tank, data);
      if (upgrade.updated && Number(data.revision) >= 5) await enableTankTokenAutoRotation(tank);
    }
    let sandbox = null;
    if (createScene) {
      sandbox = typeof scene === "string" ? game.scenes.get(scene) : scene;
      if (scene && !sandbox) throw new Error("Указанная сцена не найдена.");
      if (!sandbox) sandbox = findMarked(game.scenes, "scene");
      if (!sandbox) {
        sandbox = await Scene.create(markSource(data.scene, "scene", data.revision));
        created.push(sandbox);
      }
    }
    const actors = populateCrew ? await ensureCrew(data, demoRace, created, library) : [];
    let target = null;
    if (createTarget) {
      target = findMarked(game.actors, "target");
      if (!target) {
        target = await Actor.create(markSource(prepareModularTankDemoCharacter(data.target, demoRace), "target", data.revision));
        created.push(target);
      } else await repairEmptyModularTankDemoCharacter(target, demoRace);
    }
    const tokens = [];
    if (sandbox) {
      tokens.push(await ensureToken(sandbox, tank, "tank", { x: 500, y: 500 }, created));
      for (let index = 0; index < actors.length; index++) {
        const { actor, kind } = actors[index];
        if (isActorInActorContainer(actor)) continue;
        tokens.push(await ensureToken(sandbox, actor, kind, { x: 500 + index * 120, y: 1250 }, created));
      }
      if (target) tokens.push(await ensureToken(sandbox, target, "target", { x: 1600, y: 800 }, created));
    }
    return { tank, shell, library: library.documents, scene: sandbox, crew: actors.map(row => row.actor), target, tokens,
      created: created.map(document => document.uuid), instructions: [...data.testInstructions] };
  } catch (error) {
    const rollbackErrors = [];
    for (const document of created.reverse()) {
      try { await document.delete(); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (rollbackErrors.length) console.error(`${SYSTEM_ID} | Modular tank rollback failed`, rollbackErrors);
    throw error;
  }
}

/** Add the new sample configuration to a marked tank without resetting its
 * components, damage, ammunition, crew occupancy or customized settings.
 * A revision prevents later reinstalls from resurrecting deliberately removed features.
 */
export async function upgradeTankDemo({ actor = null, populateCrew = false, blueprint = null } = {}) {
  if (!globalThis.game?.user?.isGM) throw new Error("Обновить танк может только ведущий.");
  const data = blueprint ?? await loadBlueprint();
  validateBlueprint(data);
  const tank = typeof actor === "string" ? game.actors.get(actor.replace(/^Actor\./, ""))
    : actor ?? findMarked(game.actors, "tank");
  const marker = getMarker(tank);
  if (!tank || marker?.packageId !== MODULAR_TANK_DEMO_PACKAGE_ID || marker.kind !== "tank") {
    throw new Error("Выберите существующий Fallout Tank из этого комплекта.");
  }
  const created = [];
  const library = await ensureModularTankLibrary(data, { created });
  const race = populateCrew ? await ensureModularTankDemoAnatomy() : null;
  const crew = populateCrew ? await ensureCrew(data, race, created, library) : [];
  const upgrade = await upgradeTankConfiguration(tank, data, library);
  const renamedTokens = upgrade.updated ? await renameLegacyTankTokens(tank, data) : [];
  const autoRotateTokens = upgrade.updated && Number(data.revision) >= 5 ? await enableTankTokenAutoRotation(tank) : [];
  return { tank, library: library.documents, crew: crew.map(row => row.actor), scene: null, tokens: [], ...upgrade,
    renamedTokens, autoRotateTokens,
    created: created.map(document => document.uuid), instructions: [...data.testInstructions] };
}

function validateBlueprint(data) {
  if (data?.packageId !== MODULAR_TANK_DEMO_PACKAGE_ID || data?.version !== 1) {
    throw new Error("Некорректный комплект модульного танка.");
  }
}

async function upgradeTankConfiguration(tank, data, library) {
  const revision = Number(data.revision) || 1;
  const installedRevision = Number(getMarker(tank)?.revision) || 0;
  if (installedRevision >= revision) return { updated: false, retainedLegacyParts: [] };
  if (installedRevision < 3) await addSampleHullProtection(tank, data);
  const production = revision >= 3 && installedRevision < 3 ? planModularTankProductionUpgrade(tank, data, library)
    : { changes: {}, itemUpdates: [], deleteIds: [], mergedTracks: false, retainedLegacyParts: [] };
  const sourceFlags = tank._source?.flags?.[SYSTEM_ID] ?? tank.flags?.[SYSTEM_ID] ?? {};
  const defaults = data.tank.flags[SYSTEM_ID];
  const changes = { ...production.changes };
  if (installedRevision < 11 && [data.legacyDefaults?.tankImg,
    "systems/fallout-maw/assets/Транспорт/Военный/Fallout Tank/Карточка.webp"].includes(tank.img)) changes.img = data.tank.img;
  let consolidatedChassisVisual = false;
  if (!sourceFlags.constructVisual && installedRevision < 2) changes[`flags.${SYSTEM_ID}.constructVisual`] = structuredClone(defaults.constructVisual);
  else if (sourceFlags.constructVisual) {
    const visual = structuredClone(sourceFlags.constructVisual);
    if (installedRevision < 2) {
      visual.anchors ??= [];
      for (const anchor of defaults.constructVisual.anchors.filter(row => row.id.startsWith("window-"))) {
        if (!visual.anchors.some(row => row.id === anchor.id)) visual.anchors.push(structuredClone(anchor));
      }
      visual.seats = (visual.seats ?? []).map(seat => {
        const sampleSeat = defaults.constructVisual.seats.find(row => row.id === seat.id
          || (row.slotId === seat.slotId && row.slotIndex === seat.slotIndex));
        if (!sampleSeat?.personalWeapons?.enabled) return seat;
        return { ...seat, personalWeapons: mergeMissing(seat.personalWeapons, sampleSeat.personalWeapons) };
      });
    }
    migrateTankVisualTrackReferences(visual, production.mergedTracks);
    if (revision >= 4) consolidatedChassisVisual = consolidateTankChassisVisual(visual, data);
    if (installedRevision < 3 || consolidatedChassisVisual) changes[`flags.${SYSTEM_ID}.constructVisual`] = visual;
  }
  if (installedRevision < 2) {
    const interior = structuredClone(sourceFlags.constructInterior ?? { version: 1, parts: [] });
    interior.version ??= 1;
    interior.parts ??= [];
    for (const part of defaults.constructInterior?.parts ?? []) {
      if (!interior.parts.some(row => row.slotId === part.slotId)) interior.parts.push(structuredClone(part));
    }
    changes[`flags.${SYSTEM_ID}.constructInterior`] = interior;
  }
  const guns = revision >= 6 && installedRevision < 6
    ? planModularTankGunUpgrade(tank, data, library, { changes })
    : { changes: {}, itemUpdates: [], itemCreates: [], splitGuns: false, convertedReserve: false, retainedReserveReason: "" };
  Object.assign(changes, guns.changes);
  const systems = revision >= 7 && installedRevision < 7
    ? planModularTankSystemUpgrade(tank, data, library, changes, [...production.itemUpdates, ...guns.itemUpdates])
    : { itemUpdates: [], itemCreates: [] };
  if (revision >= 9) for (const [key, value] of Object.entries(planTankTokenFootprint(tank.prototypeToken ?? tank._source.prototypeToken)))
    changes[`prototypeToken.${key}`] = value;
  if (revision >= 10) {
    const texture = tank.prototypeToken?.texture ?? tank._source.prototypeToken.texture;
    changes["prototypeToken.texture.scaleX"] = -Math.abs(changes["prototypeToken.texture.scaleX"] ?? texture.scaleX);
    changes["prototypeToken.texture.scaleY"] = -Math.abs(changes["prototypeToken.texture.scaleY"] ?? texture.scaleY);
  }
  if (revision >= 12 && installedRevision < 12) {
    const visual = structuredClone(changes[`flags.${SYSTEM_ID}.constructVisual`] ?? sourceFlags.constructVisual ?? defaults.constructVisual);
    visual.hullRotationCost ??= structuredClone(defaults.constructVisual.hullRotationCost);
    for (const part of visual.parts ?? []) if (part.slotId === "turret") {
      part.rotationCost ??= structuredClone(defaults.constructVisual.parts.find(row => row.slotId === "turret").rotationCost);
      part.rotationSystemIds ??= ["drive"];
    }
    changes[`flags.${SYSTEM_ID}.constructVisual`] = visual;
  }
  if (revision >= 13 && installedRevision < 13) {
    const visual = structuredClone(changes[`flags.${SYSTEM_ID}.constructVisual`] ?? sourceFlags.constructVisual ?? defaults.constructVisual);
    for (const part of visual.parts ?? []) if (part.slotId === "turret"
      && part.rotationCost?.points === 5 && part.rotationCost?.degrees === 30) {
      part.rotationCost = structuredClone(defaults.constructVisual.parts.find(row => row.slotId === "turret").rotationCost);
    }
    changes[`flags.${SYSTEM_ID}.constructVisual`] = visual;
  }
  guns.itemCreates.push(...systems.itemCreates);
  production.deleteIds.push(...(guns.deleteIds ?? []));
  changes[`flags.${SYSTEM_ID}.modularTankDemo.revision`] = revision;
  const combinedUpdates = new Map();
  for (const update of [...production.itemUpdates, ...guns.itemUpdates, ...systems.itemUpdates]) {
    combinedUpdates.set(update._id, { ...(combinedUpdates.get(update._id) ?? {}), ...update });
  }
  const itemUpdates = [...combinedUpdates.values()];
  if (guns.itemCreates.length && globalThis.foundry?.documents?.modifyBatch) {
    // Use the same native projected-state validation and complete batch guards
    // as ordinary inventory operations, keeping this package's stable Item IDs.
    const oldItems = tank.items.contents.map(item => structuredClone(item._source));
    const projected = oldItems.filter(item => !production.deleteIds.includes(item._id)).map(item => {
      const update = combinedUpdates.get(item._id);
      return update ? foundry.utils.mergeObject(item, update, { inplace: false }) : item;
    }).concat(guns.itemCreates);
    validateActorInventoryState(tank, projected);
    const operations = [];
    const embedded = (action, ids, payload) => ({ action, documentName: "Item", parent: tank, ...payload,
      [INVENTORY_ATOMIC_OPTION]: true, [INVENTORY_EXPECTED_IDS_OPTION]: ids,
      [BATCH_EXPECTED_IDS_OPTION]: ids, render: false });
    if (production.deleteIds.length) operations.push(embedded("delete", production.deleteIds, { ids: production.deleteIds }));
    operations.push(embedded("create", guns.itemCreates.map(item => item._id), { data: guns.itemCreates, keepId: true }));
    if (itemUpdates.length) operations.push(embedded("update", itemUpdates.map(item => item._id), { updates: itemUpdates }));
    operations.push({ action: "update", documentName: "Actor", updates: [{ _id: tank.id, ...changes }],
      [BATCH_EXPECTED_IDS_OPTION]: [tank.id] });
    await foundry.documents.modifyBatch(operations);
  } else {
    if (guns.itemCreates.length) await tank.createEmbeddedDocuments("Item", guns.itemCreates, { keepId: true });
    if (production.deleteIds.length) await tank.deleteEmbeddedDocuments("Item", production.deleteIds);
    if (itemUpdates.length) {
      if (tank.updateEmbeddedDocuments) await tank.updateEmbeddedDocuments("Item", itemUpdates);
      else for (const row of itemUpdates) {
        const { _id, ...update } = row;
        await tank.items.get(_id).update(update);
      }
    }
    await tank.update(changes);
  }
  return { updated: true, retainedLegacyParts: production.retainedLegacyParts, consolidatedChassisVisual,
    splitGuns: guns.splitGuns, convertedReserve: guns.convertedReserve,
    retainedReserveReason: guns.retainedReserveReason, retainedCustomGunVisuals: guns.retainedCustomGunVisuals };
}

async function enableTankTokenAutoRotation(tank) {
  const updated = [];
  for (const scene of game.scenes?.contents ?? []) {
    const tokens = (scene.tokens?.contents ?? []).filter(token => token.actorId === tank.id
      && (token.flags?.[SYSTEM_ID]?.movementAutoRotate !== "on" || token.flags?.[SYSTEM_ID]?.rotationSpeedMultiplier === undefined
        || token.flags?.[SYSTEM_ID]?.tokenHitbox === undefined || token.width === 4 && token.height === 7
        || token.width === 3 && token.height === 5 && token.flags?.[SYSTEM_ID]?.tokenHitbox?.x !== undefined
        || token.texture.scaleX > 0 || token.texture.scaleY > 0));
    if (!tokens.length) continue;
    const changes = tokens.map(token => {
      const footprint = planTankTokenFootprint(token, { sceneToken: true });
      return { _id: token.id, ...footprint, [`flags.${SYSTEM_ID}.movementAutoRotate`]: "on",
      "texture.scaleX": -Math.abs(footprint["texture.scaleX"] ?? token.texture.scaleX),
      "texture.scaleY": -Math.abs(footprint["texture.scaleY"] ?? token.texture.scaleY),
      ...(token.flags?.[SYSTEM_ID]?.rotationSpeedMultiplier === undefined ? { [`flags.${SYSTEM_ID}.rotationSpeedMultiplier`]: 1 / 3 } : {}),
      ...(token.flags?.[SYSTEM_ID]?.tokenHitbox === undefined ? { [`flags.${SYSTEM_ID}.tokenHitbox`]: structuredClone(tank.prototypeToken.flags[SYSTEM_ID].tokenHitbox) } : {}) };
    });
    // Configuration migration must not spend movement resources or require a running engine.
    const options = { animate: false, autoRotate: false, method: "config",
      constrainOptions: { ignoreWalls: true, ignoreCost: true },
      falloutMawAbilityFreeMovement: Object.fromEntries(tokens.map(token => [token.id, true])) };
    if (scene.updateEmbeddedDocuments) await scene.updateEmbeddedDocuments("Token", changes, options);
    else for (const change of changes) await scene.tokens.get(change._id).update(change, options);
    updated.push(...tokens.map(token => token.uuid));
  }
  return updated;
}

function linkTankPrototypes(source, library) {
  for (const item of source.items ?? []) {
    const prototype = library.parts.get(item.system?.placement?.limbKey);
    if (!prototype) continue;
    item.flags ??= {};
    item.flags[SYSTEM_ID] ??= {};
    item.flags[SYSTEM_ID].sourceId ??= prototype.uuid;
  }
  return source;
}

async function renameLegacyTankTokens(tank, data) {
  const renamed = [];
  const previousName = data.legacyDefaults?.tankName;
  const finalName = data.productionNames?.actor ?? data.tank.name;
  if (Number(data.revision) < 6 && (!previousName || previousName === finalName)) return renamed;
  for (const scene of game.scenes?.contents ?? []) {
    const tokens = (scene.tokens?.contents ?? []).filter(token => token.actorId === tank.id
      && (Number(data.revision) >= 6 ? token.name !== finalName : token.name === previousName));
    if (!tokens.length) continue;
    if (scene.updateEmbeddedDocuments) await scene.updateEmbeddedDocuments("Token", tokens.map(token => ({ _id: token.id, name: finalName })));
    else for (const token of tokens) await token.update({ name: finalName });
    renamed.push(...tokens.map(token => token.uuid));
  }
  return renamed;
}

function completeSampleHullProtection(source) {
  const hull = source.items?.find(item => item._id === "mwtankHull000001");
  const entries = hull?.system?.functions?.damageMitigation?.entries?.constructPart;
  if (entries) for (const type of getDamageTypeSettings()) entries[type.key] ??= { value: 20 };
  return source;
}

async function addSampleHullProtection(tank, data) {
  const template = completeSampleHullProtection(structuredClone(data.tank)).items.find(item => item._id === "mwtankHull000001");
  const hull = tank.items?.get?.(template?._id)
    ?? (tank.items?.contents ?? Array.from(tank.items ?? [])).find(item => (item.id ?? item._id) === template?._id);
  if (!hull || hull.system?.placement?.mode !== "constructPart" || hull.system.placement.limbKey !== "hull") return;
  const mitigation = hull._source?.system?.functions?.damageMitigation ?? hull.system?.functions?.damageMitigation;
  if (mitigation?.enabled || mitigation?.requirements?.length || mitigation?.moduleSlots?.length
    || mitigation?.limbSetIds?.length || Object.values(mitigation?.entries ?? {}).some(entries =>
      Object.values(entries ?? {}).some(entry => Number(entry?.value) !== 0))) return;
  if (getDamageTypeSettings().some(type => Number(tank.getDamageDefense?.(type.key, "constructPart:hull")) > 0)) return;
  await hull.update({ "system.functions.damageMitigation": structuredClone(template.system.functions.damageMitigation) });
}

async function ensureCrew(data, race, created, library = null) {
  const rows = [];
  const needsAmmo = data.crew.some(entry => entry.source.items?.some(item => item.system?.functions?.weapon?.enabled));
  let personalAmmo = needsAmmo ? library?.personalAmmo ?? findMarked(game.items, "personal-ammo") : null;
  if (needsAmmo && !personalAmmo && data.personalAmmo) {
    personalAmmo = await Item.create(markSource(data.personalAmmo, "personal-ammo", data.revision));
    created.push(personalAmmo);
  }
  for (const entry of data.crew) {
    const source = personalAmmo ? replaceShellUuid(entry.source, data.personalAmmoUuidPlaceholder, personalAmmo.uuid) : entry.source;
    let actor = findMarked(game.actors, entry.kind);
    if (!actor) {
      actor = await Actor.create(markSource(prepareModularTankDemoCharacter(source, race), entry.kind, data.revision), { keepEmbeddedIds: true });
      created.push(actor);
    } else {
      await repairEmptyModularTankDemoCharacter(actor, race);
      await addMissingPersonalLoadout(actor, source, data.revision, created);
      await repairSampleWeaponRequirement(actor, source);
    }
    rows.push({ kind: entry.kind, actor });
  }
  return rows;
}

/** Repair only the initial sample pistol's missing hand requirement. The usual
 * equipment helper validates and equips it; user weapons and valid requirements stay intact. */
async function repairSampleWeaponRequirement(actor, source) {
  const template = source.items?.find(item => item.system?.functions?.weapon?.enabled);
  if (!template) return;
  const weapon = (actor.items?.contents ?? Array.from(actor.items ?? [])).find(item =>
    getMarker(item)?.packageId === MODULAR_TANK_DEMO_PACKAGE_ID && getMarker(item)?.kind === "personal-weapon");
  if (!weapon || getMarker(weapon)?.slotRequirementVersion === 1) return;
  const markerPath = `flags.${SYSTEM_ID}.modularTankDemo.slotRequirementVersion`;
  if (Object.values(weapon.system?.weaponSlotRequirement?.slots ?? {}).some(Boolean)) {
    await weapon.update({ [markerPath]: 1 });
    return;
  }
  await weapon.update({ "system.weaponSlotRequirement": structuredClone(template.system.weaponSlotRequirement), [markerPath]: 1 });
  if (weapon.system?.placement?.mode !== "inventory") return;
  const { getActorRace, equipActorItemInWeaponSlot } = await import("../utils/equipment-hud-placement.mjs");
  const { canUseWeaponSlotForItem, getRequiredWeaponSlotsForItem } = await import("../utils/equipment-slots.mjs");
  const race = getActorRace(actor);
  for (const set of race?.weaponSets ?? []) for (const slot of set.slots ?? []) {
    if (!canUseWeaponSlotForItem(race, weapon, set.key, slot.key)) continue;
    const occupied = actor.items.contents.some(item => item.id !== weapon.id
      && item.system?.placement?.mode === "weapon" && item.system.placement.weaponSet === set.key
      && getRequiredWeaponSlotsForItem(race, item, set.key, item.system.placement.weaponSlot).some(row => row.key === slot.key));
    if (!occupied) { await equipActorItemInWeaponSlot(actor, weapon, set.key, slot.key); return; }
  }
}

async function addMissingPersonalLoadout(actor, source, revision, created) {
  const loadout = source.items ?? [];
  if (!loadout.length || Number(getMarker(actor)?.revision) >= Number(revision)) return;
  const items = actor.items?.contents ?? Array.from(actor.items ?? []);
  const sampleWeapon = loadout.find(item => item.system?.functions?.weapon?.enabled);
  const existingSampleWeapon = items.find(item => item.id === sampleWeapon?._id || item._id === sampleWeapon?._id
    || getMarker(item)?.kind === "personal-weapon");
  const hasOrdinaryWeapon = items.some(item => item.system?.functions?.weapon?.enabled
    && !item.system?.functions?.constructPart?.enabled);
  if (existingSampleWeapon || !hasOrdinaryWeapon) {
    const missing = loadout.filter(item => !items.some(current => (current.id ?? current._id) === item._id
      || (getMarker(current)?.packageId === MODULAR_TANK_DEMO_PACKAGE_ID && getMarker(current)?.kind === getMarker(item)?.kind)));
    if (missing.length) created.push(...await actor.createEmbeddedDocuments("Item", structuredClone(missing), { keepId: true }));
  }
  await actor.update({ [`flags.${SYSTEM_ID}.modularTankDemo.revision`]: Number(revision) || 1 });
}

function mergeMissing(value, defaults) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return structuredClone(defaults);
  const result = structuredClone(value);
  for (const [key, fallback] of Object.entries(defaults)) {
    if (!Object.hasOwn(result, key)) result[key] = structuredClone(fallback);
    else if (fallback && typeof fallback === "object" && !Array.isArray(fallback)) result[key] = mergeMissing(result[key], fallback);
  }
  return result;
}

async function loadBlueprint() {
  const response = await fetch(MODULAR_TANK_DEMO_BLUEPRINT_URL);
  if (!response.ok) throw new Error(`Комплект модульного танка недоступен (${response.status}).`);
  return response.json();
}

function markSource(source, kind, revision = 5) {
  const data = structuredClone(source);
  delete data._id;
  delete data.folder;
  delete data.ownership;
  delete data._stats;
  data.flags ??= {};
  data.flags[SYSTEM_ID] ??= {};
  data.flags[SYSTEM_ID].modularTankDemo = { packageId: MODULAR_TANK_DEMO_PACKAGE_ID, kind, revision: Number(revision) || 1 };
  return data;
}

function findMarked(collection, kind) {
  return (collection?.contents ?? Array.from(collection ?? [])).find(document => {
    const marker = getMarker(document);
    return marker?.packageId === MODULAR_TANK_DEMO_PACKAGE_ID && marker.kind === kind;
  }) ?? null;
}

function getMarker(document) {
  return document?.getFlag?.(SYSTEM_ID, "modularTankDemo") ?? document?.flags?.[SYSTEM_ID]?.modularTankDemo;
}

function replaceShellUuid(value, placeholder, uuid) {
  if (value === placeholder) return uuid;
  if (Array.isArray(value)) return value.map(entry => replaceShellUuid(entry, placeholder, uuid));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replaceShellUuid(entry, placeholder, uuid)]));
  return value;
}

async function ensureToken(scene, actor, kind, position, created) {
  const existing = findMarked(scene.tokens, kind);
  if (existing) return existing;
  const document = await actor.getTokenDocument({ ...position, actorLink: true, flags: {
    [SYSTEM_ID]: { modularTankDemo: { packageId: MODULAR_TANK_DEMO_PACKAGE_ID, kind } }
  } });
  const [token] = await scene.createEmbeddedDocuments("Token", [document.toObject()]);
  created.push(token);
  return token;
}
