import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const stylesheet = await readFile(new URL("../styles/fallout-maw.css", import.meta.url), "utf8");

test("inventory tooltip values keep separate rows while long text wraps", () => {
  const rule = stylesheet.match(
    /\.fallout-maw-inventory-tooltip \.function-value-token\s*\{(?<body>[^}]*)\}/
  );

  assert.ok(rule?.groups?.body, "function value token rule is present");
  assert.match(rule.groups.body, /display:\s*block/);
  assert.match(rule.groups.body, /overflow-wrap:\s*break-word/);
  assert.match(rule.groups.body, /white-space:\s*normal/);
  assert.doesNotMatch(rule.groups.body, /white-space:\s*nowrap/);
});
