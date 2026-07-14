import { withSystemEventRoot } from "./dispatcher.mjs";

const SYSTEM_EVENT_PREFIX = "fallout-maw.";
const BEFORE_SNAPSHOTS_OPTION = "falloutMawSystemEventBeforeByUuid";
const OCCURRENCE_BASE_OPTION = "falloutMawSystemEventOccurrenceBase";
const MANAGED_REACTION_OPTIONS = Object.freeze([
  "falloutMawEventReactionEffect",
  "falloutMawEventReactionManaged",
  "falloutMawEventReactionCleanup"
]);

const INVENTORY_SPECIAL_TYPES = new Set(["ability", "trauma", "disease"]);
const ITEM_PLACEMENT_ROOTS = Object.freeze([
  "system.placement",
  "system.container.parentId",
  "system.stackParts"
]);
const ITEM_RESOURCE_ROOTS = Object.freeze([
  "system.resources",
  "system.resource",
  "system.ammunition",
  "system.charges"
]);
const ITEM_CONDITION_ROOTS = Object.freeze([
  "system.condition",
  "system.durability",
  "system.functions.condition"
]);

/**
 * Classify one committed Actor update into non-overlapping semantic events.
 * The returned descriptors contain plain data only and do not retain Documents.
 */
export function classifyActorUpdate(actor, changes = {}, { before = null, after = null } = {}) {
  if (!actor) return [];
  const previous = normalizeSnapshot(before);
  const current = normalizeSnapshot(after ?? captureDocumentSnapshot(actor));
  const flat = flattenChanges(changes);
  const paths = Object.keys(flat);
  if (!paths.length) return [];

  const actorParticipant = participantForActor(actor);
  const context = {
    document: actor,
    target: actorParticipant,
    data: {
      actorUuid: String(actor.uuid ?? ""),
      actorId: String(actor.id ?? actor._id ?? ""),
      actorType: String(actor.type ?? "")
    },
    previous,
    current,
    flat
  };
  const events = [];
  const claimed = new Set();

  emitPathEvent(events, claimed, context, "actor.health.changed", paths.filter(pathMatchesRoot("system.resources.health")), {
    data: { resourceKey: "health" }
  });

  const resourceGroups = groupPaths(paths.filter(path => (
    path.startsWith("system.resources.") && !pathMatchesRoot("system.resources.health")(path)
  )), 2);
  for (const [resourceKey, resourcePaths] of resourceGroups) {
    emitPathEvent(events, claimed, context, "actor.resource.changed", resourcePaths, { data: { resourceKey } });
  }

  for (const [needKey, needPaths] of groupPaths(paths.filter(path => path.startsWith("system.needs.")), 2)) {
    emitPathEvent(events, claimed, context, "actor.need.changed", needPaths, { data: { needKey } });
  }

  for (const [currencyKey, currencyPaths] of groupPaths(paths.filter(path => path.startsWith("system.currencies.")), 2)) {
    emitPathEvent(events, claimed, context, "actor.currency.changed", currencyPaths, { data: { currencyKey } });
  }

  emitPathEvent(
    events,
    claimed,
    context,
    "actor.experience.changed",
    paths.filter(path => pathMatchesRoot("system.development.experience")(path) || pathMatchesRoot("system.experience")(path))
  );
  emitPathEvent(
    events,
    claimed,
    context,
    "actor.level.changed",
    paths.filter(path => pathMatchesRoot("system.attributes.level")(path) || pathMatchesRoot("system.level")(path))
  );

  for (const [limbKey, limbPaths] of groupPaths(paths.filter(path => path.startsWith("system.limbs.")), 2)) {
    emitPathEvent(events, claimed, context, "actor.limb.changed", limbPaths, { data: { limbKey } });
    const beforeMissing = Boolean(readSnapshotPath(previous, `system.limbs.${limbKey}.missing`));
    const afterMissing = Boolean(readSnapshotPath(current, `system.limbs.${limbKey}.missing`));
    if (!beforeMissing && afterMissing) {
      events.push(createEventDescriptor("actor.limb.destroyed", context, limbPaths, { data: { limbKey } }));
    } else if (beforeMissing && !afterMissing) {
      events.push(createEventDescriptor("actor.limb.restored", context, limbPaths, { data: { limbKey } }));
    }
  }

  return events;
}

