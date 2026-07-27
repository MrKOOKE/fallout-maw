import { executeAbilityTrialLinks } from "../abilities/trial-runtime.mjs";
import {
  ABILITY_CONSTRUCT_TYPES,
  ABILITY_DAMAGE_AMOUNT_MODES,
  ABILITY_DAMAGE_LIMB_MODES,
  normalizeAbilityConstructs
} from "../settings/abilities.mjs";
import { selectRandomWeightedLimbKey } from "../utils/limb-randomization.mjs";
import { evaluateAttackTrialDifficulty } from "./attack-trial-resolution.mjs";

const DAMAGE_SCOPE_HEALTH = "health";
const DAMAGE_SCOPE_HEALTH_AND_LIMB = "healthAndLimb";

/**
 * Apply the consequence links of one resolved attack-trial entry.
 *
 * Non-damage constructs are delegated to the shared ability-trial runtime.
 * Damage remains request-only here so WeaponAttackController can commit every
 * request through its existing Damage Hub transaction.
 */
export async function applyAttackTrialOutcomeConsequences({
  entry = {},
  trial = null,
  constructs = [],
  sourceActor = null,
  sourceToken = null,
  targets = [],
  sourceEffect = null,
  sourceItemUuid = "",
  title = "",
  worldTime = Number(globalThis.game?.time?.worldTime) || 0,
  deduplicationSet = null,
  deduplicationKey = "",
  getBaseDamage = () => 0,
  getSelectedLimbKey = null,
  buildDamageRequests = () => [],
  evaluateDamageFormula = evaluateAttackDamageFormula
} = {}) {
  const resolvedKey = String(deduplicationKey ?? "").trim()
    || buildAttackTrialOutcomeDeduplicationKey(entry, trial);
  if (deduplicationSet instanceof Set && deduplicationSet.has(resolvedKey)) return [];
  if (deduplicationSet instanceof Set) deduplicationSet.add(resolvedKey);

  try {
    const resultKey = String(entry?.resultKey ?? entry?.check?.result?.key ?? "").trim();
    const outcome = entry?.outcome
      ?? trial?.outcomes?.[resultKey]
      ?? null;
    const links = Array.isArray(entry?.links)
      ? entry.links
      : (Array.isArray(outcome?.links) ? outcome.links : []);
    if (!links.length) return [];

    const normalizedConstructs = normalizeAbilityConstructs(constructs);
    const matchedSubject = resolveMatchedSubject(entry, sourceActor, sourceToken);
    const normalizedTargets = normalizeRecipients(targets);
    const damageRequests = [];

    await executeAbilityTrialLinks({
      trial: trial ?? {},
      links,
      constructs: normalizedConstructs,
      matchedSubjects: matchedSubject ? [matchedSubject] : [],
      targets: normalizedTargets,
      sourceActor,
      sourceEffect,
      sourceItemUuid,
      title,
      worldTime,
      onDamage: async ({ construct, recipients, multiplier }) => {
        if (construct?.type !== ABILITY_CONSTRUCT_TYPES.damage) return;
        for (const rawRecipient of recipients ?? []) {
          const recipient = enrichSourceRecipient(rawRecipient, sourceActor, sourceToken);
          const amount = await resolveDamageAmount({
            construct,
            recipient,
            sourceActor,
            entry,
            multiplier,
            getBaseDamage,
            evaluateDamageFormula
          });
          const { limbKey, scope } = await resolveDamageLocation({
            construct,
            recipient,
            entry,
            getSelectedLimbKey
          });
          const built = await buildDamageRequests({
            recipient,
            amount,
            limbKey,
            scope,
            construct,
            entry
          });
          damageRequests.push(...flattenRequests(built));
        }
      }
    });

    return damageRequests;
  } catch (error) {
    if (deduplicationSet instanceof Set) deduplicationSet.delete(resolvedKey);
    throw error;
  }
}

/**
 * One semantic trial lane may be visited once per pellet. Its identity must
 * therefore exclude the pellet index while retaining target and source lanes.
 */
export function buildAttackTrialOutcomeDeduplicationKey(entry = {}, trial = null) {
  const parts = [
    String(entry?.trialId ?? trial?.id ?? ""),
    String(entry?.subject ?? trial?.subject ?? ""),
    String(entry?.sourceMode ?? trial?.sourceMode ?? ""),
    getDocumentIdentity(entry?.target),
    getDocumentIdentity(entry?.token),
    getDocumentIdentity(entry?.actor),
    String(entry?.laneKey ?? "")
  ];
  return `attack-trial-outcome:${JSON.stringify(parts)}`;
}

