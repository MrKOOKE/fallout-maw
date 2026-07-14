import {
  ABILITY_ACTION_POINT_COST_MODES,
  ABILITY_ACTION_TARGET_MODES,
  ABILITY_ATTACK_ACTION_ALL,
  ABILITY_ATTACKING_WEAPON_ACTION_KEYS,
  normalizeAbilityAction
} from "../settings/abilities.mjs";
import {
  executeWeaponAttackAgainstToken,
  getActionAttackCount,
  getMissingWeaponResourceCost,
  getWeaponActionPointCost,
  getWeaponAttackData,
  hasWeaponAction,
  isWeaponPlacementDisabled,
  startConstrainedAimedAttackSelection,
  startWeaponAttackAndWait
} from "../combat/weapon-attack-controller.mjs";
import {
  canSpendStrictActionPoints,
  getStrictActionPointState,
  spendStrictActionPoints
} from "../combat/reaction-resources.mjs";
import { getReactionTimeoutMs, getResponsibleOwner } from "../combat/reaction-hub.mjs";
import { getWeaponActionBlockState } from "./runtime-state.mjs";
import {
  ITEM_FUNCTIONS,
  getEnabledWeaponFunctions,
  hasItemFunction
} from "../utils/item-functions.mjs";
import {
  getEventParticipantActorUuid,
  getEventParticipantTokenUuid
} from "../events/event-reaction-schema.mjs";
import { withSystemEventRoot } from "../events/dispatcher.mjs";

const { DialogV2 } = foundry.applications.api;
const FormDataExtended = foundry.applications.ux.FormDataExtended;
const ATTACK_QUERY = "fallout-maw.abilityAction.attack";
const ATTACK_SELECTION_QUERY = "fallout-maw.abilityAction.select";

export function registerAbilityActionQueries() {
  if (!globalThis.CONFIG?.queries) return;
  CONFIG.queries[ATTACK_QUERY] = handleAbilityActionAttackQuery;
  CONFIG.queries[ATTACK_SELECTION_QUERY] = handleAbilityActionSelectionQuery;
}

export function collectAbilityWeaponAttackOptions(actor, actionSource = {}) {
  const action = normalizeAbilityAction(actionSource);
  const allowedKeys = action.attackActionKeys.includes(ABILITY_ATTACK_ACTION_ALL)
    ? ABILITY_ATTACKING_WEAPON_ACTION_KEYS
    : action.attackActionKeys;
  const options = [];
  for (const weapon of actor?.items?.contents ?? actor?.items ?? []) {
    const placement = weapon?.system?.placement ?? {};
    if (weapon?.type !== "gear" || placement.mode !== "weapon" || !placement.weaponSet) continue;
    if (!hasItemFunction(weapon, ITEM_FUNCTIONS.weapon) || isWeaponPlacementDisabled(actor, weapon)) continue;
    for (const weaponFunction of getEnabledWeaponFunctions(weapon)) {
      const weaponFunctionId = String(weaponFunction?.id ?? ITEM_FUNCTIONS.weapon);
      if (!getWeaponAttackData(weapon, weaponFunctionId)?.enabled) continue;
      for (const actionKey of allowedKeys) {
        if (!hasWeaponAction(weapon, actionKey, weaponFunctionId)) continue;
        if (getWeaponActionBlockState(actor, actionKey).blocked) continue;
        const attackCount = getActionAttackCount(weapon, actionKey, weaponFunctionId);
        if (getMissingWeaponResourceCost(weapon, attackCount, weaponFunctionId)) continue;
        const actionPointCost = getConfiguredActionPointCost(actor, weapon, actionKey, weaponFunctionId, action);
        if (!canAffordConfiguredActionPointCost(actor, actionPointCost)) continue;
        options.push({
          actionId: action.id,
          action,
          actionKey,
          actionLabel: getWeaponActionLabel(actionKey),
          weapon,
          weaponUuid: String(weapon.uuid ?? ""),
          weaponFunctionId,
          weaponFunctionName: String(weaponFunction?.name ?? ""),
          actionPointCost,
          id: [action.id, actionKey, weapon.uuid, weaponFunctionId].join("|")
        });
      }
    }
  }
  return options;
}

