/**
 * Adds missing creation recipes to weapons that imported without craft data.
 *
 * The macro works backwards from the current item stats. It does not change
 * weapon functions, damage, price, placement, image, or any other item data.
 */

const DRY_RUN = false;
const OVERWRITE_EXISTING_CRAFTS = false;
const REPAIR_MALFORMED_DERIVED_CRAFTS = true;

const MODULE_ID = "fallout-maw";
const DEFAULT_RECIPE_ID = "recipe1";
const DEFAULT_VIEWPORT = { x: 0, y: 0, zoom: 1 };

const CLASS_BY_RARITY = {
  ordinary: "D",
  unusual: "C",
  rare: "B",
  epic: "A",
  legendary: "S",
  unique: "S",
  wild: "S",
};

const COMPLEXITY_BY_CLASS = {
  D: 40,
  C: 80,
  B: 120,
  A: 160,
  S: 200,
};

const BASE_DAMAGE_BY_RARITY = {
  ordinary: 20,
  unusual: 40,
  rare: 60,
  epic: 80,
  legendary: 100,
  unique: 120,
  wild: 140,
};

const TIER_EFFECTS_BY_CLASS = {
  D: { critChance: 3, critDamage: 10, accuracy: 10, range: 10 },
  C: { critChance: 5, critDamage: 16, accuracy: 15, range: 15 },
  B: { critChance: 7, critDamage: 23, accuracy: 20, range: 20 },
  A: { critChance: 8, critDamage: 29, accuracy: 25, range: 25 },
  S: { critChance: 10, critDamage: 35, accuracy: 30, range: 30 },
};

const COMPONENT_NAMES_BY_KEY = {
  mechanics: "Компонент механики",
  electronics: "Компонент электроники",
  frames: "Компонент каркаса",
  properties: "Компонент свойств",
};

const SPECIAL_DAMAGE_KEYS = new Set([
  "electric",
  "energy",
  "plasma",
  "cryo",
  "fire",
  "acid",
  "poison",
  "radiation",
]);

const PHYSICAL_DAMAGE_KEYS = new Set([
  "bludgeoning",
  "piercing",
  "slashing",
  "kinetic",
  "explosive",
]);

function clone(value) {
  return foundry.utils.deepClone(value);
}

function getItems() {
  return Array.from(game.items?.contents ?? game.items ?? []);
}

function getPropertyValue(source, path) {
  return foundry.utils.getProperty(source, path);
}

function asNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function hasCraftPayload(craft) {
  if (!craft || typeof craft !== "object") return false;
  if (Array.isArray(craft.recipes) && craft.recipes.some((recipe) => Array.isArray(recipe?.nodes) && recipe.nodes.length > 0)) {
    return true;
  }
  return Array.isArray(craft.nodes) && craft.nodes.length > 0;
}

function hasMalformedCraftCoordinates(craft) {
  const layouts = [
    craft,
    craft?.disassembly,
    ...(Array.isArray(craft?.recipes) ? craft.recipes : []),
    ...(Array.isArray(craft?.recipes) ? craft.recipes.map((recipe) => recipe.disassembly) : []),
  ].filter(Boolean);
  return layouts.some((layout) =>
    (layout.nodes ?? []).some((node) => Math.abs(asNumber(node.x, 0)) > 20 || Math.abs(asNumber(node.y, 0)) > 20),
  );
}

function isWeaponItem(item) {
  return item?.type === "gear" && getPropertyValue(item, "system.functions.weapon.enabled") === true;
}

function normalizeText(value) {
  return String(value ?? "").trim().toLocaleLowerCase("ru");
}

function getFolderNames(item) {
  const names = [];
  let folder = item.folder ?? null;
  while (folder) {
    names.unshift(folder.name);
    folder = folder.folder ?? null;
  }
  return names;
}

function getMigrationFolderNames(item) {
  const migration = item.getFlag?.(MODULE_ID, "weaponMigration") ?? {};
  const names = [];
  if (Array.isArray(migration.folderPath)) names.push(...migration.folderPath);
  if (Array.isArray(migration.oldFolderPath)) names.push(...migration.oldFolderPath);
  if (typeof migration.oldFolderPath === "string") {
    names.push(...migration.oldFolderPath.split("/").map((part) => part.trim()).filter(Boolean));
  }
  return names;
}

