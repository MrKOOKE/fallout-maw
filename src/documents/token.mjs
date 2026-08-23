import { isPhantomEntity } from "../abilities/phantom-entity.mjs";

/**
 * Token document behavior owned by the system.
 *
 * Phantom entities are real TokenDocuments and still provide vision, but they
 * are deliberately absent from Region membership. Foundry dispatches Region
 * enter/exit behavior from that membership, including while a token is being
 * deleted. Letting a damage-destroyed phantom participate there would run
 * ordinary actor mechanics against a synthetic actor during its teardown.
 */
export class FalloutMaWTokenDocument extends TokenDocument {
  prepareBaseData() {
    super.prepareBaseData();
    if (!isPhantomEntity(this) || !this.regions?.size) return;
    for (const region of this.regions) region.tokens?.delete?.(this);
    this.regions.clear();
  }

  _identifyRegions(changes = {}) {
    if (isPhantomEntity(this)) return [];
    return super._identifyRegions(changes);
  }
}
