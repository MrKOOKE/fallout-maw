import {
  ABILITY_CONDITION_TYPES,
  ABILITY_CONSTRUCT_TYPES,
  ABILITY_DAMAGE_AMOUNT_MODES,
  ABILITY_DAMAGE_LIMB_MODES,
  ABILITY_TRIAL_BRANCH_FLOWS,
  ABILITY_TRIAL_LINK_KINDS,
  ABILITY_TRIAL_LINK_MODES,
  ABILITY_TRIAL_LINK_RECIPIENTS,
  ABILITY_TRIAL_SELECTION_MODES,
  ABILITY_TRIAL_SUBJECTS,
  getAbilityFunctionEffectDurationSeconds,
  normalizeActiveApplicationSettings,
  normalizeAbilityCondition,
  normalizeAbilityConstructs
} from "../settings/abilities.mjs";
import { SYSTEM_ID } from "../constants.mjs";
import { requestSkillCheckBatch } from "../rolls/skill-check.mjs";
import { evaluateActorFormula } from "../utils/actor-formulas.mjs";
import {
  prepareEffectChangeForApplication,
  tryEvaluateEffectChangeValue
} from "../utils/effect-change-values.mjs";
import { grantActorReactionPoints, REACTION_RESOURCE_KEY } from "../combat/reaction-resources.mjs";
import { selectRandomWeightedLimbKey } from "../utils/limb-randomization.mjs";
import { evaluateAttackTrialDifficulty } from "../combat/attack-trial-resolution.mjs";
import { toInteger } from "../utils/numbers.mjs";

export const TRIAL_CONSTRUCT_EFFECT_FLAG_KEY = "trialConstructEffect";

const ACTIVE_EFFECT_SHOW_ICON_ALWAYS = 2;

export async function executeAbilityTrials({
  abilityFunction = {},
  constructs = [],
  sourceActor = null,
  sourceToken = null,
  targets = [],
  sourceEffect = null,
  sourceItemUuid = "",
  title = "",
  worldTime = Number(game.time?.worldTime) || 0,
  requestSkillCheckBatchFn = requestSkillCheckBatch,
  executeTrialLinksFn = executeAbilityTrialLinks,
  requestDamageApplicationsFn = null
} = {}) {
  const trials = (abilityFunction?.conditions ?? [])
    .filter(condition => condition?.type === ABILITY_CONDITION_TYPES.trial)
    .map(condition => normalizeAbilityCondition(condition));
  if (!trials.length || !sourceActor) return { attempted: 0, matched: 0 };

  const normalizedConstructs = normalizeAbilityConstructs(constructs);
  let attempted = 0;
  let matched = 0;
  let stoppedAll = false;
  let sourceStopped = false;
  const stoppedTargetActorUuids = new Set();
  for (const trial of trials) {
    if (stoppedAll) break;
    const sourceTrial = trial.trialSubject === ABILITY_TRIAL_SUBJECTS.source;
    const subjects = sourceTrial
      ? (sourceStopped ? [] : [{ actor: sourceActor, token: sourceToken }])
      : uniqueActorTargets(targets).filter(subject => (
        !stoppedTargetActorUuids.has(String(subject.actor?.uuid ?? ""))
      ));
    const entries = await buildTrialCheckEntries(trial, subjects, sourceActor, sourceToken);
    if (!entries.length) continue;
    attempted += entries.length;

    const subjectByActor = new Map(entries.map(entry => [entry.actor.uuid, entry.subject]));
    const batch = await requestSkillCheckBatchFn({
      entries: entries.map(entry => ({
        actor: entry.actor,
        skillKey: entry.skillKey,
        data: entry.data
      })),
      animate: false,
      createMessage: true,
      requester: "abilityTrial",
      title: title || sourceEffect?.name || "Испытание",
      options: {
        operationId: `ability-trial:${String(sourceEffect?.id ?? sourceItemUuid)}:${trial.id}:${worldTime}`
      },
      source: { itemUuid: String(sourceItemUuid ?? "") }
    });

    const subjectsByResultKey = new Map();
    for (const outcome of batch?.outcomes ?? []) {
      const resultKey = String(outcome?.result?.key ?? "");
      const subject = subjectByActor.get(String(outcome?.actor?.uuid ?? ""));
      if (!resultKey || !subject) continue;
      const resultSubjects = subjectsByResultKey.get(resultKey) ?? [];
      resultSubjects.push(subject);
      subjectsByResultKey.set(resultKey, resultSubjects);
    }
    let stopAllAfterCurrentTrial = false;
    for (const branch of trial.trialBranches ?? []) {
      const matchedSubjects = uniqueActorTargets((branch?.resultKeys ?? [])
        .flatMap(resultKey => subjectsByResultKey.get(resultKey) ?? []));
      if (!matchedSubjects.length) continue;
      matched += matchedSubjects.length;
      await executeTrialLinksFn({
        abilityFunction,
        trial,
        branch,
        links: branch.links,
        constructs: normalizedConstructs,
        matchedSubjects,
        targets,
        sourceActor,
        sourceEffect,
        sourceItemUuid,
        title,
        worldTime,
        onDamage: context => applyOrdinaryTrialDamage({
          ...context,
          sourceActor,
          sourceEffect,
          sourceItemUuid,
          trial,
          branch,
          worldTime,
          requestDamageApplicationsFn
        })
      });
      if (branch.flow === ABILITY_TRIAL_BRANCH_FLOWS.stopAll) {
        stopAllAfterCurrentTrial = true;
      } else if (branch.flow === ABILITY_TRIAL_BRANCH_FLOWS.stopSubject) {
        if (sourceTrial) sourceStopped = true;
        else {
          for (const subject of matchedSubjects) {
            const actorUuid = String(subject.actor?.uuid ?? "");
            if (actorUuid) stoppedTargetActorUuids.add(actorUuid);
          }
        }
      }
    }
    if (stopAllAfterCurrentTrial) stoppedAll = true;
  }
  return { attempted, matched, stoppedAll };
}

