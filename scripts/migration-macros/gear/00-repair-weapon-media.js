// Быстрая починка оружия: анимации, звуки, заполнение магазина.
// Не трогает крафты и не пересоздаёт предметы.
// Сгенерировано: 2026-06-30T18:21:14.442Z

const SYSTEM_ID = "fallout-maw";
const FLAG_SCOPE = "fallout-maw";
const WEAPON_FLAG_KEY = "weaponMigration";

const JB2A_ANIMATION_MAP = {
  "jb2a.bolt.physical.white02": "fallout-maw.generic.weapon_attacks.ranged.bolt01_01_regular_white_physical",
  "jb2a.chain_lightning": "fallout-maw.6th_level.chain_lightning.chain_lightning_01_regular_blue_primary",
  "jb2a.explosion.01": "fallout-maw.3rd_level.fireball.fireball_explosion_01_blue",
  "jb2a.explosion.07.bluewhite": "fallout-maw.generic.explosion.explosion_07_blue_white",
  "jb2a.hammer.melee": "fallout-maw.generic.weapon_attacks.melee.hammer01_01_regular_white",
  "jb2a.hammer.throw": "fallout-maw.generic.weapon_attacks.ranged.hammer01_01_regular_white",
  "jb2a.handaxe.throw.01": "fallout-maw.generic.weapon_attacks.ranged.handaxe01_01_regular_white",
  "jb2a.impact.005.orange": "fallout-maw.generic.impact.impact_05_regular_orange",
  "jb2a.impact.010.orange": "fallout-maw.generic.impact.impact_05_regular_orange",
  "jb2a.lasershot.green": "fallout-maw.generic.weapon_attacks.ranged.laser_shot_01_regular_green",
  "jb2a.arrow.physical.white.02": "fallout-maw.generic.weapon_attacks.ranged.arrow02_01_regular_white_physical",
  "jb2a.bolt.physical.white.90ft": "fallout-maw.generic.weapon_attacks.ranged.bolt01_01_regular_white_physical",
  "jb2a.breath_weapons.fire.cone.blue.02": "fallout-maw.generic.template.cone.breath_weapon.breath_weapon_fire02_regular_blue_cone_burst",
  "jb2a.breath_weapons02.burst.cone.fire.green.02": "fallout-maw.generic.template.cone.breath_weapon.breath_weapon_fire02_regular_green_cone_burst",
  "jb2a.breath_weapons02.burst.cone.fire.orange.01": "fallout-maw.generic.template.cone.breath_weapon.breath_weapon_fire01_regular_orange_cone_burst",
  "jb2a.breath_weapons02.burst.cone.fire.orange.02": "fallout-maw.generic.template.cone.breath_weapon.breath_weapon_fire02_regular_orange_cone_burst",
  "jb2a.breath_weapons02.burst.line.fire.orange.01": "fallout-maw.generic.template.line.breath_weapon.breath_weapon_fire01_regular_orange_line_burst",
  "jb2a.bullet.01.blue": "fallout-maw.generic.weapon_attacks.ranged.bullet_01_regular_blue",
  "jb2a.bullet.01.orange": "fallout-maw.generic.weapon_attacks.ranged.bullet_01_regular_orange",
  "jb2a.bullet.01.orange.90ft": "fallout-maw.generic.weapon_attacks.ranged.bullet_01_regular_orange",
  "jb2a.bullet.02.blue": "fallout-maw.generic.weapon_attacks.ranged.bullet_02_regular_blue",
  "jb2a.bullet.02.green": "fallout-maw.generic.weapon_attacks.ranged.bullet_02_regular_green",
  "jb2a.bullet.02.orange": "fallout-maw.generic.weapon_attacks.ranged.bullet_02_regular_orange",
  "jb2a.bullet.02.red": "fallout-maw.generic.weapon_attacks.ranged.bullet_02_regular_red",
  "jb2a.bullet.03.blue": "fallout-maw.generic.weapon_attacks.ranged.bullet_03_regular_blue",
  "jb2a.bullet.03.purple": "fallout-maw.generic.weapon_attacks.ranged.bullet_03_regular_purple",
  "jb2a.bullet.snipe.blue": "fallout-maw.generic.weapon_attacks.ranged.snipe_01_regular_blue",
  "jb2a.bullet.snipe.green": "fallout-maw.generic.weapon_attacks.ranged.snipe_01_regular_green",
  "jb2a.bullet.snipe.purple": "fallout-maw.generic.weapon_attacks.ranged.snipe_01_regular_purple",
  "jb2a.bullet.snipe.red": "fallout-maw.generic.weapon_attacks.ranged.snipe_01_regular_red",
  "jb2a.chain_lightning.primary.blue": "fallout-maw.6th_level.chain_lightning.chain_lightning_01_regular_blue_primary",
  "jb2a.chain_lightning.primary.blue02": "fallout-maw.6th_level.chain_lightning.chain_lightning_01_regular_blue02_primary",
  "jb2a.chain_lightning.primary.yellow": "fallout-maw.6th_level.chain_lightning.chain_lightning_01_regular_yellow_primary",
  "jb2a.club.melee.01.blue": "fallout-maw.generic.weapon_attacks.melee.group01.melee_attack01_magic_sword02_01_regular_blue",
  "jb2a.cone_of_cold.blue": "fallout-maw.5th_level.cone_of_cold.cone_of_cold_01_regular_blue",
  "jb2a.dagger.melee.02.white": "fallout-maw.generic.weapon_attacks.melee.dagger02_01_regular_white",
  "jb2a.dagger.melee.fire.blue": "fallout-maw.generic.weapon_attacks.melee.dagger02_fire_regular_blue",
  "jb2a.dagger.melee.fire.green": "fallout-maw.generic.weapon_attacks.melee.dagger02_fire_regular_green",
  "jb2a.dagger.throw.01.white": "fallout-maw.generic.weapon_attacks.melee.dagger02_01_regular_white",
  "jb2a.electric_arc.blue02.04": "fallout-maw.generic.lightning.electric_arc04_01_regular_blue02",
  "jb2a.energy_wall.01.25x05ft.01.loop.blue": "fallout-maw.generic.energy.energy_wall01_01_regular_blue_25x05ft_loop",
  "jb2a.explosion.01.orange": "fallout-maw.generic.weapon_attacks.melee.group01.melee_attack01_magic_sword02_01_regular_orange",
  "jb2a.explosion.02.green": "fallout-maw.generic.explosion.explosion_02_green",
  "jb2a.explosion.08.dark_orange": "fallout-maw.generic.explosion.explosion_05_dark_orange",
  "jb2a.falchion.melee.01.white": "fallout-maw.generic.weapon_attacks.melee.falchion01_01_regular_white",
  "jb2a.fire_bolt.blue": "fallout-maw.cantrip.fire_bolt.fire_bolt_01_regular_blue",
  "jb2a.fire_bolt.green": "fallout-maw.cantrip.fire_bolt.fire_bolt_01_dark_green02",
  "jb2a.fire_bolt.orange": "fallout-maw.cantrip.fire_bolt.fire_bolt_01_regular_orange",
  "jb2a.fire_bolt.purple": "fallout-maw.cantrip.fire_bolt.fire_bolt_01_regular_purple",
  "jb2a.glaive.melee.02.white": "fallout-maw.generic.weapon_attacks.melee.glaive01_02_regular_white",
  "jb2a.greataxe.melee.fire.blue": "fallout-maw.generic.weapon_attacks.melee.great_axe01_fire_regular_blue",
  "jb2a.greatsword.melee.fire.blue": "fallout-maw.generic.weapon_attacks.melee.great_sword01_fire_regular_blue",
  "jb2a.greatsword.melee.standard.white": "fallout-maw.generic.weapon_attacks.melee.great_sword01_01_regular_white",
  "jb2a.hammer.melee.01.blue": "fallout-maw.generic.weapon_attacks.melee.group01.melee_attack01_magic_sword02_01_regular_blue",
  "jb2a.hammer.melee.01.orange": "fallout-maw.generic.weapon_attacks.melee.group01.melee_attack01_magic_sword02_01_regular_orange",
  "jb2a.hammer.melee.01.white": "fallout-maw.generic.weapon_attacks.melee.group01.melee_attack01_butterfly_sword01_01",
  "jb2a.handaxe.melee.fire.blue": "fallout-maw.generic.weapon_attacks.melee.hand_axe02_fire_regular_blue",
  "jb2a.handaxe.melee.fire.dark_purple": "fallout-maw.generic.weapon_attacks.melee.hand_axe02_fire_dark_purple",
  "jb2a.handaxe.melee.standard.white": "fallout-maw.generic.weapon_attacks.melee.hand_axe02_01_regular_white",
  "jb2a.lightning_bolt.narrow.blue": "fallout-maw.3rd_level.lightning_bolt.lightning_bolt_01_dark_blue",
  "jb2a.lightning_strike.blue": "fallout-maw.generic.lightning.lightning_strike01_01_regular_blue",
  "jb2a.mace.melee.01.white": "fallout-maw.generic.weapon_attacks.melee.group01.melee_attack01_butterfly_sword01_01",
  "jb2a.magic_missile.blue": "fallout-maw.1st_level.magic_missile.magic_missile_01_regular_blue_01",
  "jb2a.maul.melee.fire.blue": "fallout-maw.generic.weapon_attacks.melee.maul01_fire_regular_blue",
  "jb2a.maul.melee.fire.red": "fallout-maw.generic.weapon_attacks.melee.maul01_fire_regular_red",
  "jb2a.maul.melee.standard.white": "fallout-maw.generic.weapon_attacks.melee.maul01_01_regular_white",
  "jb2a.melee_attack.01.butterflysword.01": "fallout-maw.generic.weapon_attacks.melee.group01.melee_attack01_butterfly_sword01_01",
  "jb2a.melee_attack.01.shortsword.01": "fallout-maw.generic.weapon_attacks.melee.group01.melee_attack01_short_sword01_01",
  "jb2a.melee_attack.01.sickle.01": "fallout-maw.generic.weapon_attacks.melee.group01.melee_attack01_sickle01_01",
  "jb2a.melee_attack.02.club.01": "fallout-maw.generic.weapon_attacks.melee.group02.melee_attack02_club01_01",
  "jb2a.melee_attack.02.hammer": "fallout-maw.generic.weapon_attacks.melee.group02.melee_attack02_hammer01_01",
  "jb2a.melee_attack.02.handaxe.01": "fallout-maw.generic.weapon_attacks.melee.group02.melee_attack02_hand_axe01_01",
  "jb2a.melee_attack.02.trail.01.blueyellow": "fallout-maw.generic.weapon_attacks.melee.group02.trail_attack02_01_01_regular_blue_yellow",
  "jb2a.melee_attack.03.greataxe.01": "fallout-maw.generic.weapon_attacks.melee.group03.melee_attack03_great_axe01_01",
  "jb2a.melee_attack.03.greatclub.01": "fallout-maw.generic.weapon_attacks.melee.group03.melee_attack03_great_club01_01",
  "jb2a.melee_attack.03.trail.01.orangered": "fallout-maw.generic.weapon_attacks.melee.group03.trail_attack03_01_01_regular_orange_red",
  "jb2a.melee_attack.04.katana.01": "fallout-maw.generic.weapon_attacks.melee.group04.melee_attack04_katana01_01",
  "jb2a.melee_generic.bludgeoning.one_handed": "fallout-maw.generic.weapon_attacks.melee.dmg_bludgeoning_01_regular_yellow_1handed",
  "jb2a.melee_generic.creature_attack.claw.002.red": "fallout-maw.generic.creature.claw.creature_attack_claw_001_002_red",
  "jb2a.melee_generic.creature_attack.fist.001.red": "fallout-maw.generic.creature.fist.creature_attack_fist_001_001_red",
  "jb2a.melee_generic.slashing.one_handed": "fallout-maw.generic.weapon_attacks.melee.dmg_slashing_01_regular_yellow_1handed",
  "jb2a.pack_hound_missile.orange.01": "fallout-maw.generic.weapon_attacks.ranged.packhound_missile01_01_regular_orange",
  "jb2a.quarterstaff.melee.01.white": "fallout-maw.generic.weapon_attacks.melee.group01.melee_attack01_butterfly_sword01_01",
  "jb2a.quarterstaff.melee.01.white.0": "fallout-maw.generic.weapon_attacks.melee.group01.melee_attack01_butterfly_sword01_01",
  "jb2a.quarterstaff.melee.01.white.2": "fallout-maw.generic.weapon_attacks.melee.group01.melee_attack01_butterfly_sword01_01",
  "jb2a.scorching_ray.01.rainbow01": "fallout-maw.2nd_level.scorching_ray.scorching_ray_01_regular_rainbow01",
  "jb2a.shortsword.melee.01.white": "fallout-maw.generic.weapon_attacks.melee.group01.melee_attack01_short_sword01_01",
  "jb2a.side_impact.part.shockwave.blue": "fallout-maw.generic.impact.part_side_impact_shockwave01_01_regular_blue",
  "jb2a.spear.melee.01.white": "fallout-maw.generic.weapon_attacks.melee.group01.melee_attack01_butterfly_sword01_01",
  "jb2a.sword.melee.01.blue.0": "fallout-maw.generic.weapon_attacks.melee.group01.melee_attack01_magic_sword02_01_regular_blue",
  "jb2a.sword.melee.01.orange.0": "fallout-maw.generic.weapon_attacks.melee.group01.melee_attack01_magic_sword02_01_regular_orange",
  "jb2a.sword.melee.01.white": "fallout-maw.generic.weapon_attacks.melee.group01.melee_attack01_butterfly_sword01_01",
  "jb2a.sword.melee.fire.orange": "fallout-maw.generic.weapon_attacks.melee.great_sword01_fire_regular_orange",
  "jb2a.sword.melee.fire.yellow": "fallout-maw.generic.weapon_attacks.melee.great_sword01_fire_regular_yellow",
  "jb2a.teleport.01.yellow": "fallout-maw.generic.weapon_attacks.melee.group01.melee_attack01_magic_sword01_01_regular_yellow",
  "jb2a.template_circle.out_pulse.02.burst.bluewhite": "fallout-maw.generic.template.circle.out_pulse.out_pulse_02_regular_blue_white_burst",
  "jb2a.throwable.launch.grenade.01.green": "fallout-maw.generic.weapon_attacks.melee.group01.melee_attack01_magic_sword02_01_dark_green",
  "jb2a.throwable.launch.grenade.02.blackyellow": "fallout-maw.generic.weapon_attacks.ranged.launch_grenade02_01_regular_black_yellow",
  "jb2a.throwable.launch.missile.01.blue": "fallout-maw.generic.weapon_attacks.melee.group01.melee_attack01_magic_sword02_01_regular_blue",
  "jb2a.unarmed_strike.magical.01.blue": "fallout-maw.generic.unarmed_attacks.unarmed_strike.unarmed_strike_01_regular_blue_magical01",
  "jb2a.unarmed_strike.no_hit.01.yellow": "fallout-maw.generic.unarmed_attacks.unarmed_strike.unarmed_strike_no_hit_01_regular_yellow",
  "jb2a.unarmed_strike.physical.01.blue": "fallout-maw.generic.unarmed_attacks.unarmed_strike.unarmed_strike_01_regular_blue_physical01",
  "jb2a.unarmed_strike.physical.01.dark_purple": "fallout-maw.generic.unarmed_attacks.unarmed_strike.unarmed_strike_01_dark_purple_physical01",
  "jb2a.unarmed_strike.physical.01.dark_red": "fallout-maw.generic.unarmed_attacks.unarmed_strike.unarmed_strike_01_dark_red_physical01",
  "jb2a.unarmed_strike.physical.01.yellow": "fallout-maw.generic.unarmed_attacks.unarmed_strike.unarmed_strike_01_regular_yellow_physical01",
  "jb2a.unarmed_strike.physical.02.blue": "fallout-maw.generic.unarmed_attacks.unarmed_strike.unarmed_strike_01_regular_blue_physical02",
  "jb2a.unarmed_strike.physical.02.green": "fallout-maw.generic.unarmed_attacks.unarmed_strike.unarmed_strike_01_regular_green_physical02",
  "jb2a.warhammer.melee.01.orange": "fallout-maw.generic.weapon_attacks.melee.group01.melee_attack01_magic_sword02_01_regular_orange",
  "jb2a.warhammer.melee.01.purple": "fallout-maw.generic.weapon_attacks.melee.group01.melee_attack01_magic_sword02_01_dark_purple",
  "jb2a.wrench.melee.01.white": "fallout-maw.generic.weapon_attacks.melee.group01.melee_attack01_butterfly_sword01_01"
};

