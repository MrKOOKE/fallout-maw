import { evaluateEffectChangeNumber } from "../utils/effect-change-values.mjs";

/** Whether a configured change can materially affect the current operation. */
export function isConsumableActiveUseChange(actor = null, change = {}) {
  if (String(change?.value ?? "") === "") return false;
  const amount = evaluateEffectChangeNumber(actor, change.value, { fallback: Number.NaN });
  if (!Number.isFinite(amount)) return false;
  switch (String(change?.type ?? "add")) {
    case "multiply": return amount !== 1;
    case "override":
    case "upgrade":
    case "downgrade": return true;
    default: return amount !== 0;
  }
}
