import { SYSTEM_ID } from "../constants.mjs";
import { normalizeConstructVisual } from "../utils/construct-visual-model.mjs";

const TRACK_IDS = ["mwtankFLft000001", "mwtankFRgt000001", "mwtankALft000001", "mwtankARgt000001"];
const TRACK_SLOTS = ["track-fore-left", "track-fore-right", "track-aft-left", "track-aft-right"];

/** Build an addressable migration. Runtime resources and passenger records are untouched. */
export function planModularTankProductionUpgrade(tank, data, library) {
  const raw = tank._source ?? tank;
  const items = tank.items?.contents ?? Array.from(tank.items ?? []);
  const legacy = data.legacyDefaults ?? {};
  const changes = {};
  const itemUpdates = [];
  const deleteIds = [];
  const originals = TRACK_IDS.map(id => items.find(item => (item.id ?? item._id) === id));
  const slots = structuredClone(raw.system?.constructPartSlots ?? tank.system?.constructPartSlots ?? []);
  const containedTracks = (raw.flags?.[SYSTEM_ID]?.constructInterior?.parts ?? [])
    .some(row => TRACK_SLOTS.includes(row.slotId) || TRACK_SLOTS.includes(row.parentSlotId));
  const mergeTracks = originals.every((item, index) => item && unchangedTrack(item,
    legacy.parts?.find(row => row._id === TRACK_IDS[index]))) && !containedTracks
    && TRACK_SLOTS.every(id => unchangedSlot(slots.find(row => row.id === id), legacy.slots?.find(row => row.id === id)));
  if (mergeTracks) {
    const template = data.tank.items.find(item => item.system?.placement?.limbKey === "chassis");
    const remainingFraction = originals.reduce((sum, item) => {
      const condition = item.system.functions.condition;
      return sum + Math.max(0, Math.min(1, Number(condition.value) / Number(condition.max)));
    }, 0) / originals.length;
    itemUpdates.push({ _id: TRACK_IDS[0], name: template.name, img: template.img,
      "system.description": template.system.description,
      "system.functions.freeSettings": structuredClone(template.system.functions.freeSettings),
      "system.functions.condition.value": Math.round(remainingFraction * Number(template.system.functions.condition.max)),
      "system.placement.limbKey": "chassis", "system.placement.constructPartOrder": 2,
      [`flags.${SYSTEM_ID}.modularTankDemo.mergedTracks`]: originals.map(item => ({
        itemId: item.id ?? item._id, slotId: item.system.placement.limbKey,
        condition: structuredClone(item.system.functions.condition)
      })) });
    deleteIds.push(...TRACK_IDS.slice(1));
    const chassisSlot = structuredClone(data.tank.system.constructPartSlots.find(row => row.id === "chassis"));
    changes["system.constructPartSlots"] = slots.flatMap(slot => slot.id === TRACK_SLOTS[0] ? [chassisSlot]
      : TRACK_SLOTS.includes(slot.id) ? [] : [{ ...slot, order: slot.order > 5 ? slot.order - 3 : slot.order }]);
  }
  for (const item of items) {
    const id = item.id ?? item._id;
    if (deleteIds.includes(id)) continue;
    const template = data.tank.items.find(row => row._id === id);
    const old = legacy.parts?.find(row => row._id === id);
    if (!template || !old || (TRACK_IDS.includes(id) && !mergeTracks)) continue;
    const update = itemUpdates.find(row => row._id === id) ?? { _id: id };
    if (item.name === old.name) update.name = template.name;
    if (item.img === old.img) update.img = template.img;
    if (item.system.description === old.system.description) update["system.description"] = template.system.description;
    if (mergeTracks && item.system.placement?.constructPartOrder === old.system.placement?.constructPartOrder) {
      update["system.placement.constructPartOrder"] = template.system.placement.constructPartOrder;
    }
    const slotId = template.system?.placement?.limbKey;
    const prototype = library?.parts?.get(slotId);
    if (prototype && !(item.flags?.[SYSTEM_ID]?.sourceId)) update[`flags.${SYSTEM_ID}.sourceId`] = prototype.uuid;
    if (!itemUpdates.includes(update) && Object.keys(update).length > 1) itemUpdates.push(update);
  }
  const hull = items.find(item => (item.id ?? item._id) === "mwtankHull000001");
  const seatSlots = hull?._source?.system?.functions?.actorContainer?.slots ?? hull?.system?.functions?.actorContainer?.slots;
  const passengers = raw.flags?.[SYSTEM_ID]?.actorContainer?.passengers ?? [];
  const crew = seatSlots?.find(row => row.id === "crew");
  if (crew?.width === 2 && crew?.height === 2 && crew.quantity === 4
    && passengers.filter(row => row.slotId === "mwtankHull000001:crew").every(row => Number(row.width ?? 1) <= 1 && Number(row.height ?? 1) <= 1)) {
    const update = itemUpdates.find(row => row._id === "mwtankHull000001") ?? { _id: "mwtankHull000001" };
    update["system.functions.actorContainer.slots"] = seatSlots.map(row => row.id === "crew" ? { ...row, width: 1, height: 1 } : row);
    if (!itemUpdates.includes(update)) itemUpdates.push(update);
  }
  // Profiles are labels/portraits of the installed part, not a second equipment definition.
  const finalSlots = changes["system.constructPartSlots"] ?? slots;
  for (const slot of finalSlots) {
    const old = legacy.slots?.find(row => row.id === slot.id);
    const template = data.tank.system.constructPartSlots.find(row => row.id === slot.id);
    if (!old || !template) continue;
    if (slot.profile?.name === old.profile?.name) slot.profile.name = template.profile.name;
    if (slot.profile?.img === old.profile?.img) slot.profile.img = template.profile.img;
    if (mergeTracks && slot.id === "turret") slot.order = 3;
    if (mergeTracks && slot.id === "cannons") slot.order = 4;
  }
  changes["system.constructPartSlots"] = finalSlots;
  if (raw.name === legacy.tankName) changes.name = data.tank.name;
  if (raw.img === legacy.tankImg) changes.img = data.tank.img;
  if (raw.prototypeToken?.name === legacy.tankName) changes["prototypeToken.name"] = data.tank.prototypeToken.name;
  if ([legacy.tankDescription, ...(legacy.tankDescriptions ?? [])].includes(raw.system?.description)) {
    changes["system.description"] = data.tank.system.description;
  }
  if (!tank.folder && library?.actorFolder) changes.folder = library.actorFolder.id;
  return { changes, itemUpdates, deleteIds, mergedTracks: mergeTracks,
    retainedLegacyParts: mergeTracks ? [] : originals.filter(Boolean).map(item => item.id ?? item._id) };
}

