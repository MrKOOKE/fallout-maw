// Fallout-MaW macro: increase condition by 50% for protective items.
// Paste this entire file into a Foundry Script macro and run as GM.

void (async () => {
  const SYSTEM_ID = "fallout-maw";
  const MULTIPLIER = 1.5;
  const PROCESS_WORLD_ITEMS = true;
  const PROCESS_WORLD_ACTOR_ITEMS = true;
  const PROCESS_SCENE_TOKEN_ACTOR_ITEMS = true;
  const PROCESS_SYSTEM_ITEM_PACKS = true;
  const PROCESS_SYSTEM_ACTOR_PACKS = true;
  const PROCESS_WORLD_ITEM_PACKS = true;
  const PROCESS_WORLD_ACTOR_PACKS = true;

  if (game.system.id !== SYSTEM_ID) {
    ui.notifications.error(`This macro is only for ${SYSTEM_ID}.`);
    return;
  }

  if (!game.user.isGM) {
    ui.notifications.error("Only a GM can update world and compendium items.");
    return;
  }

  const results = {
    world: { scanned: 0, updated: 0 },
    actors: { scanned: 0, updated: 0 },
    sceneTokens: { scanned: 0, updated: 0, linkedSkipped: 0 },
    packs: [],
    failed: []
  };

  function toInteger(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.trunc(number) : 0;
  }

  function scaleCondition(value) {
    return Math.max(0, Math.round(toInteger(value) * MULTIPLIER));
  }

  function hasProtectionCondition(item) {
    const functions = item?.system?.functions ?? {};
    return Boolean(hasConditionData(functions.condition) && hasDamageMitigationTable(functions.damageMitigation));
  }

  function hasConditionData(condition) {
    if (!condition || typeof condition !== "object") return false;
    return Number.isFinite(Number(condition.value)) || Number.isFinite(Number(condition.max));
  }

  function hasDamageMitigationTable(damageMitigation) {
    if (!damageMitigation || typeof damageMitigation !== "object") return false;
    if (damageMitigation.enabled) return true;
    if (Object.keys(damageMitigation.entries ?? {}).length > 0) return true;
    if (Array.isArray(damageMitigation.limbSetIds) && damageMitigation.limbSetIds.length > 0) return true;
    return Object.values(damageMitigation.entries ?? {}).some(limbEntries =>
      Object.values(limbEntries ?? {}).some(entry => Number(entry?.value) > 0)
    );
  }

  function buildConditionUpdate(item) {
    if (!hasProtectionCondition(item)) return null;

    const condition = item.system.functions.condition;
    const current = Math.max(0, toInteger(condition.value));
    const max = Math.max(0, toInteger(condition.max));
    const nextCurrent = scaleCondition(current);
    const nextMax = scaleCondition(max);

    if (nextCurrent === current && nextMax === max) return null;

    return {
      _id: item.id,
      "system.functions.condition.value": nextCurrent,
      "system.functions.condition.max": nextMax
    };
  }

  function shouldProcessPack(pack) {
    const type = String(pack?.metadata?.type ?? "");
    if (!["Actor", "Item"].includes(type)) return false;

    const collection = String(pack.collection ?? "");
    const packageName = String(pack.metadata.packageName ?? pack.metadata.package ?? "");
    const isSystemPack = packageName === SYSTEM_ID || collection.startsWith(`${SYSTEM_ID}.`);
    const isWorldPack = collection.startsWith("world.");

    if (type === "Item") {
      if (PROCESS_SYSTEM_ITEM_PACKS && isSystemPack) return true;
      if (PROCESS_WORLD_ITEM_PACKS && isWorldPack) return true;
    }

    if (type === "Actor") {
      if (PROCESS_SYSTEM_ACTOR_PACKS && isSystemPack) return true;
      if (PROCESS_WORLD_ACTOR_PACKS && isWorldPack) return true;
    }

    return false;
  }

  async function updateWorldItems() {
    if (!PROCESS_WORLD_ITEMS) return;

    const updates = [];
    for (const item of game.items ?? []) {
      results.world.scanned += 1;
      const update = buildConditionUpdate(item);
      if (update) updates.push(update);
    }

    if (updates.length) await Item.implementation.updateDocuments(updates);
    results.world.updated = updates.length;
  }

  async function updateWorldActorItems() {
    if (!PROCESS_WORLD_ACTOR_ITEMS) return;

    for (const actor of game.actors ?? []) {
      const result = await updateActorItems(actor, { scope: "world actor", useSyntheticUpdate: false });
      results.actors.scanned += result.scanned;
      results.actors.updated += result.updated;
    }
  }

  async function updateSceneTokenActorItems() {
    if (!PROCESS_SCENE_TOKEN_ACTOR_ITEMS) return;

    for (const scene of game.scenes ?? []) {
      for (const token of scene.tokens ?? []) {
        if (token.actorLink) {
          results.sceneTokens.linkedSkipped += 1;
          continue;
        }
        if (!token.actor) continue;

        const result = await updateActorItems(token.actor, {
          scope: `scene token ${scene.name}/${token.name}`,
          useSyntheticUpdate: true
        });
        results.sceneTokens.scanned += result.scanned;
        results.sceneTokens.updated += result.updated;
      }
    }
  }

  async function updateActorItems(actor, { scope = "actor", useSyntheticUpdate = false } = {}) {
    const result = { scanned: 0, updated: 0 };
    const updates = [];
    for (const item of actor.items ?? []) {
      result.scanned += 1;
      const update = buildConditionUpdate(item);
      if (update) updates.push(update);
    }
    if (!updates.length) return result;

    try {
      if (useSyntheticUpdate) {
        const mergedItems = updates
          .map(update => {
            const original = actor.items.get(update._id);
            return original ? foundry.utils.mergeObject(original.toObject(), update, { inplace: false }) : null;
          })
          .filter(Boolean);
        if (mergedItems.length) {
          await actor.update({ items: mergedItems }, {
            enforceTypes: false,
            diff: true,
            recursive: true,
            render: false
          });
        }
      } else {
        await actor.updateEmbeddedDocuments("Item", updates, { render: false });
      }
      result.updated = updates.length;
    } catch (error) {
      results.failed.push(`${scope}: ${actor.name}: ${error.message}`);
      console.error(`${SYSTEM_ID} | Failed to update actor items ${actor.uuid}`, error);
    }

    return result;
  }

  async function updatePackItems(pack) {
    const packResult = {
      collection: pack.collection,
      type: pack.metadata.type,
      scanned: 0,
      updated: 0
    };
    results.packs.push(packResult);

    const wasLocked = pack.locked;
    try {
      if (wasLocked) await pack.configure({ locked: false });

      if (pack.metadata.type === "Item") {
        const documents = await pack.getDocuments();
        const updates = [];
        for (const item of documents) {
          packResult.scanned += 1;
          const update = buildConditionUpdate(item);
          if (update) updates.push(update);
        }

        if (updates.length) await Item.implementation.updateDocuments(updates, { pack: pack.collection });
        packResult.updated = updates.length;
      } else {
        const actors = await pack.getDocuments();
        for (const actor of actors) {
          const result = await updateActorItems(actor, {
            scope: `pack ${pack.collection}`,
            useSyntheticUpdate: false
          });
          packResult.scanned += result.scanned;
          packResult.updated += result.updated;
        }
      }
    } catch (error) {
      results.failed.push(`${pack.collection}: ${error.message}`);
      console.error(`${SYSTEM_ID} | Failed to update pack ${pack.collection}`, error);
    } finally {
      if (pack.locked !== wasLocked) await pack.configure({ locked: wasLocked });
    }
  }

  ui.notifications.info("Fallout-MaW: increasing protective item condition...");

  await updateWorldItems();
  await updateWorldActorItems();
  await updateSceneTokenActorItems();

  for (const pack of game.packs) {
    if (!shouldProcessPack(pack)) continue;
    await updatePackItems(pack);
  }

  const scannedPacks = results.packs.reduce((sum, pack) => sum + pack.scanned, 0);
  const updatedPacks = results.packs.reduce((sum, pack) => sum + pack.updated, 0);
  const message = [
    `World items: ${results.world.updated}/${results.world.scanned}`,
    `Actor items: ${results.actors.updated}/${results.actors.scanned}`,
    `Scene token items: ${results.sceneTokens.updated}/${results.sceneTokens.scanned}`,
    `Linked scene tokens skipped: ${results.sceneTokens.linkedSkipped}`,
    `Pack items: ${updatedPacks}/${scannedPacks}`,
    `Failed packs: ${results.failed.length}`
  ].join("; ");

  console.log(`${SYSTEM_ID} | Protective item condition boost complete`, results);
  ui.notifications.info(`Fallout-MaW: condition boost complete. ${message}`);
})();
