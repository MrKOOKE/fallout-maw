import fs from "node:fs/promises";
import path from "node:path";

const SYSTEM_ID = "fallout-maw";
const ROOT = `systems/${SYSTEM_ID}/Library-animation`;
const MEDIA_EXTENSIONS = new Set(["webm", "mp4", "m4v", "webp", "png", "jpg", "jpeg", "gif", "ogg", "mp3", "wav"]);

const systemRoot = path.resolve(import.meta.dirname, "..");
const libraryRoot = path.join(systemRoot, "Library-animation");
const outputPath = path.join(systemRoot, "src", "generated", "animation-database.mjs");

const files = await collectFiles(libraryRoot);
const database = {
  root: ROOT,
  files: files
    .filter(file => MEDIA_EXTENSIONS.has(getExtension(file)))
    .map(file => file.slice(ROOT.length).replace(/^[/\\]+/, ""))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true })),
  updatedAt: Date.now()
};

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(
  outputPath,
  `export const ANIMATION_DATABASE = ${JSON.stringify(database)};\n`,
  "utf8"
);

console.log(`Animation database built: ${database.files.length} files`);

async function collectFiles(directory) {
  const result = [];
  const items = await fs.readdir(directory, { withFileTypes: true });
  for (const item of items) {
    const absolutePath = path.join(directory, item.name);
    if (item.isDirectory()) {
      result.push(...await collectFiles(absolutePath));
    } else if (item.isFile()) {
      const relative = path.relative(systemRoot, absolutePath).replace(/\\/g, "/");
      result.push(`systems/${SYSTEM_ID}/${relative}`);
    }
  }
  return result;
}

function getExtension(filePath) {
  return String(filePath ?? "").split(".").pop()?.toLowerCase() ?? "";
}
