import { SYSTEM_ID } from "../constants.mjs";

export const PHANTOM_ENTITY_FLAG_KEY = "phantomEntity";

export function buildPhantomEntityData() {
  return {
    excludeFromMechanics: true,
    acceptsDirectDamage: true,
    providesVision: true
  };
}

export function getPhantomEntityData(value = null) {
  return readPhantomEntityData(value)
    ?? readPhantomEntityData(value?.document)
    ?? readPhantomEntityData(value?.actor)
    ?? readPhantomEntityData(value?.baseActor)
    ?? readPhantomEntityData(value?.parent?.baseActor)
    ?? readPhantomEntityData(value?.actor?.parent?.baseActor)
    ?? null;
}

export function isPhantomEntity(value = null) {
  return getPhantomEntityData(value)?.excludeFromMechanics === true;
}

function readPhantomEntityData(document = null) {
  return document?.getFlag?.(SYSTEM_ID, PHANTOM_ENTITY_FLAG_KEY)
    ?? document?.flags?.[SYSTEM_ID]?.[PHANTOM_ENTITY_FLAG_KEY]
    ?? document?._source?.flags?.[SYSTEM_ID]?.[PHANTOM_ENTITY_FLAG_KEY]
    ?? null;
}
