import { FALLOUT_MAW } from "../config/system-config.mjs";
import { COMBAT_CAROUSEL_ENABLED_SETTING } from "../settings/constants.mjs";
import { getBaselineDefault } from "../settings/baseline.mjs";
import { CombatDock } from "./combat-carousel/combat-dock.mjs";
import { CombatantPortrait } from "./combat-carousel/combatant-portrait.mjs";
import {
  defaultAttributesConfig,
  generateDescription,
  getInitiativeDisplay,
  getSystemIcons
} from "./combat-carousel/systems.mjs";

const MODULE_ID = FALLOUT_MAW.id;

let settingsRegistered = false;

export function registerCombatCarouselHooks() {
  registerCombatCarouselSettings();

  CONFIG.combatTrackerDock = {
    CombatDock,
    CombatantPortrait,
    defaultAttributesConfig,
    generateDescription,
    getInitiativeDisplay,
    getSystemIcons,
    INTRO_ANIMATION_DURATION: 1000,
    INTRO_ANIMATION_DELAY: 0.25
  };

  Hooks.on("createCombat", combat => {
    if (isCombatCarouselEnabled() && game.combat === combat) new CombatDock(combat).render(true);
  });

  Hooks.on("updateCombat", (combat, updates) => {
    if (!isCombatCarouselEnabled()) {
      ui.combatDock?.close();
      return;
    }
    if (updates.active || updates.scene === null) new CombatDock(combat).render(true);
    if (updates.scene && combat.scene !== game.scenes.viewed && ui.combatDock?.combat === combat) ui.combatDock.close();
  });

  Hooks.on("canvasReady", () => {
    Hooks.once("renderCombatTracker", () => {
      if (!isCombatCarouselEnabled()) return ui.combatDock?.close();
      const currentCombat = getCurrentCombat();
      if (currentCombat) new CombatDock(currentCombat).render(true);
      else ui.combatDock?.close();
    });
  });

  registerCombatCarouselHotkeys();
}

export function initializeCombatCarousel() {
  applyCombatCarouselSettings();
  if (!isCombatCarouselEnabled()) {
    ui.combatDock?.close();
    return;
  }
  const currentCombat = getCurrentCombat();
  if (currentCombat) new CombatDock(currentCombat).render(true);
}

export function refreshCombatCarousel() {
  applyCombatCarouselSettings();
  if (!isCombatCarouselEnabled()) return ui.combatDock?.close();
  ui.combatDock?.refresh();
}

function getCurrentCombat() {
  return ui.combat?.viewed ?? game.combats?.active ?? game.combat ?? null;
}

function isCombatCarouselEnabled() {
  return Boolean(game.settings.get(MODULE_ID, COMBAT_CAROUSEL_ENABLED_SETTING));
}

