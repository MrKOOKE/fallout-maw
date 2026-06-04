import {
  getActorHealingModifierPercent,
  requestDamageApplication,
  requestFirstAidEffect,
  requestFirstAidNeedChanges,
  requestFirstAidRemoveEffects
} from "../combat/damage-hub.mjs";
import { ACTION_RESOURCE_KEY } from "../combat/movement-resources.mjs";
import { SYSTEM_ID } from "../constants.mjs";
import { requestSkillCheck } from "../rolls/skill-check.mjs";
import { escapeHtml } from "../utils/dom.mjs";
import { getFirstAidChargesData, getFirstAidFunction, hasItemFunction, ITEM_FUNCTIONS } from "../utils/item-functions.mjs";
import { getItemQuantity } from "../utils/inventory-containers.mjs";
import { toInteger } from "../utils/numbers.mjs";

const { DialogV2 } = foundry.applications.api;
const FIRST_AID_SOCKET = `system.${SYSTEM_ID}`;
const FIRST_AID_SOCKET_SCOPE = "fallout-maw.firstAid";
const FIRST_AID_SOCKET_TIMEOUT = 10000;
const HEALING_DAMAGE_TYPE_KEY = "healing";
const CRITICAL_SUCCESS_DEFAULT_BONUS = 20;
const FIRST_AID_HEALING_CHANGE_KEYS = new Set(["fallout-maw.healing", "healing"]);
const pendingFirstAidSocketRequests = new Map();

export function registerFirstAidSocket() {
  game.socket.on(FIRST_AID_SOCKET, handleFirstAidSocketMessage);
}

