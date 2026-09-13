const previewSources = new Set();
const constructingPreviews = [];
const constructingActorDeltas = [];
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
 * Construct an initial synthetic Actor from sources which Foundry has already
 * cleaned. The merged Actor and every embedded document still pass native
 * strict and joint validation; only duplicate source cleaning and duplicate
 * child field validation are omitted.
 */
export function applyValidatedActorDelta(delta, context, apply) {
  if (!canReuseValidatedActorDeltaSources(delta, context)) return apply(context);
  constructingActorDeltas.push(delta);
  try { return apply({ ...context, clean: false }); }
  finally { constructingActorDeltas.pop(); }
}

/**
 * Native Actor construction validates its complete embedded schema before
 * initializing children. During this exact clone construction, child sources
 * are used unchanged (clean:false). Keep joint validation on each new child,
 * but do not validate those same fields again in both Item and TypeDataModel.
 */
export function initializeValidatedPreviewActor(actor, options, initialize) {
  const source = constructingPreviews.at(-1), token = actor.parent;
  const delta = constructingActorDeltas.at(-1);
  const previewConstruction = Boolean(
    source && token && token !== source && token.parent === source.parent
    && token.id === source.id && token.actorId === source.actorId
  );
  const deltaConstruction = Boolean(delta && token && delta.parent === token);
  if ((!previewConstruction && !deltaConstruction)
    || actor.invalid !== false || options.clean !== false || options.strict !== true
    || actor.validate !== foundry.abstract.DataModel.prototype.validate) return initialize();
  const previous = validatedActorSources.get(actor);
  validatedActorSources.set(actor, new Set(actor._source.items));
  try { return initialize(); }
  finally {
    if (previous) validatedActorSources.set(actor, previous);
    else validatedActorSources.delete(actor);
  }
}

function canReuseValidatedActorDeltaSources(delta, context = {}) {
  const token = delta?.parent;
  const baseActor = token?.baseActor;
  return Boolean(
    game.release?.version === "14.361"
    && token?.documentName === "Token"
    && token.actorLink === false
    && delta.invalid === false
    && baseActor?.invalid === false
    && context.strict === true
    && context.dropInvalidEmbedded === true
    && context.clean === undefined
    && delta.validate === foundry.abstract.DataModel.prototype.validate
    && baseActor.validate === foundry.abstract.DataModel.prototype.validate
  );
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
  return { ...options, fields: false };
}
