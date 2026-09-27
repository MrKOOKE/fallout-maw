import { localize as auditLocalize, format as auditFormat } from "../utils/i18n.mjs";
import { SYSTEM_ID } from "../constants.mjs";

const { DialogV2 } = foundry.applications.api;

const APP_SETTINGS = Object.freeze({
  CreatureOptionsConfig: ["creatureOptions"],
  CharacteristicsConfig: ["characteristics"],
  SkillFormulasConfig: ["skillSettings", "skillDevelopmentCosts"],
  LevelSettingsConfig: ["levels"],
  ProficiencySettingsConfig: ["proficiencySettings"],
  DamageTypesConfig: ["damageTypes"],
  AbilitySettingsConfig: ["abilitiesCatalog"],
  TraumaSettingsConfig: ["traumaSettings"],
  DiseaseSettingsConfig: ["diseaseSettings"],
  CraftingSettingsConfig: ["craftingSettings"],
  HackingSettingsConfig: ["hackingSettings"],
  ToolSettingsConfig: ["toolSettings"],
  SystemActionSettingsConfig: ["systemActionSettings"],
  StealthSettingsConfig: ["stealthSettings"],
  CombatSettingsConfig: ["combatSettings"],
  CoverSettingsConfig: ["coverSettings"],
  CampSettingsConfig: ["campSettings"],
  FactionSettingsConfig: ["factionSettings", "factionMatrix"],
  PersonalNameRandomizerConfig: ["personalNameRandomizer"],
  CurrencySettingsConfig: ["currencySettings"],
  ItemCategorySettingsConfig: ["itemCategories"],
  ResourceSettingsConfig: ["resourceSettings"],
  TokenActionHudSettings: ["tokenActionHudDamageIcons", "systemActionSettings"],
  CharacterTokenPrototypeDefaultsConfig: ["tokenPrototypeDefaults"],
  ConstructTokenPrototypeDefaultsConfig: ["tokenPrototypeDefaults"],
  GroupTokenPrototypeDefaultsConfig: ["tokenPrototypeDefaults"],
  GlobalMapTravelSettings: ["globalMapTravelSpeedFormula"]
});

export function openPresetMigrationForApplication(app) {
  const keys = APP_SETTINGS[app.constructor.name];
  if (!keys?.length) {
    ui.notifications.warn(auditLocalize("FALLOUTMAW.AuditApps.PresetMigrationIsNotConfiguredForThisWindow", "Для этого окна не настроена миграция пресетов."));
    return Promise.resolve();
  }
  return openSettingsPresetMigration(app, keys.map(key => `${SYSTEM_ID}.${key}`)).catch(error => {
    console.error(`${SYSTEM_ID} | Settings preset migration failed`, error);
    ui.notifications.error(auditFormat("FALLOUTMAW.AuditApps.MigrationFailed", { v0: (error?.message ?? error) }, "Миграция не выполнена: {v0}"));
  });
}

export async function openSettingsPresetMigration(app, settingIds) {
  const api = CONFIG.FalloutMaW?.settingsPresets;
  if (!api?.migrationSources || !api?.migrate || !api?.status) {
    ui.notifications.error(auditLocalize("FALLOUTMAW.AuditApps.ThePresetManagerIsNotReadyYet", "Менеджер пресетов ещё не готов."));
    return;
  }
  const activeId = String(api.status()?.activePresetId ?? "");
  if (!activeId) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.ActivePresetNotFound", "Активный пресет не найден."));
  const sourceDataPromise = buildSources(api, activeId, settingIds);

  let sourceKey = "";
  while (true) {
    const selected = await chooseSource(sourceDataPromise, sourceKey);
    if (!selected) {
      await sourceDataPromise;
      return;
    }
    const { sources, target } = await sourceDataPromise;
    if (!target) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.ActivePresetNotFound", "Активный пресет не найден."));
    sourceKey = selected;
    const source = sources.find(entry => entry.key === sourceKey);
    if (!source) throw new Error(auditLocalize("FALLOUTMAW.AuditApps.TheSelectedPresetIsNoLongerAvailable", "Выбранный пресет больше недоступен."));
    const result = await compareAndApply(api, target, source, settingIds);
    if (result === "change") continue;
    if (result === "applied") {
      ui.notifications.info(auditLocalize("FALLOUTMAW.AuditApps.SettingsMigratedToTheActivePreset", "Настройки перенесены в активный пресет."));
      await app.close();
      new app.constructor().render({ force: true });
    }
    return;
  }
}