if (game.system.id !== SYSTEM_ID) {
  ui.notifications.error("Этот макрос рассчитан только на систему fallout-maw.");
  return;
}

let updated = 0;
let skipped = 0;
let errors = 0;

for (const item of game.items.contents) {
  if (item.type !== "gear") continue;
  const weaponFn = item.system?.functions?.weapon;
  const additionalWeapons = item.system?.functions?.additionalWeapons ?? {};
  const isMigratedWeapon = Boolean(item.getFlag(FLAG_SCOPE, WEAPON_FLAG_KEY));
  const hasWeaponData = Boolean(weaponFn?.enabled) || Object.keys(additionalWeapons).length > 0;
  if (!isMigratedWeapon && !hasWeaponData) continue;

  try {
    const updates = buildWeaponMediaUpdates(item.system?.functions ?? {});
    if (!Object.keys(updates).length) {
      skipped += 1;
      continue;
    }
    await item.update(updates);
    updated += 1;
  } catch (error) {
    errors += 1;
    console.error("weapon media repair failed", item.id, item.name, error);
  }
}

ui.notifications.info(
  `Починка медиа оружия: обновлено ${updated}, без изменений ${skipped}, ошибок ${errors}.`
);
console.log("weapon media repair", { updated, skipped, errors });

function buildWeaponMediaUpdates(functions = {}) {
  const updates = {};
  const weaponPatch = patchWeaponMediaData(functions.weapon ?? {});
  if (weaponPatch) updates["system.functions.weapon"] = { ...functions.weapon, ...weaponPatch };

  const additionalWeapons = functions.additionalWeapons ?? {};
  for (const [weaponId, weaponData] of Object.entries(additionalWeapons)) {
    const patch = patchWeaponMediaData(weaponData ?? {});
    if (!patch) continue;
    updates[`system.functions.additionalWeapons.${weaponId}`] = { ...weaponData, ...patch };
  }
  return updates;
}