export function classifyItemCreate(item) {
  const actor = getOwningActor(item);
  if (!actor) return [];
  const context = itemContext(item, actor, null, captureDocumentSnapshot(item), {});
  if (item.type === "ability") return [createEventDescriptor("ability.acquired", context, [])];
  if (item.type === "trauma") return [createEventDescriptor("actor.trauma.acquired", context, [])];
  if (item.type === "disease") return [createEventDescriptor("actor.disease.acquired", context, [])];
  return [createEventDescriptor("inventory.item.added", context, [])];
}

export function classifyItemDelete(item, { before = null } = {}) {
  const actor = getOwningActor(item);
  if (!actor) return [];
  const context = itemContext(item, actor, before ?? captureDocumentSnapshot(item), null, {});
  if (item.type === "ability") return [createEventDescriptor("ability.removed", context, [])];
  if (item.type === "trauma") return [createEventDescriptor("actor.trauma.recovered", context, [])];
  if (item.type === "disease") return [createEventDescriptor("actor.disease.recovered", context, [])];
  return [createEventDescriptor("inventory.item.removed", context, [])];
}

export function classifyItemUpdate(item, changes = {}, { before = null, after = null } = {}) {
  const actor = getOwningActor(item);
  if (!actor) return [];
  const previous = normalizeSnapshot(before);
  const current = normalizeSnapshot(after ?? captureDocumentSnapshot(item));
  const flat = flattenChanges(changes);
  const paths = Object.keys(flat);
  if (!paths.length) return [];
  const context = itemContext(item, actor, previous, current, flat);
  const events = [];
  const claimed = new Set();

  if (item.type === "disease") {
    const stagePaths = paths.filter(path => ["system.stageId", "system.level"].some(root => pathMatchesRoot(root)(path)));
    emitPathEvent(events, claimed, context, "actor.disease.stageChanged", stagePaths);
    return events;
  }
  if (item.type === "ability") {
    const togglePaths = paths.filter(isAbilityTogglePath);
    emitPathEvent(events, claimed, context, "ability.toggle.changed", togglePaths);
    return events;
  }
  if (item.type === "trauma") return events;

  emitPathEvent(events, claimed, context, "inventory.item.quantityChanged", paths.filter(pathMatchesRoot("system.quantity")));
  emitPathEvent(events, claimed, context, "inventory.item.resourceChanged", paths.filter(path => ITEM_RESOURCE_ROOTS.some(root => pathMatchesRoot(root)(path))));
  emitPathEvent(events, claimed, context, "inventory.item.conditionChanged", paths.filter(path => ITEM_CONDITION_ROOTS.some(root => pathMatchesRoot(root)(path))));
  emitPathEvent(events, claimed, context, "inventory.item.placementChanged", paths.filter(path => ITEM_PLACEMENT_ROOTS.some(root => pathMatchesRoot(root)(path))));

  const equippedPaths = paths.filter(pathMatchesRoot("system.equipped"));
  if (equippedPaths.length) {
    for (const path of equippedPaths) claimed.add(path);
    const equipped = Boolean(readSnapshotPath(current, "system.equipped"));
    events.push(createEventDescriptor(equipped ? "inventory.item.equipped" : "inventory.item.unequipped", context, equippedPaths));
  }

  emitPathEvent(events, claimed, context, "item.lightSource.changed", paths.filter(path => (
    pathMatchesRoot("system.functions.lightSource")(path) || pathMatchesRoot("system.lightSource")(path)
  )));
  emitPathEvent(events, claimed, context, "item.energyConsumer.changed", paths.filter(path => (
    pathMatchesRoot("system.functions.energyConsumer")(path) || pathMatchesRoot("system.energyConsumer")(path)
  )));

  return events;
}

