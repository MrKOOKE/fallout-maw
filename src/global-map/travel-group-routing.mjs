import { FALLOUT_MAW } from "../config/system-config.mjs";
import {
  GLOBAL_MAP_VERSION,
  LOCATION_ENTRY_MODES,
  TRAVEL_GROUP_FLAG
} from "./constants.mjs";
import { getGlobalMapFlag, normalizeLocationEntryMode } from "./storage.mjs";

export function createPendingArrival({
  transferId,
  groupId,
  locationId,
  entryMode,
  originSceneId,
  targetSceneId,
  requestedByUserId,
  deadline,
  originCellKeys = [],
  validExitZoneIds = []
} = {}) {
  const normalizedEntryMode = normalizeLocationEntryMode(entryMode);
  return {
    transferId: String(transferId ?? ""),
    groupId: String(groupId ?? ""),
    locationId: String(locationId ?? ""),
    entryMode: normalizedEntryMode,
    groupPreserved: normalizedEntryMode === LOCATION_ENTRY_MODES.CARRIER,
    direction: "descend",
    originSceneId: String(originSceneId ?? ""),
    targetSceneId: String(targetSceneId ?? ""),
    requestedByUserId: String(requestedByUserId ?? ""),
    deadline: Math.max(0, Number(deadline) || 0),
    originCellKeys: normalizeStringList(originCellKeys),
    validExitZoneIds: normalizeStringList(validExitZoneIds)
  };
}

function normalizeStringList(values = []) {
  return Array.from(new Set(
    (Array.isArray(values) ? values : [])
      .map(value => String(value ?? ""))
      .filter(Boolean)
  ));
}

export function buildTravelGroupRouteUpdate(actor, targetScene, transferId) {
  const path = `flags.${FALLOUT_MAW.id}.${TRAVEL_GROUP_FLAG}`;
  return {
    _id: actor?.id,
    [`${path}.version`]: GLOBAL_MAP_VERSION,
    [`${path}.currentSceneId`]: String(targetScene?.id ?? ""),
    [`${path}.currentNodeId`]: String(getGlobalMapFlag(targetScene)?.nodeId ?? ""),
    [`${path}.lastTransferId`]: String(transferId ?? "")
  };
}
