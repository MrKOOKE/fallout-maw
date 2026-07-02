import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractDescription,
  getFolderPath,
  migrateAssetPath,
  readLevelDocuments,
  toInteger
} from "./generate-material-migration.mjs";
import { parseConstructPartMigration } from "./gear-description-parser.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const systemRoot = path.resolve(__dirname, "..");
const dataRoot = path.resolve(systemRoot, "..", "..");
const downloadsDataRoot = path.join(os.homedir(), "Downloads", "Data");
const OLD_WORLD_ROOT = path.join(dataRoot, "fallout-old");
const MACRO_DIR = path.join(systemRoot, "scripts", "migration-macros", "actors");
const IMPORTED_ACTOR_ASSET_DIR = path.join(systemRoot, "assets", "Personazhi", "Imported");

const SYSTEM_ID = "fallout-maw";
const ROOT_FOLDER = "MAW Импорт акторов";
const FLAG_KEY = "actorMigration";
const CONSTRUCT_PART_FLAG_KEY = "actorConstructPartMigration";

const OLD_ITEM_ID_ALIASES = {
  "0cygJX1IKCzvWw1b": "x2VIpCSzghynU8c5",
  "lNGUlpxPqCSrMkit": "dhbmaVvqxPoAB4q0",
  "dns2gvnKvE0HDxhn": "2Gqvi42QCTSCG7tO",
  "GDpJwJUShXKuEBvY": "oZJX2XJgw23kDXPc",
  "S3TAv0k5a281qMqG": "27KJalb5VBosRB8B",
  "JFuavNs0sG8ikClw": "oclSElwvY8MjXuIv",
  "zlTJ8whZtCY2abor": "NSAiD9LVesJTicxy",
  "O49Op2BxTVJzBrSj": "O8tcA1MvPpSgET9R",
  "IBupLj0xLa4eKncN": "vByBBvvQ2lPbrxjE"
};

const MIGRATION_FLAG_KEYS = [
  "materialMigration",
  "junkMigration",
  "firstAidMigration",
  "bookMigration",
  "foodMigration",
  "toolMigration",
  "ammoMigration",
  "weaponMigration",
  "moduleMigration",
  "equipmentMigration",
  "constructPartMigration",
  "quickBonusAbility"
];

const ROBOT_NAME_PATTERNS = [
  "мистер помощник",
  "робоглаз",
  "разрушитель",
  "протектрон",
  "робомозг",
  "штурмотрон"
];

const CONTAINER_ACTOR_IDS = new Set([
  "uWALrtGIOjatBdVG",
  "CG7iBiO8PMBIz3QT",
  "MlZv9RNYJmOWNNEm",
  "14H3GnYwQXL8nA6J",
  "4qljaSBjIGkDoVnb",
  "RGKsCuy2Ngcfqv5d",
  "kASJKfoHun4D5XF5",
  "n22PuZsEuCkH6dpf",
  "mf7h1Yfvzn7GNNhG",
  "K8jO9xPV0sZyduwx",
  "eURoaqJXkeLAwdXg",
  "oUijyw2NK7ouOmB8",
  "LVhtfFbYdJyOWvuC",
  "KrYPzq3CSwcW9XaX",
  "ZkbfBIoLh8IydYnk",
  "rzaA6iirF1DVxTDh",
  "iv4IebYRpwQ0LNEd",
  "58tdtqp8Q9ek2P85"
]);

const CONTAINER_NAME_PATTERNS = [
  "default item pile",
  "аптечка",
  "большой тулбокс",
  "большой ящик",
  "еда",
  "сейф",
  "снаряжение",
  "сундук",
  "хлам",
  "шкаф",
  "ящик",
  "стол",
  "терминал"
];

const CONSTRUCT_CREATURE_MATCH = {
  raceNames: ["Робот", "Robot", "Конструкт", "Construct", "Машина", "Machine", "Объект", "Object"],
  typeNames: ["Конструкты", "Constructs", "Роботы", "Robots", "Объекты", "Objects"]
};

const CREATURE_MATCH_RULES = [
  {
    test: text => text.includes("брамин"),
    raceNames: ["Брамин", "Brahmin", "Животное", "Animal"],
    typeNames: ["Животные", "Animals", "Существа", "Creatures"]
  },
  {
    test: text => text.includes("коготь смерти"),
    raceNames: ["Коготь смерти", "Deathclaw", "Мутант", "Mutant", "Животное", "Animal"],
    typeNames: ["Животные", "Animals", "Мутанты", "Mutants", "Существа", "Creatures"]
  },
  {
    test: text => text.includes("радтаракан") || text.includes("насеком"),
    raceNames: ["Радтаракан", "Radroach", "Насекомое", "Insect", "Животное", "Animal"],
    typeNames: ["Насекомые", "Insects", "Животные", "Animals", "Существа", "Creatures"]
  },
  {
    test: text => text.includes("кротокрыс"),
    raceNames: ["Кротокрыс", "Molerat", "Животное", "Animal"],
    typeNames: ["Животные", "Animals", "Существа", "Creatures"]
  },
  {
    test: text => text.includes("крыса"),
    raceNames: ["Крыса", "Rat", "Животное", "Animal"],
    typeNames: ["Животные", "Animals", "Существа", "Creatures"]
  },
  {
    test: text => text.includes("барибал"),
    raceNames: ["Барибал", "Bear", "Животное", "Animal"],
    typeNames: ["Животные", "Animals", "Существа", "Creatures"]
  },
  {
    test: text => text.includes("гул"),
    raceNames: ["Гуль", "Ghoul", "Дикий гуль", "Feral Ghoul", "Человек", "Human"],
    typeNames: ["Гуманоиды", "Humanoids", "Люди", "People"]
  },
  {
    test: text => text.includes("супермутант"),
    raceNames: ["Супермутант", "Super Mutant", "Мутант", "Mutant", "Человек", "Human"],
    typeNames: ["Гуманоиды", "Humanoids", "Люди", "People", "Мутанты", "Mutants"]
  },
  {
    test: () => true,
    raceNames: ["Человек", "Human", "Гуманоид", "Humanoid"],
    typeNames: ["Люди", "People", "Гуманоиды", "Humanoids"]
  }
];