export function classifyActiveEffectCreate(effect, options = {}) {
  if (isManagedReactionOperation(options)) return [];
  const actor = getOwningActor(effect);
  if (!actor) return [];
  const current = captureDocumentSnapshot(effect);
  const context = effectContext(effect, actor, null, current, {});
  const events = [createEventDescriptor("actor.effect.applied", context, [])];
  for (const statusId of snapshotStatuses(current)) {
    events.push(createEventDescriptor("actor.status.gained", context, [], { data: { statusId } }));
  }
  if (hasDiseaseImmunity(current)) events.push(createEventDescriptor("actor.disease.immunityGained", context, []));
  return events;
}

export function classifyActiveEffectUpdate(effect, changes = {}, { before = null, after = null, options = {} } = {}) {
  if (isManagedReactionOperation(options)) return [];
  const actor = getOwningActor(effect);
  if (!actor) return [];
  const previous = normalizeSnapshot(before);
  const current = normalizeSnapshot(after ?? captureDocumentSnapshot(effect));
  const flat = flattenChanges(changes);
  const paths = Object.keys(flat);
  if (!paths.length) return [];
  const context = effectContext(effect, actor, previous, current, flat);
  const events = [createEventDescriptor("actor.effect.changed", context, paths)];
  const beforeStatuses = new Set(snapshotStatuses(previous));
  const afterStatuses = new Set(snapshotStatuses(current));
  for (const statusId of afterStatuses) {
    if (!beforeStatuses.has(statusId)) events.push(createEventDescriptor("actor.status.gained", context, paths, { data: { statusId } }));
  }
  for (const statusId of beforeStatuses) {
    if (!afterStatuses.has(statusId)) events.push(createEventDescriptor("actor.status.lost", context, paths, { data: { statusId } }));
  }
  if (!hasDiseaseImmunity(previous) && hasDiseaseImmunity(current)) {
    events.push(createEventDescriptor("actor.disease.immunityGained", context, paths));
  }
  return events;
}

export function classifyActiveEffectDelete(effect, { before = null, options = {} } = {}) {
  if (isManagedReactionOperation(options)) return [];
  const actor = getOwningActor(effect);
  if (!actor) return [];
  const previous = normalizeSnapshot(before ?? captureDocumentSnapshot(effect));
  const context = effectContext(effect, actor, previous, null, {});
  const events = [createEventDescriptor("actor.effect.removed", context, [])];
  for (const statusId of snapshotStatuses(previous)) {
    events.push(createEventDescriptor("actor.status.lost", context, [], { data: { statusId } }));
  }
  return events;
}

export function classifyCombatCreate(combat) {
  const current = normalizeSnapshot(captureDocumentSnapshot(combat));
  if (!isCombatStarted(current, combat)) return [];
  const context = combatContext(combat, null, current, {});
  return [createEventDescriptor("combat.started", context, [])];
}

export function classifyCombatUpdate(combat, changes = {}, { before = null, after = null } = {}) {
  if (!combat) return [];
  const previous = normalizeSnapshot(before);
  const current = normalizeSnapshot(after ?? captureDocumentSnapshot(combat));
  const flat = flattenChanges(changes);
  const paths = Object.keys(flat);
  if (!paths.length) return [];
  const context = combatContext(combat, previous, current, flat);
  const events = [];
  const wasStarted = isCombatStarted(previous);
  const started = isCombatStarted(current, combat);
  const turnTouched = paths.some(path => pathMatchesRoot("turn")(path) || pathMatchesRoot("round")(path));
  const oldCombatant = snapshotCurrentCombatant(previous);
  const newCombatant = snapshotCurrentCombatant(current) ?? participantForCombatant(combat.combatant);

  if (!wasStarted && started) events.push(createEventDescriptor("combat.started", context, paths));
  if (wasStarted && (!started || turnTouched) && oldCombatant) {
    events.push(createEventDescriptor("combat.turn.ended", { ...context, target: oldCombatant }, paths));
  }
  if (paths.some(pathMatchesRoot("round"))) events.push(createEventDescriptor("combat.round.changed", context, paths.filter(pathMatchesRoot("round"))));
  if (wasStarted && !started) events.push(createEventDescriptor("combat.ended", context, paths));
  if (started && turnTouched && newCombatant) {
    events.push(createEventDescriptor("combat.turn.started", { ...context, target: newCombatant }, paths));
  }
  return events;
}

