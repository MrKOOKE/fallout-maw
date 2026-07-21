import { SYSTEM_ID } from "../constants.mjs";

export const POSTURE_MOVEMENT_FLAG = "postureMovement";

export function getActorPostureAction(actor) {
  return normalizeMovementAction(getActorPostureEffectData(actor)?.action);
}

export function isPostureEffectApplicableToActor(effect, actor) {
  const data = effect?.getFlag?.(SYSTEM_ID, POSTURE_MOVEMENT_FLAG);
  if (!data) return true;

  const tokenUuid = actor?.isToken ? actor.token?.uuid : "";
  return !tokenUuid || data.tokenUuid === tokenUuid;
}

export function normalizeMovementAction(action) {
  const value = String(action ?? "").trim();
  return value || "walk";
}

function getActorPostureEffectData(actor) {
  for (const effect of actor?.effects ?? []) {
    const data = effect.getFlag?.(SYSTEM_ID, POSTURE_MOVEMENT_FLAG);
    if (!isPostureEffectApplicableToActor(effect, actor)) continue;
    if (data?.action) return data;
  }
  return null;
}
