import { SYSTEM_ID, TRAUMA_CREATE_OPTION } from "../constants.mjs";
import { getCreatureOptions, getDamageTypeSettings, getTraumaSettings } from "../settings/accessors.mjs";
import { getTraumaGroupForActor } from "../settings/traumas.mjs";
import { toInteger } from "../utils/numbers.mjs";

const DAMAGE_SOCKET = `system.${SYSTEM_ID}`;
const TRAUMA_FLAG_SCOPE = "fallout-maw";
const TRAUMA_FLAG_KEY = "trauma";
const MODE_DAMAGE = "damage";
const MODE_HEALING = "healing";
const SCOPE_LIMB = "limb";
const SCOPE_HEALTH = "health";
const SCOPE_HEALTH_AND_LIMB = "healthAndLimb";

export function registerDamageSocket() {
  game.socket.on(DAMAGE_SOCKET, handleDamageSocketMessage);
}

export async function requestDamageApplication({
  actor = null,
  actorUuid = "",
  limbKey = "",
  amount = 0,
  damageTypeKey = "",
  mode = MODE_DAMAGE,
  scope = SCOPE_HEALTH_AND_LIMB,
  applyMitigation = true,
  source = {}
} = {}) {
  const resolvedActor = actor ?? await fromUuid(actorUuid);
  if (!resolvedActor) return undefined;

  const request = normalizeDamageRequest({
    actorUuid: resolvedActor.uuid,
    limbKey,
    amount,
    damageTypeKey,
    mode,
    scope,
    applyMitigation,
    source,
    requesterUserId: game.user?.id ?? ""
  });

  if (canApplyDamageLocally(resolvedActor)) return applyDamageApplication(request);

  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("Нет активного GM для применения урона.");
    return undefined;
  }

  game.socket.emit(DAMAGE_SOCKET, {
    action: "applyDamage",
    gmUserId: gm.id,
    request
  });
  return undefined;
}

export async function applyDamageApplication(request = {}) {
  const data = normalizeDamageRequest(request);
  const actor = await fromUuid(data.actorUuid);
  if (!actor) return undefined;
  if (!game.user?.isGM && !actor.isOwner) return undefined;

  const mode = data.mode === MODE_HEALING ? MODE_HEALING : MODE_DAMAGE;
  const scope = normalizeScope(data.scope, data.limbKey);
  const damageType = getDamageTypeSettings().find(entry => entry.key === data.damageTypeKey);
  const effectiveAmount = mode === MODE_DAMAGE && data.applyMitigation
    ? calculateEffectiveDamage(actor, data.amount, damageType?.key ?? "", data.limbKey)
    : data.amount;
  if (effectiveAmount <= 0) return { actor, amount: 0, mode, scope };

  const updateData = {};
  const limb = data.limbKey ? actor.system?.limbs?.[data.limbKey] : null;
  const shouldUpdateHealth = scope === SCOPE_HEALTH || scope === SCOPE_HEALTH_AND_LIMB;
  const shouldUpdateLimb = Boolean(limb) && (scope === SCOPE_LIMB || scope === SCOPE_HEALTH_AND_LIMB);
  let actualLimbDelta = 0;
  let previousLimbValue = limb ? toInteger(limb.value) : 0;
  let nextLimbValue = previousLimbValue;

  if (shouldUpdateHealth && actor.health) {
    const health = actor.health;
    const current = toInteger(health.value);
    const min = toInteger(health.min);
    const max = toInteger(health.max);
    const next = mode === MODE_DAMAGE
      ? Math.max(min, current - effectiveAmount)
      : Math.min(max, current + effectiveAmount);
    updateData["system.resources.health.value"] = next;
  }

  if (shouldUpdateLimb) {
    const min = toInteger(limb.min);
    const max = toInteger(limb.max);
    if (mode === MODE_DAMAGE) {
      nextLimbValue = Math.max(min, previousLimbValue - effectiveAmount);
      actualLimbDelta = Math.max(0, previousLimbValue - nextLimbValue);
    } else {
      const cap = getLimbHealingCap(actor, data.limbKey);
      nextLimbValue = Math.min(Math.min(max, cap), previousLimbValue + effectiveAmount);
      actualLimbDelta = Math.max(0, nextLimbValue - previousLimbValue);
    }
    updateData[`system.limbs.${data.limbKey}.value`] = nextLimbValue;
    Object.assign(updateData, buildAccumulationUpdate(actor, data.limbKey, data.damageTypeKey, actualLimbDelta, mode));
  }

  if (Object.keys(updateData).length) await actor.update(updateData);

  const createdTraumas = shouldUpdateLimb && mode === MODE_DAMAGE && actualLimbDelta > 0
    ? await createTriggeredTraumas(actor, {
      limbKey: data.limbKey,
      damageTypeKey: damageType?.key ?? data.damageTypeKey,
      previousValue: previousLimbValue,
      nextValue: nextLimbValue,
      latestDamage: actualLimbDelta
    })
    : [];

  return {
    actor,
    amount: effectiveAmount,
    mode,
    scope,
    limbKey: data.limbKey,
    damageTypeKey: damageType?.key ?? data.damageTypeKey,
    createdTraumas
  };
}

