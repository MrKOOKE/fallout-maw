import { toInteger } from "../utils/numbers.mjs";

export const MAX_LEVEL = 100;

export function createDefaultLevelSettings(maxLevel = MAX_LEVEL) {
  return Array.from({ length: maxLevel + 1 }, (_entry, level) => ({
    level,
    experience: levelExperience(level)
  }));
}

export function normalizeLevelSettings(settings) {
  const source = Array.isArray(settings?.levels)
    ? settings.levels
    : Array.isArray(settings)
      ? settings
      : createDefaultLevelSettings();

  const rows = source
    .map(entry => ({
      level: Math.max(0, toInteger(entry?.level)),
      experience: Math.max(0, toInteger(entry?.experience ?? entry?.xp))
    }))
    .sort((left, right) => left.level - right.level);

  if (!rows.some(entry => entry.level === 0)) rows.unshift({ level: 0, experience: 0 });

  const uniqueRows = [];
  const usedLevels = new Set();

  for (const row of rows) {
    if (usedLevels.has(row.level)) continue;
    usedLevels.add(row.level);
    uniqueRows.push(row);
  }

  let previousExperience = 0;
  return uniqueRows.map((row, index) => {
    const experience = index === 0
      ? 0
      : Math.max(previousExperience, row.experience);
    previousExperience = experience;
    return {
      level: row.level,
      experience
    };
  });
}

export function getLevelThreshold(levelSettings = [], level = 0) {
  const normalized = normalizeLevelSettings(levelSettings);
  const targetLevel = Math.max(0, toInteger(level));
  let threshold = 0;

  for (const entry of normalized) {
    if (entry.level > targetLevel) break;
    threshold = entry.experience;
  }

  return threshold;
}

function levelExperience(level) {
  if (level <= 0) return 0;
  return (75 * level * level) + (125 * level);
}
