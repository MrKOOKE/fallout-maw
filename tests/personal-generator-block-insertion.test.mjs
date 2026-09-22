import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/apps/personal-generator.mjs", import.meta.url), "utf8");
const getIndex = new Function(`return (${source.match(/function getItemBlockInsertionIndex\([^]*?\n\}/)[0]});`)();
const root = bounds => ({ querySelectorAll: () => bounds.map(([top, bottom]) => ({ getBoundingClientRect: () => ({ top, bottom }) })) });

test("block insertion follows the viewport position instead of the list end", () => {
  assert.equal(getIndex(root([]), 600), 0);
  assert.equal(getIndex(root([[800, 1000], [1010, 1210]]), 600), 0);
  assert.equal(getIndex(root([[-200, 100], [110, 500], [510, 900], [910, 1200]]), 600), 2);
  assert.equal(getIndex(root([[-200, 100], [110, 500], [510, 900], [910, 1200]]), 800), 3);
  assert.equal(getIndex(root([[-200, 100], [110, 500]]), 600), 2);
});

test("adding in the middle saves existing form edits and reveals the inserted block", async () => {
  const body = source.match(/static async #onCreateItemBlock\([^]*?\n  \}/)[0]
    .replace("static async #onCreateItemBlock", "async function addBlock").replaceAll("#", "");
  const add = new Function("getItemBlockInsertionIndex", "createItemBlock", `${body}; return addBlock;`)(getIndex, () => ({ id: "new" }));
  const blocks = [{ id: "first", name: "Изменённое имя" }, { id: "last" }];
  const calls = [];
  const app = { element: root([[100, 400], [410, 900]]),
    readConfigFromForm: () => ({ items: { blocks } }),
    saveCurrentConfig: async () => calls.push("save"), render: () => calls.push("render") };
  await add.call(app, { preventDefault() {} }, { getBoundingClientRect: () => ({ top: 500 }) });
  assert.deepEqual(app.config.items.blocks.map(block => block.id), ["first", "new", "last"]);
  assert.equal(app.config.items.blocks[0].name, "Изменённое имя");
  assert.equal(app.createdBlockId, "new");
  assert.deepEqual(calls, ["save", "render"]);
});