export function getActorTraumas(actor) {
  return actor?.items?.filter(item => item.type === "trauma") ?? [];
}

export function getLimbHealingCap(actor, limbKey = "") {
  const limb = actor?.system?.limbs?.[limbKey];
  if (!limb) return 0;
  const max = toInteger(limb.max);
  return getActorTraumas(actor)
    .filter(item => item.system?.limbKey === limbKey)
    .reduce((cap, item) => Math.min(cap, toInteger(item.system?.thresholdValue)), max);
}

async function handleDamageSocketMessage(payload = {}) {
  if (!payload || payload.action !== "applyDamage") return;
  if (!game.user?.isGM || payload.gmUserId !== game.user.id) return;
  await applyDamageApplication(payload.request);
}

function normalizeDamageRequest(request = {}) {
  const amount = Math.max(0, Math.floor(Number(request.amount) || 0));
  const limbKey = String(request.limbKey ?? "").trim();
  return {
    actorUuid: String(request.actorUuid ?? request.actor?.uuid ?? "").trim(),
    limbKey,
    amount,
    damageTypeKey: String(request.damageTypeKey ?? "").trim(),
    mode: request.mode === MODE_HEALING || request.mode === "heal" ? MODE_HEALING : MODE_DAMAGE,
    scope: normalizeScope(request.scope, limbKey),
    applyMitigation: request.applyMitigation !== false,
    source: request.source && typeof request.source === "object" ? request.source : {},
    requesterUserId: String(request.requesterUserId ?? "")
  };
}

function normalizeScope(scope, limbKey = "") {
  if (scope === SCOPE_HEALTH) return SCOPE_HEALTH;
  if (scope === SCOPE_LIMB) return limbKey ? SCOPE_LIMB : SCOPE_HEALTH;
  return limbKey ? SCOPE_HEALTH_AND_LIMB : SCOPE_HEALTH;
}

function canApplyDamageLocally(actor) {
  return Boolean(game.user?.isGM || actor?.isOwner);
}

function getResponsibleGM() {
  return (game.users?.contents ?? [])
    .filter(user => user.active && user.isGM)
    .sort((left, right) => left.id.localeCompare(right.id))
    .at(0) ?? null;
}

function calculateEffectiveDamage(actor, amount, damageTypeKey = "", limbKey = "") {
  const incomingDamage = Math.max(0, Math.floor(Number(amount) || 0));
  if (!incomingDamage) return 0;
  if (!damageTypeKey) return incomingDamage;

  const resistance = actor.getDamageResistance?.(damageTypeKey, limbKey) ?? 0;
  const defense = Math.min(100, actor.getDamageDefense?.(damageTypeKey, limbKey) ?? 0);
  const reduction = actor.getDamageReduction?.(damageTypeKey, limbKey) ?? 0;
  const defendedDamage = Math.floor(incomingDamage * (1 - (defense / 100)));
  return Math.max(0, defendedDamage - resistance - reduction);
}

function buildAccumulationUpdate(actor, limbKey, damageTypeKey, amount, mode) {
  const limb = actor.system?.limbs?.[limbKey];
  const current = { ...(limb?.damageAccumulation ?? {}) };
  const update = {};
  if (!amount) return update;

  if (mode === MODE_DAMAGE) {
    const key = damageTypeKey || "untyped";
    current[key] = Math.max(0, Number(current[key]) || 0) + amount;
  } else {
    diluteDamageAccumulation(current, amount);
  }

  const normalized = Object.fromEntries(
    Object.entries(current)
      .map(([key, value]) => [key, Math.max(0, Number(value) || 0)])
      .filter(([_key, value]) => value > 0.0001)
  );

  update[`system.limbs.${limbKey}.damageAccumulation`] = normalized;
  return update;
}

function diluteDamageAccumulation(accumulation, healingAmount) {
  const total = Object.values(accumulation).reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
  if (total <= 0) return;
  const reduction = Math.min(total, Math.max(0, Number(healingAmount) || 0));
  for (const [key, value] of Object.entries(accumulation)) {
    const share = Math.max(0, Number(value) || 0) / total;
    accumulation[key] = Math.max(0, value - (reduction * share));
  }
}

