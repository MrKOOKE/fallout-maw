export function getFalloutMaWTimeContext(options = {}) {
  const context = options?.falloutMaw;
  return context && typeof context === "object" ? context : {};
}

export function isRestModeTime(options = {}) {
  return Boolean(getFalloutMaWTimeContext(options).restMode);
}

export function isTimeMechanicsForced(options = {}) {
  const context = getFalloutMaWTimeContext(options);
  return Boolean(context.forceTimeMechanics || context.campRest?.forceTimeMechanics);
}

export function getCampRestTimePlan(options = {}) {
  const plan = getFalloutMaWTimeContext(options).campRest;
  if (!plan || typeof plan !== "object") return null;
  const participants = Array.isArray(plan.participants) ? plan.participants : [];
  return {
    forceTimeMechanics: Boolean(plan.forceTimeMechanics),
    participants: participants.map(entry => ({
      actorUuid: String(entry?.actorUuid ?? ""),
      normalSeconds: Math.max(0, Math.trunc(Number(entry?.normalSeconds) || 0)),
      restSeconds: Math.max(0, Math.trunc(Number(entry?.restSeconds) || 0)),
      effects: Array.isArray(entry?.effects) ? entry.effects : []
    })).filter(entry => entry.actorUuid)
  };
}

export function getActorTimeSegments(actor, elapsedSeconds, options = {}) {
  const total = Math.max(0, Number(elapsedSeconds) || 0);
  const campRest = getCampRestTimePlan(options);
  if (campRest) {
    const participant = campRest.participants.find(entry => entry.actorUuid === actor?.uuid);
    if (!participant) return [{ seconds: total, restMode: false, effects: [] }];
    const normalSeconds = Math.min(total, participant.normalSeconds);
    const restSeconds = Math.min(Math.max(0, total - normalSeconds), participant.restSeconds);
    const remainderSeconds = Math.max(0, total - normalSeconds - restSeconds);
    return [
      { seconds: normalSeconds + remainderSeconds, restMode: false, effects: [] },
      { seconds: restSeconds, restMode: true, effects: participant.effects }
    ].filter(segment => segment.seconds > 0);
  }
  return [{ seconds: total, restMode: isRestModeTime(options), effects: [] }];
}

export function isCampRestParticipant(actor, options = {}) {
  const campRest = getCampRestTimePlan(options);
  if (!campRest) return false;
  return campRest.participants.some(entry => entry.actorUuid === actor?.uuid);
}

export function applyRestTimeMultiplier(perHour, restMode = false) {
  const value = Number(perHour) || 0;
  if (!restMode) return value;
  if (value > 0) return value * 0.5;
  if (value < 0) return value * 2;
  return 0;
}
