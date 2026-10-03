import { getActorTokenRecipients } from "../utils/actor-target-context.mjs";
import { chooseWithChips } from "./choice-chips.mjs";
import { localize } from "../utils/i18n.mjs";

export function getActorTargetChoices(token, { sourceActorUuid = "", includeSelf = true, getReason = null } = {}) {
  return getActorTokenRecipients(token).map(recipient => {
    const isSelf = recipient.actorUuid === sourceActorUuid;
    const reason = !includeSelf && isSelf ? localize("FALLOUTMAW.AuditRuntime.R0628", "Нужна другая цель.")
      : String(getReason?.({ ...recipient, isSelf }) ?? "");
    return { ...recipient, isSelf, reason, selectable: !reason };
  });
}

export async function chooseActorTargetRecipient(token, { title = localize("FALLOUTMAW.AuditRuntime.R0626", "Выбор цели"), ...options } = {}) {
  const choices = getActorTargetChoices(token, options);
  if (choices.length <= 1) return choices.find(choice => choice.selectable) ?? null;
  const id = await chooseWithChips({ title, prompt: token?.name ?? token?.actor?.name ?? "",
    choices: choices.map(choice => ({ value: choice.actorUuid, label: choice.label || choice.actor.name,
      detail: choice.label ? choice.actor.name : "", img: choice.actor.img, reason: choice.reason })) });
  // Seat membership and eligibility may have changed while the dialog was open.
  return id ? getActorTargetChoices(token, options).find(choice => choice.actorUuid === id && choice.selectable) ?? null : null;
}
