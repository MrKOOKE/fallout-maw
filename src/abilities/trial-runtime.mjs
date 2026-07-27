import {
  ABILITY_CONDITION_TYPES,
  ABILITY_CONSTRUCT_TYPES,
  ABILITY_TRIAL_LINK_MODES,
  ABILITY_TRIAL_LINK_RECIPIENTS,
  ABILITY_TRIAL_SELECTION_MODES,
  ABILITY_TRIAL_SUBJECTS,
  normalizeAbilityConstructs
} from "../settings/abilities.mjs";
import { SYSTEM_ID } from "../constants.mjs";
import { requestSkillCheckBatch } from "../rolls/skill-check.mjs";
import { evaluateActorFormula } from "../utils/actor-formulas.mjs";
import { prepareEffectChangeForApplication } from "../utils/effect-change-values.mjs";
import { grantActorReactionPoints, REACTION_RESOURCE_KEY } from "../combat/reaction-resources.mjs";
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
  worldTime = Number(game.time?.worldTime) || 0
} = {}) {
  const trials = (abilityFunction?.conditions ?? [])
    .filter(condition => condition?.type === ABILITY_CONDITION_TYPES.trial);
  if (!trials.length || !sourceActor) return { attempted: 0, matched: 0 };

  const normalizedConstructs = normalizeAbilityConstructs(constructs);
  let attempted = 0;
  let matched = 0;
  for (const trial of trials) {
    const subjects = trial.trialSubject === ABILITY_TRIAL_SUBJECTS.source
      ? [{ actor: sourceActor, token: sourceToken }]
      : uniqueActorTargets(targets);
    const entries = buildTrialCheckEntries(trial, subjects, sourceActor, sourceToken);
    if (!entries.length) continue;
    attempted += entries.length;

    const subjectByActor = new Map(entries.map(entry => [entry.actor.uuid, entry.subject]));
    const batch = await requestSkillCheckBatch({
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

    const accepted = new Set(trial.trialResultKeys ?? []);
    const matchedSubjects = [];
    for (const outcome of batch?.outcomes ?? []) {
      if (!accepted.has(String(outcome?.result?.key ?? ""))) continue;
      const subject = subjectByActor.get(String(outcome?.actor?.uuid ?? ""));
      if (subject) matchedSubjects.push(subject);
    }
    if (!matchedSubjects.length) continue;
    matched += matchedSubjects.length;
    await executeAbilityTrialLinks({
      trial,
      constructs: normalizedConstructs,
      matchedSubjects,
      targets,
      sourceActor,
      sourceEffect,
      sourceItemUuid,
      title,
      worldTime
    });
  }
  return { attempted, matched };
}

function buildTrialCheckEntries(trial, subjects, sourceActor, sourceToken) {
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
        difficulty: evaluateActorFormula(trial.trialDifficultyFormula, sourceActor, {
          fallback: 0,
          minimum: 0,
          context: "ability trial difficulty"
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
  trial,
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
    const construct = constructsById.get(String(link?.constructId ?? ""));
    if (!construct) continue;
    const recipients = link.recipient === ABILITY_TRIAL_LINK_RECIPIENTS.source
      ? [{ actor: sourceActor, token: null }]
      : link.recipient === ABILITY_TRIAL_LINK_RECIPIENTS.targets
        ? uniqueActorTargets(targets)
        : matchedSubjects;
    const multiplier = link.recipient === ABILITY_TRIAL_LINK_RECIPIENTS.source
      && link.mode === ABILITY_TRIAL_LINK_MODES.perSubject
      ? matchedSubjects.length
      : 1;
    if (construct.type === ABILITY_CONSTRUCT_TYPES.temporaryEffect) {
      await applyTemporaryConstruct({
        construct,
        recipients,
        sourceEffect,
        sourceItemUuid,
        title,
        worldTime
      });
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

async function applyTemporaryConstruct({
  construct,
  recipients,
  sourceEffect,
  sourceItemUuid,
  title,
  worldTime
}) {
  const durationSeconds = Math.max(0, toInteger(construct.durationSeconds));
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
