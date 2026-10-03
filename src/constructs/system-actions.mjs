import { SYSTEM_ID } from "../constants.mjs";
import { getConstructSystems, getConstructSystemState } from "../utils/construct-systems.mjs";
import { getConstructCrewContexts } from "../utils/construct-crew-context.mjs";
import { hasConstructCrew } from "../utils/construct-crew.mjs";
import { runOneTimeResourceMutation } from "../combat/one-time-resources.mjs";
import { executeInventoryMutation } from "../inventory/mutation.mjs";
import { planResourceRecovery } from "../utils/resource-recovery.mjs";

const scope = "fallout-maw.constructSystems", pending = new Map(), handled = new Map();

export function canUserControlConstructSystem(actor, systemId, user = game.user, action = "activate", passengerId = "") {
  if (!getConstructSystems(actor).some(row => row.id === systemId) || !actor?.testUserPermission?.(user, "OWNER")) return false;
  if (user?.isGM) return true;
  if (!hasConstructCrew(actor)) return true;
  return getConstructCrewContexts(actor, user, { availableOnly: true }).some(context =>
    (!passengerId || context.passenger.id === passengerId) && context.seat.functions.includes(action)
      && context.seat.systemIds.includes(systemId));
}

export function getConstructHudSystemControls(actor, crew = null, user = game.user) {
  return getConstructSystems(actor).filter(system => system.enabled && system.requiresActivation
    && (crew ? crew.available && crew.seat.functions.includes("activate") && crew.seat.systemIds.includes(system.id)
      : canUserControlConstructSystem(actor, system.id, user))).map(system => ({
      ...getConstructSystemState(actor, system), id: system.id, name: system.name, active: system.active
    }));
}

export async function requestConstructSystemAction(actor, systemId, action, options = {}) {
  const user = game.user;
  const service = action === "recover" && options.service === true;
  const authorized = service ? await canServiceSystem(actor, systemId, user, options)
    : canUserControlConstructSystem(actor, systemId, user, action === "recover" ? "recover" : "activate", options.passengerId);
  if (!authorized) {
    ui.notifications.warn("Это место не управляет выбранной системой.");
    return false;
  }
  const payload = { actorUuid: actor.uuid, systemId, action, ...options, userId: user.id };
  if (user.isActiveGM) return performConstructSystemAction(payload);
  const gm = game.users.activeGM;
  if (!gm) { ui.notifications.warn("Для управления системой нужен активный мастер."); return false; }
  const requestId = foundry.utils.randomID();
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("Мастер не ответил на запрос системы.")); }, 15000);
    pending.set(requestId, { resolve, reject, timer, gmId: gm.id });
  });
  game.socket.emit(`system.${SYSTEM_ID}`, { scope, requestId, gmId: gm.id, ...payload });
  return result;
}

export function registerConstructSystemSocket() {
  game.socket.on(`system.${SYSTEM_ID}`, async (message, senderUserId) => {
    if (message?.scope !== scope) return;
    if (message.action === "result") {
      const entry = pending.get(message.requestId);
      if (!entry || message.userId !== game.user.id || senderUserId !== entry.gmId) return;
      clearTimeout(entry.timer); pending.delete(message.requestId);
      message.error ? entry.reject(new Error(message.error)) : entry.resolve(message.result);
      return;
    }
    if (!game.user.isActiveGM || message.gmId !== game.user.id || senderUserId !== message.userId) return;
    const key = `${message.userId}:${message.requestId}`;
    let reply = handled.get(key);
    if (!reply) {
      reply = performConstructSystemAction(message).then(result => ({ result }), error => ({ error: error.message }));
      handled.set(key, reply);
      if (handled.size > 128) handled.delete(handled.keys().next().value);
    }
    game.socket.emit(`system.${SYSTEM_ID}`, { scope, action: "result", requestId: message.requestId, userId: message.userId, ...await reply });
  });
}

async function performConstructSystemAction(payload) {
  const actor = await fromUuid(payload.actorUuid), user = game.users.get(payload.userId);
  const permission = payload.action === "recover" ? "recover" : "activate";
  const authorized = payload.action === "recover" && payload.service === true
    ? await canServiceSystem(actor, payload.systemId, user, payload)
    : canUserControlConstructSystem(actor, payload.systemId, user, permission, payload.passengerId);
  if (!authorized) throw new Error("Нет прав на это взаимодействие.");
  return runOneTimeResourceMutation(actor, async () => {
    const systems = foundry.utils.deepClone(actor.system.constructSystems);
    const index = systems.findIndex(row => row.id === payload.systemId), system = systems[index];
    const state = getConstructSystemState(actor, system);
    if (!system?.enabled) throw new Error("Система отключена в настройках.");
    if (payload.action === "activate") {
      const active = Boolean(payload.active);
      if (active && !state.functional) throw new Error("Нет исправного двигателя или источника энергии.");
      if (active && state.stored <= 0) throw new Error("Нет энергии для запуска.");
      if (system.active === active) return { active, changed: false };
      systems[index].active = active;
      await actor.update({ "system.constructSystems": systems });
      if (actor.system.constructSystems[index]?.active !== active) throw new Error("Изменение системы отменено.");
      return { active, changed: true };
    }
    if (payload.action !== "recover") throw new Error("Неизвестное действие системы.");
    const sourceActor = await fromUuid(payload.sourceActorUuid || actor.uuid);
    if (!sourceActor?.testUserPermission?.(user, "OWNER")) throw new Error("Нет доступа к расходуемым предметам.");
    const method = system.recoveryMethods?.[Number(payload.methodIndex)];
    if (method?.type !== "resources") throw new Error("Метод восстановления не найден.");
    const resource = actor.system.resources[system.resourceKey];
    const plan = planResourceRecovery(sourceActor, method, { current: resource.value, max: resource.max, resourceIndex: payload.resourceIndex ?? null });
    if (!plan.ok) throw new Error(plan.reason);
    const next = resource.value + plan.restored;
    await executeInventoryMutation([
      { actor: sourceActor, updates: plan.updates, deletes: plan.deletes, expectedItems: sourceActor.items.map(item => item.toObject()) },
      { actor, actorUpdates: [{ [`system.resources.${system.resourceKey}.value`]: next,
        [`system.resources.${system.resourceKey}.spent`]: Math.max(0, resource.max - next) }] }
    ], { reason: "construct-system-recovery" });
    return { restored: plan.restored, value: next };
  });
}

/** Servicing uses the player's own supplies, following the same token context as ordinary repair. */
async function canServiceSystem(actor, systemId, user, options) {
  if (!user?.active || actor?.type !== "construct" || !getConstructSystems(actor).some(row => row.id === systemId && row.enabled)) return false;
  const [source, sourceToken, targetToken] = await Promise.all([
    fromUuid(options.sourceActorUuid ?? ""), fromUuid(options.sourceTokenUuid ?? ""), fromUuid(options.targetTokenUuid ?? "")
  ]);
  return Boolean(source?.testUserPermission?.(user, "OWNER") && sourceToken?.actor?.uuid === source.uuid
    && targetToken?.actor?.uuid === actor.uuid && sourceToken.parent?.id === targetToken.parent?.id
    && (user.isGM || (!sourceToken.hidden && !targetToken.hidden)));
}
