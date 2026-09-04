import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const applicationPath = new URL("../src/advancement/application.mjs", import.meta.url);
const abilitiesTemplatePath = new URL("../templates/actor/advancement-abilities.hbs", import.meta.url);
const abilityDetailsTemplatePath = new URL("../templates/actor/parts/advancement-ability-details.hbs", import.meta.url);
const evolutionTemplatePath = new URL("../templates/actor/parts/advancement-ability-evolution-panel.hbs", import.meta.url);
const stylesheetPath = new URL("../styles/fallout-maw.css", import.meta.url);
const applicationSource = await readFile(applicationPath, "utf8");
const abilitiesTemplate = await readFile(abilitiesTemplatePath, "utf8");
const abilityDetailsTemplate = await readFile(abilityDetailsTemplatePath, "utf8");
const evolutionTemplate = await readFile(evolutionTemplatePath, "utf8");
const stylesheet = await readFile(stylesheetPath, "utf8");

function sourceBetween(start, end) {
  const startIndex = applicationSource.indexOf(start);
  const endIndex = applicationSource.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `Missing source marker: ${end}`);
  return applicationSource.slice(startIndex, endIndex);
}

test("advancement context exits into page-specific preparation before development work", () => {
  const prepareContext = sourceBetween("  async _prepareContext(options)", "  async #prepareProficienciesPageContext(options)");
  const abilityBranch = prepareContext.indexOf('this.#page === "abilities"');
  const proficiencyBranch = prepareContext.indexOf('this.#page === "proficiencies"');
  const developmentSettings = prepareContext.indexOf("const characteristicSettings = getCharacteristicSettings()");
  assert.ok(abilityBranch >= 0 && abilityBranch < developmentSettings);
  assert.ok(proficiencyBranch >= 0 && proficiencyBranch < developmentSettings);
});

