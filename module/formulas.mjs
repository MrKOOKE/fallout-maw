import { DEFAULT_CHARACTERISTICS, DEFAULT_SKILLS, FALLOUT_MAW } from "./config.mjs";

export const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const LEGACY_CHARACTERISTIC_ALIASES = {
  str: "strength",
  dex: "agility",
  agi: "agility",
  con: "endurance",
  end: "endurance",
  wis: "perception",
  per: "perception",
  int: "intelligence",
  cha: "charisma",
  luc: "luck",
  lck: "luck"
};

const LEGACY_SKILL_ALIASES = {
  ath: "athletics"
};

export function createDefaultCharacteristicSettings() {
  return DEFAULT_CHARACTERISTICS.map(entry => ({ ...entry }));
}

export function createDefaultSkillSettings() {
  return DEFAULT_SKILLS.map(entry => ({ ...entry }));
}

export function createDefaultSkillFormulas() {
  return Object.fromEntries(createDefaultSkillSettings().map(skill => [skill.key, skill.formula]));
}

export function createDefaultActionMovementFormulas() {
  return {
    actionPoints: "5 + (dex/3 + str/5)",
    movementPoints: "2 + ath/50"
  };
}

export function normalizeCharacteristicSettings(settings) {
  const source = normalizeCollectionInput(settings, createDefaultCharacteristicSettings());
  return normalizeKeyedEntries(source, entry => ({
    key: String(entry?.key ?? "").trim(),
    label: String(entry?.label ?? entry?.name ?? "").trim()
  }), "Характеристика");
}

export function normalizeSkillSettings(settings) {
  const source = normalizeSkillSettingsInput(settings);
  return normalizeKeyedEntries(source, entry => ({
    key: String(entry?.key ?? "").trim(),
    label: String(entry?.label ?? entry?.name ?? "").trim(),
    formula: String(entry?.formula ?? "0").trim() || "0"
  }), "Навык");
}

export function normalizeSkillFormulas(formulas = {}) {
  if (Array.isArray(formulas) || Array.isArray(formulas?.skills)) return normalizeSkillSettings(formulas);
  const defaults = createDefaultSkillSettings();
  return defaults.map(skill => ({
    ...skill,
    formula: String(formulas?.[skill.key] ?? skill.formula).trim() || skill.formula
  }));
}

export function normalizeActionMovementFormulas(formulas = {}) {
  const defaults = createDefaultActionMovementFormulas();
  return Object.fromEntries(Object.keys(defaults).map(key => {
    const formula = String(formulas?.[key] ?? defaults[key]).trim();
    return [key, formula || defaults[key]];
  }));
}

export function normalizeNumberMap(values = {}, definitions = []) {
  return Object.fromEntries(definitions.map(definition => [
    definition.key,
    toInteger(values?.[definition.key])
  ]));
}

export function validateFormula(formula, options = {}) {
  parseFormula(String(formula ?? "0"), normalizeFormulaOptions(options));
  return true;
}

export function evaluateFormula(formula, data = {}) {
  const options = normalizeFormulaOptions({
    characteristics: data.characteristicSettings,
    skills: data.skillSettings,
    allowSkills: Boolean(data.skills)
  });
  const expression = parseFormula(String(formula ?? "0"), options);
  const value = expression.evaluate(identifier => {
    const normalized = identifier.toLowerCase();
    const characteristic = options.characteristicAliases[normalized];
    if (characteristic) return Number(data.characteristics?.[characteristic] ?? data[characteristic]) || 0;
    const skill = options.skillAliases[normalized];
    if (skill) return Number(data.skills?.[skill] ?? data[skill]) || 0;
    throw new Error(`Неизвестный параметр "${identifier}"`);
  });
  if (!Number.isFinite(value)) throw new Error("Формула дала некорректное числовое значение");
  return Math.trunc(value);
}

export function evaluateSkillFormulas(skillSettings, characteristicSettings, characteristics = {}) {
  const normalizedSkills = normalizeSkillSettings(skillSettings);
  const normalizedCharacteristics = normalizeCharacteristicSettings(characteristicSettings);
  return Object.fromEntries(normalizedSkills.map(skill => {
    try {
      return [skill.key, Math.max(0, evaluateFormula(skill.formula, {
        characteristicSettings: normalizedCharacteristics,
        characteristics
      }))];
    } catch (error) {
      console.warn(`${FALLOUT_MAW.title} | Ошибка формулы навыка ${skill.key}: ${error.message}`);
      return [skill.key, 0];
    }
  }));
}

export function evaluateActionMovementFormulas(
  formulas = {},
  characteristicSettings,
  skillSettings,
  characteristics = {},
  skills = {}
) {
  const normalized = normalizeActionMovementFormulas(formulas);
  const normalizedCharacteristics = normalizeCharacteristicSettings(characteristicSettings);
  const normalizedSkills = normalizeSkillSettings(skillSettings);
  return Object.fromEntries(Object.entries(normalized).map(([key, formula]) => {
    try {
      return [key, Math.max(0, evaluateFormula(formula, {
        characteristicSettings: normalizedCharacteristics,
        skillSettings: normalizedSkills,
        characteristics,
        skills
      }))];
    } catch (error) {
      console.warn(`${FALLOUT_MAW.title} | Ошибка формулы ${key}: ${error.message}`);
      return [key, 0];
    }
  }));
}

export function getCharacteristicAliases(characteristics) {
  const normalized = normalizeCharacteristicSettings(characteristics);
  const aliases = Object.fromEntries(normalized.map(entry => [entry.key.toLowerCase(), entry.key]));
  for (const [alias, target] of Object.entries(LEGACY_CHARACTERISTIC_ALIASES)) {
    if (aliases[target.toLowerCase()]) aliases[alias] = target;
  }
  return aliases;
}

