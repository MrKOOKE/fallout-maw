/**
 * Foundry 14.361 first copies Token._source.delta, adds compatibility accessors
 * to that copy, then discards it and serializes ActorDelta again. Project out
 * only that discarded copy. The returned delta still uses its native serializer
 * (including omission of optional null fields), and every returned value is a
 * fresh copy. Prepared serialization and customized serializers remain native.
 */
export function createTokenSourceSerializer(NativeToken) {
  const { BaseToken, BaseActorDelta, BaseItem, BaseActiveEffect } = foundry.documents;
  const { DataModel, Document } = foundry.abstract ?? {};
  if (!BaseToken || !DataModel || !Document) return (_document, _source, serialize) => serialize();
  const nativeToken = BaseToken.prototype.toObject;
  const nativeDocument = Document.prototype.toObject;
  const nativeModel = DataModel.prototype.toObject;
  const tokenShim = BaseToken.shimData, modelShim = DataModel.shimData;
  const deltaShim = BaseActorDelta.shimData, itemShim = BaseItem.shimData, effectShim = BaseActiveEffect.shimData;

  return (document, source, serialize) => {
    if (game.release?.version !== "14.361" || source !== true || document.actorLink
      || NativeToken.prototype.toObject !== nativeToken || BaseToken.prototype.toObject !== nativeToken
      || Document.prototype.toObject !== nativeDocument || DataModel.prototype.toObject !== nativeModel
      || document.constructor.shimData !== tokenShim || BaseToken.shimData !== tokenShim
      || DataModel.shimData !== modelShim || !document._source.delta) return serialize();
    const delta = Object.getOwnPropertyDescriptor(document, "delta")?.value;
    if (!delta || delta.constructor.shimData !== deltaShim || BaseActorDelta.shimData !== deltaShim
      || CONFIG.Item.documentClass.shimData !== itemShim || BaseItem.shimData !== itemShim
      || (CONFIG.ActiveEffect.documentClass ?? BaseActiveEffect).shimData !== effectShim
      || BaseActiveEffect.shimData !== effectShim) return serialize();
    for (const config of [CONFIG.Item, CONFIG.ActiveEffect]) {
      if (Object.values(config.dataModels ?? {}).some(Model => Model.shimData !== modelShim)) return serialize();
    }

    const data = foundry.utils.deepClone({ ...document._source, delta: null });
    document.constructor.shimData(data);
    data.delta = delta.toObject(true);
    // #region codex-runtime-debug H7a verify the single delta copy in user gameplay
    globalThis.__falloutMawGameplayProbe?.count("token.sourceSingleCopy", "H7a");
    // #endregion codex-runtime-debug
    return data;
  };
}
