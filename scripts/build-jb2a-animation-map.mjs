import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readLevelDocuments, extractDescription } from "./generate-material-migration.mjs";
import { stripGearHtml } from "./gear-description-parser.mjs";
import { buildJb2aAnimationMap } from "./jb2a-key-resolver.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const systemRoot = path.resolve(__dirname, "..");
const OLD_WORLD_ITEMS = path.resolve(systemRoot, "..", "..", "fallout-old", "data", "items");
const OUTPUT_PATH = path.join(__dirname, "generated", "jb2a-animation-map.json");

const jb2aKeys = await collectJb2aKeys();
const map = await buildJb2aAnimationMap({ jb2aKeys });

const unresolved = jb2aKeys.filter(key => !map[key]);

await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(map, null, 2)}\n`, "utf8");

console.log(`jb2a keys in old world: ${jb2aKeys.length}`);
console.log(`map entries: ${Object.keys(map).length}`);
console.log(`unresolved: ${unresolved.length}`);
if (unresolved.length) console.log(unresolved.join("\n"));

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
        if (key && key.toLowerCase() !== "путь") keys.add(key.toLowerCase());
      }
    }
  }
  return Array.from(keys).sort();
}