export async function useFirstAidItem({ sourceActor = null, targetActor = null, sourceToken = null, targetToken = null, item = null } = {}) {
  if (!sourceActor || !targetActor || !item || !hasItemFunction(item, ITEM_FUNCTIONS.firstAid)) return false;

  const firstAid = getFirstAidFunction(item);
  const charges = getFirstAidChargesData(item);
  if (getItemQuantity(item) <= 0 || charges.value <= 0) {
    ui.notifications.warn(`${item.name}: item is depleted.`);
    return false;
  }
  if (!isTargetInFirstAidRange(sourceToken, targetToken, firstAid)) return false;
  const targetContext = await getFirstAidTargetContext(targetToken, targetActor);
  if (!targetContext) return false;
  const selectedLimbs = await requestLimbSelection(targetActor, limitFirstAidSelectionByCharges(firstAid, charges.value), targetContext);
  if (selectedLimbs === null) return false;
  const removeEffectDamageTypeKeys = getFirstAidRemoveEffectDamageTypeKeys(firstAid);
  const removeEffectLimbKeys = getSelectedFirstAidLimbKeys(selectedLimbs);
  const hasEffectRemoval = removeEffectDamageTypeKeys.length > 0 && removeEffectLimbKeys.length > 0;
  const chargeCost = getFirstAidChargeCost(selectedLimbs);
  if (chargeCost > charges.value) {
    ui.notifications.warn(`${item.name}: not enough charges.`);
    return false;
  }
  if (!(await spendActionPointsIfNeeded(sourceActor, firstAid))) return false;

  const source = {
    kind: "firstAid",
    sourceActorUuid: sourceActor.uuid,
    itemUuid: item.uuid,
    itemName: item.name,
    worldTime: Number(game.time?.worldTime) || 0
  };

  const checkResult = await rollFirstAidCheck(sourceActor, targetContext, firstAid, item);
  const resultKey = checkResult?.result?.key ?? "success";
  if (resultKey === "criticalFailure") {
    await spendFirstAidItem(item, chargeCost);
    await applyCriticalFailureDamage(targetActor, firstAid, source);
    return true;
  }
  const resultMultiplier = resultKey === "failure" ? 0.5 : 1;
  const criticalSuccessMultiplier = resultKey === "criticalSuccess"
    ? 1 + (Math.max(0, toInteger(firstAid.criticalSuccessHealingBonus ?? CRITICAL_SUCCESS_DEFAULT_BONUS)) / 100)
    : 1;
  const effectMultiplier = resultMultiplier * criticalSuccessMultiplier;
  const healingMultiplier = effectMultiplier * Math.max(0, 1 + (getActorHealingModifierPercent(sourceActor, "outgoing") / 100));

  const healing = calculateHealingAmount(targetActor, firstAid, healingMultiplier, targetContext);
  const durationSeconds = Math.max(0, toInteger(firstAid.durationSeconds));
  const normalizedChanges = normalizeFirstAidChanges(firstAid.changes, effectMultiplier, healingMultiplier);
  const healingPerTick = Math.max(0, normalizedChanges.healingPerTick);
  const changes = normalizedChanges.changes;
  const needs = normalizeFirstAidNeeds(firstAid.needs, effectMultiplier);
  const limbs = normalizeFirstAidLimbs(selectedLimbs, firstAid, effectMultiplier, healingMultiplier);
  const hasImmediateHealing = healing > 0;
  const hasTimedEffect = durationSeconds > 0 && (healingPerTick > 0 || changes.length);
  if (!hasImmediateHealing && !hasTimedEffect && !needs.length && !limbs.length && !hasEffectRemoval) return false;

  if (healing > 0) {
    await requestDamageApplication({
      actor: targetActor,
      amount: healing,
      damageTypeKey: HEALING_DAMAGE_TYPE_KEY,
      mode: "healing",
      scope: "health",
      applyMitigation: false,
      processDamageTypeSettings: false,
      source
    });
  }

  for (const limb of limbs) {
    await requestDamageApplication({
      actor: targetActor,
      limbKey: limb.limbKey,
      amount: Math.abs(limb.value),
      damageTypeKey: limb.value >= 0 ? HEALING_DAMAGE_TYPE_KEY : "",
      mode: limb.value >= 0 ? "healing" : "damage",
      scope: "limb",
      applyMitigation: false,
      processDamageTypeSettings: false,
      source
    });
  }

  if (needs.length) await requestFirstAidNeedChanges({ actor: targetActor, needs });

  if (hasEffectRemoval) {
    await requestFirstAidRemoveEffects({
      actor: targetActor,
      limbKeys: removeEffectLimbKeys,
      damageTypeKeys: removeEffectDamageTypeKeys
    });
  }

  if (hasTimedEffect) {
    await requestFirstAidEffect({
      actor: targetActor,
      itemName: item.name,
      itemImg: item.img,
      healingPerTick,
      durationSeconds,
      intervalSeconds: Math.max(1, toInteger(firstAid.intervalSeconds) || 6),
      changes,
      source
    });
  }

  await spendFirstAidItem(item, chargeCost);
  return true;
}

function calculateHealingAmount(actor, firstAid = {}, multiplier = 1, targetContext = null) {
  const base = Math.max(0, toInteger(firstAid.healing));
  if (!base) return 0;
  if (firstAid.healingIsPercentage) {
    const max = Math.max(0, toInteger(targetContext?.healthMax ?? actor?.system?.resources?.health?.max));
    return Math.max(0, Math.floor((max * base * multiplier) / 100));
  }
  return Math.max(0, scaleSignedValue(base, multiplier));
}

function normalizeFirstAidChanges(changes = [], multiplier = 1, healingMultiplier = multiplier) {
  const source = Array.isArray(changes) ? changes : Object.values(changes ?? {});
  let healingPerTick = 0;
  const normalized = source
    .map(change => {
      const key = String(change?.key ?? "").trim();
      if (FIRST_AID_HEALING_CHANGE_KEYS.has(key.toLocaleLowerCase())) {
        const value = scaleHealingChangeValue(change?.value, healingMultiplier);
        healingPerTick += toInteger(value);
        return null;
      }
      const value = scaleChangeValue(change?.value, multiplier);
      return {
      key: String(change?.key ?? "").trim(),
      type: ["add", "multiply", "override"].includes(String(change?.type ?? "")) ? String(change.type) : "add",
      value: String(value),
      phase: String(change?.phase ?? "initial") || "initial",
      priority: change?.priority === null || change?.priority === "" || change?.priority === undefined
        ? null
        : toInteger(change.priority)
      };
    })
    .filter(Boolean)
    .filter(change => change.key);
  return { changes: normalized, healingPerTick };
}