export function classifyCombatDelete(combat, { before = null } = {}) {
  if (!combat) return [];
  const previous = normalizeSnapshot(before ?? captureDocumentSnapshot(combat));
  if (!isCombatStarted(previous, combat)) return [];
  return [createEventDescriptor("combat.ended", combatContext(combat, previous, null, {}), [])];
}

export function classifyCombatantCreate(combatant) {
  if (!combatant) return [];
  return [createEventDescriptor("combat.combatant.added", combatantContext(combatant, null, captureDocumentSnapshot(combatant), {}), [])];
}

export function classifyCombatantDelete(combatant, { before = null } = {}) {
  if (!combatant) return [];
  return [createEventDescriptor("combat.combatant.removed", combatantContext(
    combatant,
    before ?? captureDocumentSnapshot(combatant),
    null,
    {}
  ), [])];
}

export function classifyCombatantUpdate(combatant, changes = {}, { before = null, after = null } = {}) {
  if (!combatant) return [];
  const previous = normalizeSnapshot(before);
  const current = normalizeSnapshot(after ?? captureDocumentSnapshot(combatant));
  const flat = flattenChanges(changes);
  const paths = Object.keys(flat);
  if (!paths.length) return [];
  const context = combatantContext(combatant, previous, current, flat);
  const events = [];
  if (paths.some(pathMatchesRoot("initiative")) && Number.isFinite(Number(readSnapshotPath(current, "initiative")))) {
    events.push(createEventDescriptor("combat.initiative.rolled", context, paths.filter(pathMatchesRoot("initiative"))));
  }
  if (paths.some(pathMatchesRoot("defeated"))) {
    events.push(createEventDescriptor(
      Boolean(readSnapshotPath(current, "defeated")) ? "combat.combatant.defeated" : "combat.combatant.restored",
      context,
      paths.filter(pathMatchesRoot("defeated"))
    ));
  }
  return events;
}

/**
 * Register thin Foundry adapters. Hooks stay synchronous and all dispatch work is
 * intentionally detached from the document workflow.
 */
