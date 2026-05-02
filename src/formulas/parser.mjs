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
    skillAliases: getSkillAliases(options.skills)
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
    if (/[A-Za-z_]/.test(character)) return this.parseIdentifier();

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
    const start = this.index;
    while (/[A-Za-z0-9_]/.test(this.peek())) this.index += 1;
    const identifier = this.source.slice(start, this.index);
    const normalized = identifier.toLowerCase();

    if (!this.options.characteristicAliases[normalized] && !(this.options.allowSkills && this.options.skillAliases[normalized])) {
      throw this.error(format("FALLOUTMAW.Formula.UnknownParameter", { identifier }));
    }

    return { evaluate: resolve => resolve(identifier) };
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