const CHARACTERISTIC_MAP = {
  str: "strength",
  dex: "dexterity",
  con: "endurance",
  wis: "perception",
  int: "intelligence",
  cha: "charisma",
  luc: "luck"
};

const SKILL_MAP = {
  accm: "meleeCombat",
  accr: "rangedCombat",
  ath: "athletics",
  gam: "gambling",
  dec: "barter",
  slt: "theft",
  med: "firstAid",
  itm: "speech",
  prf: "speech",
  per: "speech",
  ins: "naturalist",
  acr: "throwing",
  nat: "naturalist",
  his: "science",
  arc: "energy",
  sur: "resilience",
  cra: "repair",
  ste: "stealth",
  prc: "resilience",
  act: "traps",
  inv: "lockpicking"
};

const OLD_CURRENCY_KEY_FALLBACKS = {
  pp: "caps",
  gp: "caps",
  ep: "caps",
  sp: "caps",
  cp: "caps",
  cop: "caps"
};

const TOKENIZER_ACTOR_ASSET_BY_ID = {
  "14H3GnYwQXL8nA6J": "systems/fallout-maw/assets/Predmety/Medicina/aptechka.webp",
  "4qljaSBjIGkDoVnb": "systems/fallout-maw/assets/Predmety/Medicina/aptechka.webp",
  "IW2MXtSBQ6FhiV9r": "systems/fallout-maw/assets/Personazhi/Zhivotnye/bramin.webp",
  "guhvo5JNAPAXWOzo": "systems/fallout-maw/assets/Personazhi/Kompaniya Kogot/nayomnik-kogtya-1.webp",
  "LP2RwgGQlknPTpjN": "systems/fallout-maw/assets/Personazhi/Kompaniya Kogot/nayomnik-kogtya-2.webp",
  "azIJOn9q0mNVcvvL": "systems/fallout-maw/assets/Personazhi/Kompaniya Kogot/nayomnik-kogtya-3.webp",
  "sNwnVXpNuv1gi0yL": "systems/fallout-maw/assets/Personazhi/NKR/nkr-veteran.webp",
  "DTPMD1dMhwyarfmT": "systems/fallout-maw/assets/Personazhi/NKR/nkr-veteran.webp",
  "tbfVJWlC3asVICd2": "systems/fallout-maw/assets/Personazhi/NKR/nkr-snajper.webp",
  "YJzBgHCBhig9sLHc": "systems/fallout-maw/assets/Personazhi/NKR/nkr-veteran.webp",
  "CNrTL1zRm1YgSO6L": "systems/fallout-maw/assets/Personazhi/Guli/Dikie/berserk.webp",
  "VfycJSKHVIYxfasw": "systems/fallout-maw/assets/Personazhi/Guli/gul-potroshitel.webp",
  "SpXjrpJHx8IiuvYZ": "systems/fallout-maw/assets/Personazhi/Guli/Dikie/dikij-gul.webp",
  "dplHqihcjLFXJFwn": "systems/fallout-maw/assets/Personazhi/Zhivotnye/bramin-karavanshika.webp",
  "usZZXLiQwieXvq3O": "systems/fallout-maw/assets/Personazhi/Mutanty/kogot-smerti.webp",
  "biEnFt0enesesKpn": "systems/fallout-maw/assets/Personazhi/Zhivotnye/krotokrys.webp",
  "WKJLgSZB50Aek5o1": "systems/fallout-maw/assets/Personazhi/Zhivotnye/krysa.webp",
  "2lL9ZqypI39zmdxs": "systems/fallout-maw/assets/Personazhi/Roboty/mister-pomoshnik.webp",
  "8EDTmzSq7jQcHu9F": "systems/fallout-maw/assets/Personazhi/Roboty/mister-pomoshnikch.webp",
  "jCINgpWHnE8gzm9I": "systems/fallout-maw/assets/Personazhi/NKR/soldat-nkr-1.webp",
  "iyOn2vvmut5QN4LD": "systems/fallout-maw/assets/Personazhi/NKR/soldat-nkr-2.webp",
  "y9O4eAacv3txPAL5": "systems/fallout-maw/assets/Personazhi/NKR/soldat-nkr-3.webp",
  "a6WXWvkQ4yYqiYkF": "systems/fallout-maw/assets/Personazhi/Kompaniya Kogot/shturmovik-kogtya-1.webp",
  "sCWwQUeT3Mn9um9V": "systems/fallout-maw/assets/Personazhi/Kompaniya Kogot/shturmovik-kogtya-2.webp",
  "YgsPRSSumk8eh1BI": "systems/fallout-maw/assets/Personazhi/Kompaniya Kogot/shturmovik-kogtya-3.webp",
  "OI9Qiudxxukmmbck": "systems/fallout-maw/assets/Personazhi/Kompaniya Kogot/shturmovik-kogtya-4.webp",
  "D318VUkLXO0uO07x": "systems/fallout-maw/assets/Personazhi/Kompaniya Kogot/shturmovik-kogtya-1.webp",
  "6QtcBCYju9YdsbTt": "systems/fallout-maw/assets/Personazhi/NKR/nkr-shturm.webp",
  "FKEEKR0VfmsttXNd": "systems/fallout-maw/assets/Personazhi/NKR/nkr-snajper.webp",
  "jArk8dfmI0NAYIIA": "systems/fallout-maw/assets/Personazhi/NKR/nkr-podryvnik.webp",
  "eieAU9u3ZpPHa5yf": "systems/fallout-maw/assets/Personazhi/NKR/nkr-shturm-1.webp",
  "edRNXaLKzYc0Dv55": "systems/fallout-maw/assets/Personazhi/NKR/nkr-specialist.webp",
  "bYaAaU3Ek1VEx9Ie": "systems/fallout-maw/assets/Personazhi/Roboty/protektron.webp",
  "HbxYXo51WPnq6LPK": "systems/fallout-maw/assets/Personazhi/Nasekomye/radtarakan.webp",
  "PTzAeNKuUr9dChPn": "systems/fallout-maw/assets/Personazhi/Roboty/assaultbot.webp",
  "DJbfmk2Iv2Ns64OL": "systems/fallout-maw/assets/Personazhi/Roboty/roboglaz.webp",
  "mf53MgHEbg0G6woU": "systems/fallout-maw/assets/Personazhi/Roboty/robomozg.webp",
  "He7FO4v3o6PNfaAs": "systems/fallout-maw/assets/Personazhi/Guli/svetyashijsya-gul.webp",
  "RCl0BxA3tmOS3ljn": "systems/fallout-maw/assets/Personazhi/Supermutanty/supermutant.webp",
  "CG7iBiO8PMBIz3QT": "systems/fallout-maw/assets/Personazhi/metki/terminal1.webp",
  "uNraTNLY4nBzh9p1": "systems/fallout-maw/assets/Personazhi/Grazhdanskie/torgovec.webp",
  "zSiqIyegGTQE5q8U": "systems/fallout-maw/assets/Personazhi/Roboty/shturmotron.webp"
};

