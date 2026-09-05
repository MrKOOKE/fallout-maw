const previewSources = new Set();
const constructingPreviews = [];
const validatedActorSources = new WeakMap();

/** Keep the native canvas clone workflow, including its private preview state. */
export function withTokenPreviewClone(document, operation) {
  if (game.release?.version !== "14.361" || document.actorLink || document.invalid !== false) return operation();
  const delta = Object.getOwnPropertyDescriptor(document, "delta")?.value;
  if (!delta?.syntheticActor || delta.invalid !== false || delta.syntheticActor.invalid !== false) return operation();
  const wasActive = previewSources.has(document);
  previewSources.add(document);
  try { return operation(); }
  finally { if (!wasActive) previewSources.delete(document); }
}

/**
 * An exact visual copy uses already migrated and cleaned source data. Native
 * validation, Item construction and all preparation still run; the copy owns
 * independent sources, models, Items and effects. Other cloning stays native.
 */
export function cloneTokenPreview(document, data, context, clone) {
  if (!previewSources.has(document) || Reflect.ownKeys(data).length || context.keepId !== true
    || Reflect.ownKeys(context).some(key => key !== "keepId")) return clone(context);
  constructingPreviews.push(document);
  try { return clone({ ...context, clean: false }); }
  finally { constructingPreviews.pop(); }
}

/** Carry the same source-copy context into native synthetic Actor construction. */
export function getPreviewActorContext(delta, context) {
  const source = constructingPreviews.at(-1), token = delta.parent;
  if (!source || token === source || token?.parent !== source.parent || token.id !== source.id
    || token.actorId !== source.actorId || token.actorLink || context.strict !== true
    || context.dropInvalidEmbedded !== true || context.clean !== undefined) return context;
  return { ...context, clean: false };
}

/**
 * Native Actor construction validates its complete embedded schema before
 * initializing children. During this exact clone construction, child sources
 * are used unchanged (clean:false). Keep joint validation on each new child,
 * but do not validate those same fields again in both Item and TypeDataModel.
 */
export function initializeValidatedPreviewActor(actor, options, initialize) {
  const source = constructingPreviews.at(-1), token = actor.parent;
  if (!source || !token || token === source || token.parent !== source.parent || token.id !== source.id
    || token.actorId !== source.actorId || actor.invalid !== false || options.clean !== false || options.strict !== true
    || actor.validate !== foundry.abstract.DataModel.prototype.validate) return initialize();
  const previous = validatedActorSources.get(actor);
  validatedActorSources.set(actor, new Set(actor._source.items));
  try { return initialize(); }
  finally {
    if (previous) validatedActorSources.set(actor, previous);
    else validatedActorSources.delete(actor);
  }
}

export function isInitializingValidatedPreviewItem(item) {
  const actor = item?.parent;
  return actor?.documentName === "Actor" && actor.items?._initialized === false
    && validatedActorSources.get(actor)?.has(item._source) === true;
}

export function getPreviewItemValidationOptions(model, options = {}) {
  if (options.changes || options.fields === false) return options;
  const item = model.documentName === "Item" ? model : model.parent;
  if (!isInitializingValidatedPreviewItem(item)
    || model !== item && model._source !== item._source.system) return options;
  // #region codex-runtime-debug H6a verify reuse in the actual preview construction
  globalThis.__falloutMawGameplayProbe?.count(model === item ? "preview.item.fieldsAlreadyValidated" : "preview.model.fieldsAlreadyValidated", "H6a");
  // #endregion codex-runtime-debug
  return { ...options, fields: false };
}
