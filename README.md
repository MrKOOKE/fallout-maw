# Fallout-MaW

Fallout-MaW is a Foundry Virtual Tabletop game system focused on configurable automation: creature types, races, characteristics, skills, derived action/movement resources, and damage resistances.

This repository is structured as a long-term codebase, not as a quick prototype. Runtime files remain directly readable by Foundry, so a build step is not required for development.

## Foundry target

The system targets Foundry VTT generation 14 and uses the V2 application stack from the start:

- document sheets extend `ActorSheetV2` / `ItemSheetV2` through `HandlebarsApplicationMixin`;
- settings windows extend `ApplicationV2` through a shared `FalloutMaWFormApplicationV2` base class;
- V2 templates are split into `PARTS` and use `data-action` handlers;
- templates do not contain nested top-level `<form>` tags for V2 applications.

## Development layout

```text
fallout-maw/
├─ system.json                 # Foundry package manifest
├─ src/                        # JavaScript source loaded by Foundry
│  ├─ main.mjs                 # System bootstrap
│  ├─ apps/                    # ApplicationV2 settings/config windows
│  ├─ config/                  # Static defaults and mutable CONFIG bridge
│  ├─ data/                    # Data fields and TypeDataModels
│  ├─ documents/               # Actor/Item document classes
│  ├─ formulas/                # Formula parser, evaluator, normalizers
│  ├─ settings/                # Game setting registration and accessors
│  ├─ sheets/                  # ActorSheetV2/ItemSheetV2 document sheets
│  └─ utils/                   # Shared small helpers
├─ templates/                  # Handlebars templates split by domain and V2 parts
├─ styles/                     # System CSS
├─ lang/                       # Localization dictionaries
├─ docs/                       # Architecture and migration notes
└─ scripts/                    # Local validation scripts
```

## Local checks

The project contains dependency-free validation scripts:

```bash
npm run check
```

The command validates JSON manifests/localization files and runs syntax checks for every `.mjs` file.

## Install for Foundry development

Clone or copy this folder into your Foundry user data directory:

```text
{userData}/Data/systems/fallout-maw/
```

Then start Foundry, create a world with the `Fallout-MaW` system, and open system settings.

## Important rule for future work

Do not place new features directly into `main.mjs`. Add code to the correct domain folder and export it through a small registration function. This keeps the project readable when it becomes large.
