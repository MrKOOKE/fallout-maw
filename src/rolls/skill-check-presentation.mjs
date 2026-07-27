export function groupSkillCheckOutcomesByActor(outcomes = []) {
  const groups = [];
  const groupsByActor = new Map();

  for (const outcome of Array.isArray(outcomes) ? outcomes : []) {
    if (!outcome) continue;

    const actor = outcome.actor;
    const actorUuid = String(actor?.uuid ?? "").trim();
    const actorId = String(actor?.id ?? "").trim();
    const actorKey = actorUuid
      ? `uuid:${actorUuid}`
      : (actorId ? `id:${actorId}` : (actor ?? outcome));

    let group = groupsByActor.get(actorKey);
    if (!group) {
      group = [];
      groupsByActor.set(actorKey, group);
      groups.push(group);
    }
    group.push(outcome);
  }

  return groups;
}
