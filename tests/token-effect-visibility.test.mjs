import assert from "node:assert/strict";
import test from "node:test";

// Model loaded 2048px textures and deferred render flags: a frame may be drawn
// after a hover refresh, before flags queued by that refresh are processed.
class DisplayObject {
  constructor() {
    this.width = this.height = 2048;
    this.visible = true;
    this.position = { set: (x, y) => { this.x = x; this.y = y; } };
    this.anchor = { set() {} };
  }
  on() {}
  destroy() {}
}

class Graphics extends DisplayObject {
  shapes = [];
  clear() { this.shapes = []; return this; }
  beginFill() { return this; }
  beginTextureFill() { return this; }
  lineStyle() { return this; }
  endFill() { return this; }
  drawRoundedRect(...args) { this.shapes.push(args); return this; }
  drawPolygon(points) { this.shapes.push(points); return this; }
}

class EffectsContainer {
  children = [];
  renderable = true;
  addChild(icon) { this.children.push(icon); return icon; }
  removeChildren() { return this.children.splice(0); }
  sortChildren() { this.children.sort((a, b) => a.zIndex - b.zIndex); }
}

class NativeToken {
  constructor() {
    this.effects = new EffectsContainer();
    this.document = {
      isSecret: false,
      getSize: () => ({ width: 100, height: 100 }),
      getCenterPoint: () => ({ x: 50, y: 50 })
    };
    this.hover = false;
    this.pendingFlags = {};
    this.renderFlags = { set: flags => Object.assign(this.pendingFlags, flags) };
  }
  async _drawEffect() { return this.effects.addChild(new DisplayObject()); }
  _refreshState() { this.effects.visible = !this.document.isSecret; }
  _refreshEffects() {
    const bg = this.effects.bg.clear();
    let index = 0;
    for (const icon of this.effects.children) {
      if (icon === bg) continue;
      if (icon === this.effects.overlay) {
        icon.width = icon.height = 60;
        icon.position = { x: 50, y: 50 };
      } else {
        icon.width = icon.height = 20;
        icon.position.set(Math.floor(index / 5) * 20, (index % 5) * 20);
        bg.drawRoundedRect(icon.x + 1, icon.y + 1, 18, 18, 2);
        index += 1;
      }
    }
  }
}

let displayMode = "hover";
globalThis.foundry = {
  applications: {
    apps: { FilePicker: { implementation: class {} } },
    sheets: { ActorSheetV2: class {}, ItemSheetV2: class {} },
    api: { ApplicationV2: class {}, DialogV2: {}, HandlebarsApplicationMixin: Base => class extends Base {} },
    ux: { FormDataExtended: class {}, TextEditor: { implementation: {} } },
    handlebars: { renderTemplate: async () => "" }
  },
  canvas: {
    placeables: { Token: NativeToken },
    loadTexture: async () => ({ width: 2048, height: 2048 })
  },
  utils: {
    randomID: () => "test-id",
    deepClone: structuredClone,
    mergeObject: (a, b) => ({ ...structuredClone(a), ...structuredClone(b) }),
    escapeHTML: String,
    cleanHTML: String
  }
};
globalThis.game = {
  user: { id: "test-user" },
  i18n: { has: () => false, localize: String, format: String },
  settings: { get: () => ({ activeEffectDisplay: displayMode }) }
};
globalThis.PIXI = { Graphics };
globalThis.CONST = { ACTIVE_EFFECT_SHOW_ICON: { NEVER: 0, ALWAYS: 1, CONDITIONAL: 2 } };
globalThis.canvas = { dimensions: { uiScale: 1 }, grid: { isHexagonal: false, columns: true } };

const { FalloutMaWToken } = await import("../src/canvas/token.mjs");

function effect(status = "", { overlay = false, showIcon = 1 } = {}) {
  return { img: "effect.webp", flags: { core: { overlay } }, statuses: new Set([status]), showIcon };
}

function visibleIcons(token) {
  if (!token.effects.visible || !token.effects.renderable) return [];
  return token.effects.children.filter(icon => icon !== token.effects.bg && icon.visible);
}

function assertFrame(token, count) {
  const icons = visibleIcons(token);
  assert.equal(icons.length, count);
  for (const icon of icons) {
    assert.ok(icon.width > 0 && icon.width <= 60, `visible icon width is ${icon.width}`);
    assert.ok(icon.height > 0 && icon.height <= 60, `visible icon height is ${icon.height}`);
  }
  const regular = icons.filter(icon => icon !== token.effects.overlay);
  if (token.effects.visible) assert.equal(token.effects.bg.shapes.length, regular.length);
}

for (const hexagonal of [false, true]) {
  const grid = hexagonal ? "hexagonal" : "square";

  test(`${grid}: first hover sizes hidden icons before the next render-flags pass`, async () => {
    canvas.grid.isHexagonal = hexagonal;
    displayMode = "hover";
    const token = new FalloutMaWToken();
    token.actor = { appliedEffects: [effect(), effect("", { overlay: true })] };
    await token._drawEffects();
    token._refreshEffects();
    assertFrame(token, 0);

    token.hover = true;
    token._refreshState();
    assertFrame(token, 2);
  });

  test(`${grid}: completed redraw exposes only sized icons, including permanent overlays`, async () => {
    canvas.grid.isHexagonal = hexagonal;
    for (const mode of ["hover", "always"]) {
      displayMode = mode;
      const token = new FalloutMaWToken();
      token.actor = { appliedEffects: [
        effect(), effect("unconscious", { showIcon: 0 }), effect("dead", { overlay: true, showIcon: 0 })
      ] };
      await token._drawEffects();
      assertFrame(token, mode === "always" ? 3 : 2);
    }
  });

  test(`${grid}: hover transitions keep death and unconsciousness, compact backgrounds and avoid unchanged layouts`, async () => {
    canvas.grid.isHexagonal = hexagonal;
    displayMode = "hover";
    const token = new FalloutMaWToken();
    token.actor = { appliedEffects: [effect(), effect("unconscious"), effect("dead", { overlay: true })] };
    await token._drawEffects();
    token._refreshEffects();
    assertFrame(token, 2);

    // Hover work must reuse the drawn icons instead of scanning Actor effects.
    Object.defineProperty(token.actor, "appliedEffects", { get() { throw new Error("Actor effects reread on hover"); } });
    for (const hovered of [true, false, true, false]) {
      token.hover = hovered;
      token._refreshState();
      assertFrame(token, hovered ? 3 : 2);
    }
    displayMode = "always";
    token._refreshState();
    assertFrame(token, 3);
    token.document.isSecret = true;
    token._refreshState();
    assertFrame(token, 0);
    token.document.isSecret = false;
    token._refreshState();
    assertFrame(token, 3);

    token.pendingFlags = {};
    token._refreshEffects = () => { throw new Error("Unchanged icons relaid out"); };
    token._refreshState();
    assert.deepEqual(token.pendingFlags, {});
  });
}