const copiedTokenizerAssets = [];
const missingTokenizerAssets = [];

const SLOT_ORDER = [
  "Голова",
  "Глаза",
  "Туловище",
  "Пах",
  "Левая рука",
  "Правая рука",
  "Левая нога",
  "Правая нога"
];

async function main() {
  const [actorDocs, folders, worldItems] = await Promise.all([
    readLevelDocuments(path.join(OLD_WORLD_ROOT, "data", "actors")),
    readLevelDocuments(path.join(OLD_WORLD_ROOT, "data", "folders")),
    readLevelDocuments(path.join(OLD_WORLD_ROOT, "data", "items"))
  ]);
  const folderById = new Map(folders.map(folder => [folder._id, folder]));
  const actorDocById = new Map(actorDocs.filter(doc => doc?._id).map(doc => [doc._id, doc]));
  const constructTemplateByName = buildConstructPartTemplateIndex(worldItems, folders);

  const characterActors = actorDocs
    .filter(doc => doc?.type === "character")
    .filter(doc => !isLostActor(doc, folderById));
  const skippedLostActors = actorDocs
    .filter(doc => doc?.type === "character")
    .filter(doc => isLostActor(doc, folderById));
  const actors = characterActors
    .sort((left, right) => String(left.name ?? "").localeCompare(String(right.name ?? ""), "ru") || left._id.localeCompare(right._id));

  const records = [];
  const warnings = [];
  for (const actor of actors) {
    const record = await createActorRecord(actor, folderById, actorDocById, constructTemplateByName);
    records.push(record);
    if (record.warnings.length) warnings.push(`${record.id}\t${record.name}\t${record.warnings.join("; ")}`);
  }

  const buildStamp = new Date().toISOString();
  await fs.mkdir(MACRO_DIR, { recursive: true });
  await fs.writeFile(path.join(MACRO_DIR, "01-import-actors.js"), buildActorMacro(records, buildStamp), "utf8");
  await fs.writeFile(path.join(MACRO_DIR, "00-PASTE-INTO-FOUNDRY-MACRO.js"), buildPasteMacro(), "utf8");
  await fs.writeFile(path.join(MACRO_DIR, "README.md"), buildReadme(records, buildStamp), "utf8");
  if (warnings.length) await fs.writeFile(path.join(MACRO_DIR, "parse-warnings.txt"), warnings.join("\n"), "utf8");
  else await fs.rm(path.join(MACRO_DIR, "parse-warnings.txt"), { force: true });

  console.log(`[actors] records: ${records.length}`);
  console.log(`[actors] skipped LOST: ${skippedLostActors.length}`);
  console.log(`[actors] constructs: ${records.filter(record => record.type === "construct").length}`);
  console.log(`[actors] personal generators: ${records.filter(record => record.personalGenerator).length}`);
  console.log(`[actors] installed construct parts: ${records.reduce((sum, record) => sum + record.constructParts.length, 0)}`);
  console.log(`[actors] copied tokenizer assets: ${copiedTokenizerAssets.length}`);
  console.log(`[actors] missing tokenizer assets: ${missingTokenizerAssets.length}`);
  if (missingTokenizerAssets.length) console.log(missingTokenizerAssets.map(entry => `MISSING_TOKENIZER\t${entry.oldPath}\t${entry.sourcePath}`).join("\n"));
  console.log(`[actors] warnings: ${warnings.length}`);
  console.log(`[actors] macro: ${path.join(MACRO_DIR, "01-import-actors.js")}`);
}

async function createActorRecord(actor, folderById, actorDocById, constructTemplateByName) {
  const warnings = [];
  const folderPath = getFolderPath(actor.folder, folderById);
  const type = isConstructActor(actor, folderPath) ? "construct" : "character";
  const creatureMatch = buildCreatureMatch(actor, type, folderPath);
  const prototypeToken = await migratePrototypeToken(actor.prototypeToken, actor);
  const img = await migrateActorAssetPath(actor.img, "icons/svg/mystery-man.svg", {
    actorId: actor._id,
    actorName: actor.name
  });
  const personalGenerator = await migratePersonalGenerator(actor.flags?.["blok-upravleniya"]?.personalGenerator ?? null);
  const constructParts = type === "construct"
    ? buildInstalledConstructParts(actor, actorDocById, constructTemplateByName, warnings)
    : [];

  return {
    id: actor._id,
    name: actor.name,
    type,
    img,
    folderPath: splitFolderPath(folderPath),
    prototypeToken,
    system: buildActorSystem(actor, type),
    creatureMatch,
    personalGenerator,
    constructParts,
    oldType: actor.type,
    warnings
  };
}

function isLostActor(actor, folderById) {
  const folderPath = getFolderPath(actor.folder, folderById);
  return String(folderPath ?? "").toLocaleLowerCase("ru").startsWith("lost");
}

function splitFolderPath(folderPath) {
  return String(folderPath ?? "")
    .split(" / ")
    .map(part => part.trim())
    .filter(Boolean);
}

