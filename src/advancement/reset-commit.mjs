import { BATCH_EXPECTED_IDS_OPTION } from "../utils/document-batch-integrity.mjs";

/** Reset advancement data and remove granted abilities as one Foundry batch. */
export async function commitAdvancementReset(actor, actorUpdate, abilityItemIds, applicationId) {
  const actorId = String(actor?.id ?? actor?._id ?? "");
  const ids = Array.from(new Set(Array.from(abilityItemIds ?? [], id => String(id ?? "")).filter(Boolean)));
  if (!actorId) throw new TypeError("Advancement reset requires an Actor ID.");
  if (!ids.length) throw new TypeError("Advancement reset batch requires at least one ability Item.");

  const sourceOption = "falloutMawAdvancementApplicationId";
  const operations = [
    {
      action: "delete",
      documentName: "Item",
      ids,
      parent: actor,
      [BATCH_EXPECTED_IDS_OPTION]: ids,
      [sourceOption]: String(applicationId ?? ""),
      animate: false,
      render: false
    },
    {
      action: "update",
      documentName: "Actor",
      updates: [{ _id: actorId, ...actorUpdate }],
      [BATCH_EXPECTED_IDS_OPTION]: [actorId],
      [sourceOption]: String(applicationId ?? ""),
      diff: false,
      render: false
    }
  ];

  const results = await foundry.documents.modifyBatch(operations);
  if (!Array.isArray(results) || results.length !== operations.length) {
    throw new Error("Advancement reset batch did not return every document result.");
  }

  const deletedIds = new Set(Array.from(results[0] ?? [], document => String(document?.id ?? document?._id ?? "")));
  if (ids.some(id => !deletedIds.has(id))) {
    throw new Error("Advancement reset batch did not delete every ability Item.");
  }
  const updatedActor = Array.from(results[1] ?? []).find(document => String(document?.id ?? document?._id ?? "") === actorId);
  if (!updatedActor) throw new Error("Advancement reset batch did not update its Actor.");
  return updatedActor;
}
