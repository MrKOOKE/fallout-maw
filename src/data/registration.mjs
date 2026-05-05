import { FALLOUT_MAW } from "../config/system-config.mjs";
import { getNeedSettings, getProficiencySettings, getResourceSettings, getSkillSettings } from "../settings/accessors.mjs";
import {
  AbilityDataModel,
  CharacterDataModel,
  GearDataModel,
  HazardDataModel,
  NpcDataModel,
  VehicleDataModel
} from "./models/index.mjs";

const ACTOR_VALUE_ATTRIBUTES = ["attributes.level"];

export function registerDataModels() {
  Object.assign(CONFIG.Actor.dataModels, {
    character: CharacterDataModel,
    npc: NpcDataModel,
    vehicle: VehicleDataModel,
    hazard: HazardDataModel
  });

  Object.assign(CONFIG.Item.dataModels, {
    gear: GearDataModel,
    ability: AbilityDataModel
  });
}

export function registerTrackableAttributes() {
  const barAttributes = [
    ...getResourceSettings().map(resource => `resources.${resource.key}`),
    ...getNeedSettings().map(need => `needs.${need.key}`),
    ...getSkillSettings().map(skill => `skills.${skill.key}`),
    ...getProficiencySettings().map(proficiency => `proficiencies.${proficiency.key}`)
  ];

  CONFIG.Actor.trackableAttributes = Object.fromEntries(
    FALLOUT_MAW.actorTypes.map(type => [
      type,
      {
        bar: [...barAttributes],
        value: [...ACTOR_VALUE_ATTRIBUTES]
      }
    ])
  );
}
