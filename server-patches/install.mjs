import fs from "node:fs/promises";
import path from "node:path";
import {createHash} from "node:crypto";
import {fileURLToPath, pathToFileURL} from "node:url";

const originals = {
  "dist/database/documents/token.mjs": "94962fa49bec2af05769677023fdc10a7a39598d801a0bff586455b2a043c3c0",
  "dist/database/backend/server-backend.mjs": "7c5cd0e0525558039f2b28224e419797f8fb9a54fe07ebdc09b31e2a9a7c1f7f"
};
const helperName = "dist/database/documents/fallout-maw-token-runtime.mjs";
const sha = value => createHash("sha256").update(value).digest("hex");

export function buildServerPatch(token, backend) {
  const pattern = /async loadRelatedDocuments\(\)\{(.*?)\}async recreateActorDelta/s;
  const match = token.match(pattern);
  if (!match || !match[1].includes("initialize({full:!0})") || !match[1].includes("constructor.applyDelta")) {
    throw new Error("Native Token loader does not match the audited implementation");
  }
  const flag = "g.writeEmbedded=n||d._wasAdopted";
  if (backend.split(flag).length !== 2) throw new Error("Native embedded-write flag is not uniquely identified");
  return {
    "dist/database/documents/token.mjs": 'import{loadTokenRelatedDocuments as mawLoadRelated}from"./fallout-maw-token-runtime.mjs";'
      + token.replace(pattern, () => `async loadRelatedDocuments(){return mawLoadRelated(this,async()=>{${match[1]}})}async recreateActorDelta`),
    "dist/database/backend/server-backend.mjs": backend.replace(flag, "g.writeEmbedded=n||!!d._wasAdopted")
  };
}

export async function install(core, mode = "check") {
  core = await fs.realpath(core);
  const pkg = JSON.parse(await fs.readFile(path.join(core, "package.json"), "utf8"));
  if (pkg.name !== "foundryvtt" || pkg.release?.generation !== 14 || pkg.release?.build !== 361) {
    throw new Error("This patch requires Foundry 14.361");
  }
  const backupDir = path.join(core, ".fallout-maw-performance-backup-14.361");
  const manifestPath = path.join(backupDir, "manifest.json");
  const manifest = await fs.readFile(manifestPath, "utf8").then(JSON.parse, error => {
    if (error.code === "ENOENT") return null; throw error;
  });
  const source = {}, current = {};
  for (const [file, expected] of Object.entries(originals)) {
    current[file] = await fs.readFile(path.join(core, file), "utf8");
    source[file] = manifest ? await fs.readFile(path.join(backupDir, path.basename(file)), "utf8") : current[file];
    if (sha(source[file]) !== expected) throw new Error(`Unexpected original file: ${file}`);
    if (sha(current[file]) !== expected && sha(current[file]) !== manifest?.installedHashes[file]) {
      throw new Error(`Refusing to replace unrelated modifications in ${file}`);
    }
  }
  const helperPath = path.join(core, helperName);
  const oldHelper = await fs.readFile(helperPath, "utf8").catch(error => {
    if (error.code === "ENOENT") return null; throw error;
  });
  if (oldHelper !== null && sha(oldHelper) !== manifest?.installedHashes[helperName]) {
    throw new Error("Refusing to replace an unrecognized server helper");
  }
  if (mode === "uninstall") {
    if (!manifest) return {status:"not-installed"};
    for (const [file, text] of Object.entries(source)) await fs.writeFile(path.join(core,file),text,"utf8");
    if (oldHelper !== null) await fs.unlink(helperPath);
    return {status:"uninstalled",restartRequired:true,backupDir};
  }
  const result = buildServerPatch(source["dist/database/documents/token.mjs"],source["dist/database/backend/server-backend.mjs"]);
  result[helperName] = await fs.readFile(new URL("./token-related-documents.mjs",import.meta.url),"utf8");
  const installedHashes = Object.fromEntries(Object.entries(result).map(([file,text])=>[file,sha(text)]));
  if (mode === "check") return {status:"compatible",core,installedHashes};
  if (mode !== "install") throw new Error("Choose check, install or uninstall");
  await fs.mkdir(backupDir,{recursive:true});
  for (const [file,text] of Object.entries(source)) {
    await fs.writeFile(path.join(backupDir,path.basename(file)),text,{encoding:"utf8",flag:"wx"}).catch(error=>{
      if(error.code!=="EEXIST")throw error;
    });
  }
  try {
    // Install the dependency before either caller. Files already loaded by the
    // running server remain unchanged until a complete application restart.
    await fs.writeFile(helperPath,result[helperName],"utf8");
    for (const file of Object.keys(originals)) await fs.writeFile(path.join(core,file),result[file],"utf8");
    await fs.writeFile(manifestPath,JSON.stringify({version:1,core,originalHashes:originals,installedHashes},null,2)+"\n","utf8");
  } catch(error) {
    for (const [file,text] of Object.entries(current)) await fs.writeFile(path.join(core,file),text,"utf8");
    if(oldHelper===null)await fs.unlink(helperPath).catch(()=>{});else await fs.writeFile(helperPath,oldHelper,"utf8");
    throw error;
  }
  return {status:"installed",restartRequired:true,core,backupDir,installedHashes};
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const mode = process.argv[2] ?? "check", core = process.argv[3];
  if (!core) throw new Error(`Usage: node ${path.basename(fileURLToPath(import.meta.url))} check|install|uninstall <Foundry resources/app>`);
  console.log(JSON.stringify(await install(core, mode),null,2));
}
