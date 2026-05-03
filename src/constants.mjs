export const SYSTEM_ID = "fallout-maw";
export const SYSTEM_TITLE = "Fallout-MaW";

export const ACTOR_TYPES = Object.freeze(["character", "npc", "vehicle", "hazard"]);
export const ITEM_TYPES = Object.freeze(["gear", "weapon", "armor", "ability", "effect"]);

export const TEMPLATES = Object.freeze({
  actorCreateDialog: `systems/${SYSTEM_ID}/templates/actor/actor-create-dialog.hbs`,
  actorSheet: Object.freeze({
    header: `systems/${SYSTEM_ID}/templates/actor/parts/header.hbs`,
    tabs: `systems/${SYSTEM_ID}/templates/actor/parts/tabs.hbs`,
    inventory: `systems/${SYSTEM_ID}/templates/actor/parts/inventory-tab.hbs`,
    indicators: `systems/${SYSTEM_ID}/templates/actor/parts/indicators-tab.hbs`,
    identity: `systems/${SYSTEM_ID}/templates/actor/parts/identity-tab.hbs`
  }),
  itemSheet: `systems/${SYSTEM_ID}/templates/item/item-sheet.hbs`,
  settings: Object.freeze({
    characteristics: `systems/${SYSTEM_ID}/templates/settings/characteristics-config.hbs`,
    creatureOptions: `systems/${SYSTEM_ID}/templates/settings/creature-options-config.hbs`,
    currencies: `systems/${SYSTEM_ID}/templates/settings/currency-settings-config.hbs`,
    damageTypes: `systems/${SYSTEM_ID}/templates/settings/damage-types-config.hbs`,
    needs: `systems/${SYSTEM_ID}/templates/settings/need-settings-config.hbs`,
    resources: `systems/${SYSTEM_ID}/templates/settings/resource-settings-config.hbs`,
    skillFormulas: `systems/${SYSTEM_ID}/templates/settings/skill-formulas-config.hbs`
  })
});
