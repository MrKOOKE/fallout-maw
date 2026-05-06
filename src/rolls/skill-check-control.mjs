import { FALLOUT_MAW } from "../config/system-config.mjs";
import { SkillCheckControl } from "../apps/skill-check-control.mjs";
import {
  DEFAULT_SKILL_CHECK_CONTROL,
  getSkillCheckControl,
  setSkillCheckControl
} from "../settings/accessors.mjs";
import { toInteger } from "../utils/numbers.mjs";

let hooksRegistered = false;
let socketRegistered = false;

export function registerSkillCheckControlHooks() {
  if (hooksRegistered) return;
  Hooks.on("getSceneControlButtons", addSkillCheckControlButton);
  Hooks.on("fallout-maw.modifySkillCheck", applySkillCheckControl);
  hooksRegistered = true;
}

export function registerSkillCheckControlSocket() {
  if (socketRegistered) return;
  game.socket.on(`system.${FALLOUT_MAW.id}`, handleSkillCheckControlSocketMessage);
  socketRegistered = true;
}

export function refreshSkillCheckControlButton() {
  if (!game.user?.isGM || !ui.controls?.rendered) return;
  void ui.controls.render({ force: true, reset: true });
}

function addSkillCheckControlButton(controls) {
  if (!game.user.isGM) return;
  const tokenControls = controls.tokens;
  if (!tokenControls?.tools || tokenControls.tools.falloutMawSkillCheckControl) return;

  tokenControls.tools.falloutMawSkillCheckControl = {
    name: "falloutMawSkillCheckControl",
    title: "FALLOUTMAW.SkillCheckControl.Title",
    icon: "fa-solid fa-sliders",
    order: Object.keys(tokenControls.tools).length,
    button: true,
    visible: true,
    onChange: () => toggleSkillCheckControlWindow()
  };
}

function toggleSkillCheckControlWindow() {
  const existing = foundry.applications.instances.get("fallout-maw-skill-check-control");
  if (existing) return existing.close();
  return new SkillCheckControl().render({ force: true });
}

function applySkillCheckControl(check) {
  const control = getSkillCheckControl();

  check.situationalModifier = toInteger(check.situationalModifier) + control.skillModifier;
  check.difficulty = toInteger(check.difficulty) + control.difficultyModifier;
  check.criticalSuccessBonus = toInteger(check.criticalSuccessBonus) + control.criticalSuccessBonus;
  check.criticalFailureBonus = toInteger(check.criticalFailureBonus) + control.criticalFailureBonus;

  if (control.edgeMode === "advantage") check.advantageCount = Math.max(1, toInteger(check.advantageCount) + 1);
  if (control.edgeMode === "disadvantage") check.disadvantageCount = Math.max(1, toInteger(check.disadvantageCount) + 1);
  if (control.resultMode !== "standard") check.forcedResult = control.resultMode;

  consumeOneUseControls(control);
}

function consumeOneUseControls(control) {
  const { next, changed } = buildConsumedSkillCheckControl(control);

  if (!changed) return;
  if (!game.user.isGM) {
    game.socket.emit(`system.${FALLOUT_MAW.id}`, {
      action: "consumeSkillCheckControl",
      userId: game.user.id
    });
    return;
  }

  applyConsumedSkillCheckControl(next);
}

function handleSkillCheckControlSocketMessage(payload = {}) {
  if (payload?.action !== "consumeSkillCheckControl" || !game.user.isGM) return;
  const control = getSkillCheckControl();
  const { next, changed } = buildConsumedSkillCheckControl(control);

  if (changed) applyConsumedSkillCheckControl(next);
}

function buildConsumedSkillCheckControl(control) {
  const next = { ...control };
  let changed = false;

  if (control.resetResultAfterUse && control.resultMode !== "standard") {
    next.resultMode = DEFAULT_SKILL_CHECK_CONTROL.resultMode;
    changed = true;
  }

  if (control.resetModifiersAfterUse && hasActiveModifiers(control)) {
    next.skillModifier = DEFAULT_SKILL_CHECK_CONTROL.skillModifier;
    next.difficultyModifier = DEFAULT_SKILL_CHECK_CONTROL.difficultyModifier;
    next.criticalSuccessBonus = DEFAULT_SKILL_CHECK_CONTROL.criticalSuccessBonus;
    next.criticalFailureBonus = DEFAULT_SKILL_CHECK_CONTROL.criticalFailureBonus;
    changed = true;
  }

  if (control.resetEdgeModeAfterUse && control.edgeMode !== "none") {
    next.edgeMode = DEFAULT_SKILL_CHECK_CONTROL.edgeMode;
    changed = true;
  }

  return { next, changed };
}

function applyConsumedSkillCheckControl(next) {
  void setSkillCheckControl(next)
    .then(() => rerenderOpenControlWindow())
    .catch(error => console.warn(`${FALLOUT_MAW.title} | Failed to consume skill check control`, error));
}

function hasActiveModifiers(control) {
  return toInteger(control.skillModifier) !== 0
    || toInteger(control.difficultyModifier) !== 0
    || toInteger(control.criticalSuccessBonus) !== 0
    || toInteger(control.criticalFailureBonus) !== 0;
}

function rerenderOpenControlWindow() {
  const app = foundry.applications.instances.get("fallout-maw-skill-check-control");
  app?.render({ force: true });
}
