# Foundry document update regression checks

Run in a script macro after loading the system in Foundry. These checks construct unsaved Actor and Token documents using the real configured document classes and world settings. They do not update world documents, install hooks, or run a collector.

```js
const bench = await import('/systems/fallout-maw/tests/foundry/document-update-benchmark.mjs');
await bench.verify();
await bench.run({counts: [200, 1000], repeats: 5, native: true, includeItemUpdates: false});
await bench.run({counts: [200, 1000], repeats: 5, includeItemUpdates: false});
```

Double-click a result panel to close it. Reload the client after changing system source; a new import query alone does not replace the configured document classes.

`native: true` delegates only the unsaved reference documents' Actor commit and ActorDelta update methods to Foundry's original implementations. It does not change global prototypes. The system's existing rules and other preparations remain active in both runs.

## Results on Foundry 14.361, 2026-09-05

Five timed repetitions after one warm-up per operation, in the same client. Each inventory repeats one actual Gear source from the world. Values are medians in milliseconds, with no socket round-trip, scene rendering, animation, or system event dispatch included.

| Operation | Items | Native | Current |
| --- | ---: | ---: | ---: |
| Actor health updateSource | 200 | 59.0 | 3.6 |
| ActorDelta health updateSource | 200 | 507.0 | 3.8 |
| Token x updateSource | 200 | 0.2 | 0.1 |
| Actor health updateSource | 1000 | 276.7 | 15.8 |
| ActorDelta health updateSource | 1000 | 2514.9 | 15.8 |
| Token x updateSource | 1000 | 0.3 | 0.2 |

The 43 client assertions compare complete source and prepared Actor data, delta source, update diffs, and parent resets with native Foundry. They exercise health/AP/dodge updates, flags, one embedded Item update, deletion fallback, dry-run behavior, and restoration of a manually modified prepared Item field. A separate 48-test focused Node run and the standard `npm run check` (886 tests plus manifest/syntax validation) passed.

## Why the scalar update was expensive

Foundry's client ActorDelta.updateSource first updates its synthetic Actor. Its schema, ActorDeltaField, then calls updateSyntheticActor while committing the delta. This repeats a complete base-Actor/delta merge, creates a new Actor and its Item models, and applies a full replacement update to the existing Actor. The system now omits that repeated callback only for a validated scalar update of an existing, unchanged ActorDelta identity. Embedded updates, deletion/replacement operators, delta materialization, restores, base-Actor changes, and other entry points retain native behavior.

Separately, TypeDataField normally constructs and validates every Item system model during an Actor reset. During a committed scalar Actor system update, those Item sources have not changed. The system resets their existing valid models, retaining all subsequent Item and ActiveEffect initialization and preparation. Unknown or replaced model classes/schemas, direct Item changes, collection changes, and explicit resets use native initialization.

## Limits

These figures measure document operations, not complete attacks or token drags. Full embedded inventory changes remain expensive and are deliberately excluded from the scalar optimization. Movement can spend Actor resources and dispatch reactions beyond the inexpensive coordinate update. The reaction index also now reuses completed participant scans; off-scene, replaced, or dirty participants retain the original fallback scan.

## Native preview construction check

`token-preview-clone.test.mjs` runs in Node with `FALLOUT_MAW_FOUNDRY_CORE` set to the local Foundry `resources/app` directory. It uses the actual common Token/Actor/Item constructors, fields, delta merge and system Item models; the small client ActorDelta construction sequence is reproduced without a canvas. It performs no world database operations.

The visual-copy adapter is limited to Foundry 14.361 and an unchanged, materialized, unlinked canvas Token cloned with exactly `{keepId: true}`. It passes `clean:false` for already cleaned source. Native Actor construction validates the complete embedded field schema. During that synchronous construction, exact child source references reuse this field validation; each Item and model still performs its native joint validation. Copies retain separate sources, models, Items and effects. Ordinary clones, extra clone options, later updates and custom document/model subclasses retain their native validation paths.

Seven fixture checks pass, including full data equivalence for 801 Items, independent mutations, invalid embedded records, error cleanup and subsequent field validation. Common constructor timing was approximately 460–490 ms natively and 64–69 ms with the adapter. These timings exclude client preparation and canvas rendering.

The user's post-fix scene capture (run009, probe revision 6) measured six grabs of the same 801-Item Token at 154.7–162.8 ms. Its two previous grabs were 1071.3–1077.7 ms. This verifies a reduction in synchronous grab cost, not complete smoothness; the remaining 155–163 ms is still a visible stall. No attacks were recorded in run009.

## Token source serialization and diagnostic identity

`token-source-serialization.test.mjs` uses the same local core environment variable and the actual system Token document class. For Foundry 14.361 source serialization with a materialized delta, the adapter omits the first delta copy which native BaseToken discards. It retains native ActorDelta serialization and its optional-field omission. Prepared, lazy, linked, custom document and unsupported-version paths remain native; custom embedded compatibility shims also retain native calls.

Six checks compare complete source, tombstones, effects, independent mutation, compatibility accessors, fallback behavior and 800-Item serialization. A small common-core fixture measured 6.3–8.7 ms natively versus 3.0–4.6 ms with the adapter. This is not a scene measurement.

Run009 also exposed a diagnostic interference: wrapping Token.toObject changed its identity, which correctly made the coordinate-history guard use native history again. Revision 7 times source serialization inline, retaining the method identity and the coordinate-history optimization. Scene fixtures verify the system serializer with active inline diagnostics, custom-serializer fallback and independent undo snapshots. The next user capture must verify both the single-copy and coordinate-history counters and measure damage separately.
