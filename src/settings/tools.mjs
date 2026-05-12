import { IDENTIFIER_PATTERN } from "../formulas/index.mjs";

export const TOOL_CLASS_CHOICES = Object.freeze(["D", "C", "B", "A", "S"]);

export const DEFAULT_TOOL_SETTINGS = Object.freeze([
  { key: "medical", label: "Инструменты медицины" },
  { key: "repair", label: "Инструменты ремонта" },
  { key: "electronicHacking", label: "Инструменты электронного взлома" },
  { key: "mechanicalHacking", label: "Инструменты механического взлома" }
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
    label: "Медицина",
    img: "icons/svg/heal.svg",
    toolKey: "medical"
  },
  {
    key: "repair",
    label: "Ремонт",
    img: "icons/tools/smithing/tongs-steel-grey.webp",
    toolKey: "repair"
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
