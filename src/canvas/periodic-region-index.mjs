const BEHAVIOR_TYPE = "fallout-maw.periodicDamage";

let periodicSceneIndex = null;
const periodicBehaviorsByScene = new WeakMap();

export function getPeriodicDamageBehaviors(scene) {
  if (!scene) return [];
  const cached = periodicBehaviorsByScene.get(scene);
  if (cached) return cached;
  const behaviors = [];
  for (const region of scene.regions?.contents ?? scene.regions ?? []) {
    for (const behavior of region.behaviors?.contents ?? region.behaviors ?? []) {
      if (behavior.type === BEHAVIOR_TYPE) behaviors.push({ region, behavior });
    }
  }
  periodicBehaviorsByScene.set(scene, behaviors);
  return behaviors;
}

export function getPeriodicDamageScenes() {
  return Array.from(getPeriodicDamageSceneSet());
}

export function getPeriodicDamageSceneSet() {
  if (!periodicSceneIndex) {
    periodicSceneIndex = new Set();
    for (const scene of game.scenes?.contents ?? game.scenes ?? []) {
      if (getPeriodicDamageBehaviors(scene).length) periodicSceneIndex.add(scene);
    }
  }
  return periodicSceneIndex;
}

export function invalidatePeriodicDamageScene(scene) {
  if (scene) periodicBehaviorsByScene.delete(scene);
  periodicSceneIndex = null;
}