function detectRarity(item) {
  const names = [
    ...getMigrationFolderNames(item),
    ...getFolderNames(item),
    getPropertyValue(item, "system.rarity"),
    getPropertyValue(item, "system.quality"),
  ].map(normalizeText);
  const text = names.join(" / ");

  if (text.includes("дикая пустошь") || text.includes("wild wasteland")) return "wild";
  if (text.includes("уникаль")) return "unique";
  if (text.includes("легендар")) return "legendary";
  if (text.includes("эпичес") || text.includes("эпик")) return "epic";
  if (text.includes("редк")) return "rare";
  if (text.includes("необыч")) return "unusual";
  if (text.includes("обыч")) return "ordinary";
  return null;
}

function detectWeaponKind(item, weapon) {
  const skillKey = String(weapon.skillKey ?? "");
  const proficiencyKey = String(weapon.proficiencyKey ?? "");
  const tags = `${skillKey} ${proficiencyKey}`.toLocaleLowerCase("en");

  if (skillKey === "throwing") return "throwing";
  if (skillKey === "meleeCombat") {
    if (tags.includes("twohanded")) return "melee2h";
    return "melee1h";
  }
  if (tags.includes("grenade")) return "grenadeLauncher";
  if (tags.includes("machinegun") || tags.includes("flamethrower")) return "machineGun";
  if (tags.includes("shotgun")) return "shotgun";
  if (tags.includes("smg")) return "smg";
  if (tags.includes("automatic")) return "automatic";
  if (tags.includes("rifle")) return "rifle";
  if (tags.includes("pistol") || tags.includes("revolver")) return "pistol";
  return "ranged";
}

function getDamageEntries(weapon) {
  const entries = [];
  const damageTypes = weapon.damageTypes;
  if (damageTypes && typeof damageTypes === "object") {
    for (const [key, rawValue] of Object.entries(damageTypes)) {
      const value = asNumber(rawValue, 0);
      if (value > 0) entries.push({ key, value });
    }
  }
  const singleKey = weapon.damageTypeKey;
  if (singleKey && !entries.some((entry) => entry.key === singleKey)) {
    entries.push({ key: singleKey, value: 100 });
  }
  return entries;
}

function hasSpecialDamage(weapon) {
  return getDamageEntries(weapon).some((entry) => SPECIAL_DAMAGE_KEYS.has(entry.key));
}

function hasPhysicalDamage(weapon) {
  return getDamageEntries(weapon).some((entry) => PHYSICAL_DAMAGE_KEYS.has(entry.key));
}

function hasAction(weapon, key) {
  return getPropertyValue(weapon, `availableActions.${key}`) === true;
}

function isEnergySubtype(weapon) {
  const subtype = String(weapon.weaponSubtypeKey ?? weapon.subtypeKey ?? "");
  return subtype === "energy" || subtype === "plasma" || hasSpecialDamage(weapon);
}

function isKineticSubtype(weapon) {
  const subtype = String(weapon.weaponSubtypeKey ?? weapon.subtypeKey ?? "");
  return subtype === "kinetic" || subtype === "gauss";
}

function addUniqueBonus(parts, rarity, mechanicsBonus = 2, frameBonus = 1) {
  if (rarity === "wild") {
    parts.mechanics += mechanicsBonus * 2;
    parts.frames += frameBonus * 2;
  } else if (rarity === "unique") {
    parts.mechanics += mechanicsBonus;
    parts.frames += frameBonus;
  }
}

function addMagazineFrameBonus(parts, kind, magazineMax) {
  if (magazineMax <= 0) return;
  let firstThreshold = 20;
  let secondThreshold = 50;
  if (kind === "smg") {
    firstThreshold = 36;
    secondThreshold = 72;
  } else if (kind === "automatic" || kind === "machineGun") {
    firstThreshold = 50;
    secondThreshold = 125;
  } else if (kind === "pistol" || kind === "rifle" || kind === "shotgun") {
    firstThreshold = 8;
    secondThreshold = 20;
  }

  if (magazineMax > secondThreshold) parts.frames += 2;
  else if (magazineMax > firstThreshold) parts.frames += 1;
}

