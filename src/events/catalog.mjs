export const SYSTEM_EVENT_CATALOG_VERSION = 1;

const EMPTY_PATCH_PATHS = Object.freeze([]);
const ALL_DATA_PATCH_PATHS = Object.freeze(["/data/*"]);
const DEFAULT_ROLES = Object.freeze(["subject"]);

const EVENT_PATCH_PATHS = Object.freeze({
  "combat.grapple.modifiers": ALL_DATA_PATCH_PATHS,
  "weapon.action.modifiers": ALL_DATA_PATCH_PATHS,
  "weapon.attack.duplicateRequested": ALL_DATA_PATCH_PATHS,
  "damage.mitigation.calculated": ALL_DATA_PATCH_PATHS
});

const NON_TARGET_ATOMIC_EVENT_PATHS = new Set([
  "skill.batch.resolved",
  "damage.batch.resolved",
  "repair.batch.resolved"
]);

function freezeRegistry(entries, localizationSection, { descriptions = false } = {}) {
  return Object.freeze(Object.fromEntries(entries.map(([key, values = {}]) => [key, Object.freeze({
    key,
    labelKey: `FALLOUTMAW.Events.${localizationSection}.${key}.Label`,
    ...(descriptions ? { descriptionKey: `FALLOUTMAW.Events.${localizationSection}.${key}.Description` } : {}),
    ...values
  })])));
}

export const SYSTEM_EVENT_PHASES = freezeRegistry([
  ["pre", {
    capabilities: Object.freeze(["observe", "react", "patch", "cancelCurrent", "cancelRemaining"]),
    selectable: true,
    awaitable: true
  }],
  ["gate", {
    capabilities: Object.freeze(["observe", "react", "cancelCurrent", "cancelRemaining"]),
    selectable: true,
    awaitable: true
  }],
  ["query", {
    capabilities: Object.freeze(["observe", "patch"]),
    selectable: false,
    awaitable: false
  }],
  ["enginePre", {
    capabilities: Object.freeze(["observe", "cancelCurrent"]),
    selectable: false,
    awaitable: false
  }],
  ["committed", {
    capabilities: Object.freeze(["observe", "react"]),
    selectable: true,
    awaitable: false
  }],
  ["transition", {
    capabilities: Object.freeze(["observe", "react"]),
    selectable: true,
    awaitable: false
  }]
], "Phases", { descriptions: true });

const PHASE_ALIASES = Object.freeze({
  post: "committed",
  syncPre: "enginePre"
});

const EVENT_PHASE_OVERRIDES = Object.freeze({
  "weapon.attack.damagePrepared": "gate"
});

const NON_SELECTABLE_EVENT_PATHS = new Set([
  "combat.reaction.requested",
  "combat.reaction.resolved",
  "movement.token.interruptionRequested"
]);

export const SYSTEM_EVENT_GROUPS = freezeRegistry([
  ["actor"],
  ["skill"],
  ["ability"],
  ["research"],
  ["progression"],
  ["combat"],
  ["weapon"],
  ["damage"],
  ["item"],
  ["inventory"],
  ["craft"],
  ["repair"],
  ["medicine"],
  ["hacking"],
  ["butchering"],
  ["movement"],
  ["environment"],
  ["stealth"],
  ["vision"],
  ["trap"],
  ["globalMap"],
  ["worldTime"],
  ["camp"],
  ["travel"]
], "Groups");

export const SYSTEM_EVENT_ROLES = freezeRegistry([
  ["subject"],
  ["source"],
  ["target"],
  ["initiator"],
  ["recipient"],
  ["attacker"],
  ["defender"],
  ["observer"],
  ["observed"],
  ["healer"],
  ["patient"],
  ["vehicle"],
  ["passenger"]
], "Roles");

export const SYSTEM_EVENT_SUBJECTS = freezeRegistry([
  ["actor"],
  ["item"],
  ["activeEffect"],
  ["combat"],
  ["combatant"],
  ["resource"],
  ["roll"],
  ["workflow"],
  ["token"],
  ["region"],
  ["trap"],
  ["scene"],
  ["camp"],
  ["travelGroup"],
  ["worldTime"],
  ["location"],
  ["currency"]
], "Subjects");

