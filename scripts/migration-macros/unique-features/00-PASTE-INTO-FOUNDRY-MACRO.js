const SYSTEM_ID = "fallout-maw";
const ROOT_FOLDER = "Уникальные особенности";
const FLAG_SCOPE = "fallout-maw";
const FLAG_KEY = "quickBonusAbility";
const DEFAULT_IMG = "systems/fallout-maw/assets/icons/skill%2B.webp";
const SORT_STEP = 100000;
const ROOT_CHILD_FOLDER_ORDER = ["Верткость", "Живучесть", "Реакция", "Форма жизни", "Черты"];

const RANKS = [
  ["Бог", "210"],
  ["Гений", "180"],
  ["Мастер", "150"],
  ["Профессионал", "120"],
  ["Опытный", "90"],
  ["Умелый", "60"],
  ["Новичок", "30"]
];

const SKILL_TRAITS = [
  [".Ближний бой", "meleeCombat"],
  [".Дальний бой", "rangedCombat"],
  ["Азарт", "gambling"],
  ["Атлетика", "athletics"],
  ["Бартер", "barter"],
  ["Взлом", "lockpicking"],
  ["Доктор", "doctor"],
  ["Кража", "theft"],
  ["Красноречие", "speech"],
  ["Ловушки", "traps"],
  ["Метание", "throwing"],
  ["Натуралист", "naturalist"],
  ["Наука", "science"],
  ["Первая помощь", "firstAid"],
  ["Ремонт", "repair"],
  ["Скрытность", "stealth"],
  ["Стойкость", "resilience"],
  ["Энергия", "energy"]
];

const QUICK_BONUSES = [
  {
    folderPath: ["Верткость"],
    name: "КБ -25",
    changes: [{ key: "system.resources.dodge.bonus", value: "-25" }]
  },
  {
    folderPath: ["Верткость"],
    name: "КБ +25",
    changes: [{ key: "system.resources.dodge.bonus", value: "25" }]
  },
  {
    folderPath: ["Верткость"],
    name: "КБ +50",
    changes: [{ key: "system.resources.dodge.bonus", value: "50" }]
  },
  {
    folderPath: ["Живучесть"],
    name: "Живучий",
    changes: [{ key: "system.limbs.all.maxBonus", value: "con * 2" }]
  },
  {
    folderPath: ["Живучесть"],
    name: "Крепкий",
    changes: [{ key: "system.limbs.all.maxBonus", value: "con" }]
  },
  {
    folderPath: ["Живучесть"],
    name: "Хилый",
    changes: [{ key: "system.limbs.all.maxBonus", value: "-con" }]
  },
  {
    folderPath: ["Реакция"],
    name: "Медленная реакция",
    changes: [{ key: "system.attributes.initiativeBonus", value: "-3" }]
  },
  {
    folderPath: ["Реакция"],
    name: "Отличная реакция",
    changes: [{ key: "system.attributes.initiativeBonus", value: "6" }]
  },
  {
    folderPath: ["Реакция"],
    name: "Ужасная реакция реакция",
    changes: [{ key: "system.attributes.initiativeBonus", value: "-6" }]
  },
  {
    folderPath: ["Реакция"],
    name: "Хорошая реакция",
    changes: [{ key: "system.attributes.initiativeBonus", value: "3" }]
  },
  {
    folderPath: ["Форма жизни"],
    name: "Высшая форма жизни",
    changes: [{ key: "system.limbs.all.maxBonus", value: "con * 4" }]
  },
  {
    folderPath: ["Форма жизни"],
    name: "Малая форма жизни",
    changes: [{ key: "system.limbs.all.maxBonus", value: "-con * 2" }]
  },
  {
    folderPath: ["Форма жизни"],
    name: "Улучшенная форма жизни",
    changes: [{ key: "system.limbs.all.maxBonus", value: "con * 2" }]
  }
];

for (const [skillLabel, skillKey] of SKILL_TRAITS) {
  for (const [rank, value] of RANKS) {
    QUICK_BONUSES.push({
      folderPath: ["Черты", skillLabel],
      name: `${rank}: ${skillLabel}`,
      description: `<p>Уровень мастерства "${rank}" в навыке "${skillLabel}". Дает бонус +${value} к проверкам этого навыка.</p>`,
      changes: [{ key: `system.skills.${skillKey}.bonus`, value }]
    });
  }
}

assignQuickBonusSorts();

await runQuickBonusImport();

async function runQuickBonusImport() {
  if (game.system.id !== SYSTEM_ID) {
    ui.notifications.error("Этот макрос рассчитан на систему fallout-maw.");
    return;
  }

  let touched = 0;
  for (const entry of QUICK_BONUSES) {
    const folder = await ensureFolderPath([ROOT_FOLDER, ...entry.folderPath]);
    const itemData = buildAbilityData(entry, folder.id);
    const existing = findExistingQuickBonus(entry, folder.id);
    if (existing) {
      await existing.update(itemData);
    } else {
      await Item.create(itemData);
    }
    touched += 1;
  }

  ui.notifications.info(`Быстрые бонусы: создано/обновлено ${touched}.`);
  console.log("Fallout-MaW quick bonus abilities", { touched });
}

