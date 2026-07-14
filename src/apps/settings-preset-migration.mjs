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
    ui.notifications.warn("Для этого окна не настроена миграция пресетов.");
    return Promise.resolve();
  }
  return openSettingsPresetMigration(app, keys.map(key => `${SYSTEM_ID}.${key}`)).catch(error => {
    console.error(`${SYSTEM_ID} | Settings preset migration failed`, error);
    ui.notifications.error(`Миграция не выполнена: ${error?.message ?? error}`);
  });
}

export async function openSettingsPresetMigration(app, settingIds) {
  const api = CONFIG.FalloutMaW?.settingsPresets;
  if (!api?.list || !api?.get || !api?.migrate) {
    ui.notifications.error("Менеджер пресетов ещё не готов.");
    return;
  }
  const active = await api.active();
  const target = active?.id ? await api.get(active.id) : null;
  if (!target) throw new Error("Активный пресет не найден.");
  const sources = await buildSources(api, target.id);
  if (!sources.length) {
    ui.notifications.warn("Нет другого пресета или сохранённой версии для миграции.");
    return;
  }

  let sourceKey = sources[0].key;
  while (sourceKey) {
    const selected = await chooseSource(sources, sourceKey);
    if (!selected) return;
    sourceKey = selected;
    const source = sources.find(entry => entry.key === sourceKey);
    const result = await compareAndApply(api, target, source, settingIds);
    if (result === "change") continue;
    if (result === "applied") {
      ui.notifications.info("Настройки перенесены в активный пресет.");
      await app.close();
      new app.constructor().render({ force: true });
    }
    return;
  }
}

async function buildSources(api, activeId) {
  const listed = await api.list();
  const result = [];
  for (const row of listed) {
    const preset = await api.get(row.id);
    if (!preset) continue;
    if (preset.id !== activeId) result.push({
      key: `preset:${preset.id}`,
      presetId: preset.id,
      saveId: "",
      name: `${preset.name} — текущая версия`,
      settings: preset.settings ?? []
    });
    for (const save of preset.saves ?? []) result.push({
      key: `save:${preset.id}:${save.id}`,
      presetId: preset.id,
      saveId: save.id,
      name: `${preset.name} / ${save.name} (${formatDate(save.createdAt)})`,
      settings: save.settings ?? []
    });
  }
  return result;
}

async function chooseSource(sources, selected) {
  const options = sources.map(source => `<option value="${escapeAttribute(source.key)}"${source.key === selected ? " selected" : ""}>${escapeHTML(source.name)}</option>`).join("");
  return DialogV2.prompt({
    window: { title: "Источник миграции", icon: "fa-solid fa-code-compare" },
    content: `<label class="form-group"><span>Пресет или его сохранение</span><select name="source">${options}</select></label><p class="hint">Сравнение использует сохранённые настройки. Несохранённые поля открытой формы в него не входят.</p>`,
    ok: { label: "Сравнить", callback: (_event, button) => button.form.elements.source.value },
    rejectClose: false,
    modal: true
  });
}