function registerCombatCarouselSettings() {
  if (settingsRegistered) return;
  settingsRegistered = true;

  registerSetting("attributes", {
    scope: "world",
    type: Array,
    default: getBaselineDefault("attributes", defaultAttributesConfig()[game.system.id] ?? []),
    onChange: refreshCombatCarousel
  });
  registerSetting("events", { scope: "world", type: Array, default: getBaselineDefault("events", []) });
  registerSetting("direction", { scope: "world", type: String, default: getBaselineDefault("direction", "rowDocked"), onChange: restartCombatCarousel });
  registerSetting("portraitSize", { scope: "client", type: String, default: getBaselineDefault("portraitSize", "70px"), onChange: refreshCombatCarousel });
  registerSetting("lessButtons", { scope: "client", type: Boolean, default: getBaselineDefault("lessButtons", false), onChange: rerenderCombatCarousel });
  registerSetting("overflowStyle", { scope: "client", type: String, default: getBaselineDefault("overflowStyle", "autofit"), onChange: refreshCombatCarousel });
  registerSetting("carouselStyle", { scope: "world", type: Number, default: getBaselineDefault("carouselStyle", 0), onChange: refreshCombatCarousel });
  registerSetting("alignment", { scope: "world", type: String, default: getBaselineDefault("alignment", "center"), onChange: refreshCombatCarousel });
  registerSetting("floatingSize", { scope: "world", type: Number, default: getBaselineDefault("floatingSize", 60), onChange: refreshCombatCarousel });
  registerSetting("portraitAspect", { scope: "world", type: Number, default: getBaselineDefault("portraitAspect", 1.5), onChange: refreshCombatCarousel });
  registerSetting("roundness", { scope: "world", type: String, default: getBaselineDefault("roundness", "0%"), onChange: refreshCombatCarousel });
  registerSetting("attributeColor", { scope: "world", type: String, default: getBaselineDefault("attributeColor", "#41AA7D"), onChange: refreshCombatCarousel });
  registerSetting("attributeColor2", { scope: "world", type: String, default: getBaselineDefault("attributeColor2", "#ffcd00"), onChange: refreshCombatCarousel });
  registerSetting("attributeColorPortrait", { scope: "world", type: String, default: getBaselineDefault("attributeColorPortrait", "#e62121"), onChange: refreshCombatCarousel });
  registerSetting("barsPlacement", { scope: "world", type: String, default: getBaselineDefault("barsPlacement", "left"), onChange: refreshCombatCarousel });
  registerSetting("attributeVisibility", { scope: "world", type: String, default: getBaselineDefault("attributeVisibility", "both"), onChange: refreshCombatCarousel });
  registerSetting("displayDescriptions", { scope: "world", type: String, default: getBaselineDefault("displayDescriptions", "owner"), onChange: refreshCombatCarousel });
  registerSetting("hideDefeated", { scope: "world", type: Boolean, default: getBaselineDefault("hideDefeated", false), onChange: refreshCombatCarousel });
  registerSetting("showDispositionColor", { scope: "world", type: Boolean, default: getBaselineDefault("showDispositionColor", true), onChange: refreshCombatCarousel });
  registerSetting("showInitiativeOnPortrait", { scope: "world", type: Boolean, default: getBaselineDefault("showInitiativeOnPortrait", true), onChange: refreshCombatCarousel });
  registerSetting("portraitImage", { scope: "world", type: String, default: getBaselineDefault("portraitImage", "actor"), onChange: refreshCombatCarousel });
  registerSetting("displayName", { scope: "world", type: String, default: getBaselineDefault("displayName", "default"), onChange: refreshCombatCarousel });
  registerSetting("playerPlayerPermission", { scope: "world", type: Boolean, default: getBaselineDefault("playerPlayerPermission", false), onChange: refreshCombatCarousel });
  registerSetting("hideFirstRound", { scope: "world", type: Boolean, default: getBaselineDefault("hideFirstRound", false), onChange: refreshCombatCarousel });
  registerSetting("hideEnemyInitiative", { scope: "world", type: Boolean, default: getBaselineDefault("hideEnemyInitiative", false), onChange: refreshCombatCarousel });
  registerSetting("portraitImageBorder", {
    scope: "world",
    type: String,
    default: getBaselineDefault("portraitImageBorder", `systems/${MODULE_ID}/assets/combat-carousel/border.png`),
    onChange: refreshCombatCarousel
  });
  registerSetting("portraitImageBackground", { scope: "world", type: String, default: getBaselineDefault("portraitImageBackground", "ui/denim075.png"), onChange: refreshCombatCarousel });
  registerSetting("showSystemIcons", { scope: "world", type: Number, default: getBaselineDefault("showSystemIcons", 0), onChange: refreshCombatCarousel });
  registerSetting("hideConflictingUIs", { scope: "world", type: Boolean, default: getBaselineDefault("hideConflictingUIs", true), onChange: applyCombatCarouselSettings });
  registerSetting("resource", { scope: "world", type: String, default: getBaselineDefault("resource", ""), onChange: refreshCombatCarousel });
  registerSetting("portraitResource", { scope: "world", type: String, default: getBaselineDefault("portraitResource", ""), onChange: refreshCombatCarousel });
}

function registerSetting(key, data) {
  if (game.settings.settings.has(`${MODULE_ID}.${key}`)) return;
  game.settings.register(MODULE_ID, key, {
    name: `Combat Carousel: ${key}`,
    config: false,
    ...data
  });
}

function registerCombatCarouselHotkeys() {
  if (game.keybindings.actions.has(`${MODULE_ID}.combatCarouselPrev`)) return;
  game.keybindings.register(MODULE_ID, "combatCarouselPrev", {
    name: "Combat Carousel: Previous Turn",
    editable: [{ key: "KeyN", modifiers: [foundry.helpers.interaction.KeyboardManager.MODIFIER_KEYS.SHIFT] }],
    restricted: false,
    onDown: () => {},
    onUp: () => {
      if (game.combat?.combatant?.isOwner) game.combat.previousTurn();
    }
  });

  game.keybindings.register(MODULE_ID, "combatCarouselNext", {
    name: "Combat Carousel: Next Turn",
    editable: [{ key: "KeyM", modifiers: [foundry.helpers.interaction.KeyboardManager.MODIFIER_KEYS.SHIFT] }],
    restricted: false,
    onDown: () => {},
    onUp: () => {
      if (game.combat?.combatant?.isOwner) game.combat.nextTurn();
    }
  });
}

