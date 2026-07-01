import fs from "node:fs";

const actions = fs.readFileSync("scripts/migration-macros/gear/00-repair-weapon-actions.js", "utf8");
const bad = [];

for (const m of actions.matchAll(/"explosionAnimationKey":"([^"]+)"/g)) {
  const key = m[1];
  if (key.includes("magic_sword") || key.includes("fireball") || (key.includes(".melee.") && !key.includes("explosion"))) {
    bad.push(`explosion: ${key}`);
  }
}

for (const m of actions.matchAll(/"skillKey":"rangedCombat"[\s\S]{0,400}?"attackAnimationKey":"([^"]+)"/g)) {
  if (m[1].includes(".melee.")) bad.push(`ranged attack melee: ${m[1]}`);
}

console.log("bad refs:", bad.length);
bad.slice(0, 20).forEach(line => console.log(line));
console.log("magic_sword02 count:", (actions.match(/magic_sword02/g) ?? []).length);
