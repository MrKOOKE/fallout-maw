import { prepareEffectChangeForApplication } from "../utils/effect-change-values.mjs";
import { getActorItemsWithActiveHudModules } from "../utils/hud-active-items.mjs";
import { abilityConditionApplies } from "../abilities/evaluation.mjs";
import { getSystemEventDescriptor } from "./catalog.mjs";
import { createGenericEventReactionProvider } from "./event-reaction-provider.mjs";
import { createEventReactionEffectManager } from "./reaction-effects.mjs";
import { createFoundryReactionCostRegistry } from "./foundry-reaction-costs.mjs";

export function createFoundryEventReactionRuntime({
  registerRootCleanup = null,
  registerRootFinalizer = null,
  canReactToEvent = isCatalogEventReactionSelectable,
  resourceSettings = null,
  evaluateCostFormula = null,
  applyHealthCost = null,
  logger = console,
  warn = undefined
} = {}) {
  const costRegistry = createFoundryReactionCostRegistry({
    resourceSettings,
    evaluateCostFormula,
    applyHealthCost,
    logger
  });
  const effectManager = createEventReactionEffectManager({
    prepareChanges: (actor, changes) => (changes ?? []).map(change => (
      prepareEffectChangeForApplication(actor, change)
    )),
    logger
  });
  const provider = createGenericEventReactionProvider({
    costRegistry,
    effectManager,
    getItems: getActorItemsWithActiveHudModules,
    conditionEvaluator: abilityConditionApplies,
    registerRootCleanup,
    canReactToEvent,
    warn,
    logger
  });
  const unregisterRootFinalizer = registerEventReactionRootFinalizer(provider, registerRootFinalizer);
  return Object.freeze({ provider, costRegistry, effectManager, unregisterRootFinalizer });
}

function isCatalogEventReactionSelectable(envelope = {}) {
  return Boolean(getSystemEventDescriptor(String(envelope?.key ?? ""))?.selectable);
}

export function registerEventReactionRootFinalizer(provider, registerRootFinalizer = null) {
  if (!provider?.cleanupRoot || typeof registerRootFinalizer !== "function") return () => undefined;
  return registerRootFinalizer({
    id: "fallout-maw.eventReaction.cleanup",
    priority: 1000,
    finalize: ({ rootId }) => provider.cleanupRoot(rootId)
  });
}

export function registerEventReactionRecoveryHooks(provider, {
  getActiveRootIds = () => [],
  hooks = globalThis.Hooks,
  getActiveGM = () => globalThis.game?.users?.activeGM ?? null
} = {}) {
  if (!provider?.cleanupOrphans || !hooks?.once || !hooks?.on) return () => undefined;
  let activeGmId = "";
  const recover = async () => {
    const gm = getActiveGM();
    const nextId = String(gm?.id ?? "");
    if (!gm?.isSelf && !globalThis.game?.user?.isActiveGM) {
      activeGmId = nextId;
      return;
    }
    activeGmId = nextId;
    await provider.cleanupOrphans(await getActiveRootIds());
  };
  const readyId = hooks.once("ready", () => void recover());
  const updateUserId = hooks.on("updateUser", () => {
    const nextId = String(getActiveGM()?.id ?? "");
    if (nextId === activeGmId) return;
    globalThis.setTimeout(() => void recover(), 0);
  });
  return () => {
    hooks.off?.("ready", readyId);
    hooks.off?.("updateUser", updateUserId);
  };
}
