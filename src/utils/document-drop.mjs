/** Resolve an Item or an Item Folder drop into world Items. Folders are expanded recursively. */
export async function getDroppedWorldItems(event) {
  const data = readDropData(event?.dataTransfer);
  if (!data || !["Item", "Folder"].includes(data.type) || !data.uuid) return [];
  const fromUuid = globalThis.fromUuid ?? foundry.utils.fromUuid;
  const document = await fromUuid?.(String(data.uuid));
  if (document?.documentName === "Item") return isWorldItem(document) ? [document] : [];
  if (document?.documentName !== "Folder" || document.type !== "Item" || document.pack) return [];
  return collectWorldFolderItems(document);
}

export function mergeDroppedUuids(current = [], droppedItems = [], index = null) {
  const existing = Array.from(current ?? []).map(value => String(value ?? "").trim()).filter(Boolean);
  const dropped = Array.from(droppedItems ?? []).map(item => String(item?.uuid ?? item ?? "").trim()).filter(Boolean);
  if (!dropped.length) return existing;
  if (Number.isInteger(index) && index >= 0 && index < existing.length) existing.splice(index, 1, ...dropped);
  else existing.push(...dropped);
  return Array.from(new Set(existing));
}

function readDropData(transfer) {
  if (!transfer) return null;
  for (const mime of ["application/json", "text/plain"]) {
    const raw = transfer.getData(mime);
    if (!raw) continue;
    try {
      return JSON.parse(raw);
    } catch (_error) {
      // Try the next supported transfer type.
    }
  }
  return null;
}

function collectWorldFolderItems(rootFolder) {
  const result = [];
  const seenFolders = new Set();
  const seenItems = new Set();
  const visit = folder => {
    if (!folder || seenFolders.has(folder.uuid)) return;
    seenFolders.add(folder.uuid);
    for (const item of sortDocuments(folder.contents).filter(isWorldItem)) {
      if (seenItems.has(item.uuid)) continue;
      seenItems.add(item.uuid);
      result.push(item);
    }
    const children = Array.from(game.folders ?? []).filter(candidate => (
      candidate?.documentName === "Folder"
      && candidate.type === "Item"
      && !candidate.pack
      && candidate.folder?.id === folder.id
    ));
    for (const child of sortDocuments(children)) visit(child);
  };
  visit(rootFolder);
  return result;
}

function sortDocuments(documents) {
  return Array.from(documents ?? []).sort((left, right) => (
    (Number(left?.sort) || 0) - (Number(right?.sort) || 0)
    || String(left?.name ?? "").localeCompare(String(right?.name ?? ""), game.i18n.lang)
  ));
}

function isWorldItem(document) {
  return Boolean(document?.documentName === "Item" && !document.pack && !document.parent);
}