test("ability catalog preparation is synchronous and uses precomputed indexes", () => {
  const prepareCategories = sourceBetween("  #prepareAbilityCategories(", "  #prepareSelectedAbility()");
  assert.doesNotMatch(prepareCategories, /Promise\.all|actorHasAbility\(/);
  assert.match(prepareCategories, /currentOwnedAbilityIds = new Set/);
  assert.match(prepareCategories, /researchBySourceId = new Map/);
  assert.match(prepareCategories, /this\.#abilityById = new Map/);
  assert.match(prepareCategories, /indexAbilityEvolutionFamily/);
  assert.doesNotMatch(prepareCategories, /#prepareAbilityEvolutionFamilyEntries/);
  assert.doesNotMatch(applicationSource, /getCreatureOptions/);
  assert.match(applicationSource, /getCreatureRaceSummaries/);
});

test("completed evolution families are green, sort after unavailable abilities, and mark only their branch complete", () => {
  const prepareCategories = sourceBetween("  #prepareAbilityCategories(", "  #prepareSelectedAbility()");
  const indexer = sourceBetween("function indexAbilityEvolutionFamily(", "function getLocalEvolutionAncestorSourceIds(");
  const sorter = sourceBetween("function compareAbilityAvailability(", "function evaluateProgressionFormula(");
  assert.match(prepareCategories, /evolutionExhausted/);
  assert.match(prepareCategories, /!currentOwnedEntry\.hasEvolutionContinuation/);
  assert.match(indexer, /hasAbilityEvolutionContinuation\(ability, ownerAbility\)/);
  assert.match(indexer, /ownerAbility\?\.system\?\.evolution, ability\?\.system\?\.evolution/);
  assert.match(sorter, /if \(entry\?\.owned\) return 2/);
  assert.match(sorter, /entry\?\.acquisitionAvailable \? 0 : 1/);
  assert.match(abilitiesTemplate, /evolutionExhausted/);
  assert.match(abilitiesTemplate, /title="\{\{#if evolutionExhausted\}\}Завершено/);
  assert.match(stylesheet, /\.fallout-maw-advancement-talent-item\.owned\s*\{[^}]*background:[^}]*border-color:/s);
  assert.match(stylesheet, /\.fallout-maw-advancement-evolution-mark\.complete\s*\{[^}]*color:\s*#ff6b66;/s);
});

test("ability entries do not enrich every description during page render", () => {
  const prepareEntry = sourceBetween("  #prepareAbilityEntry(", "  #getAbilityResearch(");
  assert.doesNotMatch(prepareEntry, /TextEditor\.enrichHTML|renderAbilityDescriptionTooltipHTML/);
  assert.match(prepareEntry, /hasDescriptionTooltip/);
  assert.match(abilitiesTemplate, /data-ability-description-source-id/);
  assert.doesNotMatch(abilitiesTemplate, /data-ability-description-tooltip/);
});

test("ability selection and category toggles do not render the full application", () => {
  const localActions = sourceBetween("  static #onToggleAbilityCategory(", "  static async #onSpendAbilityResearch(");
  assert.doesNotMatch(localActions, /forceRender\(/);
  assert.match(localActions, /classList\.toggle/);
  assert.match(localActions, /#renderAbilityDetails/);
});

test("all owned abilities stay visible and selectable, with or without evolution branches", () => {
  const prepareCategories = sourceBetween("  #prepareAbilityCategories(", "  #prepareSelectedAbility()");
  assert.match(prepareCategories, /familyOwned/);
  assert.match(prepareCategories, /currentOwnedSourceIdByFamily/);
  assert.match(prepareCategories, /currentOwnedEntry\.ability/);
  assert.doesNotMatch(prepareCategories, /if \(familyOwned && !abilityHasEvolutions\(ability\)\) return null/);
  assert.doesNotMatch(prepareCategories, /filter\(ability => !ownedAbilityIds\.has/);
  assert.match(abilitiesTemplate, /\{\{#if owned\}\} owned\{\{\/if\}\}/);
  assert.match(abilitiesTemplate, /data-ability-family-source-id="\{\{familySourceId\}\}"/);
  const selection = sourceBetween("  static async #onSelectAbility(", "  static async #onSelectAbilityEvolutionNode(");
  assert.match(selection, /target\.dataset\.abilityFamilySourceId \|\| sourceId/);
  assert.match(selection, /#selectedAbilityFamilySourceId = familySourceId/);
  assert.match(selection, /#selectedAbilitySourceId = sourceId/);
  const grant = sourceBetween("  static async #onGrantAbility(", "  #getSkillAdvancementMultiplierChanges(");
  assert.doesNotMatch(grant, /#selectedAbility(?:Family)?SourceId = ""/);
});

test("purchased ordinary abilities and features remain in the list without offering another purchase", () => {
  const plain = { id: "plain", name: "А изученная", system: {} };
  const available = { id: "available", name: "В доступная", system: {} };
  const locked = { id: "locked", name: "Б недоступная", system: { acquisitionRequirements: [{ met: false }] } };
  const evolved = { id: "evolved", name: "Г эволюция", system: {} };
  const root = { id: "root", name: "Исходная", system: { evolution: {
    nodes: [{ id: evolved.id, ability: evolved }],
    links: [{ fromId: "root", toId: evolved.id }]
  } } };
  const feature = { id: "feature", name: "Особенность", system: {} };
  const hidden = { id: "hidden", name: "Скрытая", visible: false, system: {} };
  const catalog = { categories: [
    { id: "general", abilities: [plain, locked, root, available, hidden] },
    { id: "features", abilities: [feature] }
  ] };
  const app = createAbilityListHarness(catalog);
  let categories = app.prepare([evolved.id]);
  assert.equal(categories[0].abilities.find(entry => entry.sourceId === plain.id).owned, false);
  assert.equal(categories[1].abilities[0].canPurchaseTrait, true);

  // Ownership wins over requirements which may no longer be met after buying.
  plain.system.acquisitionRequirements = [{ met: false }];
  categories = app.prepare([plain.id, feature.id, evolved.id, hidden.id]);
  assert.deepEqual(categories[0].abilities.map(entry => entry.sourceId), [available.id, locked.id, plain.id, evolved.id]);
  const ownedPlain = categories[0].abilities.find(entry => entry.sourceId === plain.id);
  const ownedFeature = categories[1].abilities[0];
  for (const entry of [ownedPlain, ownedFeature]) {
    assert.equal(entry.owned, true);
    assert.equal(entry.acquisitionAvailable, true, "owned tiles must not be marked unavailable/red");
    assert.equal(entry.hasEvolution, false);
    assert.equal(entry.statusLabel, "Изучено");
    for (const action of ["canGrant", "canPurchaseTrait", "canSpendFree", "canStartManual"]) {
      assert.equal(entry[action], false, action);
    }
  }
  const ownedEvolution = categories[0].abilities.at(-1);
  assert.equal(ownedEvolution.familySourceId, root.id);
  assert.equal(ownedEvolution.hasEvolution, true);
  assert.equal(ownedEvolution.statusLabel, "Текущая версия");
  assert.equal(ownedEvolution.evolutionExhausted, true);

  categories = app.prepare([]);
  assert.equal(categories[0].abilities.find(entry => entry.sourceId === plain.id).owned, false);
  assert.equal(categories[1].abilities[0].canPurchaseTrait, true);
});

function createAbilityListHarness(catalog) {
  // Run the production preparation and sorting methods without the Foundry UI.
  const Harness = new Function("getAbilityCatalog", `
    const LOCKED_FEATURES_CATEGORY_ID = "features";
    const getAbilitySourceId = item => item.sourceId;
    const abilityHasEvolutions = ability => Boolean(ability?.system?.evolution?.nodes?.length);
    const toInteger = value => Math.trunc(Number(value) || 0);
    const formatResearchValue = String;
    const getAbilityAcquisitionRequirementRows = (_actor, ability) => ability.system?.acquisitionRequirements ?? [];
    const getAbilityAcquisitionRequirementLabel = () => "";
    const hasUnsafeAbilityEvolutionAcquisitionChanges = () => false;
    ${sourceBetween("function indexAbilityEvolutionFamily(", "function collectAbilityEvolutionGraph(")}
    ${sourceBetween("function compareAbilityAvailability(", "function evaluateProgressionFormula(")}
    return class {
      #abilityById = new Map();
      #abilityEntriesById = new Map();
      #abilityRequirementRowsById = new Map();
      #abilityTooltipHTMLCache = new Map();
      #abilityRequirementContext = null;
      #abilityEvolutionPreparationContext = null;
      #expandedAbilityCategories = new Set();
      #gmMode = false;
      #selectedAbilitySourceId = "";
      #selectedAbilityFamilySourceId = "";
      #getTraitSessionTotal(value) { return value; }
      ${sourceBetween("  #prepareAbilityCategories(", "  #prepareSelectedAbility()")}
      ${sourceBetween("  #prepareAbilityEntry(", "  #getAbilityResearch(")}
      prepare(ownedIds) {
        this.actor = { items: ownedIds.map(sourceId => ({ type: "ability", sourceId })), system: {} };
        return this.#prepareAbilityCategories({ researches: 100, traits: 1 });
      }
    };
  `)(() => catalog);
  return new Harness();
}

test("a stale ability selection clears safely without consulting an undefined catalog entry", () => {
  const prepareSelected = sourceBetween("  #prepareSelectedAbility()", "  #prepareAbilityEvolutionPanel()");
  assert.doesNotMatch(prepareSelected, /\bentry\./);
  assert.match(prepareSelected, /this\.#selectedAbilitySourceId = ""/);
  assert.match(prepareSelected, /this\.#selectedAbilityFamilySourceId = ""/);
});

test("evolution panel is a non-modal pointer-transparent overlay with an interactive pane", () => {
  assert.match(abilitiesTemplate, /advancement-ability-evolution-panel\.hbs/);
  assert.match(evolutionTemplate, /data-ability-evolution-layer/);
  assert.doesNotMatch(evolutionTemplate, /role=["']dialog|dialog-form|backdrop/);
  assert.match(stylesheet, /\.fallout-maw-advancement-evolution-layer\s*\{[^}]*pointer-events:\s*none;/s);
  assert.match(stylesheet, /\.fallout-maw-advancement-evolution-panel\s*\{[^}]*pointer-events:\s*auto;/s);
  assert.match(stylesheet, /\.fallout-maw-advancement-evolution-layer\s*\{[^}]*width:\s*clamp\(37\.5rem, 51vw, 51rem\);/s);
});

test("nested evolution actions reuse the main source-id based acquisition controls", () => {
  assert.match(abilityDetailsTemplate, /data-ability-source-id="\{\{selectedAbility\.sourceId\}\}"/);
  assert.match(abilityDetailsTemplate, /data-action="startAbilityResearch"/);
  assert.match(abilityDetailsTemplate, /data-action="spendAbilityResearch"/);
  assert.match(abilityDetailsTemplate, /data-action="purchaseTraitAbility"/);
  assert.match(abilityDetailsTemplate, /data-action="grantAbility"/);
  assert.doesNotMatch(evolutionTemplate, /abilityEvolutionSelection|data-ability-evolution-selection/);
  const researchSnapshot = sourceBetween("  #createAbilityResearchData(", "  async #applyRepeatAction(");
  assert.match(researchSnapshot, /evolutionRootId/);
  assert.match(researchSnapshot, /evolutionParentIds/);
  assert.match(researchSnapshot, /evolutionAncestorIds:\s*entry\.ancestorSourceIds/);
});

test("irreversible evolution changes are rejected before research spends points", () => {
  const spend = sourceBetween("  static async #onSpendAbilityResearch(", "  static async #onStartAbilityResearch(");
  const preflight = spend.indexOf("hasUnsafeAbilityEvolutionAcquisitionChanges");
  assert.ok(preflight >= 0);
  assert.ok(preflight < spend.indexOf("this.#draft.development.points.researches ="));
  const entry = sourceBetween("  #prepareAbilityEntry(", "  #getAbilityResearch(");
  assert.match(entry, /evolutionAcquisitionBlocked/);
  assert.match(entry, /evolutionAcquisitionBlocked = !owned[\s\S]*?hasUnsafeAbilityEvolutionAcquisitionChanges/);
  assert.match(entry, /acquisitionAvailable = owned \|\| \([\s\S]*?evolutionAvailable[\s\S]*?!evolutionAcquisitionBlocked/);
  assert.match(entry, /canPurchaseTrait: isFeature && !owned && acquisitionAvailable/);
  assert.match(entry, /canSpendFree: !isFeature && !owned && acquisitionAvailable/);
  assert.match(entry, /canStartManual: !isFeature && !owned && acquisitionAvailable/);
});

test("recursive advancement index preserves every graph ancestor for research snapshots", () => {
  const indexer = sourceBetween("function indexAbilityEvolutionFamily(", "function collectOwnedAbilityLineageIds(");
  assert.match(indexer, /ancestorSourceIds/);
  assert.match(indexer, /getLocalEvolutionAncestorSourceIds/);
  assert.match(indexer, /new Set\(\[\.\.\.ancestorSourceIds, \.\.\.localAncestorSourceIds\]\)/);
});

test("flattened nested graphs qualify locally-scoped link ids", () => {
  const graph = sourceBetween("function collectAbilityEvolutionGraph(", "function collectCompletedEvolutionIds(");
  assert.match(graph, /const id = `\$\{sourceId\}::\$\{localId\}`/);
});

test("evolution graph camera updates synchronously with bounds and never force-render the application", () => {
  const camera = sourceBetween("  #activateAbilityEvolutionLayer(", "  #removeAbilityEvolutionLayer()");
  assert.match(camera, /wheel/);
  assert.match(camera, /pointermove/);
  assert.match(camera, /event\.button !== 2/);
  assert.match(camera, /contextmenu/);
  assert.match(camera, /getCoalescedEvents/);
  assert.match(camera, /#applyAbilityEvolutionViewport\(nextState\)/);
  assert.match(camera, /clampGraphViewportToVisibleNode/);
  assert.match(camera, /createGraphSegmentViewport/);
  assert.match(camera, /maxZoom: ABILITY_EVOLUTION_FOCUS_ZOOM_MAX/);
  assert.match(applicationSource, /const ABILITY_EVOLUTION_FOCUS_ZOOM_MAX = 2;/);
  assert.match(camera, /ResizeObserver/);
  assert.match(camera, /style\.transform = `translate\(/);
  assert.match(camera, /snapToDevicePixel/);
  assert.doesNotMatch(camera, /#queueAbilityEvolutionViewport|requestAnimationFrame/);
  assert.doesNotMatch(camera, /forceRender\(/);
});

test("selecting an evolution node updates the main details and node highlight without rebuilding the graph", () => {
  const selectNode = sourceBetween("  static async #onSelectAbilityEvolutionNode(", "  static async #onCloseAbilityEvolution(");
  const details = sourceBetween("  async #renderAbilityDetails(", "  #syncAbilityEvolutionNodeSelection(");
  const selection = sourceBetween("  #syncAbilityEvolutionNodeSelection(", "  #replaceAbilityEvolutionLayer(");
  assert.match(selectNode, /refreshEvolutionGraph:\s*false/);
  assert.match(details, /#syncAbilityEvolutionNodeSelection/);
  assert.doesNotMatch(details, /abilityEvolutionSelection\.hbs|refreshEvolutionGraph:\s*true/);
  assert.match(selection, /classList\.toggle\("selected"/);
  assert.doesNotMatch(selection, /#replaceAbilityEvolutionLayer/);
});

test("evolution panel remains a stable child of the advancement window across renders and detaching", () => {
  const overlay = sourceBetween("  #replaceAbilityEvolutionLayer(", "  #removeAbilityEvolutionLayer()");
  assert.match(overlay, /\.window-content \[data-ability-evolution-layer\]/);
  assert.match(overlay, /#canReconcileAbilityEvolutionLayers/);
  assert.match(overlay, /#reconcileAbilityEvolutionLayer/);
  assert.match(applicationSource, /this\.element\.append\(nextLayer\)/);
  assert.match(overlay, /this\.element\?\.ownerDocument/);
  assert.match(overlay, /layer\.ownerDocument\?\.defaultView/);
  assert.match(overlay, /instanceof view\.HTMLElement/);
  assert.match(overlay, /new view\.AbortController\(\)/);
  assert.match(overlay, /const animateOpening = !this\.#abilityEvolutionPanelOpen/);
  assert.match(overlay, /if \(animateOpening\) nextLayer\.classList\.add\("opening"\)/);
  assert.match(overlay, /this\.#abilityEvolutionPanelOpen = true/);
  assert.doesNotMatch(overlay, /nextFamilySourceId !==/);
  assert.doesNotMatch(overlay, /#abilityEvolutionFrame|requestAnimationFrame/);
  assert.doesNotMatch(overlay, /ownerDocument\.body|#moveAbilityEvolutionLayerToDocument|reserveOverlayZIndex/);
  assert.match(stylesheet, /\.application\.fallout-maw-advancement-app:not\([^)]*minimized[^)]*\)\s*\{[^}]*overflow:\s*visible;/s);
  assert.match(stylesheet, /\.fallout-maw-advancement-evolution-layer\s*\{[^}]*left:\s*calc\(100% \+ 1px\);[^}]*position:\s*absolute;/s);
  assert.match(stylesheet, /\.fallout-maw-advancement-evolution-layer\.opening\s*\{[^}]*overflow:\s*clip;/s);
  assert.match(stylesheet, /\.fallout-maw-advancement-evolution-layer\.opening \.fallout-maw-advancement-evolution-panel\s*\{[^}]*animation:/s);
  const openingAnimation = stylesheet.slice(
    stylesheet.indexOf("@keyframes fallout-maw-advancement-evolution-enter"),
    stylesheet.indexOf(".fallout-maw-advancement-evolution-header")
  );
  assert.match(openingAnimation, /from\s*\{\s*transform:\s*translateX\(-100%\)/s);
  assert.match(openingAnimation, /to\s*\{\s*transform:\s*translateX\(0\)/s);
  assert.doesNotMatch(openingAnimation, /translateX\(100%\)/);
});

test("evolution nodes lazily show changes together with the full ability description", () => {
  const panel = sourceBetween("  #prepareAbilityEvolutionPanel()", "  #prepareAbilityEvolutionFamilyEntries(");
  const tooltip = sourceBetween("  async #showAbilityDescriptionTooltip(", "  #clearAbilityDescriptionTooltip()");
  const renderer = sourceBetween("async function renderAbilityDescriptionTooltipHTML(", "function renderSkillCostTooltipHTML(");
  assert.match(panel, /hasDescriptionTooltip/);
  assert.match(panel, /tooltipMode/);
  assert.doesNotMatch(panel, /TextEditor\.enrichHTML/);
  assert.match(evolutionTemplate, /data-ability-description-source-id/);
  assert.match(evolutionTemplate, /data-ability-description-mode="\{\{tooltipMode\}\}"/);
  assert.doesNotMatch(evolutionTemplate, /fallout-maw-advancement-evolution-node-summary/);
  assert.match(tooltip, /includeEvolutionChanges: descriptionMode === "evolution"/);
  assert.match(tooltip, /fallout-maw-inventory-tooltip fallout-maw-ability-description-tooltip/);
  assert.match(renderer, /Promise\.all/);
  assert.match(renderer, /<h4>Изменения<\/h4>/);
  assert.match(renderer, /<h4>Описание<\/h4>/);
  assert.match(renderer, /\$\{changesSection\}\$\{descriptionSection\}/);
  assert.match(applicationSource, /#bindAbilityDescriptionTooltipEvents\(root\)/);
  assert.match(applicationSource, /this\.element\.append\(nextLayer\)/);
});

test("advancement evolution links follow the vertical graph direction", () => {
  const panel = sourceBetween("  #prepareAbilityEvolutionPanel()", "  #prepareAbilityEvolutionFamilyEntries(");
  assert.match(panel, /const startX = from\.x \+ \(ABILITY_EVOLUTION_NODE_WIDTH \/ 2\)/);
  assert.match(panel, /const startY = from\.y \+ ABILITY_EVOLUTION_NODE_HEIGHT/);
  assert.match(panel, /const endX = to\.x \+ \(ABILITY_EVOLUTION_NODE_WIDTH \/ 2\)/);
  assert.match(panel, /const endY = to\.y/);
});

test("incremental draft commits suppress unrelated document application renders", () => {
  const commit = sourceBetween("  async #applyDraftToActor(", "  #scheduleRepeatCommit()");
  assert.match(commit, /render:\s*false/);
});

test("unrelated actor resource updates do not rebuild the advancement window", () => {
  const update = sourceBetween("  async #onActorUpdated(", "  async #onActiveEffectChanged(");
  assert.match(update, /const affectsResearch = foundry\.utils\.hasProperty\(changes, "system\.researches"\)/);
  assert.match(update, /if \(!affectsDraft && !affectsResearch\) return;/);
  assert.ok(update.indexOf("if (!affectsDraft && !affectsResearch) return;") < update.indexOf("forceRender()"));
});
