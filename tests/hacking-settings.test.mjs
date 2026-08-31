import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEFAULT_HACKING_SKILL_KEY,
  createDefaultHackingSettings,
  normalizeHackingSettings
} from "../src/settings/hacking.mjs";

const SKILLS = Object.freeze([
  { key: "science", label: "Наука" },
  { key: "repair", label: "Ремесло" }
]);

test("hacking uses Craft as its base skill", () => {
  assert.equal(DEFAULT_HACKING_SKILL_KEY, "repair");
  assert.deepEqual(createDefaultHackingSettings(), { skillKey: "repair" });
  assert.deepEqual(normalizeHackingSettings({}, SKILLS), { skillKey: "repair" });
});

test("hacking skill normalization preserves valid choices and repairs stale ones", () => {
  assert.deepEqual(normalizeHackingSettings({ skillKey: "science" }, SKILLS), { skillKey: "science" });
  assert.deepEqual(normalizeHackingSettings({ skillKey: "lockpicking" }, SKILLS), { skillKey: "repair" });
  assert.deepEqual(normalizeHackingSettings({ skillKey: "repair" }, [SKILLS[0]]), { skillKey: "science" });
});

test("hacking settings expose one skill field and drive the roll", async () => {
  const [registration, app, template, hacking] = await Promise.all([
    readFile(new URL("../src/settings/registration.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/apps/hacking-settings-config.mjs", import.meta.url), "utf8"),
    readFile(new URL("../templates/settings/hacking-settings-config.hbs", import.meta.url), "utf8"),
    readFile(new URL("../src/apps/hacking-dialog.mjs", import.meta.url), "utf8")
  ]);

  assert.match(registration, /registerMenu\(FALLOUT_MAW\.id, "hackingSettingsMenu"/);
  assert.match(app, /const skills = getSkillSettings\(\)[\s\S]*?skillChoices: skills\.map/);
  assert.equal((template.match(/<(?:input|select|textarea)\b/g) ?? []).length, 1);
  assert.match(template, /<select name="skillKey">/);
  assert.match(hacking, /const skillKey = getHackingSettings\(\)\.skillKey/);
  assert.match(hacking, /requestSkillCheck\(\{[\s\S]*?skillKey,/);
  assert.match(hacking, /У актёра нет выбранного для взлома навыка/);
});