async function buildSources(api, activeId, settingIds) {
  const listed = await api.migrationSources(settingIds);
  const target = listed.find(preset => preset.id === activeId) ?? null;
  const sources = listed
    .filter(preset => preset.id !== activeId)
    .map(preset => ({
      key: `preset:${preset.id}`,
      presetId: preset.id,
      name: preset.name,
      settings: preset.settings ?? []
    }));
  return { sources, target };
}

async function chooseSource(sourceDataPromise, selected) {
  return DialogV2.wait({
    window: { title: auditLocalize("FALLOUTMAW.AuditApps.MigrationSource", "Источник миграции"), icon: "fa-solid fa-code-compare" },
    content: auditLocalize("FALLOUTMAW.AuditApps.PresetLoadingPresetsTheComparisonUsesTheSelected", "<label class=\"form-group\"><span>Пресет</span><select name=\"source\" disabled><option value=\"\">Загрузка пресетов…</option></select></label><p class=\"hint\">Сравнение использует актуальные сохранённые настройки выбранного пресета. Несохранённые поля открытой формы в него не входят.</p>"),
    buttons: [
      { action: "compare", label: auditLocalize("FALLOUTMAW.AuditApps.Compare", "Сравнить"), default: true, callback: (_event, button) => button.form.elements.source.value },
      { action: "cancel", label: auditLocalize("FALLOUTMAW.Common.Cancel", "Отмена"), callback: () => false }
    ],
    render: (_event, dialog) => {
      const form = dialog.element.querySelector("form");
      const select = form?.elements?.source;
      const compare = dialog.element.querySelector('[data-action="compare"]');
      if (compare) compare.disabled = true;
      void sourceDataPromise.then(({ sources }) => {
        if (!sources.length) {
          ui.notifications.warn(auditLocalize("FALLOUTMAW.AuditApps.ThereIsNoOtherPresetToMigrateFrom", "Нет другого пресета для миграции."));
          return dialog.close();
        }
        if (!select) return;
        const nextSelected = sources.some(source => source.key === selected) ? selected : sources[0].key;
        select.innerHTML = sources.map(source => `<option value="${escapeAttribute(source.key)}"${source.key === nextSelected ? " selected" : ""}>${escapeHTML(source.name)}</option>`).join("");
        select.disabled = false;
        if (compare) compare.disabled = false;
      }).catch(error => {
        console.error(`${SYSTEM_ID} | Failed to load migration presets`, error);
        ui.notifications.error(auditFormat("FALLOUTMAW.AuditApps.FailedToLoadPresets", { v0: (error?.message ?? error) }, "Не удалось загрузить пресеты: {v0}"));
        return dialog.close();
      });
    },
    rejectClose: false,
    modal: true,
    position: { width: 520, height: "auto" }
  });
}

async function compareAndApply(api, targetPreset, source, settingIds) {
  const targetMap = new Map((targetPreset.settings ?? []).map(entry => [entry.id, entry.value]));
  const sourceMap = new Map((source.settings ?? []).map(entry => [entry.id, entry.value]));
  const ids = settingIds.filter(id => sourceMap.has(id));
  if (!ids.length) {
    ui.notifications.warn(auditLocalize("FALLOUTMAW.AuditApps.TheSelectedSourceHasNoSettingsForThis", "В выбранном источнике нет настроек этого окна."));
    return "change";
  }
  if (ids.includes(`${SYSTEM_ID}.creatureOptions`)) return compareCreatures(api, targetMap, sourceMap, source.name);
  if (ids.includes(`${SYSTEM_ID}.abilitiesCatalog`)) return compareAbilities(api, targetMap, sourceMap, source.name);
  return compareGeneric(api, ids, targetMap, sourceMap, source.name);
}

