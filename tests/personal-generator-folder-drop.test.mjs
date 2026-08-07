import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { getDroppedWorldItems } from "../src/utils/document-drop.mjs";

test("personal generator expands an Item folder and appends all entries as one batch", async t => {
  const originalFromUuid = globalThis.fromUuid;
  const originalGame = globalThis.game;
  t.after(() => {
    globalThis.fromUuid = originalFromUuid;
    globalThis.game = originalGame;
  });

  const first = worldItem("Item.first", "Первый", 10);
  const second = worldItem("Item.second", "Второй", 20);
  const nested = worldItem("Item.nested", "Вложенный", 5);
  const root = itemFolder("Folder.root", "root", [second, first]);
  const child = itemFolder("Folder.child", "child", [nested], root);
  globalThis.game = { folders: [root, child], i18n: { lang: "ru" } };
  globalThis.fromUuid = async uuid => uuid === root.uuid ? root : null;

  const event = {
    dataTransfer: {
      getData: type => type === "application/json"
        ? JSON.stringify({ type: "Folder", uuid: root.uuid })
        : ""
    }
  };

  assert.deepEqual(
    (await getDroppedWorldItems(event)).map(item => item.uuid),
    [first.uuid, second.uuid, nested.uuid]
  );

  const source = await readFile(new URL("../src/apps/personal-generator.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async #onDropItem");
  const end = source.indexOf("#onDropzoneDragEnter", start);
  const handler = source.slice(start, end);
  assert.match(handler, /resolveItemDocumentsFromDrop\(event, data\)/);
  assert.match(handler, /entries\.push\(\.\.\.droppedItems\.map\(createItemEntryFromItem\)\)/);
});

function worldItem(uuid, name, sort) {
  return { documentName: "Item", uuid, name, sort, pack: null, parent: null };
}

function itemFolder(uuid, id, contents, folder = null) {
  return { documentName: "Folder", type: "Item", uuid, id, name: id, sort: 0, contents, folder, pack: null };
}
