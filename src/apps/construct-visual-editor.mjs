import { FalloutMaWFormApplicationV2 } from "./base-form-application-v2.mjs";
import { getConstructPartSlots, getInstalledConstructPartForSlot } from "../utils/construct-parts.mjs";
import { isItemBrokenByCondition } from "../utils/item-functions.mjs";
import { getConstructCrewSeatOptions } from "../utils/construct-crew.mjs";
import { getConstructSystems } from "../utils/construct-systems.mjs";
import { CONSTRUCT_INTERIOR_FLAG, getConstructInteriorConfig, normalizeConstructInterior,
  getConstructPartContainmentPath, getConstructCompartmentContents } from "../utils/construct-interior.mjs";
import {
  CONSTRUCT_CREW_ROLE_FUNCTIONS, CONSTRUCT_VISUAL_FLAG,
  getConstructVisualConfig, normalizeConstructVisual, normalizeConstructPersonalWeapons,
  resolveConstructVisualAnchors, resolveConstructVisualLayers, rotateConstructVisualOffset
} from "../utils/construct-visual-model.mjs";

const ROLES = [
  { value: "passenger", label: "Пассажир" }, { value: "driver", label: "Водитель" },
  { value: "gunner", label: "Стрелок" }, { value: "loader", label: "Заряжающий" }, { value: "custom", label: "Своя роль" }
];
const FUNCTIONS = [
  { value: "move", label: "Движение" }, { value: "rotate", label: "Поворот корпуса" },
  { value: "aim", label: "Прицеливание" }, { value: "fire", label: "Стрельба" }, { value: "reload", label: "Перезарядка" },
  { value: "activate", label: "Запуск систем" }
];

/** Draft editor: every change previews immediately; only Save updates the Actor. */
export class ConstructVisualEditor extends FalloutMaWFormApplicationV2 {
  #config;
  #interior;
  #activeTab = "parts";
  #selectedPartId = "";
  #selectedSeatId = "";
  #selectedAnchorId = "";
  #selectedInteriorSlotId = "";
  #placingAnchor = false;
  #previewAim = false;
  #previewSlotId = "";
  #previewRotations = {};
  #previewResizeObserver;
  #renderEvents;

  constructor(actor, options = {}) {
    super(options);
    this.actor = actor;
    this.#config = getConstructVisualConfig(actor);
    this.#interior = getConstructInteriorConfig(actor);
    this.#selectedAnchorId = this.#config.anchors[0]?.id ?? "";
    this.#selectedPartId = this.#config.parts[0]?.id ?? "";
    this.#selectedSeatId = this.#config.seats[0]?.id ?? "";
    this.#selectedInteriorSlotId = this.#interior.parts[0]?.slotId ?? "";
  }

  static DEFAULT_OPTIONS = {
    ...FalloutMaWFormApplicationV2.DEFAULT_OPTIONS,
    id: "fallout-maw-construct-visual-editor",
    classes: ["fallout-maw", "fallout-maw-config-form", "construct-visual-editor"],
    position: { width: 1240, height: 800 },
    window: { resizable: true },
    form: { handler: FalloutMaWFormApplicationV2.handleFormSubmit, submitOnChange: false, closeOnSubmit: false },
    actions: {
      addVisualAnchor: this.#addAnchor, removeVisualAnchor: this.#removeAnchor,
      placeVisualAnchor: this.#placeAnchor, addVisualPart: this.#addPart,
      removeVisualPart: this.#removePart, pickVisualImage: this.#pickImage,
      addCrewSeat: this.#addSeat, removeCrewSeat: this.#removeSeat,
      resetVisualAim: this.#resetAim,
      switchVisualTab: this.#switchTab, selectVisualRecord: this.#selectRecord
    }
  };

  static PARTS = { body: { template: "systems/fallout-maw/templates/actor/construct-visual-editor.hbs" } };

  static get scrollPreservationSelectors() {
    return [...super.scrollPreservationSelectors, ".construct-visual-fields", ".construct-visual-preview-panel"];
  }

  get title() { return `Модульный токен: ${this.actor.name}`; }

