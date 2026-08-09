import {
  BASIC_SIGHT_DETECTION_MODE_ID,
  DETECTION_MODE_RANGE_TOKEN_CHANGE_MARKER,
  getDetectionModeRangeEffectKey
} from "../canvas/vision-effect-keys.mjs";

const LIGHT_PERCEPTION_DETECTION_MODE_ID = "lightPerception";

/**
 * System ActiveEffect implementation for narrowly scoped semantic changes.
 */
export class FalloutMaWActiveEffect extends ActiveEffect {
  static applyChange(targetDocument, change, options = {}) {
    const marker = change?.[DETECTION_MODE_RANGE_TOKEN_CHANGE_MARKER];
    if (!marker || targetDocument?.documentName !== "Token" || options.modifyTarget === false) {
      return super.applyChange(targetDocument, change, options);
    }

    const modeId = String(marker);
    const rangeKey = `detectionModes.${modeId}.range`;
    if (!getDetectionModeRangeEffectKey(modeId) || change.key !== rangeKey) {
      return super.applyChange(targetDocument, change, options);
    }

    if (modeId === BASIC_SIGHT_DETECTION_MODE_ID) {
      const range = targetDocument.sight?.range;
      foundry.utils.setProperty(targetDocument, rangeKey, range);
      return { [rangeKey]: range };
    }

    const sourceMode = targetDocument._source?.detectionModes?.[modeId];
    const currentRange = foundry.utils.getProperty(targetDocument, rangeKey);
    const disabledUnlimitedPlaceholder = sourceMode?.enabled === false && sourceMode.range == null;
    const missingFiniteMode = !sourceMode && modeId !== LIGHT_PERCEPTION_DETECTION_MODE_ID;
    if (!Number.isFinite(currentRange) && (disabledUnlimitedPlaceholder || missingFiniteMode)) {
      foundry.utils.setProperty(targetDocument, rangeKey, 0);
    }
    return super.applyChange(targetDocument, change, options);
  }
}