async function createTriggeredTraumas(actor, { limbKey, damageTypeKey, previousValue, nextValue, latestDamage } = {}) {
  const limb = actor.system?.limbs?.[limbKey];
  if (!limb || toInteger(limb.max) <= 0) return [];

  const creatureOptions = getCreatureOptions();
  const damageTypes = getDamageTypeSettings();
  const traumaSettings = getTraumaSettings(creatureOptions, damageTypes);
  const traumaGroup = getTraumaGroupForActor(actor, traumaSettings, creatureOptions, damageTypes);
  const stages = traumaGroup.config?.limbs?.[limbKey]?.stages ?? [];
  if (!stages.length) return [];

  const max = toInteger(limb.max);
  const previousPercent = (previousValue / max) * 100;
  const nextPercent = (nextValue / max) * 100;
  const triggeredStages = stages.filter(stage => (
    previousPercent > Number(stage.thresholdPercent)
    && nextPercent <= Number(stage.thresholdPercent)
    && !hasExistingTrauma(actor, limbKey, stage.id)
  ));
  if (!triggeredStages.length) return [];

  const snapshot = {
    ...(actor.system?.limbs?.[limbKey]?.damageAccumulation ?? {})
  };

  const createData = triggeredStages
    .map(stage => buildTraumaItemData(actor, {
      limb,
      limbKey,
      limbSetId: traumaGroup.id,
      stage,
      damageTypes,
      damageTypeKey,
      latestDamage,
      snapshot,
      nextValue
    }))
    .filter(Boolean);

  if (!createData.length) return [];
  return actor.createEmbeddedDocuments("Item", createData, {
    [TRAUMA_CREATE_OPTION]: true
  });
}

function buildTraumaItemData(actor, { limb, limbKey, limbSetId, stage, damageTypes, damageTypeKey, latestDamage, snapshot, nextValue }) {
  const profileEntry = selectTraumaProfile(stage, snapshot, damageTypeKey, latestDamage);
  if (!profileEntry) return null;

  const damageType = damageTypes.find(entry => entry.key === profileEntry.damageTypeKey);
  const thresholdPercent = toInteger(stage.thresholdPercent);
  const thresholdValue = Math.floor((toInteger(limb.max) * thresholdPercent) / 100);
  const limbLabel = String(limb.label ?? limbKey);
  const name = profileEntry.profile.name || `${limbLabel}: ${damageType?.label ?? profileEntry.damageTypeKey}`;
  const img = profileEntry.profile.img || "icons/svg/blood.svg";
  const effectChanges = (profileEntry.profile.effects ?? [])
    .map(prepareEffectChange)
    .filter(change => change.key);

  return {
    type: "trauma",
    name,
    img,
    system: {
      description: "",
      limbSetId,
      limbKey,
      limbLabel,
      stageId: stage.id,
      damageTypeKey: profileEntry.damageTypeKey,
      damageTypeLabel: damageType?.label ?? profileEntry.damageTypeKey,
      thresholdPercent,
      thresholdValue,
      triggeredAtValue: nextValue,
      healingDifficulty: toInteger(profileEntry.profile.healingDifficulty ?? 60),
      healingToolClass: String(profileEntry.profile.healingToolClass ?? "D").trim().toUpperCase() || "D",
      healingProgress: 0,
      healingProgressMax: toInteger(profileEntry.profile.healingProgress ?? 100),
      healingSkillKey: String(profileEntry.profile.healingSkillKey ?? "doctor").trim() || "doctor",
      damageSnapshot: snapshot,
      generated: true,
      effects: effectChanges
    },
    flags: {
      [TRAUMA_FLAG_SCOPE]: {
        generatedTrauma: true,
        [TRAUMA_FLAG_KEY]: {
          actorUuid: actor.uuid,
          limbKey,
          stageId: stage.id
        }
      }
    },
    effects: [{
      type: "base",
      name,
      img,
      transfer: true,
      disabled: false,
      system: {
        changes: effectChanges
      },
      flags: {
        [TRAUMA_FLAG_SCOPE]: {
          kind: "active",
          traumaItem: true
        }
      }
    }]
  };
}

function prepareEffectChange(effect = {}) {
  const change = {
    key: String(effect.key ?? "").trim(),
    type: effect.type || "add",
    value: String(effect.value ?? "0"),
    phase: effect.phase || "initial"
  };
  const priority = Number(effect.priority);
  if (Number.isFinite(priority)) change.priority = Math.trunc(priority);
  return change;
}

function selectTraumaProfile(stage, snapshot = {}, latestDamageTypeKey = "", latestDamage = 0) {
  const weighted = Object.entries(snapshot ?? {})
    .map(([key, value]) => [key, Math.max(0, Number(value) || 0) + (key === latestDamageTypeKey ? Math.max(0, Number(latestDamage) || 0) : 0)])
    .sort((left, right) => right[1] - left[1]);
  if (latestDamageTypeKey && !weighted.some(([key]) => key === latestDamageTypeKey)) {
    weighted.push([latestDamageTypeKey, Math.max(0, Number(latestDamage) || 0)]);
  }

  for (const [damageTypeKey] of weighted) {
    const profile = stage.profiles?.[damageTypeKey];
    if (isConfiguredProfile(profile)) return { damageTypeKey, profile };
  }
  return null;
}

function isConfiguredProfile(profile) {
  if (!profile) return false;
  return Boolean(String(profile.name ?? "").trim() || String(profile.img ?? "").trim() || profile.effects?.length);
}

function hasExistingTrauma(actor, limbKey, stageId) {
  return getActorTraumas(actor).some(item => item.system?.limbKey === limbKey && item.system?.stageId === stageId);
}
