import { runOneTimeResourceMutation } from "../combat/one-time-resources.mjs";

export const activeLiberations = new Map();

/** The shared overload writer calls this without loading the combat UI. */
export async function absorbLiberationOverload(actor, amount) {
  const now = () => Number(globalThis.game?.time?.worldTime) || 0;
  if (!(actor?.getFlag?.("fallout-maw", "liberation")?.until > now())) return false;
  return runOneTimeResourceMutation(actor, async () => {
    const data = actor.getFlag("fallout-maw", "liberation");
    if (!(data?.until > now())) return false;
    await actor.setFlag("fallout-maw", "liberation", { ...data, damage: (Number(data.damage) || 0) + Math.max(0, Number(amount) || 0) });
    activeLiberations.set(actor.uuid, actor);
    return true;
  });
}
