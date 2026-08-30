import { FALLOUT_MAW } from "../config/system-config.mjs";
import { getAbilityCatalog } from "../settings/accessors.mjs";
import {
  ABILITY_CONDITION_TYPES,
  ABILITY_FUNCTION_TYPES,
  ABILITY_SOURCE_FLAG,
  findAbilityInEvolutionFamily,
  getAbilitySourceId,
  normalizeAbilityFunctions,
  prepareAbilityItemData
} from "../settings/abilities.mjs";
import { hasEventReactionCondition } from "../events/event-reaction-schema.mjs";
import { escapeHtml } from "../utils/dom.mjs";
import { evaluateEffectChangeNumber } from "../utils/effect-change-values.mjs";
import { buildEffectKeyTokens } from "../utils/effect-key-tokens.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { evaluateActorFormula, formatActorFormulaForDisplay } from "../utils/actor-formulas.mjs";
import { getAbilityAcquisitionChanges } from "./evaluation.mjs";
import {
  ABILITY_CHANGE_SELECTION_MODES,
  formatLimitedChangeDisplayValue,
  isLimitedChangeSelectionCountValid,
  normalizeAbilityChangeSelectionMode,
  resolveLimitedChangeSet
} from "./limited-changes.mjs";
import { getResearchById } from "../research/storage.mjs";

const { DialogV2 } = foundry.applications.api;
const REWARD_SELECTION_ABORTED = Symbol("abilityRewardSelectionAborted");
const abilityGrantsInFlight = new WeakMap();

export function findCatalogAbility(sourceId = "", catalog = getAbilityCatalog()) {
  const normalizedSourceId = String(sourceId ?? "").trim();
  if (!normalizedSourceId) return null;
  for (const category of catalog.categories ?? []) {
    for (const rootAbility of category.abilities ?? []) {
      const entry = findAbilityInEvolutionFamily(rootAbility, normalizedSourceId);
      if (entry) return { ...entry, category };
    }
  }
  return null;
}

export function actorHasAbility(actor, sourceId = "") {
  const normalizedSourceId = String(sourceId ?? "").trim();
  if (!normalizedSourceId) return false;
  return actor?.items?.some?.(item => {
    if (item.type !== "ability") return false;
    if (getAbilitySourceId(item) === normalizedSourceId) return true;
    const source = item.getFlag?.(FALLOUT_MAW.id, ABILITY_SOURCE_FLAG)
      ?? item.flags?.[FALLOUT_MAW.id]?.[ABILITY_SOURCE_FLAG]
      ?? {};
    return String(source.evolutionRootId ?? "") === normalizedSourceId
      || (source.evolutionAncestorIds ?? []).some(id => String(id ?? "") === normalizedSourceId);
  }) ?? false;
}

export async function grantCatalogAbility(actor, sourceId = "", catalog = getAbilityCatalog()) {
  if (!actor || actorHasAbility(actor, sourceId)) return null;
  const entry = findCatalogAbility(sourceId, catalog);
  if (!entry) return null;
  const itemData = prepareCatalogAbilityItemData(entry);
  const result = await grantAbilityItemData(actor, itemData, { sourceId });
  return result.item;
}

export function prepareCatalogAbilityItemData(entry = {}) {
  if (!entry?.ability || !entry?.category) return null;
  return prepareAbilityItemData(entry.ability, {
    categoryId: entry.category.id,
    evolutionRootId: getEvolutionRootId(entry),
    evolutionParentIds: entry.incomingSourceIds,
    evolutionAncestorIds: entry.ancestorSourceIds
  });
}

export function hasUnsafeAbilityEvolutionAcquisitionChanges(
  actor,
  abilityOrData = {},
  parentSourceIds = [],
  { predecessor = null } = {}
) {
  const ownedPredecessor = predecessor ?? findOwnedEvolutionPredecessor(actor, parentSourceIds);
  if (!ownedPredecessor) return false;
  return Boolean(
    getAbilityAcquisitionChanges(ownedPredecessor).length
    || getAbilityAcquisitionChanges(abilityOrData).length
  );
}

/**
 * Run every intentional ability grant through the same pre-create pipeline.
 * The selected limited changes are persisted on the embedded Item, so passive
 * effect projection can never see the unselected catalog rows.
 */
