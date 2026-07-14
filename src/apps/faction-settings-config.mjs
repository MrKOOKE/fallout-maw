import { TEMPLATES } from "../constants.mjs";
import {
  DEFAULT_FACTION_NAME,
  getActorFactionBelongs,
  getActorPrimaryFaction,
  getFactionMatrix,
  getFactionNamesWithDefault,
  getFactionScore,
  getFactionSettings,
  getRelationFromScore,
  getRelationTo,
  setActorFactionBelongs,
  setActorFactionRelations,
  setFactionMatrix,
  setFactionScoreMutable,
  setFactionSettings
} from "../settings/factions.mjs";
import { localize } from "../utils/i18n.mjs";
import { toInteger } from "../utils/numbers.mjs";
import { FalloutMaWFormApplicationV2 } from "./base-form-application-v2.mjs";
import { activateSettingsReorder } from "./settings-reorder.mjs";

export class FactionSettingsConfig extends FalloutMaWFormApplicationV2 {
  constructor(options = {}) {
    super(options);
    this.factions = getFactionSettings();
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-faction-settings",
    classes: ["fallout-maw", "fallout-maw-config-form", "fallout-maw-faction-settings-config"],
    position: {
      width: 620,
      height: "auto"
    },
    form: {
      closeOnSubmit: true
    },
    actions: {
      createFaction: this.#onCreateFaction,
      deleteFaction: this.#onDeleteFaction
    }
  };

  static PARTS = {
    form: {
      template: TEMPLATES.settings.factions
    }
  };

  get title() {
    return localize("FALLOUTMAW.Factions.SettingsTitle");
  }

  async _prepareContext(options) {
    return {
      ...(await super._prepareContext(options)),
      factions: this.factions
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    activateSettingsReorder(this.element, "[data-faction-row]");
  }

  async _processFormData() {
    this.factions = this.#readFactionsFromForm();
    await setFactionSettings(this.factions);
    this.factions = getFactionSettings();
    ui.notifications.info(localize("FALLOUTMAW.Factions.SettingsSaved"));
    return this.forceRender();
  }

  static #onCreateFaction(event) {
    event.preventDefault();
    this.factions = this.#readFactionsFromForm();
    this.factions.push(this.#getUniqueFactionName());
    return this.forceRender();
  }

  static #onDeleteFaction(event, target) {
    event.preventDefault();
    const rows = Array.from(this.form?.querySelectorAll("[data-faction-row]") ?? []);
    const index = rows.indexOf(target.closest("[data-faction-row]"));
    if (index < 0) return undefined;
    this.factions = this.#readFactionsFromForm();
    this.factions.splice(index, 1);
    return this.forceRender();
  }


  #readFactionsFromForm() {
    return Array.from(this.form?.querySelectorAll("[data-faction-row]") ?? [])
      .map(row => String(row.querySelector("[data-field='name']")?.value ?? "").trim())
      .filter(Boolean);
  }

  #getUniqueFactionName() {
    const base = localize("FALLOUTMAW.Factions.NewFaction");
    const names = new Set(this.factions);
    if (!names.has(base)) return base;
    let index = 2;
    while (names.has(`${base} ${index}`)) index += 1;
    return `${base} ${index}`;
  }
}

export class ActorFactionConfig extends FalloutMaWFormApplicationV2 {
  constructor(actor, options = {}) {
    super(options);
    this.actor = actor;
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-actor-factions",
    classes: ["fallout-maw", "fallout-maw-config-form", "fallout-maw-actor-faction-config"],
    position: {
      width: 780,
      height: "auto"
    },
    form: {
      closeOnSubmit: true
    }
  };

  static PARTS = {
    form: {
      template: TEMPLATES.settings.actorFactions
    }
  };

  get title() {
    return `${localize("FALLOUTMAW.Factions.ActorTitle")}: ${this.actor?.name ?? ""}`;
  }

