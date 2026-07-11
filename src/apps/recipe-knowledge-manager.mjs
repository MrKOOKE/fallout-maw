import { SYSTEM_ID, TEMPLATES } from "../constants.mjs";
import {
  getKnownCraftItemUuids,
  getWorldCraftKnowledgeItems,
  resolveCraftKnowledgeItem,
  setKnownCraftItemUuids
} from "../items/recipe-knowledge.mjs";
import {
  activateCraftKnowledgeTooltip,
  cancelCraftKnowledgeTooltipClose,
  isCraftKnowledgeTooltipOpen,
  removeCraftKnowledgeTooltip,
  reanchorCraftKnowledgeTooltip,
  renderCraftKnowledgeTooltipHTML,
  scheduleCraftKnowledgeTooltipClose,
  toggleCraftKnowledgeTooltipPin
} from "../sheets/actor-sheet.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
let recipeKnowledgeManager = null;

export function openRecipeKnowledgeManager(actors = []) {
  if (!game.user?.isGM) return null;
  const selectedActors = Array.from(new Map((actors ?? [])
    .filter(actor => actor?.documentName === "Actor")
    .map(actor => [actor.uuid, actor])).values());
  if (!selectedActors.length) {
    ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Craft.KnowledgeNoActors"));
    return null;
  }

  const items = getWorldCraftKnowledgeItems();
  if (!items.length) {
    ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Craft.KnowledgeNoRecipes"));
    return null;
  }

  void recipeKnowledgeManager?.close();
  recipeKnowledgeManager = new RecipeKnowledgeManagerApplication(selectedActors, items);
  return recipeKnowledgeManager.render({ force: true });
}

class RecipeKnowledgeManagerApplication extends HandlebarsApplicationMixin(ApplicationV2) {
  #actors;
  #items;
  #deactivateManager = null;

  constructor(actors, items, options = {}) {
    const viewportWidth = Math.max(800, globalThis.window?.innerWidth ?? 1280);
    const viewportHeight = Math.max(600, globalThis.window?.innerHeight ?? 900);
    const width = Math.min(1100, viewportWidth - 80);
    const height = Math.min(720, viewportHeight - 100);
    super(foundry.utils.mergeObject({
      position: {
        width,
        height,
        left: Math.round((viewportWidth - width) / 2),
        top: Math.round((viewportHeight - height) / 2)
      }
    }, options, { inplace: false }));
    this.#actors = actors;
    this.#items = items;
  }

  static DEFAULT_OPTIONS = {
    id: "fallout-maw-recipe-knowledge-manager",
    classes: [
      "fallout-maw",
      "fallout-maw-sheet",
      "fallout-maw-actor-sheet",
      "fallout-maw-recipe-knowledge-window",
      "sheet",
      "actor"
    ],
    position: { width: 1100, height: 720 },
    window: { resizable: true },
    actions: {
      apply: RecipeKnowledgeManagerApplication.#onApply,
      cancel: RecipeKnowledgeManagerApplication.#onCancel
    }
  };

  static PARTS = {
    body: { template: TEMPLATES.recipeKnowledgeManager }
  };

  get title() {
    return game.i18n.localize("FALLOUTMAW.Craft.KnowledgeManagerTitle");
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const knownByActor = new Map(this.#actors.map(actor => [actor.uuid, getKnownCraftItemUuids(actor)]));
    const actors = this.#actors.map(actor => ({
      uuid: actor.uuid,
      name: actor.name
    }));
    const groups = new Map();
    for (const item of this.#items) {
      const category = String(item.system?.itemCategory ?? "").trim()
        || game.i18n.localize("FALLOUTMAW.Common.Uncategorized");
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category).push(item);
    }
    const categories = Array.from(groups.entries())
      .sort(([left], [right]) => left.localeCompare(right, game.i18n.lang))
      .map(([name, items]) => ({
        name,
        open: false,
        itemCount: items.length,
        actors,
        items: items.map(item => ({
          uuid: item.uuid,
          name: item.name,
          img: item.img || "icons/svg/item-bag.svg",
          searchText: `${item.name} ${name}`.toLocaleLowerCase(game.i18n.lang),
          actorStates: actors.map(actor => ({
            uuid: actor.uuid,
            checked: knownByActor.get(actor.uuid)?.has(item.uuid)
          }))
        }))
      }));
    return {
      ...context,
      actors,
      actorCount: actors.length,
      itemCount: this.#items.length,
      categories
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.#deactivateManager?.();
    this.#deactivateManager = activateManager(this.element, this.#actors[0] ?? null);
  }

  async _onClose(options) {
    this.#deactivateManager?.();
    this.#deactivateManager = null;
    if (recipeKnowledgeManager === this) recipeKnowledgeManager = null;
    await super._onClose(options);
  }

  async #applyChanges() {
    const result = collectManagerState(this.element, this.#actors);
    const managedUuids = new Set(this.#items.map(item => item.uuid));
    for (const actor of this.#actors) {
      const previous = getKnownCraftItemUuids(actor);
      const next = new Set(Array.from(previous).filter(uuid => !managedUuids.has(uuid)));
      for (const uuid of result.get(actor.uuid) ?? []) next.add(uuid);
      await setKnownCraftItemUuids(actor, next);
    }
    ui.notifications.info(game.i18n.localize("FALLOUTMAW.Craft.KnowledgeUpdated"));
    Hooks.callAll(`${SYSTEM_ID}.recipeKnowledgeUpdated`, { actors: this.#actors });
  }

  static async #onApply(event) {
    event.preventDefault();
    await this.#applyChanges();
    return this.close();
  }

  static #onCancel(event) {
    event.preventDefault();
    return this.close();
  }
}

