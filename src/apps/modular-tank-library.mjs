import { SYSTEM_ID } from "../constants.mjs";
import { equalTankSources, getActiveTankFunctionProfiles } from "./modular-tank-gun-upgrade.mjs";
import { stripLegacyTankResourceContribution } from "./modular-tank-systems-upgrade.mjs";

/** Deliver real, reusable world prototypes independently of optional crew/scenes. */
export async function ensureModularTankLibrary(data, { created = [] } = {}) {
  const documents = [];
  const partsFolder = await ensureFolder("Item", data.library?.partsFolder, created);
  const actorFolder = await ensureFolder("Actor", data.library?.actorFolder, created);
  const legacyShell = findPrototype(data, "shell");
  const nativeShell = game.items?.get?.(data.library?.nativeShellId);
  // The selected native ammunition is reusable as-is; it needs neither package
  // flags nor a duplicate world item. Other worlds receive the portable source.
  const shell = nativeShell && equalTankSources(
    getActiveTankFunctionProfiles(nativeShell._source?.system?.functions ?? nativeShell.system?.functions),
    getActiveTankFunctionProfiles(data.shell.system.functions))
    && nativeShell.name === data.shell.name && nativeShell.img === data.shell.img
    ? nativeShell
    : await ensurePrototype(data, data.library?.nativeShellId ? "cannon-ammo" : "shell", data.shell,
      await ensureFolder("Item", data.library?.shellFolder, created), created,
      data.legacyDefaults?.shellName, data.legacyDefaults?.shellDescription);
  documents.push(shell);
  const fuel = data.fuel ? game.items?.get?.(data.library?.nativeFuelId)
    ?? await ensurePrototype(data, "fuel", data.fuel, await ensureFolder("Item", data.library?.fuelFolder, created), created) : null;
  if (fuel) documents.push(fuel);
  if (legacyShell && legacyShell !== shell) {
    const changes = planModularTankPrototypeUpgrade(legacyShell, data, "shell", legacyShell._source ?? legacyShell);
    if (Object.keys(changes).length) await legacyShell.update(changes);
  }
  const personalAmmo = data.personalAmmo ? await ensurePrototype(data, "personal-ammo", data.personalAmmo,
    await ensureFolder("Item", data.library?.personalAmmoFolder, created), created,
    data.legacyDefaults?.personalAmmoName) : null;
  if (personalAmmo) documents.push(personalAmmo);
  const replacements = new Map([[data.shellUuidPlaceholder, shell.uuid],
    [data.fuelUuidPlaceholder, fuel?.uuid],
    [data.personalAmmoUuidPlaceholder, personalAmmo?.uuid]]);
  const parts = new Map();
  for (const entry of data.library?.parts ?? []) {
    const part = await ensurePrototype(data, entry.kind, replaceTankReferences(entry.source, replacements), partsFolder, created,
      "", "", entry.legacyKind);
    parts.set(entry.kind.replace(/^part:/, ""), part);
    documents.push(part);
  }
  if (data.library?.personalWeapon) documents.push(await ensurePrototype(data, "personal-weapon-prototype",
    replaceTankReferences(data.library.personalWeapon, replacements),
    await ensureFolder("Item", data.library.personalWeaponFolder, created), created));
  return { shell, legacyShell, fuel, personalAmmo, parts, actorFolder, documents };
}

export function replaceTankReferences(value, replacements) {
  if (typeof value === "string" && replacements.has(value) && replacements.get(value)) return replacements.get(value);
  if (Array.isArray(value)) return value.map(entry => replaceTankReferences(entry, replacements));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .map(([key, entry]) => [key, replaceTankReferences(entry, replacements)]));
  return value;
}

function findPrototype(data, kind) {
  return (game.items?.contents ?? []).find(item => {
    const marker = item.getFlag?.(SYSTEM_ID, "modularTankDemo") ?? item.flags?.[SYSTEM_ID]?.modularTankDemo;
    return marker?.packageId === data.packageId && marker.kind === kind;
  });
}

