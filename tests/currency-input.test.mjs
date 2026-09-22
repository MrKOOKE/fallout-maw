import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { calculateCurrencyAmount, CurrencyInputController } from "../src/utils/currency-input.mjs";

test("currency accepts replacement and relative integer calculations without evaluating code", () => {
  for (const [input, expected] of [["+311", 534], ["-23", 200], ["*2", 446], ["/2", 111], ["42", 42], ["0", 0], ["-999", 0], [" + 1 000 ", 1223]]) {
    assert.equal(calculateCurrencyAmount(input, 223), expected, input);
  }
  for (const input of ["", "+", "abc", "2.5", "/0", "Infinity", "1e3", "alert(1)", "9007199254740992"]) {
    assert.equal(calculateCurrencyAmount(input, 223), null, input);
  }
  assert.equal(calculateCurrencyAmount("+1", Number.MAX_SAFE_INTEGER), null);
});

function fixture({ editable = true, fail = false, wait = null } = {}) {
  const doc = new EventTarget();
  doc.defaultView = { AbortController };
  const field = new EventTarget();
  Object.assign(field, { dataset: { currencyEditor: "caps" }, value: "223", selections: 0,
    select() { this.selections++; },
    focus() { doc.activeElement = this; this.dispatchEvent(new Event("focus")); },
    blur() { doc.activeElement = null; this.dispatchEvent(new Event("blur")); }
  });
  const root = { ownerDocument: doc, querySelectorAll: () => [field] };
  const writes = [], errors = [];
  const actor = { system: { currencies: { caps: 223, gold: 17 } }, async update(data) {
    writes.push(data);
    if (wait) await wait;
    if (fail) throw new Error("Save failed");
    this.system.currencies.caps = data["system.currencies.caps"];
  } };
  const controller = new CurrencyInputController();
  const options = { actor, canEdit: () => editable, onError: error => errors.push(error.message) };
  controller.bind(root, options);
  const input = value => { field.value = value; field.dispatchEvent(new Event("input")); };
  const key = value => { const event = new Event("keydown", { cancelable: true }); Object.defineProperty(event, "key", { value }); field.dispatchEvent(event); return event; };
  return { doc, field, root, actor, writes, errors, controller, options, input, key };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test("click selects the number; Enter followed by blur saves +311 exactly once", async () => {
  let release;
  const f = fixture({ wait: new Promise(resolve => { release = resolve; }) });
  f.field.focus(); f.field.dispatchEvent(new Event("click"));
  assert.equal(f.field.selections, 2);
  f.input("+311"); assert.equal(f.key("Enter").defaultPrevented, true);
  f.field.blur(); assert.equal(f.writes.length, 1); assert.equal(f.field.readOnly, true);
  release(); await settle();
  assert.deepEqual(f.writes, [{ "system.currencies.caps": 534 }]);
  assert.equal(f.actor.system.currencies.gold, 17); assert.equal(f.field.readOnly, false);
  f.controller.destroy();
});

test("clicking empty space commits, Escape cancels, and partial rebinding preserves a draft", async () => {
  const f = fixture();
  f.field.focus(); f.input("+10"); f.controller.bind(f.root, f.options);
  f.doc.dispatchEvent(new Event("pointerdown")); await settle();
  assert.equal(f.actor.system.currencies.caps, 233);
  f.field.focus(); f.input("-20"); f.key("Escape"); await settle();
  assert.equal(f.writes.length, 1); assert.equal(f.field.value, "233");
  f.controller.destroy();
  f.field.focus(); f.input("+100"); f.field.blur(); await settle();
  assert.equal(f.writes.length, 1);
});

test("invalid input, unchanged balances, read-only actors and failed writes preserve currency", async () => {
  for (const options of [{}, { editable: false }, { fail: true }]) {
    const f = fixture(options);
    f.field.focus(); f.field.blur();
    f.input("/0"); f.field.blur(); await settle(); assert.equal(f.writes.length, 0);
    f.input("+10"); f.field.blur(); await settle();
    assert.equal(f.actor.system.currencies.caps, options.editable === false || options.fail ? 223 : 233);
    if (options.fail) { assert.deepEqual(f.errors, ["Save failed"]); assert.equal(f.field.value, "223"); }
    f.controller.destroy();
  }
});

test("HUD grants the chosen currency to each selected actor and respects cancel and GM permission", async () => {
  const source = fs.readFileSync(new URL("../src/apps/token-action-hud.mjs", import.meta.url), "utf8");
  const body = source.match(/static async #onGmAwardCurrency\(event\) \{([^]*?)\n  \}/)[1];
  for (const mode of ["grant", "cancel", "player", "invalid"]) {
    const writes = [], dialogs = [];
    const actors = [10, 100].map(base => ({ system: { currencies: { gold: base, caps: 999 } }, update: async data => writes.push(data) }));
    const deps = {
      game: { user: { isGM: mode !== "player" } }, getSelectedHudActors: () => actors,
      getCurrencySettings: () => [{ key: "caps", label: "Крышки" }, { key: "gold", label: "Золото" }],
      DialogV2: { input: async config => { dialogs.push(config); return mode === "cancel" ? null : { currency: mode === "invalid" ? "missing" : "gold", amount: "25" }; } },
      escapeAttribute: String, escapeHTML: String, calculateCurrencyAmount,
      ui: { notifications: { warn: assert.fail } }
    };
    const run = new Function(...Object.keys(deps), `return async function(event) {${body}}`)(...Object.values(deps));
    await run.call({ render: async () => {} }, { preventDefault() {} });
    assert.deepEqual(writes, mode === "grant" ? [{ "system.currencies.gold": 35 }, { "system.currencies.gold": 125 }] : []);
    if (mode === "player") assert.equal(dialogs.length, 0);
    else assert.match(dialogs[0].content, /Сумма каждому/);
  }
});