export function registerFoundryDocumentSystemEventHooks({
  withRoot = withSystemEventRoot,
  hooks = globalThis.Hooks,
  isActiveGM = defaultIsActiveGM,
  randomId = defaultRandomId,
  logger = globalThis.console
} = {}) {
  if (!hooks?.on) return Object.freeze([]);
  const registrations = [];
  const on = (name, callback) => registrations.push({ name, id: hooks.on(name, callback) });

  for (const documentName of ["Actor", "Item", "ActiveEffect", "Combat", "Combatant"]) {
    on(`preUpdate${documentName}`, (document, _changes, options = {}) => captureBeforeOperation(document, options, randomId));
    on(`preDelete${documentName}`, (document, options = {}) => captureBeforeOperation(document, options, randomId));
  }

  on("updateActor", (actor, changes, options = {}, userId = "") => {
    emitAfterCommit(classifyActorUpdate(actor, changes, snapshotOptions(actor, options)), actor, options, userId);
  });
  on("createItem", (item, options = {}, userId = "") => emitAfterCommit(classifyItemCreate(item), item, options, userId));
  on("updateItem", (item, changes, options = {}, userId = "") => {
    emitAfterCommit(classifyItemUpdate(item, changes, snapshotOptions(item, options)), item, options, userId);
  });
  on("deleteItem", (item, options = {}, userId = "") => {
    emitAfterCommit(classifyItemDelete(item, { before: getBeforeSnapshot(item, options) }), item, options, userId);
  });
  on("createActiveEffect", (effect, options = {}, userId = "") => {
    emitAfterCommit(classifyActiveEffectCreate(effect, options), effect, options, userId);
  });
  on("updateActiveEffect", (effect, changes, options = {}, userId = "") => {
    emitAfterCommit(classifyActiveEffectUpdate(effect, changes, { ...snapshotOptions(effect, options), options }), effect, options, userId);
  });
  on("deleteActiveEffect", (effect, options = {}, userId = "") => {
    emitAfterCommit(classifyActiveEffectDelete(effect, { before: getBeforeSnapshot(effect, options), options }), effect, options, userId);
  });
  on("createCombat", (combat, options = {}, userId = "") => emitAfterCommit(classifyCombatCreate(combat), combat, options, userId));
  on("updateCombat", (combat, changes, options = {}, userId = "") => {
    emitAfterCommit(classifyCombatUpdate(combat, changes, snapshotOptions(combat, options)), combat, options, userId);
  });
  on("deleteCombat", (combat, options = {}, userId = "") => {
    emitAfterCommit(classifyCombatDelete(combat, { before: getBeforeSnapshot(combat, options) }), combat, options, userId);
  });
  on("createCombatant", (combatant, options = {}, userId = "") => {
    emitAfterCommit(classifyCombatantCreate(combatant), combatant, options, userId);
  });
  on("updateCombatant", (combatant, changes, options = {}, userId = "") => {
    emitAfterCommit(classifyCombatantUpdate(combatant, changes, snapshotOptions(combatant, options)), combatant, options, userId);
  });
  on("deleteCombatant", (combatant, options = {}, userId = "") => {
    emitAfterCommit(classifyCombatantDelete(combatant, { before: getBeforeSnapshot(combatant, options) }), combatant, options, userId);
  });

  function emitAfterCommit(events, document, options, userId) {
    if (!events.length || !isActiveGM()) return;
    const base = ensureOccurrenceBase(options, randomId);
    const chainRef = options?.chainRef ?? options?.falloutMawSystemEventChainRef ?? null;
    const sceneUuid = getSceneUuid(document);
    const combatUuid = getCombatUuid(document);
    void emitDescriptors(events, {
      withRoot,
      base,
      chainRef,
      sceneUuid,
      combatUuid,
      requesterId: userId,
      logger
    });
  }

  return Object.freeze(registrations);
}

export function captureDocumentSnapshot(document) {
  if (!document) return null;
  const source = cloneJson(document.toObject?.(false) ?? document._source ?? document) ?? {};
  const currentCombatant = participantForCombatant(document.combatant);
  return {
    source,
    meta: {
      uuid: String(document.uuid ?? ""),
      documentName: String(document.documentName ?? document.constructor?.documentName ?? ""),
      statuses: normalizeStringArray(document.statuses ?? source.statuses),
      started: document.started === undefined ? undefined : Boolean(document.started),
      currentCombatant
    }
  };
}

export function flattenDocumentChanges(changes = {}) {
  return flattenChanges(changes);
}

export function isManagedReactionOperation(options = {}) {
  return MANAGED_REACTION_OPTIONS.some(key => options?.[key] === true);
}

async function emitDescriptors(events, { withRoot, base, chainRef, sceneUuid, combatUuid, requesterId, logger }) {
  try {
    await withRoot({
      kind: "documentCommit",
      operationId: `document:${base}`,
      chainRef,
      sceneUuid,
      combatUuid,
      data: requesterId ? { documentRequesterId: String(requesterId) } : {}
    }, async scope => {
      for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        await scope.emit(event.key, event.data, {
          occurrenceKey: `${base}:${event.suffix}:${index}`,
          source: event.source,
          target: event.target,
          related: event.related,
          participants: {
            source: event.source,
            target: event.target,
            related: event.related
          },
          before: event.before,
          after: event.after,
          delta: event.delta
        });
      }
    });
  } catch (error) {
    logger?.warn?.("fallout-maw | Failed to dispatch committed document events.", error);
  }
}