/** Same addressable metadata/statistics plan is used by live and offline delivery. */
export function planModularTankPrototypeUpgrade(existing, data, kind, source, folder = null,
  { legacyName = "", legacyDescription = "" } = {}) {
  const raw = existing._source ?? existing;
  const marker = raw.flags?.[SYSTEM_ID]?.modularTankDemo;
  if ((Number(marker?.revision) || 0) >= Number(data.revision) && marker?.kind === kind) return {};
  const changes = { [`flags.${SYSTEM_ID}.modularTankDemo.revision`]: data.revision,
    [`flags.${SYSTEM_ID}.modularTankDemo.kind`]: kind };
  if (Number(data.revision) >= 7 && ["part:engine", "part:chassis"].includes(kind)) {
    changes["system.functions.constructPart.systems"] = structuredClone(source.system.functions.constructPart.systems);
    changes["system.functions.freeSettings"] = stripLegacyTankResourceContribution(raw, kind.slice(5));
  }
  if (Number(data.revision) >= 6) {
    if (kind.startsWith("part:")) {
      changes.name = source.name;
      changes["system.description"] = source.system.description;
    }
    if (typeof raw.system?.description === "string" && raw.system.description.includes("Fallout Tank"))
      changes["system.description"] = raw.system.description.replaceAll("Fallout Tank", "Покоритель");
    if (kind === "part:cannons") {
      const previous = data.legacyDefaults?.cannonPrototypeBeforeRevision5;
      if (previous && equalTankSources(raw.system, previous.system) && equalTankSources(raw.effects ?? [], previous.effects ?? [])) {
        changes.system = structuredClone(source.system);
      } else {
        Object.assign(changes, {
          "system.functions.weapon.magazine.max": 2,
          "system.functions.weapon.magazine.value": Math.min(2, Number(raw.system?.functions?.weapon?.magazine?.value) || 0),
          "system.functions.weapon.muzzleAnchorId": "muzzle-center", "system.functions.weapon.operatorPartSlotId": "turret",
          "system.functions.weapon.availableActions.volley": true, "system.functions.weapon.availableActions.burst": true,
          "system.functions.weapon.availableActions.snapshot": false, "system.functions.weapon.availableActions.aimedShot": false,
          "system.functions.weapon.burst.count": 2, "system.functions.weapon.burst.name": "Очередь",
          "system.functions.weapon.volley.name": "Залп"
        });
      }
    }
  }
  const previousCannon = data.legacyDefaults?.cannonPrototypeBeforeRevision5;
  if (kind === "part:cannon-left" && marker?.kind === "part:cannons" && previousCannon) {
    if (equalTankSources(raw.system, previousCannon.system) && equalTankSources(raw.effects ?? [], previousCannon.effects ?? [])) {
      changes.system = structuredClone(source.system);
      if (raw.name === previousCannon.name) changes.name = source.name;
      if (raw.img === previousCannon.img) changes.img = source.img;
    } else {
      if (raw.name === previousCannon.name) changes.name = source.name;
      changes["system.functions.weapon.muzzleAnchorId"] = "muzzle-left";
      changes["system.functions.weapon.operatorPartSlotId"] = "turret";
    }
  }
  if (legacyName && raw.name === legacyName) {
    changes.name = source.name;
    if (raw.system?.functions?.damageSource?.name === legacyName) changes["system.functions.damageSource.name"] = source.name;
  }
  if (legacyDescription && raw.system?.description === legacyDescription) changes["system.description"] = source.system.description;
  if (kind === "shell" && equalTankSources(raw.system?.craft, data.legacyDefaults?.shellCraft)) changes["system.craft"] = {};
  if (!(existing.folder ?? raw.folder) && folder) changes.folder = folder.id ?? folder._id ?? folder;
  return changes;
}

async function ensurePrototype(data, kind, source, folder, created, legacyName = "", legacyDescription = "", legacyKind = "") {
  const existing = findPrototype(data, kind) ?? (legacyKind ? findPrototype(data, legacyKind) : null);
  if (existing) {
    // Rename an untouched package label once; never replace customized prototype statistics.
    const changes = planModularTankPrototypeUpgrade(existing, data, kind, source, folder, { legacyName, legacyDescription });
    if (Object.keys(changes).length) await existing.update(changes);
    return existing;
  }
  const prototype = structuredClone(source);
  for (const key of ["_id", "folder", "ownership", "_stats"]) delete prototype[key];
  if (folder) prototype.folder = folder.id;
  prototype.flags ??= {};
  prototype.flags[SYSTEM_ID] ??= {};
  prototype.flags[SYSTEM_ID].modularTankDemo = { packageId: data.packageId, kind, revision: data.revision };
  const item = await Item.create(prototype);
  created.push(item);
  return item;
}

async function ensureFolder(type, path, created) {
  if (!Array.isArray(path) || !path.length || !globalThis.Folder?.create) return null;
  let parent = null;
  for (const name of path) {
    let folder = (game.folders?.contents ?? []).find(row => row.type === type && row.name === name
      && String(row.folder?.id ?? row.folder ?? row._source?.folder ?? "") === String(parent?.id ?? ""));
    if (!folder) {
      folder = await Folder.create({ name, type, folder: parent?.id ?? null, sorting: "a" });
      created.push(folder);
    }
    parent = folder;
  }
  return parent;
}
