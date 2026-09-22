import { SYSTEM_ID } from "../constants.mjs";
import { RESEARCH_LEGACY_PROGRESS_SETTING } from "./constants.mjs";

export function isLegacyResearchProgress() {
  return globalThis.game?.settings?.get(SYSTEM_ID, RESEARCH_LEGACY_PROGRESS_SETTING) === true;
}
