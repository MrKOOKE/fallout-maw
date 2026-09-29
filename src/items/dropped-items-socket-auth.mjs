/** Foundry supplies the sender ID separately from the untrusted message body. */
export function isAuthenticatedDroppedItemsSocketMessage(message, senderUserId, {
  users,
  currentUserId,
  pendingRequests
} = {}) {
  const sender = users?.get?.(String(senderUserId ?? ""));
  if (!sender) return false;
  if (message?.type === "request") {
    return String(message.requesterUserId ?? "") === sender.id;
  }
  if (message?.type === "response") {
    const pending = pendingRequests?.get?.(message.requestId);
    return message.recipientUserId === currentUserId
      && sender.id === pending?.responderUserId;
  }
  return false;
}
