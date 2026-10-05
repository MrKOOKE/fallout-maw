import test from "node:test";
import assert from "node:assert/strict";
function getProperty(object, path) { return path.split(".").reduce((value,key)=>value?.[key],object); }
function setProperty(object, path, value) { const keys=path.split("."),last=keys.pop(); for(const key of keys) object=object[key]??= {}; object[last]=value; }
globalThis.foundry = { applications: { api: { ApplicationV2: class { static DEFAULT_OPTIONS={}; async _onRender() {} }, HandlebarsApplicationMixin: Base=>Base, DialogV2: class {} },
  ux: { FormDataExtended: class {} }, handlebars: {renderTemplate:()=>""} }, utils: { deepClone: structuredClone, randomID: ()=>"new-id",getProperty,setProperty } };
globalThis.game = { user: { isGM: true } };
const warnings=[];
globalThis.ui = { notifications: { warn: message=>warnings.push(message) } };
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
const { ConstructVisualEditor } = await import("../src/apps/construct-visual-editor.mjs");
const { ConstructSystemsConfig } = await import("../src/apps/construct-systems-config.mjs");
const { allocateInventoryCreateIds } = await import("../src/inventory/mutation.mjs");

function fixture() {
  const flags={"fallout-maw":{constructVisual:{enabled:true,parts:[],anchors:[],seats:[]}}};
  const actor={isOwner:true,type:"construct",name:"Tank",flags,items:{contents:[]},system:{constructSystems:[{id:"drive",name:"Drive",active:true,recoveryMethods:[],sounds:{}}]},
    getFlag:(scope,key)=>flags[scope]?.[key],update:()=>{throw Error("draft validation must not write to the Actor")}};
  return actor;
}
test("unified save collects validated visual/interior and systems updates without any intermediate document writes", () => {
  const actor=fixture(),visual=new ConstructVisualEditor(actor),systems=new ConstructSystemsConfig(actor);
  const visualUpdate=visual.getActorUpdate(),systemUpdate=systems.getActorUpdate();
  assert.equal(visualUpdate["flags.fallout-maw.constructVisual"].enabled,true);
  assert.deepEqual(visualUpdate["flags.fallout-maw.constructInterior"].parts,[]);
  assert.equal(systemUpdate["system.constructSystems"][0].active,true);
});
test("invalid duplicate roles or dangling physical seats abort unified visual save before document updates", () => {
  const actor=fixture(),visual=new ConstructVisualEditor(actor);
  visual.draft.seats.push({id:"one",slotId:"missing",slotIndex:0,role:"driver",functions:["move"]});
  assert.equal(visual.getActorUpdate(),undefined);
  assert.match(warnings.at(-1),/физическое место/);
  visual.draft.seats.push({id:"two",slotId:"missing",slotIndex:0,role:"gunner",functions:["fire"]});
  assert.equal(visual.getActorUpdate(),undefined);
  assert.match(warnings.at(-1),/Одно физическое место/);
});
test("system keys are validated and runtime activation is retained from the real Actor", () => {
  const actor=fixture(),systems=new ConstructSystemsConfig(actor);
  systems.draft[0].active=false;
  assert.equal(systems.getActorUpdate()["system.constructSystems"][0].active,true);
  systems.draft.push({...systems.draft[0]});
  assert.equal(systems.getActorUpdate(),undefined);
  assert.match(warnings.at(-1),/уникальны/);
});
test("preallocated compartment IDs survive the atomic creation plan, keeping crew and container references valid", () => {
  const actor=fixture(),id="newCompartment01",childId="newContainer0001";
  const original=[{_id:id,system:{container:{parentId:""}}},{_id:childId,system:{container:{parentId:id}}}];
  const {creates,createIdMap}=allocateInventoryCreateIds(actor,original,{preserveIds:true});
  assert.deepEqual(creates.map(row=>row._id),[id,childId]);
  assert.equal(creates[1].system.container.parentId,id);
  assert.equal(createIdMap.get(id),id);
  assert.deepEqual(original.map(row=>row._id),[id,childId]);
});
test("an occupied, invalid or duplicate preallocated ID rejects the whole create plan before writes", () => {
  const actor=fixture(),id="occupiedItem0001";
  actor.items.contents.push({_id:id,id});
  assert.throws(()=>allocateInventoryCreateIds(actor,[{_id:id}],{preserveIds:true}),/already in use/);
  assert.throws(()=>allocateInventoryCreateIds(actor,[{_id:"invalid"}],{preserveIds:true}),/invalid/);
  assert.throws(()=>allocateInventoryCreateIds(actor,[{_id:"newCompartment01"},{_id:"newCompartment01"}],{preserveIds:true}),/duplicate/);
});
function mount(editor, actor) {
  const handlers = new Map();
  const element={addEventListener:(name,callback)=>handlers.set(name,callback),querySelector:()=>null,querySelectorAll:()=>[]};
  editor.attachHub({element,draftActor:actor,render:()=>{throw Error("typing must not replace the focused form")}});
  return {element,handlers};
}
test("typed system text and numbers enter the shared draft without waiting for blur or replacing focused inputs", async () => {
  const actor=fixture(),editor=new ConstructSystemsConfig(actor),mounted=mount(editor,actor);
  await editor._onRender({},{});
  const field={dataset:{systemField:"name"},type:"text",value:"New drive",closest: selector=>selector==="[data-system-field]"?field:null};
  mounted.handlers.get("input")({target:field});
  assert.equal(editor.draft[0].name,"New drive");
  field.dataset.systemField="energyPerMovementPoint";field.type="number";field.value="2";
  mounted.handlers.get("input")({target:field});
  assert.equal(editor.draft[0].energyPerMovementPoint,2);
});
test("precise pivot and rotation values enter the visual draft on input without a blur or document write", async () => {
  const actor=fixture(),editor=new ConstructVisualEditor(actor),mounted=mount(editor,actor);
  editor.draft.parts.push({id:"layer",slotId:"hull",rotationSpeed:180,pivotX:.5});
  await editor._onRender({},{});
  const field={dataset:{visualKind:"parts",visualIndex:"0",visualKey:"pivotX"},type:"number",value:"0.6665265003017262",
    matches: selector=>selector==="[data-visual-key]"};
  mounted.handlers.get("input")({target:field});
  assert.equal(editor.draft.parts[0].pivotX,.6665265003017262);
  field.dataset.visualKey="rotationSpeed";field.value="180";
  mounted.handlers.get("input")({target:field});
  assert.equal(editor.draft.parts[0].rotationSpeed,180);
});

