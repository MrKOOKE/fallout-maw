export const BATCH_EXPECTED_IDS_OPTION = "falloutMawBatchExpectedIds";

/**
 * Foundry V14 filters canceled documents during each batch's dry run. It even
 * skips _pre*Operation when every document was canceled, then sends the other
 * operations. Check after the document-class call, before the backend sends
 * anything, so a rejected transfer cannot delete its source or duplicate it.
 */
export function assertBatchPreflightIds(operation, action) {
  if (!operation?.dryRun || !Object.hasOwn(operation, BATCH_EXPECTED_IDS_OPTION)) return;
  const expected = operation[BATCH_EXPECTED_IDS_OPTION];
  if (!Array.isArray(expected) || expected.some(id => typeof id !== "string" || !id)
    || new Set(expected).size !== expected.length) {
    throw new TypeError("A complete document batch requires unique expected IDs.");
  }
  const field = {create: "data", update: "updates", delete: "ids"}[action];
  const actual = Array.from(operation[field] ?? [], entry => typeof entry === "string" ? entry : entry?.id ?? entry?._id);
  const expectedSet = new Set(expected);
  if (actual.length === expected.length && new Set(actual).size === actual.length
    && actual.every(id => expectedSet.has(id))) return;
  throw new Error(`Document batch ${action} was canceled or changed its requested document set.`);
}
