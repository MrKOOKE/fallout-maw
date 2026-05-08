import { TEMPLATES } from "../constants.mjs";
import { getAnimationLibraryIndex } from "../utils/animation-library.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const CONTROL_ID = "fallout-maw-animation-library-browser";
const MAX_VISIBLE_ROWS = 1200;
let hooksRegistered = false;

export function registerAnimationLibraryBrowserHooks() {
  if (hooksRegistered) return;
  Hooks.on("renderSceneControls", injectAnimationLibraryButton);
  hooksRegistered = true;
}

function injectAnimationLibraryButton(_app, element) {
  if (!game.user?.isGM) return;
  const root = element instanceof HTMLElement ? element : element?.[0];
  const menu = root?.matches?.("#scene-controls-layers")
    ? root
    : root?.querySelector("#scene-controls-layers");
  if (!menu || menu.querySelector("[data-fallout-maw-animation-library]")) return;

  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "control ui-control layer icon fa-solid fa-film fallout-maw-animation-library-main-control";
  button.dataset.falloutMawAnimationLibrary = "true";
  button.dataset.tooltip = "";
  button.setAttribute("aria-label", game.i18n.localize("FALLOUTMAW.AnimationLibrary.Title"));
  button.setAttribute("aria-pressed", "false");
  button.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    toggleAnimationLibraryBrowser();
    updateAnimationLibraryButtonState();
  });
  item.append(button);

  const worldTimeItem = menu.querySelector("[data-fallout-maw-world-time-control]")?.closest("li");
  if (worldTimeItem?.nextSibling) worldTimeItem.parentElement.insertBefore(item, worldTimeItem.nextSibling);
  else menu.append(item);
  updateAnimationLibraryButtonState();
}

function toggleAnimationLibraryBrowser() {
  const existing = foundry.applications.instances.get(CONTROL_ID);
  if (existing) return existing.close();
  return new AnimationLibraryBrowser().render({ force: true });
}

function updateAnimationLibraryButtonState() {
  const button = document.querySelector("[data-fallout-maw-animation-library]");
  if (!button) return;
  const active = Boolean(foundry.applications.instances.get(CONTROL_ID)?.rendered);
  button.classList.toggle("active", active);
  button.setAttribute("aria-pressed", String(active));
}

export class AnimationLibraryBrowser extends HandlebarsApplicationMixin(ApplicationV2) {
  #search = "";
  #fileType = "all";
  #showAllRanges = false;
  #showSubLists = false;
  #listView = false;
  #selectedKey = "";
  #selectedEntry = null;
  #libraryGroups = [];
  #openPaths = new Set();

  static DEFAULT_OPTIONS = {
    id: CONTROL_ID,
    classes: ["fallout-maw", "fallout-maw-config-form", "fallout-maw-animation-library-window"],
    position: {
      width: 900,
      height: 450
    },
    window: {
      resizable: true
    },
    actions: {
      refresh: AnimationLibraryBrowser.#onRefresh
    }
  };

  static PARTS = {
    body: {
      template: TEMPLATES.animationLibraryBrowser
    }
  };

