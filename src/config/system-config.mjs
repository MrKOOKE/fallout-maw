import { ACTOR_TYPES, ITEM_TYPES, SYSTEM_ID, SYSTEM_TITLE } from "../constants.mjs";
import {
  DEFAULT_CHARACTERISTICS,
  DEFAULT_DAMAGE_TYPES,
  DEFAULT_NEEDS,
  DEFAULT_RESOURCES,
  DEFAULT_SKILLS
} from "./defaults.mjs";

export const FALLOUT_MAW = {
  id: SYSTEM_ID,
  title: SYSTEM_TITLE,
  actorTypes: [...ACTOR_TYPES],
  itemTypes: [...ITEM_TYPES],
  characteristics: entriesToLabels(DEFAULT_CHARACTERISTICS),
  skills: entriesToLabels(DEFAULT_SKILLS),
  resources: entriesToLabels(DEFAULT_RESOURCES),
  needs: entriesToLabels(DEFAULT_NEEDS),
  damageTypes: entriesToLabels(DEFAULT_DAMAGE_TYPES)
};

export function syncSystemConfig({ characteristics, skills, resources, needs, damageTypes } = {}) {
  if (characteristics) FALLOUT_MAW.characteristics = entriesToLabels(characteristics);
  if (skills) FALLOUT_MAW.skills = entriesToLabels(skills);
  if (resources) FALLOUT_MAW.resources = entriesToLabels(resources);
  if (needs) FALLOUT_MAW.needs = entriesToLabels(needs);
  if (damageTypes) FALLOUT_MAW.damageTypes = entriesToLabels(damageTypes);
  if (globalThis.CONFIG?.FalloutMaW) globalThis.CONFIG.FalloutMaW = FALLOUT_MAW;
  return FALLOUT_MAW;
}

function entriesToLabels(entries) {
  return Object.fromEntries(entries.map(entry => [entry.key, entry.label]));
}
