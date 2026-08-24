# Fallout-MaW calendar build

This directory contains the maintainable TypeScript source for the calendar built
into the `fallout-maw` system. The optimized runtime is emitted to `../calendar`.

```powershell
npm ci
npm run build
```

Do not load files from this directory in Foundry. `system.json` loads only the
compiled `calendar/index.js`, `calendar/styles/calendar.css`, language files, and
templates. All persistent identifiers use the `fallout-maw.calendar.*` setting and
hook namespace; old Simple Calendar identifiers exist only in migration code.
