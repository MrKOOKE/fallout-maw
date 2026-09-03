import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("both ability editors expose and preserve existing-effect refresh", () => {
  const editor = readFileSync(new URL("../src/apps/ability-catalog-item-editor.mjs", import.meta.url), "utf8");
  const catalogTemplate = readFileSync(new URL("../templates/settings/ability-catalog-item-editor.hbs", import.meta.url), "utf8");
  const itemTemplate = readFileSync(new URL("../templates/item/item-sheet.hbs", import.meta.url), "utf8");

  assert.match(editor, /refresh:\s*readBooleanField\(row\.querySelector\("\[data-field='conditionRefresh'\]"\),\s*false\)/);
  assert.match(catalogTemplate, /data-field="conditionRefresh"\s+\{\{#if refresh\}\}checked\{\{\/if\}\}/);
  assert.equal((itemTemplate.match(/name="\{\{functionPath\}\}\.\{\{functionIndex\}\}\.conditions\.\{\{index\}\}\.refresh"/g) ?? []).length, 2);
});
