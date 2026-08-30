import { SYSTEM_ID } from "../constants.mjs";
import { getCoverSettings } from "../settings/accessors.mjs";
import {
  TILE_SPECIAL_PROPERTIES_FLAG,
  TILE_SPECIAL_PROPERTY_COVER,
  TILE_SPECIAL_PROPERTY_PENDING,
  createDefaultTileSpecialPropertyData,
  normalizeTileSpecialProperties
} from "../canvas/tile-cover.mjs";
import {
  TILE_HITBOX_FLAG,
  drawTileHitboxOnCanvas,
  getTileHitbox
} from "../canvas/tile-hitbox.mjs";

const CoreTileConfig = foundry.applications.sheets.TileConfig;
const TILE_ADDITIONAL_TEMPLATE = `systems/${SYSTEM_ID}/templates/scene/parts/tile-additional.hbs`;

export class FalloutMaWTileConfig extends CoreTileConfig {
  static DEFAULT_OPTIONS = foundry.utils.mergeObject(super.DEFAULT_OPTIONS, {
    actions: {
      addTileSpecialProperty: this.#onAddTileSpecialProperty,
      deleteTileSpecialProperty: this.#onDeleteTileSpecialProperty,
      editTileHitbox: this.#onEditTileHitbox,
      clearTileHitbox: this.#onClearTileHitbox
    }
  }, { inplace: false });

  static PARTS = insertPartBeforeFooter(super.PARTS, "additional", {
    template: TILE_ADDITIONAL_TEMPLATE
  });

  static TABS = {
    ...super.TABS,
    sheet: {
      ...super.TABS.sheet,
      tabs: [
        ...super.TABS.sheet.tabs,
        {
          id: "additional",
          icon: "fa-solid fa-gears",
          label: "FALLOUTMAW.Tile.Tabs.Additional"
        }
      ]
    }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const properties = normalizeTileSpecialProperties(
      context.source?.flags?.[SYSTEM_ID]?.[TILE_SPECIAL_PROPERTIES_FLAG]
    );
    const hitbox = getTileHitbox(this.document);
    return Object.assign(context, {
      tileSpecialProperties: properties.map((property, index) => (
        prepareTileSpecialPropertyRow(property, index)
      )),
      canAddTileSpecialProperty: properties.length === 0,
      tileHitboxStatus: getTileHitboxStatus(hitbox),
      hasTileHitbox: Boolean(hitbox),
      canClearTileHitbox: hitbox?.source === "manual"
    });
  }

  _onChangeForm(formConfig, event) {
    super._onChangeForm(formConfig, event);
    if (!event.target?.matches?.("[data-tile-special-property-type]")) return;
    FalloutMaWTileConfig.#onTileSpecialPropertyTypeChange.call(this, event);
  }

  _processFormData(event, form, formData) {
    const data = super._processFormData(event, form, formData);
    data.flags ??= {};
    data.flags[SYSTEM_ID] ??= {};
    data.flags[SYSTEM_ID][TILE_SPECIAL_PROPERTIES_FLAG] = normalizeTileSpecialProperties(
      data.flags[SYSTEM_ID][TILE_SPECIAL_PROPERTIES_FLAG]
    );
    return data;
  }

  static #onAddTileSpecialProperty(event) {
    event.preventDefault();
    const properties = normalizeTileSpecialProperties(this.#getFormTileSpecialProperties());
    if (!properties.length) properties.push(createDefaultTileSpecialPropertyData());
    this.#renderTileSpecialProperties(properties);
  }

  static #onTileSpecialPropertyTypeChange(event) {
    const select = event.target;
    const index = Number(select?.dataset?.tileSpecialPropertyType);
    const properties = normalizeTileSpecialProperties(this.#getFormTileSpecialProperties());
    if (!Number.isInteger(index) || index < 0 || !properties[index]) return;
    properties[index] = createDefaultTileSpecialPropertyData(select.value, properties[index]);
    this.#renderTileSpecialProperties(properties);
  }

  static #onDeleteTileSpecialProperty(event) {
    event.preventDefault();
    const row = event.target.closest("[data-tile-special-property-index]");
    const index = Number(row?.dataset.tileSpecialPropertyIndex);
    const properties = normalizeTileSpecialProperties(this.#getFormTileSpecialProperties());
    if (Number.isInteger(index) && index >= 0) properties.splice(index, 1);
    this.#renderTileSpecialProperties(properties);
  }

  static async #onEditTileHitbox(event) {
    event.preventDefault();
    let tile = this.document;
    if (!isTileOnActiveCanvas(tile)) {
      ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Tile.HitboxUnavailable"));
      return;
    }