function mountPreview(editor, actor) {
  const events = new Map(), pointerEvents = new Map();
  const doc = { createDocumentFragment: () => ({ children: [], append(child) { this.children.push(child); } }),
    createElement: () => ({ dataset: {}, style: {} }) };
  const preview = { ownerDocument: doc, children: [], classList: { toggle() {} },
    addEventListener: (name, callback) => pointerEvents.set(name, callback),
    replaceChildren(fragment) { this.children = fragment.children; }, setPointerCapture() {},
    getBoundingClientRect: () => ({ left: 110, top: 80, width: 600, height: 1000 }) };
  const element = { addEventListener: (name, callback) => events.set(name, callback),
    querySelector: selector => selector === "[data-visual-preview]" ? preview : null, querySelectorAll: () => [] };
  let dirty = 0;
  editor.attachHub({ element, draftActor: actor, markDraftDirty: () => dirty++,
    render: () => { throw Error("preview-only controls must not rerender the hub"); } });
  return { events, pointerEvents, preview, dirty: () => dirty };
}

test("anchors are visible immediately and their display toggle leaves the model enabled and the draft clean", async () => {
  const actor = fixture();
  actor.flags["fallout-maw"].constructVisual.anchors = [{ id: "center", name: "Center", x: .5, y: .5 }];
  const editor = new ConstructVisualEditor(actor), mounted = mountPreview(editor, actor);
  await editor._onRender({}, {});
  assert.equal(mounted.preview.children.length, 1);
  const field = { checked: false, matches: selector => selector === "[data-preview-anchors]" };
  mounted.events.get("change")({ target: field });
  assert.equal(mounted.preview.children.length, 0);
  assert.equal(editor.draft.enabled, true);
  field.checked = true;
  mounted.events.get("change")({ target: field });
  assert.equal(mounted.preview.children.length, 1);
  assert.equal(mounted.dirty(), 0);
});

test("RMB cannot move an anchor, while LMB uses the zoomed and panned rectangle for precise coordinates", async () => {
  const actor = fixture();
  actor.flags["fallout-maw"].constructVisual.anchors = [{ id: "center", name: "Center", x: .5, y: .5 }];
  const editor = new ConstructVisualEditor(actor), mounted = mountPreview(editor, actor);
  await editor._onRender({}, {});
  const marker = { dataset: { previewAnchor: "center" },
    getBoundingClientRect: () => ({ left: 400, top: 570, width: 20, height: 20 }) };
  const event = { button: 2, pointerId: 1, target: { closest: () => marker }, currentTarget: mounted.preview,
    clientX: 415, clientY: 585, preventDefault() {} };
  mounted.pointerEvents.get("pointerdown")(event);
  assert.equal(editor.draft.anchors[0].x, .5);
  assert.equal(mounted.dirty(), 0);
  event.button = 0;
  mounted.pointerEvents.get("pointerdown")(event);
  assert.equal(editor.draft.anchors[0].x, .5);
  assert.equal(editor.draft.anchors[0].y, .5);
  assert.equal(mounted.dirty(), 0, "a click on the edge must not move the anchor to the cursor");
  event.clientX = 190; event.clientY = 275;
  mounted.pointerEvents.get("pointermove")(event);
  assert.equal(editor.draft.anchors[0].x, .125);
  assert.equal(editor.draft.anchors[0].y, .19);
  assert.equal(mounted.dirty(), 1);
});