  async _prepareContext(options) {
    const primary = getActorPrimaryFaction(this.actor);
    const factions = getFactionNamesWithDefault(getFactionSettings());
    if (!factions.includes(primary)) factions.push(primary);
    const belongs = new Set(getActorFactionBelongs(this.actor));
    return {
      ...(await super._prepareContext(options)),
      actor: this.actor,
      primary,
      rows: factions.map(name => {
        const score = name === primary ? 0 : getFactionScore(primary, name);
        const relation = name === primary ? "ally" : getRelationFromScore(score);
        return {
          name,
          belongs: belongs.has(name),
          isPrimary: name === primary,
          score,
          ally: relation === "ally",
          neutral: relation === "neutral",
          enemy: relation === "enemy"
        };
      })
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.element.addEventListener("input", event => this.#onInput(event));
    this.element.addEventListener("change", event => this.#onChange(event));
  }

  async _processFormData() {
    const rows = Array.from(this.form?.querySelectorAll("[data-faction-relation-row]") ?? []);
    const primary = rows.find(row => row.querySelector("[data-field='belongs']")?.checked)
      ?.dataset?.factionName
      ?.trim() || DEFAULT_FACTION_NAME;
    const relations = {};
    const matrix = getFactionMatrix();

    for (const row of rows) {
      const name = String(row.dataset.factionName ?? "").trim();
      if (!name) continue;
      const score = name === primary ? 0 : clampScore(row.querySelector("[data-field='score']")?.value);
      relations[name] = name === primary ? "ally" : getRelationFromScore(score);
      setFactionScoreMutable(matrix, primary, name, score);
    }

    await setActorFactionBelongs(this.actor, [primary]);
    await setActorFactionRelations(this.actor, relations);
    await setFactionMatrix(matrix);
    ui.notifications.info(localize("FALLOUTMAW.Factions.ActorSaved"));
    return this.forceRender();
  }

  #onInput(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.matches("[data-faction-search]")) return this.#filterRows(target.value);
    if (target.matches("[data-field='score']")) return this.#syncRowRelationFromScore(target.closest("[data-faction-relation-row]"));
    return undefined;
  }

  #onChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.matches("[data-field='belongs']")) return this.#onBelongsChange(target);
    if (target.matches("[data-field='relation']")) return this.#syncRowScoreFromRelation(target.closest("[data-faction-relation-row]"), target.value);
    return undefined;
  }

  #filterRows(query) {
    const normalized = String(query ?? "").trim().toLocaleLowerCase();
    for (const row of this.form?.querySelectorAll("[data-faction-relation-row]") ?? []) {
      const name = String(row.dataset.factionName ?? "").toLocaleLowerCase();
      row.hidden = Boolean(normalized) && !name.includes(normalized);
    }
    return undefined;
  }

  #onBelongsChange(target) {
    if (!(target instanceof HTMLInputElement)) return undefined;
    const row = target.closest("[data-faction-relation-row]");
    const primary = target.checked
      ? String(row?.dataset.factionName ?? "").trim()
      : DEFAULT_FACTION_NAME;

    if (target.checked) {
      for (const input of this.form?.querySelectorAll("[data-field='belongs']") ?? []) {
        if (input !== target) input.checked = false;
      }
    } else {
      const defaultRow = Array.from(this.form?.querySelectorAll("[data-faction-relation-row]") ?? [])
        .find(candidate => String(candidate.dataset.factionName ?? "") === DEFAULT_FACTION_NAME);
      const defaultInput = defaultRow?.querySelector("[data-field='belongs']");
      if (defaultInput) defaultInput.checked = true;
    }

    return this.#syncRowsForPrimary(primary);
  }

  #syncRowsForPrimary(primary) {
    const nextPrimary = String(primary ?? "").trim() || DEFAULT_FACTION_NAME;
    for (const row of this.form?.querySelectorAll("[data-faction-relation-row]") ?? []) {
      const name = String(row.dataset.factionName ?? "").trim();
      const isPrimary = name === nextPrimary;
      row.classList.toggle("is-primary", isPrimary);
      const belongsInput = row.querySelector("[data-field='belongs']");
      const scoreInput = row.querySelector("[data-field='score']");
      const relationInputs = row.querySelectorAll("[data-field='relation']");
      const score = isPrimary ? 0 : getFactionScore(nextPrimary, name);
      if (belongsInput) belongsInput.checked = isPrimary;
      if (scoreInput) {
        scoreInput.value = String(score);
        scoreInput.disabled = isPrimary;
      }
      for (const input of relationInputs) input.disabled = isPrimary;
      this.#syncRowRelationFromScore(row, isPrimary ? "ally" : null);
    }
    return undefined;
  }

  #syncRowScoreFromRelation(row, relation) {
    const input = row?.querySelector("[data-field='score']");
    if (!input || input.disabled) return undefined;
    input.value = relation === "ally" ? "61" : relation === "enemy" ? "-40" : "-39";
    return undefined;
  }

  #syncRowRelationFromScore(row, forcedRelation = null) {
    if (!row) return undefined;
    const scoreInput = row.querySelector("[data-field='score']");
    const relation = forcedRelation ?? getRelationFromScore(clampScore(scoreInput?.value));
    const relationInput = row.querySelector(`[data-field='relation'][value='${relation}']`);
    if (relationInput) relationInput.checked = true;
    return undefined;
  }
}

export function openActorFactionConfig(actor) {
  if (!actor?.isOwner) return undefined;
  return new ActorFactionConfig(actor).render(true);
}

function clampScore(value) {
  return Math.max(-100, Math.min(100, toInteger(value)));
}
