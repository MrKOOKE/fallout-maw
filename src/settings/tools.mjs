import { localize as auditLocalize, format as auditFormat } from "../utils/i18n.mjs";
import { IDENTIFIER_PATTERN } from "../formulas/index.mjs";

export const TOOL_CLASS_CHOICES = Object.freeze(["D", "C", "B", "A", "S"]);

export const DEFAULT_TOOL_SETTINGS = Object.freeze([
  { key: "medical", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text075", "Инструменты медицины"); } },
  { key: "repair", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text076", "Инструменты ремонта"); } },
  { key: "electronicHacking", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text077", "Инструменты электронного взлома"); } },
  { key: "mechanicalHacking", get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text078", "Инструменты механического взлома"); } }
]);

export function createDefaultToolSettings() {
  return foundry.utils.deepClone(DEFAULT_TOOL_SETTINGS);
}

export function normalizeToolSettings(value = []) {
  const source = Array.isArray(value) ? value : [];
  const normalized = [];
  const keys = new Set();

  for (const entry of source) {
    const key = String(entry?.key ?? "").trim();
    if (!IDENTIFIER_PATTERN.test(key) || keys.has(key)) continue;
    keys.add(key);
    normalized.push({
      key,
      label: String(entry?.label ?? key).trim() || key
    });
  }

  return normalized.length ? normalized : createDefaultToolSettings();
}

export const DEFAULT_SYSTEM_ACTION_SETTINGS = Object.freeze([
  {
    key: "medicine",
    get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text079", "Медицина"); },
    img: "icons/svg/heal.svg",
    toolKey: "medical"
  },
  {
    key: "repair",
    get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text080", "Ремонт"); },
    img: "icons/tools/smithing/tongs-steel-grey.webp",
    toolKey: "repair"
  },
  {
    key: "search",
    get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text081", "Обыск"); },
    img: "icons/svg/eye.svg",
    toolKey: ""
  },
  {
    key: "trade",
    get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text082", "Торговля"); },
    img: "icons/svg/coins.svg",
    toolKey: ""
  },
  {
    key: "craft",
    get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text083", "Крафт"); },
    img: "icons/tools/smithing/hammer-sledge-steel-grey.webp",
    toolKey: "repair"
  },
  {
    key: "stealth",
    get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text084", "Скрытность"); },
    img: "icons/svg/invisible.svg",
    toolKey: ""
  },
  {
    key: "traps",
    get label() { return auditLocalize("FALLOUTMAW.AuditSystem.Text085", "Ловушки"); },
    img: "icons/svg/hazard.svg",
    toolKey: "mechanicalHacking"
  }
]);

export function createDefaultSystemActionSettings() {
  return foundry.utils.deepClone(DEFAULT_SYSTEM_ACTION_SETTINGS);
}

export function normalizeSystemActionSettings(value = []) {
  const source = Array.isArray(value) ? value : [];
  const byKey = new Map(source.map(entry => [String(entry?.key ?? ""), entry]));

  return DEFAULT_SYSTEM_ACTION_SETTINGS.map(defaultAction => {
    const stored = byKey.get(defaultAction.key) ?? {};
    return {
      ...defaultAction,
      img: String(stored.img ?? defaultAction.img).trim() || defaultAction.img
    };
  });
}