function eventLocalizationStem(path) {
  return path.split(".").map(segment => `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`).join("");
}

const EVENT_DEFINITIONS = Object.freeze([
  // Actor state.
  ["actor.health.changed", "actor", "transition", "actor"],
  ["actor.resource.changed", "actor", "transition", "resource"],
  ["actor.need.changed", "actor", "transition", "resource"],
  ["actor.currency.changed", "actor", "transition", "currency"],
  ["actor.experience.changed", "actor", "transition", "resource"],
  ["actor.level.changed", "actor", "transition", "actor"],
  ["actor.limb.changed", "actor", "transition", "actor"],
  ["actor.limb.destroyed", "actor", "transition", "actor"],
  ["actor.limb.restored", "actor", "transition", "actor"],
  ["actor.effect.applied", "actor", "transition", "activeEffect"],
  ["actor.effect.changed", "actor", "transition", "activeEffect"],
  ["actor.effect.removed", "actor", "transition", "activeEffect"],
  ["actor.status.gained", "actor", "transition", "activeEffect"],
  ["actor.status.lost", "actor", "transition", "activeEffect"],
  ["actor.trauma.acquired", "actor", "transition", "item"],
  ["actor.trauma.recovered", "actor", "transition", "item"],
  ["actor.disease.acquired", "actor", "transition", "item"],
  ["actor.disease.stageChanged", "actor", "transition", "item"],
  ["actor.disease.recovered", "actor", "transition", "item"],
  ["actor.disease.immunityGained", "actor", "transition", "activeEffect"],
  ["actor.state.changed", "actor", "transition", "actor"],

  // Rolls, abilities, research, and progression.
  ["skill.check.beforeRoll", "skill", "pre", "roll"],
  ["skill.check.resolved", "skill", "post", "roll"],
  ["skill.batch.resolved", "skill", "post", "roll"],
  ["ability.acquired", "ability", "transition", "item"],
  ["ability.removed", "ability", "transition", "item"],
  ["ability.use.before", "ability", "pre", "workflow", ["initiator"]],
  ["ability.use.resolved", "ability", "post", "workflow", ["initiator"]],
  ["ability.toggle.changed", "ability", "transition", "item"],
  ["ability.application.before", "ability", "pre", "workflow", ["source", "target"]],
  ["ability.application.resolved", "ability", "post", "workflow", ["source", "target"]],
  ["ability.cooldown.started", "ability", "post", "activeEffect"],
  ["ability.cooldown.refreshed", "ability", "post", "activeEffect"],
  ["ability.cooldown.ended", "ability", "transition", "activeEffect"],
  ["ability.aura.entered", "ability", "transition", "activeEffect", ["source", "target"]],
  ["ability.aura.left", "ability", "transition", "activeEffect", ["source", "target"]],
  ["research.started", "research", "post", "workflow"],
  ["research.progressed", "research", "post", "workflow"],
  ["research.completed", "research", "post", "workflow"],
  ["research.cancelled", "research", "post", "workflow"],
  ["organismDevelopment.gained", "progression", "post", "actor"],
  ["organismDevelopment.upgraded", "progression", "post", "actor"],
  ["actor.advancement.applied", "progression", "post", "actor"],
  ["actor.generated", "progression", "post", "actor"],
  ["actor.structure.changed", "progression", "post", "actor"],
  ["actor.recipe.learned", "progression", "post", "actor"],

  // Combat lifecycle and maneuvers.
  ["combat.started", "combat", "post", "combat"],
  ["combat.ended", "combat", "post", "combat"],
  ["combat.combatant.added", "combat", "transition", "combatant"],
  ["combat.combatant.removed", "combat", "transition", "combatant"],
  ["combat.round.changed", "combat", "post", "combat"],
  ["combat.initiative.rolled", "combat", "post", "combatant"],
  ["combat.turn.beforeEnd", "combat", "gate", "combatant"],
  ["combat.turn.ended", "combat", "post", "combatant"],
  ["combat.turn.beforeStart", "combat", "gate", "combatant"],
  ["combat.turn.started", "combat", "post", "combatant"],
  ["combat.turn.blocked", "combat", "transition", "combatant"],
  ["combat.turn.unblocked", "combat", "transition", "combatant"],
  ["combat.combatant.defeated", "combat", "transition", "combatant"],
  ["combat.combatant.restored", "combat", "transition", "combatant"],
  ["combat.resource.beforeSpend", "combat", "pre", "resource"],
  ["combat.resource.spent", "combat", "post", "resource"],
  ["combat.resource.restored", "combat", "post", "resource"],
  ["combat.reaction.requested", "combat", "gate", "workflow", ["initiator", "recipient"]],
  ["combat.reaction.resolved", "combat", "post", "workflow", ["initiator", "recipient"]],
  ["combat.finishingBlow.resolved", "combat", "post", "workflow", ["attacker", "defender"]],
  ["combat.push.before", "combat", "pre", "workflow", ["initiator", "target"]],
  ["combat.push.resolved", "combat", "post", "workflow", ["initiator", "target"]],
  ["combat.grapple.before", "combat", "pre", "workflow", ["initiator", "target"]],
  ["combat.grapple.modifiers", "combat", "query", "workflow", ["initiator", "target"]],
  ["combat.grapple.started", "combat", "post", "workflow", ["initiator", "target"]],
  ["combat.grapple.ended", "combat", "post", "workflow", ["source", "target"]],
  ["combat.grapple.escape.resolved", "combat", "post", "workflow", ["initiator", "target"]],
  ["combat.grapple.repositioned", "combat", "post", "token", ["source", "target"]],
  ["combat.knockback.resolved", "combat", "post", "token", ["source", "target"]],

  // Weapon actions and damage.
  ["weapon.action.modifiers", "weapon", "query", "workflow"],
  ["weapon.action.before", "weapon", "pre", "workflow", ["initiator"]],
  ["weapon.action.resolved", "weapon", "post", "workflow", ["initiator"]],
  ["weapon.reload.before", "weapon", "pre", "item", ["initiator"]],
  ["weapon.reload.resolved", "weapon", "post", "item", ["initiator"]],
  ["weapon.delayedVolley.armed", "weapon", "post", "item", ["attacker", "target"]],
  ["weapon.delayedVolley.detonated", "weapon", "post", "workflow", ["attacker", "target"]],
  ["weapon.attack.targeted", "weapon", "gate", "workflow", ["attacker", "defender"]],
  ["weapon.attack.committed", "weapon", "gate", "workflow", ["attacker", "defender"]],
  ["weapon.attack.aimedLimbSelected", "weapon", "gate", "workflow", ["attacker", "defender"]],
  ["weapon.attack.checkResolved", "weapon", "post", "roll", ["attacker", "defender"]],
  ["weapon.attack.damagePrepared", "weapon", "post", "workflow", ["attacker", "defender"]],
  ["weapon.attack.duplicateRequested", "weapon", "query", "workflow", ["attacker", "defender"]],
  ["weapon.attack.resolved", "weapon", "post", "workflow", ["attacker", "defender"]],
  ["damage.mitigation.calculated", "damage", "query", "workflow", ["source", "target"]],
  ["damage.beforeApply", "damage", "pre", "workflow", ["source", "target"]],
  ["healing.beforeApply", "damage", "pre", "workflow", ["healer", "patient"]],
  ["damage.resolved", "damage", "post", "workflow", ["source", "target"]],
  ["healing.resolved", "damage", "post", "workflow", ["healer", "patient"]],
  ["damage.batch.resolved", "damage", "post", "workflow", ["source", "target"]],
  ["damage.periodicTick.resolved", "damage", "post", "workflow", ["source", "target"]],
  ["healing.periodicTick.resolved", "damage", "post", "workflow", ["healer", "patient"]],
  ["damage.lethal.pending", "damage", "gate", "workflow", ["source", "target"]],
  ["damage.lethal.prevented", "damage", "post", "workflow", ["source", "target"]],
  ["damage.shock.resolved", "damage", "post", "roll", ["source", "target"]],

  // Items, inventory, and gameplay services.
  ["item.use.before", "item", "pre", "item", ["initiator"]],
  ["item.use.resolved", "item", "post", "item", ["initiator"]],
  ["item.oneTimeUse.resolved", "item", "post", "item", ["initiator"]],
  ["item.needChange.resolved", "item", "post", "item", ["initiator"]],
  ["medicine.firstAid.resolved", "medicine", "post", "workflow", ["healer", "patient"]],
  ["item.lightSource.changed", "item", "post", "item"],
  ["item.energyConsumer.changed", "item", "post", "item"],
  ["item.energySource.installed", "item", "post", "item", ["source", "target"]],
  ["item.energySource.extracted", "item", "post", "item", ["source", "target"]],
  ["inventory.item.added", "inventory", "transition", "item", ["recipient"]],
  ["inventory.item.removed", "inventory", "transition", "item", ["source"]],
  ["inventory.item.quantityChanged", "inventory", "transition", "item"],
  ["inventory.item.resourceChanged", "inventory", "transition", "item"],
  ["inventory.item.conditionChanged", "inventory", "transition", "item"],
  ["inventory.item.placementChanged", "inventory", "transition", "item"],
  ["inventory.item.equipped", "inventory", "transition", "item"],
  ["inventory.item.unequipped", "inventory", "transition", "item"],
  ["inventory.item.state.changed", "inventory", "transition", "item"],
  ["inventory.item.transfer.before", "inventory", "pre", "item", ["source", "recipient"]],
  ["inventory.item.transfer.transferred", "inventory", "post", "item", ["source", "recipient"]],
  ["inventory.currency.transfer.before", "inventory", "pre", "currency", ["source", "recipient"]],
  ["inventory.currency.transfer.transferred", "inventory", "post", "currency", ["source", "recipient"]],
  ["inventory.trade.before", "inventory", "pre", "workflow", ["source", "recipient"]],
  ["inventory.trade.resolved", "inventory", "post", "workflow", ["source", "recipient"]],
  ["inventory.item.split", "inventory", "post", "item"],
  ["inventory.item.stacked", "inventory", "post", "item"],
  ["inventory.item.rotated", "inventory", "post", "item"],
  ["inventory.item.dropped", "inventory", "post", "item", ["source"]],
  ["inventory.item.pickedUp", "inventory", "post", "item", ["source", "recipient"]],
  ["inventory.item.thrown", "inventory", "post", "item", ["source", "target"]],
  ["inventory.item.retrieved", "inventory", "post", "item", ["source", "recipient"]],
  ["craft.create.before", "craft", "pre", "workflow", ["initiator"]],
  ["craft.create.resolved", "craft", "post", "workflow", ["initiator"]],
  ["craft.disassemble.before", "craft", "pre", "workflow", ["initiator"]],
  ["craft.disassemble.resolved", "craft", "post", "workflow", ["initiator"]],
  ["repair.before", "repair", "pre", "workflow", ["initiator", "target"]],
  ["repair.resolved", "repair", "post", "workflow", ["initiator", "target"]],
  ["repair.batch.resolved", "repair", "post", "workflow", ["initiator", "target"]],
  ["medicine.treatment.before", "medicine", "pre", "workflow", ["healer", "patient"]],
  ["medicine.treatment.resolved", "medicine", "post", "workflow", ["healer", "patient"]],
  ["medicine.implant.installed", "medicine", "post", "item", ["healer", "patient"]],
  ["medicine.implant.removed", "medicine", "post", "item", ["healer", "patient"]],
  ["medicine.prosthesis.installed", "medicine", "post", "item", ["healer", "patient"]],
  ["medicine.prosthesis.removed", "medicine", "post", "item", ["healer", "patient"]],
  ["hacking.before", "hacking", "pre", "workflow", ["initiator", "target"]],
  ["hacking.resolved", "hacking", "post", "workflow", ["initiator", "target"]],
  ["butchering.before", "butchering", "pre", "workflow", ["initiator", "target"]],
  ["butchering.resolved", "butchering", "post", "workflow", ["initiator", "target"]],

  // Movement, environment, stealth, physical sight, and traps.
  ["movement.token.before", "movement", "syncPre", "token"],
  ["movement.token.beforeStart", "movement", "gate", "token"],
  ["movement.token.leavingAdjacency", "movement", "gate", "token", ["source", "target"]],
  ["movement.token.interruptionRequested", "movement", "gate", "token"],
  ["movement.token.interrupted", "movement", "post", "token"],
  ["movement.token.completed", "movement", "post", "token"],
  ["movement.token.stopped", "movement", "post", "token"],
  ["movement.token.undone", "movement", "post", "token"],
  ["region.token.entered", "environment", "transition", "region", ["target"]],
  ["region.token.left", "environment", "transition", "region", ["target"]],
  ["actor.posture.changed", "movement", "transition", "actor"],
  ["actor.cover.changed", "environment", "transition", "actor"],
  ["vehicle.passenger.boarded", "movement", "post", "token", ["vehicle", "passenger"]],
  ["vehicle.passenger.exited", "movement", "post", "token", ["vehicle", "passenger"]],
  ["vehicle.passenger.seatChanged", "movement", "post", "token", ["vehicle", "passenger"]],
  ["stealth.enter.before", "stealth", "pre", "actor"],
  ["stealth.enter.entered", "stealth", "post", "actor"],
  ["stealth.reveal.before", "stealth", "gate", "actor"],
  ["stealth.reveal.revealed", "stealth", "post", "actor"],
  ["vision.target.gained", "vision", "transition", "token", ["observer", "observed"]],
  ["vision.target.lost", "vision", "transition", "token", ["observer", "observed"]],
  ["environment.lightNetwork.changed", "environment", "post", "scene"],
  ["trap.place.before", "trap", "pre", "trap", ["initiator"]],
  ["trap.placed", "trap", "post", "trap", ["initiator"]],
  ["trap.detection.resolved", "trap", "post", "trap", ["observer", "target"]],
  ["trap.trigger.before", "trap", "gate", "trap", ["source", "target"]],
  ["trap.trigger.triggered", "trap", "post", "trap", ["source", "target"]],
  ["trap.disarm.before", "trap", "pre", "trap", ["initiator", "target"]],
  ["trap.disarm.resolved", "trap", "post", "trap", ["initiator", "target"]],
  ["trap.rearmed", "trap", "post", "trap"],
  ["trap.pickup.before", "trap", "pre", "trap", ["initiator"]],
  ["trap.pickedUp", "trap", "post", "trap", ["initiator"]],
  ["trap.removed", "trap", "post", "trap"],
  ["globalMap.location.discovered", "globalMap", "transition", "location"],
  ["globalMap.transition.discovered", "globalMap", "transition", "location"],
  ["globalMap.exit.discovered", "globalMap", "transition", "location"],

  // World time, needs, camps, and travel.
  ["world.time.beforeAdvance", "worldTime", "pre", "worldTime"],
  ["world.time.advanced", "worldTime", "post", "worldTime"],
  ["actor.need.thresholdEntered", "actor", "transition", "resource"],
  ["actor.need.thresholdLeft", "actor", "transition", "resource"],
  ["camp.started", "camp", "post", "camp"],
  ["camp.participantJoined", "camp", "post", "camp", ["recipient"]],
  ["camp.participantLeft", "camp", "post", "camp", ["source"]],
  ["camp.closed", "camp", "post", "camp"],
  ["camp.rest.before", "camp", "pre", "camp", ["initiator"]],
  ["camp.rest.completed", "camp", "post", "camp", ["initiator"]],
  ["travel.departure.before", "travel", "pre", "workflow", ["initiator"]],
  ["travel.departure.completed", "travel", "post", "workflow", ["initiator"]],
  ["travel.location.left", "travel", "transition", "location"],
  ["travel.arrival.pending", "travel", "post", "workflow"],
  ["travel.arrival.before", "travel", "pre", "workflow", ["initiator"]],
  ["travel.arrival.completed", "travel", "post", "workflow", ["initiator"]],
  ["travel.location.entered", "travel", "transition", "location"],
  ["travel.movement.completed", "travel", "post", "token"],
  ["travel.group.formed", "travel", "post", "travelGroup"],
  ["travel.group.memberJoined", "travel", "post", "travelGroup", ["recipient"]],
  ["travel.group.memberLeft", "travel", "post", "travelGroup", ["source"]],
  ["travel.group.disbanded", "travel", "post", "travelGroup"]
]);

