import {
  DEFAULT_FACTION_NAME,
  getActorPrimaryFaction
} from "../../settings/factions.mjs";
import { localize } from "../../utils/i18n.mjs";
import { MODULE_ID } from "./main.mjs";
import { HandlebarsApplication, mergeClone } from "./utils.mjs";

export async function promptCombatInitiativeSurprise(combat) {
  const dialog = new CombatInitiativeSurpriseDialog(combat);
  dialog.render(true);
  return dialog.result;
}

export function getRollAllInitiativeCombatantIds(combat) {
  return getRollAllInitiativeCombatants(combat).map(combatant => combatant.id);
}

class CombatInitiativeSurpriseDialog extends HandlebarsApplication {
  #resolveResult = null;
  #settled = false;

  constructor(combat) {
    super();
    this.combat = combat;
    this.result = new Promise(resolve => {
      this.#resolveResult = resolve;
    });
  }

  static get DEFAULT_OPTIONS() {
    return mergeClone(super.DEFAULT_OPTIONS, {
      classes: ["fallout-maw", "fallout-maw-config-form", "fallout-maw-combat-initiative-surprise"],
      id: "fallout-maw-combat-initiative-surprise",
      window: {
        title: "FALLOUTMAW.CombatCarousel.RollInitiativeTitle",
        icon: "fa-solid fa-users",
        resizable: true
      },
      position: {
        width: 520,
        height: "auto"
      }
    });
  }

  static get PARTS() {
    return {
      content: {
        template: `systems/${MODULE_ID}/templates/apps/combat-carousel/combat-initiative-surprise-dialog.hbs`,
        classes: [],
        scrollable: [".fallout-maw-combat-initiative-surprise-list"]
      }
    };
  }

  get title() {
    return localize("FALLOUTMAW.CombatCarousel.RollInitiativeTitle");
  }

  async _prepareContext(options) {
    return {
      ...(await super._prepareContext(options)),
      groups: buildCombatInitiativeGroups(this.combat)
    };
  }

  activateListeners(html) {
    html.querySelector("[data-surprise-form]")?.addEventListener("submit", event => this.#onSubmit(event));
    html.querySelector("[data-surprise-cancel]")?.addEventListener("click", event => this.#onCancel(event));
    html.querySelectorAll("[data-surprise-toggle-container]").forEach(label => {
      label.addEventListener("click", event => event.stopPropagation());
    });
    html.querySelectorAll("[data-surprise-faction-toggle]").forEach(input => {
      input.addEventListener("click", event => event.stopPropagation());
    });
    html.addEventListener("change", event => this.#onChange(event));
  }

  #onChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return undefined;
    const factionEl = target.closest("[data-surprise-faction]");
    if (!factionEl) return undefined;

    if (target.matches("[data-surprise-faction-toggle]")) {
      for (const input of factionEl.querySelectorAll("[data-surprise-combatant]")) {
        input.checked = target.checked;
      }
    }

    this.#syncFactionToggle(factionEl);
    return undefined;
  }

  #syncFactionToggle(factionEl) {
    const factionToggle = factionEl.querySelector("[data-surprise-faction-toggle]");
    const memberToggles = Array.from(factionEl.querySelectorAll("[data-surprise-combatant]"));
    if (!(factionToggle instanceof HTMLInputElement) || !memberToggles.length) return;

    const checked = memberToggles.filter(input => input.checked).length;
    factionToggle.checked = checked === memberToggles.length;
    factionToggle.indeterminate = checked > 0 && checked < memberToggles.length;
  }

  #onSubmit(event) {
    event.preventDefault();
    const checked = this.element?.querySelectorAll("[data-surprise-combatant]:checked") ?? [];
    this.#resolve(new Set(Array.from(checked, input => String(input.value ?? "").trim()).filter(Boolean)));
    return this.close();
  }

  #onCancel(event) {
    event.preventDefault();
    this.#resolve(null);
    return this.close();
  }

  #resolve(value) {
    if (this.#settled) return;
    this.#settled = true;
    this.#resolveResult?.(value);
  }

  async close(...args) {
    this.#resolve(null);
    return super.close(...args);
  }
}

function buildCombatInitiativeGroups(combat) {
  const groups = new Map();

  for (const combatant of getRollAllInitiativeCombatants(combat)) {
    const factionName = getActorPrimaryFaction(combatant.actor) || DEFAULT_FACTION_NAME;
    if (!groups.has(factionName)) {
      groups.set(factionName, {
        name: factionName,
        combatants: []
      });
    }
    groups.get(factionName).combatants.push({
      id: combatant.id,
      name: combatant.name
    });
  }

  return Array.from(groups.values())
    .sort((left, right) => left.name.localeCompare(right.name, game.i18n.lang))
    .map((group, index) => ({
      ...group,
      index,
      count: group.combatants.length
    }));
}

function getRollAllInitiativeCombatants(combat) {
  return Array.from(combat?.combatants ?? []).filter(combatant => (
    combatant?.isOwner && combatant.initiative === null
  ));
}