function buildActorSystem(actor, type) {
  const oldSystem = actor.system ?? {};
  const healthValue = Math.max(0, toInteger(oldSystem.attributes?.hp?.value));
  const healthMax = Math.max(healthValue, toInteger(oldSystem.attributes?.hp?.max) || healthValue);
  const actionPoints = Math.max(0, toInteger(actor.flags?.["blok-upravleniya"]?.currentAP));
  const movementPoints = Math.max(0, toInteger(actor.flags?.["blok-upravleniya"]?.currentMP));

  const system = {
    description: String(oldSystem.details?.biography?.value ?? ""),
    characteristics: migrateCharacteristics(oldSystem.abilities),
    skills: migrateSkills(oldSystem.skills),
    currencies: migrateActorCurrencies(oldSystem.currency),
    resources: {},
    attributes: {
      level: Math.max(1, toInteger(oldSystem.details?.level) || 1),
      initiativeBonus: toInteger(oldSystem.attributes?.init?.bonus)
    },
    development: {
      initialized: false,
      experience: Math.max(0, toInteger(oldSystem.details?.xp?.value))
    }
  };

  if (healthMax > 0) system.resources.health = createResource(healthValue, healthMax);
  if (actionPoints > 0) system.resources.actionPoints = createResource(actionPoints, actionPoints);
  if (movementPoints > 0) system.resources.movementPoints = createResource(movementPoints, movementPoints);
  system.creature = { typeId: "", raceId: "", subtypeId: "" };
  return system;
}

function migrateCharacteristics(abilities = {}) {
  const output = {};
  for (const [oldKey, key] of Object.entries(CHARACTERISTIC_MAP)) {
    output[key] = toInteger(abilities?.[oldKey]?.value);
  }
  return output;
}

function migrateSkills(skills = {}) {
  const output = {};
  for (const [oldKey, key] of Object.entries(SKILL_MAP)) {
    const source = skills?.[oldKey] ?? {};
    const value = toInteger(source.value);
    const bonus = toInteger(source.bonuses?.check) + toInteger(source.bonuses?.passive);
    if (!value && !bonus) continue;
    output[key] = { value, bonus };
  }
  return output;
}

function migrateActorCurrencies(currencies = {}) {
  const output = {};
  for (const [oldKey, value] of Object.entries(currencies ?? {})) {
    const key = OLD_CURRENCY_KEY_FALLBACKS[oldKey] ?? oldKey;
    output[key] = (output[key] ?? 0) + Math.max(0, toInteger(value));
  }
  return output;
}

function createResource(value, max = value) {
  return { min: 0, spent: 0, bonus: 0, value, max };
}

async function migratePrototypeToken(token = {}, actor = {}) {
  if (!token || typeof token !== "object") return null;
  const next = structuredClone(token);
  const actorName = actor?.name ?? "";
  next.name = String(next.name ?? actorName ?? "");
  if (next.texture?.src) next.texture.src = await migrateActorAssetPath(next.texture.src, "", {
    actorId: actor?._id,
    actorName
  });
  if (next.bar1?.attribute === "attributes.hp") next.bar1.attribute = "resources.health";
  if (next.bar2?.attribute === "attributes.hp") next.bar2.attribute = "resources.health";
  delete next.flags;
  return next;
}

async function migratePersonalGenerator(config) {
  if (!config || typeof config !== "object") return null;
  const next = structuredClone(config);
  next.name = migratePersonalGeneratorName(next.name);
  if (next.images) {
    next.images.paths = await Promise.all((Array.isArray(next.images.paths) ? next.images.paths : [])
      .map(pathValue => migrateActorAssetPath(pathValue, ""))
    );
    delete next.images.applyActorImg;
  }
  if (next.currency?.ranges) next.currency.ranges = migrateGeneratorCurrencyRanges(next.currency.ranges);
  if (next.items?.blocks) {
    next.items.blocks = await Promise.all(next.items.blocks.map(block => migrateGeneratorItemBlock(block)));
  }
  return next;
}

function migratePersonalGeneratorName(name = {}) {
  const next = { ...(name ?? {}) };
  const gender = next.gender ?? {};
  const surnameCategories = next.surnameCategories ?? {};
  next.firstNameBlockId = gender.female && !gender.male
    ? "default-female-names"
    : "default-male-names";
  next.surnameBlockId = surnameCategories.noble && !surnameCategories.common
    ? "default-surnames-noble"
    : "default-surnames-common";
  delete next.gender;
  delete next.surnameCategories;
  return next;
}

function migrateGeneratorCurrencyRanges(ranges = {}) {
  const output = {};
  for (const [oldKey, range] of Object.entries(ranges ?? {})) {
    const key = OLD_CURRENCY_KEY_FALLBACKS[oldKey] ?? oldKey;
    output[key] ??= { min: 0, max: 0 };
    output[key].min += Math.max(0, toInteger(range?.min));
    output[key].max += Math.max(0, toInteger(range?.max));
  }
  return output;
}

async function migrateGeneratorItemBlock(block = {}) {
  return {
    ...block,
    pickCurrency: OLD_CURRENCY_KEY_FALLBACKS[block.pickCurrency] ?? block.pickCurrency,
    entries: await Promise.all((Array.isArray(block.entries) ? block.entries : []).map(migrateGeneratorItemEntry))
  };
}

async function migrateGeneratorItemEntry(entry = {}) {
  return {
    ...entry,
    img: await migrateActorAssetPath(entry.img, ""),
    sourceOldId: extractItemOldId(entry.uuid)
  };
}