function createEventDescriptor(definition) {
  const [path, group, phase, subject, roles = DEFAULT_ROLES] = definition;
  const key = `fallout-maw.${path}`;
  const normalizedPhase = EVENT_PHASE_OVERRIDES[path] ?? PHASE_ALIASES[phase] ?? phase;
  const phaseDescriptor = SYSTEM_EVENT_PHASES[normalizedPhase];
  if (!phaseDescriptor) throw new Error(`Unknown system event phase: ${normalizedPhase}`);
  if (!SYSTEM_EVENT_GROUPS[group]) throw new Error(`Unknown system event group: ${group}`);
  if (!SYSTEM_EVENT_SUBJECTS[subject]) throw new Error(`Unknown system event subject: ${subject}`);
  for (const role of roles) {
    if (!SYSTEM_EVENT_ROLES[role]) throw new Error(`Unknown system event role: ${role}`);
  }

  const localizationStem = eventLocalizationStem(path);
  return Object.freeze({
    key,
    catalogVersion: SYSTEM_EVENT_CATALOG_VERSION,
    group,
    groupLabelKey: SYSTEM_EVENT_GROUPS[group].labelKey,
    phase: normalizedPhase,
    capabilities: phaseDescriptor.capabilities,
    allowedPatchPaths: EVENT_PATCH_PATHS[path] ?? EMPTY_PATCH_PATHS,
    selectable: phaseDescriptor.selectable && !NON_SELECTABLE_EVENT_PATHS.has(path),
    targetAtomic: !NON_TARGET_ATOMIC_EVENT_PATHS.has(path)
      && roles.some(role => ["target", "defender", "patient", "observed", "recipient"].includes(role)),
    subject,
    roles: Object.freeze([...roles]),
    serialize: serializeSystemEventPayload,
    labelKey: `FALLOUTMAW.Events.Entries.${localizationStem}.Label`,
    descriptionKey: `FALLOUTMAW.Events.Entries.${localizationStem}.Description`
  });
}

