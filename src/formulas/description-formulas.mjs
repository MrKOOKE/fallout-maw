import { evaluateFormula, getSkillValues } from "./index.mjs";
import { buildActorFormulaReferenceData } from "./actor-references.mjs";
import { DEFAULT_NEEDS } from "../config/defaults.mjs";
import {
  getCharacteristicSettings,
  getNeedSettings,
  getProficiencySettings,
  getResourceSettings,
  getSkillSettings
} from "../settings/accessors.mjs";
import { buildActorFormulaData } from "../utils/actor-formulas.mjs";
import { formatFormulaForDisplay } from "../utils/formula-display.mjs";

const DESCRIPTION_FORMULA_PATTERN = /\[\[(?!\/)(?<formula>[^\]\r\n]+)]]/g;
const DESCRIPTION_FORMULA_TOOLTIP_CLASS = "fallout-maw-description-formula-tooltip";
let registered = false;
let tooltipElement = null;

export function registerDescriptionFormulaEnrichment() {
  if (registered) return;
  const TextEditor = foundry.applications.ux.TextEditor.implementation;
  if (!TextEditor?.enrichHTML) return;

  registered = true;
  const enrichHTML = TextEditor.enrichHTML;
  TextEditor.enrichHTML = async function falloutMawEnrichHTML(content, options = {}) {
    return enrichHTML.call(this, replaceDescriptionFormulas(content, options), options);
  };

  document.addEventListener("pointerover", onDescriptionFormulaPointerOver);
  document.addEventListener("pointerout", onDescriptionFormulaPointerOut);
  document.addEventListener("scroll", removeDescriptionFormulaTooltip, { capture: true });
}

export function replaceDescriptionFormulas(content, options = {}) {
  if (!String(content ?? "").includes("[[")) return content;

  const root = document.createElement("div");
  root.innerHTML = String(content ?? "");
  const formulaData = buildDescriptionFormulaData(options);
  const textNodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  for (const node of textNodes) {
    const text = node.textContent ?? "";
    if (!text.includes("[[")) continue;

    let changed = false;
    const fragment = document.createDocumentFragment();
    let cursor = 0;

    for (const match of text.matchAll(DESCRIPTION_FORMULA_PATTERN)) {
      const formula = String(match.groups?.formula ?? "").trim();
      if (!formula) continue;
      const result = evaluateDescriptionFormula(formula, formulaData);
      if (!result.ok) continue;

      fragment.append(document.createTextNode(text.slice(cursor, match.index)));
      const span = document.createElement("span");
      span.className = "fallout-maw-description-formula-result";
      span.dataset.formula = formula;
      span.dataset.formulaBreakdown = result.breakdown;
      span.textContent = String(result.value);
      fragment.append(span);
      cursor = match.index + match[0].length;
      changed = true;
    }

    if (!changed) continue;
    fragment.append(document.createTextNode(text.slice(cursor)));
    node.replaceWith(fragment);
  }

  return root.innerHTML;
}

function evaluateDescriptionFormula(formula, data) {
  try {
    const value = evaluateFormula(formula, data);
    return Number.isFinite(value)
      ? { ok: true, value, breakdown: describeDescriptionFormula(formula, data, value) }
      : { ok: false, value: 0, breakdown: "" };
  } catch (_error) {
    return { ok: false, value: 0, breakdown: "" };
  }
}

export function buildDescriptionFormulaData(options = {}) {
  const actor = getFormulaActor(options?.relativeTo);
  const hasExplicitRollData = Object.prototype.hasOwnProperty.call(options ?? {}, "rollData");
  const rollData = hasExplicitRollData ? getRollData(options?.rollData) : null;
  if (!hasExplicitRollData && actor) return buildActorFormulaData(actor);
  const source = hasExplicitRollData
    ? (rollData?.system ?? rollData ?? {})
    : (actor?.system ?? {});
  const characteristicSettings = getCharacteristicSettings();
  const skillSettings = getSkillSettings();
  const characteristics = source?.characteristics ?? {};
  const skills = getSkillValues(source?.skills ?? {});
  const formulaReferences = buildActorFormulaReferenceData({
    system: source,
    characteristicSettings,
    skillSettings,
    resourceSettings: getResourceSettings(),
    needSettings: safeGetNeedSettings(),
    proficiencySettings: getProficiencySettings(),
    limbSettings: Object.entries(source?.limbs ?? {}).map(([key, limb]) => ({
      key,
      label: String(limb?.label ?? key)
    })),
    characteristicValues: characteristics,
    skillValues: skills
  });
  return {
    characteristicSettings,
    skillSettings,
    characteristics,
    skills,
    ...formulaReferences
  };
}

