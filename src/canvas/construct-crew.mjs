import { SYSTEM_ID } from "../constants.mjs";
import { canUserControlConstruct, hasConstructCrew, syncConstructPassengerOwnershipGrants } from "../utils/construct-crew.mjs";
import { getConstructCrewContext } from "../utils/construct-crew-context.mjs";
import { canUserUseConstructWeapon } from "../utils/construct-weapon-operator.mjs";
import { queueActorContainerOperation } from "./actor-containers.mjs";
import { registerNativeConstructCrewControls } from "./construct-crew-native-controls.mjs";
import { createKeyedOperationQueue } from "../utils/keyed-operation-queue.mjs";
const queueConstructControl = createKeyedOperationQueue();
function queueConstructCrewControl(payload, requester) {
  return queueConstructControl(String(payload.tokenUuid ?? ""), () => performConstructCrewControl(payload, requester));
}

const CHANNEL = `system.${SYSTEM_ID}`;
const SCOPE = `${SYSTEM_ID}.constructCrew`;
const TIMEOUT_MS = 15000;
const pendingRequests = new Map();
const handledRequests = new Map();
let actionHandlers = {};
let hooksRegistered = false;
let socketRegistered = false;

export function configureConstructCrewActions(handlers = {}) {
  actionHandlers = { ...actionHandlers, ...handlers };
}

export function getSelectedConstructCrewControlContext(tokenDocument, user = game.user) {
  return actionHandlers.getSelectedContext?.(tokenDocument, user)
    ?? getConstructCrewContext(tokenDocument?.actor, user);
}

export function registerConstructCrewSocket() {
  if (socketRegistered) return;
  socketRegistered = true;
  game.socket.on(CHANNEL, handleConstructCrewSocketMessage);
}

export function registerConstructCrewHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  const syncGrants = actor => {
    if (!game.user?.isGM || getResponsibleGM()?.id !== game.user.id || !hasConstructCrew(actor)) return;
    void queueActorContainerOperation(() => syncConstructPassengerOwnershipGrants(actor)).catch(error =>
      console.error(`${SYSTEM_ID} | Could not synchronize construct passenger ownership`, error));
  };
  const allConstructs = () => [...new Map([...(game.actors?.contents ?? []), ...(canvas?.tokens?.placeables ?? []).map(token => token.actor)]
    .filter(actor => hasConstructCrew(actor)).map(actor => [actor.uuid, actor])).values()];
  Hooks.on("updateActor", (actor, changes = {}) => {
    if (Object.hasOwn(changes, "ownership") || changes.flags?.[SYSTEM_ID]?.actorContainer
      || changes.flags?.[SYSTEM_ID]?.constructVisual) {
      if (hasConstructCrew(actor)) syncGrants(actor);
      else if (Object.hasOwn(changes, "ownership")) for (const construct of allConstructs()) syncGrants(construct);
    }
  });
  Hooks.on("canvasReady", () => {
    for (const actor of allConstructs()) syncGrants(actor);
  });
  Hooks.once("ready", () => {
    for (const actor of allConstructs()) syncGrants(actor);
  });
  registerNativeConstructCrewControls({ requestControl: requestConstructCrewControl,
    getSelectedContext: getSelectedConstructCrewControlContext });
  Hooks.on("preUpdateToken", (document, changes) => {
    if (!hasConstructCrew(document.actor) || game.user?.isGM) return;
    const passengerId = getSelectedConstructCrewControlContext(document)?.passenger.id ?? "";
    if ((Object.hasOwn(changes, "x") || Object.hasOwn(changes, "y") || Object.hasOwn(changes, "elevation"))
      && !canUserControlConstruct(document.actor, game.user, "move", { passengerId })) {
      ui.notifications.warn("Движением этого конструкта управляет персонаж на водительском месте.");
      return false;
    }
    if (Object.hasOwn(changes, "rotation") && !canUserControlConstruct(document.actor, game.user, "rotate", { passengerId })) {
      ui.notifications.warn("У вашего места нет функции поворота корпуса.");
      return false;
    }
  });
}

