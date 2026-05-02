import { TEMPLATES } from "../constants.mjs";

const { ItemSheetV2 } = foundry.applications.sheets;
const { HandlebarsApplicationMixin } = foundry.applications.api;

export class FalloutMaWItemSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
  static DEFAULT_OPTIONS = {
    classes: ["fallout-maw", "fallout-maw-sheet", "fallout-maw-item-sheet", "sheet", "item"],
    position: {
      width: 620,
      height: "auto"
    },
    window: {
      resizable: true
    }
  };

  static PARTS = {
    body: {
      template: TEMPLATES.itemSheet
    }
  };

  get item() {
    return this.document;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const item = this.item;
    const type = item.type;

    return foundry.utils.mergeObject(context, {
      item,
      system: item.system,
      sourceSystem: item.system?._source ?? item.system,
      owner: item.isOwner,
      editable: this.isEditable,
      itemType: type,
      isGear: type === "gear",
      isWeapon: type === "weapon",
      isArmor: type === "armor",
      isAbility: type === "ability",
      isEffect: type === "effect",
      totalWeight: item.totalWeight
    }, { inplace: false });
  }
}
