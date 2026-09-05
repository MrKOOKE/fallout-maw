# Foundry 14.361 server performance patch

This local engine adapter addresses two measured costs in fallout-maw:

- `Token.loadRelatedDocuments` cleared and reconstructed the complete delta inventory, then constructed another complete inventory for a synthetic Actor on every request. The adapter retains certified unchanged delta documents, rebuilds changed documents through native initialization, and constructs the separate Actor when a consumer reads it. Load-time snapshots, native ownership checks, collection order, tombstones and source aliases are preserved.
- The server backend assigned `false || undefined` to `writeEmbedded`. The downstream default treated this as `true`, rewriting unchanged embedded documents on coordinate/scalar updates. The patch supplies an actual boolean; embedded changes and adoption still request embedded writes.

The adapter applies only to fallout-maw on Foundry 14.361. The boolean correction applies to the audited native backend. This is a server installation change; reloading the game client alone does not load it. It does not change the world data format.

Revision 2 additionally reuses the adapter's private Item source snapshots when constructing a load-time ActorDelta snapshot. Each unchanged source is still checked against its certificate. Native server Item resets without embedded effects preserve that source; custom reset/field initialization and effect-bearing Items retain fresh copying. New certificates are created after native initialization. Only internal immutable snapshots share objects: synthetic Actor construction still receives deep copies, and later live-source changes cannot alter an earlier unread Actor view.

Eighteen actual server fixture checks pass, including 800 managed Items, raw mutations after loading but before Actor access, custom initializer/serializer fallback, independence of later Actor changes and the native backend persistence path. A memory-only comparison against revision 1 measured approximately 40 ms versus 23 ms for coordinate preparation and 31 ms versus 24 ms after a health update with 800 Items. Actual scene measurements are still required for revision 2.

From the system directory, with the actual Foundry `resources/app` path:

```powershell
node server-patches/install.mjs check 'D:\Foundary\Foundry Virtual Tabletop\resources\app'
node server-patches/install.mjs install 'D:\Foundary\Foundry Virtual Tabletop\resources\app'
```

Fully restart Foundry after installation. The installer checks the build and original SHA-256 hashes, preserves originals in `.fallout-maw-performance-backup-14.361` inside the engine directory, and refuses to replace unrelated modifications. Engine upgrades require a separately reviewed patch for the new build.

To restore the original engine files, then fully restart Foundry:

```powershell
node server-patches/install.mjs uninstall 'D:\Foundary\Foundry Virtual Tabletop\resources\app'
```

Native server equivalence tests use memory-only persistence substitutes; they do not open the user's world databases:

```powershell
$env:FALLOUT_MAW_FOUNDRY_CORE = 'D:\Foundary\Foundry Virtual Tabletop\resources\app'
node --test tests/foundry/server-token-runtime.test.mjs
```

These checks compare native versus adapted source/prepared data and permissions across coordinate updates, damage, Item/ActiveEffect changes, inheritance, tombstones, restoration, source replacement, linked actors and missing base actors. The actual native backend also verifies that scalar writes omit inventory while embedded changes still persist it. Tests use the original backups when run against a patched installation.

Gameplay smoothness still requires an actual post-installation comparison. Passing these tests alone is not evidence that the reported gameplay freezes are resolved.
