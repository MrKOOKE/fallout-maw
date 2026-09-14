import { BLEEDING_DAMAGE_TYPE_KEY, SYSTEM_ID } from "../constants.mjs";
import { getDamageTypeSettings } from "../settings/accessors.mjs";
import { isLimbDestroyed } from "../utils/limb-state.mjs";
import { getPeriodicDamageVisualState } from "./periodic-damage-visual-state.mjs";
import { createPeriodicDamageNoiseFilter } from "./periodic-damage-noise-filter.mjs";

const masks = new WeakMap();
let damageColors = null;
let hooksRegistered = false;

export function registerPeriodicDamageMaskHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  // Settings/preset changes can change both damage colors and maximum health.
  Hooks.on(`${SYSTEM_ID}.preparedActorsRefreshed`, () => {
    damageColors = null;
    if (!globalThis.canvas?.ready) return;
    for (const token of canvas.tokens?.placeables ?? []) refreshTokenPeriodicDamageMask(token);
  });
}

/** Called by the native effect-redraw lifecycle, including related Actor updates. */
export function refreshTokenPeriodicDamageMask(token) {
  if (!token.mesh || token.destroyed) return destroyTokenPeriodicDamageMask(token);
  const state = getPeriodicDamageVisualState(token.actor, { isLimbDestroyed });
  if (!state) return destroyTokenPeriodicDamageMask(token);
  damageColors ??= new Map(getDamageTypeSettings().map(type => [type.key, parseColor(type.color)]));
  // Every periodic effect uses its own damage type's configured color.
  const color = damageColors.get(state.damageTypeKey) ?? 0xb82020;

  let mask = masks.get(token);
  if (mask && mask.mesh !== token.mesh) {
    destroyTokenPeriodicDamageMask(token);
    mask = null;
  }
  if (!mask) {
    mask = { mesh: token.mesh, filter: createPeriodicDamageNoiseFilter(tokenSeed(token)) };
    masks.set(token, mask);
  }
  const filter = mask.filter;
  if (!mask.mesh.filters?.includes(filter)) {
    // Apply before native invisibility/transition filters so they keep authority
    // over the final appearance. Never replace another module's filters.
    mask.mesh.filters = [filter, ...(mask.mesh.filters ?? [])];
  }
  filter.uniforms.damageColor[0] = ((color >> 16) & 255) / 255;
  filter.uniforms.damageColor[1] = ((color >> 8) & 255) / 255;
  filter.uniforms.damageColor[2] = (color & 255) / 255;
  filter.uniforms.intensity = state.intensity;
  filter.uniforms.bleedingFlow = state.damageTypeKey === BLEEDING_DAMAGE_TYPE_KEY ? 1 : 0;
  refreshTokenPeriodicDamageMaskVisibility(token);
}

/** Constant-time visibility sync; hovering never recalculates periodic damage. */
export function refreshTokenPeriodicDamageMaskVisibility(token) {
  const filter = masks.get(token)?.filter;
  if (filter) filter.enabled = !token.document.isSecret;
}

export function destroyTokenPeriodicDamageMask(token) {
  const mask = masks.get(token);
  if (!mask) return;
  masks.delete(token);
  if (mask.mesh.filters?.includes(mask.filter)) {
    const remaining = mask.mesh.filters.filter(filter => filter !== mask.filter);
    mask.mesh.filters = remaining.length ? remaining : null;
  }
  mask.filter.destroy();
}

function parseColor(value) {
  const hex = String(value ?? "").replace(/^#/, "");
  return /^[0-9a-f]{6}$/i.test(hex) ? parseInt(hex, 16) : 0xb82020;
}

function tokenSeed(token) {
  let seed = 0;
  for (const character of String(token.id ?? "")) seed = ((seed * 31) + character.charCodeAt(0)) & 0xffff;
  return seed % 1024;
}
