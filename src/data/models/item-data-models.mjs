const { BooleanField, HTMLField, NumberField, SchemaField, StringField, TypedObjectField } = foundry.data.fields;

export class BaseItemDataModel extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      description: new HTMLField({ required: false, blank: true, initial: "" }),
      quantity: new NumberField({ required: true, integer: true, min: 0, initial: 1 }),
      maxStack: new NumberField({ required: true, integer: true, min: 1, initial: 1 }),
      weight: new NumberField({ required: true, min: 0, initial: 0 }),
      price: new NumberField({ required: true, min: 0, initial: 0 }),
      priceCurrency: new StringField({ required: true, blank: true, initial: "" }),
      equipped: new BooleanField({ required: true, initial: false }),
      container: new SchemaField({
        parentId: new StringField({ required: true, blank: true, initial: "" })
      }),
      occupiedSlots: new TypedObjectField(new BooleanField({ required: true, initial: false }), {
        required: true,
        initial: {}
      }),
      placement: new SchemaField({
        mode: new StringField({ required: true, blank: true, initial: "inventory" }),
        equipmentSlot: new StringField({ required: true, blank: true, initial: "" }),
        weaponSet: new StringField({ required: true, blank: true, initial: "" }),
        weaponSlot: new StringField({ required: true, blank: true, initial: "" }),
        x: new NumberField({ required: true, integer: true, min: 1, initial: 1 }),
        y: new NumberField({ required: true, integer: true, min: 1, initial: 1 }),
        width: new NumberField({ required: true, integer: true, min: 1, initial: 1 }),
        height: new NumberField({ required: true, integer: true, min: 1, initial: 1 })
      })
    };
  }
}

export class GearDataModel extends BaseItemDataModel {
  static defineSchema() {
    return {
      ...super.defineSchema(),
      itemFunction: new StringField({ required: true, blank: true, initial: "" }),
      container: new SchemaField({
        parentId: new StringField({ required: true, blank: true, initial: "" }),
        columns: new NumberField({ required: true, integer: true, min: 1, initial: 1 }),
        rows: new NumberField({ required: true, integer: true, min: 1, initial: 1 }),
        maxLoad: new NumberField({ required: true, min: 0, initial: 0 })
      })
    };
  }
}

export class WeaponDataModel extends BaseItemDataModel {
  static defineSchema() {
    return {
      ...super.defineSchema(),
      damage: new StringField({ required: true, blank: true, initial: "" }),
      range: new NumberField({ required: true, min: 0, initial: 0 })
    };
  }
}

export class ArmorDataModel extends BaseItemDataModel {
  static defineSchema() {
    return {
      ...super.defineSchema(),
      defense: new NumberField({ required: true, integer: true, min: 0, initial: 0 })
    };
  }
}

export class AbilityDataModel extends BaseItemDataModel {
  static defineSchema() {
    return {
      ...super.defineSchema(),
      cost: new NumberField({ required: true, min: 0, initial: 0 }),
      formula: new StringField({ required: true, blank: true, initial: "" })
    };
  }
}

export class EffectDataModel extends BaseItemDataModel {
  static defineSchema() {
    return {
      ...super.defineSchema(),
      target: new StringField({ required: true, blank: true, initial: "" }),
      duration: new StringField({ required: true, blank: true, initial: "" })
    };
  }
}