export async function requestConstructCrewControl(payload = {}) {
  const gm = getResponsibleGM();
  if (!gm) throw new Error("Для управления конструктом нужен активный GM.");
  if (game.user?.id === gm.id) return queueConstructCrewControl(payload, game.user);
  const requestId = foundry.utils.randomID();
  const promise = new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error("GM не ответил на запрос управления конструктом."));
    }, TIMEOUT_MS);
    pendingRequests.set(requestId, { resolve, reject, timeout, gmUserId: gm.id });
  });
  game.socket.emit(CHANNEL, { scope: SCOPE, type: "request", requestId,
    requesterUserId: game.user.id, gmUserId: gm.id, payload });
  return promise;
}

async function handleConstructCrewSocketMessage(message = {}, senderUserId = "") {
  if (message.scope !== SCOPE) return;
  const sender = game.users?.get(String(senderUserId ?? ""));
  if (!sender?.active) return;
  if (message.type === "response") {
    if (message.recipientUserId !== game.user?.id) return;
    const pending = pendingRequests.get(message.requestId);
    if (!pending || !sender.isGM || pending.gmUserId !== sender.id) return;
    globalThis.clearTimeout(pending.timeout);
    pendingRequests.delete(message.requestId);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error || "Запрос управления отклонён."));
    return;
  }
  if (message.type !== "request" || message.requesterUserId !== sender.id
    || !game.user?.isGM || message.gmUserId !== game.user.id || getResponsibleGM()?.id !== game.user.id) return;
  if (typeof message.requestId !== "string" || !message.requestId || message.requestId.length > 128) return;
  const key = `${sender.id}:${message.requestId}`;
  let response = handledRequests.get(key);
  if (!response) {
    response = queueConstructCrewControl(message.payload ?? {}, sender).then(
      result => ({ ok: true, result }), error => ({ ok: false, error: error.message })
    );
    handledRequests.set(key, response);
    if (handledRequests.size > 128) handledRequests.delete(handledRequests.keys().next().value);
  }
  game.socket.emit(CHANNEL, { scope: SCOPE, type: "response", requestId: message.requestId,
    recipientUserId: sender.id, ...await response });
}