function getOldFirearmBaseParts(kind, rarity, weapon) {
  const parts = { mechanics: 0, electronics: 0, frames: 0, properties: 0 };
  const energy = isEnergySubtype(weapon);
  const kinetic = isKineticSubtype(weapon);
  const magazineMax = asNumber(getPropertyValue(weapon, "magazine.max"), 0);

  if (kind === "pistol") {
    if (energy) {
      Object.assign(parts, { mechanics: 2, electronics: 2, frames: 2, properties: 0 });
      if (rarity === "legendary") Object.assign(parts, { mechanics: 3, electronics: 2, frames: 3, properties: 0 });
      if (rarity === "unique") Object.assign(parts, { mechanics: 4, electronics: 4, frames: 4, properties: 0 });
      if (rarity === "wild") Object.assign(parts, { mechanics: 5, electronics: 4, frames: 5, properties: 0 });
    } else {
      Object.assign(parts, { mechanics: 3, electronics: 0, frames: 1, properties: 0 });
      if (rarity === "legendary") Object.assign(parts, { mechanics: 4, electronics: 0, frames: 2, properties: 0 });
      if (rarity === "unique") Object.assign(parts, { mechanics: 5, electronics: 0, frames: 3, properties: 0 });
      if (rarity === "wild") Object.assign(parts, { mechanics: 7, electronics: 0, frames: 5, properties: 0 });
    }
    addMagazineFrameBonus(parts, kind, magazineMax);
    return parts;
  }

  if (kind === "automatic") {
    parts.mechanics = hasAction(weapon, "singleShot") && hasAction(weapon, "aimedShot") ? 5 : 4;
    parts.frames = 2;
    if (energy) {
      parts.electronics += 3;
      parts.mechanics -= 1;
    }
    if (kinetic) {
      parts.electronics += 5;
      parts.mechanics -= 1;
    }
    addUniqueBonus(parts, rarity);
    addMagazineFrameBonus(parts, kind, magazineMax);
    return parts;
  }

  if (kind === "machineGun") {
    parts.mechanics = hasAction(weapon, "singleShot") && hasAction(weapon, "aimedShot") ? 6 : 5;
    parts.frames = 3;
    if (energy) {
      parts.electronics += 3;
      parts.mechanics -= 1;
    }
    if (kinetic) {
      parts.electronics += 5;
      parts.mechanics -= 1;
    }
    addUniqueBonus(parts, rarity);
    addMagazineFrameBonus(parts, kind, magazineMax);
    return parts;
  }

  if (kind === "grenadeLauncher") {
    parts.mechanics = hasAction(weapon, "singleShot") && hasAction(weapon, "aimedShot") ? 6 : 5;
    parts.frames = String(weapon.proficiencyKey ?? "").includes("oneHanded") ? 2 : 3;
    addUniqueBonus(parts, rarity);
    addMagazineFrameBonus(parts, kind, magazineMax);
    return parts;
  }

  parts.mechanics = 4;
  parts.frames = 2;
  if (energy) {
    parts.electronics += 3;
    parts.mechanics -= 1;
    parts.frames += 1;
  }
  if (kinetic) {
    parts.electronics += 5;
    parts.mechanics -= 1;
    parts.frames += 1;
  }
  addUniqueBonus(parts, rarity);
  addMagazineFrameBonus(parts, kind, magazineMax);
  return parts;
}

function getMeleeBaseParts(kind, rarity) {
  const parts = { mechanics: 0, electronics: 0, frames: 0, properties: 0 };
  const className = CLASS_BY_RARITY[rarity] ?? "D";
  const lowTierBonus = { D: 0, C: 0, B: 1, A: 1, S: 2 }[className] ?? 0;

  if (kind === "melee2h") {
    parts.mechanics = 3 + lowTierBonus;
    parts.frames = 2;
  } else {
    parts.mechanics = 2 + lowTierBonus;
    parts.frames = 1;
  }
  if (rarity === "unique") {
    parts.mechanics += 1;
    parts.frames += 1;
  } else if (rarity === "wild") {
    parts.mechanics += 3;
    parts.frames += 2;
  }
  return parts;
}

function getThrowingBaseParts(rarity) {
  const className = CLASS_BY_RARITY[rarity] ?? "D";
  const classBonus = { D: 0, C: 0, B: 1, A: 1, S: 2 }[className] ?? 0;
  const parts = {
    mechanics: 1 + classBonus,
    electronics: 0,
    frames: rarity === "wild" ? 2 : 1,
    properties: 0,
  };
  if (rarity === "unique") parts.mechanics += 1;
  if (rarity === "wild") parts.mechanics += 2;
  return parts;
}

