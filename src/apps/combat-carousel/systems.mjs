export function defaultAttributesConfig() {
  return {
    "fallout-maw": [
      {
        attr: "resources.health.value",
        icon: "fas fa-heart",
        units: ""
      }
    ]
  };
}

export function generateDescription(actor) {
  if (!actor) return null;
  return game.i18n.localize(`TYPES.Actor.${actor.type}`) || actor.type || null;
}

export function getInitiativeDisplay(combatant) {
  return {
    value: combatant?.initiative,
    icon: "far fa-dice-d20",
    rollIcon: "far fa-dice-d20"
  };
}

export function getSystemIcons() {
  return [];
}
