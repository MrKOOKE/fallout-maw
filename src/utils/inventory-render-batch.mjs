const SCROLL_SELECTORS = ".window-content, .tab[data-tab], [data-search-scroll-key], [data-scroll-key]";
const inventoryViews = new Set();
const remoteOperations = new Map();

export function registerInventoryRenderView(view) { inventoryViews.add(view); }
export function unregisterInventoryRenderView(view) { inventoryViews.delete(view); }

/** Runs before Foundry applies descendant changes, on every receiving client. */
export function beginInventoryContentsRender(options = {}) {
  const id = options.falloutMawInventoryOperationId;
  const uuids = options.falloutMawContentsActorUuids;
  if (!id || !Array.isArray(uuids) || !options.falloutMawContentsOperationCount) return;
  let pending = remoteOperations.get(id);
  if (!pending) {
    pending = { batches: [], completed: new Set(), timer: null };
    remoteOperations.set(id, pending);
    for (const view of inventoryViews) {
      if (view.renderBatch.active || !view.zones.some(zone => uuids.includes(zone.actor.uuid))) continue;
      view.renderBatch.begin(view.options.application, {
        before: view.options.beforeTransfer, after: view.options.afterTransfer
      });
      pending.batches.push(view.renderBatch);
    }
  }
  clearTimeout(pending.timer);
  // Release even if Foundry cannot process a later operation in the response.
  pending.timer = setTimeout(() => void finishInventoryContentsRender(id), 2000);
}

export function completeInventoryContentsRender(options = {}) {
  const id = options.falloutMawInventoryOperationId;
  const pending = remoteOperations.get(id);
  if (!pending) return;
  pending.completed.add(options.falloutMawContentsOperationIndex);
  if (pending.completed.size < options.falloutMawContentsOperationCount) return;
  clearTimeout(pending.timer);
  // Let Foundry finish collection callbacks before rendering either actor.
  pending.timer = setTimeout(() => void finishInventoryContentsRender(id), 0);
}

async function finishInventoryContentsRender(id) {
  const pending = remoteOperations.get(id);
  if (!pending) return;
  remoteOperations.delete(id);
  const finished = await Promise.allSettled(pending.batches.map(batch => batch.finish()));
  for (const result of finished) {
    if (result.status === "rejected") console.error("fallout-maw | Inventory window refresh failed", result.reason);
  }
}

/** Hold document- and hook-driven renders until all contents have been attempted. */
export class InventoryRenderBatch {
  active = false;
  #allowRender = false;
  #options = null;
  #application = null;
  #after = null;
  #positions = new Map();

  begin(application, { before, after } = {}) {
    if (this.active || !application) return;
    this.#application = application;
    this.#after = after;
    this.#options = null;
    this.#positions = captureScroll(application.element);
    this.active = true;
    before?.();
  }

  defer(args = []) {
    if (!this.active || this.#allowRender) return false;
    const [first = {}, legacy = {}] = args;
    const options = typeof first === "boolean" ? { ...legacy, force: first } : first;
    const previous = this.#options;
    this.#options = { ...previous, ...options };
    if (previous) {
      if (previous.parts && options.parts) this.#options.parts = [...new Set([...previous.parts, ...options.parts])];
      else delete this.#options.parts;
    }
    return true;
  }

  async finish() {
    if (!this.active) return;
    const application = this.#application;
    try {
      // Closing a loot window during transfer must not open it again.
      if (!application.rendered || !application.element?.isConnected) return;
      this.#allowRender = true;
      let rendering;
      try {
        rendering = application.render({ ...this.#options, force: false });
      } finally {
        this.#allowRender = false;
      }
      await rendering;
      // Run after Foundry's post-render focus and the sheets' own scroll restore.
      const view = application.element?.ownerDocument?.defaultView;
      if (view?.requestAnimationFrame) await new Promise(resolve => view.requestAnimationFrame(resolve));
      restoreScroll(application.element, this.#positions);
    } finally {
      this.active = false;
      this.#options = null;
      this.#positions.clear();
      const after = this.#after;
      this.#application = null;
      this.#after = null;
      after?.();
    }
  }
}

/** Finish every affected window even after an item or another window fails. */
export async function runInventoryRenderBatch(entries, operation) {
  const started = [];
  try {
    for (const { batch, application, before, after } of entries) {
      if (batch.active) continue;
      started.push(batch);
      batch.begin(application, { before, after });
    }
    return await operation();
  } finally {
    const finished = await Promise.allSettled(started.map(batch => batch.finish()));
    for (const result of finished) {
      if (result.status === "rejected") console.error("fallout-maw | Inventory window refresh failed", result.reason);
    }
  }
}

function scrollKey(element) {
  const data = element.dataset;
  if (data.searchScrollKey) return `search:${data.searchScrollKey}`;
  if (data.scrollKey) {
    const actor = element.closest("[data-search-actor-uuid]")?.dataset.searchActorUuid ?? "";
    const tab = element.closest(".tab[data-tab]")?.dataset.tab ?? "";
    return JSON.stringify([actor, tab, data.scrollKey]);
  }
  if (data.tab) return `tab:${data.tab}`;
  return "window-content";
}

function captureScroll(root) {
  return new Map(Array.from(root?.querySelectorAll(SCROLL_SELECTORS) ?? [], element => [
    scrollKey(element), { left: element.scrollLeft, top: element.scrollTop }
  ]));
}

function restoreScroll(root, positions) {
  if (!root?.isConnected) return;
  for (const element of root.querySelectorAll(SCROLL_SELECTORS)) {
    const position = positions.get(scrollKey(element));
    if (!position) continue;
    element.scrollLeft = position.left;
    element.scrollTop = position.top;
  }
}