function createEventDescriptor(path, context, paths = [], extra = {}) {
  const normalizedPaths = Array.from(new Set(paths)).sort();
  const before = focusSnapshot(context.previous, normalizedPaths);
  const after = focusSnapshot(context.current, normalizedPaths);
  const delta = focusDelta(context.flat, normalizedPaths);
  const data = {
    ...context.data,
    ...extra.data,
    changedPaths: normalizedPaths
  };
  return {
    key: `${SYSTEM_EVENT_PREFIX}${path}`,
    suffix: `${path}:${extra.data?.resourceKey ?? extra.data?.needKey ?? extra.data?.currencyKey ?? extra.data?.limbKey ?? extra.data?.statusId ?? "document"}`,
    data: cloneJson(data) ?? {},
    source: cloneJson(extra.source ?? context.source) ?? null,
    target: cloneJson(extra.target ?? context.target) ?? null,
    related: cloneJson(extra.related ?? context.related) ?? [],
    before,
    after,
    delta
  };
}

function emitPathEvent(events, claimed, context, path, paths, extra = {}) {
  const unclaimed = Array.from(new Set(paths)).filter(entry => !claimed.has(entry));
  if (!unclaimed.length) return;
  for (const entry of unclaimed) claimed.add(entry);
  events.push(createEventDescriptor(path, context, unclaimed, extra));
}

function itemContext(item, actor, previous, current, flat) {
  const target = participantForActor(actor, item);
  return {
    document: item,
    source: participantForItem(item, actor),
    target,
    data: {
      actorUuid: String(actor?.uuid ?? ""),
      itemUuid: String(item?.uuid ?? ""),
      itemId: String(item?.id ?? item?._id ?? ""),
      itemType: String(item?.type ?? "")
    },
    previous: normalizeSnapshot(previous),
    current: normalizeSnapshot(current),
    flat
  };
}

function effectContext(effect, actor, previous, current, flat) {
  return {
    document: effect,
    source: participantForEffectOrigin(effect, actor),
    target: participantForActor(actor),
    data: {
      actorUuid: String(actor?.uuid ?? ""),
      effectUuid: String(effect?.uuid ?? ""),
      effectId: String(effect?.id ?? effect?._id ?? ""),
      origin: String(effect?.origin ?? readSnapshotPath(current ?? previous, "origin") ?? "")
    },
    previous: normalizeSnapshot(previous),
    current: normalizeSnapshot(current),
    flat
  };
}

function combatContext(combat, previous, current, flat) {
  return {
    document: combat,
    data: {
      combatUuid: String(combat?.uuid ?? ""),
      combatId: String(combat?.id ?? combat?._id ?? "")
    },
    previous: normalizeSnapshot(previous),
    current: normalizeSnapshot(current),
    flat
  };
}

function combatantContext(combatant, previous, current, flat) {
  return {
    document: combatant,
    target: participantForCombatant(combatant),
    data: {
      combatUuid: String(combatant?.combat?.uuid ?? combatant?.parent?.uuid ?? ""),
      combatantUuid: String(combatant?.uuid ?? ""),
      combatantId: String(combatant?.id ?? combatant?._id ?? "")
    },
    previous: normalizeSnapshot(previous),
    current: normalizeSnapshot(current),
    flat
  };
}

function participantForActor(actor, item = null) {
  if (!actor) return null;
  return compactParticipant({
    actorUuid: actor.uuid,
    tokenUuid: actor.token?.uuid ?? actor.token?.document?.uuid,
    itemUuid: item?.uuid
  });
}

