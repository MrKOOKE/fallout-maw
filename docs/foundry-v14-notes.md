# Foundry V14 notes

- `system.json` stays in the root of the system folder.
- The system folder name must match the manifest `id`: `fallout-maw`.
- Runtime code is loaded through `system.json -> esmodules`.
- This package targets Foundry generation 14.
- UI code uses Foundry's V2 application architecture from the start.

## V2 application baseline

- Actor sheets use `HandlebarsApplicationMixin(ActorSheetV2)`.
- Item sheets use `HandlebarsApplicationMixin(ItemSheetV2)`.
- Settings apps use `HandlebarsApplicationMixin(ApplicationV2)` through `FalloutMaWFormApplicationV2`.
- Document sheet registration uses `foundry.applications.apps.DocumentSheetConfig.registerSheet`.
- Buttons and clickable UI actions use `data-action` names connected to `static DEFAULT_OPTIONS.actions`.
- Handlebars templates for V2 apps should not wrap their content in another top-level `<form>`.

## Migration priority

1. Test the V2 refactor in Foundry V14.
2. Keep formulas/data/settings independent from sheets.
3. Add automated formula tests once the formula language grows.
4. Expand actor/item sheet parts only inside `templates/actor/parts` and `templates/item`.
5. Add new subsystems as new folders under `src/`, not as extra logic in existing files.