export async function grantAbilityItemData(actor, itemData = {}, {
  sourceId = "",
  createOptions = {},
  limitContext = "ability grant change limit",
  evaluateLimit = null,
  chooseLimitedChanges = null
} = {}) {
  if (!actor || itemData?.type !== "ability") return { item: null, cancelled: false };

  const normalizedItemData = foundry.utils.deepClone(itemData);
  delete normalizedItemData._id;
  delete normalizedItemData.id;

  const resolvedSourceId = getRewardAbilitySourceId(normalizedItemData) || String(sourceId ?? "").trim();
  const evolution = resolveAbilityEvolutionGrant(normalizedItemData, resolvedSourceId);
  const lockSourceIds = evolution.isEvolution
    ? [resolvedSourceId, ...evolution.parentSourceIds]
    : [resolvedSourceId];
  return withAbilityGrantLock(actor, lockSourceIds, async () => {
    if (resolvedSourceId && actorHasAbility(actor, resolvedSourceId)) {
      return { item: null, cancelled: false };
    }

    if (evolution.isEvolution) {
      const predecessor = findOwnedEvolutionPredecessor(actor, evolution.parentSourceIds);
      const unsafeAcquisitionChanges = predecessor && hasUnsafeAbilityEvolutionAcquisitionChanges(
        actor,
        normalizedItemData,
        evolution.parentSourceIds,
        { predecessor }
      );
      if (!predecessor || unsafeAcquisitionChanges) {
        if (unsafeAcquisitionChanges) {
          ui.notifications.warn("Эволюция с изменениями при приобретении заблокирована: прежние изменения нельзя безопасно применить повторно.");
        }
        return { item: null, cancelled: false, blocked: true };
      }
      applyEvolutionSourceFlag(normalizedItemData, resolvedSourceId, evolution);

      const preparedItemData = await applyLimitedChangeSelectionsToGrant(normalizedItemData, actor, {
        limitContext,
        evaluateLimit,
        chooseLimitedChanges
      });
      if (!preparedItemData) return { item: null, cancelled: true };

      const predecessorId = String(predecessor.id ?? predecessor._id ?? "").trim();
      if (!predecessorId || typeof actor.updateEmbeddedDocuments !== "function") {
        return { item: null, cancelled: false, blocked: true };
      }
      const previousFlags = foundry.utils.deepClone(
        predecessor.toObject?.().flags ?? predecessor.flags ?? {}
      );
      const nextFlags = foundry.utils.deepClone(preparedItemData.flags ?? {});
      const mergedFlags = {
        ...previousFlags,
        ...nextFlags,
        // An evolution is a new ability definition. Preserve foreign module
        // namespaces, but never carry the predecessor's Fallout runtime state.
        [FALLOUT_MAW.id]: nextFlags[FALLOUT_MAW.id] ?? {}
      };
      const updates = await actor.updateEmbeddedDocuments("Item", [{
        ...preparedItemData,
        flags: mergedFlags,
        _id: predecessorId
      }], {
        ...createOptions,
        diff: false,
        recursive: false
      });
      return { item: updates?.[0] ?? null, cancelled: false };
    }

    const preparedItemData = await applyLimitedChangeSelectionsToGrant(normalizedItemData, actor, {
      limitContext,
      evaluateLimit,
      chooseLimitedChanges
    });
    if (!preparedItemData) return { item: null, cancelled: true };

    const created = await actor.createEmbeddedDocuments("Item", [preparedItemData], createOptions);
    const item = created?.[0] ?? null;
    await applyAbilityAcquisitionChanges(actor, item);
    return { item, cancelled: false };
  });
}

export async function completeAbilityResearch(actor, researchId = "", options = {}) {
  const research = getResearchById(actor?.system?.researches, researchId);
  if (!research || research.type !== "ability") return null;
  if (Number(research.progress) < Number(research.target)) return null;

  const created = await grantAbilityResearchReward(actor, research);
  if (created === REWARD_SELECTION_ABORTED) return {
    research,
    item: null,
    blocked: true
  };
  await actor.deleteResearch(researchId, {
    ...options,
    event: "completed",
    progressSource: String(options?.progressSource ?? "abilityResearchReward"),
    reason: String(options?.reason ?? "completed")
  });
  return {
    research,
    item: created
  };
}

