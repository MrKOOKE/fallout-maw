const { ArrayField, BooleanField, NumberField, SchemaField, StringField } = foundry.data.fields;

export function resourceRecoveryMethodField() {
  return new SchemaField({
    type: new StringField({ required: true, choices: ["tools", "resources"], initial: "tools" }),
    toolKey: new StringField({ required: true, blank: true, initial: "" }),
    toolClass: new StringField({ required: true, choices: ["D", "C", "B", "A", "S"], initial: "D" }),
    difficulty: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
    mode: new StringField({ required: true, choices: ["all", "one"], initial: "one" }),
    recoveryMode: new StringField({ required: true, choices: ["percent", "amount"], initial: "percent" }),
    recovery: new NumberField({ required: true, min: 0, initial: 10 }),
    resources: new ArrayField(new SchemaField({
      uuid: new StringField({ required: true, blank: true, initial: "" }),
      quantity: new NumberField({ required: true, integer: true, min: 1, initial: 1 })
    }), { required: true, initial: () => [] })
  });
}

export function constructSystemField() {
  return new SchemaField({
    id: new StringField({ required: true, blank: false, initial: () => foundry.utils.randomID() }),
    name: new StringField({ required: true, blank: true, initial: "Энергосистема" }),
    enabled: new BooleanField({ required: true, initial: true }),
    resourceKey: new StringField({ required: true, blank: false, initial: "power" }),
    requiresActivation: new BooleanField({ required: true, initial: true }),
    active: new BooleanField({ required: true, initial: false }),
    movement: new BooleanField({ required: true, initial: true }),
    energyPerMovementPoint: new NumberField({ required: true, integer: true, min: 1, initial: 1 }),
    soundRadius: new NumberField({ required: true, min: 0.1, initial: 30 }),
    soundEdgeVolume: new NumberField({ required: true, min: 0, max: 1, initial: 0.25 }),
    soundWalls: new BooleanField({ required: true, initial: true }),
    soundFadeIn: new NumberField({ required: true, min: 0, max: 5000, initial: 180 }),
    soundFadeOut: new NumberField({ required: true, min: 0, max: 5000, initial: 300 }),
    soundResumeWindow: new NumberField({ required: true, min: 0, max: 5000, initial: 250 }),
    recoveryMethods: new ArrayField(resourceRecoveryMethodField(), { required: true, initial: () => [] }),
    sounds: new SchemaField(Object.fromEntries(["start", "stop", "idle", "move", "rotate"].map(key => [key,
      new SchemaField({
        paths: new ArrayField(new StringField({ required: true, blank: true, initial: "" }), { required: true, initial: () => [] }),
        volume: new NumberField({ required: true, min: 0, max: 1, initial: 0.5 })
      })
    ])))
  });
}

export function constructSystemContributionField() {
  return new SchemaField({
    systemId: new StringField({ required: true, blank: true, initial: "" }),
    capacity: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
    movementPoints: new NumberField({ required: true, integer: true, min: 0, initial: 0 }),
    activationProvider: new BooleanField({ required: true, initial: false })
  });
}