export function serializeSystemEventPayload(value) {
  const normalized = value ?? {};
  assertSystemEventJsonValue(normalized);
  return JSON.parse(JSON.stringify(normalized));
}

function assertSystemEventJsonValue(value, ancestors = new Set(), path = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new TypeError(`Non-finite number is forbidden in a system-event payload at '${path}'.`);
  }
  if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new TypeError(`Non-JSON value is forbidden in a system-event payload at '${path}'.`);
  }
  if (typeof value !== "object") {
    throw new TypeError(`Unsupported value is forbidden in a system-event payload at '${path}'.`);
  }
  if (ancestors.has(value)) throw new TypeError(`Cyclic value is forbidden in a system-event payload at '${path}'.`);
  if (!Array.isArray(value) && !isPlainJsonObject(value)) {
    const kind = value?.constructor?.name || Object.prototype.toString.call(value);
    throw new TypeError(`${kind} is forbidden in a system-event payload at '${path}'.`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => assertSystemEventJsonValue(entry, ancestors, `${path}[${index}]`));
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      assertSystemEventJsonValue(entry, ancestors, `${path}.${key}`);
    }
  } finally {
    ancestors.delete(value);
  }
}

function isPlainJsonObject(value) {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export const SYSTEM_EVENT_CATALOG = Object.freeze(EVENT_DEFINITIONS.map(createEventDescriptor));

const duplicateKeys = SYSTEM_EVENT_CATALOG
  .map(event => event.key)
  .filter((key, index, keys) => keys.indexOf(key) !== index);
if (duplicateKeys.length) throw new Error(`Duplicate system event keys: ${duplicateKeys.join(", ")}`);

export const SYSTEM_EVENT_CATALOG_BY_KEY = Object.freeze(Object.fromEntries(
  SYSTEM_EVENT_CATALOG.map(event => [event.key, event])
));

const SELECTABLE_SYSTEM_EVENTS = Object.freeze(SYSTEM_EVENT_CATALOG.filter(event => event.selectable));

export function getSystemEventDescriptor(key) {
  if (typeof key !== "string") return null;
  return SYSTEM_EVENT_CATALOG_BY_KEY[key.trim()] ?? null;
}

export function getSelectableSystemEvents() {
  return SELECTABLE_SYSTEM_EVENTS;
}
