import { FALLOUT_MAW } from "../config/system-config.mjs";
import {
  AbilityDataModel,
  ArmorDataModel,
  CharacterDataModel,
  EffectDataModel,
  GearDataModel,
  HazardDataModel,
  NpcDataModel,
  VehicleDataModel,
  WeaponDataModel
} from "./models/index.mjs";

const ACTOR_BAR_ATTRIBUTES = [
  "resources.health",
  "resources.energy",
  "resources.dodge",
  "resources.actionPoints",
  "resources.movementPoints"
];

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
    weapon: WeaponDataModel,
    armor: ArmorDataModel,
    ability: AbilityDataModel,
    effect: EffectDataModel
  });
}

export function registerTrackableAttributes() {
  CONFIG.Actor.trackableAttributes = Object.fromEntries(
    FALLOUT_MAW.actorTypes.map(type => [
      type,
      {
        bar: [...ACTOR_BAR_ATTRIBUTES],
        value: [...ACTOR_VALUE_ATTRIBUTES]
      }
    ])
  );
}