export function getConfiguredActionPointCost(actor, weapon, actionKey, weaponFunctionId, actionSource = {}) {
  if (!globalThis.game?.combat?.started) return 0;
  const action = normalizeAbilityAction(actionSource);
  if (action.actionPointCostMode === ABILITY_ACTION_POINT_COST_MODES.none) return 0;
  if (action.actionPointCostMode === ABILITY_ACTION_POINT_COST_MODES.fixed) {
    return Math.max(0, Math.trunc(Number(action.fixedActionPointCost) || 0));
  }
  const actual = getWeaponActionPointCost(actor, weapon, actionKey, weaponFunctionId);
  return Math.max(0, Math.ceil(actual * Math.max(0, Number(action.actualActionPointCostPercent) || 0) / 100));
}

export function buildAbilityActionPointCostLine(actor, amount = 0) {
  const cost = Math.max(0, Math.trunc(Number(amount) || 0));
  if (!cost) return "";
  return `${game.i18n.localize("FALLOUTMAW.Ability.Actions.ActionPoints")}: ${cost}`;
}

export async function resolveAbilityActionTriggerTarget(envelope = {}) {
  const tokenUuid = getEventParticipantTokenUuid(envelope?.source);
  const actorUuid = getEventParticipantActorUuid(envelope?.source);
  let resolved = null;
  let path = "none";
  if (tokenUuid) {
    const token = await globalThis.fromUuid?.(tokenUuid);
    const tokenObject = token?.object ?? token ?? null;
    if (tokenObject?.actor) {
      resolved = tokenObject;
      path = "sourceTokenUuid";
    }
  }
  if (!resolved && actorUuid) {
    const actor = await globalThis.fromUuid?.(actorUuid);
    resolved = canvas?.tokens?.placeables?.find(token => token?.actor?.uuid === actor?.uuid)
      ?? actor?.getActiveTokens?.()?.find(token => token?.scene?.id === canvas?.scene?.id)
      ?? null;
    path = resolved ? "sourceActorUuidFallback" : "actorUuidMiss";
  }
  return resolved;
}

export async function executeAbilityWeaponAttackOption({
  actor = null,
  option = null,
  targetToken = null,
  chainRef = null,
  damageHubOperationRef = "",
  ignoreReactionLock = false
} = {}) {
  const freshOption = findFreshOption(actor, option);
  const freeTarget = freshOption?.action?.targetMode === ABILITY_ACTION_TARGET_MODES.free;
  if (!freshOption || (!freeTarget && !targetToken?.actor)) return false;
  const owner = getResponsibleOwner(actor) ?? game.users?.activeGM ?? null;
  const attackerToken = getPrimaryActorToken(actor);
  if (!owner || !attackerToken?.actor) return false;
  const timeoutMs = getReactionTimeoutMs();
  const data = {
    executionId: foundry.utils.randomID(),
    actorUuid: String(actor.uuid ?? ""),
    attackerTokenUuid: String(attackerToken.document?.uuid ?? attackerToken.uuid ?? ""),
    targetTokenUuid: freeTarget ? "" : String(targetToken?.document?.uuid ?? targetToken?.uuid ?? ""),
    weaponUuid: freshOption.weaponUuid,
    weaponFunctionId: freshOption.weaponFunctionId,
    actionKey: freshOption.actionKey,
    targetMode: freshOption.action.targetMode,
    actionPointCost: freshOption.actionPointCost,
    chainRef,
    damageHubOperationRef: String(damageHubOperationRef ?? ""),
    ignoreReactionLock,
    timeoutMs
  };
  try {
    return Boolean(owner.isSelf
      ? await handleAbilityActionAttackQuery(data)
      : await owner.query(ATTACK_QUERY, data));
  } catch (error) {
    console.warn("fallout-maw | Ability action execution query failed", error);
    return false;
  }
}

export async function executeAbilityFunctionActions({
  actor = null,
  abilityFunction = {},
  triggerTargets = [],
  title = "",
  chainRef = null,
  ignoreReactionLock = false
} = {}) {
  const prepared = await prepareAbilityFunctionActions({ actor, abilityFunction, triggerTargets, title });
  if (prepared.cancelled) return { attempted: 0, executed: 0, cancelled: true };
  return executePreparedAbilityFunctionActions({ actor, executions: prepared.executions, chainRef, ignoreReactionLock });
}

