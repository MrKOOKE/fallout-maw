import { getConstructVisualRuntimeConfig } from "../utils/construct-visual-model.mjs";
import { planConstructRotation, getConstructRotationAngle, getConstructRotationPrice } from "../constructs/rotation-actions.mjs";

/** Hull controls belong to the paid hull mechanic, independently of the current sector price. */
export function hasPaidConstructHullRotation(actor) {
  return actor?.type === "construct" && getConstructVisualRuntimeConfig(actor).hullRotationCost.points > 0;
}

export function prepareConstructHullTurnButtons(doc, icons = {}) {
  if (!hasPaidConstructHullRotation(doc?.actor)) return [];
  const angle = getConstructRotationAngle(doc);
  return [-45, -15, 15, 45].map(delta => {
    const left = delta < 0, target = angle + delta;
    const plan = planConstructRotation(doc, "hull", target);
    return { delta, label: `${left ? "Влево" : "Вправо"} ${Math.abs(delta)}°`,
      cost: getConstructRotationPrice(doc, "hull", target), disabled: !plan.powered || !plan.reached,
      img: icons[left ? "rotateLeft" : "rotateRight"] || `systems/fallout-maw/assets/System/TokenActionHud/construct-turn-${left ? "left" : "right"}.svg` };
  });
}
