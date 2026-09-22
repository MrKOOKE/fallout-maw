const levelId = value => String(typeof value === "string" ? value : value?.id ?? value?._id ?? "").trim();

/** Resolve placement from its source, never from the receiving GM's viewed level. */
export function getSceneCreationLevels(scene, ...sources) {
  for (const source of sources) {
    const document = source?.document ?? source;
    const id = levelId(document?._source?.level) || levelId(document?.level) || levelId(document?.levelId);
    if (id) return [id];
    const levels = document?.levels ?? document?._source?.levels;
    if (Array.isArray(levels) || levels instanceof Set) return Array.from(levels, levelId).filter(Boolean);
  }
  const id = levelId(scene?.initialLevel) || levelId(scene?.firstLevel) || levelId(scene?.levels?.contents?.[0]);
  return id ? [id] : [];
}

export function getSceneCreationLevelId(scene, ...sources) {
  return getSceneCreationLevels(scene, ...sources)[0] ?? "";
}

/** Capture the initiating client's placement before asynchronous work or a socket handoff. */
export function captureSceneCreationPoint(scene, point = {}, source = null) {
  const document = source?.document ?? source;
  const viewed = globalThis.canvas?.scene?.id === scene?.id ? globalThis.canvas?.level : null;
  const level = getSceneCreationLevelId(scene, point, document, { level: viewed?.id });
  const elevation = point?.elevation ?? document?.elevation ?? scene?.levels?.get?.(level)?.elevation?.base ?? 0;
  return { ...point, level, elevation: Number(elevation) || 0 };
}
