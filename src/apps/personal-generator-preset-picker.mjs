import { SYSTEM_ID } from "../constants.mjs";
import { PERSONAL_GENERATOR_PRESETS_SETTING } from "../settings/constants.mjs";

const ROOT = "FALLOUTMAW.PersonalGeneratorPresets";

export async function deletePersonalGeneratorPreset(id) {
  if (!game.user?.isGM) throw new Error("Only the GM can delete shared presets.");
  const presets = foundry.utils.deepClone(game.settings.get(SYSTEM_ID, PERSONAL_GENERATOR_PRESETS_SETTING) ?? {});
  delete presets[id];
  await game.settings.set(SYSTEM_ID, PERSONAL_GENERATOR_PRESETS_SETTING, presets);
}

function text(key) {
  return game.i18n.localize(`${ROOT}.${key}`);
}

function escape(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

function searchText(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase(game.i18n.lang).replaceAll("ё", "е");
}

export function renderPersonalGeneratorPresetPicker(presets) {
  return `<div class="fallout-maw-pg-preset-picker">
    <label class="fallout-maw-pg-preset-search">
      <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
      <input type="search" data-pg-preset-search aria-label="${escape(text("Search"))}"
        placeholder="${escape(text("SearchPlaceholder"))}" autocomplete="off">
    </label>
    <div class="fallout-maw-pg-preset-list-heading">
      <span>${escape(text("Preset"))}</span>
      <span data-pg-preset-count role="status" aria-live="polite"></span>
    </div>
    <div class="fallout-maw-pg-preset-list" role="group" aria-label="${escape(text("Preset"))}">
      ${presets.map(preset => `<div class="fallout-maw-pg-preset-row" data-pg-preset-row>
        <label class="fallout-maw-pg-preset-choice">
        <input type="radio" name="presetId" value="${escape(preset.id)}" required>
        <span class="fallout-maw-pg-preset-name">${escape(preset.name)}</span>
        <i class="fa-solid fa-check" aria-hidden="true"></i>
        </label>
        ${game.user?.isGM ? `<button type="button" class="fallout-maw-pg-preset-delete" data-pg-delete-preset
          title="${escape(text("Delete"))}" aria-label="${escape(game.i18n.format(`${ROOT}.DeleteNamed`, { name: preset.name }))}">
          <i class="fa-solid fa-trash" aria-hidden="true"></i>
        </button>` : ""}
      </div>`).join("")}
      <div class="fallout-maw-pg-preset-empty" data-pg-preset-empty hidden>
        <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
        <strong>${escape(text("NoMatches"))}</strong>
        <span>${escape(text("NoMatchesHint"))}</span>
      </div>
    </div>
    <p class="fallout-maw-pg-preset-hint">${escape(text("LoadHint"))}</p>
  </div>`;
}

export function activatePersonalGeneratorPresetPicker(root) {
  const search = root.querySelector("[data-pg-preset-search]");
  const rows = Array.from(root.querySelectorAll("[data-pg-preset-row]"));
  let entries = rows.map(row => ({ row, input: row.querySelector("input"), name: searchText(row.querySelector(".fallout-maw-pg-preset-name").textContent) }));
  let deleting = false;
  const load = root.querySelector('button[data-action="ok"]');
  const count = root.querySelector("[data-pg-preset-count]");
  const empty = root.querySelector("[data-pg-preset-empty]");
  const list = root.querySelector(".fallout-maw-pg-preset-list");
  const syncSelection = () => {
    load.disabled = deleting || !entries.some(({ input }) => !input.disabled && input.checked);
  };
  const filter = () => {
    const words = searchText(search.value).trim().split(/\s+/).filter(Boolean);
    let visible = 0;
    for (const { row, input, name } of entries) {
      const matches = words.every(word => name.includes(word));
      row.hidden = !matches;
      input.disabled = !matches;
      if (!matches) input.checked = false;
      if (matches) visible++;
    }
    count.textContent = game.i18n.format(`${ROOT}.ResultCount`, { count: visible, total: entries.length });
    empty.hidden = visible !== 0;
    empty.querySelector("strong").textContent = text(entries.length ? "NoMatches" : "NoPresets");
    empty.querySelector("span").textContent = text(entries.length ? "NoMatchesHint" : "Empty");
    list.scrollTop = 0;
    syncSelection();
  };
  search.addEventListener("input", filter);
  search.addEventListener("keydown", event => {
    if (event.key === "Escape" && search.value) {
      event.preventDefault();
      event.stopPropagation();
      search.value = "";
      filter();
    } else if (event.key === "ArrowDown") {
      const first = entries.find(({ input }) => !input.disabled);
      if (!first) return;
      event.preventDefault();
      first.input.checked = true;
      first.input.focus();
      syncSelection();
    }
  });
  for (const { row, input } of entries) {
    input.addEventListener("change", syncSelection);
    row.addEventListener("dblclick", event => {
      if (input.disabled || deleting || event.target.closest("[data-pg-delete-preset]")) return;
      input.checked = true;
      syncSelection();
      load.click();
    });
    row.querySelector("[data-pg-delete-preset]")?.addEventListener("click", async event => {
      event.preventDefault();
      event.stopPropagation();
      if (deleting) return;
      deleting = true;
      syncSelection();
      const removeButtons = root.querySelectorAll("[data-pg-delete-preset]");
      removeButtons.forEach(button => { button.disabled = true; });
      try {
        const name = row.querySelector(".fallout-maw-pg-preset-name").textContent;
        const confirmed = await foundry.applications.api.DialogV2.confirm({
          window: { title: `${ROOT}.Delete`, icon: "fa-solid fa-trash" },
          content: `<p>${escape(game.i18n.format(`${ROOT}.DeleteHint`, { name }))}</p>`,
          yes: { label: `${ROOT}.Delete` },
          rejectClose: false,
          modal: true
        });
        if (!confirmed) return;
        await deletePersonalGeneratorPreset(input.value);
        entries = entries.filter(entry => entry.row !== row);
        row.remove();
        const scrollTop = list.scrollTop;
        filter();
        list.scrollTop = scrollTop;
        search.focus();
      } catch (error) {
        console.error("Fallout-MaW | Failed to delete personal generator preset", error);
        ui.notifications.error(text("DeleteError"));
      } finally {
        deleting = false;
        removeButtons.forEach(button => { button.disabled = false; });
        syncSelection();
      }
    });
  }
  // Enter in the search field must not submit an empty or filtered-out selection.
  root.querySelector("form")?.addEventListener("submit", event => {
    if (event.submitter?.dataset.action !== "cancel" && (deleting || !entries.some(({ input }) => !input.disabled && input.checked))) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, { capture: true });
  filter();
  search.focus();
}

export function pickPersonalGeneratorPreset(presets) {
  return foundry.applications.api.DialogV2.prompt({
    window: { title: `${ROOT}.Load`, icon: "fa-solid fa-folder-open", resizable: true },
    classes: ["fallout-maw", "fallout-maw-pg-preset-dialog"],
    position: { width: 760, height: 620 },
    content: renderPersonalGeneratorPresetPicker(presets),
    ok: {
      label: `${ROOT}.Load`,
      disabled: true,
      callback: (_event, button) => button.form.querySelector('input[name="presetId"]:checked:not(:disabled)')?.value ?? null
    },
    buttons: [{ action: "cancel", type: "button", label: "FALLOUTMAW.Common.Cancel", callback: () => null }],
    render: (_event, dialog) => activatePersonalGeneratorPresetPicker(dialog.element),
    rejectClose: false,
    modal: true
  });
}
