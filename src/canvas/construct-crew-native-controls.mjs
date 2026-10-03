import { canUserControlConstruct, hasConstructCrew } from "../utils/construct-crew.mjs";
import { getTokenMovementAutoRotateOverride, getTokenRotationSpeedMultiplier } from "../utils/token-movement-auto-rotate.mjs";
import { getTokenHitboxProfile } from "../utils/token-hitbox.mjs";

const PATCH = Symbol.for("fallout-maw.constructCrewNativeControls");
let requestControl;
let getSelectedContext;

/** Only native movement/rotation entry points are proxied; document ownership remains native. */
export function registerNativeConstructCrewControls(handlers = {}) {
  requestControl = handlers.requestControl;
  getSelectedContext = handlers.getSelectedContext;
  const TokenClass = CONFIG.Token.objectClass;
  const DocumentClass = CONFIG.Token.documentClass;
  const LayerClass = CONFIG.Canvas.layers.tokens.layerClass;
  registerMovementAutoRotateTokenConfig();
  wrap(TokenClass?.prototype, "_getDragLeftDropUpdateOptions", original => function() {
    const options = original.call(this);
    const override = getTokenMovementAutoRotateOverride(this.document);
    if (override !== undefined) options.autoRotate = override;
    return options;
  });
  wrap(TokenClass?.prototype, "_canControl", original => function(user, event) {
    if (original.call(this, user, event)) return true;
    if (!hasConstructCrew(this.actor) || !getSelectedContext?.(this.document, user)
      || this.document.hidden && !user.isGM || !this.layer.active || !ui.controls.tool?.control
      || canvas.regions._placementContext || this.layer._draggedToken || canvas.controls.ruler.active
      || CONFIG.Canvas.rulerClass.canMeasure && event?.type === "pointerdown") return false;
    return true;
  });
  wrap(TokenClass?.prototype, "_canDragLeftStart", original => function(user, event, options = {}) {
    if (hasConstructCrew(this.actor) && !canUseNativeControl(this.document, user, "move", options.notify !== false)) return false;
    return original.call(this, user, event, options);
  });
  wrap(TokenClass?.prototype, "rotate", original => async function(angle, snap) {
    if (!hasConstructCrew(this.actor) || game.user?.isGM) return original.call(this, angle, snap);
    if (!canUseNativeControl(this.document, game.user, "rotate", true)) return this;
    await runRequest(this.document, { action: "rotate", rotation: Number(angle), snap: Number(snap ?? 0) });
    return this;
  });
  wrap(DocumentClass?.prototype, "move", original => async function(waypoints, options = {}) {
    if (!hasConstructCrew(this.actor) || game.user?.isGM) return original.call(this, waypoints, options);
    if (!canUseNativeControl(this, game.user, "move", true)) return false;
    const result = await runRequest(this, { action: "move", waypoints: Array.isArray(waypoints) ? waypoints : [waypoints],
      movementOptions: nativeMovementOptions({}, options, "api") });
    return Boolean(result?.completed);
  });
  wrap(TokenClass?.prototype, "_onDragLeftDrop", original => function(event) {
    if (game.user?.isGM) return original.call(this, event);
    const clones = event.interactionData?.clones ?? [];
    if (!clones.some(clone => hasConstructCrew(clone._original?.actor))) return original.call(this, event);
    if (!event.interactionData.dropped && this._shouldPreventDragLeftDrop(event)) {
      event.interactionData.released = true;
      event.preventDefault();
      return;
    }
    event.interactionData.dropped = true;
    const result = this._prepareDragLeftDropUpdates(event);
    if (!result) return;
    const [updates, options = {}] = Array.isArray(result[0]) ? result : [result];
    event.interactionData.clearPreviewContainer = false;
    void commitDrag(this.layer, updates, options).catch(notifyError).finally(() => this.layer.clearPreviewContainer());
  });
  wrap(LayerClass?.prototype, "moveMany", original => async function(options = {}) {
    if (game.user?.isGM) return original.call(this, options);
    const { dx = 0, dy = 0, dz = 0, rotate = false, ids, includeLocked = false } = options;
    const objects = this._getMovableObjects(ids, includeLocked);
    const crew = objects.filter(token => hasConstructCrew(token.actor));
    if (!crew.length) return original.call(this, options);
    if (![dx, dy, dz].every(value => [-1, 0, 1].includes(value)) || !dx && !dy && !dz) return [];
    const ordinary = objects.filter(token => !hasConstructCrew(token.actor));
    const result = ordinary.length ? await original.call(this, { ...options, ids: ordinary.map(token => token.id) }) : [];
    this.hud?.close();
    const [updates, movementOptions = {}] = rotate ? this._prepareKeyboardRotationUpdates(crew, dx, dy, dz)
      : this._prepareKeyboardMovementUpdates(crew, dx, dy, dz);
    const requests = [];
    for (const token of crew) {
      if (!canUseNativeControl(token.document, game.user, rotate ? "rotate" : "move", true)) continue;
      const instruction = movementOptions.movement?.[token.id];
      const update = updates.find(row => row._id === token.id);
      const payload = rotate ? { action: "rotate", rotation: update?.rotation }
        : { action: "move", waypoints: instruction?.waypoints ?? [update],
          keyboard: { dx, dy, dz },
          movementOptions: nativeMovementOptions(instruction, movementOptions, "keyboard") };
      requests.push(runRequest(token.document, payload).then(() => result.push(token)).catch(notifyError));
    }
    await Promise.all(requests);
    return result;
  });
  wrap(LayerClass?.prototype, "rotateMany", original => async function(options = {}) {
    if (game.user?.isGM) return original.call(this, options);
    const { ids, includeLocked = false, angle, delta, snap } = options;
    const objects = this._getMovableObjects(ids, includeLocked);
    const crew = objects.filter(token => hasConstructCrew(token.actor));
    if (!crew.length) return original.call(this, options);
    const ordinary = objects.filter(token => !hasConstructCrew(token.actor));
    const result = ordinary.length ? await original.call(this, { ...options, ids: ordinary.map(token => token.id) }) : [];
    for (const token of crew) {
      if (!canUseNativeControl(token.document, game.user, "rotate", true)) continue;
      const payload = { action: "rotate", snap: Number(snap ?? 0),
        ...(angle === undefined ? { delta: Number(delta ?? 0) } : { rotation: Number(angle) }) };
      try { await runRequest(token.document, payload); result.push(token); } catch (error) { notifyError(error); }
    }
    return result;
  });
}