function participantForItem(item, actor = getOwningActor(item)) {
  return compactParticipant({
    actorUuid: actor?.uuid,
    tokenUuid: actor?.token?.uuid ?? actor?.token?.document?.uuid,
    itemUuid: item?.uuid
  });
}

function participantForCombatant(combatant) {
  if (!combatant) return null;
  return compactParticipant({
    actorUuid: combatant.actor?.uuid,
    tokenUuid: combatant.token?.uuid ?? combatant.token?.document?.uuid ?? combatant.tokenUuid
  });
}

function participantForEffectOrigin(effect, actor) {
  const origin = String(effect?.origin ?? "");
  const itemUuid = origin.includes(".Item.") ? origin : "";
  return compactParticipant({ actorUuid: actor?.uuid, itemUuid });
}

function compactParticipant(value = {}) {
  const result = {
    actorUuid: String(value.actorUuid ?? "").trim(),
    tokenUuid: String(value.tokenUuid ?? "").trim(),
    itemUuid: String(value.itemUuid ?? "").trim()
  };
  return Object.values(result).some(Boolean) ? result : null;
}

function getOwningActor(document) {
  const direct = document?.actor ?? document?.parent;
  if (direct?.documentName === "Actor" || direct?.constructor?.documentName === "Actor") return direct;
  if (direct?.uuid && (direct?.system?.resources || direct?.items || direct?.type === "character" || direct?.type === "creature")) return direct;
  return null;
}

function snapshotOptions(document, options) {
  return {
    before: getBeforeSnapshot(document, options),
    after: captureDocumentSnapshot(document)
  };
}

function captureBeforeOperation(document, options = {}, randomId = defaultRandomId) {
  if (!document || !options || typeof options !== "object") return;
  const key = documentSnapshotKey(document);
  const snapshots = isPlainObject(options[BEFORE_SNAPSHOTS_OPTION]) ? options[BEFORE_SNAPSHOTS_OPTION] : {};
  snapshots[key] = captureDocumentSnapshot(document);
  options[BEFORE_SNAPSHOTS_OPTION] = snapshots;
  ensureOccurrenceBase(options, randomId);
}

function getBeforeSnapshot(document, options = {}) {
  return options?.[BEFORE_SNAPSHOTS_OPTION]?.[documentSnapshotKey(document)] ?? null;
}

function documentSnapshotKey(document) {
  return String(document?.uuid ?? `${document?.documentName ?? document?.constructor?.documentName ?? "Document"}.${document?.id ?? document?._id ?? ""}`);
}

function ensureOccurrenceBase(options = {}, randomId = defaultRandomId) {
  if (!options || typeof options !== "object") return String(randomId());
  const existing = String(options[OCCURRENCE_BASE_OPTION] ?? "").trim();
  if (existing) return existing;
  const created = String(randomId());
  options[OCCURRENCE_BASE_OPTION] = created;
  return created;
}

function normalizeSnapshot(snapshot) {
  if (!snapshot) return null;
  if (Object.hasOwn(snapshot, "source") && Object.hasOwn(snapshot, "meta")) return cloneJson(snapshot);
  return { source: cloneJson(snapshot) ?? {}, meta: {} };
}

function readSnapshotPath(snapshot, path) {
  const normalized = normalizeSnapshot(snapshot);
  if (!normalized) return undefined;
  return getPath(normalized.source, path);
}

function snapshotStatuses(snapshot) {
  const normalized = normalizeSnapshot(snapshot);
  return normalizeStringArray(normalized?.meta?.statuses ?? getPath(normalized?.source, "statuses"));
}

function snapshotCurrentCombatant(snapshot) {
  const normalized = normalizeSnapshot(snapshot);
  return compactParticipant(normalized?.meta?.currentCombatant ?? {});
}

function focusSnapshot(snapshot, paths) {
  if (!snapshot) return null;
  if (!paths.length) return {};
  return Object.fromEntries(paths.map(path => [path, cloneJson(readSnapshotPath(snapshot, path)) ?? null]));
}

