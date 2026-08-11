import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

let actorContextHook;

globalThis.Hooks = {
  on(name, callback) {
    if (name === "getActorContextOptions") actorContextHook = callback;
  }
};

class ApplicationV2 {
  render(options) {
    this.renderOptions = options;
    return this;
  }
}

globalThis.foundry = {
  applications: {
    api: {
      ApplicationV2,
      HandlebarsApplicationMixin: Base => class extends Base {}
    }
  }
};
globalThis.game = {
  actors: new Map(),
  i18n: {
    localize: key => key === "FALLOUTMAW.Factions.ActorButton" ? "Фракции" : key
  }
};

const { registerActorFactionConfigHooks } = await import("../src/apps/faction-settings-config.mjs");
const mainSource = await readFile(new URL("../src/main.mjs", import.meta.url), "utf8");

function createDirectoryEntry(id) {
  return {
    dataset: { entryId: id },
    closest: () => null
  };
}

test("actor directory exposes the existing faction editor only to owners", () => {
  registerActorFactionConfigHooks();
  assert.equal(typeof actorContextHook, "function");

  const ownedActor = { id: "owned", isOwner: true };
  const foreignActor = { id: "foreign", isOwner: false };
  const actors = new Map([[ownedActor.id, ownedActor], [foreignActor.id, foreignActor]]);
  const options = [];
  actorContextHook({ collection: actors }, options);

  assert.equal(options.length, 1);
  assert.equal(options[0].label, "Фракции");
  assert.equal(options[0].icon, "fa-solid fa-flag");
  assert.equal(options[0].visible(createDirectoryEntry(ownedActor.id)), true);
  assert.equal(options[0].visible(createDirectoryEntry(foreignActor.id)), false);

  const application = options[0].onClick(null, createDirectoryEntry(ownedActor.id));
  assert.equal(application.actor, ownedActor);
  assert.equal(application.renderOptions, true);
});

test("faction directory hook is registered during system initialization", () => {
  assert.match(mainSource, /registerActorFactionConfigHooks\(\);/);
});