async function resolveDamageAmount({
  construct,
  recipient,
  sourceActor,
  entry,
  multiplier = 1,
  getBaseDamage,
  evaluateDamageFormula
}) {
  const damage = construct?.damage ?? {};
  const mode = String(damage.amountMode ?? ABILITY_DAMAGE_AMOUNT_MODES.base);
  const count = Math.max(1, normalizeInteger(multiplier));
  if (mode === ABILITY_DAMAGE_AMOUNT_MODES.formula) {
    const amount = await evaluateDamageFormula(damage.formula, sourceActor, {
      fallback: 0,
      minimum: 0,
      context: "attack trial damage",
      targetActor: recipient?.actor ?? null,
      subjectActor: entry?.actor ?? null
    });
    return normalizeDamageAmount(amount * count);
  }

  const base = normalizeDamageAmount(await getBaseDamage(recipient));
  if (mode === ABILITY_DAMAGE_AMOUNT_MODES.percent) {
    const percent = await evaluateDamageFormula(damage.formula, sourceActor, {
      fallback: 0,
      minimum: 0,
      context: "attack trial damage percent",
      targetActor: recipient?.actor ?? null,
      subjectActor: entry?.actor ?? null
    });
    return normalizeDamageAmount((base * Math.max(0, Number(percent) || 0) * count) / 100);
  }
  return normalizeDamageAmount(base * count);
}

async function resolveDamageLocation({
  construct,
  recipient,
  entry,
  getSelectedLimbKey
}) {
  const mode = String(construct?.damage?.limbMode ?? ABILITY_DAMAGE_LIMB_MODES.random);
  if (mode === ABILITY_DAMAGE_LIMB_MODES.healthOnly) {
    return { limbKey: "", scope: DAMAGE_SCOPE_HEALTH };
  }
  if (mode === ABILITY_DAMAGE_LIMB_MODES.randomCritical) {
    return {
      limbKey: selectRandomWeightedLimbKey(recipient?.actor, { criticalOnly: true }),
      scope: DAMAGE_SCOPE_HEALTH_AND_LIMB
    };
  }
  if (mode === ABILITY_DAMAGE_LIMB_MODES.selected) {
    const selected = typeof getSelectedLimbKey === "function"
      ? await getSelectedLimbKey(recipient, { construct, entry })
      : entry?.selectedLimbKey ?? entry?.limbKey ?? entry?.target?.limbKey;
    return {
      limbKey: String(selected ?? "").trim(),
      scope: DAMAGE_SCOPE_HEALTH_AND_LIMB
    };
  }
  return {
    limbKey: selectRandomWeightedLimbKey(recipient?.actor),
    scope: DAMAGE_SCOPE_HEALTH_AND_LIMB
  };
}

function resolveMatchedSubject(entry, sourceActor, sourceToken) {
  const actor = entry?.actor
    ?? entry?.target?.actor
    ?? (entry?.subject === "source" ? sourceActor : null);
  if (!actor) return null;
  const token = entry?.token
    ?? entry?.target?.token
    ?? (entry?.subject === "source" ? sourceToken : null);
  return { actor, token: token ?? null };
}

function normalizeRecipients(values = []) {
  return (Array.isArray(values) ? values : [values])
    .map(value => {
      if (value?.actor) return { actor: value.actor, token: value.token ?? value.document ?? null };
      if (value?.document?.actor) return { actor: value.document.actor, token: value.document };
      return null;
    })
    .filter(Boolean);
}

function enrichSourceRecipient(recipient, sourceActor, sourceToken) {
  if (
    sourceToken
    && recipient?.actor
    && recipient.actor === sourceActor
    && !recipient.token
  ) {
    return { ...recipient, token: sourceToken };
  }
  return recipient;
}

function flattenRequests(value) {
  return (Array.isArray(value) ? value : [value]).flat(Infinity).filter(Boolean);
}

function normalizeDamageAmount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function normalizeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function evaluateAttackDamageFormula(formula, sourceActor, {
  fallback = 0,
  minimum = 0,
  targetActor = null,
  subjectActor = null
} = {}) {
  return evaluateAttackTrialDifficulty({
    formula,
    sourceActor,
    targetActor,
    subjectActor,
    fallback,
    minimum
  });
}

function getDocumentIdentity(value) {
  if (typeof value === "string") return value;
  return String(
    value?.document?.uuid
    ?? value?.uuid
    ?? value?.token?.document?.uuid
    ?? value?.token?.uuid
    ?? value?.actor?.uuid
    ?? value?.document?.id
    ?? value?.id
    ?? ""
  );
}
