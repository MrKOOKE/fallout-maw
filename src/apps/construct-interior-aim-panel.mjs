import { getConstructCompartmentContents } from "../utils/construct-interior.mjs";
import { getInstalledConstructPartForSlot } from "../utils/construct-parts.mjs";
import { resolvePassengerActorSync } from "../utils/construct-crew.mjs";
import { isLimbDestroyed } from "../utils/limb-state.mjs";

/** A separate aimed layer keeps the exterior menu compact and preserves physical ancestry. */
export class ConstructInteriorAimPanel {
  constructor(controller) { this.controller = controller; this.element = null; this.selection = null; }
  contains(element) { return this.element?.contains(element) ?? false; }
  show(actor, shellSlotId, slotId = shellSlotId, passenger = null) {
    const contents = getConstructCompartmentContents(actor, slotId);
    if (!passenger && !contents.parts.length && !contents.passengers.length) { this.hide(); return; }
    if (!this.element) {
      this.element = document.createElement("div");
      this.element.className = "fallout-maw-interior-aim-panel";
      this.element.addEventListener("contextmenu", event => { event.preventDefault(); event.stopPropagation(); });
      document.body.append(this.element);
    }
    this.selection = { actor, shellSlotId, slotId, passenger };
    const part = getInstalledConstructPartForSlot(actor, slotId);
    const crewActor = passenger ? resolvePassengerActorSync(passenger) : null;
    const title = crewActor?.name ?? part?.name ?? "Внутреннее размещение";
    this.element.replaceChildren();
    const header = document.createElement("div"); header.className = "interior-aim-header";
    if (slotId !== shellSlotId || passenger) {
      const back = document.createElement("button"); back.type = "button"; back.textContent = "‹"; back.title = "К содержимому оболочки";
      back.dataset.interiorBack = "true"; header.append(back);
    }
    const name = document.createElement("strong"); name.textContent = title; header.append(name); this.element.append(header);
    const hint = document.createElement("small"); hint.textContent = "Попадание проходит защиту оболочки"; this.element.append(hint);
    const list = document.createElement("div"); list.className = "interior-aim-list"; this.element.append(list);
    const add = (label, descriptor, expand = null, disabled = false) => {
      const row = document.createElement("div"); row.className = "interior-aim-row";
      const button = document.createElement("button"); button.type = "button"; button.textContent = label; button.disabled = disabled;
      if (descriptor && !disabled) {
        const targetActor = descriptor.kind === "passenger" ? crewActor : actor;
        const key = descriptor.kind === "passenger" ? descriptor.limbKey : `constructPart:${descriptor.slotId}`;
        const chance = this.controller.getConstructInteriorAimChance(targetActor, key);
        const output = document.createElement("span"); output.className = "interior-aim-chance"; output.textContent = `${Math.round(chance)}%`;
        button.append(output);
      }
      if (descriptor) { button.dataset.interiorTarget = JSON.stringify(descriptor); button.title = "Прицелиться через оболочку"; }
      else button.dataset.interiorExpand = JSON.stringify(expand);
      row.append(button);
      if (descriptor && expand) { const open = document.createElement("button"); open.type = "button"; open.textContent = "›";
        open.title = "Показать содержимое"; open.dataset.interiorExpand = JSON.stringify(expand); row.append(open); }
      list.append(row);
    };
    if (crewActor) {
      for (const [limbKey, limb] of Object.entries(crewActor.system?.limbs ?? {})) {
        if (!limb || typeof limb !== "object") continue;
        add(String(limb.label ?? limbKey), { kind: "passenger", shellSlotId, passengerId: passenger.id,
          actorUuid: crewActor.uuid, limbKey }, null, isLimbDestroyed(crewActor, limbKey));
      }
    } else {
      for (const child of contents.parts) {
        const nested = getConstructCompartmentContents(actor, child.slotId);
        const expandable = nested.parts.length || nested.passengers.length;
        add(child.item?.name ?? "Пустая оболочка", child.item ? { kind: "part", shellSlotId, slotId: child.slotId } : null,
          expandable ? { slotId: child.slotId } : null, child.item
            ? isLimbDestroyed(actor, `constructPart:${child.slotId}`) : !expandable);
      }
      for (const occupant of contents.passengers) {
        const character = resolvePassengerActorSync(occupant);
        if (character) add(character.name, null, { slotId, passengerId: occupant.id });
      }
    }
    this.position();
  }
  handlePointerDown(event) {
    if (!this.contains(event.target)) return false;
    event.preventDefault(); event.stopPropagation();
    event.stopImmediatePropagation?.();
    if (this.controller.processing || !this.selection) return true;
    if (event.button === 2) { this.controller.onCancel(event); return true; }
    if (event.button !== 0) return true;
    const { actor, shellSlotId, slotId } = this.selection;
    if (event.target.closest("[data-interior-back]")) { this.show(actor, shellSlotId); return true; }
    const expand = event.target.closest("[data-interior-expand]");
    if (expand && !expand.disabled) {
      const next = JSON.parse(expand.dataset.interiorExpand);
      const passenger = next.passengerId ? getConstructCompartmentContents(actor, next.slotId).passengers.find(row => row.id === next.passengerId) : null;
      this.show(actor, shellSlotId, next.slotId ?? slotId, passenger); return true;
    }
    const button = event.target.closest("[data-interior-target]");
    if (button && !button.disabled && this.controller.aimedMode === "limb") {
      this.controller.selectedInteriorTarget = JSON.parse(button.dataset.interiorTarget);
      void this.controller.runInteractiveAttackOperation(() => this.controller.performAimedAttack(`constructPart:${shellSlotId}`));
    }
    return true;
  }
  position() {
    if (!this.element || !this.controller.limbMenu) return;
    const parent = this.controller.limbMenu.getBoundingClientRect(), rect = this.element.getBoundingClientRect();
    const gap = 6, margin = 8;
    const candidate = parent.right + gap + rect.width <= window.innerWidth - margin ? parent.right + gap : parent.left - rect.width - gap;
    this.element.style.left = `${Math.max(margin, Math.min(window.innerWidth - rect.width - margin, candidate))}px`;
    this.element.style.top = `${Math.max(margin, Math.min(window.innerHeight - rect.height - margin, parent.top))}px`;
  }
  hide() { this.element?.remove(); this.element = null; this.selection = null; }
}
