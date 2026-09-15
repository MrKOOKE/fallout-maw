import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import * as functions from "../src/utils/item-functions.mjs";
import * as modules from "../src/utils/weapon-modules.mjs";
import * as tooltip from "../src/utils/function-module-tooltip.mjs";
import { prepareItemDamageMitigationCell } from "../src/items/damage-mitigation-preparation.mjs";
import { buildDamageMitigationTables } from "../src/utils/damage-mitigation-display.mjs";

const sheet = readFileSync(new URL("../src/sheets/actor-sheet.mjs", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const hud = readFileSync(new URL("../src/apps/token-action-hud.mjs", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const escapeHTML = value => String(value ?? "").replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const sourceFunction = name => {
  const start = sheet.indexOf(`function ${name}(`);
  assert(start >= 0, name);
  return sheet.slice(start, sheet.indexOf("\n}\n", start) + 2);
};
globalThis.game = { i18n: { localize: key => key, lang: "ru" } };
globalThis.foundry = { utils: { deepClone: structuredClone } };
const data = value => ({ enabled: true, mode: "defense", entries: { torso: { physical: { value } } } });
const createModule = (id, targetFunction = "damageMitigation", moduleKey = "plate") => ({
  id, name: id, uuid: `Item.${id}`, type: "gear", system: { quantity: 2, functions: {
    condition: { enabled: true, value: 67, max: 100 },
    module: { enabled: true, name: moduleKey, targetFunction, damageMitigation: data(50) }
  } }
});
const armor = () => ({ id: "armor", name: "Armor", type: "gear", system: { functions: {
  damageMitigation: { ...data(36), moduleSlots: [{ id: "slot", moduleKey: "plate" }] },
  weapon: { enabled: true, moduleSlots: [{ id: "weaponSlot", moduleKey: "plate" }] }
} } });
function loadRenderers(extra = {}) {
  const names = ["buildInventoryTooltipFunctionSections", "buildModuleTooltipSection", "getModuleTooltipRows", "renderTooltipFunctionSection", "renderTooltipFunctionGrid", "hasTooltipRowValue", "renderTooltipRowValue", "formatTooltipLabel", "buildProtectionModuleSlotsTooltipSection", "renderWeaponTooltipModuleSlots", "renderWeaponTooltipModulePickerPanel", "getTooltipWeaponModuleCandidates", "renderWeaponTooltipModuleChoice", "buildDamageMitigationTooltipSection", "renderDamageMitigationTooltipTables", "buildDamageMitigationCellBreakdown"];
  const dependencies = {
    ...functions, ...modules, ...tooltip, prepareItemDamageMitigationCell, buildDamageMitigationTables,
    escapeHTML, escapeAttribute: escapeHTML, toInteger: value => Math.trunc(Number(value) || 0), formatNumber: String,
    getItemQuantityHelper: item => item.system.quantity,
    renderInstalledModuleTooltipAttributes: () => "", renderModuleChangePreview: () => "",
    getWeaponTooltipSectionTitle: () => "Weapon", getWeaponRequirementLabels: () => [],
    getCreatureOptions: () => ({ races: [{ id: "human", name: "Human", limbs: [{ key: "torso", label: "Torso" }] }] }),
    getDamageTypeSettings: () => [{ key: "physical", label: "Physical" }],
    createActorEffectSnapshot: () => ({}), collectActorPreparedPathAttribution: () => ({ sources: [] }),
    PROTECTION_EFFECTIVENESS_PERCENT_EFFECT_KEY: "system.equipmentEffectiveness.protectionPercent",
    renderDamageTypeIcon: row => escapeHTML(row.damageTypeLabel),
    renderTooltipValueTokens: values => values.map(escapeHTML).join(", "),
    renderItemValueBreakdownTooltipHTML: breakdown => `${breakdown.sources.map(source => source.name).join("+")}=${breakdown.total}`,
    ...Object.fromEntries(["buildContainerTooltipSection", "buildConditionTooltipSection", "buildFirstAidTooltipSection", "buildNeedChangeTooltipSection", "buildOneTimeUseTooltipSection", "buildDamageSourceTooltipSection", "buildEnergySourceTooltipSection", "buildEnergyConsumerTooltipSection", "buildLightSourceTooltipSection", "buildConstructPartTooltipSection", "buildProsthesisTooltipSection"].map(name => [name, () => ""])),
    buildWeaponTooltipSections: () => [], buildToolTooltipSections: () => [],
    ...extra
  };
  return new Function(...Object.keys(dependencies), `${names.map(sourceFunction).join("\n")}\nreturn {${names.join(",")}};`)(...Object.values(dependencies));
}

for (const mode of ["defense", "resistance"]) {
  test(`standalone ${mode} module card uses the armor matrix and identifies its occupied slot`, () => {
    const item = createModule("Plate C");
    item.system.functions.condition.value = 100;
    // The nested schema has enabled=false; the Module function enables this preview.
    item.system.functions.module.damageMitigation.enabled = false;
    item.system.functions.module.damageMitigation.mode = mode;
    item.system.functions.module.damageMitigation.requirements = [{ key: "athletics", value: 50 }];
    const original = structuredClone(item);
    const html = loadRenderers({
      getWeaponRequirementLabels: mitigation => (mitigation.requirements ?? []).map(entry => `${entry.key} ${entry.value}`)
    }).buildInventoryTooltipFunctionSections(item, null);
    assert.equal((html.match(/class="tooltip-mitigation-matrix"/g) ?? []).length, 1);
    assert.match(html, />50<\/span>/);
    assert.match(html, /<h4>FALLOUTMAW.Item.FunctionModule<\/h4>/);
    assert.match(html, /FALLOUTMAW.Item.ModuleOccupiedSlot:[\s\S]*?<strong>plate<\/strong>/);
    assert.match(html, new RegExp(`MitigationMode${mode === "defense" ? "Defense" : "Resistance"}`));
    assert.match(html, /athletics 50/);
    assert.doesNotMatch(html, /protection-module-slots-section|tooltip-module-picker-panel/);
    assert.equal(functions.hasItemFunction(item, "damageMitigation"), false);
    assert.deepEqual(item, original, "rendering must not activate or modify the inventory module");
  });
}

test("a protective module preview preserves weakening and an installed module renders only one matrix", () => {
  const module = createModule("Plate C");
  module.system.functions.condition.value = 10;
  const renderers = loadRenderers();
  const html = renderers.buildInventoryTooltipFunctionSections(module, null);
  assert.match(html, />30<\/span>/);
  const host = armor();
  host.system.functions.damageMitigation.moduleSlots[0].itemData = module;
  const [installed] = functions.getInstalledFunctionModuleItems(host, "damageMitigation", { ignoreBroken: true });
  const installedHTML = renderers.buildInventoryTooltipFunctionSections(installed, null);
  assert.equal((installedHTML.match(/class="tooltip-mitigation-matrix"/g) ?? []).length, 1);
  assert.match(installedHTML, />30<\/span>/);
  assert.doesNotMatch(installedHTML, /protection-module-slots-section/);
});

test("armor card renders visible slots and only matching protective inventory choices", () => {
  const item = armor();
  const candidates = [createModule("plate"), createModule("weapon", "weapon"), createModule("other", "damageMitigation", "other")];
  const actor = { items: { contents: [item, ...candidates] } };
  const html = loadRenderers().buildProtectionModuleSlotsTooltipSection(item, actor);
  assert.match(html, /class="tooltip-module-slot empty"/);
  assert.match(html, /data-tooltip-module-target="damageMitigation"/);
  assert.match(html, /data-tooltip-module-picker-panel="damageMitigation:0:0"/);
  assert.match(html, /data-tooltip-module-choice="plate"/);
  assert.doesNotMatch(html, /data-tooltip-module-choice="(?:weapon|other)"/);
  assert.match(sheet, /buildProtectionModuleSlotsTooltipSection\(item, sourceActor, evaluatingActor\)/);
});

test("armor card renders one combined matrix with module attribution and a remove button", () => {
  const item = armor();
  const module = createModule("plate");
  module.system.functions.condition.value = 100;
  item.system.functions.damageMitigation.moduleSlots[0].itemData = module;
  const renderers = loadRenderers();
  const html = renderers.buildDamageMitigationTooltipSection(item, null);
  assert.equal((html.match(/class="tooltip-mitigation-matrix"/g) ?? []).length, 1);
  assert.match(html, />86<\/span>/);
  assert.match(html, /data-tooltip-html="plate=86"/);
  assert.doesNotMatch(html, /<h4>[^<]*plate/);
  const slots = renderers.buildProtectionModuleSlotsTooltipSection(item, null);
  assert.match(slots, /class="tooltip-module-slot filled"/);
  assert.match(slots, /data-tooltip-module-remove[^>]*data-tooltip-module-target="damageMitigation"/);
});

test("mixed protection modes stay in one matrix without adding resistance to defense", () => {
  const item = armor();
  const module = createModule("resistance");
  module.system.functions.condition.value = 100;
  module.system.functions.module.damageMitigation.mode = "resistance";
  item.system.functions.damageMitigation.moduleSlots[0].itemData = module;
  const html = loadRenderers().buildDamageMitigationTooltipSection(item, null);
  assert.equal((html.match(/class="tooltip-mitigation-matrix"/g) ?? []).length, 1);
  assert.match(html, />36 \/ 50<\/span>/);
});

test("weapon and armor slots with the same index open distinct pickers, including on broken armor", () => {
  const item = armor();
  item.system.functions.condition = { enabled: true, value: 0, max: 100 };
  const protection = { tooltipModuleTarget: "damageMitigation", tooltipModuleSlotIndex: "0", tooltipWeaponIndex: "0" };
  const weapon = { ...protection, tooltipModuleTarget: "weapon" };
  assert.notEqual(tooltip.getModuleTooltipPickerKey(protection), tooltip.getModuleTooltipPickerKey(weapon));
  assert.equal(tooltip.getModuleTooltipSlotContext(item, protection).slot.id, "slot");
  assert.equal(tooltip.getModuleTooltipSlotContext(item, weapon).slot.id, "weaponSlot");
});

test("module selection renders only the icon and name without building nested previews", () => {
  const html = loadRenderers({
    renderInstalledModuleTooltipAttributes: () => assert.fail("candidate list must not construct a complete nested item tooltip"),
    renderModuleChangePreview: () => assert.fail("candidate list must not render modifier details")
  }).renderWeaponTooltipModuleChoice(createModule("Plate C"), 0, 0, null, null, "damageMitigation");
  assert.match(html, /<img /);
  assert.match(html, /<strong>Plate C<\/strong>/);
  assert.doesNotMatch(html, /tooltip-module-choice-effects|data-tooltip-html/);
});

function loadMutation(source, methodName, dependencies) {
  const start = source.indexOf(`  async #${methodName}(`);
  assert(start >= 0, methodName);
  const method = source.slice(start, source.indexOf("\n  }", start) + 4)
    .replace(`async #${methodName}`, `async function ${methodName}`)
    .replace(/this\.#(?:restoreTooltipModuleSlotsTab|restoreHudModuleSlotsTab)/g, "this.restore")
    .replace(/this\.#(?:refreshInventoryTooltip|refreshHudItemTooltip)/g, "this.refresh")
    .replace(/this\.#moduleTooltipMutation/g, "this.moduleMutation")
    .replaceAll("this.#", "this.");
  return new Function(...Object.keys(dependencies), `return ${method};`)(...Object.values(dependencies));
}

for (const [label, source, installName, removeName] of [
  ["actor sheet", sheet, "installWeaponModule", "uninstallWeaponModule"],
  ["token HUD", hud, "installHudWeaponModule", "uninstallHudWeaponModule"]
]) {
  test(`${label} installs and returns a protection module with condition intact through inventory mutations`, async () => {
    const item = armor();
    const module = createModule("plate");
    const plans = [];
    const dependencies = {
      ...functions, ...modules, ...tooltip,
      planActorInventoryGrant: (_actor, source) => ({ updates: [], creates: [structuredClone(source)] }),
      planWeaponMagazineCapacityTransition: () => assert.fail("protective slots must not change a weapon magazine"),
      planInventoryItemConsumption: ({ item, amount }) => ({ updates: [{ _id: item.id, "system.quantity": item.system.quantity - amount }], deletes: [] }),
      executeInventoryMutation: async plan => plans.push(plan)
    };
    const context = { actor: {}, moduleMutation: new tooltip.ModuleTooltipMutation(), restore: () => assert.fail("armor does not switch weapon tabs"), refresh: async () => {} };
    const entry = tooltip.getProtectionModuleTooltipEntry(item);
    await loadMutation(source, installName, dependencies).call(context, item, entry, 0, module);
    assert.equal(plans.length, 1);
    assert.equal(plans[0].updates[1]["system.quantity"], 1);
    const slots = plans[0].updates[0]["system.functions.damageMitigation.moduleSlots"];
    assert.equal(slots[0].itemData.system.functions.condition.value, 67);
    assert.equal(slots[0].itemData.system.quantity, 1);
    assert.equal(plans[0].updates[0]["system.functions.weapon.moduleSlots"], undefined);
    entry.data.moduleSlots = slots;
    await loadMutation(source, removeName, dependencies).call(context, item, entry, 0, slots[0].itemData);
    assert.equal(plans[1].creates[0].system.functions.condition.value, 67);
    assert.equal(plans[1].updates[0]["system.functions.damageMitigation.moduleSlots"].length, 1);
    assert.deepEqual(plans[1].updates[0]["system.functions.damageMitigation.moduleSlots"][0].itemData, {});
  });

  for (const methodName of [installName, removeName]) {
    test(`${label} ${methodName} refreshes once after commit and ignores repeated clicks`, async () => {
      const item = armor();
      const module = createModule("plate");
      const entry = tooltip.getProtectionModuleTooltipEntry(item);
      let releaseMutation;
      const pending = new Promise(resolve => { releaseMutation = resolve; });
      let commits = 0;
      let refreshes = 0;
      let returned = false;
      const automaticRefresh = loadMutation(source, label === "actor sheet" ? "refreshInventoryTooltip" : "refreshHudItemTooltip", {});
      const context = {
        actor: {}, moduleMutation: new tooltip.ModuleTooltipMutation(),
        restore: () => {},
        async refresh(options) {
          assert.equal(options, undefined);
          assert.equal(returned, true, "render the committed state");
          refreshes++;
          // A render callback arriving during the final async tooltip build is deferred too.
          await automaticRefresh.call(this, { afterRender: true });
          assert.equal(this.moduleMutation.active, true);
        }
      };
      const dependencies = {
        ...functions, ...modules, ...tooltip,
        planActorInventoryGrant: () => ({ updates: [], creates: [] }),
        planInventoryItemConsumption: () => ({ updates: [], deletes: [] }),
        async executeInventoryMutation() {
          commits++;
          await automaticRefresh.call(context, { afterRender: true });
          await pending;
          await automaticRefresh.call(context, { afterRender: true });
          returned = true;
        }
      };
      const method = loadMutation(source, methodName, dependencies);
      const argument = methodName === installName ? module : structuredClone(module);
      const first = method.call(context, item, entry, 0, argument);
      await method.call(context, item, entry, 0, argument);
      assert.equal(commits, 1);
      assert.equal(refreshes, 0);
      releaseMutation();
      await first;
      assert.equal(refreshes, 1);
      assert.equal(context.moduleMutation.active, false);
    });
  }
}

test("failed module transfers still refresh once and release the guard for retry", async () => {
  const mutation = new tooltip.ModuleTooltipMutation();
  const failure = new Error("Inventory mutation failed");
  let refreshes = 0;
  await assert.rejects(mutation.run(async () => { throw failure; }, async () => {
    assert.equal(mutation.active, true);
    refreshes++;
  }), error => error === failure);
  assert.equal(mutation.active, false);
  await mutation.run(async () => {}, async () => { refreshes++; });
  assert.equal(refreshes, 2);
  await assert.rejects(mutation.run(async () => {}, async () => { throw new Error("Render failed"); }), /Render failed/);
  assert.equal(mutation.active, false);
});