    await this.submit({ render: false });
    tile = this.document;
    if (!isTileOnActiveCanvas(tile)) {
      ui.notifications.warn(game.i18n.localize("FALLOUTMAW.Tile.HitboxUnavailable"));
      return;
    }
    await this.close({ animate: false });
    try {
      const hitbox = await drawTileHitboxOnCanvas(tile);
      if (!hitbox) return;
      await tile.setFlag(SYSTEM_ID, TILE_HITBOX_FLAG, hitbox);
      ui.notifications.info(game.i18n.localize("FALLOUTMAW.Tile.HitboxSaved"));
    } catch (error) {
      console.error(`${SYSTEM_ID} | Failed to edit Tile hitbox`, error);
      ui.notifications.error(game.i18n.localize("FALLOUTMAW.Tile.HitboxEditFailed"));
    } finally {
      if (tile.parent) await this.render({ force: true });
    }
  }

  static async #onClearTileHitbox(event) {
    event.preventDefault();
    await this.submit({ render: false });
    await this.document.unsetFlag(SYSTEM_ID, TILE_HITBOX_FLAG);
    await this.render({ force: true });
  }

  #getFormTileSpecialProperties() {
    const formData = new foundry.applications.ux.FormDataExtended(this.form);
    const data = foundry.utils.expandObject(formData.object ?? {});
    return data.flags?.[SYSTEM_ID]?.[TILE_SPECIAL_PROPERTIES_FLAG];
  }

  #renderTileSpecialProperties(properties = []) {
    const container = this.form?.querySelector(".fallout-maw-tile-special-property-list");
    if (!container) return;
    container.innerHTML = properties.length
      ? properties.map((property, index) => renderTileSpecialPropertyRow(property, index)).join("")
      : `<p class="fallout-maw-empty-list">${escapeHtml(game.i18n.localize("FALLOUTMAW.Tile.NoSpecialProperties"))}</p>`;
    const addButton = this.form?.querySelector("[data-action='addTileSpecialProperty']");
    if (addButton) addButton.disabled = properties.length > 0;
  }
}

function getTileHitboxStatus(hitbox) {
  if (!hitbox) return game.i18n.localize("FALLOUTMAW.Tile.HitboxNone");
  const key = hitbox.source === "manual"
    ? "FALLOUTMAW.Tile.HitboxManual"
    : "FALLOUTMAW.Tile.HitboxRimWorld";
  return game.i18n.format(key, { count: hitbox.points.length });
}

function isTileOnActiveCanvas(tile) {
  if (!canvas?.ready || !canvas.scene || !tile?.parent) return false;
  return tile.parent === canvas.scene || tile.parent.id === canvas.scene.id;
}

function insertPartBeforeFooter(parts, id, configuration) {
  const { footer, ...body } = parts;
  return {
    ...body,
    [id]: configuration,
    ...(footer ? { footer } : {})
  };
}

function prepareTileSpecialPropertyRow(property, index) {
  return {
    ...property,
    index,
    isCover: property.type === TILE_SPECIAL_PROPERTY_COVER,
    choices: [
      {
        value: TILE_SPECIAL_PROPERTY_PENDING,
        label: game.i18n.localize("FALLOUTMAW.Tile.ChooseSpecialProperty")
      },
      {
        value: TILE_SPECIAL_PROPERTY_COVER,
        label: game.i18n.localize("FALLOUTMAW.Tile.Cover")
      }
    ].map(choice => ({ ...choice, selected: choice.value === property.type })),
    coverChoices: buildTileCoverChoices(property.coverKey)
  };
}

function buildTileCoverChoices(selected = "") {
  const selectedKey = String(selected ?? "").trim();
  const choices = [{
    value: "",
    label: game.i18n.localize("FALLOUTMAW.Tile.ChooseCover")
  }];
  for (const cover of getCoverSettings().entries) {
    choices.push({
      value: cover.key,
      label: cover.label || cover.key
    });
  }
  if (selectedKey && !choices.some(choice => choice.value === selectedKey)) {
    choices.push({
      value: selectedKey,
      label: game.i18n.format("FALLOUTMAW.Tile.MissingCover", { key: selectedKey })
    });
  }
  return choices.map(choice => ({ ...choice, selected: choice.value === selectedKey }));
}

function renderTileSpecialPropertyRow(property, index) {
  const row = prepareTileSpecialPropertyRow(property, index);
  const propertyOptions = row.choices.map(choice => (
    `<option value="${escapeHtml(choice.value)}" ${choice.selected ? "selected" : ""}>${escapeHtml(choice.label)}</option>`
  )).join("");
  const coverOptions = row.coverChoices.map(choice => (
    `<option value="${escapeHtml(choice.value)}" ${choice.selected ? "selected" : ""}>${escapeHtml(choice.label)}</option>`
  )).join("");
  return `
    <div class="fallout-maw-tile-special-property-row" data-tile-special-property-index="${index}">
      <select name="flags.${SYSTEM_ID}.${TILE_SPECIAL_PROPERTIES_FLAG}.${index}.type" data-tile-special-property-type="${index}">${propertyOptions}</select>
      ${row.isCover ? `<label><span>${escapeHtml(game.i18n.localize("FALLOUTMAW.Tile.CoverType"))}</span><select name="flags.${SYSTEM_ID}.${TILE_SPECIAL_PROPERTIES_FLAG}.${index}.coverKey">${coverOptions}</select></label>` : ""}
      <button type="button" data-action="deleteTileSpecialProperty" title="${escapeHtml(game.i18n.localize("FALLOUTMAW.Common.Delete"))}"><i class="fa-solid fa-trash"></i></button>
    </div>
  `;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
