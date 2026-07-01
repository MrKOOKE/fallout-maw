import path from "path";
import { fileURLToPath } from "node:url";
import { readLevelDocuments, extractDescription } from "./generate-material-migration.mjs";
import { stripGearHtml, parseWeaponMigration } from "./gear-description-parser.mjs";

function extractInlineJsonBlobs(flatText = "") {
  const blobs = [];
  for (const match of String(flatText ?? "").matchAll(/\{"version":1,[\s\S]+?\}(?=\s*\{|\s*Путь|\s*ТРЕБОВАНИЯ|$)/g)) {
    try { blobs.push(JSON.parse(match[0])); } catch { /* ignore */ }
  }
  return blobs;
}

const items = await readLevelDocuments(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fallout-old", "data", "items"));

function parseFields(html) {
  const m = html.match(/id="bu-skill-fields"[^>]*>([^<]+)/i);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function parseBindings(html) {
  const m = html.match(/id="bu-skill-bindings"[^>]*>([^<]+)/i);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function getSkillModes(item) {
  const html = extractDescription(item);
  const flat = stripGearHtml(html).replace(/\s+/g, " ");
  for (const blob of extractInlineJsonBlobs(flat)) {
    if (blob?.modes) return blob.modes;
  }
  const b = parseBindings(html);
  return b?.modes ?? [];
}

const throwWeapons = items.filter(i => {
  if (i.type !== "weapon") return false;
  return getSkillModes(i).some(m => /метан/i.test(m.label));
});

console.log("throw weapons", throwWeapons.length);

for (const w of throwWeapons.slice(0, 3)) {
  const html = extractDescription(w);
  const flat = stripGearHtml(html).replace(/\s+/g, " ");
  const fields = parseFields(html);
  const bindings = parseBindings(html);
  const inline = extractInlineJsonBlobs(flat);
  const throwMode = (bindings?.modes ?? inline.find(b => b.modes)?.modes ?? []).find(m => /метан/i.test(m.label));
  const fieldBlob = fields ?? inline.find(b => b.fields);
  const throwFields = throwMode ? fieldBlob?.fields?.[throwMode.id] : null;
  console.log("\n===", w.name, w._id, "===");
  console.log("modes", (bindings?.modes ?? inline.find(b => b.modes)?.modes ?? []).map(m => m.label));
  console.log("system.quantity", w.system?.quantity);
  console.log("flat patterns:", {
    multiplier: flat.match(/Множитель[^:]{0,30}:\s*([\d.,]+)/gi),
    lossShot: flat.match(/Потеря\s+прочности\s+за\s+выстрел:\s*(\d+)/i)?.[1],
    lossMult: flat.match(/Множитель\s+потери\s+прочности:\s*([\d.,]+)/i)?.[1]
  });
  console.log("throw durabilityLoss", throwFields?.durabilityLoss);
  const parsed = parseWeaponMigration(html, w.name);
  console.log("parsed primary costs", parsed.primary.resourceCosts, parsed.primary.skillKey);
  console.log("parsed additional", parsed.additionalWeapons.map(a => ({ name: a.name, costs: a.resourceCosts, skill: a.skillKey })));
}

// melee with skill modes - check durabilityLoss distribution
const meleeSkill = items.filter(i => {
  if (i.type !== "weapon") return false;
  const f = parseFields(extractDescription(i));
  return f?.fields && Object.values(f.fields).some(v => v?.weaponType && !/дальн/i.test(v.weaponType));
}).slice(0, 0);

const rarityMap = new Map();
for (const i of items) {
  if (i.type !== "weapon") continue;
  const flat = stripGearHtml(extractDescription(i)).replace(/\s+/g, " ");
  const rarity = flat.match(/Редкость:\s*(\S+)/i)?.[1];
  const loss = flat.match(/Потеря\s+прочности\s+за\s+выстрел:\s*(\d+)/i)?.[1];
  if (!rarity || !loss) continue;
  if (!rarityMap.has(rarity)) rarityMap.set(rarity, []);
  rarityMap.get(rarity).push({ name: i.name, loss: Number(loss) });
}

console.log("\n=== Ranged condition loss by rarity ===");
for (const [rarity, list] of rarityMap) {
  const losses = [...new Set(list.map(x => x.loss))].sort((a, b) => a - b);
  console.log(rarity, "unique losses:", losses.join(", "), "count", list.length);
}

const spear = items.find(i => i._id === "L4sOYN8dz1Q9aWhy");
const parsed = parseWeaponMigration(extractDescription(spear), spear.name);
console.log("\n=== SPEAR parsed costs ===");
console.log("primary", parsed.primary.resourceCosts, "skill", parsed.primary.skillKey);
console.log("throw", parsed.additionalWeapons[0]?.resourceCosts, "skill", parsed.additionalWeapons[0]?.skillKey);

const skillLosses = [];
for (const i of items) {
  if (i.type !== "weapon") continue;
  const flat = stripGearHtml(extractDescription(i)).replace(/\s+/g, " ");
  const shotLoss = parseInteger(flat.match(/Потеря\s+прочности\s+за\s+выстрел:\s*(\d+)/i)?.[1]);
  const multLoss = parseFloat(String(flat.match(/Множитель\s+потери\s+прочности:\s*([\d.,]+)/i)?.[1] ?? "").replace(",", "."));
  const rarity = flat.match(/Редкость:\s*(\S+)/)?.[1] ?? "";
  for (const blob of extractInlineJsonBlobs(flat)) {
    for (const [modeId, fields] of Object.entries(blob.fields ?? {})) {
      const mode = blob.modes?.find(m => m.id === modeId);
      skillLosses.push({
        id: i._id,
        name: i.name,
        rarity,
        shotLoss,
        multLoss,
        durabilityLoss: fields.durabilityLoss,
        modeLabel: mode?.label ?? fields.weaponType
      });
    }
  }
}

function parseInteger(v) { return Math.max(0, Number.parseInt(String(v ?? "0"), 10) || 0); }

console.log("\n=== Melee low durabilityLoss (no shot loss) ===");
console.log(skillLosses.filter(x => !x.shotLoss && x.durabilityLoss <= 5).slice(0, 15));

console.log("\n=== Throw modes durabilityLoss ===");
console.log(skillLosses.filter(x => /метан/i.test(String(x.modeLabel))).slice(0, 10));

console.log("\n=== MultLoss in flat text ===");
const multSamples = items.filter(i => {
  const flat = stripGearHtml(extractDescription(i)).replace(/\s+/g, " ");
  return /Множитель\s+потери\s+прочности/i.test(flat);
}).slice(0, 8);
for (const i of multSamples) {
  const flat = stripGearHtml(extractDescription(i)).replace(/\s+/g, " ");
  console.log(i.name, flat.match(/Множитель\s+потери\s+прочности:\s*([\d.,]+)/i)?.[1], "shot", flat.match(/Потеря\s+прочности\s+за\s+выстрел:\s*(\d+)/i)?.[1]);
}

console.log("\n=== Median ranged loss by rarity ===");
for (const [rarity, list] of rarityMap) {
  const losses = list.map(x => x.loss).filter(x => x > 0).sort((a, b) => a - b);
  if (!losses.length) continue;
  const med = losses[Math.floor(losses.length / 2)];
  console.log(rarity, "median", med, "from", losses.length, "ranged weapons");
}
