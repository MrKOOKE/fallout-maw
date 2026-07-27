import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [source, styles, template] = await Promise.all([
  readFile(new URL("../src/apps/token-action-hud.mjs", import.meta.url), "utf8"),
  readFile(new URL("../styles/fallout-maw.css", import.meta.url), "utf8"),
  readFile(new URL("../templates/actor/token-action-hud.hbs", import.meta.url), "utf8")
]);

test("HUD ability categories start collapsed and preserve explicitly expanded categories", () => {
  assert.match(source, /#expandedAbilityCategoryKeys = new Set\(\)/);
  assert.match(source, /open: expandedCategoryKeys\.has\(key\)/);
  assert.match(source, /if \(details\.open\) this\.#expandedAbilityCategoryKeys\.add\(key\)/);
  assert.match(source, /else this\.#expandedAbilityCategoryKeys\.delete\(key\)/);
  assert.match(template, /{{#if open}}open{{\/if}}/);
});

test("HUD ability category blocks use a two-column grid", () => {
  assert.match(
    styles,
    /\.fallout-maw-token-hud-ability-section\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s
  );
  assert.match(
    styles,
    /\.fallout-maw-token-hud-ability-section-title\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/s
  );
});