function canUseNativeControl(document, user, action, notify = false) {
  if (user?.isGM) return true;
  const context = getSelectedContext?.(document, user);
  const allowed = Boolean((context || user?.isGM) && canUserControlConstruct(document.actor, user, action,
    { passengerId: context?.passenger.id ?? "" }) && (user?.isGM || !game.paused && !document.locked && !document.hidden));
  if (!allowed && notify) ui.notifications.warn(game.paused && !user?.isGM ? "Игра приостановлена."
    : action === "move" ? "Движением этого конструкта управляет персонаж на водительском месте."
      : "У выбранного места нет функции поворота корпуса.");
  return allowed;
}

function runRequest(document, payload) {
  const context = getSelectedContext?.(document, game.user);
  return requestControl({ tokenUuid: document.uuid, passengerId: context?.passenger.id ?? "", ...payload });
}

async function commitDrag(layer, updates, options) {
  const ordinaryUpdates = [];
  const ordinaryMovement = {};
  const requests = [];
  for (const update of updates) {
    const token = layer.get(update._id);
    if (!token) continue;
    const instruction = options.movement?.[token.id];
    if (!hasConstructCrew(token.actor)) {
      ordinaryUpdates.push(update);
      if (instruction) ordinaryMovement[token.id] = instruction;
      continue;
    }
    if (!canUseNativeControl(token.document, game.user, "move", true)) continue;
    const waypoints = instruction?.waypoints ?? [{ x: update.x, y: update.y, elevation: update.elevation }];
    requests.push(runRequest(token.document, { action: "move", waypoints,
      movementOptions: nativeMovementOptions(instruction, options, "dragging") }));
  }
  if (ordinaryUpdates.length) requests.push(canvas.scene.updateEmbeddedDocuments("Token", ordinaryUpdates,
    { ...options, movement: ordinaryMovement }));
  await Promise.all(requests);
}