async function buildTrialCheckEntries(trial, subjects, sourceActor, sourceToken) {
  const configured = (trial.trialEntries ?? [])
    .filter(entry => entry?.kind === "skill" && String(entry?.key ?? "").trim());
  const entries = [];
  for (const subject of subjects) {
    const ranked = configured
      .map((entry, order) => ({
        skillKey: String(entry.key),
        order,
        value: Number(subject.actor?.system?.skills?.[entry.key]?.value)
      }))
      .filter(entry => Number.isFinite(entry.value))
      .sort((left, right) => (
        trial.trialSelectionMode === ABILITY_TRIAL_SELECTION_MODES.worst
          ? left.value - right.value || left.order - right.order
          : right.value - left.value || left.order - right.order
      ));
    const selected = ranked[0];
    if (!selected) continue;
    entries.push({
      actor: subject.actor,
      subject,
      skillKey: selected.skillKey,
      data: {
        difficulty: await evaluateAttackTrialDifficulty({
          formula: trial.trialDifficultyFormula,
          sourceActor,
          targetActor: subject.actor,
          subjectActor: subject.actor,
          fallback: 0,
          minimum: 0
        }),
        actorToken: subject.token,
        targetActor: sourceActor,
        targetToken: sourceToken,
        allowImplicitTarget: false
      }
    });
  }
  return entries;
}

