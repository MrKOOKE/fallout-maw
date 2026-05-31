# Settings Baseline

Fallout-MaW can turn the current registered system settings into defaults for new worlds.

## Export from Foundry

Open a world as GM and use one of these options:

- Settings > Configure Settings > Fallout-MaW > Settings Baseline > Download JSON.
- Run this in the browser console or a macro:

```js
await CONFIG.FalloutMaW.settingsBaseline.copy();
```

The snapshot includes registered `fallout-maw` world and client settings. It skips only internal migration state by default.

## Bake into the system

Give the exported JSON to Codex or run:

```powershell
node .\scripts\update-settings-baseline.mjs .\path\to\fallout-maw-settings-baseline-world.json
```

This updates `src/settings/baseline-data.mjs`. After that, new worlds use those values as the system defaults because every system setting registration calls `getBaselineDefault(...)`.

Existing worlds keep their saved settings. Foundry only falls back to `default` when a setting document is absent.
