# Миграция оружия, боеприпасов и снаряжения

Запускайте импорт в порядке: **боеприпасы → оружие → снаряжение**.

- `00-ONE-MACRO-IMPORT-ALL-GEAR.js` — один макрос на всё
- или по отдельности из папок `ammo/`, `weapons/`, `equipment/`

## Быстрая починка уже импортированного оружия

Если оружие уже в мире, но нужно только поправить **анимации**, **звуки** и **заполнить магазин** (без крафтов и полного переимпорта):

1. Запустите макрос **`00-repair-weapon-media.js`** от GM.
2. Он обновит только `system.functions.weapon` / `additionalWeapons`: ключи анимаций `jb2a.*` → `fallout-maw.*`, звуки `icons/Weapon_Sounds` → `audio/Weapon_Sounds`, `magazine.value = magazine.max`.

Перегенерация макроса после обновления системы:

```bash
node scripts/build-jb2a-animation-map.mjs
node scripts/generate-weapon-media-repair-macro.mjs
```
