import { escapeHtml, getHtmlRoot } from "../utils/dom.mjs";
import { getOverlayBaseZIndex } from "../utils/overlay-layer.mjs";

const FORMULA_INPUT_SELECTOR = "input[data-formula-autocomplete]";
const IDENTIFIER_BEFORE_CARET = /[\p{L}_][\p{L}\p{N}_]*$/u;
const IDENTIFIER_CHARACTER = /[\p{L}\p{N}_]/u;
const MAX_SUGGESTIONS = 10;
const MENU_VIEWPORT_PADDING = 12;

export function activateFormulaAutocomplete(html, { characteristics = [], skills = [], variables = [] } = {}) {
  const root = getHtmlRoot(html);
  if (!root) return;

  const tokenGroups = {
    characteristics: buildTokens(characteristics, "characteristic"),
    all: [
      ...buildTokens(characteristics, "characteristic"),
      ...buildTokens(skills, "skill"),
      ...buildTokens(variables, "variable")
    ]
  };

  for (const input of root.querySelectorAll(FORMULA_INPUT_SELECTOR)) {
    if (input.dataset.formulaAutocompleteActive === "true") continue;
    input.dataset.formulaAutocompleteActive = "true";
    const mode = input.dataset.formulaAutocomplete || "characteristics";
    const tokens = tokenGroups[mode] ?? tokenGroups.characteristics;
    if (tokens.length) new FormulaAutocomplete(input, tokens);
  }
}

function buildTokens(entries, type) {
  return entries
    .map(entry => {
      const code = String(entry.abbr || entry.key || "").trim();
      const key = String(entry.key || "").trim();
      const label = String(entry.label || "").trim();
      return {
        code,
        key,
        label,
        type,
        matches: buildSearchValues(code, key, label)
      };
    })
    .filter(token => token.code && token.key);
}

class FormulaAutocomplete {
  constructor(input, tokens) {
    this.input = input;
    this.tokens = tokens;
    this.matches = [];
    this.activeIndex = 0;
    this.tokenStart = 0;
    this.tokenEnd = 0;
    this.menu = null;
    this.abortController = new AbortController();
    const { signal } = this.abortController;

    this.input.addEventListener("input", this.#onInput, { signal });
    this.input.addEventListener("click", this.#onInput, { signal });
    this.input.addEventListener("keydown", this.#onKeydown, { signal });
    this.input.addEventListener("blur", this.#onBlur, { signal });
    document.addEventListener("pointerdown", this.#onDocumentPointerDown, { capture: true, signal });
    window.addEventListener("resize", this.#position, { signal });
    window.addEventListener("scroll", this.#onWindowScroll, { capture: true, signal });
  }

  #onInput = () => {
    const context = this.#getTokenContext();
    if (!context) {
      this.#hide();
      return;
    }

    this.tokenStart = context.start;
    this.tokenEnd = context.end;
    this.matches = this.#findMatches(context.query);
    this.activeIndex = 0;

    if (!this.matches.length) {
      this.#hide();
      return;
    }

    this.#render();
    this.#position();
  };

  #onKeydown = event => {
    if (!this.menu || this.menu.hidden) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      this.#setActive(this.activeIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      this.#setActive(this.activeIndex - 1);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      this.#insert(this.matches[this.activeIndex]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      this.#hide();
    }
  };

  #onBlur = () => {
    window.setTimeout(() => {
      if (this.menu?.matches(":hover")) return;
      this.#hide();
    }, 120);
  };

  #onDocumentPointerDown = event => {
    if (event.target === this.input) return;
    if (this.menu?.contains(event.target)) return;
    this.#hide();
  };

  #onWindowScroll = event => {
    if (this.menu?.contains(event.target)) return;
    this.#position();
  };

  #hide = () => {
    this.menu?.remove();
    this.menu = null;
    this.matches = [];
  };

