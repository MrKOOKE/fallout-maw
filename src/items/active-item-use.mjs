import { useFirstAidItem } from "./first-aid.mjs";
import { openLightSourceEnergyDialog } from "./light-source.mjs";
import { useNeedChangeItem } from "./need-change.mjs";
import { ITEM_FUNCTIONS, hasItemFunction, isActiveItem } from "../utils/item-functions.mjs";

export function canUseActiveItem(item = null) {
  return Boolean(item?.actor?.isOwner && isActiveItem(item));
}

export async function useActiveItem({ actor = null, token = null, item = null, application = null } = {}) {
  const sourceActor = actor ?? item?.actor ?? token?.actor ?? token?.document?.actor ?? null;
  if (!sourceActor?.isOwner || !item || !canUseActiveItem(item)) return false;

  const freshItem = sourceActor.items?.get(item.id) ?? item;
  const sourceToken = resolveActorToken(sourceActor, token);
  if (hasItemFunction(freshItem, ITEM_FUNCTIONS.lightSource)) {
    await openLightSourceEnergyDialog({
      actor: sourceActor,
      token: sourceToken,
      item: freshItem,
      application,
      showToggle: true
    });
    return true;
  }

  const target = resolveActiveItemTarget(sourceActor, sourceToken);
  const used = hasItemFunction(freshItem, ITEM_FUNCTIONS.firstAid)
    ? await useFirstAidItem({
      sourceActor,
      sourceToken,
      targetActor: target.actor,
      targetToken: target.token,
      item: freshItem
    })
    : await useNeedChangeItem({
      targetActor: target.actor,
      item: freshItem
    });
  if (used) await application?.render?.({ force: true });
  return used;
}

function resolveActiveItemTarget(actor = null, sourceToken = null) {
  const targetToken = Array.from(game.user?.targets ?? [])
    .find(target => target?.actor) ?? null;
  return {
    token: targetToken ?? sourceToken,
    actor: targetToken?.actor ?? actor
  };
}

function resolveActorToken(actor = null, token = null) {
  const tokenDocument = token?.document ?? token ?? null;
  if (tokenDocument?.actor?.uuid === actor?.uuid) return tokenDocument;
  return (canvas?.tokens?.controlled ?? [])
    .map(controlled => controlled?.document ?? controlled)
    .find(document => document?.actor?.uuid === actor?.uuid) ?? findActorTokenDocument(actor);
}

function findActorTokenDocument(actor = null) {
  if (!actor) return null;
  for (const token of canvas?.tokens?.placeables ?? []) {
    const document = token?.document ?? token;
    if (document?.actor?.uuid === actor.uuid) return document;
  }
  return null;
}
