const tokenTargetAlphaProviders = new Map();

export function registerTokenTargetAlphaProvider(id = "", provider = null) {
  const key = String(id ?? "").trim();
  if (!key || typeof provider !== "function" || tokenTargetAlphaProviders.has(key)) return false;
  tokenTargetAlphaProviders.set(key, provider);
  return true;
}

export function unregisterTokenTargetAlphaProvider(id = "") {
  return tokenTargetAlphaProviders.delete(String(id ?? "").trim());
}

export function resolveTokenTargetAlpha(token = null, baseAlpha = 1) {
  let alpha = clampAlpha(baseAlpha);
  for (const provider of tokenTargetAlphaProviders.values()) {
    const candidate = provider(token, alpha);
    if (candidate === null || candidate === undefined) continue;
    alpha = clampAlpha(candidate);
  }
  return alpha;
}

function clampAlpha(value) {
  const alpha = Number(value);
  return Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1;
}
