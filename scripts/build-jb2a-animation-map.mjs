import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ANIMATION_DATABASE } from "../src/generated/animation-database.mjs";
import { readLevelDocuments, extractDescription } from "./generate-material-migration.mjs";
import { stripGearHtml } from "./gear-description-parser.mjs";
import { JB2A_MANUAL_OVERRIDES } from "./weapon-media-migration.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const systemRoot = path.resolve(__dirname, "..");
const OLD_WORLD_ITEMS = path.resolve(systemRoot, "..", "..", "fallout-old", "data", "items");
const SYSTEM_ID = "fallout-maw";
const OUTPUT_PATH = path.join(__dirname, "generated", "jb2a-animation-map.json");

const DISTANCE_PATTERN = /(?:^|[_\-\s])(\d{1,3})(ft|m)(?=$|[_\-\s])/i;
const DIMENSION_PATTERN = /[_\-\s]\d{2,5}x\d{2,5}$/i;
const THUMB_PATTERN = /(?:^|[_\-\s])thumb(?:$|[_\-\s])/i;

const animationGroups = buildAnimationGroups(ANIMATION_DATABASE.files);
const jb2aKeys = await collectJb2aKeys();
const { map, unresolved } = buildJb2aMap(jb2aKeys, animationGroups);

await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(map, null, 2)}\n`, "utf8");

console.log(`jb2a keys: ${jb2aKeys.length}`);
console.log(`mapped: ${Object.keys(map).length}`);
console.log(`unresolved: ${unresolved.length}`);
if (unresolved.length) console.log(unresolved.join("\n"));

function normalizeKeySegment(segment) {
  return String(segment ?? "")
    .trim()
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function cleanAnimationStem(stem) {
  return String(stem ?? "")
    .replace(THUMB_PATTERN, "_")
    .replace(DISTANCE_PATTERN, "_")
    .replace(DIMENSION_PATTERN, "")
    .replace(/[_\-\s]+$/g, "")
    .replace(/^[_\-\s]+/g, "");
}

function buildAnimationGroups(files = []) {
  const groupMap = new Map();
  for (const relativePath of files) {
    const segments = relativePath.split("/");
    const filename = segments.pop() ?? "";
    const stem = filename.replace(/\.[^.]+$/, "");
    if (THUMB_PATTERN.test(stem)) continue;
    const cleanedStem = cleanAnimationStem(stem);
    const key = [
      SYSTEM_ID,
      ...segments.map(normalizeKeySegment),
      normalizeKeySegment(cleanedStem)
    ].filter(Boolean).join(".");
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        key,
        folder: segments.join("/"),
        label: cleanedStem || stem,
        tokens: tokenize(`${segments.join(" ")} ${cleanedStem} ${stem}`)
      });
    }
  }
  return Array.from(groupMap.values());
}

function tokenize(value = "") {
  return String(value ?? "")
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 2);
}

async function collectJb2aKeys() {
  const items = await readLevelDocuments(OLD_WORLD_ITEMS);
  const keys = new Set();
  for (const item of items) {
    if (item.type !== "weapon") continue;
    const flat = stripGearHtml(extractDescription(item)).replace(/\s+/g, " ");
    for (const pattern of [
      /Путь\s+анимации[^:]*:\s*(\S+)/ig,
      /Путь\s+анимации\s+взрыва[^:]*:\s*(\S+)/ig
    ]) {
      let match;
      while ((match = pattern.exec(flat)) !== null) {
        const key = String(match[1] ?? "").trim();
        if (key && key !== "Путь") keys.add(key.toLowerCase());
      }
    }
  }
  return Array.from(keys).sort();
}

function buildJb2aMap(jb2aKeys, groups) {
  const map = { ...JB2A_MANUAL_OVERRIDES };
  const unresolved = [];
  for (const rawKey of jb2aKeys) {
    const lower = String(rawKey).toLowerCase();
    if (map[lower]) continue;
    const converted = convertJb2aKey(rawKey, groups);
    if (converted) map[lower] = converted;
    else unresolved.push(rawKey);
  }
  return { map, unresolved };
}

function convertJb2aKey(rawKey, groups) {
  const key = String(rawKey ?? "").trim();
  if (!key || key === "Путь") return "";
  if (key.startsWith(`${SYSTEM_ID}.`)) return key;
  if (key.startsWith("systems/")) return key;

  const normalized = key.toLowerCase().replace(/^jb2a\./, "");
  const direct = convertJb2aDirect(normalized);
  if (direct && groups.some(group => group.key === direct)) return direct;

  const jb2aTokens = tokenize(normalized.replace(/\./g, " "));
  let best = null;
  let bestScore = 0;
  for (const group of groups) {
    const score = scoreGroupMatch(jb2aTokens, group);
    if (score > bestScore) {
      bestScore = score;
      best = group;
    }
  }
  if (best && bestScore >= 3) return best.key;
  return "";
}

function convertJb2aDirect(normalized) {
  const parts = normalized.split(".").filter(Boolean);
  if (parts[0] === "bullet" && parts.length >= 3) {
    if (parts[1] === "snipe") {
      return `${SYSTEM_ID}.generic.weapon_attacks.ranged.snipe_01_regular_${parts[2]}`;
    }
    const num = parts[1].padStart(2, "0");
    return `${SYSTEM_ID}.generic.weapon_attacks.ranged.bullet_${num}_regular_${parts[2]}`;
  }
  if (parts[0] === "fire" && parts[1] === "bolt" && parts[2]) {
    return `${SYSTEM_ID}.cantrip.fire_bolt.fire_bolt_01_regular_${parts[2]}`;
  }
  if (parts[0] === "melee" && parts[1] === "attack" && parts[2] && parts[3]) {
    const group = `group${parts[2].padStart(2, "0")}`;
    const weapon = parts[3];
    return `${SYSTEM_ID}.generic.weapon_attacks.melee.${group}.meleeattack${parts[2]}_${weapon}01`;
  }
  return "";
}

function scoreGroupMatch(jb2aTokens, group) {
  const haystack = `${group.key} ${group.label} ${group.folder}`.toLowerCase();
  let score = 0;
  for (const token of jb2aTokens) {
    if (haystack.includes(token)) score += 1;
  }
  const groupNumber = jb2aTokens.find(token => /^\d+$/.test(token));
  if (groupNumber && haystack.includes(`group${groupNumber.padStart(2, "0")}`)) score += 2;
  return score;
}