export async function grantAbilityResearchReward(actor, research = {}) {
  if (!actor) return null;
  const sourceId = String(research?.sourceId ?? "").trim();
  if (sourceId && actorHasAbility(actor, sourceId)) return null;

  const itemData = getAbilityRewardItemData(research) ?? getCatalogAbilityRewardItemData(sourceId);
  if (!itemData) return null;
  const result = await grantAbilityItemData(actor, itemData, {
    sourceId,
    limitContext: "ability reward change limit"
  });
  if (result.cancelled || result.blocked) {
    if (result.cancelled) {
      ui.notifications.warn("Выбор изменений способности не завершён. Завершённое исследование оставлено без выдачи награды.");
    }
    return REWARD_SELECTION_ABORTED;
  }
  return result.item;
}

export function getAbilitySourceFlagPath() {
  return `flags.${FALLOUT_MAW.id}.${ABILITY_SOURCE_FLAG}`;
}

function getAbilityRewardItemData(research = {}) {
  for (const reward of research.rewards ?? []) {
    const itemData = reward?.itemData;
    if (itemData?.type === "ability") return itemData;
  }
  return null;
}

function getCatalogAbilityRewardItemData(sourceId = "") {
  const entry = findCatalogAbility(sourceId);
  if (!entry) return null;
  return prepareCatalogAbilityItemData(entry);
}

function getRewardAbilitySourceId(itemData = {}) {
  return String(itemData?.flags?.[FALLOUT_MAW.id]?.[ABILITY_SOURCE_FLAG]?.id ?? "");
}

function getEvolutionRootId(entry = {}) {
  const sourceId = String(entry?.ability?.id ?? "").trim();
  const rootId = String(entry?.rootAbility?.id ?? "").trim();
  return rootId && rootId !== sourceId ? rootId : "";
}

function resolveAbilityEvolutionGrant(itemData = {}, sourceId = "") {
  const sourceFlag = itemData?.flags?.[FALLOUT_MAW.id]?.[ABILITY_SOURCE_FLAG] ?? {};
  const hasStoredEvolutionMetadata = Object.hasOwn(sourceFlag, "evolutionRootId")
    && Array.isArray(sourceFlag.evolutionParentIds);
  let rootSourceId = String(sourceFlag.evolutionRootId ?? "").trim();
  let parentValues = Array.isArray(sourceFlag.evolutionParentIds) ? sourceFlag.evolutionParentIds : [];
  let ancestorValues = Array.isArray(sourceFlag.evolutionAncestorIds) ? sourceFlag.evolutionAncestorIds : [];
  if (!hasStoredEvolutionMetadata) {
    const catalogEntry = sourceId ? findCatalogAbility(sourceId) : null;
    rootSourceId ||= getEvolutionRootId(catalogEntry);
    if (!parentValues.length) parentValues = catalogEntry?.incomingSourceIds ?? [];
    if (!ancestorValues.length) ancestorValues = catalogEntry?.ancestorSourceIds ?? [];
  }
  const parentSourceIds = Array.from(new Set(parentValues
    .map(value => String(value ?? "").trim())
    .filter(Boolean)));
  const ancestorSourceIds = Array.from(new Set(ancestorValues
    .map(value => String(value ?? "").trim())
    .filter(Boolean)));
  return {
    isEvolution: Boolean(rootSourceId && rootSourceId !== sourceId && parentSourceIds.length),
    rootSourceId,
    parentSourceIds,
    ancestorSourceIds
  };
}

function findOwnedEvolutionPredecessor(actor, parentSourceIds = []) {
  const parentIds = new Set(parentSourceIds);
  const matches = (actor?.items?.contents ?? Array.from(actor?.items ?? []))
    .filter(item => item?.type === "ability" && parentIds.has(getAbilitySourceId(item)));
  return matches.length === 1 ? matches[0] : null;
}

function applyEvolutionSourceFlag(itemData = {}, sourceId = "", evolution = {}) {
  itemData.flags ??= {};
  itemData.flags[FALLOUT_MAW.id] ??= {};
  const previous = itemData.flags[FALLOUT_MAW.id][ABILITY_SOURCE_FLAG] ?? {};
  itemData.flags[FALLOUT_MAW.id][ABILITY_SOURCE_FLAG] = {
    ...previous,
    id: sourceId,
    evolutionRootId: evolution.rootSourceId,
    evolutionParentIds: [...evolution.parentSourceIds],
    evolutionAncestorIds: [...evolution.ancestorSourceIds]
  };
}

