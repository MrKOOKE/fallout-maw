import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

globalThis.foundry = {
  applications: {
    api: { DialogV2: {} },
    ux: { FormDataExtended: class {} },
    handlebars: { renderTemplate: async () => "" }
  },
  utils: {
    deepClone: value => value === undefined ? undefined : structuredClone(value),
    fromUuid: async uuid => game.actors.get(String(uuid).replace(/^Actor\./, "")),
    randomID: () => "generated-id"
  }
};

const {
  GLOBAL_MAP_FLAG,
  GLOBAL_MAP_VERSION,
  LOCATION_ENTRY_MODES
} = await import("../src/global-map/constants.mjs");
const { resolveTravelGroupParticipants } = await import("../src/global-map/travel-group-data.mjs");
const {
  buildTravelGroupRouteUpdate,
  createPendingArrival
} = await import("../src/global-map/travel-group-routing.mjs");

test("pending arrival snapshots carrier/deploy behavior for the whole transfer", () => {
  const carrierPending = createPendingArrival({
    transferId: "down-1",
    groupId: "group-a",
    locationId: "regional",
    entryMode: LOCATION_ENTRY_MODES.CARRIER,
    originSceneId: "root",
    targetSceneId: "regional-scene",
    requestedByUserId: "player-a",
    deadline: 12345,
    originCellKeys: ["4,5", "4,5", "5,5"],
    validExitZoneIds: ["north", "north", "south"]
  });
  assert.deepEqual(carrierPending, {
    transferId: "down-1",
    groupId: "group-a",
    locationId: "regional",
    entryMode: LOCATION_ENTRY_MODES.CARRIER,
    groupPreserved: true,
    direction: "descend",
    originSceneId: "root",
    targetSceneId: "regional-scene",
    requestedByUserId: "player-a",
    deadline: 12345,
    originCellKeys: ["4,5", "5,5"],
    validExitZoneIds: ["north", "south"]
  });

  const invalidPending = createPendingArrival({ entryMode: "automatic" });
  assert.equal(invalidPending.entryMode, LOCATION_ENTRY_MODES.DEPLOY);
  assert.equal(invalidPending.groupPreserved, false);
  assert.equal(carrierPending.entryMode, LOCATION_ENTRY_MODES.CARRIER, "later marker edits must not mutate a started transfer");
});

test("the same carrier Actor route advances through submaps without changing its identity", () => {
  const actor = { id: "carrier-actor" };
  const regional = scene("regional-scene", "regional-node");
  const local = scene("local-scene", "local-node");
  const first = buildTravelGroupRouteUpdate(actor, regional, "down-1");
  const second = buildTravelGroupRouteUpdate(actor, local, "down-2");

  assert.equal(first._id, actor.id);
  assert.equal(second._id, actor.id);
  assert.equal(first["flags.fallout-maw.travelGroup.currentSceneId"], regional.id);
  assert.equal(first["flags.fallout-maw.travelGroup.currentNodeId"], "regional-node");
  assert.equal(second["flags.fallout-maw.travelGroup.currentSceneId"], local.id);
  assert.equal(second["flags.fallout-maw.travelGroup.currentNodeId"], "local-node");
  assert.equal(second["flags.fallout-maw.travelGroup.lastTransferId"], "down-2");
  assert.equal(second["flags.fallout-maw.travelGroup.version"], GLOBAL_MAP_VERSION);
});

test("travel-group participants include vehicle passengers nested inside other passengers", async () => {
  const nested = actor("nested");
  const passenger = actor("passenger");
  const vehicle = actor("vehicle");
  const unlinkedPassenger = passengerData("passenger");
  unlinkedPassenger.tokenData.actorLink = false;
  unlinkedPassenger.tokenData.delta = {
    flags: {
      "fallout-maw": {
        actorContainer: { passengers: [passengerData("nested")] }
      }
    }
  };
  const carrier = actor("carrier", [], {
    travelGroup: {
      groupId: "group-a",
      units: [{
        id: "vehicle-unit",
        actorUuid: vehicle.uuid,
        tokenData: { actorId: vehicle.id, actorLink: true },
        actorContainer: {
          seats: [{ id: "seat" }],
          passengers: [unlinkedPassenger]
        }
      }]
    }
  });
  const actors = new Map([vehicle, passenger, nested, carrier].map(entry => [entry.id, entry]));
  actors.contents = Array.from(actors.values());
  globalThis.game = { actors };

  const resolved = await resolveTravelGroupParticipants(carrier);
  assert.deepEqual(resolved.map(entry => entry.actorUuid), [vehicle.uuid, passenger.uuid, nested.uuid]);
});

