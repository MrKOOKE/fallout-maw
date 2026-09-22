export function formatCraftYieldQuantity(quantity, fullQuantity = quantity) {
  return quantity < fullQuantity ? `${quantity}/${fullQuantity}×` : `${quantity}×`;
}

const bounds = nodes => {
  const left = Math.min(...nodes.map(n => n.x - n.width / 2));
  const right = Math.max(...nodes.map(n => n.x + n.width / 2));
  const top = Math.min(...nodes.map(n => n.y - n.height / 2));
  const bottom = Math.max(...nodes.map(n => n.y + n.height / 2));
  return { left, right, top, bottom, x: (left + right) / 2, y: (top + bottom) / 2, width: right - left, height: bottom - top };
};

export function layoutCraftEmbeddedItems(nodes = [], links = [], chips = [], mode = "craft") {
  if (!chips.length) return { nodes, links };
  const result = nodes.map(node => ({ ...node }));
  const root = result.find(node => node.root);
  if (!root) return { nodes, links };
  const failureIds = new Set(links.filter(link => link.failureResult).flatMap(link => [link.fromNodeId, link.toNodeId]).filter(id => id !== root.id));
  const failureBlocks = new Set(result.filter(node => failureIds.has(node.id)).map(node => node.blockId).filter(Boolean));
  const candidates = result.filter(node => !node.root && !node.isToolRequirement && !failureIds.has(node.id) && !failureBlocks.has(node.blockId));
  const target = candidates.sort((a, b) => Math.abs(a.y - root.y) - Math.abs(b.y - root.y))[0];
  const group = target ? result.filter(node => target.blockId ? node.blockId === target.blockId : node.id === target.id) : [];
  const blockId = target?.blockId || "craft-embedded-block";
  const added = chips.map((chip, index) => ({
    id: `craft-embedded-${index}`, blockId, root: false,
    width: Math.max(1, Math.trunc(Number(chip.data?.system?.placement?.width) || 1)),
    height: Math.max(1, Math.trunc(Number(chip.data?.system?.placement?.height) || 1)),
    x: 0, y: 0, name: chip.name, img: chip.img, tooltipUuid: chip.sourceUuid,
    quantity: chip.quantity,
    quantityLabel: mode === "disassembly" ? formatCraftYieldQuantity(chip.quantity) : `${chip.quantity}/${chip.requested}`,
    embedded: true, embeddedOptional: mode !== "disassembly", embeddedEnabled: chip.enabled !== false,
    embeddedKey: chip.key
  }));
  for (const node of group) node.blockId = blockId;
  const original = group.length ? bounds(group) : null;
  const maxWidth = Math.max(6, root.width, original?.width ?? 0, ...added.map(node => node.width));
  const addedWidth = added.reduce((sum, node) => sum + node.width, 0);
  if (original && original.height === Math.max(...group.map(node => node.height)) && original.width + addedWidth <= maxWidth) {
    for (const node of group) node.x -= addedWidth / 2;
    let x = original.right - addedWidth / 2;
    for (const node of added) { node.x = x + node.width / 2; node.y = original.y; x += node.width; }
  } else {
    const rows = [[]];
    let width = 0;
    for (const node of added) {
      if (width && width + node.width > maxWidth) { rows.push([]); width = 0; }
      rows.at(-1).push(node); width += node.width;
    }
    let y = original ? original.bottom : root.y + root.height / 2 + 2;
    for (const row of rows) {
      const height = Math.max(...row.map(node => node.height));
      let x = (original?.x ?? root.x) - row.reduce((sum, node) => sum + node.width, 0) / 2;
      for (const node of row) { node.x = x + node.width / 2; node.y = y + height / 2; x += node.width; }
      y += height;
    }
  }
  const combined = [...group, ...added];
  const extent = bounds(combined);
  const others = result.filter(node => !group.includes(node));
  const overlaps = others.some(node => {
    const b = bounds([node]);
    return extent.left < b.right + 0.5 && extent.right > b.left - 0.5 && extent.top < b.bottom + 0.5 && extent.bottom > b.top - 0.5;
  });
  if (overlaps || (!target && mode !== "disassembly")) {
    const otherBounds = bounds(others);
    const dy = mode === "disassembly" ? otherBounds.bottom + 2 - extent.top : otherBounds.top - 2 - extent.bottom;
    for (const node of combined) node.y += dy;
  }
  return {
    nodes: [...result, ...added],
    links: target ? links : [...links, { id: "craft-embedded-link", fromNodeId: root.id, toNodeId: added[0].id, noCheck: true }]
  };
}
