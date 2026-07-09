import { isTargetInFirstAidRange, useFirstAidItem } from "./first-aid.mjs";
import { openLightSourceEnergyDialog } from "./light-source.mjs";
import { useNeedChangeItem } from "./need-change.mjs";
import { useOneTimeUseItem } from "./one-time-use.mjs";
import { requestCustomActorTokenSelection } from "../canvas/custom-token-selection.mjs";
import { startTrapPlacement } from "../canvas/traps.mjs";
import { isActorUnableToAct, isReactionSystemLocked } from "../combat/reaction-hub.mjs";
import { ITEM_FUNCTIONS, getFirstAidFunction, hasItemFunction, isActiveItem, resolveActorItemOrInstalledModule } from "../utils/item-functions.mjs";

export function canUseActiveItem(item = null) {
  return Boolean(item?.actor?.isOwner && isActiveItem(item));
}

export async function useActiveItem({ actor = null, token = null, item = null, application = null, targetActor = null, targetToken = null } = {}) {
  if (isReactionSystemLocked()) {
    ui.notifications.warn("Ожидание реакций: предмет временно заблокирован.");
    return false;
  }
  const sourceActor = actor ?? item?.actor ?? token?.actor ?? token?.document?.actor ?? null;
  if (!sourceActor?.isOwner || !item || !canUseActiveItem(item)) return false;
  if (isActorUnableToAct(sourceActor)) {
    ui.notifications.warn(`${sourceActor.name}: невозможно использовать предмет без сознания или после смерти.`);
    return false;
  }

  const freshItem = resolveActorItemOrInstalledModule(sourceActor, item.id) ?? item;
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
  if (hasItemFunction(freshItem, ITEM_FUNCTIONS.trap)) {
    return startTrapPlacement({
      actor: sourceActor,
      token: sourceToken,
      item: freshItem,
      application
    });
  }

  if (hasItemFunction(freshItem, ITEM_FUNCTIONS.oneTimeUse)) {
    const used = await useOneTimeUseItem({
      actor: sourceActor,
      item: freshItem
    });
    if (used) await application?.render?.({ force: true });
    return used;
  }

  const isFirstAid = hasItemFunction(freshItem, ITEM_FUNCTIONS.firstAid);
  const target = targetActor
    ? { actor: targetActor, token: targetToken?.document ?? targetToken ?? null }
    : (isFirstAid
      ? await requestFirstAidItemTarget(sourceActor, sourceToken, freshItem)
      : resolveActiveItemTarget(sourceActor, sourceToken));
  if (!target?.actor) return false;

  const used = isFirstAid
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

async function requestFirstAidItemTarget(sourceActor = null, sourceToken = null, item = null) {
  const firstAid = getFirstAidFunction(item);
  const selected = await requestCustomActorTokenSelection({
    sourceActor,
    sourceToken,
    includeSelf: true,
    title: "Первая помощь",
    noneWarning: "Нет подходящих целей для первой помощи.",
    instructions: "Первая помощь: выберите цель. Esc/ПКМ отменяет.",
    getReason: ({ token }) => {
      if (isTargetInFirstAidRange(sourceToken, token, firstAid, { warn: false })) return "";
      return "Цель слишком далеко.";
    }
  });
  if (!selected?.actor) return { actor: null, token: null };
  return {
    actor: selected.actor,
    token: selected.token?.document ?? selected.token
  };
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
