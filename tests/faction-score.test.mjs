import assert from "node:assert/strict";
import test from "node:test";
import { FACTION_MATRIX_SETTING, FACTION_SETTINGS_SETTING } from "../src/settings/constants.mjs";
import {
  DEFAULT_FACTION_NAME, getFactionMatrix, getFactionScore, getRelationTo,
  normalizeFactionMatrix, normalizeFactionSettings
} from "../src/settings/factions.mjs";

function settingsFixture(factions, matrix) {
  const state = { factions, matrix };
  globalThis.game = { settings: { get(_scope, key) {
    if (key === FACTION_SETTINGS_SETTING) return state.factions;
    if (key === FACTION_MATRIX_SETTING) return state.matrix;
    throw new Error(`Unexpected setting ${key}`);
  } } };
  return state;
}

test("configured scalar scores match full matrix projection across defaults and malformed values", () => {
  const factionCases = [[], ["A", "B", "C", "A", "  B  ", ""], { a:"A", b:"B" }, null, ["0", "1"]];
  const matrixCases = [
    {}, null, "11", [],
    { A:{B:62.6,C:-200,ghost:90}, B:{A:-50,C:"invalid"}, C:{B:41} },
    { A:{B:null,C:false}, B:{A:100,C:"-39.6"}, C:{A:NaN,B:Infinity} },
    { [DEFAULT_FACTION_NAME]:{A:74}, A:{[DEFAULT_FACTION_NAME]:-41} },
    { 0:{1:88}, 1:{0:-40} }
  ];
  const names = ["A","B","C","ghost","",undefined,"  A  ",DEFAULT_FACTION_NAME,"0","1"];
  for (const factions of factionCases) for (const matrix of matrixCases) {
    settingsFixture(factions,matrix);
    const expected = normalizeFactionMatrix(matrix,normalizeFactionSettings(factions));
    for (const from of names) for (const to of names) {
      assert.equal(getFactionScore(from,to),getFactionScore(from,to,expected),`pair ${from} -> ${to}`);
    }
  }
});

test("provided matrices retain arbitrary faction names, direction priority and fallback", () => {
  globalThis.game = { settings:{ get(){throw new Error("Provided matrix must not read settings");} } };
  const matrix = { outsider:{other:-40.4}, other:{outsider:90} };
  assert.equal(getFactionScore("outsider","other",matrix),-40);
  assert.equal(getFactionScore("other","outsider",matrix),90);
  assert.equal(getFactionScore("outsider","other",{other:{outsider:130}}),100);
  assert.equal(getFactionScore("outsider","other",null),0);
  assert.equal(getFactionScore("outsider","outsider",matrix),0);
});

test("membership, in-place score edits and matrix replacement affect the next relation check", () => {
  const state = settingsFixture(["A","B"],{A:{B:60}});
  const actor = {getFlag:(_scope,key)=>key==="factionBelongs"?["A"]:undefined};
  assert.equal(getRelationTo(actor,"B"),"neutral");
  state.matrix.A.B=61;
  assert.equal(getRelationTo(actor,"B"),"ally");
  state.matrix={B:{A:-40}};
  assert.equal(getRelationTo(actor,"B"),"enemy");
  state.factions.splice(state.factions.indexOf("B"),1);
  assert.equal(getRelationTo(actor,"B"),"neutral");
  state.factions.push("B");
  assert.equal(getRelationTo(actor,"B"),"enemy");
});

test("scalar lookup reads only the requested pair and does not materialize unrelated cells", () => {
  let unrelatedReads=0;
  const unrelated={};
  Object.defineProperty(unrelated,"A",{enumerable:true,get(){unrelatedReads++;return 90;}});
  settingsFixture(["A","B","C"],{A:{B:70},C:unrelated});
  assert.equal(getFactionScore("A","B"),70);
  assert.equal(unrelatedReads,0);
  assert.equal(getFactionMatrix().C.A,90);
  assert.ok(unrelatedReads>0,"full editable matrix still projects every pair");
});

test("unavailable settings remain neutral and editable matrix copies stay independent", () => {
  globalThis.game={settings:{get(){throw new Error("Settings unavailable");}}};
  assert.equal(getFactionScore("A","B"),0);
  assert.equal(getFactionScore(DEFAULT_FACTION_NAME,"A"),0);
  const state=settingsFixture(["A","B"],{A:{B:70}});
  const editable=getFactionMatrix();editable.A.B=-100;
  assert.equal(state.matrix.A.B,70);
  assert.equal(getFactionScore("A","B"),70);
});
