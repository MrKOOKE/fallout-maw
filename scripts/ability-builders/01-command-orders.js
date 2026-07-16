// Одноразовый GM-макрос для Fallout MaW.
// Собирает в каталоге две конструкторные способности:
// «Приказ: Коли!» и «Приказ: Цельсь, пли!».
// Выданные предметы, исследования и старые «Основы командования» не изменяет.

await (async () => {

const SYSTEM_ID = "fallout-maw";
const CATALOG_SETTING = "abilitiesCatalog";
const SKILLS_SETTING = "skillSettings";
const SPEECH_CATEGORY_ID = "skill-speech";
const ABILITY_IDS = Object.freeze({
  strike: "o0eHtaXDOfkfOP4M",
  shoot: "hXDOkMGJjkPB7WBb"
});

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

function buildCommandFunction(abilityId, actionKey) {
  const functionId = `${abilityId}-application`;
  return {
    id: functionId,
    type: "activeApplication",
    sort: 0,
    fixedKey: "",
    fixedSettings: {},
    reactionSettings: {
      costs: [],
      durationSeconds: 0
    },
    activeSettings: {
      name: "",
      costs: [{
        id: `${functionId}-cost-power`,
        resourceKey: "power",
        formula: "30",
        overloadAmount: 60,
        overloadDurationSeconds: 12
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
      id: `${functionId}-weapon-attack`,
      type: "weaponAttack",
      attackActionKeys: [actionKey],
      executorMode: "targets",
      targetMode: "free",
      actionPointCostMode: "none",
      fixedActionPointCost: 0,
      actualActionPointCostPercent: 100
    }],
    conditions: [],
    penalties: []
  };
}

function buildStrikeAbility() {
  return {
    id: ABILITY_IDS.strike,
    name: "Приказ: Коли!",
    img: "systems/fallout-maw/assets/icons/1-7/lider.webp",
    visible: true,
    description: "<p>Стоимость активации: 30 энергии<br>Перегрузка: 60 энергии на 12 секунд.</p><p>Активация позволяет выбрать до [[2+speech/50]]-х союзников. Они ударят в указанных вами направлениях.</p>",
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
        id: "GYTOhsTgDylfTDfg",
        type: "skill",
        skillKey: "speech",
        value: 100
      }],
      functions: [buildCommandFunction(ABILITY_IDS.strike, "meleeAttack")]
    }
  };
}

function buildShootAbility() {
  return {
    id: ABILITY_IDS.shoot,
    name: "Приказ: Цельсь, пли!",
    img: "systems/fallout-maw/assets/icons/1-7/lider.webp",
    visible: true,
    description: "<p>Стоимость активации: 30 энергии<br>Перегрузка: 60 энергии на 12 секунд.</p><p>Активация позволяет выбрать до [[2+speech/50]]-х союзников. Они выстрелят в указанных вами направлениях.</p>",
    system: {
      category: "Красноречие",
      cost: 0,
      formula: "",
      acquisition: {
        difficulty: 60,
        onlyFree: false,
        onlyManual: false,
        skillKey: "meleeCombat"
      },
      acquisitionRequirements: [],
      functions: [buildCommandFunction(ABILITY_IDS.shoot, "snapshot")]
    }
  };
}

const catalog = clone(game.settings.get(SYSTEM_ID, CATALOG_SETTING));
const categories = Array.isArray(catalog?.categories) ? catalog.categories : [];
const speechCategory = categories.find(category => String(category?.id ?? "") === SPEECH_CATEGORY_ID);
if (!speechCategory) {
  ui.notifications.error("В каталоге не найдена категория Красноречия (skill-speech).");
  return;
}
speechCategory.abilities = Array.isArray(speechCategory.abilities) ? speechCategory.abilities : [];

const definitions = [buildStrikeAbility(), buildShootAbility()];
const changedNames = [];
for (const definition of definitions) {
  const matches = [];
  for (const category of categories) {
    for (const ability of category?.abilities ?? []) {
      if (String(ability?.id ?? "") === definition.id) matches.push({ category, ability });
    }
  }
  if (matches.length > 1) {
    ui.notifications.error(`${definition.name}: в каталоге найдено несколько записей с ID ${definition.id}.`);
    return;
  }

  if (!matches.length) {
    speechCategory.abilities.push(definition);
  } else {
    const current = matches[0].ability;
    current.system = {
      ...(current.system ?? {}),
      functions: clone(definition.system.functions)
    };
  }
  changedNames.push(definition.name);
}

await game.settings.set(SYSTEM_ID, CATALOG_SETTING, catalog);
await CONFIG.FalloutMaW?.settingsPresets?.flush?.();
ui.notifications.info(`Собраны способности: ${changedNames.join(", ")}.`);
console.log("Fallout MaW | Ability builder completed", {
  abilityIds: definitions.map(definition => definition.id),
  executorMode: "targets"
});
})();
