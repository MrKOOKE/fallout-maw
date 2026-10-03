import { getConstructSystems, getConstructSystemState } from "./construct-systems.mjs";
import { planResourceRecovery } from "./resource-recovery.mjs";
import { resolveWorldItemSync } from "./world-items.mjs";
import { getResourceSettings } from "../settings/accessors.mjs";

export function snapshotConstructServiceSystems(actor) {
  return getConstructSystems(actor).filter(system => system.enabled).map(system => {
    const state = getConstructSystemState(actor, system), resource = actor.system.resources[system.resourceKey];
    return { id: system.id, name: system.name, active: state.operational,
      label: getResourceSettings().find(row => row.key === system.resourceKey)?.label ?? system.resourceKey,
      value: resource?.value ?? 0, max: resource?.max ?? 0,
      recoveryMethods: foundry.utils.deepClone(system.recoveryMethods) };
  });
}

export function prepareConstructServiceRows(systems, sourceActor) {
  return Array.from(systems ?? []).map(system => ({ ...system,
    recipes: system.recoveryMethods.flatMap((method, methodIndex) => {
      if (method.type !== "resources") return [];
      const choices = method.mode === "all" ? [{ index: "", rows: method.resources }]
        : method.resources.map((row, index) => ({ index, rows: [row] }));
      return choices.map(choice => {
        const plan = planResourceRecovery(sourceActor, method, { current: system.value, max: system.max,
          resourceIndex: choice.index === "" ? null : choice.index });
        return { systemId: system.id, methodIndex, resourceIndex: choice.index, usable: plan.ok, reason: plan.reason,
          cost: choice.rows.map(row => `${resolveWorldItemSync(row.uuid)?.name || "Предмет не найден"} × ${row.quantity}`).join(" + "),
          restored: plan.restored ?? Math.min(system.max - system.value,
            Math.floor(method.recoveryMode === "amount" ? method.recovery : system.max * method.recovery / 100)) };
      });
    }) }));
}