async function restartCombatCarousel() {
  applyCombatCarouselSettings();
  await ui.combatDock?.restart();
}

function rerenderCombatCarousel() {
  applyCombatCarouselSettings();
  ui.combatDock?.render({ force: true });
}

function applyCombatCarouselSettings() {
  if (!game.settings.settings.has(`${MODULE_ID}.direction`)) return;
  setFloatingSize();
  setPortraitSize();
  setPortraitAspect();
  setAlignment();
  setDirection();
  setFlex();
  setOverflowStyle();
  setRoundness();
  setAttributeColor();
  setPortraitImageBorder();
  setPortraitImageBackground();
  setHideConflictingUIs();
}

function setFloatingSize() {
  document.documentElement.style.setProperty("--carousel-floating-size", `${game.settings.get(MODULE_ID, "floatingSize")}%`);
}

function setPortraitSize() {
  document.documentElement.style.setProperty("--combatant-portrait-size", game.settings.get(MODULE_ID, "portraitSize"));
}

function setPortraitAspect() {
  document.documentElement.style.setProperty("--combatant-portrait-aspect", game.settings.get(MODULE_ID, "portraitAspect"));
}

function setAlignment() {
  document.documentElement.style.setProperty("--carousel-alignment", game.settings.get(MODULE_ID, "alignment"));
  ui.combatDock?.setControlsOrder();
}

function setDirection() {
  const direction = game.settings.get(MODULE_ID, "direction");
  document.documentElement.style.setProperty("--carousel-direction", direction === "columnFloat" ? "column" : "row");
  document.documentElement.style.setProperty("--combatant-portrait-margin", direction !== "columnFloat" ? "0 calc(var(--combatant-portrait-size) * 0.1)" : "0");
  ui.combatDock?.setControlsOrder();
}

function setFlex() {
  const alignment = game.settings.get(MODULE_ID, "alignment");
  const direction = game.settings.get(MODULE_ID, "direction");
  let alignItems = "flex-start";
  if (direction === "columnFloat" && alignment === "right") alignItems = "flex-end";
  if (direction === "columnFloat" && alignment === "center") alignItems = "center";
  document.documentElement.style.setProperty("--carousel-align-items", alignItems);
}

function setOverflowStyle() {
  let overflowStyle = game.settings.get(MODULE_ID, "overflowStyle");
  if (overflowStyle === "autofit") overflowStyle = "hidden";
  if (overflowStyle === "scroll") overflowStyle = game.settings.get(MODULE_ID, "direction") !== "columnFloat" ? "scroll hidden" : "hidden scroll";
  document.documentElement.style.setProperty("--carousel-overflow", overflowStyle);
}

function setRoundness() {
  document.documentElement.style.setProperty("--combatant-portrait-border-radius", game.settings.get(MODULE_ID, "roundness"));
}

function setAttributeColor() {
  const primary = game.settings.get(MODULE_ID, "attributeColor") || "#41AA7D";
  const secondary = game.settings.get(MODULE_ID, "attributeColor2") || "#ffcd00";
  const portrait = game.settings.get(MODULE_ID, "attributeColorPortrait") || "#e62121";
  document.documentElement.style.setProperty("--attribute-bar-primary-color", primary);
  document.documentElement.style.setProperty("--attribute-bar-secondary-color", Color.from(primary).mix(Color.from("#000"), 0.5).toString());
  document.documentElement.style.setProperty("--attribute-bar-primary-color2", secondary);
  document.documentElement.style.setProperty("--attribute-bar-secondary-color2", Color.from(secondary).mix(Color.from("#000"), 0.5).toString());
  document.documentElement.style.setProperty("--attribute-bar-portrait-color", portrait);
}

function setPortraitImageBorder() {
  document.documentElement.style.setProperty("--combatant-portrait-image-border", `url('${game.settings.get(MODULE_ID, "portraitImageBorder")}')`);
}

function setPortraitImageBackground() {
  document.documentElement.style.setProperty("--combatant-portrait-image-background", `url('${game.settings.get(MODULE_ID, "portraitImageBackground")}')`);
}

function setHideConflictingUIs() {
  document.querySelector("#ui-top")?.classList.toggle("ctd-hide-conflicting-uis", game.settings.get(MODULE_ID, "hideConflictingUIs"));
}
