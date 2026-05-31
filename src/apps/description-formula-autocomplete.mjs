import { getCharacteristicSettings, getSkillSettings } from "../settings/accessors.mjs";
import { escapeHtml, getHtmlRoot } from "../utils/dom.mjs";

const DESCRIPTION_EDITOR_SELECTOR = "prose-mirror .ProseMirror, .editor-content.ProseMirror, .ProseMirror[contenteditable='true']";
const FORMULA_CONTEXT_PATTERN = /\[\[[^\]\r\n]*?([\p{L}_][\p{L}\p{N}_]*)$/u;
const MAX_SUGGESTIONS = 10;
const MENU_VIEWPORT_PADDING = 12;

export function activateDescriptionFormulaAutocomplete(html) {
  const root = getHtmlRoot(html);
  if (!root) return;

  const tokens = buildDescriptionFormulaTokens();
  if (!tokens.length) return;

  for (const editor of root.querySelectorAll(DESCRIPTION_EDITOR_SELECTOR)) {
    if (!(editor instanceof HTMLElement)) continue;
    if (editor.dataset.descriptionFormulaAutocompleteActive === "true") continue;
    editor.dataset.descriptionFormulaAutocompleteActive = "true";
    new DescriptionFormulaAutocomplete(editor, tokens);
  }
}

function buildDescriptionFormulaTokens() {
  return [
    ...buildTokens(getCharacteristicSettings(), "characteristic"),
    ...buildTokens(getSkillSettings(), "skill")
  ];
}

function buildTokens(entries, type) {
  return entries
    .map(entry => {
      const key = String(entry.key || "").trim();
      const label = String(entry.label || "").trim();
      const abbr = String(entry.abbr || "").trim();
      return {
        code: key,
        key,
        label,
        abbr,
        type,
        matches: buildSearchValues(key, label, abbr)
      };
    })
    .filter(token => token.code);
}

class DescriptionFormulaAutocomplete {
  constructor(editor, tokens) {
    this.editor = editor;
    this.tokens = tokens;
    this.matches = [];
    this.activeIndex = 0;
    this.tokenRange = null;
    this.menu = null;
    this.abortController = new AbortController();
    const { signal } = this.abortController;

    this.editor.addEventListener("input", this.onInput, { signal });
    this.editor.addEventListener("keyup", this.onInput, { signal });
    this.editor.addEventListener("click", this.onInput, { signal });
    this.editor.addEventListener("keydown", this.onKeydown, { signal });
    this.editor.addEventListener("blur", this.onBlur, { signal });
    document.addEventListener("pointerdown", this.onDocumentPointerDown, { capture: true, signal });
    window.addEventListener("resize", this.position, { signal });
    window.addEventListener("scroll", this.position, { capture: true, signal });
  }

  onInput = () => {
    const context = this.getTokenContext();
    if (!context) {
      this.hide();
      return;
    }

    this.tokenRange = context.range;
    this.matches = this.findMatches(context.query);
    this.activeIndex = 0;

    if (!this.matches.length) {
      this.hide();
      return;
    }

    this.render();
    this.position();
  };

  onKeydown = event => {
    if (!this.menu || this.menu.hidden) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      this.setActive(this.activeIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      this.setActive(this.activeIndex - 1);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      this.insert(this.matches[this.activeIndex]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      this.hide();
    }
  };

  onBlur = () => {
    window.setTimeout(() => {
      if (this.menu?.matches(":hover")) return;
      this.hide();
    }, 120);
  };

  onDocumentPointerDown = event => {
    if (event.target === this.editor || this.editor.contains(event.target)) return;
    if (this.menu?.contains(event.target)) return;
    this.hide();
  };

  hide = () => {
    this.menu?.remove();
    this.menu = null;
    this.matches = [];
    this.tokenRange = null;
  };

  getTokenContext() {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    if (!this.editor.contains(range.startContainer)) return null;
    if (range.startContainer.nodeType !== Node.TEXT_NODE) return null;

    const beforeCaret = String(range.startContainer.textContent ?? "").slice(0, range.startOffset);
    const match = beforeCaret.match(FORMULA_CONTEXT_PATTERN);
    if (!match) return null;

    const token = match[1] ?? "";
    const tokenRange = document.createRange();
    tokenRange.setStart(range.startContainer, range.startOffset - token.length);
    tokenRange.setEnd(range.startContainer, range.startOffset);
    return {
      query: normalizeSearchText(token),
      range: tokenRange
    };
  }

  findMatches(query) {
    return this.tokens
      .filter(token => token.matches.some(value => value.startsWith(query)))
      .sort((left, right) => left.code.localeCompare(right.code))
      .slice(0, MAX_SUGGESTIONS);
  }

  render() {
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
        this.insert(token);
      });
      this.menu.appendChild(option);
    });

    this.setActive(0);
    this.menu.hidden = false;
  }

  position = () => {
    if (!this.menu) return;
    const selection = window.getSelection();
    const rect = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : this.editor.getBoundingClientRect();
    const fallback = this.editor.getBoundingClientRect();
    const anchor = rect && (rect.width || rect.height) ? rect : fallback;

    this.menu.style.top = `${anchor.bottom + 2}px`;
    const minWidth = 240;
    const maxWidth = Math.max(minWidth, window.innerWidth - (MENU_VIEWPORT_PADDING * 2));
    this.menu.style.minWidth = `${minWidth}px`;
    this.menu.style.maxWidth = `${maxWidth}px`;
    this.menu.style.width = "max-content";

    const width = Math.min(Math.max(this.menu.scrollWidth, minWidth), maxWidth);
    const leftMax = window.innerWidth - width - MENU_VIEWPORT_PADDING;
    const left = Math.min(Math.max(anchor.left, MENU_VIEWPORT_PADDING), leftMax);
    this.menu.style.left = `${Math.max(MENU_VIEWPORT_PADDING, left)}px`;
    this.menu.style.width = `${width}px`;
  };

  setActive(index) {
    if (!this.menu || !this.matches.length) return;
    this.activeIndex = (index + this.matches.length) % this.matches.length;
    for (const option of this.menu.querySelectorAll(".fallout-maw-formula-autocomplete-option")) {
      option.classList.toggle("active", Number(option.dataset.index) === this.activeIndex);
    }
  }

  insert(token) {
    if (!token || !this.tokenRange) return;

    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(this.tokenRange);
    document.execCommand("insertText", false, token.code);
    this.editor.dispatchEvent(new Event("input", { bubbles: true }));
    this.editor.focus();
    this.hide();
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
