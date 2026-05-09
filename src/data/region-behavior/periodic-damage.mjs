const { ArrayField, BooleanField, NumberField, SchemaField, StringField } = foundry.data.fields;
const DEFAULT_INTERVAL_SECONDS = 6;

export default class PeriodicDamageRegionBehaviorType extends foundry.data.regionBehaviors.RegionBehaviorType {
  static LOCALIZATION_PREFIXES = ["FALLOUTMAW.REGIONBEHAVIORS.PERIODICDAMAGE", "BEHAVIOR.TYPES.base"];

  static defineSchema() {
    return {
      damage: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      damageTypeKey: new StringField({ required: true, blank: true, initial: "firearm" }),
      damageEntries: new ArrayField(new SchemaField({
        damageTypeKey: new StringField({ required: true, blank: true, initial: "firearm" }),
        amount: new NumberField({ required: true, integer: true, min: 0, initial: 0 })
      }), { required: true, initial: [] }),
      intervalSeconds: new NumberField({ required: true, integer: true, min: 1, initial: DEFAULT_INTERVAL_SECONDS }),
      delaySeconds: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      durationSeconds: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      radiusDeltaMeters: new NumberField({ required: true, initial: 0 }),
      deleteRegionWhenExpired: new BooleanField({ required: true, initial: true })
    };
  }
}