function buildAbilityData(entry, folderId) {
  const changes = entry.changes.map(change => ({
    id: foundry.utils.randomID(),
    key: change.key,
    type: "add",
    value: change.value,
    phase: "initial",
    priority: null
  }));

  return {
    name: entry.name,
    type: "ability",
    img: DEFAULT_IMG,
    folder: folderId,
    sort: entry.sort ?? SORT_STEP,
    system: {
      description: entry.description ?? "",
      cost: 0,
      formula: "",
      acquisition: {
        onlyFree: false,
        onlyManual: false,
        skillKey: "",
        difficulty: 60
      },
      acquisitionRequirements: [],
      functions: [{
        id: foundry.utils.randomID(),
        type: "effectChanges",
        fixedKey: "",
        fixedSettings: {},
        changes,
        conditions: [],
        penalties: []
      }]
    },
    flags: {
      [FLAG_SCOPE]: {
        [FLAG_KEY]: {
          folderPath: [ROOT_FOLDER, ...entry.folderPath].join(" / "),
          name: entry.name
        }
      }
    }
  };
}

function findExistingQuickBonus(entry, folderId) {
  const fullPath = [ROOT_FOLDER, ...entry.folderPath].join(" / ");
  return game.items.find(item => {
    const flag = item.getFlag(FLAG_SCOPE, FLAG_KEY);
    return flag?.folderPath === fullPath && flag?.name === entry.name;
  }) ?? game.items.find(item => (
    item.type === "ability"
    && item.folder?.id === folderId
    && item.name === entry.name
  ));
}

async function ensureFolderPath(parts) {
  let parent = null;
  const currentParts = [];
  for (const name of parts) {
    currentParts.push(name);
    const sort = getFolderSort(currentParts);
    const existing = game.folders.find(folder => (
      folder.type === "Item"
      && folder.name === name
      && ((folder.folder?.id ?? folder.folder ?? null) === (parent?.id ?? null))
    ));
    if (existing) {
      const update = {};
      if (existing.sorting !== "m") update.sorting = "m";
      if (existing.sort !== sort) update.sort = sort;
      if (Object.keys(update).length) await existing.update(update);
      parent = existing;
      continue;
    }
    parent = await Folder.create({
      name,
      type: "Item",
      folder: parent?.id ?? null,
      sorting: "m",
      sort
    });
  }
  return parent;
}

function assignQuickBonusSorts() {
  const groups = new Map();
  for (const entry of QUICK_BONUSES) {
    const key = entry.folderPath.join(" / ");
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    group.sort(compareQuickBonusEntries);
    group.forEach((entry, index) => {
      entry.sort = (index + 1) * SORT_STEP;
    });
  }
}

function compareQuickBonusEntries(left, right) {
  const leftRank = getRankSort(left.name);
  const rightRank = getRankSort(right.name);
  if (leftRank !== rightRank) return leftRank - rightRank;

  const leftValue = getPrimaryChangeSortValue(left);
  const rightValue = getPrimaryChangeSortValue(right);
  if (leftValue !== rightValue) return rightValue - leftValue;

  return String(left.name ?? "").localeCompare(String(right.name ?? ""), "ru");
}

function getRankSort(name) {
  const rank = String(name ?? "").split(":")[0]?.trim();
  const index = RANKS.findIndex(entry => entry[0] === rank);
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}

function getPrimaryChangeSortValue(entry) {
  const value = String(entry?.changes?.[0]?.value ?? "").trim();
  const direct = Number(value);
  if (Number.isFinite(direct)) return direct;

  if (value === "con") return 1;
  if (value === "-con") return -1;

  const positive = value.match(/^con\s*\*\s*(\d+(?:\.\d+)?)$/);
  if (positive) return Number(positive[1]);

  const negative = value.match(/^-con\s*\*\s*(\d+(?:\.\d+)?)$/);
  if (negative) return -Number(negative[1]);

  return 0;
}

function getFolderSort(parts) {
  if (parts.length <= 1) return SORT_STEP;

  if (parts.length === 2 && parts[0] === ROOT_FOLDER) {
    return getOrderSort(ROOT_CHILD_FOLDER_ORDER, parts[1]);
  }

  if (parts.length === 3 && parts[0] === ROOT_FOLDER && parts[1] === "Черты") {
    return getOrderSort(SKILL_TRAITS.map(entry => entry[0]), parts[2]);
  }

  return SORT_STEP;
}

function getOrderSort(order, value) {
  const index = order.indexOf(value);
  return (index >= 0 ? index + 1 : order.length + 1) * SORT_STEP;
}