async function withAbilityGrantLock(actor, sourceIds = [], operation) {
  const lockIds = Array.from(new Set((Array.isArray(sourceIds) ? sourceIds : [sourceIds])
    .map(value => String(value ?? "").trim())
    .filter(Boolean)));
  if (!lockIds.length) return operation();
  let inFlight = abilityGrantsInFlight.get(actor);
  if (!inFlight) {
    inFlight = new Set();
    abilityGrantsInFlight.set(actor, inFlight);
  }
  if (lockIds.some(sourceId => inFlight.has(sourceId))) return { item: null, cancelled: false, blocked: true };
  for (const sourceId of lockIds) inFlight.add(sourceId);
  try {
    return await operation();
  } finally {
    for (const sourceId of lockIds) inFlight.delete(sourceId);
    if (!inFlight.size) abilityGrantsInFlight.delete(actor);
  }
}

async function applyLimitedChangeSelectionsToGrant(itemData = {}, actor = null, {
  limitContext = "ability grant change limit",
  evaluateLimit = null,
  chooseLimitedChanges = null
} = {}) {
  const functions = normalizeAbilityFunctions(itemData.system?.functions ?? []);
  let changed = false;

  for (const entry of functions) {
    if (entry.type !== ABILITY_FUNCTION_TYPES.effectChanges) continue;
    if (hasEventReactionCondition(entry.conditions)) continue;
    if ((entry.conditions ?? []).some(condition => condition?.type === ABILITY_CONDITION_TYPES.itemUse)) continue;

    const limitedConditions = (entry.conditions ?? []).filter(condition => condition.type === ABILITY_CONDITION_TYPES.limitedChanges);
    if (!limitedConditions.length) continue;

    changed = true;
    entry.conditions = (entry.conditions ?? []).filter(condition => condition.type !== ABILITY_CONDITION_TYPES.limitedChanges);
    const selection = await resolveLimitedChangeSet({
      changes: entry.changes ?? [],
      conditions: limitedConditions,
      actor,
      evaluateLimit: evaluateLimit ?? (formula => evaluateActorFormula(formula, actor, {
        fallback: 1,
        minimum: 1,
        context: limitContext
      })),
      choose: chooseLimitedChanges ?? (({
        changes,
        selectionIds,
        limit,
        minimum,
        selectionMode,
        actor: evaluationActor
      }) => (
        requestLimitedChangeSelection({
          abilityName: itemData.name,
          changes,
          selectionIds,
          limit,
          minimum,
          selectionMode,
          evaluationActors: [evaluationActor]
        })
      ))
    });
    if (selection.cancelled) return null;
    entry.changes = selection.changes;
  }

  // selectedChanges keeps the full row set and only stores the chosen keys, so
  // the owner picks the initial active subset immediately at grant time.
  for (const entry of functions) {
    const selectedConditions = (entry.conditions ?? [])
      .filter(condition => condition?.type === ABILITY_CONDITION_TYPES.selectedChanges);
    for (const condition of selectedConditions) {
      const selection = await resolveLimitedChangeSet({
        changes: entry.changes ?? [],
        conditions: [condition],
        actor,
        evaluateLimit: evaluateLimit ?? (formula => evaluateActorFormula(formula, actor, {
          fallback: 1,
          minimum: 1,
          context: limitContext
        })),
        choose: chooseLimitedChanges ?? (({
          changes,
          selectionIds,
          limit,
          minimum,
          selectionMode,
          actor: evaluationActor
        }) => (
          requestLimitedChangeSelection({
            abilityName: itemData.name,
            changes,
            selectionIds,
            limit,
            minimum,
            selectionMode,
            evaluationActors: [evaluationActor]
          })
        ))
      });
      if (selection.cancelled) return null;
      condition.selectedKeys = selection.changes
        .map(change => String(change?.key ?? "").trim())
        .filter(Boolean);
      changed = true;
    }
  }

  if (changed) itemData.system.functions = functions;
  return itemData;
}

