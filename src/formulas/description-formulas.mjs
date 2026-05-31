import { evaluateFormula, getSkillValues } from "./index.mjs";
import { getCharacteristicSettings, getSkillSettings } from "../settings/accessors.mjs";

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

function buildDescriptionFormulaData(options = {}) {
  const actor = getFormulaActor(options?.relativeTo);
  const rollData = getRollData(options?.rollData);
  const source = actor?.system ?? rollData?.system ?? rollData ?? {};
  return {
    characteristicSettings: getCharacteristicSettings(),
    skillSettings: getSkillSettings(),
    characteristics: source?.characteristics ?? {},
    skills: getSkillValues(source?.skills ?? {})
  };
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
  const resolved = String(formula ?? "").replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/g, identifier => {
    const entry = resolveFormulaIdentifier(identifier, data);
    if (!entry) return identifier;
    return entry.label;
  });
  return `${resolved} = ${total}`;
}

function resolveFormulaIdentifier(identifier, data) {
  const normalized = String(identifier ?? "").trim().toLowerCase();
  if (!normalized) return null;

  for (const characteristic of data.characteristicSettings ?? []) {
    if (!matchesFormulaEntry(normalized, characteristic)) continue;
    return {
      label: characteristic.label || characteristic.key,
      value: Number(data.characteristics?.[characteristic.key]) || 0
    };
  }

  for (const skill of data.skillSettings ?? []) {
    if (!matchesFormulaEntry(normalized, skill)) continue;
    return {
      label: skill.label || skill.key,
      value: Number(data.skills?.[skill.key]) || 0
    };
  }

  return null;
}

function matchesFormulaEntry(normalized, entry = {}) {
  return normalized === String(entry.key ?? "").toLowerCase()
    || normalized === String(entry.abbr ?? "").toLowerCase();
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
  element.style.left = `${Math.round(left)}px`;
  element.style.top = `${Math.round(top)}px`;
}
