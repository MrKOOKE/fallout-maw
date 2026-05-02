# Migration from the current prototype layout

The current public repository already had the right idea: separate folders for apps, config, data models, documents, formulas, settings, sheets, templates, styles, and localization. The main problem was that several files were too broad and the UI was still shaped like a legacy Foundry application stack.

This refactor keeps the existing game concepts and splits them into smaller domains while switching the UI layer to V2 from the beginning.

## Main changes

- `fallout-maw.mjs` was replaced by `src/main.mjs`.
- `module/config.mjs` was split into `src/config/defaults.mjs`, `src/config/system-config.mjs`, and `src/constants.mjs`.
- `module/formulas.mjs` was split into parser, evaluation, and normalization files.
- `module/settings.mjs` was split into setting constants, accessors, creature option normalization, and registration.
- `module/data-models.mjs` was split into actor data models, item data models, resource helpers, and registration.
- `module/documents.mjs` was split into Actor and Item documents.
- `module/sheets.mjs` was split into Actor sheet, Item sheet, and sheet registration.
- Actor and item sheets now use `ActorSheetV2` / `ItemSheetV2`.
- Settings windows now use `ApplicationV2` through `FalloutMaWFormApplicationV2`.
- Actor sheet templates were split into V2 parts.
- Settings templates were converted into form bodies instead of standalone `<form>` documents.
- `package.json` and validation scripts were added so basic mistakes can be caught before opening Foundry.

## Preserved behavior

- Actor types: character, npc, vehicle, hazard.
- Item types: gear, weapon, armor, ability, effect.
- Configurable characteristics, skills, damage types, creature types, and races.
- Formula-based skill values.
- Formula-based action/movement resource maximums.
- Formula-based race damage resistances.
- Actor creation dialog race/type picker.

## Not runtime-tested here

This package was syntax-checked and manifest/localization-checked outside Foundry. It still needs a manual Foundry V14 smoke test:

1. copy the folder to `Data/systems/fallout-maw`;
2. start Foundry V14;
3. create a new world with Fallout-MaW;
4. open each settings menu;
5. create a creature type and race;
6. create a character and check that race defaults and derived values apply;
7. open actor and item sheets and confirm V2 actions, tabs, and image editing work.