async function compareGeneric(api, ids, targetMap, sourceMap, sourceName) {
  const rows = [];
  for (const id of ids) {
    const target = targetMap.get(id);
    const source = sourceMap.get(id);
    const differences = collectDifferences(target, source).slice(0, 2000);
    if (!differences.length) continue;
    rows.push(`<fieldset data-setting="${escapeAttribute(id)}"><legend><label><input type="checkbox" data-whole-setting value="${escapeAttribute(id)}"> ${escapeHTML(id)}</label></legend>${differences.map((difference, index) => `<label class="fallout-maw-migration-row"><input type="checkbox" data-setting-path data-setting-id="${escapeAttribute(id)}" value="${escapeAttribute(difference.pointer)}"><code>${escapeHTML(difference.label || auditLocalize("FALLOUTMAW.AuditApps.EntireValue", "(всё значение)"))}</code><span>${escapeHTML(preview(difference.target))}</span><i class="fa-solid fa-arrow-right"></i><span>${escapeHTML(preview(difference.source))}</span></label>`).join("")}</fieldset>`);
  }
  if (!rows.length) {
    ui.notifications.info(auditLocalize("FALLOUTMAW.AuditApps.ThereAreNoDifferencesFromTheSelectedSource", "Различий с выбранным источником нет."));
    return "change";
  }
  const result = await migrationDialog(auditFormat("FALLOUTMAW.AuditApps.Comparison", { v0: (sourceName) }, "Сравнение: {v0}"), rows.join(""), form => {
    const values = [];
    for (const id of ids) {
      if (!sourceMap.has(id)) continue;
      const whole = Array.from(form.querySelectorAll("[data-whole-setting]"))
        .find(input => input.value === id)?.checked;
      const pointers = Array.from(form.querySelectorAll("[data-setting-path]:checked"))
        .filter(input => input.dataset.settingId === id)
        .map(input => input.value);
      if (whole) values.push({ id, value: clone(sourceMap.get(id)) });
      else if (pointers.length) values.push({ id, value: applyPaths(targetMap.get(id), sourceMap.get(id), pointers) });
    }
    return values;
  });
  if (result === "change" || !result) return result;
  if (!result.length) {
    ui.notifications.warn(auditLocalize("FALLOUTMAW.AuditApps.NoDataSelectedForMigration", "Не выбраны данные для миграции."));
    return null;
  }
  await api.migrate(result);
  return "applied";
}