function migrateWeaponSoundPath(rawPath = "") {
  let pathValue = String(rawPath ?? "").trim();
  if (!pathValue || pathValue === "Путь") return "";

  pathValue = pathValue.replace(/Путь$/i, "");
  try {
    pathValue = decodeURIComponent(pathValue);
  } catch (_error) {
    // keep raw path
  }

  pathValue = pathValue
    .replace(/^systems\/fallout-maw\/icons\/Weapon_Sounds/i, "systems/fallout-maw/audio/Weapon_Sounds")
    .replace(/^systems\/fallout-maw\/icons\/WEAPON_SOUNDS/i, "systems/fallout-maw/audio/Weapon_Sounds");

  if (/^Weapon_Sounds\//i.test(pathValue)) {
    pathValue = `systems/fallout-maw/audio/${pathValue}`;
  }

  return pathValue;
}

function migrateWeaponAnimationKey(rawKey = "") {
  const key = String(rawKey ?? "").trim();
  if (!key || key === "Путь") return "";
  if (key.startsWith("fallout-maw.")) return key;
  if (key.startsWith("systems/")) return key;
  return JB2A_ANIMATION_MAP[key.toLowerCase()] ?? "";
}

function patchWeaponMediaData(weapon = {}) {
  if (!weapon || typeof weapon !== "object") return null;

  const updates = {};
  const nextAttackAnimation = migrateWeaponAnimationKey(weapon.attackAnimationKey);
  if (nextAttackAnimation && nextAttackAnimation !== weapon.attackAnimationKey) {
    updates.attackAnimationKey = nextAttackAnimation;
  }

  const nextAttackSound = migrateWeaponSoundPath(weapon.attackSoundPath);
  if (nextAttackSound !== String(weapon.attackSoundPath ?? "")) {
    updates.attackSoundPath = nextAttackSound;
  }

  const volley = weapon.volley ?? {};
  const volleyUpdates = {};
  const nextExplosionAnimation = migrateWeaponAnimationKey(volley.explosionAnimationKey);
  if (nextExplosionAnimation && nextExplosionAnimation !== volley.explosionAnimationKey) {
    volleyUpdates.explosionAnimationKey = nextExplosionAnimation;
  }
  const nextExplosionSound = migrateWeaponSoundPath(volley.explosionSoundPath);
  if (nextExplosionSound !== String(volley.explosionSoundPath ?? "")) {
    volleyUpdates.explosionSoundPath = nextExplosionSound;
  }
  if (Object.keys(volleyUpdates).length) {
    updates.volley = { ...volley, ...volleyUpdates };
  }

  const magazineMax = Math.max(0, Number(weapon.magazine?.max) || 0);
  if (magazineMax > 0 && Number(weapon.magazine?.value) !== magazineMax) {
    updates.magazine = { ...(weapon.magazine ?? {}), value: magazineMax };
  }

  return Object.keys(updates).length ? updates : null;
}
