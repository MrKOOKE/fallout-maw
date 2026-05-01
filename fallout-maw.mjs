import { FALLOUT_MAW } from "./module/config.mjs";
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
} from "./module/data-models.mjs";
import { FalloutMaWActor, FalloutMaWItem } from "./module/documents.mjs";
import { registerSystemSheets } from "./module/sheets.mjs";
import { registerSystemSettings } from "./module/settings.mjs";

Hooks.once("init", () => {
  console.log(`${FALLOUT_MAW.title} | Initializing system`);

  CONFIG.FalloutMaW = FALLOUT_MAW;

  CONFIG.Actor.documentClass = FalloutMaWActor;
  CONFIG.Item.documentClass = FalloutMaWItem;

  registerSystemSettings();
  registerSystemSheets();

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

  CONFIG.Actor.trackableAttributes = {
    character: {
      bar: ["resources.health", "resources.stamina", "resources.energy"],
      value: ["attributes.level", "attributes.dodge", "attributes.actionPoints", "attributes.movementPoints"]
    },
    npc: {
      bar: ["resources.health", "resources.stamina", "resources.energy"],
      value: ["attributes.level", "attributes.dodge", "attributes.actionPoints", "attributes.movementPoints"]
    },
    vehicle: {
      bar: ["resources.health", "resources.energy"],
      value: ["attributes.dodge"]
    },
    hazard: {
      bar: ["resources.health"],
      value: []
    }
  };
});
