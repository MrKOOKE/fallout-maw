import { SYSTEM_ID } from "../constants.mjs";
import { requestCustomActorTokenSelection } from "../canvas/custom-token-selection.mjs";
import { getActorFactionRelation } from "../settings/factions.mjs";
import { getActiveRulesProfile } from "../settings/rules-profiles.mjs";
import { toInteger } from "../utils/numbers.mjs";

export const HUNTER_RACE_FIXED_KEY = "hunterRace";
export const HUNTER_RACE_EFFECT_FLAG_KEY = "hunterRace";

const ACTIVE_EFFECT_SHOW_ICON_ALWAYS = 2;
const DEFAULT_ICON = "icons/svg/target.svg";

export function normalizeHunterRaceSettings(value = {}) {
  return {
    energyCost: Math.max(0, toInteger(value?.energyCost ?? 20)),
    overloadEnergyCost: Math.max(0, toInteger(value?.overloadEnergyCost ?? 40)),
    overloadDurationSeconds: Math.max(0, toInteger(value?.overloadDurationSeconds ?? 60)),
    durationSeconds: Math.max(1, toInteger(value?.durationSeconds ?? 60)),
    accuracyBonus: toInteger(value?.accuracyBonus ?? 10),
    damagePercentBonus: toInteger(value?.damagePercentBonus ?? 5),
    criticalChanceBonus: toInteger(value?.criticalChanceBonus ?? 2)
  };
}

/**
 * UI-only target acquisition. Costs must be committed after this succeeds and
 * before activateHunterRaceEffect() is called by the fixed-function dispatcher.
 */
export async function selectHunterRaceTarget({
  actor = null,
  sourceToken = null,
  abilityName = "Охотник"
} = {}) {
  if (!actor) return null;
  const selection = await requestCustomActorTokenSelection({
    sourceActor: actor,
    sourceToken,
    includeSelf: false,
    title: abilityName,
    noneWarning: `${abilityName}: нет видимых врагов или нейтральных целей с указанной расой.`,
    instructions: `${abilityName}: выберите врага или нейтральную цель.`,
    getReason: ({ actor: targetActor }) => getHunterRaceTargetRejectionReason(actor, targetActor)
  });
  const targetToken = selection?.token ?? null;
  const targetActor = targetToken?.actor ?? selection?.actor ?? null;
  return getHunterRaceTargetRejectionReason(actor, targetActor)
    ? null
    : { actor: targetActor, token: targetToken };
}

export function getHunterRaceTargetRejectionReason(sourceActor = null, targetActor = null) {
  if (!sourceActor || !targetActor) return "Цель недоступна.";
  if (getActorFactionRelation(sourceActor, targetActor) === "ally") return "Союзники не могут быть целью.";
  if (!getActorRaceId(targetActor)) return "У цели не указана раса.";
  return "";
}

/** Create or replace this particular Hunter function's one-minute hunt. */
export async function activateHunterRaceEffect({
  actor = null,
  targetActor = null,
  abilityItem = null,
  abilityFunction = null,
  settings = abilityFunction?.fixedSettings ?? {},
  startTime = getWorldTime()
} = {}) {
  const rejection = getHunterRaceTargetRejectionReason(actor, targetActor);
  if (rejection || !abilityItem || !abilityFunction) {
    return { ok: false, reason: rejection || "Некорректная функция способности.", effect: null };
  }

  const normalized = normalizeHunterRaceSettings(settings);
  const raceId = getActorRaceId(targetActor);
  const data = buildHunterRaceEffectData({
    actor,
    targetActor,
    abilityItem,
    abilityFunction,
    settings: normalized,
    startTime
  });
  const existing = findHunterRaceEffect(actor, abilityItem, abilityFunction);
  try {
    if (existing) {
      await existing.update(data, { animate: false, falloutMawHunterRaceRuntime: true });
      return {
        ok: true,
        reason: "",
        effect: resolveCurrentDocument(existing),
        raceId,
        settings: normalized
      };
    }
    const [created] = await actor.createEmbeddedDocuments("ActiveEffect", [data], {
      animate: false,
      falloutMawHunterRaceRuntime: true
    });
    return { ok: Boolean(created), reason: created ? "" : "Эффект не создан.", effect: created ?? null, raceId, settings: normalized };
  } catch (error) {
    console.error(`${SYSTEM_ID} | Hunter activation failed`, error);
    return { ok: false, reason: "Не удалось начать охоту.", effect: null };
  }
}

