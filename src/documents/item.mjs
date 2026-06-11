import {
  getContainerContents,
  getItemContainerParentId,
  getItemTotalWeight,
  isContainerItem
} from "../utils/inventory-containers.mjs";
import { DISEASE_CREATE_OPTION, TRAUMA_CREATE_OPTION } from "../constants.mjs";
import { getCreatureOptions } from "../settings/accessors.mjs";
import { migrateItemData } from "../migrations/documents.mjs";
import { handleItemDamageUpdate } from "../combat/damage-hub.mjs";
import { rewriteItemReferenceData, stampPrototypeUuid } from "../utils/document-references.mjs";
import {
  cleanBooleanSlotSelections,
  getCreatureEquipmentSlotSelectionKeys,
  getCreatureWeaponSlotSelectionKeys
} from "../utils/equipment-slots.mjs";

const MANUALLY_CREATABLE_ITEM_TYPES = Object.freeze(["gear", "ability"]);

export class FalloutMaWItem extends Item {
  static TRAUMA_CREATE_OPTION = TRAUMA_CREATE_OPTION;
  static DISEASE_CREATE_OPTION = DISEASE_CREATE_OPTION;

  static async createDialog(data = {}, createOptions = {}, dialogOptions = {}, renderOptions = {}) {
    const requestedTypes = Array.isArray(dialogOptions.types) ? dialogOptions.types : MANUALLY_CREATABLE_ITEM_TYPES;
    const types = requestedTypes.filter(type => MANUALLY_CREATABLE_ITEM_TYPES.includes(type));
    const createData = foundry.utils.deepClone(data ?? {});
    if (!MANUALLY_CREATABLE_ITEM_TYPES.includes(createData.type)) delete createData.type;
    return super.createDialog(createData, createOptions, {
      ...dialogOptions,
      types: types.length ? types : MANUALLY_CREATABLE_ITEM_TYPES
    }, renderOptions);
  }

  static migrateData(source) {
    source = super.migrateData(source);
    return migrateItemData(source);
  }

  _initializeSource(data, options = {}) {
    if (["weapon", "armor"].includes(data?.type)) {
      data.type = "gear";
    }
    return super._initializeSource(data, options);
  }

  async _preCreate(data, options, user) {
    if ((await super._preCreate(data, options, user)) === false) return false;
    this.updateSource(getCleanSlotRequirementSource(this));
    if (!options?.pack) stampPrototypeUuid(this, data, "Item");
    if (this.type === "trauma" && options?.[TRAUMA_CREATE_OPTION] !== true) {
      ui.notifications?.warn?.("Травмы создаются только системой при получении повреждения.");
      return false;
    }
    if (this.type === "disease" && options?.[DISEASE_CREATE_OPTION] !== true) {
      ui.notifications?.warn?.("Болезни создаются только системой.");
      return false;
    }
    if (this.type === "trauma") {
      this.updateSource({
        system: {
          generated: true
        },
        flags: {
          "fallout-maw": {
            generatedTrauma: true
          }
        }
      });
      return undefined;
    }
    if (this.type === "disease") {
      this.updateSource({
        system: {
          generated: true
        },
        flags: {
          "fallout-maw": {
            generatedDisease: true
          }
        }
      });
      return undefined;
    }
    if (!this.parent) {
      this.updateSource({
        system: {
          equipped: false,
          placement: {
            mode: "inventory",
            equipmentSlot: "",
            weaponSet: "",
            weaponSlot: "",
            limbKey: ""
          }
        }
      });
    }
    if (!this.parent && !options?.pack) {
      const referenceUpdates = rewriteItemReferenceData(this.system ?? {});
      if (!foundry.utils.isEmpty(referenceUpdates)) this.updateSource(referenceUpdates);
    }
    if (isContainerItem(data ?? this)) {
      this.updateSource({
        system: {
          quantity: 1,
          maxStack: 1
        }
      });
    }
    return undefined;
  }

  async _preUpdate(changes, options, user) {
    if ((await super._preUpdate(changes, options, user)) === false) return false;

    const nextSource = foundry.utils.mergeObject(this.toObject(), changes, { inplace: false });
    Object.assign(changes, getSlotRequirementDeletionUpdates(nextSource));
    if (isContainerItem(nextSource)) {
      foundry.utils.setProperty(changes, "system.quantity", 1);
      foundry.utils.setProperty(changes, "system.maxStack", 1);
    }

    if (getItemContainerParentId(nextSource)) {
      foundry.utils.setProperty(changes, "system.equipped", false);
      foundry.utils.setProperty(changes, "system.placement.mode", "inventory");
      foundry.utils.setProperty(changes, "system.placement.equipmentSlot", "");
      foundry.utils.setProperty(changes, "system.placement.weaponSet", "");
      foundry.utils.setProperty(changes, "system.placement.weaponSlot", "");
      foundry.utils.setProperty(changes, "system.placement.limbKey", "");
    }

    return undefined;
  }

  _onUpdate(changes, options, userId) {
    super._onUpdate(changes, options, userId);
    handleItemDamageUpdate(this, changes, options);
  }

  _onCreate(data, options, userId) {
    super._onCreate(data, options, userId);
    handleItemDamageUpdate(this, data, options);
  }

  get isEquipped() {
    return Boolean(this.system?.equipped);
  }

  get isContainer() {
    return isContainerItem(this);
  }

  get containerParentId() {
    return getItemContainerParentId(this);
  }

  get containerContents() {
    return this.actor ? getContainerContents(this, this.actor.items) : [];
  }

  get totalWeight() {
    return getItemTotalWeight(this, this.actor?.items ?? []);
  }
}

function getCleanSlotRequirementSource(itemOrData) {
  const source = itemOrData?.toObject?.() ?? itemOrData ?? {};
  if (!hasSlotRequirementSource(source)) return {};
  const creatureOptions = getCreatureOptions();
  return {
    system: {
      occupiedSlots: cleanBooleanSlotSelections(
        source.system?.occupiedSlots ?? {},
        getCreatureEquipmentSlotSelectionKeys(creatureOptions)
      ),
      weaponSlotRequirement: {
        slots: cleanBooleanSlotSelections(
          source.system?.weaponSlotRequirement?.slots ?? {},
          getCreatureWeaponSlotSelectionKeys(creatureOptions)
        )
      }
    }
  };
}

function getSlotRequirementDeletionUpdates(itemOrData) {
  const source = itemOrData?.toObject?.() ?? itemOrData ?? {};
  if (!hasSlotRequirementSource(source)) return {};
  const creatureOptions = getCreatureOptions();
  const validEquipmentKeys = getCreatureEquipmentSlotSelectionKeys(creatureOptions);
  const validWeaponKeys = getCreatureWeaponSlotSelectionKeys(creatureOptions);
  return {
    ...getSlotRequirementRecordDeletionUpdates("system.occupiedSlots", source.system?.occupiedSlots, validEquipmentKeys),
    ...getSlotRequirementRecordDeletionUpdates("system.weaponSlotRequirement.slots", source.system?.weaponSlotRequirement?.slots, validWeaponKeys)
  };
}

function hasSlotRequirementSource(source = {}) {
  return Boolean(source.system?.occupiedSlots || source.system?.weaponSlotRequirement?.slots);
}

function getSlotRequirementRecordDeletionUpdates(path, slots = {}, validKeys = new Set()) {
  const updates = {};
  for (const [key, selected] of Object.entries(slots ?? {})) {
    if (selected && validKeys.has(key)) continue;
    updates[`${path}.-=${key}`] = null;
  }
  return updates;
}