export async function prepareAbilityFunctionActions({
  actor = null,
  abilityFunction = {},
  triggerTargets = [],
  title = ""
} = {}) {
  const executions = [];
  for (const action of abilityFunction?.actions ?? []) {
    const options = collectAbilityWeaponAttackOptions(actor, action);
    const option = await requestAbilityWeaponAttackOption(options, { title });
    if (!option) return { executions: [], cancelled: true };
    const targets = action.targetMode === ABILITY_ACTION_TARGET_MODES.free
      ? [null]
      : triggerTargets.map(target => target?.token ?? target).filter(Boolean);
    if (!targets.length) return { executions: [], cancelled: true };
    for (const targetToken of targets) executions.push({ option, targetToken });
  }
  return { executions, cancelled: false };
}

export async function executePreparedAbilityFunctionActions({
  actor = null,
  executions = [],
  chainRef = null,
  ignoreReactionLock = false
} = {}) {
  let attempted = 0;
  let executed = 0;
  for (const execution of executions) {
    attempted += 1;
    if (await executeAbilityWeaponAttackOption({ actor, ...execution, chainRef, ignoreReactionLock })) executed += 1;
  }
  return { attempted, executed, cancelled: false };
}

export async function requestAbilityWeaponAttackOption(options = [], { title = "" } = {}) {
  if (!options.length) return null;
  if (options.length === 1) return options[0];
  const weaponGroups = groupAbilityAttackOptionsByWeapon(options);
  let selectedGroup = weaponGroups[0] ?? null;
  if (weaponGroups.length > 1) {
    const weaponRows = weaponGroups.map((group, index) => `
      <label class="fallout-maw-radio-card fallout-maw-weapon-choice-card">
        <input type="radio" name="weaponUuid" value="${escapeAttribute(group.weaponUuid)}" ${index === 0 ? "checked" : ""}>
        <img src="${escapeAttribute(group.img)}" alt="">
        <span><strong>${escapeHTML(group.name)}</strong></span>
      </label>
    `).join("");
    const weaponData = await DialogV2.input({
      window: { title: buildAbilityActionDialogTitle(title, "SelectWeapon") },
      content: `<div class="fallout-maw-disarm-choice-grid">${weaponRows}</div>`,
      ok: {
        label: game.i18n.localize("FALLOUTMAW.Ability.Actions.Next"),
        icon: "fa-solid fa-arrow-right",
        callback: (_event, button) => new FormDataExtended(button.form).object
      },
      buttons: [{ action: "cancel", label: game.i18n.localize("FALLOUTMAW.Common.Cancel") }],
      position: { width: 520 },
      rejectClose: false
    });
    selectedGroup = weaponGroups.find(group => group.weaponUuid === String(weaponData?.weaponUuid ?? "")) ?? null;
    if (!selectedGroup) return null;
  }
  if (!selectedGroup) return null;
  if (selectedGroup.options.length === 1) return selectedGroup.options[0];

  const actionRows = selectedGroup.options.map((option, index) => `
    <label class="fallout-maw-radio-card">
      <input type="radio" name="optionId" value="${escapeAttribute(option.id)}" ${index === 0 ? "checked" : ""}>
      <span><strong>${escapeHTML(option.actionLabel || getWeaponActionLabel(option.actionKey))}</strong>${formatActionOptionDetails(option)}</span>
    </label>
  `).join("");
  const actionData = await DialogV2.input({
    window: { title: buildAbilityActionDialogTitle(title, "SelectAction") },
    content: `<div class="fallout-maw-disarm-choice-grid"><p>${escapeHTML(game.i18n.localize("FALLOUTMAW.Ability.Actions.Weapon"))}: <strong>${escapeHTML(selectedGroup.name)}</strong></p>${actionRows}</div>`,
    ok: {
      label: game.i18n.localize("FALLOUTMAW.Ability.Actions.Execute"),
      icon: "fa-solid fa-crosshairs",
      callback: (_event, button) => new FormDataExtended(button.form).object
    },
    buttons: [{ action: "cancel", label: game.i18n.localize("FALLOUTMAW.Common.Cancel") }],
    position: { width: 520 },
    rejectClose: false
  });
  const optionId = String(actionData?.optionId ?? "");
  return selectedGroup.options.find(option => option.id === optionId) ?? null;
}

