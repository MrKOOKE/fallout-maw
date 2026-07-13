import { FALLOUT_MAW } from "../config/system-config.mjs";
import {
  FACTION_MATRIX_SETTING,
  FACTION_SETTINGS_SETTING
} from "./constants.mjs";
import { getMainPresetDefault } from "./presets/manager.mjs";

export const DEFAULT_FACTION_NAME = "\u041d\u0435\u043e\u043f\u0440\u0435\u0434\u0435\u043b\u0435\u043d\u043e";

const RELATIONS = new Set(["ally", "neutral", "enemy"]);

export function createDefaultFactionSettings() {
  return [];
}

export function createDefaultFactionMatrix() {
  return {};
}

export function normalizeFactionSettings(value = []) {
  const source = Array.isArray(value) ? value : Object.values(value ?? {});
  return Array.from(new Set(source
    .map(entry => String(entry ?? "").trim())
    .filter(Boolean)));
}

export function normalizeFactionMatrix(value = {}, factions = []) {
  const names = getFactionNamesWithDefault(factions);
  const source = value && typeof value === "object" ? value : {};
  const matrix = {};

  for (const from of names) {
    matrix[from] = {};
    for (const to of names) {
      matrix[from][to] = from === to ? 0 : getScoreFromMatrix(source, from, to);
    }
  }

  return matrix;
}

export function getFactionNamesWithDefault(factions = []) {
  const names = normalizeFactionSettings(factions).filter(name => name !== DEFAULT_FACTION_NAME);
  return [DEFAULT_FACTION_NAME, ...names];
}

export function getFactionSettings() {
  try {
    return normalizeFactionSettings(game.settings.get(FALLOUT_MAW.id, FACTION_SETTINGS_SETTING));
  } catch (_error) {
    return createDefaultFactionSettings();
  }
}

export async function setFactionSettings(settings) {
  const normalized = normalizeFactionSettings(settings).filter(name => name !== DEFAULT_FACTION_NAME);
  await game.settings.set(FALLOUT_MAW.id, FACTION_SETTINGS_SETTING, normalized);
  await setFactionMatrix(getFactionMatrix(normalized), normalized);
  return normalized;
}

export async function resetFactionSettings() {
  const factions = getMainPresetDefault(FACTION_SETTINGS_SETTING, createDefaultFactionSettings());
  const matrix = getMainPresetDefault(FACTION_MATRIX_SETTING, createDefaultFactionMatrix());
  await game.settings.set(FALLOUT_MAW.id, FACTION_MATRIX_SETTING, matrix);
  await setFactionSettings(factions);
  await setFactionMatrix(matrix, factions);
  return normalizeFactionSettings(factions);
}

export function getFactionMatrix(factions = getFactionSettings()) {
  try {
    return normalizeFactionMatrix(game.settings.get(FALLOUT_MAW.id, FACTION_MATRIX_SETTING), factions);
  } catch (_error) {
    return normalizeFactionMatrix(createDefaultFactionMatrix(), factions);
  }
}

export async function setFactionMatrix(matrix, factions = getFactionSettings()) {
  const normalized = normalizeFactionMatrix(matrix, factions);
  await game.settings.set(FALLOUT_MAW.id, FACTION_MATRIX_SETTING, normalized);
  return normalized;
}

export function getFactionScore(fromFaction, toFaction, matrix = getFactionMatrix()) {
  const from = normalizeFactionName(fromFaction, DEFAULT_FACTION_NAME);
  const to = normalizeFactionName(toFaction, DEFAULT_FACTION_NAME);
  if (!from || !to || from === to) return 0;
  return getScoreFromMatrix(matrix, from, to);
}

export function setFactionScoreMutable(matrix, fromFaction, toFaction, value) {
  const from = normalizeFactionName(fromFaction, DEFAULT_FACTION_NAME);
  const to = normalizeFactionName(toFaction, DEFAULT_FACTION_NAME);
  if (!from || !to) return;
  const score = clampFactionScore(value);
  matrix[from] ??= {};
  matrix[to] ??= {};
  matrix[from][to] = score;
  matrix[to][from] = score;
}

