import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";

// The vendored calendar has its own Jest runner. Run the system's Node tests here.
const testsDirectory = fileURLToPath(new URL("../tests/", import.meta.url));
function collectTests(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectTests(fullPath);
    return entry.isFile() && entry.name.endsWith(".test.mjs") ? [fullPath] : [];
  });
}

const result = spawnSync(process.execPath, [
  "--test", ...process.argv.slice(2), ...collectTests(testsDirectory).sort()
], { stdio: "inherit" });
if (result.error) console.error(result.error);
process.exit(result.status ?? 1);
