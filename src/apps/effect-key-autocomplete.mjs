import { escapeHtml, getHtmlRoot } from "../utils/dom.mjs";

const EFFECT_KEY_INPUT_SELECTOR = "input[data-effect-key-autocomplete]";
const TOKEN_BEFORE_CARET = /[\p{L}_][\p{L}\p{N}_]*$/u;
const MENU_VIEWPORT_PADDING = 12;

export function activateEffectKeyAutocomplete(html, tokens = [], { selector = EFFECT_KEY_INPUT_SELECTOR } = {}) {
  const root = getHtmlRoot(html);
  if (!root || !tokens.length) return;

  for (const input of root.querySelectorAll(selector)) {
    if (input.dataset.effectKeyAutocompleteActive === "true") continue;
    input.dataset.effectKeyAutocompleteActive = "true";
    new EffectKeyAutocomplete(input, tokens);
  }
}

export function createEffectKeyToken({ code, key, label, path, group = "" }) {
  const normalizedCode = String(code ?? "").trim();
  const normalizedKey = String(key ?? "").trim();
  const normalizedLabel = String(label ?? "").trim();
  const normalizedPath = String(path ?? "").trim();
  if (!normalizedCode || !normalizedKey || !normalizedPath) return null;

  return {
    code: normalizedCode,
    key: normalizedKey,
    label: normalizedLabel,
    path: normalizedPath,
    group: String(group ?? ""),
    matches: buildSearchValues(normalizedCode, normalizedKey, normalizedLabel, normalizedPath)
  };
}

class EffectKeyAutocomplete {
  constructor(input, tokens) {
    this.input = input;
    this.tokens = tokens;
    this.matches = [];
    this.activeIndex = 0;
    this.tokenStart = 0;
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
    const beforeCaret = this.input.value.slice(0, caret);
    const match = beforeCaret.match(TOKEN_BEFORE_CARET);
    if (!match) return null;
    return {
      query: normalizeSearchText(match[0]),
      start: caret - match[0].length
    };
  }

  #findMatches(query) {
    return this.tokens
      .filter(token => token.matches.some(value => value.startsWith(query)))
      .sort((left, right) => (
        getTokenSuggestionRank(left) - getTokenSuggestionRank(right)
        || left.code.localeCompare(right.code)
      ));
  }

  #render() {
    if (!this.menu) {
      this.menu = document.createElement("div");
      this.menu.className = "fallout-maw-formula-autocomplete fallout-maw-effect-key-autocomplete";
      this.menu.addEventListener("mousedown", event => event.preventDefault());
      document.body.appendChild(this.menu);
    }

    this.menu.innerHTML = "";
    this.matches.forEach((token, index) => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "fallout-maw-formula-autocomplete-option";
      option.dataset.index = String(index);
      option.innerHTML = `
        <strong>${escapeHtml(token.code)}</strong>
        <span>${escapeHtml(token.label || token.key)}</span>
      `;
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
    this.menu.style.top = `${rect.bottom + 2}px`;
    const minWidth = Math.max(rect.width, 300);
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

    const caret = this.input.selectionStart ?? this.input.value.length;
    const before = this.input.value.slice(0, this.tokenStart);
    const after = this.input.value.slice(caret);
    this.input.value = `${before}${token.path}${after}`;

    const nextCaret = this.tokenStart + token.path.length;
    this.input.setSelectionRange(nextCaret, nextCaret);
    this.input.dispatchEvent(new Event("input", { bubbles: true }));
    this.input.dispatchEvent(new Event("change", { bubbles: true }));
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

function getTokenSuggestionRank(token) {
  const path = String(token?.path ?? "");
  if (path.endsWith(".all.all")) return 0;
  if (path.endsWith(".all")) return 1;
  if (path.includes(".all.")) return 2;
  return 3;
}
