import { SYSTEM_ID } from "../constants.mjs";
import { areActorsStealthAlliesCached } from "../stealth/observers.mjs";

export const PHANTOM_VISION_FLAG_KEY = "phantomVision";

export function getPhantomVisionData(document = null) {
  return document?.getFlag?.(SYSTEM_ID, PHANTOM_VISION_FLAG_KEY)
    ?? document?.flags?.[SYSTEM_ID]?.[PHANTOM_VISION_FLAG_KEY]
    ?? document?._source?.flags?.[SYSTEM_ID]?.[PHANTOM_VISION_FLAG_KEY]
    ?? null;
}

export function localViewReceivesPhantomVision(document = null) {
  const data = getPhantomVisionData(document);
  if (!data) return false;
  const sourceActor = resolvePhantomSourceActor(data);
  if (!sourceActor) return false;

  const controlled = (canvas?.tokens?.controlled ?? []).filter(token => token?.actor);
  if (controlled.length) {
    return controlled.some(token => actorsArePhantomAllies(sourceActor, token.actor));
  }
  if (game.user?.isGM) return false;
  return (canvas?.tokens?.placeables ?? []).some(observerToken => (
    hasExplicitActorObservation(observerToken?.actor, game.user)
    && actorsArePhantomAllies(sourceActor, observerToken.actor)
  ));
}

export function actorsArePhantomAllies(sourceActor, observerActor) {
  if (!sourceActor || !observerActor) return false;
  const sourceBaseActor = sourceActor?.parent?.baseActor ?? sourceActor;
  const observerBaseActor = observerActor?.parent?.baseActor ?? observerActor;
  return sourceBaseActor?.uuid === observerBaseActor?.uuid
    || areActorsStealthAlliesCached(sourceActor, observerActor);
}

export function hasExplicitActorObservation(actor, user) {
  if (!actor || !user?.id) return false;
  const baseActor = actor?.parent?.baseActor ?? actor;
  const ownership = baseActor?._source?.ownership ?? baseActor?.ownership ?? {};
  const level = Number(ownership[user.id] ?? ownership.default);
  const observerLevel = Number(CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER);
  return Number.isFinite(level) && level >= observerLevel;
}

function resolvePhantomSourceActor(data = {}) {
  const sourceToken = fromUuidSync(String(data?.sourceTokenUuid ?? ""));
  return sourceToken?.actor
    ?? fromUuidSync(String(data?.sourceActorUuid ?? ""))
    ?? null;
}
