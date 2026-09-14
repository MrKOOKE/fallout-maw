import { normalizeInventoryMutationPlans, validateActorInventoryState } from "./mutation.mjs";

/** Plan several ordinary transfers against isolated collections, then commit once. */
export function createInventoryMutationPreview(actors) {
  const states = new Map();
  for (const original of actors) {
    if (states.has(original.uuid)) continue;
    const initial = original.items.contents.map(item => item.toObject());
    const actor = {
      id: original.id, uuid: original.uuid, documentName: "Actor",
      name: original.name, type: original.type, isOwner: original.isOwner,
      system: original.system, flags: original.flags, _source: original._source,
      getFlag: (...args) => original.getFlag?.(...args),
      getRollData: (...args) => original.getRollData?.(...args)
    };
    actor.items = createItems(initial, actor);
    states.set(actor.uuid, { original, actor, initial });
  }

  function apply(input, { validateLoad = true } = {}) {
    const plans = normalizeInventoryMutationPlans(input, { resolveActors: false });
    for (const plan of plans) {
      if (states.get(plan.actor.uuid)?.actor !== plan.actor || plan.actorUpdatePaths.length) {
        throw new Error("Inventory preview received an unrelated mutation.");
      }
      validateActorInventoryState(plan.actor, plan.projectedItems, { validateLoad });
    }
    // Rejecting any part leaves both preview actors untouched.
    for (const plan of plans) plan.actor.items = createItems(plan.projectedItems, plan.actor);
    return { createdDocuments: plans.flatMap(plan => plan.creates.map(item => plan.actor.items.get(item._id))) };
  }

  function getPlans() {
    return [...states.values()].map(({ original, actor, initial }) => {
      const originals = new Map(initial.map(item => [item._id, item]));
      const updates = [], creates = [];
      for (const item of actor.items) {
        const before = originals.get(item.id);
        const after = item.toObject();
        if (!before) creates.push(after);
        else {
          const difference = foundry.utils.diffObject(before, after);
          if (Object.keys(difference).length) updates.push({ ...difference, _id: item.id });
        }
      }
      return { actor: original, expectedItems: initial, updates, creates,
        deletes: initial.filter(item => !actor.items.has(item._id)).map(item => item._id) };
    }).filter(plan => plan.updates.length || plan.creates.length || plan.deletes.length);
  }
  return { getActor: uuid => states.get(uuid)?.actor, apply, getPlans };
}

function createItems(sources, actor) {
  const map = new Map(sources.map(source => {
    const data = foundry.utils.deepClone(source);
    const item = { ...data, id: data._id, uuid: `${actor.uuid}.Item.${data._id}`,
      documentName: "Item", parent: actor, _source: data,
      getFlag: (scope, key) => data.flags?.[scope]?.[key],
      toObject: () => foundry.utils.deepClone(data) };
    return [item.id, item];
  }));
  return {
    get contents() { return [...map.values()]; }, get size() { return map.size; },
    get: id => map.get(id), has: id => map.has(id),
    find: fn => [...map.values()].find(fn), filter: fn => [...map.values()].filter(fn),
    map: fn => [...map.values()].map(fn), some: fn => [...map.values()].some(fn),
    values: () => map.values(), [Symbol.iterator]: () => map.values()
  };
}