export async function executeAbilityTrialLinks({
  abilityFunction = null,
  trial,
  branch = null,
  links = trial?.trialLinks ?? [],
  constructs,
  matchedSubjects,
  targets = [],
  sourceActor,
  sourceEffect,
  sourceItemUuid,
  title,
  worldTime,
  onDamage = null
}) {
  const constructsById = new Map(constructs.map(construct => [construct.id, construct]));
  const resourceGrants = new Map();
  for (const link of links ?? []) {
    const recipients = link.recipient === ABILITY_TRIAL_LINK_RECIPIENTS.source
      ? [{ actor: sourceActor, token: null }]
      : link.recipient === ABILITY_TRIAL_LINK_RECIPIENTS.targets
        ? uniqueActorTargets(targets)
        : matchedSubjects;
    const multiplier = link.recipient === ABILITY_TRIAL_LINK_RECIPIENTS.source
      && link.mode === ABILITY_TRIAL_LINK_MODES.perSubject
      ? matchedSubjects.length
      : 1;
    if ([
      ABILITY_TRIAL_LINK_KINDS.primaryChanges,
      ABILITY_TRIAL_LINK_KINDS.primaryChangesPercent
    ].includes(link?.kind)) {
      await applyPrimaryChangeLink({
        abilityFunction,
        trial,
        branch,
        link,
        recipients,
        multiplier,
        sourceActor,
        sourceEffect,
        sourceItemUuid,
        title,
        worldTime
      });
      continue;
    }
    const construct = constructsById.get(String(link?.constructId ?? ""));
    if (!construct) continue;
    if (construct.type === ABILITY_CONSTRUCT_TYPES.temporaryEffect) {
      for (const recipient of uniqueActorTargets(recipients)) {
        const durationSeconds = await resolveTrialLinkDurationSeconds({
          abilityFunction,
          link,
          sourceActor,
          recipient,
          fallbackSeconds: construct.durationSeconds
        });
        await applyTemporaryConstruct({
          construct: { ...construct, durationSeconds },
          recipients: [recipient],
          sourceEffect,
          sourceItemUuid,
          title,
          worldTime
        });
      }
    } else if (construct.type === ABILITY_CONSTRUCT_TYPES.resourceChange) {
      collectResourceConstructGrants(resourceGrants, construct, recipients, multiplier);
    } else if (
      construct.type === ABILITY_CONSTRUCT_TYPES.damage
      && typeof onDamage === "function"
    ) {
      await onDamage({ construct, recipients: uniqueActorTargets(recipients), multiplier, link });
    }
  }
  await commitResourceGrants(resourceGrants);
}

async function applyPrimaryChangeLink({
  abilityFunction,
  trial,
  branch,
  link,
  recipients = [],
  multiplier = 1,
  sourceActor,
  sourceEffect,
  sourceItemUuid,
  title,
  worldTime
}) {
  const primaryDurationSeconds = getAbilityFunctionEffectDurationSeconds(abilityFunction);
  const primaryChanges = (abilityFunction?.changes ?? [])
    .filter(change => change?.key && String(change?.value ?? "") !== "");
  if (!primaryDurationSeconds || !primaryChanges.length) return;

  const settings = normalizeActiveApplicationSettings(abilityFunction?.activeSettings);
  const uniqueRecipients = uniqueActorTargets(recipients);
  for (const recipient of uniqueRecipients) {
    const durationSeconds = link?.kind === ABILITY_TRIAL_LINK_KINDS.primaryChangesPercent
      ? await resolveTrialLinkDurationSeconds({
        abilityFunction,
        link,
        sourceActor,
        recipient,
        fallbackSeconds: primaryDurationSeconds
      })
      : primaryDurationSeconds;
    if (!durationSeconds) continue;
    const evaluationActor = settings.changeEvaluation === "source"
      ? sourceActor
      : recipient.actor;
    let ratio = Math.max(1, toInteger(multiplier));
    if (link?.kind === ABILITY_TRIAL_LINK_KINDS.primaryChangesPercent) {
      const percent = await evaluateAttackTrialDifficulty({
        formula: link?.percentFormula,
        sourceActor,
        targetActor: recipient.actor,
        subjectActor: recipient.actor,
        fallback: 0,
        minimum: 0
      });
      ratio *= Math.max(0, Number(percent) || 0) / 100;
    }

    const changes = primaryChanges
      .map(change => preparePrimaryChangeForRatio(evaluationActor, change, ratio))
      .filter(change => change?.key && String(change?.value ?? "") !== "");
    if (!changes.length) continue;
    await applyTemporaryConstruct({
      construct: {
        id: [
          "primary",
          String(abilityFunction?.id ?? ""),
          String(trial?.id ?? ""),
          String(branch?.id ?? ""),
          String(link?.id ?? "")
        ].join(":"),
        type: ABILITY_CONSTRUCT_TYPES.temporaryEffect,
        name: title || sourceEffect?.name || "Испытание",
        durationSeconds,
        changes
      },
      recipients: [recipient],
      sourceEffect,
      sourceItemUuid,
      title,
      worldTime
    });
  }
}

async function resolveTrialLinkDurationSeconds({
  abilityFunction,
  link,
  sourceActor,
  recipient,
  fallbackSeconds = 0
}) {
  const primaryDurationSeconds = getAbilityFunctionEffectDurationSeconds(abilityFunction);
  if (!primaryDurationSeconds) return Math.max(0, Number(fallbackSeconds) || 0);
  const percent = await evaluateAttackTrialDifficulty({
    formula: link?.durationPercentFormula,
    sourceActor,
    targetActor: recipient?.actor,
    subjectActor: recipient?.actor,
    fallback: 100,
    minimum: 0
  });
  return Math.max(
    0,
    Math.round(primaryDurationSeconds * (Math.max(0, Number(percent) || 0) / 100))
  );
}

