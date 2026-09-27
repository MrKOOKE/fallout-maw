import { localize as auditLocalize, format as auditFormat } from "../utils/i18n.mjs";
import { toInteger } from "../utils/numbers.mjs";

export const BULLSEYE_DEFAULT_SETTINGS = Object.freeze({
  energyCost: 10,
  innateDifficultyIgnorePercent: 100,
  penetrationBonusFormula: "10+rangedCombat/20",
  maxStacks: 3
});

export const BULLSEYE_STATE_EFFECT_FLAG_KEY = "bullseyeState";

export function normalizeBullseyeSettings(settings = {}) {
  return {
    energyCost: Math.max(0, toInteger(settings.energyCost ?? BULLSEYE_DEFAULT_SETTINGS.energyCost)),
    innateDifficultyIgnorePercent: clampPercent(
      settings.innateDifficultyIgnorePercent,
      BULLSEYE_DEFAULT_SETTINGS.innateDifficultyIgnorePercent
    ),
    penetrationBonusFormula: String(
      settings.penetrationBonusFormula ?? BULLSEYE_DEFAULT_SETTINGS.penetrationBonusFormula
    ).trim() || BULLSEYE_DEFAULT_SETTINGS.penetrationBonusFormula,
    maxStacks: Math.max(1, toInteger(settings.maxStacks ?? BULLSEYE_DEFAULT_SETTINGS.maxStacks))
  };
}

/** Formula applied to the next attack after one or more consecutive hits. */
export function getBullseyePenetrationFormula(stacks = 0, settings = {}) {
  const normalized = normalizeBullseyeSettings(settings);
  const count = Math.max(0, Math.min(normalized.maxStacks, toInteger(stacks)));
  return count > 0 ? `(${normalized.penetrationBonusFormula})*${count}` : "0";
}

/** Build the shooter-facing indicator without turning its contextual bonus into a generic effect key. */
export function buildBullseyeStatePresentation({
  abilityName = auditLocalize("FALLOUTMAW.AuditRuntime.R0040", "В яблочко"),
  targetName = "",
  limbName = "",
  penetrationBonus = 0,
  state = {},
  settings = {}
} = {}) {
  const normalized = normalizeBullseyeSettings(settings);
  const current = normalizeBullseyeState(state, normalized);
  const name = String(abilityName ?? "").trim() || auditLocalize("FALLOUTMAW.AuditRuntime.R0040", "В яблочко");
  if (current.stacks <= 0) {
    return {
      name: auditFormat("FALLOUTMAW.AuditRuntime.R0041", { p0: (name), p1: (normalized.maxStacks) }, "{p0}: серия 0/{p1}"),
      description: [
        auditLocalize("FALLOUTMAW.AuditRuntime.R0042", "<strong>Серия:</strong> не начата."),
        auditLocalize("FALLOUTMAW.AuditRuntime.R0043", "<strong>Попадание Прицельным выстрелом:</strong> начнёт накапливать пробивание."),
        auditLocalize("FALLOUTMAW.AuditRuntime.R0044", "<strong>Промах:</strong> сбросит серию.")
      ].join("<br>")
    };
  }

  const target = String(targetName ?? "").trim() || current.targetActorUuid;
  const limb = String(limbName ?? "").trim() || current.limbKey;
  const bonus = Math.max(0, toInteger(penetrationBonus));
  return {
    name: auditFormat("FALLOUTMAW.AuditRuntime.R0045", { p0: (name), p1: (current.stacks), p2: (normalized.maxStacks), p3: (bonus) }, "{p0}: серия {p1}/{p2} · пробивание +{p3}"),
    description: [
      auditFormat("FALLOUTMAW.AuditRuntime.R0046", { p0: (target) }, "<strong>Цель:</strong> {p0}."),
      auditFormat("FALLOUTMAW.AuditRuntime.R0047", { p0: (limb) }, "<strong>Часть тела:</strong> {p0}."),
      "",
      auditFormat("FALLOUTMAW.AuditRuntime.R0048", { p0: (bonus) }, "<strong>Следующий Прицельный выстрел:</strong> пробивание +{p0} при атаке этой же части тела."),
      auditLocalize("FALLOUTMAW.AuditRuntime.R0044", "<strong>Промах:</strong> сбросит серию.")
    ].join("<br>")
  };
}

/**
 * Return the stored chain that applies to an aimed attack preview/resolution.
 * A chain never leaks to another actor, limb, or attack action.
 */
export function getBullseyeApplicableStacks({
  state = {},
  actionKey = "",
  targetActorUuid = "",
  limbKey = ""
} = {}, settings = {}) {
  if (String(actionKey ?? "").trim() !== "aimedShot") return 0;
  const target = String(targetActorUuid ?? "").trim();
  const limb = String(limbKey ?? "").trim();
  if (!target || !limb) return 0;
  const normalizedState = normalizeBullseyeState(state, settings);
  if (normalizedState.targetActorUuid !== target || normalizedState.limbKey !== limb) return 0;
  return normalizedState.stacks;
}

/**
 * Fold one complete attack cycle into Bullseye state. `successfulAttack` is an
 * aggregate value: any successful check advances the chain exactly once.
 */
export function resolveBullseyeAttackCycle({
  state = {},
  attackId = "",
  actionKey = "",
  targetActorUuid = "",
  limbKey = "",
  attackCheckCount = 0,
  successfulAttack = false
} = {}, settings = {}) {
  const current = normalizeBullseyeState(state, settings);
  const id = String(attackId ?? "").trim();
  if (id && current.lastAttackId === id) {
    return { changed: false, duplicate: true, previousStacks: current.stacks, nextState: current };
  }

  const target = String(targetActorUuid ?? "").trim();
  const limb = String(limbKey ?? "").trim();
  const eligible = String(actionKey ?? "").trim() === "aimedShot"
    && target
    && limb
    && Math.max(0, toInteger(attackCheckCount)) > 0;
  if (!eligible) {
    return { changed: false, duplicate: false, previousStacks: current.stacks, nextState: current };
  }

  const normalized = normalizeBullseyeSettings(settings);
  const sameLane = current.targetActorUuid === target && current.limbKey === limb;
  const stacks = successfulAttack === true
    ? Math.min(normalized.maxStacks, sameLane ? current.stacks + 1 : 1)
    : 0;
  const nextState = {
    targetActorUuid: stacks > 0 ? target : "",
    limbKey: stacks > 0 ? limb : "",
    stacks,
    lastAttackId: id
  };
  return {
    changed: !sameBullseyeState(current, nextState),
    duplicate: false,
    previousStacks: current.stacks,
    nextState
  };
}

export function normalizeBullseyeState(state = {}, settings = {}) {
  const normalized = normalizeBullseyeSettings(settings);
  return {
    targetActorUuid: String(state?.targetActorUuid ?? "").trim(),
    limbKey: String(state?.limbKey ?? "").trim(),
    stacks: Math.max(0, Math.min(normalized.maxStacks, toInteger(state?.stacks))),
    lastAttackId: String(state?.lastAttackId ?? "").trim()
  };
}

function sameBullseyeState(left, right) {
  return left.targetActorUuid === right.targetActorUuid
    && left.limbKey === right.limbKey
    && left.stacks === right.stacks
    && left.lastAttackId === right.lastAttackId;
}

function clampPercent(value, fallback = 0) {
  const number = Number(value);
  return Math.max(0, Math.min(100, Number.isFinite(number) ? Math.trunc(number) : fallback));
}
