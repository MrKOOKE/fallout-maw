import {
  BASIC_SIGHT_DETECTION_MODE_ID,
  DETECTION_MODE_RANGE_TOKEN_CHANGE_MARKER,
  getDetectionModeRangeEffectKey
} from "../canvas/vision-effect-keys.mjs";
import { SYSTEM_ID } from "../constants.mjs";
import { executeInventoryMutation } from "../inventory/mutation.mjs";
import {
  EFFECT_EXPIRATION_ACTIONS,
  getEffectExpirationAction,
  isEffectActuallyExpired
} from "../effects/expiration-actions.mjs";

const LIGHT_PERCEPTION_DETECTION_MODE_ID = "lightPerception";
const pendingExpirationActions = new Set();

/**
 * System ActiveEffect implementation for narrowly scoped semantic changes.
 */
export class FalloutMaWActiveEffect extends ActiveEffect {
  _onDelete(options, userId) {
    super._onDelete(options, userId);
    if (!game.user?.isActiveGM) return;
    void this.executeExpirationAction();
  }

  /** Execute the action stored by this effect only when its duration has ended. */
  async executeExpirationAction() {
    if (
      !isEffectActuallyExpired(this)
      || getEffectExpirationAction(this) !== EFFECT_EXPIRATION_ACTIONS.deleteBearer
    ) return false;
    const item = this.parent;
    const actor = item?.parent;
    const itemId = String(item?.id ?? "");
    const operationKey = String(item?.uuid ?? itemId);
    if (!itemId || actor?.documentName !== "Actor" || !actor.items?.get?.(itemId)) return false;
    if (pendingExpirationActions.has(operationKey)) return false;

    pendingExpirationActions.add(operationKey);
    try {
      await executeInventoryMutation({ actor, deletes: [itemId] }, {
        reason: "effect-expiration-action",
        render: true
      });
      ui.notifications.info(`${item.name}: срок годности истёк.`);
      return true;
    } catch (error) {
      console.error(`${SYSTEM_ID} | Failed to execute ActiveEffect expiration action`, error);
      ui.notifications.error(`${item.name}: не удалось выполнить действие истёкшего эффекта.`);
      return false;
    } finally {
      pendingExpirationActions.delete(operationKey);
    }
  }

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
