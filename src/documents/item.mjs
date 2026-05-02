export class FalloutMaWItem extends Item {
  get isEquipped() {
    return Boolean(this.system?.equipped);
  }

  get totalWeight() {
    return (Number(this.system?.quantity) || 0) * (Number(this.system?.weight) || 0);
  }
}