function normalizeFirstAidNeeds(needs = [], multiplier = 1) {
  const source = Array.isArray(needs) ? needs : Object.entries(needs ?? {}).map(([needKey, value]) => ({ needKey, value }));
  return source
    .map(entry => ({
      key: String(entry?.needKey ?? "").trim(),
      value: scaleSignedValue(toInteger(entry?.value), multiplier)
    }))
    .filter(entry => entry.key && entry.value);
}

function getFirstAidRemoveEffectDamageTypeKeys(firstAid = {}) {
  const source = Array.isArray(firstAid.removeEffects)
    ? firstAid.removeEffects
    : Object.entries(firstAid.removeEffects ?? {}).map(([damageTypeKey]) => ({ damageTypeKey }));
  return Array.from(new Set(source
    .map(entry => String(entry?.damageTypeKey ?? entry?.key ?? "").trim())
    .filter(Boolean)));
}

function getSelectedFirstAidLimbKeys(selectedLimbs = []) {
  return Array.from(new Set((Array.isArray(selectedLimbs) ? selectedLimbs : [])
    .filter(entry => Math.max(0, toInteger(entry?.count)) > 0)
    .map(entry => String(entry?.limbKey ?? "").trim())
    .filter(Boolean)));
}

function normalizeFirstAidLimbs(limbs = [], firstAid = {}, multiplier = 1, healingMultiplier = multiplier) {
  const baseValue = toInteger(firstAid.limbSelection?.value);
  const value = baseValue > 0 && Number(healingMultiplier) <= 0
    ? 0
    : scaleSignedValue(baseValue, baseValue > 0 ? healingMultiplier : multiplier);
  if (!value) return [];
  const source = Array.isArray(limbs) ? limbs : [];
  return source
    .map(entry => ({
      limbKey: String(entry?.limbKey ?? "").trim(),
      value: value * Math.max(1, toInteger(entry?.count))
    }))
    .filter(entry => entry.limbKey && entry.value);
}

function limitFirstAidSelectionByCharges(firstAid = {}, availableCharges = 1) {
  const maxApplications = Math.max(0, toInteger(firstAid.limbSelection?.count));
  const available = Math.max(0, toInteger(availableCharges));
  return {
    ...firstAid,
    limbSelection: {
      ...(firstAid.limbSelection ?? {}),
      count: Math.min(maxApplications, available)
    }
  };
}

function getFirstAidChargeCost(selectedLimbs = []) {
  const limbApplications = (Array.isArray(selectedLimbs) ? selectedLimbs : [])
    .reduce((total, limb) => total + Math.max(0, toInteger(limb?.count)), 0);
  return Math.max(1, limbApplications);
}

function scaleChangeValue(value, multiplier = 1) {
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isFinite(Number(multiplier)) || Number(multiplier) === 1) return value;
  return scaleSignedValue(number, multiplier);
}

function scaleHealingChangeValue(value, multiplier = 1) {
  if (Number(multiplier) <= 0) return 0;
  return scaleChangeValue(value, multiplier);
}

function scaleSignedValue(value, multiplier = 1) {
  const number = Number(value) || 0;
  if (!number) return 0;
  const scaled = Math.floor(Math.abs(number) * Math.max(0, Number(multiplier) || 0));
  const finalValue = scaled < 1 ? 1 : scaled;
  return number < 0 ? -finalValue : finalValue;
}

async function rollFirstAidCheck(sourceActor, targetContext = null, firstAid = {}, item = null) {
  const difficulty = Math.max(0, toInteger(firstAid.difficulty));
  if (!difficulty) return null;
  const skillKey = targetContext?.isConstruct ? "repair" : "firstAid";
  return requestSkillCheck({
    actor: sourceActor,
    skillKey,
    data: {
      difficulty
    },
    animate: false,
    requester: item?.name ?? ""
  });
}

