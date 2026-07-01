import path from "path";
import { fileURLToPath } from "node:url";
import { readLevelDocuments, extractDescription, getFolderPath } from "./generate-material-migration.mjs";
import { stripGearHtml, parseWeaponMigration } from "./gear-description-parser.mjs";

const items = await readLevelDocuments(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fallout-old", "data", "items"));
const folders = await readLevelDocuments(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fallout-old", "data", "folders"));
const folderById = new Map(folders.map(f => [f._id, f]));

const spear = items.find(i => i._id === "L4sOYN8dz1Q9aWhy");
const html = extractDescription(spear);
const flat = stripGearHtml(html).replace(/\s+/g, " ");
console.log("flat costs:", flat.match(/Потеря[^]+?(?=Максимальная|ДОСТУП|ЗАНИМАЕТ|$)/gi));
for (const id of ["bu-skill-fields"]) {
  const m = html.match(new RegExp(`id="${id}"[^>]*>([^<]+)`, "i"));
  if (m) console.log(id, m[1].slice(0, 800));
}

const parsed = parseWeaponMigration(html, spear.name);
console.log("\nprimary resourceCosts", parsed.primary.resourceCosts);
console.log("throw resourceCosts", parsed.additionalWeapons[0]?.resourceCosts);

// sample ranged same rarity
const spearRarity = flat.match(/Редкость:\s*(\S+)/i)?.[1];
console.log("\nrarity", spearRarity);
const ranged = items.filter(i => {
  if (i.type !== "weapon") return false;
  const f = stripGearHtml(extractDescription(i)).replace(/\s+/g, " ");
  return f.includes(`Редкость: ${spearRarity}`) && /Потеря\s+прочности\s+за\s+выстрел/i.test(f);
}).slice(0, 3);
for (const r of ranged) {
  const f = stripGearHtml(extractDescription(r)).replace(/\s+/g, " ");
  const loss = f.match(/Потеря\s+прочности\s+за\s+выстрел:\s*(\d+)/i)?.[1];
  console.log("ranged ref", r.name, "loss", loss);
}
