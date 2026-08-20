import {
  buildWeaponNoiseZone,
  testWeaponNoiseZoneContact
} from "./detection.mjs";
import { isValidStealthObserver } from "./observers.mjs";
import {
  getRuntimeStealthSettings,
  getTokenCenter,
  isActorStealthed
} from "./rules.mjs";
import {
  ABILITY_FIXED_FUNCTION_KEYS,
  normalizeInconspicuousSettings
} from "../settings/abilities.mjs";
import { getActiveRulesProfile } from "../settings/rules-profiles.mjs";
import { isActorInActiveCombat } from "../combat/combat-membership.mjs";

const weaponNoiseDetectionQueues = new Map();

let rollStealthCheckCallback = async () => undefined;
let rollStealthChecksCallback = null;
let pauseGameCallback = () => undefined;
let settingsProvider = getRuntimeStealthSettings;

export function configureWeaponNoiseDetection({
  rollStealthCheck = null,
  rollStealthChecks = null,
  pauseGame = null,
  getSettings = null
} = {}) {
  rollStealthCheckCallback = typeof rollStealthCheck === "function"
    ? rollStealthCheck
    : async () => undefined;
  rollStealthChecksCallback = typeof rollStealthChecks === "function" ? rollStealthChecks : null;
  pauseGameCallback = typeof pauseGame === "function" ? pauseGame : () => undefined;
  settingsProvider = typeof getSettings === "function" ? getSettings : getRuntimeStealthSettings;
}

/**
 * Resolve the audible consequence of a completed weapon action. Requests for
 * the same actor are serialized so overlapping command/attack workflows,
 * including multiple scene tokens for one Actor, cannot produce concurrent
 * rolls against the same hidden state.
 */
export function resolveWeaponNoiseDetection(attackerToken, { noiseLevel = 0 } = {}) {
  if (!attackerToken?.actor) return Promise.resolve(false);
  const queueKey = getWeaponNoiseDetectionQueueKey(attackerToken);
  const previous = weaponNoiseDetectionQueues.get(queueKey) ?? Promise.resolve(false);
  const resolution = previous
    .catch(() => false)
    .then(() => resolveWeaponNoiseDetectionNow(attackerToken, noiseLevel))
    .catch(error => {
      console.error("Fallout MaW | Weapon noise detection failed", error);
      return false;
    });
  let tracked;
  tracked = resolution.finally(() => {
    if (weaponNoiseDetectionQueues.get(queueKey) === tracked) {
      weaponNoiseDetectionQueues.delete(queueKey);
    }
  });
  weaponNoiseDetectionQueues.set(queueKey, tracked);
  return tracked;
}

export function clearWeaponNoiseDetectionQueues() {
  weaponNoiseDetectionQueues.clear();
}

async function resolveWeaponNoiseDetectionNow(attackerToken, noiseLevel) {
  const settings = settingsProvider();
  const hiddenToken = getCurrentSceneToken(attackerToken);
  if (
    !settings?.autoDetection?.enabled
    || !globalThis.canvas?.ready
    || !hiddenToken?.actor
    || !isActorStealthed(hiddenToken.actor)
  ) return false;

  const hiddenPoint = getTokenCenter(hiddenToken);
  const noiseZone = buildWeaponNoiseZone(hiddenToken, { noiseLevel });
  const skillBonus = getInconspicuousAttackStealthBonus(hiddenToken.actor);
  const checks = [];
  for (const observerToken of globalThis.canvas?.tokens?.placeables ?? []) {
    if (!isValidStealthObserver(hiddenToken, observerToken)) continue;
    const observerOrigin = getTokenCenter(observerToken);
    if (!testWeaponNoiseZoneContact(observerToken, observerOrigin, hiddenPoint, {
      noiseLevel,
      noiseZone,
      settings
    })) continue;
    checks.push({ sourceToken: hiddenToken, targetToken: observerToken, skillBonus });
  }
  const outcomes = rollStealthChecksCallback
    ? await rollStealthChecksCallback(checks, { animate: false })
    : await Promise.all(checks.map(check => rollStealthCheckCallback(
      check.sourceToken,
      check.targetToken,
      null,
      { animate: false, skillBonus: check.skillBonus }
    )));
  if (!isActorStealthed(hiddenToken.actor) || outcomes.some(isStealthCheckFailure)) {
    pauseGameCallback();
    return true;
  }
  return false;
}

function getInconspicuousAttackStealthBonus(actor) {
  if (getActiveRulesProfile().fixedAbilityFunctionsEnabled === false || !isActorInActiveCombat(actor)) return 0;
  for (const item of actor?.items ?? []) {
    if (item?.type !== "ability") continue;
    const entry = (item.system?.functions ?? [])
      .find(abilityFunction => (
        abilityFunction?.type === "fixed"
        && abilityFunction?.fixedKey === ABILITY_FIXED_FUNCTION_KEYS.inconspicuous
      ));
    if (entry) return normalizeInconspicuousSettings(entry.fixedSettings).attackStealthBonus;
  }
  return 0;
}

function getCurrentSceneToken(token) {
  const activeCanvas = globalThis.canvas;
  if (!activeCanvas?.ready || !token?.actor) return null;
  const direct = activeCanvas.tokens?.get?.(token.id);
  if (direct?.actor) return direct;
  const tokenUuid = String(token.document?.uuid ?? token.uuid ?? "").trim();
  if (tokenUuid) {
    const byUuid = (activeCanvas.tokens?.placeables ?? [])
      .find(candidate => String(candidate?.document?.uuid ?? candidate?.uuid ?? "") === tokenUuid);
    if (byUuid?.actor) return byUuid;
  }
  return null;
}

function getWeaponNoiseDetectionQueueKey(token) {
  return String(
    token?.actor?.uuid
    ?? token?.document?.uuid
    ?? token?.uuid
    ?? token?.id
    ?? ""
  ).trim() || "unknown-actor";
}

function isStealthCheckFailure(outcome) {
  if (outcome?.falloutMawRevealPrevented) return false;
  const resultKey = String(outcome?.result?.key ?? "");
  return ["failure", "criticalFailure"].includes(resultKey) || outcome?.result?.autoFailure;
}