export async function selectAbilityWeaponAttackOption(actor, options = [], { title = "" } = {}) {
  if (!options.length) return null;
  if (options.length === 1) return options[0];
  const owner = getResponsibleOwner(actor) ?? game.users?.activeGM ?? null;
  if (!owner) return null;
  const timeoutMs = getReactionTimeoutMs();
  const query = {
    actorUuid: String(actor?.uuid ?? ""),
    title: String(title ?? ""),
    options: options.map(serializeAbilityAttackSelectionOption)
  };
  try {
    const response = owner.isSelf
      ? await handleAbilityActionSelectionQuery(query)
      : await owner.query(ATTACK_SELECTION_QUERY, query, { timeout: (timeoutMs * 2) + 2000 });
    const optionId = String(response?.optionId ?? "");
    return options.find(option => option.id === optionId) ?? null;
  } catch (error) {
    console.warn("fallout-maw | Ability attack selection query failed", error);
    return null;
  }
}

function findFreshOption(actor, option) {
  if (!option?.action) return null;
  return collectAbilityWeaponAttackOptions(actor, option.action).find(candidate => (
    candidate.actionKey === option.actionKey
    && candidate.weaponUuid === option.weaponUuid
    && candidate.weaponFunctionId === option.weaponFunctionId
    && candidate.actionPointCost === option.actionPointCost
  )) ?? null;
}

function canAffordConfiguredActionPointCost(actor, amount) {
  if (!game.combat?.started || amount <= 0) return true;
  const state = getStrictActionPointState(actor);
  return Boolean(state && amount <= state.current);
}

async function handleAbilityActionAttackQuery(data = {}) {
  const executionId = String(data.executionId ?? "").trim() || foundry.utils.randomID();
  return withSystemEventRoot({
    kind: "abilityActionAttack",
    operationId: `ability-action-attack:${executionId}`,
    sceneUuid: getSceneUuidFromTokenUuid(data.attackerTokenUuid),
    combatUuid: String(game.combat?.uuid ?? ""),
    chainRef: data.chainRef ?? null
  }, scope => executeAbilityActionAttackQuery(data, scope.chainRef));
}

async function executeAbilityActionAttackQuery(data = {}, chainRef = null) {
  const actor = data.actorUuid ? await globalThis.fromUuid?.(data.actorUuid) : null;
  const attackerTokenDocument = data.attackerTokenUuid ? await globalThis.fromUuid?.(data.attackerTokenUuid) : null;
  const targetTokenDocument = data.targetTokenUuid ? await globalThis.fromUuid?.(data.targetTokenUuid) : null;
  const weapon = data.weaponUuid ? await globalThis.fromUuid?.(data.weaponUuid) : null;
  const attackerToken = attackerTokenDocument?.object ?? attackerTokenDocument ?? null;
  const targetToken = targetTokenDocument?.object ?? targetTokenDocument ?? null;
  if (!actor?.isOwner || attackerToken?.actor?.uuid !== actor.uuid || weapon?.parent?.uuid !== actor.uuid) return false;

  const actionKey = String(data.actionKey ?? "");
  const weaponFunctionId = String(data.weaponFunctionId ?? "");
  const actionPointCost = Math.max(0, Math.trunc(Number(data.actionPointCost) || 0));
  const onBeforeExecute = async () => {
    if (actionPointCost <= 0) return true;
    if (!canSpendStrictActionPoints(actor, actionPointCost, { label: getWeaponActionLabel(actionKey) })) return false;
    await spendStrictActionPoints(actor, actionPointCost, {
      source: "abilityAction",
      actionKey,
      chainRef
    });
    return true;
  };

  if (data.targetMode === ABILITY_ACTION_TARGET_MODES.free) {
    return startWeaponAttackAndWait({
      token: attackerToken,
      weapon,
      actionKey,
      weaponFunctionId,
      chainRef,
      damageHubOperationRef: data.damageHubOperationRef,
      onBeforeExecute,
      skipActionPointCost: true,
      ignoreReactionLock: Boolean(data.ignoreReactionLock),
      suspendActiveAttack: true,
      timeoutMs: data.timeoutMs
    });
  }
  if (!targetToken?.actor) return false;
  if (["aimedShot", "aimedMeleeAttack"].includes(actionKey)) {
    return startConstrainedAimedAttackSelection({
      attackerToken,
      targetToken,
      weapon,
      actionKey,
      weaponFunctionId,
      chainRef,
      damageHubOperationRef: data.damageHubOperationRef,
      onBeforeExecute,
      timeoutMs: data.timeoutMs
    });
  }
  return executeWeaponAttackAgainstToken({
    attackerToken,
    targetToken,
    weapon,
    actionKey,
    weaponFunctionId,
    chainRef,
    damageHubOperationRef: data.damageHubOperationRef,
    onBeforeExecute,
    skipActionPointCost: true,
    ignoreReactionLock: Boolean(data.ignoreReactionLock),
    suspendActiveAttack: true
  });
}

