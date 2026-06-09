import { SYSTEM_ID } from "../constants.mjs";

const PROTOTYPE_UUID_FLAG = "prototypeUuid";

export function getDocumentReferenceCandidates(documentOrData = null, documentName = "") {
  const candidates = new Set();
  const source = documentOrData?._source ?? documentOrData ?? {};
  const type = String(documentName || documentOrData?.documentName || documentOrData?.constructor?.documentName || "").trim();
  const id = String(documentOrData?.id ?? source._id ?? source.id ?? "").trim();
  const uuid = String(documentOrData?.uuid ?? "").trim();
  if (uuid) candidates.add(uuid);
  if (id) {
    candidates.add(id);
    if (type) candidates.add(`${type}.${id}`);
  }

  addReference(candidates, source?._stats?.compendiumSource);
  addReference(candidates, source?._stats?.exportSource?.uuid);
  addReference(candidates, source?.flags?.core?.sourceId);
  addReference(candidates, source?.flags?.[SYSTEM_ID]?.[PROTOTYPE_UUID_FLAG]);
  addReference(candidates, documentOrData?.getFlag?.(SYSTEM_ID, PROTOTYPE_UUID_FLAG));
  addReference(candidates, documentOrData?.getFlag?.("core", "sourceId"));
  return candidates;
}

export function getDocumentPrototypeUuid(documentOrData = null, documentName = "") {
  const source = documentOrData?._source ?? documentOrData ?? {};
  const candidates = getDocumentReferenceCandidates(documentOrData, documentName);
  for (const candidate of candidates) {
    if (isWorldDocumentUuid(candidate, documentName)) return candidate;
  }
  const id = String(source._id ?? source.id ?? "").trim();
  const type = String(documentName || documentOrData?.documentName || documentOrData?.constructor?.documentName || "").trim();
  return id && type ? `${type}.${id}` : "";
}

export function stampPrototypeUuid(document, data = {}, documentName = "") {
  const current = String(document?.getFlag?.(SYSTEM_ID, PROTOTYPE_UUID_FLAG) ?? "").trim();
  if (current) return;
  const prototypeUuid = getDocumentPrototypeUuid(data, documentName || document?.documentName);
  if (!prototypeUuid) return;
  document.updateSource({
    flags: {
      [SYSTEM_ID]: {
        [PROTOTYPE_UUID_FLAG]: prototypeUuid
      }
    }
  });
}

export function resolveWorldDocumentByReference(documentName = "", value = "") {
  const type = String(documentName ?? "").trim();
  const ref = String(value ?? "").trim();
  if (!type || !ref || ref.startsWith("Compendium.")) return null;

  const collection = game.collections?.get?.(type);
  const documents = collection?.contents ?? [];
  const directId = getWorldDocumentIdFromUuid(type, ref);
  if (directId) {
    const direct = collection?.get?.(directId) ?? documents.find(doc => doc.id === directId) ?? null;
    if (direct) return direct;
  }

  return documents.find(doc => getDocumentReferenceCandidates(doc, type).has(ref)) ?? null;
}

export function resolveWorldItemReference(value = "") {
  return resolveWorldDocumentByReference("Item", value);
}

export function resolveWorldActorReference(value = "") {
  return resolveWorldDocumentByReference("Actor", value);
}

export function rewriteItemReferenceData(system = {}) {
  const updates = {};
  rewriteWeaponDataReferences(system.functions?.weapon, "system.functions.weapon", updates);
  for (const [key, value] of Object.entries(system.functions ?? {})) {
    if (!key.startsWith("module:")) continue;
    rewriteWeaponDataReferences(value, `system.functions.${key}`, updates);
  }
  rewriteEnergyConsumerReferences(system.functions?.energyConsumer, "system.functions.energyConsumer", updates);
  return updates;
}

export function rewriteSceneTokenActorReferences(sceneData = {}) {
  const tokens = Array.isArray(sceneData.tokens) ? foundry.utils.deepClone(sceneData.tokens) : [];
  let changed = false;
  for (const token of tokens) {
    const actorId = String(token?.actorId ?? "").trim();
    if (!actorId) continue;
    const actor = resolveWorldActorReference(actorId) ?? resolveWorldActorReference(`Actor.${actorId}`);
    if (!actor || actor.id === actorId) continue;
    token.actorId = actor.id;
    changed = true;
  }
  return changed ? { tokens } : {};
}

function rewriteWeaponDataReferences(weaponData = null, path = "", updates = {}) {
  if (!weaponData || typeof weaponData !== "object") return;
  rewriteUuidList({
    active: weaponData.magazine?.sourceItemUuid,
    list: weaponData.magazine?.sourceItemUuids,
    path: `${path}.magazine`,
    activeKey: "sourceItemUuid",
    listKey: "sourceItemUuids",
    updates
  });

  const slots = Array.isArray(weaponData.moduleSlots) ? foundry.utils.deepClone(weaponData.moduleSlots) : [];
  let changed = false;
  for (const slot of slots) {
    const next = getResolvedItemUuid(slot?.itemUuid);
    if (next && next !== slot.itemUuid) {
      slot.itemUuid = next;
      changed = true;
    }
  }
  if (changed) updates[`${path}.moduleSlots`] = slots;
}

function rewriteEnergyConsumerReferences(consumerData = null, path = "", updates = {}) {
  if (!consumerData || typeof consumerData !== "object") return;
  rewriteUuidList({
    active: consumerData.sourceItemUuid,
    list: consumerData.sourceItemUuids,
    path,
    activeKey: "sourceItemUuid",
    listKey: "sourceItemUuids",
    updates
  });

  const installed = consumerData.installedSource;
  if (installed?.sourceItemUuid) {
    const next = getResolvedItemUuid(installed.sourceItemUuid);
    if (next && next !== installed.sourceItemUuid) {
      updates[`${path}.installedSource.sourceItemUuid`] = next;
    }
  }
}

function rewriteUuidList({ active = "", list = [], path = "", activeKey = "", listKey = "", updates = {} } = {}) {
  const currentActive = String(active ?? "").trim();
  const nextActive = getResolvedItemUuid(currentActive);
  if (nextActive && nextActive !== currentActive) updates[`${path}.${activeKey}`] = nextActive;

  if (!Array.isArray(list)) return;
  const nextList = list.map(uuid => getResolvedItemUuid(uuid) || String(uuid ?? "").trim()).filter(Boolean);
  if (JSON.stringify(nextList) !== JSON.stringify(list)) updates[`${path}.${listKey}`] = [...new Set(nextList)];
}

function getResolvedItemUuid(value = "") {
  const ref = String(value ?? "").trim();
  if (!ref) return "";
  const item = resolveWorldItemReference(ref);
  return item?.uuid ?? "";
}

function addReference(candidates, value) {
  const ref = String(value ?? "").trim();
  if (ref) candidates.add(ref);
}

function getWorldDocumentIdFromUuid(documentName = "", uuid = "") {
  const ref = String(uuid ?? "").trim();
  const type = String(documentName ?? "").trim();
  if (!ref) return "";
  if (type && ref.startsWith(`${type}.`)) return ref.slice(type.length + 1);
  if (!ref.includes(".")) return ref;
  return "";
}

function isWorldDocumentUuid(value = "", documentName = "") {
  const ref = String(value ?? "").trim();
  const type = String(documentName ?? "").trim();
  return Boolean(type && ref.startsWith(`${type}.`));
}
