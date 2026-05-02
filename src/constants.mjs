export const SYSTEM_ID = "fallout-maw";
export const SYSTEM_TITLE = "Fallout-MaW";

export const ACTOR_TYPES = Object.freeze(["character", "npc", "vehicle", "hazard"]);
export const ITEM_TYPES = Object.freeze(["gear", "weapon", "armor", "ability", "effect"]);

export const TEMPLATES = Object.freeze({
  actorCreateDialog: `systems/${SYSTEM_ID}/templates/actor/actor-create-dialog.hbs`,
  actorSheet: Object.freeze({
    header: `systems/${SYSTEM_ID}/templates/actor/parts/header.hbs`,
    tabs: `systems/${SYSTEM_ID}/templates/actor/parts/tabs.hbs`,
    overview: `systems/${SYSTEM_ID}/templates/actor/parts/overview-tab.hbs`,
    skills: `systems/${SYSTEM_ID}/templates/actor/parts/skills-tab.hbs`,
    details: `systems/${SYSTEM_ID}/templates/actor/parts/details-tab.hbs`
  }),
  itemSheet: `systems/${SYSTEM_ID}/templates/item/item-sheet.hbs`,
  settings: Object.freeze({
    actionMovementFormulas: `systems/${SYSTEM_ID}/templates/settings/action-movement-formulas-config.hbs`,
    characteristics: `systems/${SYSTEM_ID}/templates/settings/characteristics-config.hbs`,
    creatureOptions: `systems/${SYSTEM_ID}/templates/settings/creature-options-config.hbs`,
    damageTypes: `systems/${SYSTEM_ID}/templates/settings/damage-types-config.hbs`,
    skillFormulas: `systems/${SYSTEM_ID}/templates/settings/skill-formulas-config.hbs`
  })
});