async function performConstructCrewControl(payload, requester) {
  if (!game.user?.isGM || !requester?.active) throw new Error("Не удалось подтвердить пользователя управления.");
  const document = await globalThis.fromUuid?.(String(payload.tokenUuid ?? ""));
  const actor = document?.actor;
  const action = String(payload.action ?? "");
  if (document?.documentName !== "Token" || actor?.type !== "construct" || !hasConstructCrew(actor)) {
    throw new Error("Токен управляемого конструкта не найден.");
  }
  const partSlotId = String(payload.partSlotId ?? "").trim();
  const weapon = payload.weaponUuid ? await globalThis.fromUuid?.(String(payload.weaponUuid)) : null;
  if (payload.weaponUuid && !weapon) throw new Error("Оружие конструкта не найдено.");
  const authorized = ["aim", "rotationBudget", "fire", "reload"].includes(action) && weapon
    ? canUserUseConstructWeapon(actor, weapon, requester, action === "rotationBudget" ? "aim" : action, String(payload.weaponFunctionId ?? ""),
      { passengerId: String(payload.passengerId ?? ""), partSlotId })
    : canUserControlConstruct(actor, requester, action === "rotationBudget" ? "aim" : action, { partSlotId, weapon,
      passengerId: requester.isGM && ["move", "rotate"].includes(action) ? "" : String(payload.passengerId ?? "") });
  if (!authorized) {
    throw new Error("Место вашего персонажа не даёт это управление, либо его деталь повреждена.");
  }
  if (!requester.isGM && (game.paused || document.locked || document.hidden)) {
    throw new Error("Управление сейчас недоступно: игра приостановлена или токен заблокирован.");
  }
  if (action === "move") return moveConstruct(document, payload, requester);
  if (action === "rotate") {
    const delta = Number(payload.delta ?? 0);
    const angle = payload.rotation === undefined ? Number(document.rotation) + delta : Number(payload.rotation);
    const snap = Number(payload.snap ?? 0);
    if (![angle, delta, snap].every(Number.isFinite) || Math.abs(delta) > 180 || snap < 0 || snap > 360) throw new Error("Недопустимый угол поворота корпуса.");
    const rotation = ((snap > 0 ? Math.round(angle / snap) * snap : angle) % 360 + 360) % 360;
    if (Math.abs(((rotation - Number(document._source?.rotation ?? document.rotation) + 540) % 360) - 180) < 1e-6)
      return { ok: true, rotation, changed: false };
    const updated = await document.update({ rotation }, { falloutMawConstructCrewMovement: true });
    if (!updated) throw new Error("Поворот корпуса не выполнен: проверьте двигатель и доступную энергию.");
    return { ok: true, rotation };
  }
  if (action === "aim" || action === "rotationBudget") {
    const rotation = Number(payload.rotation);
    if (!partSlotId || !Number.isFinite(rotation)) throw new Error("Недопустимый угол наведения детали.");
    if (typeof actionHandlers.aim !== "function") throw new Error("Наведение детали ещё не подключено.");
    return actionHandlers.aim({ token: document.object, tokenDocument: document, actor, requester,
      partSlotId, rotation, payload, buyOnly: action === "rotationBudget" });
  }
  if (action === "fire") {
    if (!weapon || (weapon.actor?.uuid ?? weapon.parent?.uuid) !== actor.uuid) throw new Error("Оружие конструкта не найдено.");
    // Selection remains on the player's canvas. The ordinary attack GM handler
    // rechecks this permission after selection before spending any resources.
    return { ok: true, authorized: true, weaponUuid: weapon.uuid, partSlotId };
  }
  if (action === "reload") {
    if (!weapon || (weapon.actor?.uuid ?? weapon.parent?.uuid) !== actor.uuid) throw new Error("Оружие конструкта не найдено.");
    if (typeof actionHandlers.reload !== "function") throw new Error("Перезарядка экипажа ещё не подключена.");
    return actionHandlers.reload({ token: document.object, tokenDocument: document, actor, requester,
      partSlotId, weapon, weaponFunctionId: String(payload.weaponFunctionId ?? ""), passengerId: String(payload.passengerId ?? ""), payload });
  }
  throw new Error("Неизвестная функция места экипажа.");
}

