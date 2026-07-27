import { toInteger } from "../utils/numbers.mjs";

export const STUN_EFFECT_KEY = "system.combat.stun";
export const STUN_RESOURCE_KEYS = Object.freeze([
  "actionPoints",
  "reactionPoints",
  "movementPoints"
]);

const DAMAGE_EFFECT_FLAG_SCOPE = "fallout-maw";
const DAMAGE_EFFECT_FLAG_KEY = "damageEffect";
const DAMAGE_RESOURCE_LIMIT_KINDS = new Set(["resourceLimit", "resourceBlock"]);
const STUN_LIMIT_COLOR = "#d94b4b";

export function getActorStunDegree(actor = null) {
  return Math.min(100, Math.max(0, toInteger(actor?.system?.combat?.stun)));
}

export function getResourceLimitState(actor = null) {
  const resources = {};
  collectDamageResourceLimits(actor, resources);
  collectStunResourceLimits(actor, resources);
  return { resources, stun: getActorStunDegree(actor) };
}

export const getResourceBlockState = getResourceLimitState;

export function getActorResourceLimitAmount(actor = null, resourceKey = "") {
  const key = String(resourceKey ?? "").trim();
  if (!key) return 0;
  return Math.max(0, toInteger(getResourceLimitState(actor).resources[key]?.amount));
}

function collectDamageResourceLimits(actor, resources) {
  for (const effect of actor?.effects ?? []) {
    if (effect?.disabled) continue;
    const data = effect.getFlag?.(DAMAGE_EFFECT_FLAG_SCOPE, DAMAGE_EFFECT_FLAG_KEY);
    if (!DAMAGE_RESOURCE_LIMIT_KINDS.has(String(data?.kind ?? ""))) continue;
    const color = String(data.color ?? "#3f8cff");
    for (const [key, amount] of Object.entries(data.resources ?? {})) {
      addResourceLimit(resources, key, amount, color);
    }
  }
}

function collectStunResourceLimits(actor, resources) {
  const stun = getActorStunDegree(actor);
  if (!stun) return;
  for (const resourceKey of STUN_RESOURCE_KEYS) {
    const maximum = Math.max(0, toInteger(actor?.system?.resources?.[resourceKey]?.max));
    if (!maximum) continue;
    addResourceLimit(resources, resourceKey, Math.ceil(maximum * stun / 100), STUN_LIMIT_COLOR);
  }
}

function addResourceLimit(resources, rawKey, rawAmount, color) {
  const key = String(rawKey ?? "").trim();
  const amount = Math.max(0, toInteger(rawAmount));
  if (!key || !amount) return;
  resources[key] ??= { amount: 0, color: String(color || "#3f8cff") };
  resources[key].amount += amount;
  resources[key].color = String(color || resources[key].color || "#3f8cff");
}
