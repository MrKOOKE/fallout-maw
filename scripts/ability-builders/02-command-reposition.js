// Одноразовый GM-макрос для Fallout MaW.
// Собирает способность «Приказ: Сменить позицию!» через конструктор действий.
// Старые фиксированные функции и уже выданные предметы не изменяет.

await (async () => {

const SYSTEM_ID = "fallout-maw";
const CATALOG_SETTING = "abilitiesCatalog";
const SKILLS_SETTING = "skillSettings";
const SPEECH_CATEGORY_ID = "skill-speech";
const ABILITY_ID = "u6NqPLJYeinNzWNF";

if (game.system.id !== SYSTEM_ID) {
  ui.notifications.error("Этот макрос предназначен для системы fallout-maw.");
  return;
}
if (!game.user?.isGM) {
  ui.notifications.error("Собирать способности в каталоге может только GM.");
  return;
}

const clone = value => foundry.utils.deepClone(value);
const rawSkills = game.settings.get(SYSTEM_ID, SKILLS_SETTING);
const skills = Array.isArray(rawSkills)
  ? rawSkills
  : Array.isArray(rawSkills?.skills)
    ? rawSkills.skills
    : Array.isArray(rawSkills?.entries)
      ? rawSkills.entries
      : [];
const speechSkill = skills.find(skill => String(skill?.key ?? "") === "speech");
const speechVariable = String(speechSkill?.abbr ?? speechSkill?.key ?? "spe").trim() || "spe";

const functionId = `${ABILITY_ID}-movement-route`;
const definition = {
  id: ABILITY_ID,
  name: "Приказ: Сменить позицию!",
  img: "systems/fallout-maw/assets/icons/1-7/lider.webp",
  visible: true,
  description: `<p>Стоимость активации: 30 энергии; каждая выбранная цель тратит 5 ОД (только в бою).<br>Перегрузка: 60 энергии на 12 секунд.</p><p>Активация позволяет выбрать до [[2+${speechVariable}/50]]-х союзников. Они последовательно переместятся по построенным вами маршрутам.<br>Бюджет каждого маршрута: [[2+${speechVariable}/25]] ОП.</p>`,
  system: {
    category: "Красноречие",
    cost: 3000,
    formula: "",
    acquisition: {
      difficulty: 150,
      onlyFree: false,
      onlyManual: false,
      skillKey: "speech"
    },
    acquisitionRequirements: [{
      id: `${ABILITY_ID}-speech-requirement`,
      type: "skill",
      skillKey: "speech",
      value: 100
    }],
    functions: [{
      id: functionId,
      type: "activeApplication",
      sort: 0,
      fixedKey: "",
      fixedSettings: {},
      reactionSettings: { durationSeconds: 0, costs: [] },
      activeSettings: {
        name: "",
        costs: [{
          id: `${functionId}-cost-power`,
          resourceKey: "power",
          formula: "30",
          overloadAmount: 60,
          overloadDurationSeconds: 12,
          payer: "source"
        }, {
          id: `${functionId}-cost-action-points`,
          resourceKey: "actionPoints",
          formula: "5",
          overloadAmount: 0,
          overloadDurationSeconds: 0,
          payer: "targets"
        }],
        targetMode: "others",
        targetSelectionMode: "manual",
        targetLimit: `2+${speechVariable}/50`,
        targetGroups: ["ally"],
        includeSelf: false,
        excludeSelf: true,
        radiusFormula: "",
        wallsBlock: false,
        changeEvaluation: "target"
      },
      changes: [],
      actions: [{
        id: `${functionId}-route-action`,
        type: "movementRoute",
        attackActionKeys: ["all"],
        executorMode: "targets",
        targetMode: "triggerActor",
        actionPointCostMode: "none",
        actionPointPayer: "executor",
        fixedActionPointCost: 0,
        actualActionPointCostPercent: 100,
        routeBudgetMode: "movementCost",
        routeBudgetFormula: `2+${speechVariable}/25`,
        routeBudgetEvaluation: "source",
        routeExecutionMode: "sequential",
        routeMovementAction: "",
        routeAutoRotate: false,
        routeShowRuler: true
      }],
      conditions: [],
      penalties: []
    }]
  }
};

const catalog = clone(game.settings.get(SYSTEM_ID, CATALOG_SETTING));
const categories = Array.isArray(catalog?.categories) ? catalog.categories : [];
const speechCategory = categories.find(category => String(category?.id ?? "") === SPEECH_CATEGORY_ID);
if (!speechCategory) {
  ui.notifications.error("В каталоге не найдена категория Красноречие (skill-speech).");
  return;
}
speechCategory.abilities = Array.isArray(speechCategory.abilities) ? speechCategory.abilities : [];

const matches = [];
for (const category of categories) {
  for (const ability of category?.abilities ?? []) {
    if (String(ability?.id ?? "") === ABILITY_ID) matches.push({ category, ability });
  }
}
if (matches.length > 1) {
  ui.notifications.error(`В каталоге найдено несколько записей с ID ${ABILITY_ID}.`);
  return;
}

if (!matches.length) speechCategory.abilities.push(clone(definition));
else {
  const { category, ability } = matches[0];
  const abilityIndex = category.abilities.indexOf(ability);
  const rebuilt = clone(definition);
  if (category === speechCategory && abilityIndex >= 0) category.abilities.splice(abilityIndex, 1, rebuilt);
  else {
    if (abilityIndex >= 0) category.abilities.splice(abilityIndex, 1);
    speechCategory.abilities.push(rebuilt);
  }
}

await game.settings.set(SYSTEM_ID, CATALOG_SETTING, catalog);
await CONFIG.FalloutMaW?.settingsPresets?.flush?.();
ui.notifications.info("Собрана способность «Приказ: Сменить позицию!».");
console.log("Fallout MaW | Movement-route ability builder completed", { abilityId: ABILITY_ID });
})();
