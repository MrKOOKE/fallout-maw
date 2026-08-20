import { queueSmokeRegionRefresh } from "../../canvas/smoke-vision.mjs";
import { REGION_TARGET_RELATIONS } from "../../canvas/region-targeting.mjs";
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
      targetRelations: new ArrayField(new StringField({
        required: true,
        blank: false,
        choices: REGION_TARGET_RELATIONS
      }), { required: true, initial: [...REGION_TARGET_RELATIONS] }),
      sourceActorUuid: new StringField({ required: true, blank: true, initial: "" }),
      effectName: new StringField({ required: true, blank: true, initial: "" }),
      effectImg: new StringField({ required: true, blank: true, initial: "" }),
      effectChanges: new ArrayField(new SchemaField({
        key: new StringField({ required: true, blank: true, initial: "" }),
        type: new StringField({
          required: true,
          blank: false,
          choices: ["add", "multiply", "override", "upgrade", "downgrade"],
          initial: "add"
        }),
        value: new StringField({ required: true, blank: true, initial: "0" }),
        phase: new StringField({ required: true, blank: false, initial: "initial" }),
        priority: new NumberField({ required: false, nullable: true, integer: true, initial: null })
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