export function buildHunterRaceEffectData({
  actor = null,
  targetActor = null,
  abilityItem = null,
  abilityFunction = null,
  settings = {},
  startTime = 0
} = {}) {
  const normalized = normalizeHunterRaceSettings(settings);
  const now = finiteNumber(startTime, 0);
  const raceId = getActorRaceId(targetActor);
  const raceName = getActorRaceName(targetActor) || raceId;
  const abilityName = getAbilityName(abilityItem);
  return {
    type: "base",
    name: `${abilityName}: ${raceName}`,
    img: abilityItem?.img || DEFAULT_ICON,
    description: `Охота на расу «${escapeHtml(raceName)}»: Точность +${normalized.accuracyBonus}, урон +${normalized.damagePercentBonus}%, шанс критического успеха +${normalized.criticalChanceBonus}%.`,
    origin: String(abilityItem?.uuid ?? ""),
    transfer: false,
    disabled: false,
    showIcon: ACTIVE_EFFECT_SHOW_ICON_ALWAYS,
    duration: { seconds: normalized.durationSeconds, startTime: now },
    system: { changes: [] },
    flags: {
      [SYSTEM_ID]: {
        kind: "temporary",
        [HUNTER_RACE_EFFECT_FLAG_KEY]: {
          sourceActorUuid: String(actor?.uuid ?? ""),
          abilityItemId: String(abilityItem?.id ?? ""),
          abilityItemUuid: String(abilityItem?.uuid ?? ""),
          abilitySourceId: getAbilitySourceId(abilityItem),
          functionId: String(abilityFunction?.id ?? ""),
          fixedKey: String(abilityFunction?.fixedKey ?? HUNTER_RACE_FIXED_KEY),
          raceId,
          raceName,
          createdAt: now,
          expiresAt: now + normalized.durationSeconds,
          settings: normalized
        }
      }
    }
  };
}

export function getHunterRaceEffectData(effect = null) {
  const raw = readFlag(effect, HUNTER_RACE_EFFECT_FLAG_KEY);
  if (!raw?.sourceActorUuid || !raw?.functionId || !raw?.raceId) return null;
  return {
    sourceActorUuid: String(raw.sourceActorUuid),
    abilityItemId: String(raw.abilityItemId ?? ""),
    abilityItemUuid: String(raw.abilityItemUuid ?? ""),
    abilitySourceId: String(raw.abilitySourceId ?? ""),
    functionId: String(raw.functionId),
    fixedKey: String(raw.fixedKey ?? HUNTER_RACE_FIXED_KEY),
    raceId: String(raw.raceId),
    raceName: String(raw.raceName ?? raw.raceId),
    createdAt: finiteNumber(raw.createdAt, 0),
    expiresAt: finiteNumber(raw.expiresAt, 0),
    settings: normalizeHunterRaceSettings(raw.settings)
  };
}

export function findHunterRaceEffects(actor = null) {
  return getActorEffects(actor).filter(effect => isLiveEffect(effect, getHunterRaceEffectData(effect)));
}

export function findHunterRaceEffect(actor = null, abilityItem = null, abilityFunction = null) {
  const abilityItemId = String(abilityItem?.id ?? "");
  const abilitySourceId = getAbilitySourceId(abilityItem);
  const functionId = String(abilityFunction?.id ?? "");
  return findHunterRaceEffects(actor).find(effect => {
    const data = getHunterRaceEffectData(effect);
    if (!data || data.sourceActorUuid !== String(actor?.uuid ?? "")) return false;
    if (functionId && data.functionId !== functionId) return false;
    if (abilityItemId && data.abilityItemId === abilityItemId) return true;
    return Boolean(abilitySourceId && data.abilitySourceId === abilitySourceId);
  }) ?? null;
}

/**
 * Called once while the weapon modifier state is being built. The caller adds
 * the returned totals to accuracy, damagePercent and criticalChance.
 */
