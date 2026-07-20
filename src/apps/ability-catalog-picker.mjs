import { getAbilityCatalog } from "../settings/accessors.mjs";
import { findCatalogAbility } from "../abilities/purchase.mjs";

const { DialogV2 } = foundry.applications.api;

/**
 * Open a multi-select ability catalog picker grouped by category.
 * @param {object} [options]
 * @param {string[]} [options.selectedIds]
 * @param {string[]} [options.excludeIds]
 * @param {string} [options.title]
 * @returns {Promise<string[]|null>} Selected ability ids, or null if cancelled.
 */
export async function pickCatalogAbilities({
  selectedIds = [],
  excludeIds = [],
  title = "Выбор способностей"
} = {}) {
  const exclude = new Set((excludeIds ?? []).map(id => String(id ?? "").trim()).filter(Boolean));
  const initialSelected = new Set(
    (selectedIds ?? [])
      .map(id => String(id ?? "").trim())
      .filter(id => id && !exclude.has(id))
  );
  const categories = buildPickerCategories(exclude);
  if (!categories.length) {
    ui.notifications.warn("В каталоге нет доступных способностей.");
    return null;
  }

  const content = `
    <div class="fallout-maw-ability-catalog-picker">
      <label class="fallout-maw-ability-catalog-picker-search">
        <span>Поиск</span>
        <input type="search" data-ability-picker-search placeholder="Название способности..." autocomplete="off">
      </label>
      <div class="fallout-maw-ability-catalog-picker-list" data-ability-picker-list>
        ${categories.map(category => renderPickerCategory(category, initialSelected)).join("")}
      </div>
    </div>
  `;

  return DialogV2.wait({
    window: { title, icon: "fa-solid fa-list-check" },
    classes: ["fallout-maw", "fallout-maw-ability-catalog-picker-dialog"],
    content,
    buttons: [
      {
        action: "confirm",
        label: "Подтвердить",
        default: true,
        callback: (_event, button) => collectSelectedAbilityIds(button.form)
      },
      {
        action: "cancel",
        label: "Отмена",
        callback: () => null
      }
    ],
    render: (_event, dialog) => activateAbilityCatalogPicker(dialog.element?.querySelector?.("form") ?? dialog.element),
    rejectClose: false,
    modal: true,
    position: { width: 720, height: "auto" }
  });
}

export function resolveCatalogAbilityEntries(abilityIds = []) {
  return (abilityIds ?? [])
    .map(id => String(id ?? "").trim())
    .filter(Boolean)
    .map(id => {
      const entry = findCatalogAbility(id);
      return {
        id,
        name: entry?.ability?.name || id,
        img: entry?.ability?.img || "icons/svg/aura.svg",
        categoryId: entry?.category?.id ?? "",
        categoryName: entry?.category?.name ?? ""
      };
    });
}

function buildPickerCategories(exclude = new Set()) {
  const catalog = getAbilityCatalog();
  return (catalog.categories ?? [])
    .map(category => {
      const abilities = (category.abilities ?? [])
        .filter(ability => {
          const id = String(ability?.id ?? "").trim();
          return id && !exclude.has(id);
        })
        .map(ability => ({
          id: ability.id,
          name: String(ability?.name ?? "").trim() || ability.id,
          img: ability?.img || "icons/svg/aura.svg"
        }))
        .sort((left, right) => left.name.localeCompare(right.name, "ru", { sensitivity: "base" }));
      return {
        id: category.id,
        name: String(category?.name ?? "").trim() || category.id,
        abilities
      };
    })
    .filter(category => category.abilities.length);
}

function renderPickerCategory(category, selected = new Set()) {
  return `
    <section class="fallout-maw-ability-catalog-picker-category" data-ability-picker-category="${escapeAttribute(category.id)}">
      <header class="fallout-maw-ability-catalog-picker-category-header">
        <strong>${escapeHtml(category.name)}</strong>
        <span data-ability-picker-category-count>${category.abilities.length}</span>
      </header>
      <div class="fallout-maw-ability-catalog-picker-abilities">
        ${category.abilities.map(ability => `
          <label class="fallout-maw-ability-catalog-picker-row" data-ability-picker-row data-ability-search-text="${escapeAttribute(`${ability.name} ${category.name}`)}">
            <input type="checkbox" data-ability-picker-id value="${escapeAttribute(ability.id)}" ${selected.has(ability.id) ? "checked" : ""}>
            <img src="${escapeAttribute(ability.img)}" alt="">
            <span>${escapeHtml(ability.name)}</span>
          </label>
        `).join("")}
      </div>
    </section>
  `;
}

function activateAbilityCatalogPicker(root) {
  if (!root) return;
  const search = root.querySelector("[data-ability-picker-search]");
  const applyFilter = () => {
    const query = String(search?.value ?? "").trim().toLocaleLowerCase("ru");
    root.querySelectorAll("[data-ability-picker-category]").forEach(category => {
      let visibleCount = 0;
      category.querySelectorAll("[data-ability-picker-row]").forEach(row => {
        const haystack = String(row.dataset.abilitySearchText ?? "").toLocaleLowerCase("ru");
        const visible = !query || haystack.includes(query);
        row.hidden = !visible;
        if (visible) visibleCount += 1;
      });
      category.hidden = visibleCount === 0;
      const count = category.querySelector("[data-ability-picker-category-count]");
      if (count) count.textContent = String(visibleCount);
    });
  };
  search?.addEventListener("input", applyFilter);
  applyFilter();
}

function collectSelectedAbilityIds(form) {
  return Array.from(form?.querySelectorAll("[data-ability-picker-id]:checked") ?? [])
    .map(input => String(input.value ?? "").trim())
    .filter(Boolean);
}

function escapeHtml(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('"', "&quot;");
}