test("preserved carrier workflows emit travel events without group lifecycle churn", async () => {
  const source = await readFile(new URL("../src/global-map/travel-groups.mjs", import.meta.url), "utf8");
  const descent = source.slice(
    source.indexOf("async function performCarrierArrivalInRoot"),
    source.indexOf("function prepareTravelGroupUnitForStorage")
  );
  const ascent = source.slice(
    source.indexOf("async function performCarrierDepartureInRoot"),
    source.indexOf("async function performDeparture(args)")
  );
  for (const [workflow, required] of [
    [descent, ["arrival.before", "location.entered", "arrival.completed"]],
    [ascent, ["departure.before", "location.left", "departure.completed"]]
  ]) {
    for (const key of required) assert.match(workflow, new RegExp(`fallout-maw\\.travel\\.${key.replace(".", "\\.")}`));
    assert.doesNotMatch(workflow, /travel\.group\.(?:formed|memberJoined|memberLeft|disbanded)/);
    assert.match(workflow, /groupPreserved:\s*true/);
    assert.match(workflow, /transferTokensBetweenScenes/);
  }
});

test("generic map transitions batch carrier route flags and restore its control for every viewer", async () => {
  const source = await readFile(new URL("../src/global-map/travel.mjs", import.meta.url), "utf8");
  const transfer = source.slice(
    source.indexOf("async function performTravelNow"),
    source.indexOf("function restoreTransferredTokenControls")
  );
  assert.match(transfer, /actorUpdates/);
  assert.match(transfer, /buildTravelGroupRouteUpdate/);
  assert.match(transfer, /getTravelGroupViewerUserIds/);
  assert.match(transfer, /controlTokenIds/);
  assert.match(source, /token\.control\?\.\(\{ releaseOthers:/);
  assert.match(source, /const \{ target, entryMode, groupPreserved \} = record/);
  assert.match(source, /canvas\.loading[\s\S]*?queueTravelViewRetry/);
  assert.match(source, /canvasReady[\s\S]*?runAfterCanvasSettles[\s\S]*?completeTravelForCurrentViewer/);
  assert.match(source, /if \(canvas\.loading\)[\s\S]*?setTimeout\(attempt, 16\)/);
  assert.match(source, /carrierTokens\.length && !targetScene\.active/);
  assert.match(source, /targetScene\.activate\(\)/);
});

test("carrier placement is confined to the selected zone including its whole footprint", async () => {
  const source = await readFile(new URL("../src/global-map/travel-groups.mjs", import.meta.url), "utf8");
  const placement = source.slice(
    source.indexOf("function findFreePlacement"),
    source.indexOf("function getPlacementBounds")
  );
  const carrierValidation = source.slice(
    source.indexOf("function canPlaceTravelCarrier"),
    source.indexOf("function uniqueActorParticipants")
  );
  assert.match(placement, /strictPreferredCells/);
  assert.match(placement, /getOccupiedGridSpaceOffsets/);
  assert.match(placement, /allowedCellKeys\.has\(cellKey\(offset\)\)/);
  assert.match(placement, /if \(!strictPreferredCells\)/, "strict placement must not expand beyond preferred cells");
  assert.match(carrierValidation, /strictPreferredCells:\s*true/);
  assert.match(source, /performCarrierArrivalInRoot[\s\S]*?strictPreferredCells:\s*true/);
  assert.match(source, /performCarrierDepartureInRoot[\s\S]*?strictPreferredCells:\s*true/);
});

test("arrival selection views an already-active target and cannot reopen after another client completes it", async () => {
  const travelGroups = await readFile(new URL("../src/global-map/travel-groups.mjs", import.meta.url), "utf8");
  const layer = await readFile(new URL("../src/global-map/layer.mjs", import.meta.url), "utf8");
  const opener = travelGroups.slice(
    travelGroups.indexOf("async function openArrivalSelection"),
    travelGroups.indexOf("function queueArrivalSelection")
  );
  assert.match(opener, /targetScene\.view\(\)/);
  assert.match(opener, /canvas\.loading[\s\S]*?queueArrivalView/);
  assert.match(travelGroups, /travelGroup\.arrival\.open[\s\S]*?await openArrivalSelection\(payload\)/);
  assert.match(layer, /completedArrivalTransferIds\.has\(selection\.transferId\)/);
  assert.match(layer, /pending\?\.transferId === selection\.transferId/);
  assert.match(travelGroups, /completeArrivalSelection\(groupId, transferId\)/);
  assert.match(travelGroups, /completeTravelNotificationForCurrentViewer/);
  assert.match(travelGroups, /completeTravelNotificationForCurrentViewer[\s\S]*?targetScene\.view\(\)/);
  assert.match(travelGroups, /originCellKeys/);
  assert.match(travelGroups, /snapshotCellKeys\.includes\(key\)/);
  assert.match(travelGroups, /reopenPendingArrivalSelection/);
  assert.match(travelGroups, /allowedZoneIds\.has\(String\(zone\.id\)\)/);
  assert.match(travelGroups, /collectTravelActors\(activeModel\.members\)/);
  assert.match(travelGroups, /getTravelPassengerChildren\(passenger, actor\)/);
  assert.match(travelGroups, /canvasReady[\s\S]*?runAfterCanvasSettles/);
  assert.match(travelGroups, /if \(canvas\.loading\)[\s\S]*?setTimeout\(attempt, 16\)/);
});

test("location labels render directly below Foundry's Token Layer", async () => {
  const source = await readFile(new URL("../src/global-map/layer.mjs", import.meta.url), "utf8");
  const overlay = source.slice(
    source.indexOf("  #drawDiscoveredLocationOverlay("),
    source.indexOf("  #drawLocationOverlayEntry(")
  );
  assert.match(overlay, /const tokenLayerZ = canvas\.tokens\?\.getZIndex\?\.\(\)/);
  assert.match(overlay, /overlay\.zIndex = tokenLayerZ - 1/);
  assert.doesNotMatch(overlay, /zIndexDrawings/);
});

test("carrier return prompt names the parent Scene without map-level terminology", async () => {
  const source = await readFile(new URL("../src/global-map/travel-groups.mjs", import.meta.url), "utf8");
  const prompt = source.slice(
    source.indexOf("export async function promptLocationExit"),
    source.indexOf("export async function promptLocationEntry")
  );
  assert.match(prompt, /getGlobalMapFlag\(scene\)\?\.parentSceneId/);
  assert.match(prompt, /parentScene\?\.name/);
  assert.match(prompt, /`Вернуться \$\{returnDestination\}`/);
  assert.match(prompt, /`на «\$\{parentSceneName\}»`/);
  assert.match(prompt, /Вернуться \$\{returnDestinationHtml\} всей путешествующей группой/);
  assert.match(prompt, /fa-arrow-left/);
  assert.doesNotMatch(prompt, /fa-arrow-up/);
  assert.doesNotMatch(prompt, /карт[ауы] выше/i);
});

test("arrival retries get a fresh event root while keeping their transfer identity", async () => {
  const source = await readFile(new URL("../src/global-map/travel-groups.mjs", import.meta.url), "utf8");
  const arrival = source.slice(
    source.indexOf("async function performArrival"),
    source.indexOf("async function performDeployArrivalInRoot")
  );
  assert.match(arrival, /const attemptId = foundry\.utils\.randomID\(\)/);
  assert.match(arrival, /operationId: `travel-arrival:\$\{request\.transferId\}:\$\{attemptId\}`/);
  assert.match(arrival, /transferId: String\(pending\?\.transferId/);
});

test("pending arrivals retain a timer across fallible UI and temporarily missing destinations", async () => {
  const source = await readFile(new URL("../src/global-map/travel-groups.mjs", import.meta.url), "utf8");
  const request = source.slice(
    source.indexOf("async function handleArrivalRequest"),
    source.indexOf("async function handleArrivalSelectRequest")
  );
  assert.ok(
    request.indexOf("scheduleArrivalTimer(originScene.id, token.id, pending.deadline)")
      < request.indexOf("await targetScene.activate()"),
    "the retry timer must be scheduled before Scene activation or selection UI"
  );
  assert.match(source, /queueResumeArrivalTimers\(\)[\s\S]*?queueResponsibleGMTask\(resumeArrivalTimers\)/);
  const timeout = source.slice(
    source.indexOf("async function chooseRandomArrival"),
    source.indexOf("async function postponePendingArrival")
  );
  assert.match(timeout, /if \(!targetScene\)[\s\S]*?await postponePendingArrival\(originScene, token, pending\)/);
});

function scene(id, nodeId) {
  return {
    id,
    getFlag: (namespace, key) => namespace === "fallout-maw" && key === GLOBAL_MAP_FLAG ? { nodeId } : null
  };
}

function actor(id, passengers = [], extraFlags = {}) {
  const flags = {
    actorContainer: { passengers },
    ...extraFlags
  };
  return {
    id,
    uuid: `Actor.${id}`,
    name: id,
    getFlag: (namespace, key) => namespace === "fallout-maw" ? flags[key] ?? null : null
  };
}

function passengerData(actorId) {
  return {
    id: `passenger-${actorId}`,
    actorUuid: `Actor.${actorId}`,
    actorName: actorId,
    slotId: "seat",
    slotIndex: 0,
    tokenData: { actorId, actorLink: true }
  };
}