async function compareCreatures(api, targetMap, sourceMap, sourceName) {
  const id = `${SYSTEM_ID}.creatureOptions`;
  const source = sourceMap.get(id) ?? {};
  const target = targetMap.get(id) ?? { types: [], races: [] };
  const types = source.types ?? [];
  const typeRows = types.map(type => {
    const raceCount = (source.races ?? []).filter(race => race.typeId === type.id).length;
    const status = target.types?.some(entry => entry.id === type.id) ? auditLocalize("FALLOUTMAW.AuditApps.Replace", "заменить") : auditLocalize("FALLOUTMAW.AuditApps.Add", "добавить");
    return auditFormat("FALLOUTMAW.AuditApps.Races", { v0: (escapeAttribute(type.id)), v1: (escapeAttribute(type.id)), v2: (escapeHTML(type.name || type.id)), v3: (raceCount), v4: (status) }, "<label class=\"fallout-maw-option-row fallout-maw-migration-option-row\" data-creature-type-row=\"{v0}\">\n      <input type=\"checkbox\" data-creature-type value=\"{v1}\">\n      <span class=\"fallout-maw-migration-option-name\">{v2}</span>\n      <span class=\"fallout-maw-migration-count\">{v3} рас</span>\n      <span class=\"fallout-maw-migration-status\">{v4}</span>\n    </label>");
  }).join("");
  const raceGroups = types.map(type => {
    const races = (source.races ?? []).filter(race => race.typeId === type.id);
    return `<section class="fallout-maw-migration-race-group" data-creature-race-group="${escapeAttribute(type.id)}">
      <header class="fallout-maw-panel-header"><h3>${escapeHTML(type.name || type.id)}</h3></header>
      <div class="fallout-maw-option-list">${races.map(race => `<label class="fallout-maw-option-row fallout-maw-migration-option-row">
        <input type="checkbox" data-creature-race data-type-id="${escapeAttribute(type.id)}" value="${escapeAttribute(race.id)}">
        <span class="fallout-maw-migration-option-name">${escapeHTML(race.name || race.id)}</span>
        <span class="fallout-maw-migration-status">${target.races?.some(entry => entry.id === race.id) ? auditLocalize("FALLOUTMAW.AuditApps.Replace", "заменить") : auditLocalize("FALLOUTMAW.AuditApps.Add", "добавить")}</span>
      </label>`).join("") || auditLocalize("FALLOUTMAW.AuditApps.ThisTypeHasNoRaces", "<p class=\"fallout-maw-empty-list\">В этом типе нет рас.</p>")}</div>
    </section>`;
  }).join("");
  const body = auditFormat("FALLOUTMAW.AuditApps.TypesATypeSCheckboxSelectsOrDeselects", { v0: (typeRows), v1: (raceGroups) }, "<div class=\"fallout-maw-migration-creatures fallout-maw-two-pane\">\n    <aside class=\"fallout-maw-sidebar\"><section class=\"fallout-maw-panel\"><header class=\"fallout-maw-panel-header\"><h2>Типы</h2></header><p class=\"hint\">Чекбокс типа выбирает или снимает все его расы.</p><div class=\"fallout-maw-option-list\">{v0}</div></section></aside>\n    <section class=\"fallout-maw-panel fallout-maw-migration-race-list\"><header class=\"fallout-maw-panel-header\"><h2>Расы</h2></header>{v1}</section>\n  </div>");
  const result = await migrationDialog(auditFormat("FALLOUTMAW.AuditApps.RacesAndTypes", { v0: (sourceName) }, "Расы и типы: {v0}"), body, form => {
    const wholeTypeIds = new Set(Array.from(form.querySelectorAll("[data-creature-type]:checked"), input => input.value));
    const typeIds = new Set(wholeTypeIds);
    const raceIds = new Set(Array.from(form.querySelectorAll("[data-creature-race]:checked"), input => input.value));
    for (const race of source.races ?? []) if (typeIds.has(race.typeId)) raceIds.add(race.id);
    for (const race of source.races ?? []) if (raceIds.has(race.id)) typeIds.add(race.typeId);
    if (!typeIds.size && !raceIds.size) return [];
    const next = clone(target);
    next.types ??= [];
    next.races ??= [];
    next.races = next.races.filter(race => !wholeTypeIds.has(race.typeId));
    for (const type of source.types ?? []) if (typeIds.has(type.id)) replaceById(next.types, type);
    for (const race of source.races ?? []) if (raceIds.has(race.id)) replaceById(next.races, race);
    return [{ id, value: next }];
  }, {
    width: 1000,
    mode: "creatures",
    attach: activateCreatureGroupSelection
  });
  if (result === "change" || !result) return result;
  if (!result.length) return null;
  await api.migrate(result);
  return "applied";
}

