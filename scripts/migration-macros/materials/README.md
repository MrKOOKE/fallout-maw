# Fallout-MaW material migration

Use one Foundry script macro: `00-PASTE-INTO-FOUNDRY-MACRO.js`.

That macro loads `00-import-all-materials.js`, so all item ids are known before craft links are rewritten.

Import contents:

1. `01-import-primary-materials.js` - primary materials (168).
2. `02-import-secondary-materials.js` - secondary materials (81) and external dependencies (1).
3. `03-import-material-components.js` - material components (43).

The macro creates or updates world `gear` items, keeps the old id in `fallout-maw.materialMigration.oldId`, adds the material category, and rebuilds craft graphs with the output item in the center and the requirement block above it.

`00-run-material-import-menu.js` is only a debug launcher.