  #getTokenContext() {
    const caret = this.input.selectionStart ?? this.input.value.length;
    const value = this.input.value;
    const beforeCaret = value.slice(0, caret);
    const match = beforeCaret.match(IDENTIFIER_BEFORE_CARET);
    if (!match) return null;
    const start = caret - match[0].length;
    const end = findIdentifierEnd(value, caret);
    const token = value.slice(start, end);
    return {
      query: normalizeSearchText(token),
      start,
      end
    };
  }

  #findMatches(query) {
    return this.tokens
      .filter(token => token.matches.some(value => value.startsWith(query)))
      .sort((left, right) => left.code.localeCompare(right.code))
      .slice(0, MAX_SUGGESTIONS);
  }

  #render() {
    if (!this.menu) {
      this.menu = document.createElement("div");
      this.menu.className = "fallout-maw-formula-autocomplete";
      this.menu.addEventListener("mousedown", event => event.preventDefault());
      document.body.appendChild(this.menu);
    }

    this.menu.innerHTML = "";
    this.matches.forEach((token, index) => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "fallout-maw-formula-autocomplete-option";
      option.dataset.index = String(index);
      option.innerHTML = `<strong>${escapeHtml(token.code)}</strong><span>${escapeHtml(token.label || token.key)}</span>`;
      option.addEventListener("mousedown", event => {
        event.preventDefault();
        this.#insert(token);
      });
      this.menu.appendChild(option);
    });

    this.#setActive(0);
    this.menu.hidden = false;
  }

  #position() {
    if (!this.menu) return;
    const rect = this.input.getBoundingClientRect();
    const owner = this.input.closest(".application, .window-app") ?? this.input;
    this.menu.style.zIndex = String(getOverlayBaseZIndex(owner) + 10);
    this.menu.style.top = `${rect.bottom + 2}px`;
    const minWidth = Math.max(rect.width, 220);
    const maxWidth = Math.max(minWidth, window.innerWidth - (MENU_VIEWPORT_PADDING * 2));

    this.menu.style.minWidth = `${minWidth}px`;
    this.menu.style.maxWidth = `${maxWidth}px`;
    this.menu.style.width = "max-content";

    const width = Math.min(Math.max(this.menu.scrollWidth, minWidth), maxWidth);
    const leftMax = window.innerWidth - width - MENU_VIEWPORT_PADDING;
    const left = Math.min(Math.max(rect.left, MENU_VIEWPORT_PADDING), leftMax);
    this.menu.style.left = `${Math.max(MENU_VIEWPORT_PADDING, left)}px`;
    this.menu.style.width = `${width}px`;
  }

  #setActive(index) {
    if (!this.menu || !this.matches.length) return;
    this.activeIndex = (index + this.matches.length) % this.matches.length;
    for (const option of this.menu.querySelectorAll(".fallout-maw-formula-autocomplete-option")) {
      option.classList.toggle("active", Number(option.dataset.index) === this.activeIndex);
    }
  }

  #insert(token) {
    if (!token) return;

    const before = this.input.value.slice(0, this.tokenStart);
    const after = this.input.value.slice(this.tokenEnd);
    this.input.value = `${before}${token.code}${after}`;

    const nextCaret = this.tokenStart + token.code.length;
    this.input.setSelectionRange(nextCaret, nextCaret);
    this.input.dispatchEvent(new Event("input", { bubbles: true }));
    this.input.focus();
    this.#hide();
  }
}

function normalizeSearchText(value) {
  return String(value).trim().toLocaleLowerCase();
}

function buildSearchValues(...values) {
  const matches = new Set();
  for (const value of values) {
    const normalized = normalizeSearchText(value);
    if (!normalized) continue;
    matches.add(normalized);
    for (const part of normalized.split(/\s+/)) {
      if (part) matches.add(part);
    }
  }
  return Array.from(matches);
}

function findIdentifierEnd(value = "", start = 0) {
  let index = Math.max(0, Math.min(String(value).length, start));
  while (index < value.length && IDENTIFIER_CHARACTER.test(value[index])) index += 1;
  return index;
}