async function compareAbilities(api, targetMap, sourceMap, sourceName) {
  const id = `${SYSTEM_ID}.abilitiesCatalog`;
  const source = sourceMap.get(id) ?? { categories: [] };
  const target = targetMap.get(id) ?? { categories: [] };
  const body = auditFormat("FALLOUTMAW.AuditApps.SelectAll", { v0: ((source.categories ?? []).map(category => auditFormat("FALLOUTMAW.AuditApps.Abilities", { v0: (escapeAttribute(category.id)), v1: (escapeAttribute(category.id)), v2: (escapeHTML(category.name || category.id)), v3: (category.abilities?.length ?? 0), v4: ((category.abilities ?? []).map(ability => auditFormat("FALLOUTMAW.AuditApps.Name", { v0: (escapeAttribute(ability.img || "systems/fallout-maw/assets/System/Abilities/ability-default.webp")), v1: (escapeAttribute(ability.name || ability.id)), v2: (escapeAttribute(ability.id)), v3: (escapeAttribute(category.id)), v4: (escapeAttribute(ability.id)), v5: (buildAbilityDestinationOptions(target.categories, category)) }, "<div class=\"fallout-maw-ability-compact-row fallout-maw-migration-ability-row\">\n        <img src=\"{v0}\" alt=\"\">\n        <label class=\"fallout-maw-ability-compact-main\"><span>Название</span><input type=\"text\" value=\"{v1}\" readonly></label>\n        <div class=\"fallout-maw-migration-ability-controls\">\n          <input type=\"checkbox\" data-ability-id=\"{v2}\" data-source-category=\"{v3}\" title=\"Перенести способность\">\n          <span class=\"fallout-maw-icon-button\" aria-hidden=\"true\"><i class=\"fa-solid fa-arrow-right-arrow-left\"></i></span>\n          <select data-ability-destination=\"{v4}\" title=\"Целевая категория\">{v5}</select>\n        </div>\n      </div>")).join("") || '<p class="fallout-maw-empty-list">В категории нет способностей.</p>') }, "<div class=\"fallout-maw-ability-category-shell\" data-migration-ability-category=\"{v0}\">\n    <article class=\"fallout-maw-panel fallout-maw-ability-category\">\n      <header class=\"fallout-maw-ability-category-header\">\n        <button type=\"button\" class=\"fallout-maw-icon-button\" data-migration-ability-category-toggle aria-expanded=\"false\" title=\"Развернуть категорию\">\n          <i class=\"fa-solid fa-chevron-right\"></i>\n        </button>\n        <label class=\"fallout-maw-migration-category-check\"><input type=\"checkbox\" data-ability-category value=\"{v1}\"><strong>{v2}</strong></label>\n        <span class=\"fallout-maw-migration-count\">{v3} способностей</span>\n      </header>\n      <div class=\"fallout-maw-ability-compact-list\" data-migration-ability-category-body hidden>{v4}</div>\n    </article>\n  </div>")).join("")) }, "<label class=\"fallout-maw-migration-category-check fallout-maw-migration-ability-select-all\">\n    <input type=\"checkbox\" data-ability-select-all>\n    <strong>Выбрать всё</strong>\n  </label>\n  <div class=\"fallout-maw-ability-category-list fallout-maw-migration-ability-list\">{v0}</div>");
  const result = await migrationDialog(auditFormat("FALLOUTMAW.AuditApps.Abilities_985", { v0: (sourceName) }, "Способности: {v0}"), body, form => {
    const next = clone(target);
    next.categories ??= [];
    const wholeCategories = new Set(Array.from(form.querySelectorAll("[data-ability-category]:checked"), input => input.value));
    const selectedAbilities = Array.from(form.querySelectorAll("[data-ability-id]:checked"));
    if (!wholeCategories.size && !selectedAbilities.length) return [];
    for (const category of source.categories ?? []) {
      if (!wholeCategories.has(category.id)) continue;
      const existing = next.categories.find(entry => entry.id === category.id);
      const metadata = { ...clone(category), abilities: existing?.abilities ?? [] };
      replaceById(next.categories, metadata);
    }
    for (const input of selectedAbilities) {
      const abilityId = input.dataset.abilityId;
      const sourceCategory = (source.categories ?? []).find(category => category.id === input.dataset.sourceCategory);
      const ability = sourceCategory?.abilities?.find(entry => entry.id === abilityId);
      const destinationId = Array.from(form.querySelectorAll("[data-ability-destination]"))
        .find(select => select.dataset.abilityDestination === abilityId)?.value;
      if (!ability || !destinationId) continue;
      for (const category of next.categories) category.abilities = (category.abilities ?? []).filter(entry => entry.id !== abilityId);
      let destination = next.categories.find(category => category.id === destinationId);
      if (!destination) {
        const sourceDestination = (source.categories ?? []).find(category => category.id === destinationId);
        if (sourceDestination) {
          destination = { ...clone(sourceDestination), abilities: [] };
          next.categories.push(destination);
        }
      }
      destination?.abilities?.push(clone(ability));
    }
    return [{ id, value: next }];
  }, {
    width: 1120,
    mode: "abilities",
    attach: activateAbilityGroupSelection
  });
  if (result === "change" || !result) return result;
  if (!result.length) {
    ui.notifications.warn(auditLocalize("FALLOUTMAW.AuditApps.NoAbilitiesOrCategoriesSelectedForMigration", "Не выбраны способности или категории для миграции."));
    return null;
  }
  await api.migrate(result);
  return "applied";
}