async function compareAndApply(api, targetPreset, source, settingIds) {
  const targetMap = new Map((targetPreset.settings ?? []).map(entry => [entry.id, entry.value]));
  const sourceMap = new Map((source.settings ?? []).map(entry => [entry.id, entry.value]));
  const ids = settingIds.filter(id => sourceMap.has(id));
  if (!ids.length) {
    ui.notifications.warn("В выбранном источнике нет настроек этого окна.");
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
    rows.push(`<fieldset data-setting="${escapeAttribute(id)}"><legend><label><input type="checkbox" data-whole-setting value="${escapeAttribute(id)}"> ${escapeHTML(id)}</label></legend>${differences.map((difference, index) => `<label class="fallout-maw-migration-row"><input type="checkbox" data-setting-path data-setting-id="${escapeAttribute(id)}" value="${escapeAttribute(difference.pointer)}"><code>${escapeHTML(difference.label || "(всё значение)")}</code><span>${escapeHTML(preview(difference.target))}</span><i class="fa-solid fa-arrow-right"></i><span>${escapeHTML(preview(difference.source))}</span></label>`).join("")}</fieldset>`);
  }
  if (!rows.length) {
    ui.notifications.info("Различий с выбранным источником нет.");
    return "change";
  }
  const result = await migrationDialog(`Сравнение: ${sourceName}`, rows.join(""), form => {
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
    ui.notifications.warn("Не выбраны данные для миграции.");
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
    const status = target.types?.some(entry => entry.id === type.id) ? "заменить" : "добавить";
    return `<label class="fallout-maw-option-row fallout-maw-migration-option-row" data-creature-type-row="${escapeAttribute(type.id)}">
      <input type="checkbox" data-creature-type value="${escapeAttribute(type.id)}">
      <span class="fallout-maw-migration-option-name">${escapeHTML(type.name || type.id)}</span>
      <span class="fallout-maw-migration-count">${raceCount} рас</span>
      <span class="fallout-maw-migration-status">${status}</span>
    </label>`;
  }).join("");
  const raceGroups = types.map(type => {
    const races = (source.races ?? []).filter(race => race.typeId === type.id);
    return `<section class="fallout-maw-migration-race-group" data-creature-race-group="${escapeAttribute(type.id)}">
      <header class="fallout-maw-panel-header"><h3>${escapeHTML(type.name || type.id)}</h3></header>
      <div class="fallout-maw-option-list">${races.map(race => `<label class="fallout-maw-option-row fallout-maw-migration-option-row">
        <input type="checkbox" data-creature-race data-type-id="${escapeAttribute(type.id)}" value="${escapeAttribute(race.id)}">
        <span class="fallout-maw-migration-option-name">${escapeHTML(race.name || race.id)}</span>
        <span class="fallout-maw-migration-status">${target.races?.some(entry => entry.id === race.id) ? "заменить" : "добавить"}</span>
      </label>`).join("") || '<p class="fallout-maw-empty-list">В этом типе нет рас.</p>'}</div>
    </section>`;
  }).join("");
  const body = `<div class="fallout-maw-migration-creatures fallout-maw-two-pane">
    <aside class="fallout-maw-sidebar"><section class="fallout-maw-panel"><header class="fallout-maw-panel-header"><h2>Типы</h2></header><p class="hint">Чекбокс типа выбирает или снимает все его расы.</p><div class="fallout-maw-option-list">${typeRows}</div></section></aside>
    <section class="fallout-maw-panel fallout-maw-migration-race-list"><header class="fallout-maw-panel-header"><h2>Расы</h2></header>${raceGroups}</section>
  </div>`;
  const result = await migrationDialog(`Расы и типы: ${sourceName}`, body, form => {
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
  const body = `<div class="fallout-maw-ability-category-list fallout-maw-migration-ability-list">${(source.categories ?? []).map(category => `<div class="fallout-maw-ability-category-shell" data-migration-ability-category="${escapeAttribute(category.id)}">
    <article class="fallout-maw-panel fallout-maw-ability-category">
      <header class="fallout-maw-ability-category-header">
        <label class="fallout-maw-migration-category-check"><input type="checkbox" data-ability-category value="${escapeAttribute(category.id)}"><strong>${escapeHTML(category.name || category.id)}</strong></label>
        <span class="fallout-maw-migration-count">${category.abilities?.length ?? 0} способностей</span>
      </header>
      <div class="fallout-maw-ability-compact-list">${(category.abilities ?? []).map(ability => `<div class="fallout-maw-ability-compact-row fallout-maw-migration-ability-row">
        <img src="${escapeAttribute(ability.img || "icons/svg/aura.svg")}" alt="">
        <label class="fallout-maw-ability-compact-main"><span>Название</span><input type="text" value="${escapeAttribute(ability.name || ability.id)}" readonly></label>
        <div class="fallout-maw-migration-ability-controls">
          <input type="checkbox" data-ability-id="${escapeAttribute(ability.id)}" data-source-category="${escapeAttribute(category.id)}" title="Перенести способность">
          <span class="fallout-maw-icon-button" aria-hidden="true"><i class="fa-solid fa-arrow-right-arrow-left"></i></span>
          <select data-ability-destination="${escapeAttribute(ability.id)}" title="Целевая категория">${buildAbilityDestinationOptions(target.categories, category)}</select>
        </div>
      </div>`).join("") || '<p class="fallout-maw-empty-list">В категории нет способностей.</p>'}</div>
    </article>
  </div>`).join("")}</div>`;
  const result = await migrationDialog(`Способности: ${sourceName}`, body, form => {
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
    ui.notifications.warn("Не выбраны способности или категории для миграции.");
    return null;
  }
  await api.migrate(result);
  return "applied";
}

async function migrationDialog(title, content, collect, { width = 900, mode = "generic", attach = null } = {}) {
  return DialogV2.wait({
    window: { title, icon: "fa-solid fa-code-compare" },
    classes: ["fallout-maw", "fallout-maw-settings-migration-dialog", `mode-${mode}`],
    content: `<div class="fallout-maw-settings-migration"><p class="hint">Отметьте данные источника, которыми нужно заменить текущие. Неотмеченные значения не меняются.</p>${content}</div>`,
    buttons: [
      { action: "apply", label: "Мигрировать выбранное", default: true, callback: (_event, button) => collect(button.form) },
      { action: "change", label: "Сменить источник", callback: () => "change" },
      { action: "cancel", label: "Отмена", callback: () => false }
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
  for (const master of form?.querySelectorAll("[data-ability-category]") ?? []) {
    const category = master.closest("[data-migration-ability-category]");
    const children = Array.from(category?.querySelectorAll("[data-ability-id]") ?? []);
    master.addEventListener("change", () => {
      for (const child of children) child.checked = master.checked;
      master.indeterminate = false;
    });
    for (const child of children) child.addEventListener("change", () => updateGroupMaster(master, children));
    updateGroupMaster(master, children);
  }
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
function formatDate(value) { try { return new Date(value).toLocaleString(); } catch (_error) { return String(value ?? ""); } }
