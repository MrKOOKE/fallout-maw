/** Keep whole blocks together, filling the earliest row with enough free space. */
export function packInventoryBlockRows(widths, availableWidth, gap = 0) {
  const capacity = Math.max(1, Number(availableWidth) || 1);
  const spacing = Math.max(0, Number(gap) || 0);
  const rows = [];
  return widths.map(value => {
    const width = Math.min(capacity, Math.max(1, Number(value) || 1));
    // Computed styles serialize fractional pixels; flexbox keeps the exact sizes.
    let row = rows.findIndex(used => used + spacing + width <= capacity + 0.05);
    if (row < 0) {
      row = rows.length;
      rows.push(width);
    } else rows[row] += spacing + width;
    return { row, width };
  });
}

/** Display-only packing. Inventory cell coordinates and document order never change. */
export class InventoryBlockLayout {
  #root = null;
  #view = null;
  #observer = null;
  #frame = null;
  #widths = new Map();
  #schedule = () => {
    if (!this.#root || this.#frame !== null) return;
    this.#frame = this.#view.requestAnimationFrame(() => {
      this.#frame = null;
      this.layout();
    });
  };

  bind(root) {
    this.destroy();
    if (!root) return;
    this.#root = root;
    this.#view = root.ownerDocument.defaultView;
    const targets = root.querySelectorAll("[data-inventory-pack], .fallout-maw-slot-card, .fallout-maw-inventory-grid");
    this.#observer = new this.#view.ResizeObserver(entries => {
      if (entries.some(({ target }) => this.#widths.get(target) !== target.clientWidth)) this.#schedule();
    });
    for (const target of targets) {
      this.#widths.set(target, target.clientWidth);
      this.#observer.observe(target);
    }
    root.addEventListener("load", this.#schedule, true);
    root.ownerDocument.fonts?.addEventListener("loadingdone", this.#schedule);
    this.layout();
  }

  layout() {
    if (!this.#root?.isConnected || !this.#root.clientWidth) return;
    const layouts = [...this.#root.querySelectorAll("[data-inventory-pack]")];
    for (const header of this.#root.querySelectorAll("[data-inventory-block-header]")) {
      header.style.removeProperty("min-height");
    }
    // Measure in source order before packing, including nested weapon/seat groups.
    for (const layout of layouts) {
      for (const block of layout.children) {
        block.style.removeProperty("order");
      }
    }
    // Parents precede their nested layouts in document order.
    for (const layout of layouts) {
      const style = this.#view.getComputedStyle(layout);
      const padding = pixels(style.paddingLeft) + pixels(style.paddingRight);
      const border = pixels(style.borderLeftWidth) + pixels(style.borderRightWidth);
      const width = pixels(style.width) - (style.boxSizing === "border-box" ? padding + border : 0);
      if (width <= 0) continue;
      const blocks = [...layout.children];
      const widths = blocks.map(block => {
        const computed = this.#view.getComputedStyle(block);
        const border = pixels(computed.borderLeftWidth) + pixels(computed.borderRightWidth);
        const padding = pixels(computed.paddingLeft) + pixels(computed.paddingRight);
        return pixels(computed.width) + (computed.boxSizing === "border-box" ? 0 : border + padding);
      });
      const placements = packInventoryBlockRows(widths, width, pixels(style.columnGap));
      blocks.forEach((block, index) => {
        // Leave intrinsic sizing to CSS: copying rounded pixel widths back into
        // nested blocks can make an otherwise exact-fit slot wrap to a new line.
        block.style.order = String(placements[index].row);
      });
      // Titles and grids share a baseline within each displayed inventory row,
      // including containers with load meters or names that wrap over several lines.
      const headers = blocks.flatMap(block => {
        const header = block.querySelector(":scope > [data-inventory-block-header]");
        return header ? [{ header, row: block.offsetTop, height: header.offsetHeight }] : [];
      });
      const heights = new Map();
      for (const { row, height } of headers) heights.set(row, Math.max(heights.get(row) ?? 0, height));
      for (const { header, row } of headers) header.style.minHeight = `${heights.get(row)}px`;
    }
    this.#alignSummaryColumns();
    // Ignore resize notifications caused by this layout pass itself.
    for (const target of this.#widths.keys()) this.#widths.set(target, target.clientWidth);
  }

  #alignSummaryColumns() {
    const summary = this.#root.querySelector(".fallout-maw-inventory-summary");
    if (!summary) return;
    summary.style.removeProperty("--fallout-maw-inventory-summary-columns");
    const [currencies, load] = summary.children;
    const flow = this.#root.querySelector(".fallout-maw-equipment-flow");
    const equipment = flow?.firstElementChild;
    if (!currencies || !load || !equipment || currencies.offsetTop !== load.offsetTop) return;
    const neighbor = [...flow.children].find(block => block !== equipment && block.offsetTop === equipment.offsetTop);
    if (!neighbor) return;

    // The slot row is the reference: move only the summary divider above it.
    // Computed CSS pixels stay correct when Foundry scales the whole sheet.
    const style = this.#view.getComputedStyle(equipment);
    const inset = pixels(style.paddingLeft) + pixels(style.paddingRight)
      + pixels(style.borderLeftWidth) + pixels(style.borderRightWidth);
    const width = pixels(style.width) + (style.boxSizing === "border-box" ? 0 : inset);
    summary.style.setProperty("--fallout-maw-inventory-summary-columns", `${width}px minmax(0, 1fr)`);
  }

  destroy() {
    if (this.#frame !== null) this.#view.cancelAnimationFrame(this.#frame);
    this.#observer?.disconnect();
    this.#root?.removeEventListener("load", this.#schedule, true);
    this.#root?.ownerDocument.fonts?.removeEventListener("loadingdone", this.#schedule);
    this.#frame = null;
    this.#observer = null;
    this.#root = null;
    this.#widths.clear();
  }
}

function pixels(value) {
  return Number.parseFloat(value) || 0;
}
