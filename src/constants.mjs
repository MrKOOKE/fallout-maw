export const SYSTEM_ID = "fallout-maw";
export const SYSTEM_TITLE = "Fallout-MaW";

export const ACTOR_TYPES = Object.freeze(["character", "construct"]);
export const ITEM_TYPES = Object.freeze(["gear", "ability", "trauma", "disease"]);
export const TRAUMA_CREATE_OPTION = "falloutMawAllowTraumaCreate";
export const DISEASE_CREATE_OPTION = "falloutMawAllowDiseaseCreate";
export const BLEEDING_DAMAGE_TYPE_KEY = "bleeding";
export const GRAPPLE_FOLLOW_MOVEMENT_OPTION = "falloutMawGrappleFollowMovement";

export const TEMPLATES = Object.freeze({
  actorCreateDialog: `systems/${SYSTEM_ID}/templates/actor/actor-create-dialog.hbs`,
  advancement: Object.freeze({
    dialog: `systems/${SYSTEM_ID}/templates/actor/advancement-dialog.hbs`
  }),
  skillCheckDialog: `systems/${SYSTEM_ID}/templates/actor/skill-check-dialog.hbs`,
  limbDamageDialog: `systems/${SYSTEM_ID}/templates/actor/limb-damage-dialog.hbs`,
  medicineDialog: `systems/${SYSTEM_ID}/templates/actor/medicine-dialog.hbs`,
  repairDialog: `systems/${SYSTEM_ID}/templates/actor/repair-dialog.hbs`,
  trapDisarmDialog: `systems/${SYSTEM_ID}/templates/actor/trap-disarm-dialog.hbs`,
  trapLinkedActionDialog: `systems/${SYSTEM_ID}/templates/actor/trap-linked-action-dialog.hbs`,
  constructStructure: `systems/${SYSTEM_ID}/templates/actor/construct-structure.hbs`,
  animationLibraryBrowser: `systems/${SYSTEM_ID}/templates/actor/animation-library-browser.hbs`,
  skillCheckControl: `systems/${SYSTEM_ID}/templates/actor/skill-check-control.hbs`,
  worldTimeControl: `systems/${SYSTEM_ID}/templates/actor/world-time-control.hbs`,
  skillCheckAnimation: `systems/${SYSTEM_ID}/templates/actor/skill-check-animation.hbs`,
  tokenActionHud: `systems/${SYSTEM_ID}/templates/actor/token-action-hud.hbs`,
  tokenActionHudScaleSettings: `systems/${SYSTEM_ID}/templates/actor/token-action-hud-scale-settings.hbs`,
  stealthWindow: `systems/${SYSTEM_ID}/templates/actor/stealth-window.hbs`,
  searchInventory: `systems/${SYSTEM_ID}/templates/actor/search-inventory.hbs`,
  craftWindow: `systems/${SYSTEM_ID}/templates/actor/craft-window.hbs`,
  personalGenerator: `systems/${SYSTEM_ID}/templates/actor/personal-generator.hbs`,
  actorTradeSettings: `systems/${SYSTEM_ID}/templates/actor/trade-settings.hbs`,
  skillCheckChatCard: `systems/${SYSTEM_ID}/templates/chat/skill-check-card.hbs`,
  skillCheckBatchChatCard: `systems/${SYSTEM_ID}/templates/chat/skill-check-batch-card.hbs`,
  damageSummaryChatCard: `systems/${SYSTEM_ID}/templates/chat/damage-summary-card.hbs`,
  finishingBlowChatCard: `systems/${SYSTEM_ID}/templates/chat/finishing-blow-card.hbs`,
  researchCompleteChatCard: `systems/${SYSTEM_ID}/templates/chat/research-complete-card.hbs`,
  actorSheet: Object.freeze({
    header: `systems/${SYSTEM_ID}/templates/actor/parts/header.hbs`,
    tabs: `systems/${SYSTEM_ID}/templates/actor/parts/tabs.hbs`,
    inventory: `systems/${SYSTEM_ID}/templates/actor/parts/inventory-tab.hbs`,
    indicators: `systems/${SYSTEM_ID}/templates/actor/parts/indicators-tab.hbs`,
    identity: `systems/${SYSTEM_ID}/templates/actor/parts/identity-tab.hbs`,
    research: `systems/${SYSTEM_ID}/templates/actor/parts/research-tab.hbs`,
    effects: `systems/${SYSTEM_ID}/templates/actor/parts/effects-tab.hbs`
  }),
  research: Object.freeze({
    createDialog: `systems/${SYSTEM_ID}/templates/actor/research-create-dialog.hbs`,
    manageDialog: `systems/${SYSTEM_ID}/templates/actor/research-manage-dialog.hbs`,
    timeDialog: `systems/${SYSTEM_ID}/templates/actor/research-time-dialog.hbs`
  }),
  itemSheet: `systems/${SYSTEM_ID}/templates/item/item-sheet.hbs`,
  activeEffectSheet: `systems/${SYSTEM_ID}/templates/effects/active-effect-sheet.hbs`,
  containerSheet: `systems/${SYSTEM_ID}/templates/item/container-sheet.hbs`,
  settings: Object.freeze({
    characteristics: `systems/${SYSTEM_ID}/templates/settings/characteristics-config.hbs`,
    creatureOptions: `systems/${SYSTEM_ID}/templates/settings/creature-options-config.hbs`,
    limbSettings: `systems/${SYSTEM_ID}/templates/settings/limb-settings-config.hbs`,
    currencies: `systems/${SYSTEM_ID}/templates/settings/currency-settings-config.hbs`,
    itemCategories: `systems/${SYSTEM_ID}/templates/settings/item-category-settings-config.hbs`,
    damageTypes: `systems/${SYSTEM_ID}/templates/settings/damage-types-config.hbs`,
    damageTypeSettings: `systems/${SYSTEM_ID}/templates/settings/damage-type-settings-config.hbs`,
    abilities: `systems/${SYSTEM_ID}/templates/settings/ability-settings-config.hbs`,
    abilityEditor: `systems/${SYSTEM_ID}/templates/settings/ability-catalog-item-editor.hbs`,
    diseases: `systems/${SYSTEM_ID}/templates/settings/disease-settings-config.hbs`,
    levels: `systems/${SYSTEM_ID}/templates/settings/level-settings-config.hbs`,
    needs: `systems/${SYSTEM_ID}/templates/settings/need-settings-config.hbs`,
    needSettings: `systems/${SYSTEM_ID}/templates/settings/need-advanced-settings-config.hbs`,
    proficiencies: `systems/${SYSTEM_ID}/templates/settings/proficiency-settings-config.hbs`,
    resources: `systems/${SYSTEM_ID}/templates/settings/resource-settings-config.hbs`,
    skillFormulas: `systems/${SYSTEM_ID}/templates/settings/skill-formulas-config.hbs`,
    limbSilhouette: `systems/${SYSTEM_ID}/templates/settings/limb-silhouette-config.hbs`,
    tokenActionHud: `systems/${SYSTEM_ID}/templates/settings/token-action-hud-config.hbs`,
    tools: `systems/${SYSTEM_ID}/templates/settings/tool-settings-config.hbs`,
    systemActions: `systems/${SYSTEM_ID}/templates/settings/system-action-settings-config.hbs`,
    stealth: `systems/${SYSTEM_ID}/templates/settings/stealth-settings-config.hbs`,
    combat: `systems/${SYSTEM_ID}/templates/settings/combat-settings-config.hbs`,
    cover: `systems/${SYSTEM_ID}/templates/settings/cover-settings-config.hbs`,
    factions: `systems/${SYSTEM_ID}/templates/settings/faction-settings-config.hbs`,
    actorFactions: `systems/${SYSTEM_ID}/templates/settings/actor-faction-config.hbs`,
    personalNameRandomizer: `systems/${SYSTEM_ID}/templates/settings/personal-name-randomizer-config.hbs`,
    traumaSettings: `systems/${SYSTEM_ID}/templates/settings/trauma-settings-config.hbs`,
    traumaGroupSettings: `systems/${SYSTEM_ID}/templates/settings/trauma-group-settings-config.hbs`,
    baseline: `systems/${SYSTEM_ID}/templates/settings/settings-baseline-config.hbs`
  })
});
