import { queueSmokeRegionRefresh } from "../../canvas/smoke-vision.mjs";
const { ArrayField, BooleanField, NumberField, SchemaField, StringField } = foundry.data.fields;
const DEFAULT_INTERVAL_SECONDS = 6;
const REGION_EVENTS = globalThis.CONST?.REGION_EVENTS ?? {};

export default class PeriodicDamageRegionBehaviorType extends foundry.data.regionBehaviors.RegionBehaviorType {
  static LOCALIZATION_PREFIXES = ["FALLOUTMAW.REGIONBEHAVIORS.PERIODICDAMAGE", "BEHAVIOR.TYPES.base"];

  static defineSchema() {
    return {
      damageEntries: new ArrayField(new SchemaField({
        damageTypeKey: new StringField({ required: true, blank: true, initial: "firearm" }),
        amount: new StringField({ required: true, blank: true, initial: "0" })
      }), { required: true, initial: [] }),
      regionSpecialProperties: new ArrayField(new SchemaField({
        type: new StringField({ required: true, blank: false, choices: ["pending", "smoke"], initial: "pending" }),
        smoke: new SchemaField({
          thickness: new StringField({ required: true, blank: true, initial: "1" }),
          densityPercent: new StringField({ required: true, blank: true, initial: "50" })
        })
      }), { required: true, initial: [] }),
      intervalSeconds: new NumberField({ required: true, integer: true, min: 1, initial: DEFAULT_INTERVAL_SECONDS }),
      delaySeconds: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      durationSeconds: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      radiusDeltaMeters: new NumberField({ required: true, initial: 0 }),
      deleteRegionWhenExpired: new BooleanField({ required: true, initial: true })
    };
  }

  static events = {
    [REGION_EVENTS.BEHAVIOR_VIEWED ?? "behaviorViewed"]: () => queueSmokeRegionRefresh(),
    [REGION_EVENTS.BEHAVIOR_UNVIEWED ?? "behaviorUnviewed"]: () => queueSmokeRegionRefresh(),
    [REGION_EVENTS.REGION_BOUNDARY ?? "regionBoundary"]: () => queueSmokeRegionRefresh(),
    [REGION_EVENTS.REGION_ANIMATION ?? "regionAnimation"]: () => queueSmokeRegionRefresh({ forceVision: false })
  };
}
