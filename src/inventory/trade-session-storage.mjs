import { SYSTEM_ID } from "../constants.mjs";

export const COMPLETED_TRADE_SESSIONS_SETTING = "completedTradeSessions";
let writeQueue = Promise.resolve();

export function registerCompletedTradeSessionStorage() {
  game.settings.register(SYSTEM_ID, COMPLETED_TRADE_SESSIONS_SETTING, {
    scope: "world", config: false, type: Object, default: {}
  });
}

export function readCompletedTradeSessions() {
  const stored = game.settings.get(SYSTEM_ID, COMPLETED_TRADE_SESSIONS_SETTING);
  return stored && typeof stored === "object" && !Array.isArray(stored)
    ? foundry.utils.deepClone(stored) : {};
}

/** Serialize the read as well as the write: different sessions share one world Setting. */
export function persistCompletedTradeSession(session) {
  const snapshot = foundry.utils.deepClone(session);
  if (!snapshot?.sessionId) return Promise.resolve();
  const next = writeQueue.catch(() => undefined).then(async () => {
    const stored = readCompletedTradeSessions();
    if (snapshot.offers?.completed) stored[snapshot.sessionId] = snapshot;
    else {
      if (!Object.hasOwn(stored, snapshot.sessionId)) return;
      delete stored[snapshot.sessionId];
    }
    await game.settings.set(SYSTEM_ID, COMPLETED_TRADE_SESSIONS_SETTING, stored);
  });
  writeQueue = next;
  return next;
}
