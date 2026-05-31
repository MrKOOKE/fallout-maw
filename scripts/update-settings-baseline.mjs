import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const systemRoot = path.resolve(__dirname, "..");
const baselinePath = path.join(systemRoot, "src", "settings", "baseline-data.mjs");

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: node scripts/update-settings-baseline.mjs <snapshot.json>");
  process.exit(1);
}

const raw = await fs.readFile(path.resolve(inputPath), "utf8");
const snapshot = JSON.parse(raw);

if (snapshot.system !== "fallout-maw") {
  throw new Error(`Snapshot system must be fallout-maw, got ${snapshot.system ?? "<missing>"}.`);
}
if (!snapshot.settings || typeof snapshot.settings !== "object" || Array.isArray(snapshot.settings)) {
  throw new Error("Snapshot must contain a settings object.");
}

const settings = Object.fromEntries(
  Object.entries(snapshot.settings)
    .filter(([id, entry]) => id.startsWith("fallout-maw.") && entry && Object.hasOwn(entry, "value"))
    .sort(([left], [right]) => left.localeCompare(right))
);

const baseline = {
  version: Number(snapshot.version) || 1,
  system: "fallout-maw",
  createdAt: snapshot.createdAt ?? new Date().toISOString(),
  sourceWorld: snapshot.sourceWorld ?? null,
  settings
};

const contents = `export const SETTINGS_BASELINE_VERSION = ${baseline.version};

export const SETTINGS_BASELINE = Object.freeze(${JSON.stringify(baseline, null, 2)});
`;

await fs.writeFile(baselinePath, contents, "utf8");
console.log(`Updated ${path.relative(systemRoot, baselinePath)} with ${Object.keys(settings).length} settings.`);