function preparePrimaryChangeForRatio(actor, change = {}, ratio = 1) {
  if (ratio === 1) return prepareEffectChangeForApplication(actor, change);
  const evaluated = tryEvaluateEffectChangeValue(actor, change?.value);
  if (!evaluated.ok || !Number.isFinite(evaluated.value)) return null;
  const type = String(change?.type ?? "add");
  const scaled = type === "multiply"
    ? 1 + ((evaluated.value - 1) * ratio)
    : evaluated.value * ratio;
  if (!Number.isFinite(scaled)) return null;
  return {
    ...change,
    value: Math.round((scaled + Number.EPSILON) * 1_000_000) / 1_000_000
  };
}

async function applyOrdinaryTrialDamage({
  construct,
  recipients = [],
  multiplier = 1,
  sourceActor,
  sourceEffect,
  sourceItemUuid,
  trial,
  branch,
  worldTime,
  requestDamageApplicationsFn = null
}) {
  if (construct?.type !== ABILITY_CONSTRUCT_TYPES.damage) return;
  const requests = [];
  const count = Math.max(1, toInteger(multiplier));
  for (const recipient of uniqueActorTargets(recipients)) {
    const damage = construct.damage ?? {};
    const evaluatedAmount = damage.amountMode === ABILITY_DAMAGE_AMOUNT_MODES.formula
      ? await evaluateAttackTrialDifficulty({
        formula: damage.formula,
        sourceActor,
        targetActor: recipient.actor,
        subjectActor: recipient.actor,
        fallback: 0,
        minimum: 0
      })
      : 0;
    const amount = Math.max(0, toInteger(evaluatedAmount * count));
    if (!amount) continue;
    const location = resolveOrdinaryTrialDamageLocation(damage, recipient);
    requests.push({
      actor: recipient.actor,
      amount,
      damageTypeKey: String(damage.damageTypeKey ?? "").trim(),
      limbKey: location.limbKey,
      scope: location.scope,
      applyMitigation: true,
      processDamageTypeSettings: true,
      source: {
        ability: true,
        abilityItemUuid: String(sourceItemUuid ?? ""),
        sourceEffectUuid: String(sourceEffect?.uuid ?? ""),
        sourceActorUuid: String(sourceActor?.uuid ?? ""),
        trialId: String(trial?.id ?? ""),
        trialBranchId: String(branch?.id ?? ""),
        constructId: String(construct?.id ?? ""),
        worldTime
      }
    });
  }
  if (!requests.length) return;
  const requestApplications = typeof requestDamageApplicationsFn === "function"
    ? requestDamageApplicationsFn
    : (await import("../combat/damage-hub.mjs")).requestDamageApplications;
  await requestApplications(requests);
}

function resolveOrdinaryTrialDamageLocation(damage = {}, recipient = {}) {
  const mode = String(damage?.limbMode ?? ABILITY_DAMAGE_LIMB_MODES.random);
  if (mode === ABILITY_DAMAGE_LIMB_MODES.healthOnly) {
    return { limbKey: "", scope: "health" };
  }
  if (mode === ABILITY_DAMAGE_LIMB_MODES.randomCritical) {
    return {
      limbKey: selectRandomWeightedLimbKey(recipient.actor, { criticalOnly: true }),
      scope: "healthAndLimb"
    };
  }
  if (mode === ABILITY_DAMAGE_LIMB_MODES.selected) {
    const selected = String(recipient?.limbKey ?? recipient?.token?.limbKey ?? "").trim();
    if (selected) return { limbKey: selected, scope: "healthAndLimb" };
  }
  return {
    limbKey: selectRandomWeightedLimbKey(recipient.actor),
    scope: "healthAndLimb"
  };
}