  async _prepareContext(options) {
    const slots = this.#slots();
    const physicalSeats = getConstructCrewSeatOptions(this.actor).map(option => ({ ...option,
      label: `${this.actor.items?.get?.(option.itemId)?.name || "Отсек"} · место ${option.slotIndex + 1}`
    }));
    if (!this.#config.parts.some(part => part.id === this.#selectedPartId)) this.#selectedPartId = this.#config.parts[0]?.id ?? "";
    if (!this.#config.anchors.some(anchor => anchor.id === this.#selectedAnchorId)) this.#selectedAnchorId = this.#config.anchors[0]?.id ?? "";
    if (!this.#config.seats.some(seat => seat.id === this.#selectedSeatId)) this.#selectedSeatId = this.#config.seats[0]?.id ?? "";
    this.#interior = normalizeConstructInterior(this.#interior, { slotIds: slots.map(slot => slot.id) });
    if (!this.#interior.parts.some(part => part.slotId === this.#selectedInteriorSlotId)) this.#selectedInteriorSlotId = this.#interior.parts[0]?.slotId ?? "";
    const anchors = this.#config.anchors.map((anchor, index) => ({
      ...anchor, index, selected: anchor.id === this.#selectedAnchorId,
      parents: this.#config.anchors.filter(entry => entry.id !== anchor.id).map(entry => ({
        value: entry.id, label: entry.name, selected: entry.id === anchor.parentId
      })), parentParts: selectOptions(slots, anchor.parentSlotId)
    }));
    const partOptions = slots.map(slot => ({ value: slot.id, label: slot.label }));
    const parts = this.#config.parts.map((part, index) => ({
        ...part, index, slots: selectOptions(slots, part.slotId),
        selected: part.id === this.#selectedPartId,
        label: slots.find(slot => slot.id === part.slotId)?.label || "Деталь без назначения",
        status: slots.find(slot => slot.id === part.slotId)?.broken ? "Повреждена" : slots.find(slot => slot.id === part.slotId)?.installed ? "Установлена" : "Снята",
        anchors: this.#config.anchors.map(anchor => ({ value: anchor.id, label: anchor.name, selected: anchor.id === part.anchorId })),
        muzzleAnchors: this.#config.anchors.map(anchor => ({ value: anchor.id, label: anchor.name, selected: anchor.id === part.muzzleAnchorId })),
        rotationSystems: getConstructSystems(this.actor).map(system => ({ id: system.id, name: system.name, checked: (part.rotationSystemIds ?? []).includes(system.id) }))
      }));
    const seats = this.#config.seats.map((seat, index) => ({
        ...seat, index, selected: seat.id === this.#selectedSeatId,
        roleLabel: ROLES.find(role => role.value === seat.role)?.label || "Пассажир",
        roles: ROLES.map(role => ({ ...role, selected: role.value === seat.role })),
        physicalSeats: physicalSeats.map(option => ({ ...option, selected: option.slotId === seat.slotId && option.slotIndex === seat.slotIndex })),
        parts: partOptions.map(option => ({ ...option, selected: option.value === seat.partSlotId })),
        functions: FUNCTIONS.map(entry => ({ ...entry, checked: seat.functions.includes(entry.value) })),
        systems: getConstructSystems(this.actor).map(system => ({ id: system.id, name: system.name, checked: seat.systemIds.includes(system.id) })),
        personalAnchors: this.#config.anchors.map(anchor => ({ value: anchor.id, label: anchor.name,
          selected: anchor.id === seat.personalWeapons.anchorId }))
      }));
    const interior = this.#interior.parts.map(part => {
      const slot = slots.find(entry => entry.id === part.slotId);
      const parent = slots.find(entry => entry.id === part.parentSlotId);
      const children = this.#interior.parts.filter(child => child.parentSlotId === part.slotId)
        .map(child => slots.find(entry => entry.id === child.slotId)?.label || child.slotId);
      const occupants = getConstructCompartmentContents(this.actor, part.slotId).passengers
        .map(passenger => passenger.actorName || "Персонаж");
      return { ...part, label: slot?.label || "Безымянная деталь", selected: part.slotId === this.#selectedInteriorSlotId,
        locationLabel: parent ? `Внутри: ${parent.profile?.name || parent.label}` : "Снаружи",
        parents: slots.filter(candidate => candidate.id !== part.slotId
          && !getConstructPartContainmentPath(this.#interior, candidate.id).includes(part.slotId))
          .map(candidate => ({ value: candidate.id, label: candidate.label, selected: candidate.id === part.parentSlotId })),
        pathLabel: getConstructPartContainmentPath(this.#interior, part.slotId)
          .map(id => slots.find(entry => entry.id === id)?.profile?.name || slots.find(entry => entry.id === id)?.label || id).join(" → "),
        childrenLabel: children.join(", "), occupantsLabel: occupants.join(", ") };
    });
    return {
      ...(await super._prepareContext(options)), config: this.#config,
      placingAnchor: this.#placingAnchor, hasSlots: slots.length > 0, hasPhysicalSeats: physicalSeats.length > 0,
      anchors, parts, seats, interior,
      partsTab: this.#activeTab === "parts", anchorsTab: this.#activeTab === "anchors", seatsTab: this.#activeTab === "seats", interiorTab: this.#activeTab === "interior",
      selectedPart: parts.find(part => part.selected), selectedAnchor: anchors.find(anchor => anchor.selected), selectedSeat: seats.find(seat => seat.selected),
      selectedInterior: interior.find(part => part.selected),
      partCount: parts.length, anchorCount: anchors.length, seatCount: seats.length, interiorCount: interior.length,
      previewAim: this.#previewAim,
      previewParts: this.#config.parts.filter(part => part.rotates).map(part => ({
        value: part.slotId, label: slots.find(slot => slot.id === part.slotId)?.label ?? "Вращаемая деталь",
        selected: part.slotId === this.#previewSlotId
      })),
      previewAspect: `${this.#dimensions().width} / ${this.#dimensions().height}`
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.#renderEvents?.abort();
    this.#renderEvents = new AbortController();
    const eventOptions = { signal: this.#renderEvents.signal };
    this.element.addEventListener("change", event => this.#onFieldChange(event), eventOptions);
    this.element.addEventListener("input", event => {
      if (event.target.type === "number" || event.target.matches('[data-visual-key="img"], [data-visual-key="damagedImg"], [data-visual-key="baseImage"]')) this.#onFieldChange(event);
    }, eventOptions);
    const preview = this.element.querySelector("[data-visual-preview]");
    let dragging = false;
    preview?.addEventListener("pointerdown", event => {
      const marker = event.target.closest("[data-preview-anchor]");
      if (marker) { this.#selectedAnchorId = marker.dataset.previewAnchor; this.#activeTab = "anchors"; }
      if (!marker && !this.#placingAnchor) return;
      event.preventDefault();
      dragging = true;
      preview.setPointerCapture(event.pointerId);
      this.#updateAnchorFromPointer(event);
    }, eventOptions);
    preview?.addEventListener("pointermove", event => {
      if (dragging) this.#updateAnchorFromPointer(event);
      else if (this.#previewAim) this.#updateAimFromPointer(event);
    }, eventOptions);
    const finish = () => {
      if (!dragging) return;
      dragging = false;
      this.#placingAnchor = false;
      void this.render();
    };
    preview?.addEventListener("pointerup", finish, eventOptions);
    preview?.addEventListener("pointercancel", finish, eventOptions);
    this.#refreshPreview();
    this.#previewResizeObserver?.disconnect();
    this.#previewResizeObserver = new ResizeObserver(() => this.#fitPreview());
    const frame = this.element.querySelector(".construct-visual-preview-frame");
    if (frame) this.#previewResizeObserver.observe(frame);
    this.#fitPreview();
  }

  async close(options = {}) {
    this.#renderEvents?.abort();
    this.#previewResizeObserver?.disconnect();
    return super.close(options);
  }

  async _processFormData() {
    if (!this.actor.isOwner && !game.user?.isGM) {
      ui.notifications?.warn("Для изменения модульного токена нужны права владельца.");
      return;
    }
    const refs = this.#config.seats.map(seat => `${seat.slotId}:${seat.slotIndex}`);
    if (new Set(refs).size !== refs.length) {
      ui.notifications?.warn("Одно физическое место может иметь только одно назначение экипажа. Укажите другое место или объедините функции.");
      return;
    }
    const normalized = normalizeConstructVisual(this.#config);
    const physical = getConstructCrewSeatOptions(this.actor);
    const invalidSeat = normalized.seats.find(seat => !physical.some(option => option.slotId === seat.slotId && option.slotIndex === seat.slotIndex));
    if (invalidSeat) {
      ui.notifications?.warn(`Для места «${invalidSeat.name}» выберите существующее физическое место конструкта.`);
      return;
    }
    const invalidPersonalSeat = normalized.seats.find(seat => seat.personalWeapons.enabled && !seat.personalWeapons.anchorId);
    if (invalidPersonalSeat) {
      ui.notifications?.warn(`Для личного оружия на месте «${invalidPersonalSeat.name}» выберите точку стрельбы во вкладке «Крепления».`);
      return;
    }
    this.#config = normalized;
    this.#interior = normalizeConstructInterior(this.#interior, { slotIds: this.#slots().map(slot => slot.id) });
    await this.actor.update({
      [`flags.fallout-maw.${CONSTRUCT_VISUAL_FLAG}`]: this.#config,
      [`flags.fallout-maw.${CONSTRUCT_INTERIOR_FLAG}`]: this.#interior
    });
    ui.notifications?.info("Модульный токен, размещение деталей и места экипажа сохранены.");
    return this.render();
  }

  #slots() {
    return getConstructPartSlots(this.actor).map(slot => {
      const item = getInstalledConstructPartForSlot(this.actor, slot.id);
      const broken = item && isItemBrokenByCondition(item);
      return { ...slot, installed: Boolean(item), broken,
        label: `${item?.name || slot.profile?.name || "Безымянная деталь"}${!item ? " — снята" : broken ? " — сломана" : ""}` };
    });
  }

  #dimensions() {
    return { width: Number(this.actor.prototypeToken?.width) || 1, height: Number(this.actor.prototypeToken?.height) || 1 };
  }

  #resolveOptions() {
    const slots = this.#slots();
    return { ...this.#dimensions(), rotations: this.#previewRotations,
      installedSlots: slots.filter(slot => slot.installed).map(slot => slot.id),
      brokenSlots: slots.filter(slot => slot.broken).map(slot => slot.id) };
  }

  #onFieldChange(event) {
    const field = event.target;
    if (field.matches("[data-preview-aim]")) { this.#previewAim = field.checked; this.#fitPreview(); this.#refreshPreview(); return; }
    if (field.matches("[data-preview-slot]")) { this.#previewSlotId = field.value; return; }
    const { visualKind: kind, visualIndex: index, visualKey: key } = field.dataset;
    if (!key) return;
    if (kind === "interior") {
      const part = this.#interior.parts.find(row => row.slotId === field.dataset.visualSlotId);
      if (!part || key !== "parentSlotId") return;
      if (field.value && getConstructPartContainmentPath(this.#interior, field.value).includes(part.slotId)) {
        ui.notifications?.warn("Деталь нельзя поместить внутрь самой себя или её содержимого.");
        return this.render();
      }
      part.parentSlotId = field.value;
      return this.render();
    }
    const target = kind === "config" ? this.#config : this.#config[kind]?.[Number(index)];
    if (!target) return;
    if (kind === "seats" && key === "personalWeapons") {
      target.personalWeapons ??= normalizeConstructPersonalWeapons();
      const personalKey = field.dataset.personalKey;
      if (!Object.hasOwn(target.personalWeapons, personalKey)) return;
      target.personalWeapons[personalKey] = field.type === "checkbox" ? field.checked
        : field.type === "number" ? field.value === "" && personalKey === "maxRangeMeters" ? null : Number(field.value) : field.value;
      if (personalKey === "enabled" || personalKey === "anchorId") return this.render();
      return this.#refreshPreview();
    }
    if (key === "physicalSeat") {
      const option = getConstructCrewSeatOptions(this.actor).find(seat => seat.value === field.value);
      target.slotId = option?.slotId ?? "";
      target.slotIndex = option?.slotIndex ?? 0;
    } else if (["systemIds", "rotationSystemIds"].includes(key)) {
      const ids = new Set(target[key] ?? []);
      field.checked ? ids.add(field.dataset.systemId) : ids.delete(field.dataset.systemId);
      target[key] = [...ids];
    } else if (["rotationCost", "hullRotationCost"].includes(key)) {
      target[key] ??= { points: 0, degrees: 15 };
      if (["points", "degrees"].includes(field.dataset.costKey)) target[key][field.dataset.costKey] = Number(field.value);
    } else if (key === "functions") {
      const functions = new Set(target.functions);
      field.checked ? functions.add(field.dataset.function) : functions.delete(field.dataset.function);
      target.functions = [...functions];
    } else {
      target[key] = field.type === "checkbox" ? field.checked : field.type === "number" ? Number(field.value) : field.value;
      if (key === "role") target.functions = [...CONSTRUCT_CREW_ROLE_FUNCTIONS[target.role]];
      if (key === "parentId" && field.value) target.parentSlotId = "";
      if (key === "parentSlotId" && field.value) target.parentId = "";
    }
    if (["role", "parentId", "parentSlotId", "name", "rotates", "slotId", "physicalSeat"].includes(key)) return this.render();
    this.#refreshPreview();
  }

  #refreshPreview() {
    const preview = this.element?.querySelector("[data-visual-preview]");
    if (!preview) return;
    const doc = preview.ownerDocument;
    const fragment = doc.createDocumentFragment();
    const basePath = this.#config.baseImage;
    if (basePath) {
      const base = doc.createElement("img");
      base.src = basePath; base.className = "construct-visual-preview-base"; base.draggable = false;
      fragment.append(base);
    }
    for (const layer of resolveConstructVisualLayers(this.#config, this.#resolveOptions()).filter(layer => layer.visible)) {
      const img = doc.createElement("img");
      img.src = layer.img; img.className = "construct-visual-preview-part"; img.draggable = false;
      img.style.cssText = `left:${layer.x * 100}%;top:${layer.y * 100}%;width:${layer.width * 100}%;height:${layer.height * 100}%;transform-origin:${layer.pivotX * 100}% ${layer.pivotY * 100}%;transform:translate(${-layer.pivotX * 100}%,${-layer.pivotY * 100}%) rotate(${layer.rotation}deg);z-index:${Math.max(1, layer.zIndex + 10001)};`;
      fragment.append(img);
    }
    const seat = this.#activeTab === "seats" ? this.#config.seats.find(entry => entry.id === this.#selectedSeatId) : null;
    if (seat?.personalWeapons?.enabled) {
      const personal = normalizeConstructPersonalWeapons(seat.personalWeapons);
      const anchor = resolveConstructVisualAnchors(this.#config, this.#resolveOptions()).find(entry => entry.id === personal.anchorId && entry.parentVisible);
      if (anchor) this.#appendPersonalWeaponPreview(fragment, doc, anchor, personal);
    }
    for (const anchor of (this.#activeTab === "anchors" || this.#placingAnchor
      ? resolveConstructVisualAnchors(this.#config, this.#resolveOptions()) : [])) {
      const marker = doc.createElement("button");
      marker.type = "button"; marker.dataset.previewAnchor = anchor.id;
      marker.className = `construct-visual-anchor${anchor.id === this.#selectedAnchorId ? " selected" : ""}`;
      marker.style.cssText = `left:${anchor.x * 100}%;top:${anchor.y * 100}%;`;
      marker.title = anchor.name;
      marker.textContent = "+";
      fragment.append(marker);
    }
    preview.replaceChildren(fragment);
    preview.classList.toggle("placing-anchor", this.#placingAnchor);
    preview.classList.toggle("aiming", this.#previewAim);
  }

  #appendPersonalWeaponPreview(fragment, doc, anchor, personal) {
    const { width, height } = this.#dimensions();
    const x = anchor.x * width, y = anchor.y * height;
    const gridDistance = Number(globalThis.canvas?.scene?.grid?.distance) || 1;
    const radius = personal.maxRangeMeters === null ? Math.max(width, height) * 0.8 : personal.maxRangeMeters / gridDistance;
    const start = (anchor.rotation + personal.minRotation) * Math.PI / 180;
    const end = (anchor.rotation + personal.maxRotation) * Math.PI / 180;
    const span = personal.maxRotation - personal.minRotation;
    const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("construct-visual-personal-cone");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("aria-hidden", "true");
    const cone = doc.createElementNS(svg.namespaceURI, span >= 360 ? "circle" : "path");
    if (span >= 360) { cone.setAttribute("cx", x); cone.setAttribute("cy", y); cone.setAttribute("r", radius); }
    else cone.setAttribute("d", `M${x},${y} L${x + Math.sin(start) * radius},${y - Math.cos(start) * radius} A${radius},${radius} 0 ${span > 180 ? 1 : 0} 1 ${x + Math.sin(end) * radius},${y - Math.cos(end) * radius} Z`);
    cone.setAttribute("vector-effect", "non-scaling-stroke");
    svg.append(cone);
    const marker = doc.createElementNS(svg.namespaceURI, "circle");
    marker.setAttribute("cx", x); marker.setAttribute("cy", y); marker.setAttribute("r", Math.min(width, height) * 0.025);
    marker.setAttribute("vector-effect", "non-scaling-stroke");
    marker.classList.add("origin");
    svg.append(marker);
    fragment.append(svg);
  }

  #fitPreview() {
    const frame = this.element?.querySelector(".construct-visual-preview-frame");
    const preview = this.element?.querySelector("[data-visual-preview]");
    if (!frame || !preview) return;
    const { width, height } = this.#dimensions();
    const availableWidth = Math.max(80, frame.clientWidth - 48);
    const availableHeight = Math.max(80, frame.clientHeight - 48);
    const tokenHeight = Math.min(availableHeight, availableWidth * height / width,
      this.#previewAim ? availableWidth * .84 : Infinity);
    preview.style.width = `${tokenHeight * width / height}px`;
    preview.style.height = `${tokenHeight}px`;
  }

  #updateAnchorFromPointer(event) {
    const preview = event.currentTarget;
    const anchor = this.#config.anchors.find(entry => entry.id === this.#selectedAnchorId);
    if (!anchor) return;
    const rect = preview.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width, y = (event.clientY - rect.top) / rect.height;
    const options = this.#resolveOptions();
    const parentPart = this.#config.parts.find(part => part.slotId === anchor.parentSlotId);
    const parent = parentPart
      ? resolveConstructVisualLayers(this.#config, options).find(layer => layer.id === parentPart.id)
      : resolveConstructVisualAnchors(this.#config, options).find(entry => entry.id === anchor.parentId);
    const point = parent ? rotateConstructVisualOffset(x - parent.x, y - parent.y, -parent.rotation, options) : { x, y };
    anchor.x = Number(point.x.toFixed(4)); anchor.y = Number(point.y.toFixed(4));
    this.#refreshPreview();
  }

  #updateAimFromPointer(event) {
    const part = this.#config.parts.find(entry => entry.slotId === this.#previewSlotId && entry.rotates)
      ?? this.#config.parts.find(entry => entry.rotates);
    if (!part) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const layer = resolveConstructVisualLayers(this.#config, this.#resolveOptions()).find(entry => entry.id === part.id);
    if (!layer) return;
    const dx = event.clientX - rect.left - layer.x * rect.width;
    const dy = event.clientY - rect.top - layer.y * rect.height;
    this.#previewRotations[part.slotId] = Math.atan2(dx, -dy) * 180 / Math.PI;
    this.#refreshPreview();
  }

  static #addAnchor(event) {
    event.preventDefault();
    const id = foundry.utils.randomID();
    this.#config.anchors.push({ id, name: `Крепление ${this.#config.anchors.length + 1}`, x: 0.5, y: 0.5, rotation: 0, parentId: "", parentSlotId: "" });
    this.#selectedAnchorId = id; this.#placingAnchor = true; this.#activeTab = "anchors";
    return this.render();
  }

  static #removeAnchor(event, button) {
    event.preventDefault();
    const id = this.#config.anchors[Number(button.dataset.index)]?.id;
    this.#config.anchors = this.#config.anchors.filter(anchor => anchor.id !== id);
    this.#config.anchors.forEach(anchor => { if (anchor.parentId === id) anchor.parentId = ""; });
    this.#config.parts.forEach(part => {
      if (part.anchorId === id) part.anchorId = "";
      if (part.muzzleAnchorId === id) part.muzzleAnchorId = "";
    });
    this.#config.seats.forEach(seat => { if (seat.personalWeapons?.anchorId === id) seat.personalWeapons.anchorId = ""; });
    if (this.#selectedAnchorId === id) this.#selectedAnchorId = this.#config.anchors[0]?.id ?? "";
    return this.render();
  }

  static #placeAnchor(event, button) {
    event.preventDefault();
    this.#selectedAnchorId = this.#config.anchors[Number(button.dataset.index)]?.id ?? "";
    this.#placingAnchor = true; this.#activeTab = "anchors";
    return this.render();
  }

  static #addPart(event) {
    event.preventDefault();
    const slot = this.#slots().find(entry => !this.#config.parts.some(part => part.slotId === entry.id)) ?? this.#slots()[0];
    if (!slot) { ui.notifications?.warn("Сначала добавьте деталь в строение конструкта."); return; }
    const id = foundry.utils.randomID();
    this.#config.parts.push({ id, slotId: slot.id, anchorId: this.#selectedAnchorId, muzzleAnchorId: "",
      img: slot.profile?.img ?? "", damagedImg: "", width: 1, height: 1, pivotX: 0.5, pivotY: 0.5,
      rotation: 0, zIndex: this.#config.parts.length, rotates: false, rotationSpeed: 90,
      rotationCost: { points: 0, degrees: 30 }, rotationSystemIds: [], minRotation: -180, maxRotation: 180 });
    this.#selectedPartId = id; this.#activeTab = "parts";
    return this.render();
  }

  static #removePart(event, button) {
    event.preventDefault();
    this.#config.parts.splice(Number(button.dataset.index), 1);
    return this.render();
  }

  static #addSeat(event) {
    event.preventDefault();
    const option = getConstructCrewSeatOptions(this.actor).find(entry => !this.#config.seats.some(seat => seat.slotId === entry.slotId && seat.slotIndex === entry.slotIndex));
    if (!option) { ui.notifications?.warn("Нет свободных физических мест. Добавьте место функцией «Контейнер актёров» у детали конструкта."); return; }
    const id = foundry.utils.randomID();
    this.#config.seats.push({ id, name: `Место ${this.#config.seats.length + 1}`,
      role: "passenger", functions: [], slotId: option.slotId, slotIndex: option.slotIndex, partSlotId: "" });
    this.#config.seats.at(-1).personalWeapons = normalizeConstructPersonalWeapons();
    this.#selectedSeatId = id; this.#activeTab = "seats";
    return this.render();
  }

  static #removeSeat(event, button) {
    event.preventDefault();
    this.#config.seats.splice(Number(button.dataset.index), 1);
    return this.render();
  }

  static #pickImage(event, button) {
    event.preventDefault();
    const target = button.dataset.kind === "config" ? this.#config : this.#config.parts[Number(button.dataset.index)];
    const key = button.dataset.key;
    if (!target) return;
    new foundry.applications.apps.FilePicker.implementation({
      type: "image", current: target[key] || "", callback: path => { target[key] = path; void this.render(); }
    }).render(true);
  }

  static #resetAim(event) {
    event.preventDefault();
    this.#previewRotations = {}; this.#previewAim = false;
    return this.render();
  }

  static #switchTab(event, button) {
    event.preventDefault();
    if (!["parts", "anchors", "seats", "interior"].includes(button.dataset.tab)) return;
    this.#activeTab = button.dataset.tab;
    this.#placingAnchor = false;
    return this.render();
  }

  static #selectRecord(event, button) {
    event.preventDefault();
    const kind = button.dataset.kind;
    if (kind === "interior") {
      this.#selectedInteriorSlotId = button.dataset.slotId;
      this.#activeTab = "interior";
      this.#placingAnchor = false;
      return this.render();
    }
    const record = this.#config[kind]?.[Number(button.dataset.index)];
    if (!record) return;
    if (kind === "parts") this.#selectedPartId = record.id;
    if (kind === "anchors") this.#selectedAnchorId = record.id;
    if (kind === "seats") this.#selectedSeatId = record.id;
    this.#activeTab = kind;
    this.#placingAnchor = false;
    return this.render();
  }
}

function selectOptions(slots, selected) {
  return slots.map(slot => ({ value: slot.id, label: slot.label, selected: slot.id === selected }));
}
