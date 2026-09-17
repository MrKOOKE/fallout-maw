import { createSkillCheckBatchCollector } from "../rolls/skill-check.mjs";

/** Keep successful hidden rolls in their owner/GM audience, even in a mixed batch. */
export function createStealthCheckBatch({ successMessageData, isSuccess, createCollector = createSkillCheckBatchCollector }) {
  const groups = new Map();
  const collectorFor = outcome => {
    const actor = outcome.actor;
    const successful = isSuccess(outcome);
    const key = `${actor.uuid}:${successful ? "private" : "public"}`;
    if (!groups.has(key)) groups.set(key, createCollector({
      requester: "stealth",
      title: "Проверки скрытности",
      messageData: successful ? successMessageData(actor) : {}
    }));
    return groups.get(key);
  };
  return {
    deferTerminal(outcome, getCompletionPromise) {
      return collectorFor(outcome).deferTerminal(outcome, getCompletionPromise);
    },
    async publish() {
      // Release every terminal barrier even if one card fails to publish.
      let firstError;
      for (const collector of groups.values()) {
        try { await collector.publish(); }
        catch (error) { firstError ??= error; }
      }
      if (firstError) {
        console.error("Fallout MaW | Stealth check batch publication failed", firstError);
        globalThis.ui?.notifications?.warn?.("Проверки скрытности выполнены, но не все карточки были созданы.");
      }
    }
  };
}