async function getFirstAidTargetContext(targetToken, fallbackActor = null) {
  const actor = targetToken?.actor ?? fallbackActor;
  if (!actor) return null;
  if (canUseActorLocally(actor)) return buildFirstAidTargetContext(actor, targetToken);

  const gm = getResponsibleGM();
  if (!gm) {
    ui.notifications.warn("Нет активного GM для доступа к цели первой помощи.");
    return null;
  }

  try {
    const result = await requestFirstAidSocket("getTargetContext", {
      actorUuid: actor.uuid,
      tokenName: targetToken?.name ?? ""
    }, gm);
    return result?.targetContext ?? null;
  } catch (error) {
    console.error(`${SYSTEM_ID} | First aid target socket failed`, error);
    ui.notifications.error(`Не удалось получить данные цели первой помощи: ${error.message}`);
    return null;
  }
}

function buildFirstAidTargetContext(actor, token = null) {
  const installedProstheses = getInstalledProsthesesByLimb(actor);
  return {
    actorUuid: actor?.uuid ?? "",
    name: token?.name ?? actor?.name ?? "",
    actorName: actor?.name ?? "",
    tokenName: token?.name ?? "",
    healthMax: Math.max(0, toInteger(actor?.system?.resources?.health?.max)),
    isConstruct: isConstructActor(actor),
    limbs: Object.entries(actor?.system?.limbs ?? {})
      .map(([key, limb]) => {
        const value = toInteger(limb?.value);
        const prosthesis = installedProstheses.get(key) ?? null;
        return {
          key,
          label: String(limb?.label ?? key),
          value,
          min: toInteger(limb?.min),
          max: toInteger(limb?.max),
          missing: Boolean(limb?.missing),
          prosthesis: prosthesis ? { id: prosthesis.id, name: prosthesis.name } : null
        };
      })
      .filter(limb => limb.key)
  };
}

async function requestLimbSelection(actor, firstAid = {}, targetContext = null) {
  const count = Math.max(0, toInteger(firstAid.limbSelection?.count));
  const value = toInteger(firstAid.limbSelection?.value);
  const hasEffectRemoval = getFirstAidRemoveEffectDamageTypeKeys(firstAid).length > 0;
  if (!count || (!value && !hasEffectRemoval)) return [];
  const limbs = (Array.isArray(targetContext?.limbs) && targetContext.limbs.length
    ? targetContext.limbs
    : Object.entries(actor.system?.limbs ?? {}).map(([key, limb]) => ({
      key,
      label: String(limb?.label ?? key),
      value: toInteger(limb?.value),
      min: toInteger(limb?.min),
      max: toInteger(limb?.max),
      missing: Boolean(limb?.missing),
      prosthesis: null
    })))
    .filter(limb => limb.key);
  if (!limbs.length) return [];

  const applicationColumnLabel = game.i18n.localize("FALLOUTMAW.Item.FirstAidSelectLimbsApplications");
  const currentColumnLabel = game.i18n.localize("FALLOUTMAW.Item.FirstAidSelectLimbsCurrent");
  const resultColumnLabel = game.i18n.localize("FALLOUTMAW.Item.FirstAidSelectLimbsResult");
  const rows = limbs.map(limb => {
    const unavailable = Boolean(limb.missing || limb.prosthesis);
    const disabled = unavailable || (value > 0
      ? limb.value >= limb.max
      : value < 0
        ? limb.value <= limb.min
        : false);
    const result = calculateLimbSelectionPreview(limb.value, value, 0, limb.min, limb.max);
    const currentLabel = limb.prosthesis
      ? "Протез"
      : limb.missing
        ? "Отсутствует"
        : `${limb.value} / ${limb.max}`;
    return `
    <button type="button" class="fallout-maw-first-aid-limb-choice${disabled ? " disabled" : ""}" data-limb-key="${escapeHtml(limb.key)}" data-count="0" data-current="${limb.value}" data-min="${limb.min}" data-max="${limb.max}" data-disabled="${disabled ? "true" : "false"}">
      <span class="fallout-maw-first-aid-limb-count">${disabled ? "-" : "0"}</span>
      <span>${escapeHtml(limb.label)}</span>
      <small>${currentLabel}</small>
      <strong data-limb-result>${disabled ? "-" : result}</strong>
    </button>
  `;
  }).join("");

  const result = await DialogV2.wait({
    classes: ["dialog", "fallout-maw", "fallout-maw-first-aid-limb-dialog"],
    position: { width: 680 },
    window: { title: game.i18n.localize("FALLOUTMAW.Item.FirstAidSelectLimbs") },
    content: `
      <div class="fallout-maw-first-aid-limb-summary">
        <p>${game.i18n.format("FALLOUTMAW.Item.FirstAidSelectLimbsHint", { count })}</p>
        <p>${game.i18n.format("FALLOUTMAW.Item.FirstAidSelectLimbsHealing", { value: formatSignedInteger(value) })}</p>
        <p class="fallout-maw-first-aid-limb-total">${game.i18n.localize("FALLOUTMAW.Common.Total")}: <strong><span data-limb-total>0</span> / ${count}</strong></p>
      </div>
      <div class="fallout-maw-first-aid-limb-choice-list">
        <div class="fallout-maw-first-aid-limb-choice-header">
          <span>${applicationColumnLabel}</span>
          <span>${game.i18n.localize("FALLOUTMAW.Item.FirstAidLimbs")}</span>
          <span>${currentColumnLabel}</span>
          <span>${resultColumnLabel}</span>
        </div>
        ${rows}
      </div>
    `,
    render: (_event, dialog) => activateFirstAidLimbSelection(dialog, { count, value }),
    buttons: [
      {
        action: "apply",
        label: "FALLOUTMAW.Common.SaveChanges",
        icon: "fa-solid fa-check",
        default: true,
        disabled: true,
        callback: (_event, button) => {
          const entries = collectFirstAidLimbSelection(button.form);
          const total = entries.reduce((sum, entry) => sum + entry.count, 0);
          if (total < 1 || total > count) {
            ui.notifications.warn(game.i18n.format("FALLOUTMAW.Item.FirstAidSelectLimbsInvalid", { count }));
            return false;
          }
          return entries;
        }
      },
      {
        action: "cancel",
        label: "Cancel",
        icon: "fa-solid fa-xmark",
        callback: () => false
      }
    ]
  });
  return result === false ? null : result;
}

