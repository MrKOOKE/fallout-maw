import { transferInventoryContents } from "./contents-transfer.mjs";
import { createInventoryMutationPreview } from "./preview.mjs";
import { executeInventoryMutation } from "./mutation.mjs";

export async function transferInventoryContentsBatch({ source, target, canTransfer, move,
  execute = executeInventoryMutation } = {}) {
  const preview = createInventoryMutationPreview([source.actor, target.actor]);
  const projectedSource = { ...source, actor: preview.getActor(source.actor.uuid) };
  const projectedTarget = { ...target, actor: preview.getActor(target.actor.uuid) };
  const result = await transferInventoryContents({
    source: projectedSource, target: projectedTarget,
    canTransfer: () => canTransfer(source, target),
    move: async (payload, context) => {
      await move(payload, { ...context, executeMutation: preview.apply });
      return true;
    }
  });
  const plans = preview.getPlans();
  if (plans.length) {
    if (!canTransfer(source, target)) throw new Error("Нет прав на перенос содержимого.");
    await execute(plans, { reason: "contents-transfer", documentOptions: {
      falloutMawContentsActorUuids: [...new Set([source.actor.uuid, target.actor.uuid])]
    } });
  }
  return result;
}
