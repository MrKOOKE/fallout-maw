import { isPhantomEntity } from "../abilities/phantom-entity.mjs";
import { cloneTokenPreview } from "./token-clone-initialization.mjs";
import { createTokenSourceSerializer } from "./token-source-serialization.mjs";

const serializeTokenSource = createTokenSourceSerializer(TokenDocument);

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
  toObject(source = true) {
    // #region codex-runtime-debug H7a inline measurement preserves method identity
    const finish = globalThis.__falloutMawGameplayProbe?.tokenSerialization?.(this, source);
    try {
    // #endregion codex-runtime-debug
      if (this.constructor !== FalloutMaWTokenDocument) return super.toObject(source);
      return serializeTokenSource(this, source, () => super.toObject(source));
    // #region codex-runtime-debug H7a
    } finally { finish?.(); }
    // #endregion codex-runtime-debug
  }

  clone(data = {}, context = {}) {
    return cloneTokenPreview(this, data, context, options => super.clone(data, options));
  }

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