function collectFirstAidLimbSelection(form) {
  return Array.from(form?.querySelectorAll("[data-limb-key]") ?? [])
    .map(row => ({
      limbKey: String(row.dataset.limbKey ?? "").trim(),
      count: Math.max(0, toInteger(row.dataset.count))
    }))
    .filter(entry => entry.limbKey && entry.count > 0);
}

function activateFirstAidLimbSelection(dialog, { count = 0, value = 0 } = {}) {
  const form = dialog.element?.querySelector("form");
  if (!form) return;
  const applyButton = form.querySelector('button[data-action="apply"]');
  const totalElement = form.querySelector("[data-limb-total]");

  const getTotal = () => collectFirstAidLimbSelection(form)
    .reduce((sum, entry) => sum + entry.count, 0);
  const updateRow = row => {
    const rowCount = Math.max(0, toInteger(row.dataset.count));
    const current = toInteger(row.dataset.current);
    const min = toInteger(row.dataset.min);
    const max = toInteger(row.dataset.max);
    row.classList.toggle("selected", rowCount > 0);
    const countElement = row.querySelector(".fallout-maw-first-aid-limb-count");
    const resultElement = row.querySelector("[data-limb-result]");
    if (countElement) countElement.textContent = String(rowCount);
    if (resultElement) resultElement.textContent = String(calculateLimbSelectionPreview(current, value, rowCount, min, max));
  };
  const updateTotal = () => {
    const total = getTotal();
    if (totalElement) totalElement.textContent = String(total);
    if (applyButton) applyButton.disabled = total <= 0;
  };

  for (const row of form.querySelectorAll("[data-limb-key]")) {
    if (row.dataset.disabled === "true") continue;
    row.addEventListener("click", event => {
      event.preventDefault();
      if (getTotal() >= count) {
        ui.notifications.warn(game.i18n.format("FALLOUTMAW.Item.FirstAidSelectLimbsInvalid", { count }));
        return;
      }
      row.dataset.count = String(Math.max(0, toInteger(row.dataset.count)) + 1);
      updateRow(row);
      updateTotal();
    });
    row.addEventListener("contextmenu", event => {
      event.preventDefault();
      row.dataset.count = String(Math.max(0, toInteger(row.dataset.count) - 1));
      updateRow(row);
      updateTotal();
    });
  }
  updateTotal();
}