function safeGetNeedSettings() {
  try {
    const settings = getNeedSettings();
    return settings.length ? settings : DEFAULT_NEEDS.map(entry => ({ ...entry }));
  } catch (_error) {
    return DEFAULT_NEEDS.map(entry => ({ ...entry }));
  }
}

function getFormulaActor(document) {
  if (!document) return null;
  if (document.documentName === "Actor") return document;
  if (document.actor?.documentName === "Actor") return document.actor;
  if (document.parent?.documentName === "Actor") return document.parent;
  if (document.parent?.actor?.documentName === "Actor") return document.parent.actor;
  return null;
}

function getRollData(rollData) {
  if (typeof rollData === "function") return rollData() ?? {};
  return rollData ?? {};
}

function describeDescriptionFormula(formula, data, total) {
  const resolved = formatFormulaForDisplay(formula, {
    characteristics: data.characteristicSettings,
    skills: data.skillSettings,
    characteristicValues: data.characteristics,
    skillValues: data.skills,
    variables: data.formulaVariableSettings,
    variableValues: data.formulaVariables,
    references: data.formulaReferenceSettings,
    referenceValues: data.formulaReferences,
    includeValues: true
  });
  return `${resolved} = ${total}`;
}

function onDescriptionFormulaPointerOver(event) {
  const target = event.target?.closest?.(".fallout-maw-description-formula-result");
  if (!target) return;
  const text = String(target.dataset.formulaBreakdown ?? "").trim();
  if (!text) return;

  removeDescriptionFormulaTooltip();
  tooltipElement = document.createElement("aside");
  tooltipElement.className = DESCRIPTION_FORMULA_TOOLTIP_CLASS;
  tooltipElement.textContent = text;
  document.body.append(tooltipElement);
  positionDescriptionFormulaTooltip(tooltipElement, target);
}

function onDescriptionFormulaPointerOut(event) {
  const target = event.target?.closest?.(".fallout-maw-description-formula-result");
  if (!target || target.contains(event.relatedTarget)) return;
  removeDescriptionFormulaTooltip();
}

function removeDescriptionFormulaTooltip() {
  tooltipElement?.remove();
  tooltipElement = null;
}

function positionDescriptionFormulaTooltip(element, target) {
  const margin = 8;
  const gap = 8;
  const rect = target.getBoundingClientRect();
  const tooltipRect = element.getBoundingClientRect();
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const left = Math.min(
    Math.max(rect.left + ((rect.width - tooltipRect.width) / 2), margin),
    Math.max(margin, viewportWidth - tooltipRect.width - margin)
  );
  const below = rect.bottom + gap;
  const top = below + tooltipRect.height <= viewportHeight - margin
    ? below
    : Math.max(margin, rect.top - tooltipRect.height - gap);
  syncDescriptionFormulaTooltipLayer(element, target);
  element.style.left = `${Math.round(left)}px`;
  element.style.top = `${Math.round(top)}px`;
}

function syncDescriptionFormulaTooltipLayer(element, target) {
  const host = target?.closest?.(".fallout-maw-inventory-tooltip, .fallout-maw-ability-description-tooltip, #tooltip, .application");
  if (!host) return;
  const zIndex = Number.parseInt(window.getComputedStyle(host).zIndex, 10);
  if (!Number.isFinite(zIndex)) return;
  element.style.zIndex = String(zIndex + 1);
}
