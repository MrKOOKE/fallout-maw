import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const requiredJsonFiles = ["system.json", "lang/en.json", "lang/ru.json"];

for (const file of requiredJsonFiles) {
  const fullPath = path.join(root, file);
  try {
    JSON.parse(fs.readFileSync(fullPath, "utf8"));
  } catch (error) {
    console.error(`Invalid JSON in ${file}: ${error.message}`);
    process.exitCode = 1;
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, "system.json"), "utf8"));
const requiredManifestFields = ["id", "title", "version", "compatibility", "esmodules", "styles", "languages", "documentTypes"];

for (const field of requiredManifestFields) {
  if (!(field in manifest)) {
    console.error(`system.json is missing required project field: ${field}`);
    process.exitCode = 1;
  }
}

if (manifest.id !== "fallout-maw") {
  console.error('system.json id must remain "fallout-maw" so the folder name matches the Foundry package id.');
  process.exitCode = 1;
}

for (const modulePath of manifest.esmodules ?? []) {
  if (!fs.existsSync(path.join(root, modulePath))) {
    console.error(`Missing esmodule file referenced by system.json: ${modulePath}`);
    process.exitCode = 1;
  }
}

for (const stylePath of manifest.styles ?? []) {
  if (!fs.existsSync(path.join(root, stylePath))) {
    console.error(`Missing style file referenced by system.json: ${stylePath}`);
    process.exitCode = 1;
  }
}

for (const language of manifest.languages ?? []) {
  if (!fs.existsSync(path.join(root, language.path))) {
    console.error(`Missing language file referenced by system.json: ${language.path}`);
    process.exitCode = 1;
  }
}

if (!process.exitCode) console.log("Manifest and localization JSON look valid.");
