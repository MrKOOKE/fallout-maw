/** Build both final inventories before committing either side of an exchange. */
export function planEquippedItemSwap({ sourceActor, targetActor, sourceItem, targetItem,
  targetPlacement, resolvePlacement, createTransferTree }) {
  if (sourceActor.uuid === targetActor.uuid || sourceItem.system?.placement?.mode !== "equipment"
    || targetItem.system?.placement?.mode !== "equipment") {
    throw new Error("Обмен требует надетого снаряжения у двух актёров.");
  }
  const sourcePlacement = resolvePlacement(sourceActor, targetItem.toObject(),
    sourceItem.system.placement, [sourceItem.id]);
  const destinationPlacement = resolvePlacement(targetActor, sourceItem.toObject(),
    targetPlacement, [targetItem.id]);
  if (!sourcePlacement || !destinationPlacement) {
    throw new Error("Обмен невозможен: снаряжение не подходит к одному из слотов или занимает другие занятые слоты.");
  }
  const intoSource = createTransferTree(targetActor, sourceActor, targetItem, sourcePlacement);
  const intoTarget = createTransferTree(sourceActor, targetActor, sourceItem, destinationPlacement);
  return {
    targetRootId: intoTarget.rootId,
    plans: [
      { actor: sourceActor, deletes: [sourceItem.id], creates: intoSource.creates,
        expectedItems: sourceActor.items.contents.map(item => item.toObject()) },
      { actor: targetActor, deletes: [targetItem.id], creates: intoTarget.creates,
        expectedItems: targetActor.items.contents.map(item => item.toObject()) }
    ]
  };
}