function activateManager(root, tooltipActor = null) {
  const tooltipCache = new Map();
  const middleActiveAnchors = new WeakSet();
  let tooltipTimer = null;
  let tooltipAnchor = null;
  const clearTooltipTimer = () => {
    if (!tooltipTimer) return;
    window.clearTimeout(tooltipTimer);
    tooltipTimer = null;
  };
  const showItemTooltip = async (anchor, { locked = false } = {}) => {
    const uuid = String(anchor?.dataset?.recipeKnowledgeItemUuid ?? "");
    const item = resolveCraftKnowledgeItem(uuid);
    if (!item || !anchor?.isConnected) return;
    let html = tooltipCache.get(uuid);
    if (!html) {
      html = await renderCraftKnowledgeTooltipHTML(item, tooltipActor);
      tooltipCache.set(uuid, html);
    }
    if (!anchor.isConnected || (!locked && tooltipAnchor !== anchor)) return;
    activateCraftKnowledgeTooltip(anchor, html, { locked, replace: true });
  };
  const syncRow = row => {
    const master = row.querySelector("[data-recipe-knowledge-row-toggle]");
    const checks = Array.from(row.querySelectorAll("[data-recipe-knowledge-actor]"));
    const checked = checks.filter(input => input.checked).length;
    master.checked = Boolean(checks.length && checked === checks.length);
    master.indeterminate = checked > 0 && checked < checks.length;
  };
  const syncColumn = (category, actorUuid) => {
    const escaped = CSS.escape(actorUuid);
    const master = category.querySelector(`[data-recipe-knowledge-column="${escaped}"]`);
    const checks = Array.from(category.querySelectorAll(`[data-recipe-knowledge-row]:not([hidden]) [data-recipe-knowledge-actor="${escaped}"]`));
    const checked = checks.filter(input => input.checked).length;
    if (!master) return;
    master.checked = Boolean(checks.length && checked === checks.length);
    master.indeterminate = checked > 0 && checked < checks.length;
  };
  const syncColumns = category => category.querySelectorAll("[data-recipe-knowledge-column]")
    .forEach(master => syncColumn(category, String(master.dataset.recipeKnowledgeColumn ?? "")));
  const syncCategory = category => {
    const master = category.querySelector("[data-recipe-knowledge-category-toggle]");
    if (!master) return;
    const checks = Array.from(category.querySelectorAll("[data-recipe-knowledge-row]:not([hidden]) [data-recipe-knowledge-actor]"));
    const checked = checks.filter(input => input.checked).length;
    const allChecked = Boolean(checks.length && checked === checks.length);
    const partial = checked > 0 && checked < checks.length;
    if (master instanceof HTMLInputElement) {
      master.checked = allChecked;
      master.indeterminate = partial;
    }
    master.classList.toggle("checked", allChecked);
    master.classList.toggle("indeterminate", partial);
    master.setAttribute("aria-pressed", partial ? "mixed" : String(allChecked));
  };
  const syncCategoryControls = category => {
    syncColumns(category);
    syncCategory(category);
  };

  const toggleCategory = categoryMaster => {
    const category = categoryMaster.closest("[data-recipe-knowledge-category]");
    const checks = Array.from(category.querySelectorAll("[data-recipe-knowledge-row]:not([hidden]) [data-recipe-knowledge-actor]"));
    const allChecked = checks.length > 0 && checks.every(input => input.checked);
    checks.forEach(input => { input.checked = !allChecked; });
    category.querySelectorAll("[data-recipe-knowledge-row]:not([hidden])").forEach(syncRow);
    syncCategoryControls(category);
  };

  root.querySelectorAll("[data-recipe-knowledge-row]").forEach(syncRow);
  root.querySelectorAll("[data-recipe-knowledge-category]").forEach(syncCategoryControls);
  root.addEventListener("click", event => {
    const categoryMaster = event.target.closest?.("[data-recipe-knowledge-category-toggle]");
    if (!categoryMaster) return;
    event.preventDefault();
    toggleCategory(categoryMaster);
  });
  root.addEventListener("keydown", event => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const categoryMaster = event.target.closest?.("[data-recipe-knowledge-category-toggle]");
    if (!categoryMaster) return;
    event.preventDefault();
    toggleCategory(categoryMaster);
  });
  root.addEventListener("change", event => {
    const rowMaster = event.target.closest?.("[data-recipe-knowledge-row-toggle]");
    if (rowMaster) {
      const row = rowMaster.closest("[data-recipe-knowledge-row]");
      row.querySelectorAll("[data-recipe-knowledge-actor]").forEach(input => { input.checked = rowMaster.checked; });
      syncRow(row);
      syncCategoryControls(row.closest("[data-recipe-knowledge-category]"));
      return;
    }
    const columnMaster = event.target.closest?.("[data-recipe-knowledge-column]");
    if (columnMaster) {
      const category = columnMaster.closest("[data-recipe-knowledge-category]");
      const actorUuid = String(columnMaster.dataset.recipeKnowledgeColumn ?? "");
      const escaped = CSS.escape(actorUuid);
      category.querySelectorAll(`[data-recipe-knowledge-row]:not([hidden]) [data-recipe-knowledge-actor="${escaped}"]`)
        .forEach(input => { input.checked = columnMaster.checked; syncRow(input.closest("[data-recipe-knowledge-row]")); });
      syncColumn(category, actorUuid);
      syncCategory(category);
      return;
    }
    const actorCheck = event.target.closest?.("[data-recipe-knowledge-actor]");
    if (actorCheck) {
      const row = actorCheck.closest("[data-recipe-knowledge-row]");
      syncRow(row);
      const category = row.closest("[data-recipe-knowledge-category]");
      syncColumn(category, String(actorCheck.dataset.recipeKnowledgeActor ?? ""));
      syncCategory(category);
    }
  });
  root.querySelector("[data-recipe-knowledge-search]")?.addEventListener("input", event => {
    const query = String(event.currentTarget.value ?? "").trim().toLocaleLowerCase(game.i18n.lang);
    root.querySelectorAll("[data-recipe-knowledge-category]").forEach(category => {
      let visible = 0;
      category.querySelectorAll("[data-recipe-knowledge-row]").forEach(row => {
        row.hidden = Boolean(query && !String(row.dataset.searchText ?? "").includes(query));
        if (!row.hidden) visible += 1;
      });
      category.hidden = visible < 1;
      if (query && visible) category.open = true;
      if (visible) syncCategoryControls(category);
    });
  });
  root.addEventListener("pointerover", event => {
    const anchor = event.target.closest?.("[data-recipe-knowledge-item-uuid]");
    if (!anchor || anchor.contains(event.relatedTarget)) return;
    cancelCraftKnowledgeTooltipClose();
    clearTooltipTimer();
    tooltipAnchor = anchor;
    if (isCraftKnowledgeTooltipOpen()) {
      reanchorCraftKnowledgeTooltip(anchor);
      void showItemTooltip(anchor);
      return;
    }
    tooltipTimer = window.setTimeout(() => {
      tooltipTimer = null;
      void showItemTooltip(anchor);
    }, 500);
  });
  root.addEventListener("pointerout", event => {
    const anchor = event.target.closest?.("[data-recipe-knowledge-item-uuid]");
    if (!anchor || anchor.contains(event.relatedTarget)) return;
    clearTooltipTimer();
    scheduleCraftKnowledgeTooltipClose(anchor, event.relatedTarget);
    if (tooltipAnchor === anchor) tooltipAnchor = null;
  });
  root.addEventListener("pointerdown", event => {
    if (event.button !== 1) return;
    const anchor = event.target.closest?.("[data-recipe-knowledge-item-uuid]");
    if (!anchor) return;
    if (toggleCraftKnowledgeTooltipPin(anchor)) middleActiveAnchors.add(anchor);
    event.preventDefault();
  });
  root.addEventListener("auxclick", event => {
    const anchor = event.target.closest?.("[data-recipe-knowledge-item-uuid]");
    if (event.button !== 1 || !anchor) return;
    event.preventDefault();
    clearTooltipTimer();
    tooltipAnchor = anchor;
    if (middleActiveAnchors.has(anchor)) {
      middleActiveAnchors.delete(anchor);
      return;
    }
    void showItemTooltip(anchor, { locked: true });
  });

  return () => {
    clearTooltipTimer();
    removeCraftKnowledgeTooltip();
  };
}

function collectManagerState(root, actors) {
  const result = new Map(actors.map(actor => [actor.uuid, new Set()]));
  root.querySelectorAll("[data-recipe-knowledge-row]").forEach(row => {
    const itemUuid = String(row.dataset.itemUuid ?? "");
    row.querySelectorAll("[data-recipe-knowledge-actor]:checked").forEach(input => {
      result.get(String(input.dataset.recipeKnowledgeActor ?? ""))?.add(itemUuid);
    });
  });
  return result;
}
