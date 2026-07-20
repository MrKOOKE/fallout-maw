import { format, localize } from "../utils/i18n.mjs";
import { getCharacteristicAliases, getSkillAliases } from "./normalization.mjs";

export function parseFormula(source, options = {}) {
  const parser = new FormulaParser(source, normalizeFormulaOptions(options));
  const expression = parser.parseExpression();
  parser.expectEnd();
  return expression;
}

export function validateFormula(formula, options = {}) {
  parseFormula(String(formula ?? "0"), options);
  return true;
}

export function normalizeFormulaOptions(options = {}) {
  return {
    allowSkills: options.allowSkills === true,
    characteristicAliases: getCharacteristicAliases(options.characteristics),
    skillAliases: getSkillAliases(options.skills),
    variableAliases: getVariableAliases(options.variables),
    referenceAliases: getReferenceAliases(options.references)
  };
}

class FormulaParser {
  constructor(source, options = {}) {
    this.source = String(source ?? "0");
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
      if (this.peek() !== ")") throw this.error(localize("FALLOUTMAW.Formula.ClosingParenthesisExpected"));
      this.index += 1;
      return expression;
    }

    if (/[0-9.]/.test(character)) return this.parseNumber();
    if (character === "@") return this.parseReference();
    if (/\p{L}|_/u.test(character)) return this.parseIdentifier();

    throw this.error(localize("FALLOUTMAW.Formula.ExpectedTerm"));
  }

  parseNumber() {
    const start = this.index;
    while (/[0-9.]/.test(this.peek())) this.index += 1;
    const token = this.source.slice(start, this.index);

    if (!/^(?:\d+|\d+\.\d+|\.\d+)$/.test(token)) {
      throw this.error(format("FALLOUTMAW.Formula.InvalidNumber", { token }));
    }

    const value = Number(token);
    return { evaluate: () => value };
  }

  parseIdentifier() {
    const identifier = this.readIdentifierPath();
    const normalized = identifier.toLowerCase();

    if (
      !this.options.characteristicAliases[normalized]
      && !(this.options.allowSkills && this.options.skillAliases[normalized])
      && !this.options.variableAliases[normalized]
      && !this.options.referenceAliases[normalized]
    ) {
      throw this.error(format("FALLOUTMAW.Formula.UnknownParameter", { identifier }));
    }

    return { evaluate: resolve => resolve(identifier) };
  }

  parseReference() {
    this.index += 1;
    const identifier = this.readIdentifierPath();
    const normalized = identifier.toLowerCase();
    if (!this.options.referenceAliases[normalized]) {
      throw this.error(format("FALLOUTMAW.Formula.UnknownParameter", { identifier: `@${identifier}` }));
    }
    return { evaluate: resolve => resolve(`@${identifier}`) };
  }

  readIdentifierPath() {
    const start = this.index;
    this.readIdentifierSegment();
    while (this.peek() === ".") {
      this.index += 1;
      this.readIdentifierSegment();
    }
    return this.source.slice(start, this.index);
  }

  readIdentifierSegment() {
    if (!/[\p{L}_]/u.test(this.peek())) {
      throw this.error(localize("FALLOUTMAW.Formula.ExpectedTerm"));
    }
    this.index += 1;
    while (/[\p{L}\p{N}_]/u.test(this.peek())) this.index += 1;
  }

  expectEnd() {
    this.skipWhitespace();
    if (this.index < this.source.length) {
      throw this.error(format("FALLOUTMAW.Formula.ExtraCharacter", { character: this.peek() }));
    }
  }

  skipWhitespace() {
    while (/\s/.test(this.peek())) this.index += 1;
  }

  peek() {
    return this.source[this.index] ?? "";
  }

  error(message) {
    return new Error(`${message} ${format("FALLOUTMAW.Formula.OnPosition", { position: this.index + 1 })}`);
  }
}

function getVariableAliases(variables = []) {
  const aliases = {};
  for (const variable of variables ?? []) {
    if (variable && typeof variable === "object") {
      const key = String(variable.key ?? "").trim();
      if (!key) continue;
      aliases[key.toLowerCase()] = key;
      const abbr = String(variable.abbr ?? "").trim();
      if (abbr) aliases[abbr.toLowerCase()] = key;
      for (const alias of variable.aliases ?? []) {
        const normalized = String(alias ?? "").trim();
        if (normalized) aliases[normalized.toLowerCase()] = key;
      }
      continue;
    }
    const key = String(variable ?? "").trim();
    if (key) aliases[key.toLowerCase()] = key;
  }
  return aliases;
}

function getReferenceAliases(references = []) {
  const source = Array.isArray(references)
    ? references
    : Object.keys(references ?? {});
  const aliases = {};
  for (const reference of source ?? []) {
    if (reference && typeof reference === "object") {
      const key = normalizeReference(reference.key);
      if (!key) continue;
      aliases[key.toLowerCase()] = key;
      for (const alias of reference.aliases ?? []) {
        const normalized = normalizeReference(alias);
        if (normalized) aliases[normalized.toLowerCase()] = key;
      }
      continue;
    }
    const key = normalizeReference(reference);
    if (key) aliases[key.toLowerCase()] = key;
  }
  return aliases;
}

function normalizeReference(value) {
  return String(value ?? "").trim().replace(/^@/, "");
}

function binaryExpression(operator, left, right) {
  return {
    evaluate(resolve) {
      const leftValue = left.evaluate(resolve);
      const rightValue = right.evaluate(resolve);

      switch (operator) {
        case "+":
          return leftValue + rightValue;
        case "-":
          return leftValue - rightValue;
        case "*":
          return leftValue * rightValue;
        case "/":
          if (rightValue === 0) throw new Error(localize("FALLOUTMAW.Formula.DivisionByZero"));
          return leftValue / rightValue;
        default:
          throw new Error(`Unsupported operator: ${operator}`);
      }
    }
  };
}