function focusDelta(flat, paths) {
  if (!paths.length) return {};
  return Object.fromEntries(paths.map(path => [path, cloneJson(flat[path]) ?? null]));
}

function flattenChanges(changes = {}) {
  const result = {};
  walk(changes, "");
  return result;

  function walk(value, prefix) {
    if (isPlainObject(value) && Object.keys(value).length) {
      for (const [key, child] of Object.entries(value)) {
        if (key === "_id") continue;
        const normalizedKey = key.startsWith("-=") ? key.slice(2) : key;
        const next = prefix ? `${prefix}.${normalizedKey}` : normalizedKey;
        if (key.includes(".")) walk(child, prefix ? `${prefix}.${canonicalizePath(key)}` : canonicalizePath(key));
        else walk(child, next);
      }
      return;
    }
    if (prefix) result[canonicalizePath(prefix)] = cloneJson(value) ?? null;
  }
}

function canonicalizePath(path) {
  return String(path ?? "").replace(/\.-=/gu, ".").replace(/^-=/u, "");
}

function groupPaths(paths, segmentIndex) {
  const groups = new Map();
  for (const path of paths) {
    const key = path.split(".")[segmentIndex] ?? "";
    if (!key) continue;
    const entries = groups.get(key) ?? [];
    entries.push(path);
    groups.set(key, entries);
  }
  return groups;
}

function pathMatchesRoot(root) {
  return path => path === root || path.startsWith(`${root}.`);
}

function isAbilityTogglePath(path) {
  if ([
    "system.active",
    "system.enabled",
    "system.activation.enabled",
    "system.use.enabled",
    "flags.fallout-maw.active"
  ].some(root => pathMatchesRoot(root)(path))) return true;
  return path.startsWith("flags.fallout-maw.abilityFixedFunctionState.") && path.endsWith(".active");
}

function hasDiseaseImmunity(snapshot) {
  return Boolean(
    readSnapshotPath(snapshot, "flags.fallout-maw.diseaseImmunity")
    || readSnapshotPath(snapshot, "flags.fallout-maw.kind") === "diseaseImmunity"
  );
}

function isCombatStarted(snapshot, document = null) {
  const normalized = normalizeSnapshot(snapshot);
  const explicit = normalized?.meta?.started;
  if (explicit !== undefined) return Boolean(explicit);
  if (document?.started !== undefined && snapshot === null) return Boolean(document.started);
  return Number(readSnapshotPath(normalized, "round")) > 0;
}

function getPath(object, path) {
  let current = object;
  for (const segment of String(path ?? "").split(".")) {
    if (!segment) continue;
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = current[segment];
  }
  return current;
}

function getSceneUuid(document) {
  return String(
    document?.scene?.uuid
    ?? document?.combat?.scene?.uuid
    ?? document?.parent?.scene?.uuid
    ?? document?.token?.parent?.uuid
    ?? document?.parent?.parent?.uuid
    ?? ""
  );
}

function getCombatUuid(document) {
  return String(
    document?.documentName === "Combat" ? document.uuid
      : document?.combat?.uuid ?? (document?.parent?.documentName === "Combat" ? document.parent.uuid : "")
  );
}

function defaultIsActiveGM() {
  const activeGM = globalThis.game?.users?.activeGM;
  return Boolean(activeGM?.id && globalThis.game?.user?.id === activeGM.id);
}

function defaultRandomId() {
  return String(globalThis.foundry?.utils?.randomID?.() ?? globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);
}

function normalizeStringArray(value) {
  const entries = value instanceof Set ? Array.from(value) : Array.isArray(value) ? value : [];
  return Array.from(new Set(entries.map(entry => String(entry ?? "").trim()).filter(Boolean))).sort();
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  try {
    return structuredClone(value);
  } catch (_error) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_jsonError) {
      return null;
    }
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