  get title() {
    return game.i18n.localize("FALLOUTMAW.AnimationLibrary.Title");
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const index = await getAnimationLibraryIndex();
    this.#libraryGroups = index.groups;
    const view = this.#buildViewRows();

    if (!this.#selectedEntry && view.filteredEntries.length) this.#selectedEntry = preparePreviewEntry(view.filteredEntries[0]);
    if (!this.#selectedKey && this.#selectedEntry) this.#selectedKey = this.#selectedEntry.key;

    return {
      ...context,
      search: this.#search,
      showAllRanges: this.#showAllRanges,
      showSubLists: this.#showSubLists,
      listView: this.#listView,
      fileTypeOptions: buildFileTypeOptions(this.#fileType),
      rows: view.rows,
      selectedEntry: this.#selectedEntry,
      hasSelection: Boolean(this.#selectedEntry),
      rowLimitReached: view.rowLimitReached
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.element?.querySelector("[data-animation-library-search]")?.addEventListener("input", event => {
      this.#search = String(event.currentTarget?.value ?? "");
      this.#refreshEntries();
    });
    this.element?.querySelector("[data-animation-library-file-type]")?.addEventListener("change", event => {
      this.#fileType = String(event.currentTarget?.value ?? "all");
      this.#refreshEntries();
    });
    this.element?.querySelectorAll("[data-animation-library-toggle-option]").forEach(input => {
      input.addEventListener("change", event => this.#onToggleOption(event));
    });
    this.element?.querySelector("[data-animation-library-entries]")?.addEventListener("click", event => this.#onEntriesClick(event));
    this.#positionNearControl();
    updateAnimationLibraryButtonState();
  }

  _onClose(options) {
    super._onClose(options);
    updateAnimationLibraryButtonState();
  }

  #onToggleOption(event) {
    const option = String(event.currentTarget?.dataset?.animationLibraryToggleOption ?? "");
    const checked = Boolean(event.currentTarget?.checked);
    if (option === "allRanges") this.#showAllRanges = checked;
    if (option === "subLists") this.#showSubLists = checked;
    if (option === "listView") this.#listView = checked;
    this.#refreshEntries();
  }

  #onEntriesClick(event) {
    event.preventDefault();
    const actionButton = event.target?.closest?.("[data-animation-library-action]");
    if (actionButton) return this.#onEntryAction(event, actionButton);

    const toggle = event.target?.closest?.("[data-animation-library-tree-toggle]");
    if (toggle) return this.#onTreeToggle(event, toggle);

    const row = event.target?.closest?.("[data-animation-library-select-row]");
    if (!row) return undefined;
    return this.#selectRow(row);
  }

  #onEntryAction(event, button) {
    event.stopPropagation();
    const action = String(button.dataset.animationLibraryAction ?? "");
    if (action === "copyKey") return copyText(button.dataset.key ?? "", event.ctrlKey);
    if (action === "copyPath") return copyText(button.dataset.path ?? "", event.ctrlKey);
    if (action === "playEntry") {
      const row = button.closest("[data-animation-library-select-row]");
      return this.#selectRow(row);
    }
    return undefined;
  }

  #onTreeToggle(event, toggle) {
    event.stopPropagation();
    const path = String(toggle.dataset.animationLibraryTreeToggle ?? "");
    if (!path) return undefined;
    this.#setPathOpen(path, !this.#openPaths.has(path), event.ctrlKey);
    this.#refreshEntries();
  }

  #setPathOpen(path, open, recursive = false) {
    if (open) this.#openPaths.add(path);
    else this.#openPaths.delete(path);
    if (!recursive) return;

    const prefix = `${path}.`;
    for (const existing of Array.from(this.#openPaths)) {
      if (existing.startsWith(prefix)) this.#openPaths.delete(existing);
    }
  }

  #selectRow(row) {
    const key = String(row?.dataset?.animationLibrarySelectRow ?? "");
    const entry = getRenderedEntryFromElement(row);
    if (!key || !entry) return undefined;
    this.#selectedKey = key;
    this.#selectedEntry = preparePreviewEntry(entry);
    this.#updateActiveRow();
    this.#renderPreview();
  }

  static async #onRefresh(event) {
    event.preventDefault();
    await getAnimationLibraryIndex({ refresh: true });
    this.#libraryGroups = [];
    return this.render({ force: true });
  }

  #positionNearControl() {
    const button = document.querySelector("[data-fallout-maw-animation-library]");
    const element = this.element;
    if (!button || !element) return;

    const rect = button.getBoundingClientRect();
    this.setPosition({
      left: Math.round(rect.right + 8),
      top: Math.round(rect.top)
    });
  }