function buildInstalledConstructParts(actor, actorDocById, constructTemplateByName, warnings) {
  const installed = actor.flags?.["blok-upravleniya"]?.installedProsthetics ?? {};
  const entries = [];
  for (const [slotLabel, rawValue] of Object.entries(installed)) {
    const oldEmbeddedId = typeof rawValue === "string" ? rawValue : String(rawValue?.id ?? "");
    if (!oldEmbeddedId) continue;
    const embedded = actorDocById.get(oldEmbeddedId);
    if (!embedded) {
      warnings.push(`не найден embedded item ${oldEmbeddedId} для ${slotLabel}`);
      continue;
    }
    const template = constructTemplateByName.get(normalizeName(embedded.name));
    if (!template) {
      warnings.push(`не найден шаблон детали для ${embedded.name}`);
      continue;
    }
    const parsed = parseConstructPartMigration(extractDescription(embedded), embedded.name);
    entries.push({
      slotLabel,
      oldEmbeddedId,
      templateOldId: template._id,
      name: embedded.name,
      condition: {
        value: Math.max(0, toInteger(parsed.parsedGear?.conditionValue)),
        max: Math.max(0, toInteger(parsed.parsedGear?.conditionMax))
      },
      integrationDegree: typeof rawValue === "object" ? Math.max(0, toInteger(rawValue.integrationDegree)) : null,
      order: resolveConstructPartOrder(slotLabel, entries.length)
    });
  }
  return entries.sort((left, right) => left.order - right.order);
}

function buildConstructPartTemplateIndex(worldItems, folders) {
  const folderById = new Map(folders.map(folder => [folder._id, folder]));
  const index = new Map();
  for (const item of worldItems) {
    const folderPath = getFolderPath(item.folder, folderById);
    if (folderPath !== "Детали роботов" && !folderPath.startsWith("Детали роботов /")) continue;
    if (folderPath === "Детали роботов / ВСТРОЕННОЕ ОРУЖИЕ") continue;
    if (!index.has(normalizeName(item.name))) index.set(normalizeName(item.name), item);
  }
  return index;
}

function resolveConstructPartOrder(slotLabel, fallbackIndex) {
  const index = SLOT_ORDER.findIndex(label => label === slotLabel);
  return (index >= 0 ? index : fallbackIndex) + 1;
}

function isConstructActor(actor, folderPath = "") {
  return isRobotActor(actor) || isContainerActor(actor, folderPath);
}

function isRobotActor(actor) {
  const name = normalizeName(actor.name);
  return ROBOT_NAME_PATTERNS.some(pattern => name.includes(pattern));
}

function isContainerActor(actor, folderPath = "") {
  const name = normalizeName(actor.name);
  const folder = normalizeName(folderPath);
  return CONTAINER_ACTOR_IDS.has(String(actor?._id ?? ""))
    || folder === "лут"
    || folder.startsWith("лут /")
    || CONTAINER_NAME_PATTERNS.some(pattern => name.includes(pattern));
}

function buildCreatureMatch(actor, type, folderPath = "") {
  if (type === "construct") return { ...CONSTRUCT_CREATURE_MATCH };
  const text = normalizeName(`${folderPath} ${actor?.name ?? ""}`);
  const rule = CREATURE_MATCH_RULES.find(entry => entry.test(text)) ?? CREATURE_MATCH_RULES[CREATURE_MATCH_RULES.length - 1];
  return {
    raceNames: [...rule.raceNames],
    typeNames: [...rule.typeNames]
  };
}

function normalizeName(value = "") {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase("ru");
}

async function migrateActorAssetPath(rawPath, fallback, context = {}) {
  const value = String(rawPath ?? "").trim();
  if (!value) return fallback;
  const decoded = decodeFoundryPath(value);
  if (decoded.startsWith("tokenizer/")) return migrateTokenizerActorAsset(decoded, fallback, context);
  if (decoded.startsWith("Своё/")) return migrateAssetPath(value);
  if (decoded.startsWith("systems/") || decoded.startsWith("icons/") || decoded.startsWith("modules/")) return value;
  return value;
}

