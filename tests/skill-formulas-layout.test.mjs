import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("pure development limit uses separate full-width toggle and hint rows", async () => {
  const [template, styles] = await Promise.all([
    readFile(new URL("../templates/settings/skill-formulas-config.hbs", import.meta.url), "utf8"),
    readFile(new URL("../styles/fallout-maw.css", import.meta.url), "utf8")
  ]);

  const blockStart = template.indexOf("fallout-maw-skill-advancement-settings");
  const blockEnd = template.indexOf("fallout-maw-skill-advancement-list", blockStart);
  const block = template.slice(blockStart, blockEnd);

  assert.ok(blockStart >= 0);
  assert.ok(blockEnd > blockStart);
  assert.match(block, /fallout-maw-skill-development-limit-toggle/);
  assert.match(block, /fallout-maw-skill-development-limit-hint/);
  assert.doesNotMatch(
    block,
    /<label[^>]*>\s*<span>\{\{localize "FALLOUTMAW\.Settings\.Skills\.DevelopmentLimitPureOnly"\}\}<\/span>\s*<input[^>]*>\s*<small/s
  );
  assert.match(
    styles,
    /\.fallout-maw-skill-advancement-settings\s*>\s*\.fallout-maw-skill-development-limit-toggle\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;/s
  );
  assert.match(
    styles,
    /\.fallout-maw-skill-advancement-settings\s*>\s*\.fallout-maw-skill-development-limit-hint\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;/s
  );
});
