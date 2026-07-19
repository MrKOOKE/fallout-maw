import { FALLOUT_MAW } from "../config/system-config.mjs";
import { getAbilityCatalog } from "../settings/accessors.mjs";
import {
  ABILITY_CONDITION_TYPES,
  ABILITY_FUNCTION_TYPES,
  ABILITY_SOURCE_FLAG,
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
import { formatLimitedChangeDisplayValue, resolveLimitedChangeSet } from "./limited-changes.mjs";
import { getResearchById } from "../research/storage.mjs";

const { DialogV2 } = foundry.applications.api;
const REWARD_SELECTION_ABORTED = Symbol("abilityRewardSelectionAborted");

export function findCatalogAbility(sourceId = "", catalog = getAbilityCatalog()) {
  const normalizedSourceId = String(sourceId ?? "").trim();
  if (!normalizedSourceId) return null;
  for (const category of catalog.categories ?? []) {
    const ability = (category.abilities ?? []).find(entry => entry.id === normalizedSourceId);
    if (ability) return { ability, category };
  }
  return null;
}

export function actorHasAbility(actor, sourceId = "") {
  const normalizedSourceId = String(sourceId ?? "").trim();
  if (!normalizedSourceId) return false;
  return actor?.items?.some?.(item => item.type === "ability" && getAbilitySourceId(item) === normalizedSourceId) ?? false;
}

export async function grantCatalogAbility(actor, sourceId = "") {
  if (!actor || actorHasAbility(actor, sourceId)) return null;
  const entry = findCatalogAbility(sourceId);
  if (!entry) return null;
  const itemData = prepareAbilityItemData(entry.ability, { categoryId: entry.category.id });
  const created = await actor.createEmbeddedDocuments("Item", [itemData]);
  const item = created?.[0] ?? null;
  await applyAbilityAcquisitionChanges(actor, item);
  return item;
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
  const normalizedItemData = foundry.utils.deepClone(itemData);
  delete normalizedItemData._id;

  const rewardSourceId = getRewardAbilitySourceId(normalizedItemData) || sourceId;
  if (rewardSourceId && actorHasAbility(actor, rewardSourceId)) return null;

  const preparedItemData = await applyLimitedChangeSelectionsToReward(normalizedItemData, actor);
  if (!preparedItemData) {
    ui.notifications.warn("Выбор изменений способности не завершён. Завершённое исследование оставлено без выдачи награды.");
    return REWARD_SELECTION_ABORTED;
  }

  const created = await actor.createEmbeddedDocuments("Item", [preparedItemData]);
  const item = created?.[0] ?? null;
  await applyAbilityAcquisitionChanges(actor, item);
  return item;
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
  return prepareAbilityItemData(entry.ability, { categoryId: entry.category.id });
}

function getRewardAbilitySourceId(itemData = {}) {
  return String(itemData?.flags?.[FALLOUT_MAW.id]?.[ABILITY_SOURCE_FLAG]?.id ?? "");
}

async function applyLimitedChangeSelectionsToReward(itemData = {}, actor = null) {
  const functions = normalizeAbilityFunctions(itemData.system?.functions ?? []);
  let changed = false;

  for (const entry of functions) {
    if (entry.type !== ABILITY_FUNCTION_TYPES.effectChanges) continue;
    if (hasEventReactionCondition(entry.conditions)) continue;

    const limitedConditions = (entry.conditions ?? []).filter(condition => condition.type === ABILITY_CONDITION_TYPES.limitedChanges);
    if (!limitedConditions.length) continue;

    changed = true;
    entry.conditions = (entry.conditions ?? []).filter(condition => condition.type !== ABILITY_CONDITION_TYPES.limitedChanges);
    const selection = await resolveLimitedChangeSet({
      changes: entry.changes ?? [],
      conditions: limitedConditions,
      actor,
      evaluateLimit: formula => evaluateActorFormula(formula, actor, {
        fallback: 1,
        minimum: 1,
        context: "ability reward change limit"
      }),
      choose: ({ changes, selectionIds, limit, actor: evaluationActor }) => requestLimitedChangeSelection({
        abilityName: itemData.name,
        changes,
        selectionIds,
        limit,
        evaluationActors: [evaluationActor]
      })
    });
    if (selection.cancelled) return null;
    entry.changes = selection.changes;
  }

  if (changed) itemData.system.functions = functions;
  return itemData;
}

export async function requestLimitedChangeSelection({
  abilityName = "",
  changes = [],
  selectionIds = [],
  limit = 1,
  evaluationActors = []
} = {}) {
  const normalizedLimit = Math.max(1, Math.min(changes.length, toInteger(limit)));
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
            <h3>Выберите ${normalizedLimit} из ${changes.length}</h3>
            <p class="hint">Нужно выбрать ровно ${normalizedLimit}.</p>
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
    render: (_event, dialog) => activateLimitedChangeSelection(dialog, normalizedLimit),
    buttons: [
      {
        action: "apply",
        label: "Применить",
        icon: "fa-solid fa-check",
        default: true,
        disabled: true,
        callback: (_event, button) => collectLimitedChangeSelection(button.form, normalizedLimit)
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

function activateLimitedChangeSelection(dialog, limit) {
  const form = dialog.element?.querySelector("form");
  if (!form) return;

  const applyButton = form.querySelector('button[data-action="apply"]');
  const selectedElement = form.querySelector("[data-limited-change-selected]");
  const counterElement = form.querySelector("[data-limited-change-counter]");
  const update = () => {
    const selected = form.querySelectorAll("[data-limited-change-choice]:checked").length;
    if (selectedElement) selectedElement.textContent = String(selected);
    if (counterElement) {
      counterElement.classList.toggle("complete", selected === limit);
      counterElement.setAttribute("aria-label", `Выбрано ${selected} из ${limit}`);
    }
    if (applyButton) applyButton.disabled = selected !== limit;
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

function collectLimitedChangeSelection(form, limit) {
  const selected = Array.from(form?.querySelectorAll("[data-limited-change-choice]:checked") ?? [])
    .map(input => String(input.value ?? "").trim())
    .filter(Boolean);
  if (selected.length !== limit) {
    ui.notifications.warn(`Нужно выбрать изменений: ${limit}.`);
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
