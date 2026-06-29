// Small launcher for the generated material migration macros.
// It fetches the large generated scripts from the fallout-maw system folder.

const MATERIAL_IMPORT_STEPS = [
  {
    action: "primary",
    label: "01. Первичные материалы",
    file: "01-import-primary-materials.js"
  },
  {
    action: "secondary",
    label: "02. Вторичные материалы",
    file: "02-import-secondary-materials.js"
  },
  {
    action: "components",
    label: "03. Компоненты материалов",
    file: "03-import-material-components.js"
  }
];

const BASE_PATH = "systems/fallout-maw/scripts/migration-macros/materials";
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const DialogV2 = foundry.applications.api.DialogV2;

const action = await DialogV2.wait({
  window: { title: "Импорт материалов Fallout-MaW" },
  content: "<p>Запускай шаги по порядку. Повторный запуск обновляет уже созданные предметы по флагу миграции.</p>",
  buttons: MATERIAL_IMPORT_STEPS.map((step, index) => ({
    action: step.action,
    label: step.label,
    icon: index === 0 ? "fa-solid fa-seedling" : index === 1 ? "fa-solid fa-cubes-stacked" : "fa-solid fa-gears",
    default: index === 0
  })),
  rejectClose: false,
  position: { width: 420 }
});

const step = MATERIAL_IMPORT_STEPS.find(entry => entry.action === action);
if (step) await runMaterialImportStep(step);

async function runMaterialImportStep(step) {
  const url = `${BASE_PATH}/${step.file}`;
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`Не удалось загрузить ${url}: HTTP ${response.status}`);
  const code = await response.text();
  await new AsyncFunction(code)();
}