async function migrationDialog(title, content, collect, { width = 900, mode = "generic", attach = null } = {}) {
  return DialogV2.wait({
    window: { title, icon: "fa-solid fa-code-compare" },
    classes: ["fallout-maw", "fallout-maw-settings-migration-dialog", `mode-${mode}`],
    content: auditFormat("FALLOUTMAW.AuditApps.SelectSourceDataToReplaceTheCurrentValues", { v0: (content) }, "<div class=\"fallout-maw-settings-migration\"><p class=\"hint\">Отметьте данные источника, которыми нужно заменить текущие. Неотмеченные значения не меняются.</p>{v0}</div>"),
    buttons: [
      { action: "apply", label: auditLocalize("FALLOUTMAW.AuditApps.MigrateSelected", "Мигрировать выбранное"), default: true, callback: (_event, button) => collect(button.form) },
      { action: "change", label: auditLocalize("FALLOUTMAW.AuditApps.ChangeSource", "Сменить источник"), callback: () => "change" },
      { action: "cancel", label: auditLocalize("FALLOUTMAW.Common.Cancel", "Отмена"), callback: () => false }
    ],
    render: (_event, dialog) => attach?.(dialog.element.querySelector("form")),
    rejectClose: false,
    modal: true,
    position: { width, height: "auto" }
  });
}

function collectDifferences(target, source, path = []) {
  if (Object.is(target, source)) return [];
  if (isRecord(target) && isRecord(source)) {
    return Object.keys(source).sort().flatMap(key => collectDifferences(target[key], source[key], [...path, key]));
  }
  if (Array.isArray(target) && Array.isArray(source)) {
    return source.flatMap((value, index) => collectDifferences(target[index], value, [...path, String(index)]));
  }
  return [{ pointer: path.map(escapePointer).join("/"), label: formatPath(path), target, source }];
}

function applyPaths(target, source, pointers) {
  if (pointers.includes("")) return clone(source);
  const result = clone(target);
  for (const pointer of pointers) {
    const path = pointer.split("/").map(unescapePointer);
    let targetNode = result;
    let sourceNode = source;
    for (let index = 0; index < path.length - 1; index += 1) {
      const key = path[index];
      sourceNode = sourceNode?.[key];
      if (targetNode[key] === undefined) targetNode[key] = /^\d+$/.test(path[index + 1]) ? [] : {};
      targetNode = targetNode[key];
    }
    const leaf = path.at(-1);
    targetNode[leaf] = clone(sourceNode?.[leaf]);
  }
  return result;
}

function replaceById(collection, value) {
  const index = collection.findIndex(entry => entry.id === value.id);
  if (index < 0) collection.push(clone(value));
  else collection[index] = clone(value);
}