export function getRelationFromScore(score) {
  const value = clampFactionScore(score);
  if (value >= 61) return "ally";
  if (value <= -40) return "enemy";
  return "neutral";
}

export function getActorFactionBelongs(actor) {
  const belongs = actor?.getFlag?.(FALLOUT_MAW.id, "factionBelongs");
  return normalizeFactionSettings(Array.isArray(belongs) ? belongs : []);
}

export function getActorPrimaryFaction(actor) {
  return getActorFactionBelongs(actor)[0] || DEFAULT_FACTION_NAME;
}

export async function setActorFactionBelongs(actor, belongs) {
  const normalized = normalizeFactionSettings(belongs);
  await actor?.setFlag?.(FALLOUT_MAW.id, "factionBelongs", normalized.length ? normalized : [DEFAULT_FACTION_NAME]);
  return normalized;
}

export function getActorFactionRelations(actor) {
  const source = actor?.getFlag?.(FALLOUT_MAW.id, "factionRelations");
  if (!source || typeof source !== "object") return {};
  return Object.fromEntries(Object.entries(source)
    .map(([name, relation]) => [String(name ?? "").trim(), RELATIONS.has(relation) ? relation : "neutral"])
    .filter(([name]) => Boolean(name)));
}

export async function setActorFactionRelations(actor, relations = {}) {
  const normalized = {};
  for (const [name, relation] of Object.entries(relations ?? {})) {
    const factionName = String(name ?? "").trim();
    if (!factionName) continue;
    normalized[factionName] = RELATIONS.has(relation) ? relation : "neutral";
  }
  await actor?.setFlag?.(FALLOUT_MAW.id, "factionRelations", normalized);
  return normalized;
}

export function getRelationTo(actor, factionName) {
  const target = normalizeFactionName(factionName, DEFAULT_FACTION_NAME);
  if (!target) return "neutral";
  const primary = getActorPrimaryFaction(actor);
  if (primary === target) return "ally";
  const score = getFactionScore(primary, target);
  if (Number.isFinite(score)) return getRelationFromScore(score);
  return getActorFactionRelations(actor)[target] ?? "neutral";
}

export function registerFactionApi() {
  const api = {
    defaultFactionName: DEFAULT_FACTION_NAME,
    getFactions: getFactionSettings,
    setFactions: setFactionSettings,
    getMatrix: getFactionMatrix,
    setMatrix: setFactionMatrix,
    getFactionScore,
    setFactionScoreMutable,
    getRelationFromScore,
    getRelationTo,
    getActorBelongs: getActorFactionBelongs,
    setActorBelongs: setActorFactionBelongs,
    getActorRelations: getActorFactionRelations,
    setActorRelations: setActorFactionRelations,
    getActorPrimaryFaction
  };

  FALLOUT_MAW.factionsApi = api;
  if (globalThis.CONFIG?.FalloutMaW) globalThis.CONFIG.FalloutMaW.factions = api;
  if (globalThis.game?.system) {
    game.system.api = foundry.utils.mergeObject(game.system.api ?? {}, { factions: api }, { inplace: false });
  }
  globalThis.falloutMaWFactions = api;
  return api;
}

function normalizeFactionName(value, fallback = "") {
  return String(value ?? "").trim() || fallback;
}

function getScoreFromMatrix(matrix = {}, fromFaction, toFaction) {
  const direct = Number(matrix?.[fromFaction]?.[toFaction]);
  const reverse = Number(matrix?.[toFaction]?.[fromFaction]);
  if (Number.isFinite(direct)) return clampFactionScore(direct);
  if (Number.isFinite(reverse)) return clampFactionScore(reverse);
  return 0;
}

function clampFactionScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(-100, Math.min(100, Math.round(number)));
}