function calculateLimbSelectionPreview(current, value, count, min, max) {
  const next = toInteger(current) + (toInteger(value) * Math.max(0, toInteger(count)));
  return Math.min(Math.max(toInteger(min), next), toInteger(max));
}

function getInstalledProsthesesByLimb(actor) {
  const entries = new Map();
  for (const item of actor?.items ?? []) {
    if (item?.type !== "gear" || !hasItemFunction(item, ITEM_FUNCTIONS.prosthesis)) continue;
    if (!item.system?.equipped || String(item.system?.placement?.mode ?? "") !== "prosthesis") continue;
    const limbKey = String(item.system?.placement?.limbKey ?? "").trim();
    if (limbKey) entries.set(limbKey, item);
  }
  return entries;
}

function formatSignedInteger(value) {
  const number = toInteger(value);
  return number > 0 ? `+${number}` : String(number);
}

function isConstructActor(actor) {
  const type = String(actor?.system?.creature?.typeId ?? actor?.system?.details?.type?.value ?? "").toLowerCase();
  return type === "construct" || type === "robot" || type === "робот" || type === "конструкт";
}

async function requestFirstAidSocket(action, payload = {}, gm = getResponsibleGM()) {
  if (!gm) throw new Error("нет активного GM");
  const requestId = foundry.utils.randomID();
  const requesterUserId = game.user?.id ?? "";

  const promise = new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingFirstAidSocketRequests.delete(requestId);
      reject(new Error("GM не ответил на запрос первой помощи"));
    }, FIRST_AID_SOCKET_TIMEOUT);
    pendingFirstAidSocketRequests.set(requestId, { resolve, reject, timeout });
  });

  game.socket.emit(FIRST_AID_SOCKET, {
    scope: FIRST_AID_SOCKET_SCOPE,
    type: "request",
    action,
    requestId,
    requesterUserId,
    gmUserId: gm.id,
    payload
  });
  return promise;
}

async function handleFirstAidSocketMessage(message = {}) {
  if (message?.scope !== FIRST_AID_SOCKET_SCOPE) return;

  if (message.type === "response") {
    if (message.recipientUserId && message.recipientUserId !== game.user?.id) return;
    const pending = pendingFirstAidSocketRequests.get(message.requestId);
    if (!pending) return;
    window.clearTimeout(pending.timeout);
    pendingFirstAidSocketRequests.delete(message.requestId);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error || "ошибка GM-сокета первой помощи"));
    return;
  }

  if (message.type !== "request") return;
  if (!game.user?.isGM || message.gmUserId !== game.user.id) return;

  try {
    const result = await handleFirstAidSocketRequest(message.action, message.payload ?? {});
    game.socket.emit(FIRST_AID_SOCKET, {
      scope: FIRST_AID_SOCKET_SCOPE,
      type: "response",
      requestId: message.requestId,
      recipientUserId: message.requesterUserId,
      ok: true,
      result
    });
  } catch (error) {
    console.error(`${SYSTEM_ID} | First aid socket request failed`, error);
    game.socket.emit(FIRST_AID_SOCKET, {
      scope: FIRST_AID_SOCKET_SCOPE,
      type: "response",
      requestId: message.requestId,
      recipientUserId: message.requesterUserId,
      ok: false,
      error: error.message
    });
  }
}

async function handleFirstAidSocketRequest(action, payload = {}) {
  const actor = await fromUuid(String(payload.actorUuid ?? ""));
  if (!actor) throw new Error("цель не найдена");

  if (action === "getTargetContext") {
    return {
      targetContext: {
        ...buildFirstAidTargetContext(actor),
        name: String(payload.tokenName ?? "") || actor.name,
        tokenName: String(payload.tokenName ?? "")
      }
    };
  }

  throw new Error(`неизвестное действие первой помощи: ${action}`);
}

