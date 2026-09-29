/** Bind a search operation to the server record for this user and actor pair. */
export function hasActiveSearchInventorySession(sessions, {
  sessionId = "",
  requesterUserId = "",
  searcherActorUuid = "",
  searchedActorUuid = ""
} = {}) {
  const id = String(sessionId ?? "");
  const requester = String(requesterUserId ?? "");
  if (!id || !requester || !searcherActorUuid || !searchedActorUuid) return false;
  const record = sessions?.get?.(`${requester}:${id}`);
  return Boolean(record
    && record.searcherActor?.uuid === searcherActorUuid
    && record.searchedActor?.uuid === searchedActorUuid);
}
