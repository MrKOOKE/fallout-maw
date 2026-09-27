// Local UI preferences belong to a world/user/Actor, not to shared Actor data.
const stateCache = new Map();
const PREFIX = "fallout-maw.craft-window.v1:";

function stateKey(actorUuid) {
  if (!actorUuid) return null;
  return PREFIX + JSON.stringify([globalThis.game?.world?.id ?? "", globalThis.game?.user?.id ?? "", actorUuid]);
}

export function readCraftWindowState(actorUuid) {
  const key = stateKey(actorUuid);
  if (!key) return null;
  let raw = stateCache.get(key);
  if (!raw) {
    try { raw = globalThis.localStorage?.getItem(key); }
    catch { /* Restricted browser storage still permits session-local memory. */ }
  }
  if (!raw) return null;
  try {
    const state = JSON.parse(raw);
    if (state?.version !== 1 || !Array.isArray(state.tabs)) return null;
    const ids = new Set();
    state.tabs = state.tabs.filter(tab => {
      if (!tab || typeof tab !== "object" || typeof tab.id !== "string" || !tab.id || ids.has(tab.id)) return false;
      ids.add(tab.id);
      return true;
    });
    if (!state.tabs.length) return null;
    for (const field of ["craftToolSelections", "bulkEntries", "scrollPositions"]) {
      state[field] = Array.isArray(state[field])
        ? state[field].filter(entry => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string")
        : [];
    }
    return state;
  } catch { return null; }
}

export function writeCraftWindowState(actorUuid, state) {
  const key = stateKey(actorUuid);
  if (!key) return;
  const raw = JSON.stringify({ ...state, version: 1 });
  stateCache.set(key, raw);
  try { globalThis.localStorage?.setItem(key, raw); }
  catch { /* A full/disabled browser store must not break crafting or closing. */ }
}