function canUseActorLocally(actor) {
  return Boolean(game.user?.isGM || actor?.isOwner);
}

function getResponsibleGM() {
  return (game.users?.contents ?? [])
    .filter(user => user.active && user.isGM)
    .sort((left, right) => left.id.localeCompare(right.id))
    .at(0) ?? null;
}

async function spendActionPointsIfNeeded(actor, firstAid = {}) {
  const cost = Math.max(0, toInteger(firstAid.actionPointCost));
  if (!cost || !isActorInCombat(actor)) return true;
  const resource = actor.system?.resources?.[ACTION_RESOURCE_KEY];
  const current = Math.max(0, toInteger(resource?.value));
  if (current < cost) {
    ui.notifications.warn(`Недостаточно ОД: требуется ${cost}.`);
    return false;
  }
  await actor.update({ [`system.resources.${ACTION_RESOURCE_KEY}.value`]: current - cost });
  return true;
}

function isActorInCombat(actor) {
  return Boolean(game.combat?.started && game.combat.combatants.some(combatant => combatant.actor?.uuid === actor.uuid));
}

function isTargetInFirstAidRange(sourceToken, targetToken, firstAid = {}) {
  const maxDistance = Number(firstAid.maxDistance) || 0;
  if (maxDistance <= 0 || !sourceToken || !targetToken || sourceToken === targetToken) return true;
  const distance = getTokenDistance(sourceToken, targetToken);
  if (distance <= maxDistance) return true;
  ui.notifications.warn(`Цель слишком далеко (${Math.round(distance)}; максимум: ${maxDistance}).`);
  return false;
}

function getTokenDistance(leftToken, rightToken) {
  const left = getTokenCenter(leftToken);
  const right = getTokenCenter(rightToken);
  const pixels = Math.hypot(right.x - left.x, right.y - left.y);
  const gridDistance = Math.max(0.0001, Number(canvas.scene?.grid?.distance ?? canvas.grid?.distance) || 1);
  const gridSize = Math.max(1, Number(canvas.grid?.size) || 100);
  return Math.max(0, pixels) * (gridDistance / gridSize);
}

function getTokenCenter(token) {
  const center = token?.document?.getCenterPoint?.(token.document._source) ?? token?.center ?? {
    x: (Number(token?.x) || 0) + ((Number(token?.w) || 0) / 2),
    y: (Number(token?.y) || 0) + ((Number(token?.h) || 0) / 2)
  };
  return {
    x: Number(center.x) || 0,
    y: Number(center.y) || 0
  };
}

async function applyCriticalFailureDamage(actor, firstAid = {}, source = {}) {
  const min = Math.max(0, toInteger(firstAid.criticalFailureDamageMin));
  const max = Math.max(min, toInteger(firstAid.criticalFailureDamageMax));
  const amount = min + Math.floor(Math.random() * ((max - min) + 1));
  if (!amount) return;
  await requestDamageApplication({
    actor,
    amount,
    damageTypeKey: "",
    mode: "damage",
    scope: "health",
    applyMitigation: false,
    processDamageTypeSettings: false,
    source: { ...source, criticalFailure: true }
  });
}

async function spendFirstAidItem(item, amount = 1) {
  const quantity = getItemQuantity(item);
  const charges = getFirstAidChargesData(item);
  const cost = Math.max(1, toInteger(amount));
  if (charges.max <= 1) {
    const next = Math.max(0, quantity - 1);
    if (next <= 0) return item.delete();
    return item.update({ "system.quantity": next });
  }

  const remainingCharges = Math.max(0, charges.value - cost);
  if (remainingCharges > 0) {
    return item.update({ "system.functions.firstAid.charges.value": remainingCharges });
  }

  const nextQuantity = Math.max(0, quantity - 1);
  if (nextQuantity <= 0) return item.delete();
  return item.update({
    "system.quantity": nextQuantity,
    "system.functions.firstAid.charges.value": charges.max
  });
}