export function migrateTankVisualTrackReferences(visual, mergedTracks) {
  if (!mergedTracks) return visual;
  const remap = slotId => TRACK_SLOTS.includes(slotId) ? "chassis" : slotId;
  for (const part of visual.parts ?? []) part.slotId = remap(part.slotId);
  for (const anchor of visual.anchors ?? []) anchor.parentSlotId = remap(anchor.parentSlotId);
  for (const seat of visual.seats ?? []) seat.partSlotId = remap(seat.partSlotId);
  return visual;
}

/** Replace only the untouched stock four-image chassis from revision 3.
 * Optional model defaults may be absent in the saved source. Any actual custom
 * field, pose, artwork or interleaved layer preserves the existing assembly.
 */
export function consolidateTankChassisVisual(visual, data) {
  const defaults = data.legacyDefaults?.chassisVisualLayers ?? [];
  const replacement = data.tank.flags?.[SYSTEM_ID]?.constructVisual?.parts?.find(part => part.id === "chassis-image");
  const parts = visual?.parts;
  if (defaults.length !== 4 || !replacement || !Array.isArray(parts)
    || parts.some(part => part.id === replacement.id)) return false;
  const ids = new Set(defaults.map(part => part.id));
  const originals = parts.filter(part => ids.has(part.id));
  if (originals.length !== 4 || new Set(originals.map(part => part.id)).size !== 4) return false;
  const expected = normalizeConstructVisual({ ...data.tank.flags[SYSTEM_ID].constructVisual, parts: defaults }).parts;
  const current = normalizeConstructVisual({ ...visual, parts: originals }).parts;
  if (expected.length !== 4 || !originals.every(part => {
    const template = expected.find(entry => entry.id === part.id);
    return template && equal(current.find(entry => entry.id === part.id), template)
      && Object.keys(part).filter(key => part[key] !== undefined)
      .every(key => Object.hasOwn(template, key) && equal(part[key], template[key]));
  })) return false;
  // A custom layer drawn between the four stock pieces would change stacking
  // when those pieces become one image, so leave that composition intact.
  const low = Math.min(...defaults.map(part => part.zIndex));
  const high = Math.max(...defaults.map(part => part.zIndex));
  if (normalizeConstructVisual(visual).parts.some(part => !ids.has(part.id)
    && part.zIndex >= low && part.zIndex <= high)) return false;
  const first = parts.findIndex(part => ids.has(part.id));
  visual.parts = parts.flatMap((part, index) => index === first ? [structuredClone(replacement)]
    : ids.has(part.id) ? [] : [part]);
  return true;
}

function unchangedTrack(item, template) {
  if (!template) return false;
  const source = item._source ?? item;
  const current = structuredClone(source.system ?? item.system);
  const expected = structuredClone(template.system);
  delete current.functions?.condition?.value;
  delete expected.functions?.condition?.value;
  return source.name === template.name && source.img === template.img && equal(current, expected)
    && !(source.effects?.length) && !Object.keys(source.flags ?? {}).length;
}

function unchangedSlot(current, expected) { return Boolean(current && expected && equal(current, expected)); }
function equal(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && a.length !== b.length) return false;
  // Foundry's live DataModels expose optional undefined fields which disappear
  // from their saved JSON; absence and undefined describe the same source value.
  const keys = Object.keys(a).filter(key => a[key] !== undefined);
  const otherKeys = Object.keys(b).filter(key => b[key] !== undefined);
  return keys.length === otherKeys.length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
}