async function applyTemporaryConstruct({
  construct,
  recipients,
  sourceEffect,
  sourceItemUuid,
  title,
  worldTime
}) {
  const durationSeconds = Math.max(0, Number(construct.durationSeconds) || 0);
  if (!durationSeconds || !construct.changes?.length) return;
  for (const recipient of uniqueActorTargets(recipients)) {
    const actor = recipient.actor;
    const changes = construct.changes
      .map(change => prepareEffectChangeForApplication(actor, change))
      .filter(change => change?.key && String(change?.value ?? "") !== "");
    if (!changes.length) continue;
    const sourceEffectUuid = String(sourceEffect?.uuid ?? sourceItemUuid ?? "");
    const existing = actor.effects?.find(effect => {
      const flag = effect.getFlag?.(SYSTEM_ID, TRIAL_CONSTRUCT_EFFECT_FLAG_KEY);
      return flag?.sourceEffectUuid === sourceEffectUuid && flag?.constructId === construct.id;
    }) ?? null;
    const data = {
      type: "base",
      name: construct.name || title || sourceEffect?.name || "Испытание",
      img: sourceEffect?.img || "icons/svg/aura.svg",
      origin: sourceEffect?.origin || sourceItemUuid,
      transfer: false,
      disabled: false,
      showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
      start: { time: worldTime },
      duration: { value: durationSeconds, units: "seconds", expiry: null, expired: false },
      system: { changes },
      flags: {
        [SYSTEM_ID]: {
          kind: "temporary",
          [TRIAL_CONSTRUCT_EFFECT_FLAG_KEY]: {
            sourceEffectUuid,
            constructId: construct.id
          }
        }
      }
    };
    if (existing) {
      await existing.update({
        name: data.name,
        img: data.img,
        start: data.start,
        duration: data.duration,
        "system.changes": changes,
        [`flags.${SYSTEM_ID}.${TRIAL_CONSTRUCT_EFFECT_FLAG_KEY}`]:
          data.flags[SYSTEM_ID][TRIAL_CONSTRUCT_EFFECT_FLAG_KEY]
      }, { animate: false, falloutMawTrialRuntime: true });
    } else {
      await actor.createEmbeddedDocuments("ActiveEffect", [data], {
        animate: false,
        falloutMawTrialRuntime: true
      });
    }
  }
}

function collectResourceConstructGrants(grants, construct, recipients, multiplier) {
  for (const recipient of uniqueActorTargets(recipients)) {
    const actor = recipient.actor;
    const actorGrants = grants.get(actor.uuid) ?? { actor, resources: new Map() };
    for (const row of construct.resources ?? []) {
      const resourceKey = String(row?.resourceKey ?? "").trim();
      const amount = Math.max(0, toInteger(evaluateActorFormula(row?.formula, actor, {
        fallback: 0,
        minimum: 0,
        context: "ability trial resource change"
      }) * Math.max(1, multiplier)));
      if (!resourceKey || !amount) continue;
      actorGrants.resources.set(resourceKey, (actorGrants.resources.get(resourceKey) ?? 0) + amount);
    }
    if (actorGrants.resources.size) grants.set(actor.uuid, actorGrants);
  }
}

async function commitResourceGrants(grants) {
  for (const { actor, resources } of grants.values()) {
    const reactionAmount = Math.max(0, toInteger(resources.get(REACTION_RESOURCE_KEY)));
    if (reactionAmount) await grantActorReactionPoints(actor, reactionAmount);
    const update = {};
    for (const [resourceKey, amount] of resources) {
      if (resourceKey === REACTION_RESOURCE_KEY) continue;
      const resource = actor.system?.resources?.[resourceKey];
      if (!resource) continue;
      const current = Math.max(0, Number(resource.value) || 0);
      const maximum = Math.max(current, Number(resource.max) || 0);
      const next = Math.min(maximum, current + Math.max(0, toInteger(amount)));
      if (next === current) continue;
      update[`system.resources.${resourceKey}.value`] = next;
      update[`system.resources.${resourceKey}.spent`] = Math.max(0, maximum - next);
    }
    if (Object.keys(update).length) {
      await actor.update(update, { falloutMawTrialRuntime: true });
    }
  }
}

function uniqueActorTargets(targets = []) {
  const unique = new Map();
  for (const target of targets ?? []) {
    const actor = target?.actor ?? null;
    const actorUuid = String(actor?.uuid ?? "");
    if (actorUuid && !unique.has(actorUuid)) unique.set(actorUuid, { actor, token: target?.token ?? null });
  }
  return Array.from(unique.values());
}
