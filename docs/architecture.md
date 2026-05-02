# Fallout-MaW architecture

## Goals

1. Keep Foundry entrypoints tiny.
2. Separate data rules from user interface code.
3. Keep world settings normalized at the boundary.
4. Make formulas testable and independent from sheets.
5. Use Foundry's V2 application/sheet structure from the start.
6. Avoid one-file growth: every new feature must have a clear folder.

## Domains

### `src/main.mjs`

Only bootstraps the system:

- registers document classes;
- registers Actor/Item data models;
- registers V2 document sheets;
- registers settings and V2 settings windows;
- refreshes derived data when Foundry is ready.

### `src/config/`

Contains static defaults and the object exposed as `CONFIG.FalloutMaW`.

### `src/formulas/`

Contains the formula language. UI code may call formula helpers, but formula code must not import sheets or settings applications.

### `src/settings/`

Owns Foundry world settings. All settings are read and written through accessors so normalization happens once.

### `src/data/`

Owns Foundry data fields and TypeDataModels. Data models may read settings to prepare derived actor data, but they should not render UI.

### `src/documents/`

Contains behavior attached to Actor and Item documents: damage application, creation defaults, derived clamping, convenience getters.

### `src/sheets/`

Contains document sheets only. The actor sheet extends `ActorSheetV2`; the item sheet extends `ItemSheetV2`. Sheet code prepares view data and delegates rules to other domains.

Actor sheet templates are split into V2 parts:

```text
templates/actor/parts/
|- header.hbs
|- tabs.hbs
|- inventory-tab.hbs
|- indicators-tab.hbs
`- identity-tab.hbs
```

### `src/apps/`

Contains configuration windows opened from system settings. These extend the shared `FalloutMaWFormApplicationV2` base class, which is an `ApplicationV2` + `HandlebarsApplicationMixin` form application.

Settings app templates are form bodies, not nested forms. The outer form is provided by `ApplicationV2` through `tag: "form"`.

## Adding a new large feature

Create a folder for the domain first. Example for combat automation:

```text
src/combat/
|- initiative.mjs
|- damage-resolution.mjs
|- chat-cards.mjs
`- registration.mjs
```

Then call `registerCombatAutomation()` from `src/main.mjs` or a higher-level registration module. Do not mix combat calculations into sheets.

## UI rule

New windows and sheets should use the V2 pattern by default:

- `static DEFAULT_OPTIONS`, not `static get defaultOptions()`;
- `static PARTS`, not one giant template when the UI is complex;
- `static TABS` for tabbed sheets;
- `data-action="someAction"`, not jQuery listener wiring;
- `_prepareContext()`, not `getData()`;
- `_onRender()`, not `activateListeners()`.