function getSceneUuidFromTokenUuid(tokenUuid = "") {
  return String(tokenUuid ?? "").match(/^(Scene\.[^.]+)/)?.[1]
    ?? String(canvas?.scene?.uuid ?? "");
}

async function handleAbilityActionSelectionQuery(data = {}) {
  const actor = data.actorUuid ? await globalThis.fromUuid?.(data.actorUuid) : null;
  if (!actor?.isOwner) return null;
  const option = await requestAbilityWeaponAttackOption(
    Array.isArray(data.options) ? data.options : [],
    { title: String(data.title ?? "") }
  );
  return option ? { optionId: String(option.id ?? "") } : null;
}

function getPrimaryActorToken(actor) {
  return canvas?.tokens?.controlled?.find(token => token?.actor?.uuid === actor?.uuid)
    ?? canvas?.tokens?.placeables?.find(token => token?.actor?.uuid === actor?.uuid)
    ?? actor?.getActiveTokens?.()?.[0]
    ?? null;
}

function getWeaponActionLabel(actionKey) {
  const keys = {
    aimedShot: "WeaponActionAimedShot",
    snapshot: "WeaponActionSnapshot",
    burst: "WeaponActionBurst",
    volley: "WeaponActionVolley",
    meleeAttack: "WeaponActionMeleeAttack",
    aimedMeleeAttack: "WeaponActionAimedMeleeAttack",
    push: "WeaponActionPush"
  };
  return game.i18n.localize(`FALLOUTMAW.Item.${keys[actionKey] ?? actionKey}`);
}

function groupAbilityAttackOptionsByWeapon(options = []) {
  const groups = new Map();
  for (const option of options) {
    const weaponUuid = String(option?.weaponUuid ?? option?.weapon?.uuid ?? "");
    if (!weaponUuid) continue;
    const group = groups.get(weaponUuid) ?? {
      weaponUuid,
      name: String(option?.weaponName ?? option?.weapon?.name ?? weaponUuid),
      img: String(option?.weaponImg ?? option?.weapon?.img ?? "icons/svg/sword.svg"),
      options: []
    };
    group.options.push(option);
    groups.set(weaponUuid, group);
  }
  return Array.from(groups.values());
}

function serializeAbilityAttackSelectionOption(option = {}) {
  return {
    id: String(option.id ?? ""),
    weaponUuid: String(option.weaponUuid ?? option.weapon?.uuid ?? ""),
    weaponName: String(option.weapon?.name ?? ""),
    weaponImg: String(option.weapon?.img ?? "icons/svg/sword.svg"),
    weaponFunctionId: String(option.weaponFunctionId ?? ""),
    weaponFunctionName: String(option.weaponFunctionName ?? ""),
    actionKey: String(option.actionKey ?? ""),
    actionPointCost: Math.max(0, Math.trunc(Number(option.actionPointCost) || 0))
  };
}

function buildAbilityActionDialogTitle(title = "", localizationKey = "SelectAttack") {
  const step = game.i18n.localize(`FALLOUTMAW.Ability.Actions.${localizationKey}`);
  return title ? `${title}: ${step}` : step;
}

function formatActionOptionDetails(option) {
  const functionName = String(option.weaponFunctionName ?? "").trim();
  const costLine = buildAbilityActionPointCostLine(option.weapon?.parent, option.actionPointCost);
  const details = [functionName, costLine].filter(Boolean);
  return details.length ? `<br>${escapeHTML(details.join(" · "))}` : "";
}

function escapeHTML(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

function escapeAttribute(value) {
  return escapeHTML(value).replaceAll('"', "&quot;");
}
