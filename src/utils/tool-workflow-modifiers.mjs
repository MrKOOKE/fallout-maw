const TOOL_CLASS_RANKS = Object.freeze({ D: 0, C: 1, B: 2, A: 3, S: 4 });
const providers = new Map();
let orderedProviders = Object.freeze([]);

/**
 * Register a synchronous provider for contextual tool modifiers.
 *
 * The factory runs once when a workflow creates its resolver, so a provider can
 * scan Actor items once and return a cheap function for every candidate or
 * repeated check in that workflow.
 */
export function registerToolWorkflowModifierProvider(id, factory, { priority = 0 } = {}) {
  const providerId = String(id ?? "").trim();
  if (!providerId) throw new TypeError("A tool-workflow modifier provider requires an id.");
  if (typeof factory !== "function") throw new TypeError("A tool-workflow modifier provider requires a factory.");

  const entry = {
    id: providerId,
    factory,
    priority: toFiniteNumber(priority)
  };
  providers.set(providerId, entry);
  orderedProviders = Object.freeze(
    Array.from(providers.values()).sort((left, right) => (
      left.priority - right.priority || left.id.localeCompare(right.id)
    ))
  );

  return () => {
    if (providers.get(providerId) !== entry) return false;
    providers.delete(providerId);
    orderedProviders = Object.freeze(
      Array.from(providers.values()).sort((left, right) => (
        left.priority - right.priority || left.id.localeCompare(right.id)
      ))
    );
    return true;
  };
}

/**
 * Prepare a resolver for one Actor and reuse it throughout a workflow.
 */
export function createToolWorkflowModifierResolver(actor) {
  const resolvers = [];
  for (const provider of orderedProviders) {
    const resolver = provider.factory(actor);
    if (typeof resolver === "function") resolvers.push({ id: provider.id, resolve: resolver });
  }

  if (!resolvers.length) return () => createEmptyToolWorkflowModifiers();
  return context => resolvePreparedToolWorkflowModifiers(resolvers, context);
}

/** Resolve modifiers for a single, non-repeating tool operation. */
export function resolveToolWorkflowModifiers(actor, context = {}) {
  return createToolWorkflowModifierResolver(actor)(context);
}

export function normalizeToolWorkflowContext(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    ...source,
    requester: String(source.requester ?? "").trim(),
    skillKey: String(source.skillKey ?? "").trim(),
    toolContext: normalizeToolWorkflowToolContext(source.toolContext)
  };
}

export function normalizeToolWorkflowToolContext(value = {}) {
  if (!value || typeof value !== "object") return null;
  const toolKey = String(value.toolKey ?? "").trim();
  if (!toolKey) return null;
  return {
    itemId: String(value.itemId ?? "").trim(),
    itemUuid: String(value.itemUuid ?? "").trim(),
    toolKey,
    toolClass: normalizeToolClass(value.toolClass),
    requiredClass: normalizeToolClass(value.requiredClass)
  };
}

export function isToolWorkflowClassCompatible(toolContext = null) {
  if (!toolContext?.toolKey) return false;
  return getToolClassRank(toolContext.toolClass) >= getToolClassRank(toolContext.requiredClass);
}

/** Match the exact class requested by a workflow-specific modifier. */
export function isToolWorkflowClassExact(toolContext = null) {
  if (!toolContext?.toolKey) return false;
  return normalizeToolClass(toolContext.toolClass) === normalizeToolClass(toolContext.requiredClass);
}

export function normalizeToolClass(value = "D") {
  const normalized = String(value ?? "D").trim().toUpperCase();
  return Object.hasOwn(TOOL_CLASS_RANKS, normalized) ? normalized : "D";
}

export function getToolClassRank(value = "D") {
  return TOOL_CLASS_RANKS[normalizeToolClass(value)];
}

/** Apply additive percentage points to the system's 100-based efficiency scale. */
export function applyToolWorkflowEfficiencyBonus(efficiency, percentBonus = 0) {
  return Math.max(0, toFiniteNumber(efficiency) + toFiniteNumber(percentBonus));
}

function resolvePreparedToolWorkflowModifiers(resolvers, context) {
  const normalizedContext = normalizeToolWorkflowContext(context);
  let skillBonus = 0;
  let efficiencyPercentBonus = 0;
  const sources = [];

  for (const provider of resolvers) {
    const result = provider.resolve(normalizedContext);
    const contributions = Array.isArray(result) ? result : [result];
    for (const contribution of contributions) {
      if (!contribution || typeof contribution !== "object") continue;
      const normalized = normalizeContribution(contribution, provider.id);
      if (!normalized.skillBonus && !normalized.efficiencyPercentBonus) continue;
      skillBonus += normalized.skillBonus;
      efficiencyPercentBonus += normalized.efficiencyPercentBonus;
      sources.push(normalized);
    }
  }

  return { skillBonus, efficiencyPercentBonus, sources };
}

function normalizeContribution(value, providerId) {
  return {
    source: String(value.source ?? providerId),
    label: String(value.label ?? value.source ?? providerId),
    skillBonus: toFiniteNumber(value.skillBonus),
    efficiencyPercentBonus: toFiniteNumber(value.efficiencyPercentBonus)
  };
}

function createEmptyToolWorkflowModifiers() {
  return { skillBonus: 0, efficiencyPercentBonus: 0, sources: [] };
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
