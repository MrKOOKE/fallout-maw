export const SYSTEM_ID = "fallout-maw";
export const SYSTEM_TITLE = "Fallout-MaW";

export const ACTOR_TYPES = Object.freeze(["character", "npc", "vehicle", "hazard"]);
export const ITEM_TYPES = Object.freeze(["gear", "weapon", "armor", "ability"]);

export const TEMPLATES = Object.freeze({
  actorCreateDialog: `systems/${SYSTEM_ID}/templates/actor/actor-create-dialog.hbs`,
  skillCheckDialog: `systems/${SYSTEM_ID}/templates/actor/skill-check-dialog.hbs`,
  skillCheckChatCard: `systems/${SYSTEM_ID}/templates/chat/skill-check-card.hbs`,
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
    currencies: `systems/${SYSTEM_ID}/templates/settings/currency-settings-config.hbs`,
    damageTypes: `systems/${SYSTEM_ID}/templates/settings/damage-types-config.hbs`,
    needs: `systems/${SYSTEM_ID}/templates/settings/need-settings-config.hbs`,
    proficiencies: `systems/${SYSTEM_ID}/templates/settings/proficiency-settings-config.hbs`,
    resources: `systems/${SYSTEM_ID}/templates/settings/resource-settings-config.hbs`,
    skillFormulas: `systems/${SYSTEM_ID}/templates/settings/skill-formulas-config.hbs`
  })
});