async function migrateTokenizerActorAsset(decodedPath, fallback, context = {}) {
  const mapped = TOKENIZER_ACTOR_ASSET_BY_ID[String(context.actorId ?? "")];
  if (mapped) return encodeFoundryWebPath(mapped);

  const cleanPath = decodedPath.split(/[?#]/)[0];
  const fileName = path.basename(cleanPath).replace(/[^\w.-]/g, "_");
  const destinationPath = path.join(IMPORTED_ACTOR_ASSET_DIR, fileName);
  if (fsSync.existsSync(destinationPath)) {
    return encodeFoundryWebPath(`systems/fallout-maw/assets/Personazhi/Imported/${fileName}`);
  }

  const sourcePath = path.join(downloadsDataRoot, ...cleanPath.split("/"));
  if (!fsSync.existsSync(sourcePath)) {
    missingTokenizerAssets.push({ oldPath: decodedPath, sourcePath });
    return fallback || "icons/svg/mystery-man.svg";
  }

  if (!fsSync.existsSync(destinationPath)) {
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.copyFile(sourcePath, destinationPath);
    copiedTokenizerAssets.push({ oldPath: decodedPath, sourcePath, destinationPath });
  }
  return encodeFoundryWebPath(`systems/fallout-maw/assets/Personazhi/Imported/${fileName}`);
}

function decodeFoundryPath(value) {
  try {
    return decodeURIComponent(String(value ?? ""));
  } catch (_error) {
    return String(value ?? "");
  }
}

function encodeFoundryWebPath(value) {
  return String(value ?? "")
    .split("/")
    .map(segment => encodeURIComponent(segment))
    .join("/");
}

function extractItemOldId(uuid = "") {
  const match = String(uuid ?? "").trim().match(/(?:^|\.)(?:Item\.)([A-Za-z0-9]+)$/);
  return match?.[1] ?? String(uuid ?? "").replace(/^Item\./, "");
}

function buildActorMacro(records, buildStamp) {
  return `// Generated by systems/fallout-maw/scripts/generate-actor-migration.mjs
// ${buildStamp}

const ACTOR_RECORDS = ${JSON.stringify(records, null, 2)};

const SYSTEM_ID = ${JSON.stringify(SYSTEM_ID)};
const ROOT_FOLDER = ${JSON.stringify(ROOT_FOLDER)};
const FLAG_SCOPE = "fallout-maw";
const FLAG_KEY = ${JSON.stringify(FLAG_KEY)};
const CONSTRUCT_PART_FLAG_KEY = ${JSON.stringify(CONSTRUCT_PART_FLAG_KEY)};
const OLD_ITEM_ID_ALIASES = ${JSON.stringify(OLD_ITEM_ID_ALIASES)};
const MIGRATION_FLAG_KEYS = ${JSON.stringify(MIGRATION_FLAG_KEYS)};
const NATURAL_RACE_ITEM_FLAG = "naturalRaceItem";

const missingItemReferences = new Map();
const skippedNaturalItems = [];
const constructPartErrors = [];
const creatureSelectionFallbacks = [];

await runActorImport();

async function runActorImport() {
  if (game.system.id !== SYSTEM_ID) {
    ui.notifications.error("Этот макрос рассчитан на систему fallout-maw.");
    return;
  }

  const touched = [];
  for (const record of ACTOR_RECORDS) {
    const folderId = await ensureFolderPath([ROOT_FOLDER, ...record.folderPath]);
    let actor = findExistingMigrationActor(record);
    if (!actor) {
      actor = await createActorWithPreferredId({
        _id: record.id,
        name: record.name,
        type: record.type,
        img: record.img,
        folder: folderId,
        flags: buildActorMigrationFlags(record)
      });
    }

    if (actor.type !== record.type) {
      if (actor.getFlag(FLAG_SCOPE, FLAG_KEY)?.oldId === record.id) {
        await actor.delete();
        actor = await createActorWithPreferredId({
          _id: record.id,
          name: record.name,
          type: record.type,
          img: record.img,
          folder: folderId,
          flags: buildActorMigrationFlags(record)
        });
      } else {
        throw new Error("Существующий актор \\"" + actor.name + "\\" имеет тип \\"" + actor.type + "\\", а импорт ожидает \\"" + record.type + "\\". Удали его или переименуй перед повторным запуском.");
      }
    }

    const system = foundry.utils.deepClone(record.system);
    applyCreatureSelection(system, record);

    await actor.update({
      name: record.name,
      img: record.img,
      folder: folderId,
      prototypeToken: record.prototypeToken,
      system,
      flags: buildActorMigrationFlags(record)
    });

    if (record.personalGenerator) {
      const config = rewritePersonalGeneratorConfig(record.personalGenerator);
      await actor.setFlag(SYSTEM_ID, "personalGenerator", config);
    } else if (actor.getFlag(SYSTEM_ID, "personalGenerator")) {
      await actor.unsetFlag(SYSTEM_ID, "personalGenerator");
    }

    if (record.type === "construct") await installConstructParts(actor, record.constructParts, record);
    touched.push(actor);
  }

  const removedFlatFolders = await cleanupFlatActorImportFolders();
  const missingCount = Array.from(missingItemReferences.values()).reduce((sum, entry) => sum + entry.count, 0);
  if (missingCount || constructPartErrors.length || creatureSelectionFallbacks.length) {
    ui.notifications.warn(\`Импорт акторов: \${touched.length}. Не найдено ссылок генератора: \${missingCount}. Ошибок деталей: \${constructPartErrors.length}. Fallback рас: \${creatureSelectionFallbacks.length}.\`);
    console.warn("actorMigration import warnings", {
      missingItemReferences: Array.from(missingItemReferences.values()),
      skippedNaturalItems,
      constructPartErrors,
      creatureSelectionFallbacks,
      removedFlatFolders
    });
    if (missingItemReferences.size) console.table(Array.from(missingItemReferences.values()).sort((left, right) => right.count - left.count));
    if (creatureSelectionFallbacks.length) console.table(creatureSelectionFallbacks);
  } else {
    ui.notifications.info(\`Импорт акторов: \${touched.length}. Генераторы, расы и детали применены.\`);
  }
  console.log("actorMigration import", {
    touched: touched.length,
    missingItemReferences: Array.from(missingItemReferences.values()),
    skippedNaturalItems,
    constructPartErrors,
    creatureSelectionFallbacks,
    removedFlatFolders
  });
}

function buildActorMigrationFlags(record) {
  return {
    [FLAG_SCOPE]: {
      [FLAG_KEY]: {
        oldId: record.id,
        oldType: record.oldType,
        sourceWorld: "fallout-old"
      }
    }
  };
}

function applyCreatureSelection(system, record = {}) {
  if (record.type !== "character") {
    system.creature = { typeId: "", raceId: "", subtypeId: "" };
    return;
  }
  system.creature = resolveCreatureSelection(record.creatureMatch, record);
}

function resolveCreatureSelection(match = {}, record = {}) {
  const creatureOptions = getCreatureOptions();
  const types = Array.isArray(creatureOptions.types) ? creatureOptions.types : [];
  const races = Array.isArray(creatureOptions.races) ? creatureOptions.races : [];
  if (!races.length) return { typeId: "", raceId: "", subtypeId: "" };

  const raceNames = Array.isArray(match?.raceNames) ? match.raceNames : [];
  const typeNames = Array.isArray(match?.typeNames) ? match.typeNames : [];
  const requestedType = findNamedCreatureEntry(types, typeNames);
  const requestedRace = findNamedCreatureEntry(races, raceNames);
  const exactRace = requestedRace && (!requestedType || requestedRace.typeId === requestedType.id)
    ? requestedRace
    : null;
  const race = exactRace
    ?? (requestedType ? findNamedCreatureEntry(races.filter(entry => entry.typeId === requestedType.id), raceNames) : null)
    ?? (requestedType ? races.find(entry => entry.typeId === requestedType.id) : null)
    ?? requestedRace
    ?? races[0];

  if (!exactRace) {
    creatureSelectionFallbacks.push({
      actor: record.name,
      actorType: record.type,
      wantedRace: raceNames.join(", "),
      wantedType: typeNames.join(", "),
      selectedRace: race?.name ?? "",
      selectedType: types.find(entry => entry.id === race?.typeId)?.name ?? ""
    });
  }

  return {
    typeId: race?.typeId || requestedType?.id || "",
    raceId: race?.id ?? "",
    subtypeId: getFirstCreatureSubtypeId(race)
  };
}

function getCreatureOptions() {
  try {
    return game.settings.get(SYSTEM_ID, "creatureOptions") ?? {};
  } catch (error) {
    console.warn("actorMigration creatureOptions unavailable", error);
    return {};
  }
}

function findNamedCreatureEntry(entries = [], names = []) {
  const wanted = names.map(normalizeCreatureName).filter(Boolean);
  if (!wanted.length) return null;
  const normalizedEntries = entries.map(entry => ({
    entry,
    id: normalizeCreatureName(entry?.id),
    name: normalizeCreatureName(entry?.name)
  }));
  return normalizedEntries.find(row => wanted.includes(row.id) || wanted.includes(row.name))?.entry
    ?? normalizedEntries.find(row => wanted.some(name => row.name.includes(name) || name.includes(row.name)))?.entry
    ?? null;
}

function normalizeCreatureName(value = "") {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase("ru");
}

function getFirstCreatureSubtypeId(race = {}) {
  const sets = Array.isArray(race?.naturalItemSets) ? race.naturalItemSets : [];
  return String(sets.find(entry => entry?.id)?.id ?? "");
}

async function createActorWithPreferredId(data) {
  try {
    return await Actor.create(data);
  } catch (error) {
    console.warn("Не удалось создать актора с исходным id, создаю с новым id.", data._id, error);
    const fallback = foundry.utils.deepClone(data);
    delete fallback._id;
    return Actor.create(fallback);
  }
}

function findExistingMigrationActor(record) {
  const byFlag = game.actors.find(actor => actor.getFlag(FLAG_SCOPE, FLAG_KEY)?.oldId === record.id);
  if (byFlag) return byFlag;
  const byId = game.actors.get(record.id);
  if (byId?.name === record.name) return byId;
  return null;
}

function rewritePersonalGeneratorConfig(config) {
  const next = foundry.utils.deepClone(config ?? {});
  next.currency = rewriteGeneratorCurrency(next.currency);
  next.items = rewriteGeneratorItems(next.items);
  return next;
}

function rewriteGeneratorCurrency(currency = {}) {
  const valid = new Set(getCurrencySettings().map(entry => entry.key));
  const primary = getPrimaryCurrencyKey();
  const ranges = {};
  for (const [key, range] of Object.entries(currency?.ranges ?? {})) {
    const nextKey = valid.has(key) ? key : primary;
    ranges[nextKey] ??= { min: 0, max: 0 };
    ranges[nextKey].min += Math.max(0, toInteger(range?.min));
    ranges[nextKey].max += Math.max(0, toInteger(range?.max));
  }
  return { ...(currency ?? {}), ranges };
}

function rewriteGeneratorItems(items = {}) {
  const blocks = [];
  for (const block of items?.blocks ?? []) {
    const entries = [];
    for (const entry of block.entries ?? []) {
      const resolved = resolveGeneratorItem(entry);
      if (!resolved) continue;
      entries.push({
        ...entry,
        uuid: resolved.uuid,
        name: resolved.name,
        img: resolved.img,
        hasCondition: resolved.hasCondition,
        hasDurability: resolved.hasCondition
      });
    }
    blocks.push({
      ...block,
      pickCurrency: getValidCurrencyKey(block.pickCurrency),
      entries
    });
  }
  return { ...(items ?? {}), blocks };
}

function resolveGeneratorItem(entry = {}) {
  const oldId = extractItemOldId(entry.sourceOldId || entry.uuid);
  const item = findItemByOldIdOrName(oldId, entry.name);
  if (!item) {
    addMissingItemReference(oldId, entry.name);
    return null;
  }
  if (isNaturalRaceItem(item)) {
    skippedNaturalItems.push({ oldId, name: item.name });
    return null;
  }
  return {
    uuid: item.uuid,
    name: item.name,
    img: item.img,
    hasCondition: hasItemFunction(item, "condition")
  };
}

async function installConstructParts(actor, parts = [], record = {}) {
  const previous = actor.items.filter(item => item.getFlag(FLAG_SCOPE, CONSTRUCT_PART_FLAG_KEY)?.oldActorId === record.id);
  if (previous.length) await actor.deleteEmbeddedDocuments("Item", previous.map(item => item.id));

  const creates = [];
  for (const part of parts) {
    const template = findConstructPartTemplate(part);
    if (!template) {
      constructPartErrors.push({ actor: record.name, part: part.name, oldEmbeddedId: part.oldEmbeddedId, reason: "template-not-found" });
      continue;
    }
    const data = foundry.utils.deepClone(template.toObject());
    delete data._id;
    delete data.id;
    delete data.folder;
    foundry.utils.mergeObject(data, {
      system: {
        equipped: false,
        locked: true,
        container: { parentId: "" },
        placement: {
          mode: "constructPart",
          equipmentSlot: "",
          weaponSet: "",
          weaponSlot: "",
          limbKey: "",
          constructPartOrder: part.order,
          x: 1,
          y: 1,
          width: Math.max(1, toInteger(data.system?.placement?.width) || 1),
          height: Math.max(1, toInteger(data.system?.placement?.height) || 1),
          rotated: false
        }
      },
      flags: {
        [FLAG_SCOPE]: {
          ...(data.flags?.[FLAG_SCOPE] ?? {}),
          [CONSTRUCT_PART_FLAG_KEY]: {
            oldActorId: record.id,
            oldEmbeddedId: part.oldEmbeddedId,
            templateOldId: part.templateOldId,
            slotLabel: part.slotLabel
          }
        }
      }
    }, { inplace: true });
    if (part.condition?.max > 0) {
      foundry.utils.setProperty(data, "system.functions.condition.value", Math.max(0, part.condition.value));
      foundry.utils.setProperty(data, "system.functions.condition.max", Math.max(part.condition.value, part.condition.max));
    }
    creates.push(data);
  }
  if (creates.length) await actor.createEmbeddedDocuments("Item", creates);
}

function findConstructPartTemplate(part = {}) {
  const byOldId = findItemByMigrationOldId(part.templateOldId);
  if (byOldId && hasItemFunction(byOldId, "constructPart")) return byOldId;
  const byName = findItemByName(part.name, item => hasItemFunction(item, "constructPart"));
  return byName;
}

function findItemByOldIdOrName(oldId = "", name = "") {
  return findItemByMigrationOldId(oldId)
    ?? game.items.get(resolveAlias(oldId))
    ?? findItemByName(name)
    ?? null;
}

function findItemByMigrationOldId(oldId = "") {
  const resolvedOldId = resolveAlias(oldId);
  for (const flagKey of MIGRATION_FLAG_KEYS) {
    const byFlag = game.items.find(item => item.getFlag(FLAG_SCOPE, flagKey)?.oldId === resolvedOldId)
      ?? game.items.find(item => item.getFlag(FLAG_SCOPE, flagKey)?.oldId === oldId);
    if (byFlag) return byFlag;
  }
  return null;
}

function findItemByName(name = "", predicate = null) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) return null;
  const matches = game.items.filter(item => item.name === trimmed && (!predicate || predicate(item)));
  if (!matches.length) return null;
  if (matches.length === 1) return matches[0];
  for (const flagKey of MIGRATION_FLAG_KEYS) {
    const migrated = matches.find(item => item.getFlag(FLAG_SCOPE, flagKey));
    if (migrated) return migrated;
  }
  return matches[0];
}

function resolveAlias(oldId = "") {
  const sourceOldId = extractItemOldId(oldId);
  return OLD_ITEM_ID_ALIASES[sourceOldId] ?? OLD_ITEM_ID_ALIASES[oldId] ?? sourceOldId;
}

function extractItemOldId(uuid = "") {
  const raw = String(uuid ?? "").trim();
  const itemMatch = raw.match(/(?:^|\\.)(?:Item\\.)([A-Za-z0-9]+)$/);
  return itemMatch?.[1] ?? raw.replace(/^Item\\./, "");
}

function hasItemFunction(item, functionKey) {
  return Boolean(item?.system?.functions?.[functionKey]?.enabled);
}

function isNaturalRaceItem(item) {
  return Boolean(item?.getFlag?.(SYSTEM_ID, NATURAL_RACE_ITEM_FLAG) ?? item?.flags?.[SYSTEM_ID]?.[NATURAL_RACE_ITEM_FLAG]);
}

function addMissingItemReference(oldId, name) {
  const key = oldId || name || "unknown";
  const current = missingItemReferences.get(key) ?? { oldId, name, count: 0 };
  current.count += 1;
  missingItemReferences.set(key, current);
}

function getCurrencySettings() {
  return game.settings.get(SYSTEM_ID, "currencySettings") ?? [];
}

function getPrimaryCurrencyKey() {
  const currencies = getCurrencySettings();
  return String((currencies.find(currency => currency.primaryTrade) ?? currencies[0])?.key ?? "");
}

function getValidCurrencyKey(key = "") {
  const valid = new Set(getCurrencySettings().map(entry => entry.key));
  return valid.has(key) ? key : getPrimaryCurrencyKey();
}

async function ensureFolderPath(parts) {
  let parentId = null;
  for (const name of parts.filter(Boolean)) {
    let folder = game.folders.find(candidate => (
      candidate.type === "Actor"
      && candidate.name === name
      && getFolderParentId(candidate) === parentId
    ));
    if (!folder) folder = await Folder.create({ name, type: "Actor", folder: parentId });
    parentId = folder.id;
  }
  return parentId;
}

async function cleanupFlatActorImportFolders() {
  const folders = () => Array.from(game.folders ?? []);
  const root = folders().find(folder => (
    folder.type === "Actor"
    && folder.name === ROOT_FOLDER
    && !getFolderParentId(folder)
  ));
  if (!root) return [];

  const removed = [];
  let changed = true;
  while (changed) {
    changed = false;
    const candidates = folders().filter(folder => (
      folder.type === "Actor"
      && getFolderParentId(folder) === root.id
      && (String(folder.name ?? "").includes(" / ") || normalizeCreatureName(folder.name).startsWith("lost"))
      && isActorFolderEmpty(folder)
    ));
    for (const folder of candidates) {
      removed.push(folder.name);
      await folder.delete();
      changed = true;
    }
  }
  return removed;
}

function isActorFolderEmpty(folder) {
  const folderId = folder.id;
  const hasChildFolder = Array.from(game.folders ?? []).some(candidate => (
    candidate.type === "Actor" && getFolderParentId(candidate) === folderId
  ));
  const hasActor = Array.from(game.actors ?? []).some(actor => getActorFolderId(actor) === folderId);
  return !hasChildFolder && !hasActor;
}

function getActorFolderId(actor) {
  return actor?.folder?.id ?? actor?.folder ?? null;
}

function getFolderParentId(folder) {
  return folder.folder?.id ?? folder.folder ?? null;
}

function toInteger(value) {
  const parsed = Number.parseInt(String(value ?? "").replace(/[^\\d-]/g, ""), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}
`;
}

function buildPasteMacro() {
  return `// Fallout-MaW actor migration: one Foundry macro.
// Вставьте весь этот скрипт в один макрос Foundry (Script) и запустите от GM.

const SYSTEM_ID = "fallout-maw";
const BASE_PATH = "systems/fallout-maw/scripts/migration-macros/actors";
const IMPORT_FILE = "01-import-actors.js";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

if (game.system.id !== SYSTEM_ID) {
  ui.notifications.error("Этот макрос рассчитан только на систему fallout-maw.");
  return;
}

ui.notifications.info("Импорт акторов: старт...");

const url = \`\${BASE_PATH}/\${IMPORT_FILE}\`;
const response = await fetch(url, { cache: "no-cache" });
if (!response.ok) throw new Error(\`Не удалось загрузить \${url}: HTTP \${response.status}\`);
const code = await response.text();
await new AsyncFunction(code)();

ui.notifications.info("Импорт акторов: завершён.");
`;
}

function buildReadme(records, buildStamp) {
  return `# Миграция акторов

Сгенерировано: \`${buildStamp}\`

- Акторов: ${records.length}
- Конструктов: ${records.filter(record => record.type === "construct").length}
- Акторов с персональным генератором: ${records.filter(record => record.personalGenerator).length}
- Установленных деталей конструктов: ${records.reduce((sum, record) => sum + record.constructParts.length, 0)}

Запуск: создайте Foundry macro типа Script и вставьте \`00-PASTE-INTO-FOUNDRY-MACRO.js\`.
`;
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