async function moveConstruct(document, payload, requester) {
  const scene = document.parent;
  if (!canvas?.ready || canvas.scene?.id !== scene?.id || !document.object) {
    throw new Error("GM должен открыть сцену конструкта для проверки движения.");
  }
  let waypoints;
  if (payload.keyboard && payload.movementOptions?.method === "keyboard") {
    const { dx = 0, dy = 0, dz = 0 } = payload.keyboard;
    if (![dx, dy, dz].every(value => Number.isInteger(value) && Math.abs(value) <= 1) || (!dx && !dy && !dz))
      throw new Error("Перемещение должно быть одним шагом по сетке.");
    // Consecutive socket requests can be prepared before the previous commit
    // reaches the player's _source. Rebase each key on the latest native source.
    const [, options] = canvas.tokens._prepareKeyboardMovementUpdates([document.object], dx, dy, dz);
    waypoints = options.movement[document.id].waypoints;
  } else if (Array.isArray(payload.waypoints)) {
    if (!payload.waypoints.length || payload.waypoints.length > 256) throw new Error("Недопустимый маршрут движения.");
    let position = { x: document._source?.x ?? document.x, y: document._source?.y ?? document.y,
      elevation: document._source?.elevation ?? document.elevation };
    waypoints = payload.waypoints.map(raw => {
      const point = { x: raw?.x === undefined ? position.x : Number(raw.x), y: raw?.y === undefined ? position.y : Number(raw.y),
        elevation: raw?.elevation === undefined ? position.elevation : Number(raw.elevation),
        action: document.movementAction, explicit: Boolean(raw?.explicit), checkpoint: Boolean(raw?.checkpoint), snapped: Boolean(raw?.snapped) };
      if (![point.x, point.y, point.elevation].every(Number.isFinite)) throw new Error("Недопустимая точка маршрута.");
      position = point;
      return point;
    });
  } else {
    const dx = Number(payload.dx ?? 0), dy = Number(payload.dy ?? 0), dz = Number(payload.dz ?? 0);
    if (![dx, dy, dz].every(value => Number.isInteger(value) && Math.abs(value) <= 1) || (!dx && !dy && !dz)) {
      throw new Error("Перемещение должно быть одним шагом по сетке.");
    }
    const destination = document.object._getShiftedPosition(dx, dy, dz);
    waypoints = [{ ...destination, action: document.movementAction, explicit: false,
      snapped: !canvas.grid.isGridless, checkpoint: true }];
  }
  const size = document.getSize?.() ?? { width: Number(document.width) * canvas.grid.sizeX, height: Number(document.height) * canvas.grid.sizeY };
  const bounds = scene.dimensions?.sceneRect ?? canvas.dimensions?.sceneRect;
  if (bounds && waypoints.some(point => point.x < bounds.x || point.y < bounds.y
    || point.x + size.width > bounds.x + bounds.width || point.y + size.height > bounds.y + bounds.height)) {
    throw new Error("Конструкт не помещается в границы сцены.");
  }
  const movement = sanitizeNativeMovementOptions(payload.movementOptions ?? { method: payload.method }, requester);
  movement.waypoints = waypoints;
  // Match TokenLayer.moveMany and PlaceableObject's native drag commit. The
  // database commit releases authority; Foundry chains the animation itself.
  const updated = await scene.updateEmbeddedDocuments("Token", [{ _id: document.id }], {
    movement: { [document.id]: movement }, falloutMawConstructCrewMovement: !requester.isGM
  });
  return { ok: true, completed: updated.some(row => row.id === document.id),
    x: document._source?.x ?? document.x, y: document._source?.y ?? document.y,
    elevation: document._source?.elevation ?? document.elevation };
}

function sanitizeNativeMovementOptions(raw = {}, requester) {
  const method = ["keyboard", "dragging"].includes(raw.method) ? raw.method : "api";
  const result = { method };
  if (typeof raw.id === "string" && /^[a-zA-Z0-9]{16}$/.test(raw.id)) result.id = raw.id;
  for (const key of ["planned", "split", "showRuler", "autoRotate"])
    if (typeof raw[key] === "boolean") result[key] = raw[key];
  for (const key of ["terrainOptions", "measureOptions"])
    if (raw[key] && typeof raw[key] === "object" && !Array.isArray(raw[key]))
      result[key] = sanitizeMovementOptionRecord(raw[key]);
  result.constrainOptions = {};
  for (const key of ["maxCost", "maxDistance"]) {
    const value = raw.constrainOptions?.[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) result.constrainOptions[key] = value;
  }
  result.constrainOptions.ignoreWalls = Boolean(requester.isGM && raw.constrainOptions?.ignoreWalls);
  result.constrainOptions.ignoreCost = Boolean(requester.isGM && raw.constrainOptions?.ignoreCost);
  return result;
}

function sanitizeMovementOptionRecord(raw) {
  return Object.fromEntries(Object.entries(raw).slice(0, 32).filter(([key, value]) =>
    !["__proto__", "constructor", "prototype", "preview", "history", "ignoreWalls", "ignoreCost"].includes(key)
    && (typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)
      || typeof value === "string" && value.length <= 128)));
}

function getResponsibleGM() {
  return game.users?.activeGM ?? (game.users?.contents ?? []).filter(user => user.active && user.isGM)
    .sort((left, right) => left.id.localeCompare(right.id)).at(0) ?? null;
}

export const CONSTRUCT_CREW_TESTING = Object.freeze({ performControl: performConstructCrewControl,
  handleSocketMessage: handleConstructCrewSocketMessage });