export function getHunterRaceWeaponModifiers(actor = null, targetActor = null) {
  const raceId = getActorRaceId(targetActor);
  if (!actor || !raceId || getActiveRulesProfile().fixedAbilityFunctionsEnabled === false) return createEmptyModifiers();
  const sources = findHunterRaceEffects(actor)
    .map(effect => ({ effect, data: getHunterRaceEffectData(effect) }))
    .filter(entry => entry.data?.raceId === raceId)
    .map(entry => ({
      key: `hunter-race:${entry.effect?.id ?? entry.data.abilityItemId}:${entry.data.functionId}`,
      name: String(entry.effect?.name ?? "Охотник"),
      img: String(entry.effect?.img ?? ""),
      accuracy: entry.data.settings.accuracyBonus,
      damagePercent: entry.data.settings.damagePercentBonus,
      criticalChance: entry.data.settings.criticalChanceBonus
    }));
  return sources.reduce((result, source) => {
    result.accuracy += source.accuracy;
    result.damagePercent += source.damagePercent;
    result.criticalChance += source.criticalChance;
    result.sources.push(source);
    return result;
  }, createEmptyModifiers());
}

/** Register three target-dependent values with one shared per-target lookup. */
export function addHunterRaceWeaponModifiers(modifierState = null, actor = null) {
  if (!modifierState?.addCombatValue || !actor) return false;
  let cachedTarget = null;
  let cached = createEmptyModifiers();
  const resolve = context => {
    const target = context?.targetActor ?? context?.targetToken?.actor ?? null;
    if (target !== cachedTarget) {
      cachedTarget = target;
      cached = getHunterRaceWeaponModifiers(actor, target);
    }
    return cached;
  };
  modifierState.addCombatValue("accuracy", context => resolve(context).accuracy);
  modifierState.addCombatValue("damagePercent", context => resolve(context).damagePercent);
  modifierState.addCombatValue("criticalChance", context => resolve(context).criticalChance);
  return true;
}

export function getActorRaceId(actor = null) {
  return String(actor?.system?.creature?.raceId ?? "").trim();
}

function createEmptyModifiers() {
  return { accuracy: 0, damagePercent: 0, criticalChance: 0, sources: [] };
}

function getActorRaceName(actor = null) {
  const raceId = getActorRaceId(actor);
  return String(
    actor?.system?.creature?.raceName
    ?? actor?.system?.creature?.race?.name
    ?? getConfiguredRaceName(raceId)
    ?? ""
  ).trim();
}

function getConfiguredRaceName(raceId = "") {
  const key = String(raceId ?? "").trim();
  if (!key) return "";
  try {
    const configured = globalThis.game?.settings?.get?.(SYSTEM_ID, "creatureOptions");
    const races = Array.isArray(configured?.races) ? configured.races : Object.values(configured?.races ?? {});
    const race = races.find(entry => String(entry?.id ?? "") === key);
    return String(race?.name ?? "").trim();
  } catch (_error) {
    return "";
  }
}

function getAbilityName(item = null) {
  return String(item?.name ?? "").trim() || "Охотник";
}

function getAbilitySourceId(item = null) {
  return String(item?.getFlag?.("core", "sourceId") ?? item?.flags?.core?.sourceId ?? "");
}

function getActorEffects(actor = null) {
  return Array.from(actor?.effects?.contents ?? actor?.effects ?? []);
}

function isLiveEffect(effect, data = null, now = getWorldTime()) {
  if (!effect || !data || effect.disabled || effect.active === false || effect.duration?.expired === true) return false;
  return !(data.expiresAt > 0 && now >= data.expiresAt);
}

function readFlag(document = null, key = "") {
  return document?.getFlag?.(SYSTEM_ID, key)
    ?? document?.flags?.[SYSTEM_ID]?.[key]
    ?? document?._source?.flags?.[SYSTEM_ID]?.[key]
    ?? null;
}

function resolveCurrentDocument(document = null) {
  const uuid = String(document?.uuid ?? "").trim();
  return (uuid ? globalThis.fromUuidSync?.(uuid) : null) ?? document;
}

function escapeHtml(value = "") {
  const text = String(value ?? "");
  if (globalThis.foundry?.utils?.escapeHTML) return foundry.utils.escapeHTML(text);
  return text.replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[character]);
}

function getWorldTime() {
  return finiteNumber(globalThis.game?.time?.worldTime, 0);
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