  #buildViewRows() {
    const entries = buildDatabaseEntries(this.#libraryGroups, {
      showAllRanges: this.#showAllRanges,
      showSubLists: this.#showSubLists,
      fileType: this.#fileType
    });
    const filteredEntries = filterEntries(entries, this.#search);
    const treeRows = buildVisibleTreeRows(filteredEntries, {
      openPaths: this.#openPaths,
      search: this.#search
    }).slice(0, MAX_VISIBLE_ROWS);
    const listRows = filteredEntries.slice(0, MAX_VISIBLE_ROWS).map(entry => ({
      ...entry,
      label: entry.key,
      depth: 0,
      hasEntry: true,
      selected: entry.key === this.#selectedKey
    }));
    return {
      filteredEntries,
      rows: prepareRowsForTemplate(this.#listView ? listRows : treeRows, this.#selectedKey),
      rowLimitReached: filteredEntries.length > MAX_VISIBLE_ROWS
    };
  }

  #refreshEntries() {
    const container = this.element?.querySelector("[data-animation-library-entries]");
    if (!container) return;
    const view = this.#buildViewRows();
    container.classList.toggle("tree", !this.#listView);
    container.innerHTML = renderRows(view.rows, view.rowLimitReached);
    if (this.#selectedKey && !view.filteredEntries.some(entry => entry.key === this.#selectedKey)) {
      this.#selectedKey = "";
      this.#selectedEntry = null;
      this.#renderPreview();
    }
  }

  #updateActiveRow() {
    this.element?.querySelectorAll("[data-animation-library-select-row]").forEach(row => {
      row.classList.toggle("active", row.dataset.animationLibrarySelectRow === this.#selectedKey);
    });
  }

  #renderPreview() {
    const entry = this.#selectedEntry;
    const player = this.element?.querySelector("[data-animation-library-player]");
    const metadata = this.element?.querySelector("[data-animation-library-metadata]");
    const previewData = this.element?.querySelector("[data-animation-library-preview-data]");
    if (!player || !metadata || !previewData) return;

    if (!entry) {
      const noFile = escapeHtml(game.i18n.localize("FALLOUTMAW.AnimationLibrary.NoFileLoaded"));
      player.innerHTML = `<div class="fallout-maw-animation-library-no-file">${noFile}</div>`;
      metadata.innerHTML = `<span>${noFile}</span>`;
      previewData.innerHTML = "";
      return;
    }

    player.innerHTML = renderPreviewMedia(entry);
    metadata.innerHTML = `<span>${escapeHtml(game.i18n.localize("FALLOUTMAW.AnimationLibrary.Type"))}: ${escapeHtml(entry.mediaType)}</span>`;
    previewData.innerHTML = renderPreviewData(entry);
  }
}

function buildDatabaseEntries(groups = [], { showAllRanges = false, showSubLists = false, fileType = "all" } = {}) {
  const entries = [];
  for (const group of groups) {
    const groupEntries = getTypedEntries(group.entries, fileType);
    if (!groupEntries.length) continue;

    if (showSubLists) {
      for (const entry of groupEntries) {
        entries.push({
          key: entry.fileKey,
          path: entry.path,
          label: entry.filename,
          mediaType: entry.mediaType,
          previewEntry: entry,
          entries: [entry]
        });
      }
      continue;
    }

    if (!showAllRanges) {
      entries.push({
        key: group.key,
        path: group.representativePath,
        label: group.key.split(".").at(-1) ?? group.key,
        mediaType: getPrimaryMediaType(groupEntries),
        previewEntry: selectPreviewEntry(groupEntries),
        entries: groupEntries
      });
      continue;
    }

    const byDistance = new Map();
    for (const entry of groupEntries) {
      const distanceLabel = entry.distanceLabel || "base";
      if (!byDistance.has(distanceLabel)) byDistance.set(distanceLabel, []);
      byDistance.get(distanceLabel).push(entry);
    }
    for (const [distanceLabel, rangedEntries] of byDistance.entries()) {
      const key = distanceLabel === "base" ? group.key : `${group.key}.${distanceLabel}`;
      const previewEntry = selectPreviewEntry(rangedEntries);
      entries.push({
        key,
        path: previewEntry?.path ?? "",
        label: key.split(".").at(-1) ?? key,
        mediaType: previewEntry?.mediaType ?? getPrimaryMediaType(rangedEntries),
        previewEntry,
        entries: rangedEntries
      });
    }
  }
  return entries.sort((left, right) => left.key.localeCompare(right.key, undefined, { numeric: true }));
}

