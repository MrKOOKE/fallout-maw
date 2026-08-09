export const DETECTION_MODE_RANGE_EFFECT_KEY_PREFIX = "fallout-maw.vision.detectionModes.";
export const DETECTION_MODE_RANGE_EFFECT_KEY_SUFFIX = ".range";
export const DETECTION_MODE_RANGE_TOKEN_CHANGE_MARKER = "_falloutMawDetectionModeRange";
export const BASIC_SIGHT_DETECTION_MODE_ID = "basicSight";

const DETECTION_MODE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Build the semantic Actor Active Effect key for one Foundry detection mode.
 */
export function getDetectionModeRangeEffectKey(modeId = "") {
  const id = normalizeDetectionModeId(modeId);
  return id
    ? `${DETECTION_MODE_RANGE_EFFECT_KEY_PREFIX}${id}${DETECTION_MODE_RANGE_EFFECT_KEY_SUFFIX}`
    : "";
}

/**
 * Resolve a semantic vision key back to its Foundry detection mode id.
 */
export function getDetectionModeIdFromRangeEffectKey(effectKey = "") {
  const key = String(effectKey ?? "").trim();
  if (!key.startsWith(DETECTION_MODE_RANGE_EFFECT_KEY_PREFIX)
    || !key.endsWith(DETECTION_MODE_RANGE_EFFECT_KEY_SUFFIX)) return "";
  const id = key.slice(
    DETECTION_MODE_RANGE_EFFECT_KEY_PREFIX.length,
    -DETECTION_MODE_RANGE_EFFECT_KEY_SUFFIX.length
  );
  return normalizeDetectionModeId(id);
}

/**
 * Return the detection modes registered with Foundry as stable effect-key
 * descriptors. This naturally includes modes supplied by other packages.
 */
export function getDetectionModeRangeEffectKeyDescriptors(
  detectionModes = globalThis.CONFIG?.Canvas?.detectionModes ?? {}
) {
  const descriptors = [];
  const seen = new Set();
  for (const [registryId, definition] of Object.entries(detectionModes ?? {})) {
    const id = normalizeDetectionModeId(definition?.id ?? registryId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    descriptors.push({
      id,
      label: String(definition?.label ?? id).trim() || id,
      path: getDetectionModeRangeEffectKey(id)
    });
  }
  return descriptors.sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Expand one semantic vision change into native TokenDocument changes. The
 * source and selected detection mode are enabled before Foundry applies the
 * original operation to the range.
 */
export function expandDetectionModeRangeEffectChange(change = {}) {
  const modeId = getDetectionModeIdFromRangeEffectKey(change?.key);
  if (!modeId) return null;
  const rangeKey = `detectionModes.${modeId}.range`;
  const changes = [
    {
      ...change,
      key: "sight.enabled",
      type: "add",
      value: true
    },
    {
      ...change,
      key: `detectionModes.${modeId}.enabled`,
      type: "add",
      value: true
    }
  ];

  // Foundry builds VisionSource.radius (the visible sight boundary and the
  // geometry constrained by smoke) from sight.range, while token detection is
  // tested against detectionModes.basicSight.range. Keep both native values on
  // the same operation for Night Vision; other senses must not enlarge normal
  // sight geometry.
  if (modeId === BASIC_SIGHT_DETECTION_MODE_ID) {
    changes.push({
      ...change,
      key: "sight.range"
    });
  }

  changes.push({
    ...change,
    key: rangeKey,
    [DETECTION_MODE_RANGE_TOKEN_CHANGE_MARKER]: modeId
  });
  return changes;
}

function normalizeDetectionModeId(value) {
  const id = String(value ?? "").trim();
  return DETECTION_MODE_ID_PATTERN.test(id) ? id : "";
}
