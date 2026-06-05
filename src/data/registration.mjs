import { FALLOUT_MAW } from "../config/system-config.mjs";
import { getNeedSettings, getProficiencySettings, getResourceSettings, getSkillSettings } from "../settings/accessors.mjs";
import * as regionBehaviorData from "./region-behavior/_module.mjs";
import {
  AbilityDataModel,
  CharacterDataModel,
  ConstructDataModel,
  DiseaseDataModel,
  GearDataModel,
  TraumaDataModel,
} from "./models/index.mjs";

const ACTOR_VALUE_ATTRIBUTES = ["attributes.level", "attributes.initiative"];

export function registerDataModels() {
  Object.assign(CONFIG.Actor.dataModels, {
    character: CharacterDataModel,
    construct: ConstructDataModel
  });

  Object.assign(CONFIG.Item.dataModels, {
    gear: GearDataModel,
    ability: AbilityDataModel,
    trauma: TraumaDataModel,
    disease: DiseaseDataModel
  });

  Object.assign(CONFIG.RegionBehavior.dataModels, regionBehaviorData.config);
  Object.assign(CONFIG.RegionBehavior.typeIcons, regionBehaviorData.icons);
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