function deriveParts(item) {
  const weapon = getPropertyValue(item, "system.functions.weapon") ?? {};
  const rarity = detectRarity(item);
  if (!rarity) return { error: "Не удалось определить редкость" };

  const partClass = CLASS_BY_RARITY[rarity] ?? "D";
  const kind = detectWeaponKind(item, weapon);
  const tierEffects = TIER_EFFECTS_BY_CLASS[partClass] ?? TIER_EFFECTS_BY_CLASS.D;
  let parts;

  if (kind === "melee1h" || kind === "melee2h") {
    parts = getMeleeBaseParts(kind, rarity);
  } else if (kind === "throwing") {
    parts = getThrowingBaseParts(rarity);
  } else {
    parts = getOldFirearmBaseParts(kind, rarity, weapon);
  }

  const damage = asNumber(weapon.damage, 0);
  const baseDamage = BASE_DAMAGE_BY_RARITY[rarity] ?? 20;
  const damageExtra = Math.max(0, damage - baseDamage);
  const specialDamage = hasSpecialDamage(weapon);
  const physicalDamage = hasPhysicalDamage(weapon);
  const penetration = asNumber(weapon.penetration, 0);
  const critChance = Math.max(0, asNumber(weapon.criticalChanceModifier, 0));
  const critDamage = asNumber(weapon.criticalDamagePercent, 150);
  const radius = asNumber(weapon.radius, 0);
  const accuracy = Math.max(0, asNumber(weapon.accuracy, 0));
  const magazineMax = asNumber(getPropertyValue(weapon, "magazine.max"), 0);

  if (kind === "melee1h" || kind === "melee2h") {
    const extraUnits = clamp(Math.ceil(damageExtra / 40), 0, 4);
    if (specialDamage && !physicalDamage) parts.electronics += extraUnits;
    else if (specialDamage && physicalDamage) {
      parts.mechanics += Math.ceil(extraUnits / 2);
      parts.electronics += Math.floor(extraUnits / 2);
    } else {
      parts.mechanics += extraUnits;
    }

    if (specialDamage) parts.electronics += 2;
    if (magazineMax > 0) parts.electronics += clamp(Math.ceil(magazineMax / 5), 1, 3);
    if (asNumber(item.system?.weight, 0) >= 6) parts.frames += 1;
  } else if (kind === "throwing") {
    const extraUnits = clamp(Math.ceil(damageExtra / 40), 0, 6);
    if (specialDamage && !physicalDamage) parts.electronics += extraUnits;
    else if (specialDamage && physicalDamage) {
      parts.mechanics += Math.ceil(extraUnits / 2);
      parts.electronics += Math.floor(extraUnits / 2);
    } else {
      parts.mechanics += extraUnits;
    }
    if (specialDamage) parts.electronics += 2;
    if (radius >= 5) parts.frames += 1;
    if (radius > 0) parts.properties += clamp(Math.ceil(radius / 2), 1, 3);
  } else {
    if (damageExtra > 0) {
      const extraUnits = clamp(Math.ceil(damageExtra / 40), 0, 4);
      if (specialDamage && !physicalDamage) parts.electronics += extraUnits;
      else parts.mechanics += extraUnits;
    }
    if (accuracy > 0) parts.mechanics += clamp(Math.ceil(accuracy / tierEffects.accuracy), 1, 4);
  }

  if (penetration > 0) {
    const penetrationUnits = clamp(Math.ceil(penetration / 10), 1, 5);
    if (specialDamage && !physicalDamage) parts.electronics += penetrationUnits;
    else parts.mechanics += penetrationUnits;
  }

  if (critChance > 0) {
    parts.properties += clamp(Math.ceil(critChance / tierEffects.critChance), 1, 6);
  }
  if (critDamage > 150) {
    parts.properties += clamp(Math.ceil((critDamage - 150) / tierEffects.critDamage), 1, 4);
  }

  for (const key of Object.keys(parts)) {
    parts[key] = Math.max(0, Math.round(parts[key]));
  }

  if (!Object.values(parts).some((value) => value > 0)) {
    parts.mechanics = 1;
  }

  return {
    parts,
    partClass,
    rarity,
    kind,
    difficulty: COMPLEXITY_BY_CLASS[partClass] ?? 40,
  };
}

function buildComponentIndex() {
  const index = new Map();
  for (const item of getItems()) {
    index.set(normalizeText(item.name), item);
  }
  return index;
}

function resolveResources(componentIndex, parts, partClass) {
  const resources = [];
  const missing = [];
  for (const [key, quantity] of Object.entries(parts)) {
    if (!quantity || quantity <= 0) continue;
    const name = `${COMPONENT_NAMES_BY_KEY[key]} ${partClass} класса`;
    const item = componentIndex.get(normalizeText(name));
    if (!item) {
      missing.push(name);
      continue;
    }
    resources.push({ item, quantity });
  }
  return { resources, missing };
}

function makeEmptyLayout() {
  return {
    nodes: [],
    links: [],
    viewport: clone(DEFAULT_VIEWPORT),
  };
}

function getNodeSize(item) {
  return { width: 1, height: 1 };
}

function makeNode(item, { id, x, y, quantity = 1, root = false }) {
  const size = getNodeSize(item);
  return {
    id,
    itemUuid: item.uuid,
    name: item.name,
    img: item.img,
    type: item.type,
    x,
    y,
    width: size.width,
    height: size.height,
    quantity,
    blockId: "",
    blockLimit: null,
    root,
  };
}