function activateAbilityGroupSelection(form) {
  if (!form) return;
  const selectAll = form.querySelector("[data-ability-select-all]");
  const categoryMasters = Array.from(form.querySelectorAll("[data-ability-category]"));
  const abilityInputs = Array.from(form.querySelectorAll("[data-ability-id]"));
  const updateSelectAll = () => {
    if (!selectAll) return;
    const inputs = [...categoryMasters, ...abilityInputs];
    const selected = inputs.filter(input => input.checked).length;
    selectAll.checked = inputs.length > 0 && selected === inputs.length;
    selectAll.indeterminate = !selectAll.checked
      && (selected > 0 || categoryMasters.some(input => input.indeterminate));
  };

  form.addEventListener("change", event => {
    const input = event.target;
    if (input?.matches?.("[data-ability-select-all]")) {
      for (const target of [...categoryMasters, ...abilityInputs]) {
        target.checked = input.checked;
        target.indeterminate = false;
      }
    } else if (input?.matches?.("[data-ability-category]")) {
      const category = input.closest("[data-migration-ability-category]");
      for (const child of category?.querySelectorAll("[data-ability-id]") ?? []) child.checked = input.checked;
      input.indeterminate = false;
    } else if (input?.matches?.("[data-ability-id]")) {
      const category = input.closest("[data-migration-ability-category]");
      const master = category?.querySelector("[data-ability-category]");
      const children = Array.from(category?.querySelectorAll("[data-ability-id]") ?? []);
      if (master) updateGroupMaster(master, children);
    } else return;
    updateSelectAll();
  });

  form.addEventListener("click", event => {
    const toggle = event.target?.closest?.("[data-migration-ability-category-toggle]");
    if (!toggle || !form.contains(toggle)) return;
    const category = toggle.closest("[data-migration-ability-category]");
    const body = category?.querySelector("[data-migration-ability-category-body]");
    if (!body) return;
    const expanded = body.hidden;
    body.hidden = !expanded;
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.title = expanded ? auditLocalize("FALLOUTMAW.AuditApps.CollapseCategory", "Свернуть категорию") : auditLocalize("FALLOUTMAW.AuditApps.ExpandCategory", "Развернуть категорию");
    const icon = toggle.querySelector("i");
    icon?.classList.toggle("fa-chevron-right", !expanded);
    icon?.classList.toggle("fa-chevron-down", expanded);
  });

  for (const master of categoryMasters) {
    const category = master.closest("[data-migration-ability-category]");
    updateGroupMaster(master, Array.from(category?.querySelectorAll("[data-ability-id]") ?? []));
  }
  updateSelectAll();
}

function activateCreatureGroupSelection(form) {
  for (const master of form?.querySelectorAll("[data-creature-type]") ?? []) {
    const children = Array.from(form.querySelectorAll("[data-creature-race]"))
      .filter(child => child.dataset.typeId === master.value);
    master.addEventListener("change", () => {
      for (const child of children) child.checked = master.checked;
      master.indeterminate = false;
    });
    for (const child of children) child.addEventListener("change", () => updateGroupMaster(master, children));
    updateGroupMaster(master, children);
  }
}

function updateGroupMaster(master, children) {
  if (!children.length) return;
  const selected = children.filter(child => child.checked).length;
  master.checked = selected === children.length;
  master.indeterminate = selected > 0 && selected < children.length;
}

function buildAbilityDestinationOptions(categories = [], sourceCategory = {}) {
  const options = [...categories];
  if (sourceCategory?.id && !options.some(category => category.id === sourceCategory.id)) {
    options.push({ ...sourceCategory, abilities: [] });
  }
  return options.map(category => `<option value="${escapeAttribute(category.id)}"${category.id === sourceCategory?.id ? " selected" : ""}>${escapeHTML(category.name || category.id)}</option>`).join("");
}

function isRecord(value) { return value && typeof value === "object" && !Array.isArray(value); }
function clone(value) { return foundry.utils.deepClone(value); }
function preview(value) { const text = JSON.stringify(value); return text?.length > 120 ? `${text.slice(0, 117)}…` : (text ?? "—"); }
function formatPath(path) { return path.map(part => /^\d+$/.test(part) ? `[${part}]` : part).join(".").replace(".[", "["); }
function escapePointer(value) { return String(value).replaceAll("~", "~0").replaceAll("/", "~1"); }
function unescapePointer(value) { return String(value).replaceAll("~1", "/").replaceAll("~0", "~"); }
function escapeHTML(value) { return foundry.utils.escapeHTML(String(value ?? "")); }
function escapeAttribute(value) { return escapeHTML(value).replaceAll('"', "&quot;"); }