export async function requestLimitedChangeSelection({
  abilityName = "",
  changes = [],
  selectionIds = [],
  limit = 1,
  minimum = 1,
  selectionMode = ABILITY_CHANGE_SELECTION_MODES.exact,
  evaluationActors = []
} = {}) {
  const normalizedLimit = Math.max(1, Math.min(changes.length, toInteger(limit)));
  const normalizedMinimum = Math.max(1, Math.min(normalizedLimit, toInteger(minimum)));
  const normalizedSelectionMode = normalizeAbilityChangeSelectionMode(selectionMode);
  const isUpTo = normalizedSelectionMode === ABILITY_CHANGE_SELECTION_MODES.upTo;
  const rows = changes.map((change, index) => {
    const id = String(selectionIds?.[index] ?? "").trim() || getChangeSelectionId(change, index);
    const display = getAbilityChangeDisplayData(change, evaluationActors);
    const tooltip = display.formula
      ? ` data-tooltip="${escapeAttribute(`Формула: ${display.formula}`)}"`
      : "";
    return `
      <label class="checkbox fallout-maw-ability-change-choice">
        <input type="checkbox" name="limitedChanges" value="${escapeAttribute(id)}" data-limited-change-choice>
        <span class="fallout-maw-ability-change-choice-name ellipsis">${escapeHtml(display.label)}</span>
        <output class="fallout-maw-ability-change-choice-value"${tooltip}>${escapeHtml(display.value)}</output>
      </label>
    `;
  }).join("");

  const result = await DialogV2.wait({
    classes: ["dialog", "fallout-maw", "fallout-maw-ability-change-dialog"],
    window: {
      icon: "fa-solid fa-list-check",
      title: `Выбор изменений: ${abilityName}`
    },
    position: { width: 560 },
    modal: true,
    content: `
      <section class="fallout-maw-ability-change-picker">
        <header class="fallout-maw-ability-change-picker-summary">
          <div>
            <h3>Выберите ${isUpTo ? "до " : ""}${normalizedLimit} из ${changes.length}</h3>
            <p class="hint">${isUpTo
              ? `Можно выбрать от ${normalizedMinimum} до ${normalizedLimit}.`
              : `Нужно выбрать ровно ${normalizedLimit}.`}</p>
          </div>
          <output class="fallout-maw-ability-change-picker-counter" data-limited-change-counter aria-live="polite">
            <strong data-limited-change-selected>0</strong><span aria-hidden="true"> / </span><strong>${normalizedLimit}</strong>
          </output>
        </header>
        <fieldset class="fallout-maw-ability-change-picker-fieldset">
          <legend>Доступные изменения</legend>
          <div class="fallout-maw-ability-change-choice-list scrollable" role="group" aria-label="Доступные изменения">${rows}</div>
        </fieldset>
      </section>
    `,
    render: (_event, dialog) => activateLimitedChangeSelection(dialog, normalizedLimit, {
      minimum: normalizedMinimum,
      selectionMode: normalizedSelectionMode
    }),
    buttons: [
      {
        action: "apply",
        label: "Применить",
        icon: "fa-solid fa-check",
        default: true,
        disabled: true,
        callback: (_event, button) => collectLimitedChangeSelection(button.form, normalizedLimit, {
          minimum: normalizedMinimum,
          selectionMode: normalizedSelectionMode
        })
      },
      {
        action: "cancel",
        label: "Отмена",
        icon: "fa-solid fa-xmark",
        callback: () => false
      }
    ]
  });

  return result === false ? null : result;
}

function activateLimitedChangeSelection(dialog, limit, {
  minimum = 1,
  selectionMode = ABILITY_CHANGE_SELECTION_MODES.exact
} = {}) {
  const form = dialog.element?.querySelector("form");
  if (!form) return;

  const applyButton = form.querySelector('button[data-action="apply"]');
  const selectedElement = form.querySelector("[data-limited-change-selected]");
  const counterElement = form.querySelector("[data-limited-change-counter]");
  const update = () => {
    const selected = form.querySelectorAll("[data-limited-change-choice]:checked").length;
    const valid = isLimitedChangeSelectionCountValid(selected, limit, { minimum, selectionMode });
    if (selectedElement) selectedElement.textContent = String(selected);
    if (counterElement) {
      counterElement.classList.toggle("complete", valid);
      counterElement.setAttribute("aria-label", `Выбрано ${selected} из ${limit}`);
    }
    if (applyButton) applyButton.disabled = !valid;
    for (const checkbox of form.querySelectorAll("[data-limited-change-choice]")) {
      const unavailable = !checkbox.checked && selected >= limit;
      checkbox.disabled = unavailable;
      checkbox.closest(".fallout-maw-ability-change-choice")?.classList.toggle("selected", checkbox.checked);
      checkbox.closest(".fallout-maw-ability-change-choice")?.classList.toggle("unavailable", unavailable);
    }
  };

  for (const checkbox of form.querySelectorAll("[data-limited-change-choice]")) {
    checkbox.addEventListener("change", update);
  }
  update();
}