function layoutResourceNodes(resources) {
  const columns = Math.min(5, Math.max(1, resources.length));
  const rows = Math.ceil(resources.length / columns);
  const blockId = resources.length > 1 ? "block-1-resources" : "";
  return resources.map((resource, index) => ({
      row: Math.floor(index / columns),
      column: index % columns,
      resource,
    }))
  .map(({ row, column, resource }, index) => {
    const countInRow = row === rows - 1 ? resources.length - (row * columns) : columns;
    const x = column - ((countInRow - 1) / 2);
    const y = -3 - (rows - 1 - row);
    const node = makeNode(resource.item, {
      id: `node-${resource.item.id}-${index + 1}`,
      x,
      y,
      quantity: resource.quantity,
    });
    node.blockId = blockId;
    node.blockLimit = null;
    return node;
  });
}

function buildCraftData(item, resources, difficulty) {
  const rootNode = makeNode(item, { id: "root", x: 0, y: 0, quantity: 1, root: true });
  const resourceNodes = layoutResourceNodes(resources);
  const nodes = [rootNode, ...resourceNodes];
  const links = resourceNodes.length
    ? [
        {
          id: `link-${DEFAULT_RECIPE_ID}-resources-root`,
          fromNodeId: resourceNodes[0].id,
          toNodeId: rootNode.id,
          fromAnchorSide: "bottom",
          fromAnchorOffset: 0.5,
          toAnchorSide: "top",
          toAnchorOffset: 0.5,
          bendX: null,
          bendY: null,
          skillKey: "repair",
          difficulty,
          noCheck: false,
        },
      ]
    : [];

  const disassembly = makeEmptyLayout();
  const recipe = {
    id: DEFAULT_RECIPE_ID,
    name: "Рецепт 1",
    nodes: clone(nodes),
    links: clone(links),
    viewport: clone(DEFAULT_VIEWPORT),
    disassembly: clone(disassembly),
  };

  return {
    mode: "craft",
    nodes,
    links,
    viewport: clone(DEFAULT_VIEWPORT),
    disassembly,
    recipes: [recipe],
  };
}

function describeParts(parts, partClass) {
  return Object.entries(parts)
    .filter(([, quantity]) => quantity > 0)
    .map(([key, quantity]) => `${COMPONENT_NAMES_BY_KEY[key]} ${partClass}: ${quantity}`)
    .join(", ");
}

if (game.system?.id !== MODULE_ID) {
  ui.notifications?.error(`Этот макрос рассчитан на систему ${MODULE_ID}.`);
  return;
}

if (!game.user?.isGM) {
  ui.notifications?.error("Макрос должен запускать GM.");
  return;
}

const componentIndex = buildComponentIndex();
const updates = [];
const previewRows = [];
const skipped = [];

for (const item of getItems()) {
  if (!isWeaponItem(item)) continue;
  const hasCraft = hasCraftPayload(item.system?.craft);
  const repairMalformed = REPAIR_MALFORMED_DERIVED_CRAFTS && hasCraft && hasMalformedCraftCoordinates(item.system?.craft);
  if (!OVERWRITE_EXISTING_CRAFTS && hasCraft && !repairMalformed) continue;

  const derived = deriveParts(item);
  if (derived.error) {
    skipped.push({ name: item.name, reason: derived.error });
    continue;
  }

  const { resources, missing } = resolveResources(componentIndex, derived.parts, derived.partClass);
  if (missing.length > 0) {
    skipped.push({ name: item.name, reason: `Не найдены компоненты: ${missing.join(", ")}` });
    continue;
  }

  const craft = buildCraftData(item, resources, derived.difficulty);
  updates.push({ _id: item.id, "system.craft": craft });
  previewRows.push({
    name: item.name,
    rarity: derived.rarity,
    kind: derived.kind,
    difficulty: derived.difficulty,
    recipe: describeParts(derived.parts, derived.partClass),
  });
}

console.group("Derived missing weapon crafts");
console.table(previewRows);
if (skipped.length > 0) console.table(skipped);
console.groupEnd();

if (DRY_RUN) {
  ui.notifications?.info(`Проверка рецептов: найдено ${updates.length}, пропущено ${skipped.length}. Подробности в консоли.`);
  return;
}

if (updates.length > 0) {
  await Item.implementation.updateDocuments(updates);
}

ui.notifications?.info(`Добавлены рецепты оружия: ${updates.length}. Пропущено: ${skipped.length}. Подробности в консоли.`);
