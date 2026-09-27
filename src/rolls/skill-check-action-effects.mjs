import { localize as auditLocalize } from "../utils/i18n.mjs";
export const SKILL_CHECK_ACTION_EFFECT_FIELDS = Object.freeze([
  "bonus",
  "advantage",
  "disadvantage"
]);

export const SKILL_CHECK_ACTIONS = Object.freeze([
  createAction("trapDetection", () => auditLocalize("FALLOUTMAW.AuditRuntime.R1177", "Обнаружение ловушек"), [
    "trapDetection"
  ]),
  createAction("stealth", () => auditLocalize("FALLOUTMAW.AuditRuntime.R1178", "Раскрытие скрытности"), [
    "stealth",
    "stealthReveal"
  ]),
  createAction("grappleResistance", () => auditLocalize("FALLOUTMAW.AuditRuntime.R1179", "Сопротивление захвату"), [
    "grappleResistance",
    "grappleEscape"
  ]),
  createAction("knockdownResistance", () => auditLocalize("FALLOUTMAW.AuditRuntime.R1180", "Сопротивление опрокидыванию"), [
    "knockdownResistance"
  ]),
  createAction("knockbackResistance", () => auditLocalize("FALLOUTMAW.AuditRuntime.R1181", "Сопротивление отталкиванию"), [
    "knockbackResistance",
    "activePushResistance",
    "weaponPushResistance",
    "keepAwayResistance"
  ]),
  createAction("repair", () => auditLocalize("FALLOUTMAW.AuditRuntime.R1182", "Ремонт"), [
    "repair"
  ]),
  createAction("medicineProsthesis", () => auditLocalize("FALLOUTMAW.AuditRuntime.R1183", "Протезирование"), [
    "medicineProsthesis",
    "prosthesis"
  ]),
  createAction("medicineImplant", () => auditLocalize("FALLOUTMAW.AuditRuntime.R1184", "Имплантирование"), [
    "medicineImplant",
    "implant"
  ]),
  createAction("craft", () => auditLocalize("FALLOUTMAW.AuditRuntime.R1185", "Крафт"), [
    "craft",
    "Крафт"
  ]),
  createAction("disassembly", () => auditLocalize("FALLOUTMAW.AuditRuntime.R1186", "Разбор"), [
    "disassembly",
    "dismantle",
    "Разбор"
  ]),
  createAction("research", () => auditLocalize("FALLOUTMAW.AuditRuntime.R1187", "Исследование"), [
    "research"
  ])
]);

const SKILL_CHECK_ACTION_IDS = new Set(SKILL_CHECK_ACTIONS.map(action => action.id));
const SKILL_CHECK_ACTION_BY_REQUESTER = new Map(SKILL_CHECK_ACTIONS.flatMap(action => (
  action.requesterAliases.map(alias => [normalizeRequester(alias), action])
)));
const SKILL_CHECK_ACTION_EFFECT_KEY_PATTERN = /^system\.skillCheck\.actions\.([^.]+)\.(bonus|advantage|disadvantage)$/;

export function getSkillCheckAction(requester = "") {
  return SKILL_CHECK_ACTION_BY_REQUESTER.get(normalizeRequester(requester)) ?? null;
}

export function getSkillCheckActionId(requester = "") {
  return getSkillCheckAction(requester)?.id ?? "";
}

export function getSkillCheckActionEffectKey(actionId = "", field = "bonus") {
  const id = String(actionId ?? "").trim();
  const normalizedField = String(field ?? "").trim();
  if (!SKILL_CHECK_ACTION_IDS.has(id) || !SKILL_CHECK_ACTION_EFFECT_FIELDS.includes(normalizedField)) return "";
  return `system.skillCheck.actions.${id}.${normalizedField}`;
}

export function getSkillCheckActionEffectKeys(requester = "") {
  const actionId = getSkillCheckActionId(requester);
  if (!actionId) return [];
  return SKILL_CHECK_ACTION_EFFECT_FIELDS
    .map(field => getSkillCheckActionEffectKey(actionId, field))
    .filter(Boolean);
}

export function isSkillCheckActionEffectKey(effectKey = "") {
  const match = String(effectKey ?? "").trim().match(SKILL_CHECK_ACTION_EFFECT_KEY_PATTERN);
  return Boolean(match && SKILL_CHECK_ACTION_IDS.has(match[1]));
}

function createAction(id, label, requesterAliases = []) {
  const normalizedId = String(id ?? "").trim();
  return Object.freeze({
    id: normalizedId,
    get label() { return String((typeof label === "function" ? label() : label) ?? normalizedId).trim() || normalizedId; },
    requesterAliases: Object.freeze(Array.from(new Set(
      [normalizedId, ...requesterAliases]
        .map(alias => String(alias ?? "").trim())
        .filter(Boolean)
    )))
  });
}

function normalizeRequester(requester = "") {
  return String(requester ?? "").trim().toLocaleLowerCase();
}
