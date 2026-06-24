import { resolveActorItemOrInstalledModule } from "../utils/item-functions.mjs";
import { openEnergyConsumptionDialog } from "./energy-consumption.mjs";
import { openLightSourceEnergyDialog } from "./light-source.mjs";
import {
  getItemInteractionState,
  resolveActorInteractionToken
} from "./item-interactions.mjs";

export async function openItemInteractionDialog({
  actor = null,
  token = null,
  item = null,
  application = null
} = {}) {
  const sourceActor = actor ?? item?.actor ?? token?.actor ?? token?.document?.actor ?? null;
  const freshItem = sourceActor && item?.id
    ? (resolveActorItemOrInstalledModule(sourceActor, item.id) ?? item)
    : item;
  const sourceToken = resolveActorInteractionToken(sourceActor, token);
  const state = getItemInteractionState(sourceActor, freshItem, { token: sourceToken });

  if (state.hasEnergyConsumption) {
    return openEnergyConsumptionDialog({
      actor: sourceActor,
      item: freshItem,
      conditionId: state.primaryEnergyConditionId,
      application
    });
  }

  if (state.hasLightSource) {
    return openLightSourceEnergyDialog({
      actor: sourceActor,
      token: sourceToken,
      item: freshItem,
      application,
      showToggle: true
    });
  }

  return undefined;
}
