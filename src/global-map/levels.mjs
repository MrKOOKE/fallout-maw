const idOf = level => String(level?.id ?? level?._id ?? (typeof level === "string" ? level : "")).trim();

export function getDefaultMapLevelId(scene) {
  return idOf(scene?.initialLevel) || idOf(scene?.levels?.contents?.[0]);
}

export function getViewedMapLevelId(scene) {
  const activeCanvas = globalThis.canvas;
  return (scene?.id && activeCanvas?.scene?.id === scene.id ? idOf(activeCanvas.level) : "")
    || getDefaultMapLevelId(scene);
}

export function getMapAreaLevelId(scene, area, field = "levelId") {
  return idOf(area?.[field]) || getDefaultMapLevelId(scene);
}

export function getMapTokenLevelId(scene, token, position = token) {
  return idOf(position?.level) || idOf(token?.level) || idOf(token?._source?.level) || getDefaultMapLevelId(scene);
}

export function isMapAreaOnLevel(scene, area, levelId = getViewedMapLevelId(scene), field = "levelId") {
  return getMapAreaLevelId(scene, area, field) === idOf(levelId);
}

export function getMapLevelChoices(scene, area, field = "levelId") {
  const selected = getMapAreaLevelId(scene, area, field);
  return Array.from(scene?.levels?.contents ?? []).map(level => ({ id: level.id, name: level.name, selected: level.id === selected }));
}

export function getMapAreaTokenPlacement(scene, area, field = "levelId") {
  const level = scene?.levels?.get?.(getMapAreaLevelId(scene, area, field));
  return level ? { level: level.id, elevation: level.elevation.base } : {};
}