export function getSkillAliases(skills) {
  const normalized = normalizeSkillSettings(skills);
  const aliases = Object.fromEntries(normalized.map(entry => [entry.key.toLowerCase(), entry.key]));
  for (const [alias, target] of Object.entries(LEGACY_SKILL_ALIASES)) {
    if (aliases[target.toLowerCase()]) aliases[alias] = target;
  }
  return aliases;
}

function normalizeFormulaOptions(options = {}) {
  return {
    allowSkills: options.allowSkills === true,
    characteristicAliases: getCharacteristicAliases(options.characteristics),
    skillAliases: getSkillAliases(options.skills)
  };
}

function normalizeSkillSettingsInput(settings) {
  if (settings === undefined || settings === null) return createDefaultSkillSettings();
  if (Array.isArray(settings)) return settings;
  if (Array.isArray(settings?.skills)) return settings.skills;
  if (settings && typeof settings === "object") {
    const values = Object.values(settings);
    if (values.every(value => value && typeof value === "object" && "key" in value)) return values;
    return Object.entries(settings).map(([key, formula]) => ({
      key,
      label: FALLOUT_MAW.skills[key] ?? key,
      formula
    }));
  }
  return createDefaultSkillSettings();
}

function normalizeCollectionInput(settings, defaults) {
  if (settings === undefined || settings === null) return defaults;
  if (Array.isArray(settings)) return settings;
  if (Array.isArray(settings?.entries)) return settings.entries;
  if (settings && typeof settings === "object") {
    return Object.entries(settings).map(([key, label]) => ({ key, label }));
  }
  return defaults;
}

function normalizeKeyedEntries(source, mapEntry, fallbackLabel) {
  const used = new Set();
  const entries = [];
  for (const raw of source) {
    const entry = mapEntry(raw);
    if (!IDENTIFIER_PATTERN.test(entry.key) || used.has(entry.key)) continue;
    used.add(entry.key);
    entries.push({
      ...entry,
      label: entry.label || `${fallbackLabel} ${entries.length + 1}`
    });
  }
  return entries;
}

function parseFormula(source, options = {}) {
  const parser = new FormulaParser(source, options);
  const expression = parser.parseExpression();
  parser.expectEnd();
  return expression;
}

class FormulaParser {
  constructor(source, options = {}) {
    this.source = source;
    this.options = options;
    this.index = 0;
  }

  parseExpression() {
    let expression = this.parseTerm();
    while (true) {
      this.skipWhitespace();
      const operator = this.peek();
      if (!["+", "-"].includes(operator)) return expression;
      this.index += 1;
      const right = this.parseTerm();
      expression = binaryExpression(operator, expression, right);
    }
  }

  parseTerm() {
    let expression = this.parseFactor();
    while (true) {
      this.skipWhitespace();
      const operator = this.peek();
      if (!["*", "/"].includes(operator)) return expression;
      this.index += 1;
      const right = this.parseFactor();
      expression = binaryExpression(operator, expression, right);
    }
  }

  parseFactor() {
    this.skipWhitespace();
    const character = this.peek();
    if (character === "+") {
      this.index += 1;
      return this.parseFactor();
    }
    if (character === "-") {
      this.index += 1;
      const expression = this.parseFactor();
      return { evaluate: resolve => -expression.evaluate(resolve) };
    }
    if (character === "(") {
      this.index += 1;
      const expression = this.parseExpression();
      this.skipWhitespace();
      if (this.peek() !== ")") throw this.error("Ожидалась закрывающая скобка");
      this.index += 1;
      return expression;
    }
    if (/[0-9.]/.test(character)) return this.parseNumber();
    if (/[A-Za-z_]/.test(character)) return this.parseIdentifier();
    throw this.error("Ожидалось число, параметр или скобка");
  }

  parseNumber() {
    const start = this.index;
    while (/[0-9.]/.test(this.peek())) this.index += 1;
    const token = this.source.slice(start, this.index);
    if (!/^(?:\d+|\d+\.\d+|\.\d+)$/.test(token)) throw this.error(`Некорректное число "${token}"`);
    const value = Number(token);
    return { evaluate: () => value };
  }

  parseIdentifier() {
    const start = this.index;
    while (/[A-Za-z0-9_]/.test(this.peek())) this.index += 1;
    const identifier = this.source.slice(start, this.index);
    const normalized = identifier.toLowerCase();
    if (
      !this.options.characteristicAliases[normalized]
      && !(this.options.allowSkills && this.options.skillAliases[normalized])
    ) {
      throw this.error(`Неизвестный параметр "${identifier}"`);
    }
    return { evaluate: resolve => resolve(identifier) };
  }

  expectEnd() {
    this.skipWhitespace();
    if (this.index < this.source.length) throw this.error(`Лишний символ "${this.peek()}"`);
  }

  skipWhitespace() {
    while (/\s/.test(this.peek())) this.index += 1;
  }

  peek() {
    return this.source[this.index] ?? "";
  }

  error(message) {
    return new Error(`${message} на позиции ${this.index + 1}`);
  }
}

function binaryExpression(operator, left, right) {
  return {
    evaluate(resolve) {
      const leftValue = left.evaluate(resolve);
      const rightValue = right.evaluate(resolve);
      switch (operator) {
        case "+": return leftValue + rightValue;
        case "-": return leftValue - rightValue;
        case "*": return leftValue * rightValue;
        case "/":
          if (rightValue === 0) throw new Error("Деление на ноль");
          return leftValue / rightValue;
      }
    }
  };
}

function toInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}
