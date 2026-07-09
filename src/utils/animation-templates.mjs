// Sequencer-compatible templates: [gridSize, startPoint, endPoint]
// https://github.com/fantasycalendar/FoundryVTT-Sequencer/blob/main/docs/database-basics.md

const DISTANCE_FILE_PATTERN = /(?:^|[_\-\s])\d{1,3}(?:ft|m)(?=$|[_\-\s.])/i;
const MELEE_FILE_PATTERN = /(?:^|\/)Generic\/Weapon_Attacks\/Melee(?:\/|$)|(?:^|[_\/])(?:CreatureAttack|Dmg_(?:Bludgeoning|Slashing|Piercing))[^/]*\.webm$/i;
const CONE_FILE_PATTERN = /(?:^|\/)(?:1st_Level\/Burning_Hands|5th_Level\/Cone_Of_Cold|Generic\/Template\/Cone)(?:\/|$)|(?:^|[_\/])(?:BreathWeapon|BurningHands|ConeOfCold|DetectMagicCone)[^/]*\.webm$/i;

export const ANIMATION_TEMPLATES = Object.freeze({
  default: Object.freeze({ type: "default", gridSize: 100, startPoint: 0, endPoint: 0 }),
  ranged: Object.freeze({ type: "ranged", gridSize: 200, startPoint: 200, endPoint: 200 }),
  melee: Object.freeze({ type: "melee", gridSize: 200, startPoint: 300, endPoint: 300 }),
  cone: Object.freeze({ type: "cone", gridSize: 100, startPoint: 0, endPoint: 0 })
});

export function getAnimationTemplate(file = "") {
  const path = String(file ?? "");
  if (CONE_FILE_PATTERN.test(path)) return ANIMATION_TEMPLATES.cone;
  if (MELEE_FILE_PATTERN.test(path)) return ANIMATION_TEMPLATES.melee;
  if (DISTANCE_FILE_PATTERN.test(path)) return ANIMATION_TEMPLATES.ranged;
  return ANIMATION_TEMPLATES.default;
}

export function getAnimationGridSizeDifference(template = ANIMATION_TEMPLATES.default) {
  const gridSize = Math.max(1, Number(canvas?.grid?.size) || 100);
  const templateGridSize = Math.max(1, Number(template?.gridSize) || 100);
  return gridSize / templateGridSize;
}
