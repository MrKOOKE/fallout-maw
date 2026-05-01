function clampNumber(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export class FalloutMaWActor extends Actor {
  prepareDerivedData() {
    super.prepareDerivedData();

    const resources = this.system?.resources;
    if (!resources) return;

    for (const resource of Object.values(resources)) {
      const min = Number(resource.min) || 0;
      const max = Number(resource.max) || min;
      resource.value = clampNumber(Number(resource.value) || min, min, max);
    }
  }

  get health() {
    return this.system?.resources?.health;
  }

  async applyDamage(amount = 0) {
    const damage = Math.max(0, Math.floor(Number(amount) || 0));
    if (!this.health || damage === 0) return this;

    const nextValue = Math.max(this.health.min, this.health.value - damage);
    return this.update({ "system.resources.health.value": nextValue });
  }
}

export class FalloutMaWItem extends Item {
  get isEquipped() {
    return Boolean(this.system?.equipped);
  }

  get totalWeight() {
    return (Number(this.system?.quantity) || 0) * (Number(this.system?.weight) || 0);
  }
}