function collectLimitedChangeSelection(form, limit, {
  minimum = 1,
  selectionMode = ABILITY_CHANGE_SELECTION_MODES.exact
} = {}) {
  const selected = Array.from(form?.querySelectorAll("[data-limited-change-choice]:checked") ?? [])
    .map(input => String(input.value ?? "").trim())
    .filter(Boolean);
  if (!isLimitedChangeSelectionCountValid(selected.length, limit, { minimum, selectionMode })) {
    const normalizedMode = normalizeAbilityChangeSelectionMode(selectionMode);
    ui.notifications.warn(normalizedMode === ABILITY_CHANGE_SELECTION_MODES.upTo
      ? `Нужно выбрать от ${minimum} до ${limit} изменений.`
      : `Нужно выбрать изменений: ${limit}.`);
    return null;
  }
  return selected;
}

function getChangeSelectionId(change = {}, index = 0) {
  return String(change?.id ?? "").trim() || `change-${index}`;
}

function getAbilityChangeDisplayData(change = {}, evaluationActors = []) {
  const values = resolveAbilityChangePreviewValues(change, evaluationActors);
  const rawValue = String(change?.value ?? "").trim();
  const actor = (Array.isArray(evaluationActors) ? evaluationActors : [evaluationActors]).find(Boolean) ?? null;
  return {
    label: getEffectKeyLabel(change.key),
    value: formatLimitedChangeDisplayValue(change, values),
    formula: values.length && rawValue && !Number.isFinite(Number(rawValue))
      ? formatActorFormulaForDisplay(rawValue, actor, { includeValues: Boolean(actor) })
      : ""
  };
}

function getEffectKeyLabel(key = "") {
  const normalized = String(key ?? "").trim();
  if (!normalized) return "Без ключа";

  const token = buildEffectKeyTokens().find(entry => entry.path === normalized);
  if (token?.label) return token.label;

  return normalized
    .replace(/^system\./, "")
    .split(".")
    .filter(Boolean)
    .join(" / ");
}

function resolveAbilityChangePreviewValues(change = {}, evaluationActors = []) {
  const actors = (Array.isArray(evaluationActors) ? evaluationActors : [evaluationActors]).filter(Boolean);
  if (!actors.length) return [];
  const values = actors.map(actor => evaluateEffectChangeNumber(actor, change?.value, {
    fallback: Number.NaN,
    stage: "prepared"
  }));
  return values.every(Number.isFinite) ? values : [];
}

function escapeAttribute(value) {
  return escapeHtml(value)
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;")
    .replaceAll("`", "&#096;");
}

async function applyAbilityAcquisitionChanges(actor, item) {
  const changes = getAbilityAcquisitionChanges(item);
  if (!actor || !changes.length) return;

  const updates = {};
  for (const change of changes) {
    const key = String(change?.key ?? "").trim();
    if (!key.startsWith("system.")) continue;

    const current = Number(foundry.utils.getProperty(updates, key) ?? foundry.utils.getProperty(actor, key)) || 0;
    const value = evaluateEffectChangeNumber(actor, change?.value, { fallback: 0 });
    let next = value;
    if (change.type === "add") next = current + value;
    else if (change.type === "multiply") next = current * value;
    else if (change.type === "upgrade") next = Math.max(current, value);
    else if (change.type === "downgrade") next = Math.min(current, value);
    foundry.utils.setProperty(updates, key, Math.max(0, next));
  }

  if (Object.keys(foundry.utils.flattenObject(updates)).length) await actor.update(updates);
}