function nativeMovementOptions(instruction = {}, options = {}, method = "api") {
  const merged = { ...options, ...instruction };
  const result = { method: merged.method ?? method };
  for (const key of ["id", "planned", "split", "terrainOptions", "constrainOptions", "measureOptions", "showRuler", "autoRotate"])
    if (merged[key] !== undefined) result[key] = merged[key];
  if (result.autoRotate === undefined && ["keyboard", "dragging"].includes(result.method))
    result.autoRotate = game.settings.get("core", "tokenAutoRotate");
  return result;
}

function notifyError(error) { ui.notifications.warn(error?.message ?? String(error)); }

let tokenConfigRegistered = false;
function registerMovementAutoRotateTokenConfig() {
  if (tokenConfigRegistered) return;
  tokenConfigRegistered = true;
  const insert = (app, element) => {
    const form = element?.querySelector?.("form") ?? element;
    if (!form?.querySelector || form.querySelector("[data-fallout-movement-auto-rotate]")) return;
    const document = app.token ?? app.prototype ?? app.document;
    if (!document) return;
    const override = getTokenMovementAutoRotateOverride(document);
    const row = documentElement("div", "form-group");
    row.dataset.falloutMovementAutoRotate = "";
    const label = documentElement("label"); label.textContent = game.i18n.localize("FALLOUTMAW.ConstructCrew.MovementAutoRotate");
    const fields = documentElement("div", "form-fields");
    const select = documentElement("select"); select.name = "flags.fallout-maw.movementAutoRotate";
    for (const [value, key] of [["inherit", "Inherit"], ["on", "Enabled"], ["off", "Disabled"]]) {
      const option = documentElement("option"); option.value = value;
      option.textContent = game.i18n.localize(`FALLOUTMAW.ConstructCrew.MovementAutoRotate${key}`);
      option.selected = value === (override === undefined ? "inherit" : override ? "on" : "off");
      select.append(option);
    }
    fields.append(select); row.append(label, fields);
    const target = form.querySelector("[name='lockRotation']")?.closest(".form-group");
    if (target) target.after(row); else form.querySelector(".tab[data-tab='appearance']")?.append(row);
    const speedRow = documentElement("div", "form-group");
    const speedLabel = documentElement("label"); speedLabel.textContent = "Множитель скорости поворота";
    const speedFields = documentElement("div", "form-fields");
    const speed = documentElement("input"); speed.type = "number"; speed.min = "0.01"; speed.step = "any";
    speed.name = "flags.fallout-maw.rotationSpeedMultiplier"; speed.value = String(getTokenRotationSpeedMultiplier(document));
    speedFields.append(speed); speedRow.append(speedLabel, speedFields);
    const speedHint = documentElement("p", "hint"); speedHint.textContent = "1 — штатная скорость; 0,333 — втрое медленнее. Влияет на поворот корпуса, включая автоповорот при движении.";
    speedRow.append(speedHint); row.after(speedRow);
    const hitbox = documentElement("details");
    const summary = documentElement("summary"); summary.textContent = "Область токена"; hitbox.append(summary);
    const profile = getTokenHitboxProfile(document) ?? { enabled: false };
    for (const [key, caption] of [["enabled", "Поворачивать область вместе с токеном"]]) {
      const group = documentElement("div", "form-group"), label = documentElement("label"), fields = documentElement("div", "form-fields");
      label.textContent = caption;
      const input = documentElement("input"); input.name = `flags.fallout-maw.tokenHitbox.${key}`;
      input.type = "checkbox"; input.checked = profile[key];
      fields.append(input); group.append(label, fields); hitbox.append(group);
    }
    const hint = documentElement("p", "hint");
    hint.textContent = "Область использует штатные ширину и высоту в клетках. Изображение может выступать за неё: его масштаб и якорь задаются в настройках текстуры.";
    hitbox.append(hint); speedRow.after(hitbox);
  };
  Hooks.on("renderTokenConfig", insert);
  Hooks.on("renderPrototypeTokenConfig", insert);
}

function documentElement(tag, className = "") {
  const element = globalThis.document.createElement(tag);
  if (className) element.className = className;
  return element;
}

function wrap(prototype, name, factory) {
  const original = prototype?.[name];
  if (typeof original !== "function" || original[PATCH]) return;
  const replacement = factory(original);
  Object.defineProperty(replacement, PATCH, { value: true });
  prototype[name] = replacement;
}
