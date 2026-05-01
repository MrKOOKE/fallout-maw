const {
  BooleanField,
  HTMLField,
  NumberField,
  SchemaField,
  StringField
} = foundry.data.fields;

function resourceField(value = 0, max = value) {
  return new SchemaField({
    min: new NumberField({ required: true, integer: true, initial: 0 }),
    value: new NumberField({ required: true, integer: true, initial: value }),
    max: new NumberField({ required: true, integer: true, initial: max })
  });
}

class BaseActorDataModel extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      description: new HTMLField({ required: false, blank: true, initial: "" }),
      resources: new SchemaField({
        health: resourceField(10, 10),
        stamina: resourceField(10, 10),
        energy: resourceField(0, 0)
      }),
      attributes: new SchemaField({
        level: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
        armor: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
        speed: new NumberField({ required: true, min: 0, initial: 0 })
      })
    };
  }
}

export class CharacterDataModel extends BaseActorDataModel {}

export class NpcDataModel extends BaseActorDataModel {}

export class VehicleDataModel extends BaseActorDataModel {
  static defineSchema() {
    return {
      ...super.defineSchema(),
      crew: new NumberField({ required: true, integer: true, min: 0, initial: 0 })
    };
  }
}

export class HazardDataModel extends BaseActorDataModel {
  static defineSchema() {
    return {
      ...super.defineSchema(),
      difficulty: new NumberField({ required: true, integer: true, min: 0, initial: 0 })
    };
  }
}

class BaseItemDataModel extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      description: new HTMLField({ required: false, blank: true, initial: "" }),
      quantity: new NumberField({ required: true, integer: true, min: 0, initial: 1 }),
      weight: new NumberField({ required: true, min: 0, initial: 0 }),
      price: new NumberField({ required: true, min: 0, initial: 0 }),
      equipped: new BooleanField({ required: true, initial: false })
    };
  }
}

export class GearDataModel extends BaseItemDataModel {}

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
