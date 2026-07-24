import {
  testStealthDetectionPoint,
  weaponNoiseToRangeBonus
} from "./detection.mjs";
import { isValidStealthObserver } from "./observers.mjs";
import {
  getRuntimeStealthSettings,
  getTokenCenter,
  isActorStealthed
} from "./rules.mjs";

const weaponNoiseDetectionQueues = new Map();

let rollStealthCheckCallback = async () => undefined;
let pauseGameCallback = () => undefined;
let settingsProvider = getRuntimeStealthSettings;

export function configureWeaponNoiseDetection({
  rollStealthCheck = null,
  pauseGame = null,
  getSettings = null
} = {}) {
  rollStealthCheckCallback = typeof rollStealthCheck === "function"
    ? rollStealthCheck
    : async () => undefined;
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
  const rangeBonus = weaponNoiseToRangeBonus(noiseLevel);
  for (const observerToken of globalThis.canvas?.tokens?.placeables ?? []) {
    if (!isActorStealthed(hiddenToken.actor)) return true;
    if (!isValidStealthObserver(hiddenToken, observerToken)) continue;
    const observerOrigin = getTokenCenter(observerToken);
    if (!testStealthDetectionPoint(observerToken, observerOrigin, hiddenPoint, {
      rangeBonus,
      settings
    })) continue;

    const outcome = await rollStealthCheckCallback(hiddenToken, observerToken, null, { animate: false });
    if (!isActorStealthed(hiddenToken.actor) || isStealthCheckFailure(outcome)) {
      pauseGameCallback();
      return true;
    }
  }
  return false;
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
  const resultKey = String(outcome?.result?.key ?? "");
  return ["failure", "criticalFailure"].includes(resultKey) || outcome?.result?.autoFailure;
}
