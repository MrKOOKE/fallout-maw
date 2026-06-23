import { SYSTEM_ID } from "../constants.mjs";
import { ABILITY_FIXED_FUNCTION_KEYS } from "../settings/abilities.mjs";
import { hasActorFixedAbilityFunction } from "./runtime-state.mjs";

const DANGER_SENSE_SOCKET = `system.${SYSTEM_ID}`;
const DANGER_SENSE_SOCKET_SCOPE = "fallout-maw.dangerSense";
const DANGER_SENSE_WARNING = "Чутье: рядом есть опасность.";

export function registerDangerSenseSocket() {
  game.socket.on(DANGER_SENSE_SOCKET, handleDangerSenseSocketMessage);
}

export function notifyDangerSenseWarning(actor) {
  if (!actor || !hasActorFixedAbilityFunction(actor, ABILITY_FIXED_FUNCTION_KEYS.dangerSense)) return false;
  void createDangerSenseChatMessage(actor);
  const owners = getActiveActorOwnerUsers(actor);
  if (owners.length) {
    for (const owner of owners) {
      if (owner.id === game.user?.id) {
        showDangerSenseWarning();
        continue;
      }
      game.socket.emit(DANGER_SENSE_SOCKET, {
        scope: DANGER_SENSE_SOCKET_SCOPE,
        action: "warning",
        targetUserId: owner.id
      });
    }
    return true;
  }
  if (actor.isOwner) {
    showDangerSenseWarning();
    return true;
  }
  return false;
}

function handleDangerSenseSocketMessage(message = {}) {
  if (message?.scope !== DANGER_SENSE_SOCKET_SCOPE) return;
  if (message.action !== "warning") return;
  if (message.targetUserId !== game.user?.id) return;
  showDangerSenseWarning();
}

function showDangerSenseWarning() {
  ui.notifications?.warn?.(DANGER_SENSE_WARNING);
}

async function createDangerSenseChatMessage(actor) {
  try {
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `<p><strong>${escapeHtml(actor.name)}</strong> почувствовал рядом опасность.</p>`
    });
  } catch (error) {
    console.error(`${SYSTEM_ID} | Danger sense chat message failed`, error);
  }
}

function getActiveActorOwnerUsers(actor) {
  return (game.users?.contents ?? [])
    .filter(user => user.active && !user.isGM && actor?.testUserPermission?.(user, "OWNER"))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