function filterEntries(entries = [], search = "") {
  const terms = String(search ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return entries;
  return entries.filter(entry => {
    const haystack = [
      entry.key,
      entry.path,
      ...(entry.entries ?? []).map(file => file.path)
    ].join(" ").toLowerCase();
    return terms.every(term => haystack.includes(term));
  });
}

function buildVisibleTreeRows(entries = [], { openPaths = new Set(), search = "" } = {}) {
  const root = createTreeNode("", "", 0);
  const entryByKey = new Map(entries.map(entry => [entry.key, entry]));

  for (const entry of entries) {
    const parts = entry.key.split(".");
    let node = root;
    let path = "";
    for (const part of parts) {
      path = path ? `${path}.${part}` : part;
      if (!node.children.has(part)) node.children.set(part, createTreeNode(part, path, node.depth + 1));
      node = node.children.get(part);
    }
    node.entry = entry;
  }

  const rows = [];
  const hasSearch = Boolean(String(search ?? "").trim());
  for (const child of root.children.values()) appendTreeRows(child, rows, { openPaths, hasSearch, entryByKey });
  return rows;
}

function appendTreeRows(node, rows, { openPaths, hasSearch, entryByKey }) {
  const children = Array.from(node.children.values());
  const hasChildren = children.length > 0;
  const open = hasSearch || openPaths.has(node.fullPath);
  const entry = node.entry ?? entryByKey.get(node.fullPath) ?? null;
  rows.push({
    key: entry?.key ?? node.fullPath,
    label: node.path,
    fullPath: node.fullPath,
    depth: node.depth - 1,
    hasChildren,
    open,
    selected: false,
    path: entry?.path ?? "",
    mediaType: entry?.mediaType ?? "",
    previewEntry: entry?.previewEntry ?? null,
    entries: entry?.entries ?? [],
    hasEntry: Boolean(entry)
  });

  if (!hasChildren || !open) return;
  for (const child of children) appendTreeRows(child, rows, { openPaths, hasSearch, entryByKey });
  rows.push({ separator: true, fullPath: `${node.fullPath}.__separator.${rows.length}` });
}

function prepareRowsForTemplate(rows = [], selectedKey = "") {
  return rows.map(row => {
    if (row.separator) return row;
    return {
      ...row,
      selected: row.key === selectedKey,
      encodedEntry: row.hasEntry || row.previewEntry
        ? encodeURIComponent(JSON.stringify({
          key: row.key,
          path: row.path,
          mediaType: row.mediaType,
          previewEntry: row.previewEntry,
          entries: row.entries
        }))
        : ""
    };
  });
}

function renderRows(rows = [], rowLimitReached = false) {
  const parts = [];
  for (const row of rows) {
    if (row.separator) {
      parts.push(`<div class="fallout-maw-animation-library-separator"></div>`);
      continue;
    }
    parts.push(renderRow(row));
  }
  if (!rows.length) {
    parts.push(`<p class="fallout-maw-empty-list">${escapeHtml(game.i18n.localize("FALLOUTMAW.AnimationLibrary.Empty"))}</p>`);
  }
  if (rowLimitReached) {
    parts.push(`<p class="fallout-maw-empty-list">${escapeHtml(game.i18n.localize("FALLOUTMAW.AnimationLibrary.RowLimit"))}</p>`);
  }
  return parts.join("");
}

function renderRow(row) {
  const active = row.selected ? " active" : "";
  const depth = Number(row.depth) || 0;
  const toggle = row.hasChildren
    ? `<button type="button" class="fallout-maw-animation-tree-toggle" data-animation-library-tree-toggle="${escapeAttribute(row.fullPath)}"><i class="fa-solid ${row.open ? "fa-angle-down" : "fa-angle-right"}"></i></button>`
    : `<span class="fallout-maw-animation-tree-spacer"></span>`;
  const controls = row.hasEntry
    ? [
      `<button type="button" data-animation-library-action="copyPath" data-path="${escapeAttribute(row.path)}" title="${escapeAttribute(game.i18n.localize("FALLOUTMAW.AnimationLibrary.CopyPath"))}"><i class="fa-solid fa-file"></i></button>`,
      `<button type="button" data-animation-library-action="copyKey" data-key="${escapeAttribute(row.key)}" title="${escapeAttribute(game.i18n.localize("FALLOUTMAW.AnimationLibrary.CopyKey"))}"><i class="fa-solid fa-database"></i></button>`,
      `<button type="button" data-animation-library-action="playEntry" title="${escapeAttribute(game.i18n.localize("FALLOUTMAW.AnimationLibrary.PlayPreview"))}"><i class="fa-solid fa-play"></i></button>`
    ].join("")
    : `<span class="fallout-maw-animation-tree-spacer"></span><span class="fallout-maw-animation-tree-spacer"></span><span class="fallout-maw-animation-tree-spacer"></span>`;

  return `<div class="fallout-maw-animation-library-entry${active}" style="--fallout-maw-animation-depth: ${depth};" data-animation-library-select-row="${escapeAttribute(row.key)}" data-animation-library-entry="${escapeAttribute(row.encodedEntry)}">
    <div class="fallout-maw-animation-library-entry-main">
      ${toggle}
      ${controls}
      <div class="fallout-maw-animation-library-entry-text" title="${escapeAttribute(row.key)}"><strong>${escapeHtml(row.label)}</strong></div>
    </div>
  </div>`;
}

function renderPreviewMedia(entry) {
  const path = escapeAttribute(entry.path);
  if (entry.isVideo) return `<video src="${path}" autoplay loop muted controls></video>`;
  if (entry.isImage) return `<img src="${path}">`;
  if (entry.isAudio) return `<audio src="${path}" controls autoplay loop></audio>`;
  return `<div class="fallout-maw-animation-library-no-file">${escapeHtml(game.i18n.localize("FALLOUTMAW.AnimationLibrary.NoFileLoaded"))}</div>`;
}

function renderPreviewData(entry) {
  return `<label>
    <span>${escapeHtml(game.i18n.localize("FALLOUTMAW.AnimationLibrary.Key"))}</span>
    <input type="text" value="${escapeAttribute(entry.key)}" readonly>
  </label>
  <label>
    <span>${escapeHtml(game.i18n.localize("FALLOUTMAW.AnimationLibrary.Path"))}</span>
    <input type="text" value="${escapeAttribute(entry.path)}" readonly>
  </label>`;
}

function createTreeNode(path, fullPath, depth) {
  return {
    path,
    fullPath,
    depth,
    children: new Map(),
    entry: null
  };
}

function getTypedEntries(entries = [], fileType = "all") {
  if (fileType === "all") return entries.filter(entry => !entry.isThumb);
  return entries.filter(entry => entry.mediaType === fileType && !entry.isThumb);
}

function getPrimaryMediaType(entries = []) {
  if (entries.some(entry => entry.mediaType === "video")) return "video";
  if (entries.some(entry => entry.mediaType === "audio")) return "audio";
  if (entries.some(entry => entry.mediaType === "image")) return "image";
  return entries[0]?.mediaType ?? "";
}

function selectPreviewEntry(entries = []) {
  return entries.find(entry => entry.mediaType === "video")
    ?? entries.find(entry => entry.mediaType === "image")
    ?? entries.find(entry => entry.mediaType === "audio")
    ?? entries[0]
    ?? null;
}

function preparePreviewEntry(entry) {
  const preview = entry.previewEntry ?? selectPreviewEntry(entry.entries) ?? entry;
  if (!preview) return null;
  return {
    ...preview,
    key: entry.key,
    path: preview.path ?? entry.path ?? "",
    isVideo: preview.mediaType === "video",
    isImage: preview.mediaType === "image",
    isAudio: preview.mediaType === "audio"
  };
}

function buildFileTypeOptions(selected = "all") {
  return [
    ["all", game.i18n.localize("FALLOUTMAW.AnimationLibrary.All")],
    ["video", game.i18n.localize("FALLOUTMAW.AnimationLibrary.Video")],
    ["audio", game.i18n.localize("FALLOUTMAW.AnimationLibrary.Audio")],
    ["image", game.i18n.localize("FALLOUTMAW.AnimationLibrary.Image")]
  ].map(([value, label]) => ({
    value,
    label,
    selected: value === selected
  }));
}

function getRenderedEntryFromElement(element) {
  const encoded = element?.closest?.("[data-animation-library-entry]")?.dataset?.animationLibraryEntry
    ?? element?.dataset?.animationLibraryEntry
    ?? "";
  if (!encoded) return null;
  try {
    return JSON.parse(decodeURIComponent(encoded));
  } catch (_error) {
    return null;
  }
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

async function copyText(text, quotes = false) {
  let value = String(text ?? "");
  if (!value) return;
  if (quotes) value = `"${value}"`;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const input = document.createElement("input");
  input.value = value;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  document.execCommand("copy");
  input.remove();
}
