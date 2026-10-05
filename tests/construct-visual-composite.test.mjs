import test from "node:test";
import assert from "node:assert/strict";

let fixtureId = 0;
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} ≠ ${expected}`);

async function fixture(t, { deferred = false } = {}) {
  const names = ["PIXI", "foundry", "canvas", "game", "Hooks", "ui"];
  const original = Object.fromEntries(names.map(name => [name, globalThis[name]]));
  const renders = [], buffers = [], loaded = new Map(), loadCalls = [], hooks = new Map(), extracts = [], loaderAlphaCalls = [], notices = [];
  let finishLoad;
  const gate = deferred ? new Promise(resolve => { finishLoad = resolve; }) : Promise.resolve();
  class Point {
    constructor(x = 0, y = 0) { this.x = x; this.y = y; }
    set(x, y = x) { this.x = x; this.y = y; }
    copyFrom(point) { this.set(point.x, point.y); }
  }
  class Texture {
    constructor(width = 100, height = 160) {
      this.width = width; this.height = height; this.valid = true; this.destroyCalls = 0;
      this.baseTexture = { valid: true };
    }
    destroy() { this.destroyCalls++; this.destroyed = true; this.valid = false; }
  }
  class Container {
    constructor() {
      this.children = []; this.position = new Point(); this.scale = new Point(1, 1);
      this.visible = true; this.renderable = true; this.alpha = 1;
    }
    addChild(child) { this.children.push(child); child.parent = this; return child; }
    setChildIndex(child, index) { this.children.splice(this.children.indexOf(child), 1); this.children.splice(index, 0, child); }
    destroy(options) {
      this.destroyed = true;
      if (options?.children) for (const child of [...this.children]) child.destroy(options);
      if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    }
  }
  class Sprite extends Container {
    constructor(texture) { super(); this.texture = texture; this.anchor = new Point(); this.angle = 0; }
    get width() { return Math.abs(this.scale.x) * (this.texture?.width ?? 0); }
    set width(value) { this.scale.x = (Math.sign(this.scale.x) || 1) * value / (this.texture?.width || 1); }
    get height() { return Math.abs(this.scale.y) * (this.texture?.height ?? 0); }
    set height(value) { this.scale.y = (Math.sign(this.scale.y) || 1) * value / (this.texture?.height || 1); }
    destroy(options) { super.destroy(options); if (options?.texture) this.texture.destroy(options.baseTexture); }
  }
  class PrimaryMesh extends Sprite {
    constructor(options) {
      super(options.texture ?? Texture.EMPTY); this.name = options.name; this.object = options.object;
      this.elevation = 0; this.sortLayer = 1; this.sort = 0; this.zIndex = 0;
      this.unoccludedAlpha = 1; this.occludedAlpha = 0.5; this.textureAlphaThreshold = 0;
      this._canvasBoundsID = 0; this.voidCalls = 0;
    }
    _renderVoid() { if (this.visible && this.renderable) this.voidCalls++; }
    containsCanvasPoint(point, threshold = this.textureAlphaThreshold) {
      if (threshold > 1) return false;
      const data = this._textureAlphaData;
      if (data && (point.x < data.minX * this.texture.width / data.width
        || point.x >= data.maxX * this.texture.width / data.width)) return false;
      return PrimaryMesh.prototype.containsPoint.call(this, point, threshold);
    }
    containsPoint(point, threshold = this.textureAlphaThreshold) {
      if (threshold > 1) return false;
      const { width, height } = this.texture;
      if (threshold <= 0) return point.x >= 0 && point.y >= 0 && point.x < width && point.y < height;
      const data = this._textureAlphaData ??= foundry.canvas.TextureLoader.getTextureAlphaData(this.texture, 0.25);
      const x = point.x * data.width / width, y = point.y * data.height / height;
      if (x < data.minX || y < data.minY || x >= data.maxX || y >= data.maxY) return false;
      return data.data[(Math.floor(y) - data.minY) * (data.maxX - data.minX) + Math.floor(x) - data.minX] / 255 >= threshold;
    }
  }
  Texture.EMPTY = new Texture(1, 1);
  globalThis.PIXI = { Container, Sprite, Texture, SCALE_MODES: { LINEAR: 1 }, RenderTexture: {
    create(options) {
      const texture = new Texture(options.width, options.height);
      texture.resolution = options.resolution; buffers.push(texture); return texture;
    }
  } };
  const immutableAlphaCache = new WeakMap();
  globalThis.foundry = { canvas: { primary: { PrimarySpriteMesh: PrimaryMesh },
    TextureLoader: { getTextureAlphaData(texture, resolution = 1) {
      loaderAlphaCalls.push(texture);
      if (immutableAlphaCache.has(texture)) return immutableAlphaCache.get(texture);
      const width = Math.ceil(Math.round(texture.width * (texture.resolution ?? 1)) * resolution);
      const height = Math.ceil(Math.round(texture.height * (texture.resolution ?? 1)) * resolution);
      const minX = texture.alphaRegion === "right" ? Math.floor(width / 2) : 0;
      const maxX = texture.alphaRegion === "left" ? Math.ceil(width / 2) : width;
      const data = { width, height, minX, minY: 0, maxX, maxY: height,
        data: new Uint8Array((maxX - minX) * height).fill(255) };
      immutableAlphaCache.set(texture, data);
      return data;
    } },
    async loadTexture(img) {
      loadCalls.push(img); await gate;
      if (!loaded.has(img)) loaded.set(img, new Texture());
      return loaded.get(img);
    }
  } };
  const primary = new Container();
  globalThis.canvas = { primary, tokens: { placeables: [] }, app: { renderer: {
    gl: { MAX_TEXTURE_SIZE: 1, getParameter: () => 512 },
    render(container, options) {
      options.renderTexture.sourceTexture = container.texture;
      renders.push({ texture: options.renderTexture, sprites: container.children.filter(child => child.visible).length,
        alpha: container.children.filter(child => child.visible).map(child => child.alpha), clear: options.clear });
    },
    extract: { pixels(texture) {
      extracts.push(texture);
      const { width, height } = texture, region = texture.sourceTexture?.alphaRegion;
      const pixels = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        if (region === "left" && x >= Math.ceil(width / 2) || region === "right" && x < Math.floor(width / 2)) continue;
        pixels[(width * y + x) * 4 + 3] = 255;
      }
      return pixels;
    } }
  } } };
  globalThis.game = { ready: false, user: { id: "gm", isGM: true }, socket: { emit() {} } };
  globalThis.ui = { notifications: { warn(message) { notices.push(message); }, info(message) { notices.push(message); } } };
  globalThis.Hooks = {
    on(name, callback) { const rows = hooks.get(name) ?? []; rows.push(callback); hooks.set(name, rows); },
    once() {}
  };
  const actor = { documentName: "Actor", uuid: `Actor.composite-${++fixtureId}`, type: "construct", system: { limbs: {} },
    flags: { "fallout-maw": { constructVisual: { enabled: true,
      anchors: [{ id: "turret-pivot", x: 0.5, y: 0.55 }],
      parts: [{ id: "hull", slotId: "hull", img: "hull.webp", width: 1, height: 1, zIndex: 0 },
        { id: "gun", slotId: "gun", img: "gun.webp", anchorId: "turret-pivot", width: 0.3, height: 0.8,
          rotates: true, pivotY: 0.8, zIndex: 1 }] } } },
    getFlag(scope, flag) { return this.flags[scope]?.[flag]; }
  };
  actor.items = { contents: ["hull", "gun"].map(id => ({ id, type: "gear", parent: actor, actor, system: {
    placement: { mode: "constructPart", limbKey: id },
    functions: { constructPart: { enabled: true }, condition: { enabled: true, max: 100, value: 100 } }
  } })) };
  const createToken = (preview = false, originalToken = null) => {
    const document = { documentName: "Token", uuid: "Scene.test.Token.composite", actor,
      texture: { anchorX: 0.5, anchorY: 0.5, scaleX: 1, scaleY: 1 },
      flags: { "fallout-maw": { constructVisualState: { rotations: { gun: 0 } } } },
      getFlag(scope, flag) { return this.flags[scope]?.[flag]; } };
    const token = { actor, document, w: 100, h: 160, center: new Point(250, 380),
      visible: true, renderable: true, isPreview: preview, _original: originalToken,
      objectId: `Token.composite${preview ? ".preview" : ""}`, voidMesh: { render() {} } };
    token.mesh = new PrimaryMesh({ texture: new Texture(), name: token.objectId, object: token });
    token.mesh.position.set(250, 380); token.mesh.anchor.set(0.5, 0.5); token.mesh.alpha = preview ? 0.8 : 0.4;
    token.mesh.tint = 0xAABBCC; document.object = token;
    return token;
  };
  const visual = await import(`../src/canvas/construct-visuals.mjs?composite-test=${fixtureId}`);
  visual.registerConstructVisualHooks();
  const token = createToken();
  canvas.tokens.placeables.push(token);
  const hook = (name, ...args) => { for (const callback of hooks.get(name) ?? []) callback(...args); };
  const settle = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
  t.after(() => {
    for (const row of [...visual.CONSTRUCT_VISUAL_TESTING.states.keys()]) visual.destroyConstructVisual(row);
    for (const name of names) {
      if (original[name] === undefined) delete globalThis[name]; else globalThis[name] = original[name];
    }
  });
  return { visual, token, actor, primary, loaded, loadCalls, buffers, renders, extracts, loaderAlphaCalls, notices, createToken, hook, settle,
    finishLoad, state: row => visual.CONSTRUCT_VISUAL_TESTING.states.get(row ?? token) };
}

test("overlapping parts are opaque inside one raster, with native drag opacity applied once", async t => {
  const f = await fixture(t);
  await f.visual.syncConstructVisual(f.token); await f.settle();
  const state = f.state();
  assert.equal(f.primary.children.filter(child => child.visible && child.renderable).length, 1);
  assert.equal(state.mesh.alpha, 0.4);
  assert.equal(state.mesh.tint, f.token.mesh.tint);
  assert.equal(f.token.mesh.renderable, false);
  assert.equal(f.renders.at(-1).sprites, 2);
  assert.deepEqual(f.renders.at(-1).alpha, [1, 1]);
  assert.equal(f.renders.at(-1).clear, true);
  assert.deepEqual(state.composite.texture.baseTexture.clearColor, [0, 0, 0, 0]);
  f.token.voidMesh.render({});
  assert.equal(state.mesh.voidCalls, 1, "the actual composite supplies the grid silhouette once");
});

test("a saved machine-gun yaw follows its turret in the actual composite and returns to its local pose on preview cancel", async t => {
  const f = await fixture(t), config = f.actor.flags["fallout-maw"].constructVisual;
  config.anchors.push({ id: "mg-pivot", parentSlotId: "gun", x: 0.1, y: -0.1 });
  config.parts.push({ id: "mg", slotId: "mg", img: "mg.webp", anchorId: "mg-pivot", rotates: true, width: 0.1, height: 0.2, zIndex: 2 });
  f.actor.items.contents.push({ id: "mg", type: "gear", parent: f.actor, actor: f.actor, system: {
    placement: { mode: "constructPart", limbKey: "mg" }, functions: { constructPart: { enabled: true } }
  } });
  f.token.document.flags["fallout-maw"].constructVisualState.rotations = { gun: 35, mg: 10 };
  await f.visual.syncConstructVisual(f.token); await f.settle();
  const sprite = f.state().composite.sprites.get("mg");
  assert.equal(sprite.angle, 10);
  f.visual.CONSTRUCT_VISUAL_TESTING.previews.set(f.token, { gun: 65 });
  f.visual.syncConstructVisual(f.token, { rotationsDirty: true });
  assert.equal(sprite.angle, 40, "parent movement carries the saved local yaw rather than counter-rotating the sprite");
  assert.equal(f.visual.getConstructPartRotations(f.token).mg, 40);
  f.visual.CONSTRUCT_VISUAL_TESTING.previews.delete(f.token);
  f.visual.syncConstructVisual(f.token, { rotationsDirty: true });
  assert.equal(sprite.angle, 10);
  assert.deepEqual(f.token.document.getFlag("fallout-maw", "constructVisualState").rotations, { gun: 35, mg: 10 });
});

test("warm native movement and rotation do not resolve parts, fetch images, allocate or rasterize", async t => {
  const f = await fixture(t);
  await f.visual.syncConstructVisual(f.token); await f.settle();
  const state = f.state(), counters = [state.resolveCount, state.renderCount, f.loadCalls.length, f.buffers.length];
  for (let frame = 0; frame < 100; frame++) {
    f.token.mesh.position.set(250 + frame, 380 + frame / 2);
    f.token.mesh.angle = frame * 1.3;
    f.hook("refreshToken", f.token, { refreshPosition: true, refreshRotation: true });
    near(state.mesh.position.x, f.token.mesh.position.x);
    near(state.mesh.position.y, f.token.mesh.position.y);
    near(state.mesh.angle, f.token.mesh.angle);
  }
  assert.deepEqual([state.resolveCount, state.renderCount, f.loadCalls.length, f.buffers.length], counters);
  f.hook("updateToken", f.token.document, { delta: { system: { resources: { movementPoints: { spent: 2 } } } } });
  f.hook("updateActor", f.actor, { system: { resources: { movementPoints: { spent: 2 } } } });
  assert.deepEqual([state.resolveCount, state.renderCount, f.loadCalls.length, f.buffers.length], counters,
    "unlinked vehicle movement-resource deltas must not invalidate the visual assembly");
});

test("local yaw reuses its sprites and raster buffer, preserving sweep bounds and GPU limits", async t => {
  const f = await fixture(t);
  await f.visual.syncConstructVisual(f.token); await f.settle();
  const state = f.state(), composite = state.composite, bounds = { ...composite.bounds };
  const sprites = [...composite.sprites.values()], start = state.renderCount;
  for (const gun of [90, 179, -179, -90, 0]) {
    f.token.document.flags["fallout-maw"].constructVisualState.rotations.gun = gun;
    f.hook("updateToken", f.token.document, { flags: { "fallout-maw": { constructVisualState: { rotations: { gun } } } } });
    assert.equal(state.composite, composite);
    assert.deepEqual([...composite.sprites.values()], sprites);
    assert.deepEqual(composite.bounds, bounds);
    for (const sprite of composite.sprites.values()) {
      const angle = sprite.angle * Math.PI / 180;
      for (const x of [0, 1]) for (const y of [0, 1]) {
        const dx = (x - sprite.anchor.x) * sprite.width, dy = (y - sprite.anchor.y) * sprite.height;
        const px = sprite.position.x + dx * Math.cos(angle) - dy * Math.sin(angle);
        const py = sprite.position.y + dx * Math.sin(angle) + dy * Math.cos(angle);
        assert.ok(px >= bounds.x && px <= bounds.x + bounds.width && py >= bounds.y && py <= bounds.y + bounds.height);
      }
    }
  }
  assert.equal(state.renderCount, start + 5);
  assert.equal(f.buffers.length, 1);
  assert.equal(f.loadCalls.length, 2);
  assert.ok(composite.texture.width * composite.texture.resolution <= 512);
  assert.ok(composite.texture.height * composite.texture.resolution <= 512);
});

test("drag clones share the reached assembly and release it without destroying source images", async t => {
  const f = await fixture(t);
  await f.visual.syncConstructVisual(f.token); await f.settle();
  f.visual.CONSTRUCT_VISUAL_TESTING.previews.set(f.token, { gun: 73 });
  f.visual.syncConstructVisual(f.token, { rotationsDirty: true });
  const original = f.state(), clone = f.createToken(true, f.token);
  f.visual.syncConstructVisual(clone);
  const preview = f.state(clone), shared = original.composite;
  assert.equal(preview.composite, shared);
  assert.equal(shared.refs, 2);
  assert.equal(preview.mesh.alpha, 0.8);
  assert.equal(f.visual.getConstructPartRotations(clone).gun, 73);
  const renders = f.renders.length;
  f.visual.syncConstructVisual(clone);
  assert.equal(f.renders.length, renders);
  f.visual.CONSTRUCT_VISUAL_TESTING.previews.set(f.token, { gun: 90 });
  f.visual.syncConstructVisual(f.token, { rotationsDirty: true });
  assert.notEqual(original.composite, shared, "live yaw detaches from an immutable drag snapshot");
  assert.equal(shared.refs, 1);
  assert.equal(shared.texture.destroyCalls, 0);
  f.visual.destroyConstructVisual(clone);
  assert.equal(shared.texture.destroyCalls, 1);
  assert.equal(f.state(clone), undefined);
  assert.equal(original.composite.texture.destroyCalls, 0);
  assert.ok([...f.loaded.values()].every(texture => texture.destroyCalls === 0));
});

test("fitted mirrored native anchors affect only the final transform and muzzle position", async t => {
  const f = await fixture(t);
  f.token.mesh.width = 80; f.token.mesh.height = 100; f.token.mesh.scale.x *= -1;
  f.token.mesh.anchor.set(0.25, 0.75); f.token.mesh.angle = 90;
  await f.visual.syncConstructVisual(f.token); await f.settle();
  const state = f.state(), composite = state.composite, renders = state.renderCount;
  assert.ok(state.mesh.scale.x < 0);
  near(state.mesh.anchor.x, (composite.width * 0.25 - composite.bounds.x) / composite.bounds.width);
  near(state.mesh.anchor.y, (composite.height * 0.75 - composite.bounds.y) / composite.bounds.height);
  const point = f.visual.CONSTRUCT_VISUAL_TESTING.constructPointToWorld({ x: 1, y: 0 }, f.token);
  near(point.x, 325); near(point.y, 320);
  near(f.visual.CONSTRUCT_VISUAL_TESTING.mirrorConstructRotation(f.token, 30), -30);
  const limits = f.visual.getConstructPartRotationLimitsPose(f.token, "gun");
  near(limits.toWorldAngle(30), 60);
  near(limits.origin.x, 270); near(limits.origin.y, 360);
  f.token.mesh.anchor.set(0.5, 0.5); f.token.mesh.scale.x *= -1;
  f.visual.syncConstructVisual(f.token);
  assert.equal(state.composite, composite);
  assert.equal(state.renderCount, renders);
  assert.ok(state.mesh.scale.x > 0);
});

test("paid aim activation follows the same initial barrel and mirrored pivot as the visible cost cone", async t => {
  const f = await fixture(t);
  const config = f.actor.flags["fallout-maw"].constructVisual;
  config.parts.find(part => part.slotId === "gun").rotationCost = { points: 2, degrees: 30 };
  const combat = { id: "battle", started: true, round: 1, turn: 0, combatant: { actor: f.actor }, combatants: [{ actor: f.actor }] };
  game.combats = [combat]; game.settings = { get: () => true };
  f.token.document.rotation = 180; f.token.document._source = { rotation: 180 };
  f.token.document.flags["fallout-maw"].constructVisualState.rotations.gun = -40;
  f.token.mesh.angle = 180; f.token.mesh.scale.set(-1, -1);
  const sector = f.visual.getConstructPartRotationActivationSector(f.token, "gun");
  near(sector.rotation, 320); near(sector.initialRotation, 320);
  assert.deepEqual([sector.minRotation, sector.maxRotation], [-15, 15]);
  const pose = f.visual.getConstructPartRotationLimitsPose(f.token, "gun");
  assert.deepEqual(sector.origin, pose.origin);
  f.token.mesh.scale.x *= -1;
  const mirrored = f.visual.getConstructPartRotationActivationSector(f.token, "gun");
  near(mirrored.initialRotation, 40);
  assert.deepEqual([mirrored.minRotation, mirrored.maxRotation], [-15, 15]);
  f.visual.updateConstructWeaponAimPreview({ token: f.token, aimActivation: { waiting: true } });
  assert.equal(f.visual.CONSTRUCT_VISUAL_TESTING.rotatingPreviews.has(f.token), false, "waiting input cannot start rotation or request payment");
  game.combats = [];
  assert.equal(f.visual.getConstructPartRotationActivationSector(f.token, "gun"), null);
});

test("physical item damage and item-owned effects refresh installed art without reallocating unchanged layouts", async t => {
  const f = await fixture(t);
  await f.visual.syncConstructVisual(f.token); await f.settle();
  const state = f.state(), gun = f.actor.items.contents.find(item => item.id === "gun"), firstBuffer = state.composite.texture;
  gun.system.functions.condition.value = 99;
  f.hook("updateItem", gun, { system: { functions: { condition: { value: 99 } } } });
  assert.equal(state.composite.texture, firstBuffer, "ordinary wear changes state without replacing unchanged raster bounds");
  gun.system.functions.condition.value = 0;
  f.hook("updateItem", gun, { system: { functions: { condition: { value: 0 } } } });
  assert.equal(f.renders.at(-1).sprites, 1, "a destroyed module disappears from the assembly");
  gun.system.functions.condition.value = 100;
  f.actor.system.limbs["constructPart:gun"] = { value: 0, min: 0 };
  f.hook("updateActiveEffect", { documentName: "ActiveEffect", parent: gun }, { changes: [] });
  assert.equal(f.renders.at(-1).sprites, 1, "an item-owned effect resolves the carrier actor and its broken limb");
  f.actor.system.limbs["constructPart:gun"].value = 100;
  f.hook("deleteActiveEffect", { documentName: "ActiveEffect", parent: gun });
  assert.equal(f.renders.at(-1).sprites, 2, "restored physical hardware becomes visible again");
});

test("native visibility suppresses incomplete drag clones and async image completion cannot resurrect a destroyed token", async t => {
  const f = await fixture(t, { deferred: true });
  const pending = f.visual.syncConstructVisual(f.token);
  assert.equal(f.token.mesh.renderable, true, "native image remains the loading fallback");
  f.visual.destroyConstructVisual(f.token);
  f.finishLoad(); await pending; await f.settle();
  assert.equal(f.state(), undefined);
  assert.equal(f.buffers.length, 0);
  const token = f.createToken();
  token.visible = false;
  await f.visual.syncConstructVisual(token); await f.settle();
  assert.equal(f.state(token).mesh.visible, false);
  token.visible = true; token.renderable = false;
  f.visual.syncConstructVisual(token);
  assert.equal(f.state(token).mesh.visible, false);
  assert.equal(f.state(token).mesh.renderable, false);
  token.renderable = true;
  f.visual.syncConstructVisual(token);
  assert.equal(f.state(token).mesh.visible, true);
});

test("mutable assembly containment refreshes CPU alpha lazily and bypasses the immutable image cache", async t => {
  const f = await fixture(t);
  await f.visual.syncConstructVisual(f.token); await f.settle();
  const state = f.state(), texture = state.composite.texture;
  texture.alphaRegion = "left";
  // Seed the native immutable cache with the old silhouette: invalidating just mesh data cannot fix this.
  foundry.canvas.TextureLoader.getTextureAlphaData(texture, 0.25);
  const left = { x: texture.width * 0.25, y: texture.height * 0.5 };
  const right = { x: texture.width * 0.75, y: texture.height * 0.5 };
  const allocationCount = f.buffers.length;
  assert.equal(state.mesh.containsCanvasPoint(right, 0), true);
  assert.equal(state.mesh.containsPoint(left, 2), false);
  assert.equal(f.extracts.length, 0);
  assert.equal(f.buffers.length, allocationCount);
  assert.equal(state.mesh.containsCanvasPoint(left, 0.5), true);
  assert.equal(state.mesh.containsPoint(right, 0.5), false);
  assert.equal(f.extracts.length, 1);
  assert.equal(f.extracts[0].destroyCalls, 1, "the temporary readback raster is immediately released");
  const clone = f.createToken(true, f.token);
  f.visual.syncConstructVisual(clone);
  assert.equal(f.state(clone).mesh.containsCanvasPoint(left, 0.5), true);
  assert.equal(f.extracts.length, 1, "immutable drag snapshots share the already extracted alpha");
  f.visual.destroyConstructVisual(clone);
  for (let frame = 0; frame < 20; frame++) {
    f.token.mesh.position.x++;
    f.visual.syncConstructVisual(f.token);
  }
  assert.equal(f.extracts.length, 1, "body motion does not read pixels");
  f.visual.CONSTRUCT_VISUAL_TESTING.previews.set(f.token, { gun: 90 });
  f.visual.syncConstructVisual(f.token, { rotationsDirty: true });
  texture.alphaRegion = "right";
  assert.equal(state.composite.texture, texture);
  assert.equal(f.extracts.length, 1, "dirty yaw does not extract until an alpha containment query");
  assert.equal(state.mesh.containsCanvasPoint(right, 0.5), true, "new bounds are refreshed before native early rejection");
  assert.equal(state.mesh.containsPoint(left, 0.5), false);
  assert.equal(f.extracts.length, 2);
  assert.equal(f.loaderAlphaCalls.filter(row => row === texture).length, 1, "mutable pixels never re-enter the loader cache");
  assert.ok(f.extracts.every(row => row.destroyCalls === 1));
  assert.equal(texture.destroyCalls, 0, "readback does not destroy the owned assembly buffer");
});

test("independent weapon muzzles converge separately and unavailable explicit bindings prevent execution", async t => {
  const f = await fixture(t);
  const config = f.actor.flags["fallout-maw"].constructVisual;
  config.anchors.push(
    { id: "left-muzzle", parentSlotId: "gun", x: -0.1, y: -0.3 },
    { id: "right-muzzle", parentSlotId: "gun", x: 0.1, y: -0.3 });
  const weapon = muzzleAnchorId => ({ id: muzzleAnchorId, actor: f.actor, system: { functions: {
    weapon: { enabled: true, requiresOperator: false, operatorPartSlotId: "gun", muzzleAnchorId }
  } } });
  const left = weapon("left-muzzle"), right = weapon("right-muzzle"), cursor = { x: 250, y: 100 };
  const leftOrigin = f.visual.getConstructWeaponAimOrigin(f.token, left);
  const rightOrigin = f.visual.getConstructWeaponAimOrigin(f.token, right);
  assert.ok(leftOrigin.x < rightOrigin.x, "two physical guns retain their separate lateral muzzle origins");
  const leftAim = f.visual.getConstructPartAim(f.token, "gun", cursor, { muzzleAnchorId: "left-muzzle" });
  const rightAim = f.visual.getConstructPartAim(f.token, "gun", cursor, { muzzleAnchorId: "right-muzzle" });
  assert.ok(leftAim.rotation > 0 && rightAim.rotation < 0, "each muzzle requires its own off-center convergence correction");
  for (const [gun, aim] of [[left, leftAim], [right, rightAim]]) {
    f.visual.CONSTRUCT_VISUAL_TESTING.previews.set(f.token, { gun: aim.rotation });
    const point = f.visual.getConstructWeaponAimPoint(f.token, gun, cursor);
    near(point.x, cursor.x); near(point.y, cursor.y);
  }
  f.visual.CONSTRUCT_VISUAL_TESTING.previews.delete(f.token);
  const removed = weapon("removed-muzzle");
  assert.equal(f.visual.getConstructWeaponAimOrigin(f.token, removed), null);
  assert.equal(f.visual.getConstructPartAim(f.token, "gun", cursor, { muzzleAnchorId: "removed-muzzle" }), null);
  assert.equal(f.visual.getConstructWeaponAimPoint(f.token, removed, cursor), null);
  assert.equal(await f.visual.prepareConstructWeaponAttackExecution({ token: f.token, weapon: removed, pointer: cursor }), false);
  assert.equal(f.notices.at(-1), "Точка выстрела недоступна.");
  config.anchors.find(anchor => anchor.id === "left-muzzle").parentSlotId = "hull";
  f.actor.items.contents = f.actor.items.contents.filter(item => item.id !== "hull");
  assert.equal(f.visual.getConstructWeaponAimOrigin(f.token, left), null, "an anchor on an absent physical parent cannot become a pivot-origin shot");
  assert.equal(f.visual.getConstructPartAim(f.token, "gun", cursor, { muzzleAnchorId: "left-muzzle" }), null);
  assert.ok(f.visual.getConstructPartAim(f.token, "gun", cursor), "unconfigured standalone aiming retains the part-origin fallback");
});
