import { SYSTEM_ID } from "../constants.mjs";
import {
  BLOCK_TURN_ACTOR_OPTION,
  BLOCK_TURN_COMBATANT_OPTION
} from "./turn-order-blocks.mjs";

const COMBAT_TURN_SOCKET = `system.${SYSTEM_ID}`;
export const COMBAT_TURN_SOCKET_SCOPE = "fallout-maw.combatTurnNavigation";
const COMBAT_TURN_REQUEST_TIMEOUT_MS = 60 * 1000;
const ALLOWED_METHODS = new Set([
  "startCombat",
  "nextTurn",
  "previousTurn",
  "nextRound",
  "previousRound",
  "setTurn",
  "delete"
]);
const PLAYER_METHODS = new Set(["nextTurn", "previousTurn"]);
const CONVERSION_MODES = new Set(["dodge", "reaction", "none", "skip"]);
const pendingRequests = new Map();
let socketRegistered = false;

export function registerCombatTurnNavigationSocket() {
  if (socketRegistered) return;
  game.socket?.on?.(COMBAT_TURN_SOCKET, handleCombatTurnNavigationSocketMessage);
  socketRegistered = true;
}

export function requestCombatTurnNavigation(combat, method, {
  turn = null,
  options = {}
} = {}) {
  const normalizedMethod = normalizeMethod(method);
  if (!combat?.id || !normalizedMethod) {
    return Promise.reject(new Error("Invalid combat turn request."));
  }
  const activeGM = game.users?.activeGM;
  if (!activeGM?.id) {
    return Promise.reject(new Error("No active GM is available for combat navigation."));
  }
  registerCombatTurnNavigationSocket();

  const requestId = foundry.utils.randomID();
  const request = {
    scope: COMBAT_TURN_SOCKET_SCOPE,
    type: "request",
    requestId,
    targetUserId: activeGM.id,
    requesterUserId: game.user?.id ?? "",
    combatId: combat.id,
    method: normalizedMethod,
    turn: Number.isInteger(turn) ? turn : null,
    options: sanitizeTurnOptions(options)
  };
  const promise = new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error("The active GM did not answer the combat turn request."));
    }, COMBAT_TURN_REQUEST_TIMEOUT_MS);
    timeout?.unref?.();
    pendingRequests.set(requestId, {
      resolve,
      reject,
      timeout,
      expectedAuthorityUserId: activeGM.id
    });
  });
  game.socket.emit(COMBAT_TURN_SOCKET, request);
  return promise;
}

async function handleCombatTurnNavigationSocketMessage(message = {}) {
  if (message?.scope !== COMBAT_TURN_SOCKET_SCOPE) return;
  if (message.type === "response") {
    if (message.targetUserId !== game.user?.id) return;
    const pending = pendingRequests.get(message.requestId);
    if (!pending) return;
    if (message.authorityUserId !== pending.expectedAuthorityUserId) return;
    if (game.users?.activeGM?.id !== pending.expectedAuthorityUserId) {
      globalThis.clearTimeout(pending.timeout);
      pendingRequests.delete(message.requestId);
      pending.reject(new Error("Combat authority changed; re-check the current turn state."));
      return;
    }
    globalThis.clearTimeout(pending.timeout);
    pendingRequests.delete(message.requestId);
    if (message.ok) pending.resolve(true);
    else pending.reject(new Error(message.error || "Combat turn request failed."));
    return;
  }

  if (
    message.type !== "request"
    || message.targetUserId !== game.user?.id
    || !isCurrentActiveGM()
  ) return;

  try {
    await performCombatTurnNavigationRequest(message);
    sendResponse(message, { ok: true });
  } catch (error) {
    sendResponse(message, {
      ok: false,
      error: error?.message ?? String(error)
    });
  }
}

export async function performCombatTurnNavigationRequest(message = {}) {
  if (!isCurrentActiveGM()) throw new Error("Combat authority changed.");
  const method = normalizeMethod(message.method);
  if (!method) throw new Error("Unsupported combat turn operation.");
  const combat = game.combats?.get?.(message.combatId);
  if (!combat) throw new Error("Combat not found.");
  const requester = game.users?.get?.(message.requesterUserId);
  assertRequesterMayNavigateCombat(requester, combat, method);

  const options = sanitizeTurnOptions(message.options);
  if (method === "setTurn") {
    if (!Number.isInteger(message.turn)) throw new Error("Invalid target turn.");
    await combat.setTurn(message.turn, options);
  } else if (method === "delete") {
    const deleted = await combat.delete(options);
    if (!deleted) throw new Error("Combat deletion was cancelled.");
  } else {
    await combat[method](options);
  }
  return true;
}

function assertRequesterMayNavigateCombat(requester, combat, method) {
  if (!requester) throw new Error("Combat requester not found.");
  if (requester.isGM) return;
  if (!PLAYER_METHODS.has(method)) {
    throw new Error("Only a GM may perform this combat operation.");
  }

  const actor = combat.combatant?.actor;
  if (!actor?.testUserPermission?.(requester, "OWNER")) {
    throw new Error("The requester does not own the active combatant.");
  }
  if (typeof combat.canUserModify === "function") {
    const usesTurnPermission = Number.isInteger(combat.turn)
      && combat.turn > 0
      && combat.turn < (combat.turns?.length ?? 0) - 1;
    const change = usesTurnPermission ? { turn: 0 } : { round: 0 };
    if (!combat.canUserModify(requester, "update", change)) {
      throw new Error("The requester cannot update this combat.");
    }
  }
}

function sendResponse(request, response) {
  game.socket?.emit?.(COMBAT_TURN_SOCKET, {
    scope: COMBAT_TURN_SOCKET_SCOPE,
    type: "response",
    requestId: request.requestId,
    targetUserId: request.requesterUserId,
    authorityUserId: game.user?.id ?? "",
    ...response
  });
}

function sanitizeTurnOptions(options = {}) {
  const source = options && typeof options === "object" ? options : {};
  const conversionMode = String(source.falloutMawConversionMode ?? "");
  const combatantId = String(source[BLOCK_TURN_COMBATANT_OPTION] ?? "").trim();
  const actorUuid = String(source[BLOCK_TURN_ACTOR_OPTION] ?? "").trim();
  return {
    ...(CONVERSION_MODES.has(conversionMode)
      ? { falloutMawConversionMode: conversionMode }
      : {}),
    ...(combatantId ? { [BLOCK_TURN_COMBATANT_OPTION]: combatantId } : {}),
    ...(actorUuid ? { [BLOCK_TURN_ACTOR_OPTION]: actorUuid } : {})
  };
}

function normalizeMethod(method) {
  const value = String(method ?? "");
  return ALLOWED_METHODS.has(value) ? value : "";
}

function isCurrentActiveGM() {
  return Boolean(
    game.user?.isActiveGM
    && game.users?.activeGM?.id === game.user.id
  );
}
