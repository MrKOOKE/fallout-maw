import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {pathToFileURL} from "node:url";
import fs from "node:fs/promises";
import {loadTokenRelatedDocuments} from "../../server-patches/token-related-documents.mjs";
import {buildServerPatch} from "../../server-patches/install.mjs";

const core = process.env.FALLOUT_MAW_FOUNDRY_CORE;
test("server token adapter matches Foundry 14.361 native documents", {skip: !core}, async t => {
  const source = file => pathToFileURL(path.join(core, file)).href;
  await import(source("common/server.mjs"));
  const {ForcedReplacement} = await import(source("common/data/operators.mjs"));
  const realNow=Date.now;Date.now=()=>1788598731000;t.after(()=>{Date.now=realNow});
  globalThis.release = {version: "14.361", generation: 14, build: 361};
  globalThis.game = {release, system: {id: "fallout-maw", version: "0.2.1", grid: {type:1,distance:5,units:"m"},
    documentTypes: {Actor:{character:{}},Item:{gear:{},ability:{}},ActiveEffect:{base:{}}}},
    model: {Actor:{character:{}},Item:{gear:{},ability:{}},ActiveEffect:{base:{}}},
    world:{path:"memory-fixture"},i18n: {localize:x=>x,format:x=>x}, documentCache: {get(){},set(){},addAll(){}}};
  globalThis.logger = {warn(){},error(){},debug(){},info(){}};
  globalThis.db = await import(source("dist/database/database.mjs"));
  const nativeFile = async relative => {
    const backup=path.join(core,'.fallout-maw-performance-backup-14.361',path.basename(relative));
    return fs.readFile(backup,'utf8').catch(error=>{
      if(error.code!=='ENOENT')throw error;return fs.readFile(path.join(core,relative),'utf8');
    });
  };
  const nativeTokenText=await nativeFile('dist/database/documents/token.mjs');
  const nativeBackendText=await nativeFile('dist/database/backend/server-backend.mjs');
  globalThis.getDocumentClass = name => db[name];
  globalThis.packages={Module:{getPackages:()=>[]}};
  for(const cls of [db.Actor,db.Scene])cls.identifySanitizedFields();
  const sublevels = new Map();
  const fakeDB = {sublevels: new Proxy({}, {get(_target, name) {
    if (!sublevels.has(name)) sublevels.set(name, {prefixKey:id=>`${name}.${id}`,db:fakeDB});
    return sublevels.get(name);
  }})};
  db.Actor._db = db.Scene._db = fakeDB;
  const base = new db.Actor({_id:"actor00000000000",name:"Fixture",type:"character",system:{hp:10},
    ownership:{default:0,player0000000000:3}, items:[{_id:"baseitem00000000",name:"Base",type:"gear",system:{quantity:2}}]});
  // World Actors are not cached by this native server class: each DB read owns
  // its source. Do not accidentally share writable inherited sources across loads.
  const getBase = async () => new db.Actor(foundry.utils.deepClone(base._source));
  db.Actor.get = getBase;
  const data = {_id:"scene00000000000",name:"Fixture",tokens:[{_id:"token00000000000",actorId:base.id,actorLink:false,
    delta:{_id:"token00000000000",items:[{_id:"deltaitem0000000",name:"Delta",type:"gear",system:{quantity:3}}]}}]};
  const native = new db.Scene(foundry.utils.deepClone(data)).tokens.get("token00000000000");
  const candidate = new db.Scene(foundry.utils.deepClone(data)).tokens.get("token00000000000");
  // Always compare against the backed-up native implementation, including when
  // the installed engine already uses the candidate adapter.
  const body=nativeTokenText.match(/async loadRelatedDocuments\(\)\{(.*?)\}async recreateActorDelta/s)[1];
  const {default:original}=await import('data:text/javascript;base64,'+Buffer.from(`export default async function(){${body}}`).toString('base64'));
  const load = token => loadTokenRelatedDocuments(token, () => original.call(token));
  const users = [{id:"player0000000000",isGM:false}, {id:"stranger00000000",isGM:false}, {id:"gm00000000000000",isGM:true}];
  function equivalent() {
    assert.deepEqual(candidate.toObject(), native.toObject(), "persisted Token source");
    assert.deepEqual(candidate.actor?.toObject(), native.actor?.toObject(), "synthetic Actor source");
    assert.deepEqual(candidate.actor?.toObject(false), native.actor?.toObject(false), "prepared Actor");
    for (const name of ["items", "effects"]) {
      assert.deepEqual(candidate.delta?.[name]?.map(d=>d.toObject()), native.delta?.[name]?.map(d=>d.toObject()), name);
    }
    for (const user of users) {
      assert.equal(candidate.getUserLevel(user),native.getUserLevel(user),"ownership "+user.id);
      assert.equal(candidate.canUserModify(user,"update"),native.canUserModify(user,"update"),"permission "+user.id);
    }
  }
  async function reloadBoth() { await original.call(native); await load(candidate); equivalent(); }
  await t.test("lazy construction retains native state and permissions", async () => {
    await original.call(native); await load(candidate);
    assert.equal(typeof Object.getOwnPropertyDescriptor(candidate,"actor").get,"function");
    equivalent();
  });
  await t.test("coordinate moves reuse unchanged documents and reset prepared values", async () => {
    const item=candidate.delta.items.get("deltaitem0000000"), actor=candidate.actor;
    candidate.actor.system.hp=-999;
    for(let i=1;i<=3;i++){
      native.updateSource({x:i*100,y:i*50}); candidate.updateSource({x:i*100,y:i*50});
      await reloadBoth();
      assert.equal(candidate.delta.items.get(item.id),item);
      assert.equal(candidate.actor,actor);
    }
  });
  await t.test("scalar damage and replacement retain current inventory", async () => {
    for(const token of [native,candidate]) token.delta.updateSource({system:{hp:4,damage:{head:1}}});
    await reloadBoth();
    for(const token of [native,candidate]) token.delta.updateSource({system:{damage:ForcedReplacement.create({head:2})}});
    await reloadBoth();
  });
  await t.test("managed Item update, creation and deletion", async () => {
    for(const token of [native,candidate]){
      const c=token.delta.items;
      const item=c.get("deltaitem0000000");item.updateSource({"system.quantity":7});c.set(item.id,item);
      const added=new c.documentClass({_id:"newitem000000000",name:"New",type:"ability",system:{rank:1}}, {parent:token.delta,parentCollection:"items"});
      c.set(added.id,added);
    }
    await reloadBoth();
    for(const token of [native,candidate]) token.delta.items.delete("newitem000000000");
    await reloadBoth();
  });
  await t.test("inherited Item adoption, tombstone and restoration", async () => {
    for(const token of [native,candidate]){
      const c=token.delta.items,item=c.get("baseitem00000000");
      await item._preUpdate({system:{quantity:6}},{},users[2]);
      item.updateSource({"system.quantity":6});c.set(item.id,item);
    }
    await reloadBoth();
    for(const token of [native,candidate]) token.delta.items.delete("baseitem00000000");
    await reloadBoth();
    assert.equal(candidate.actor.items.has("baseitem00000000"),false);
    for(const token of [native,candidate]) token.delta.items.delete("baseitem00000000",{restoreDelta:true});
    await reloadBoth();assert.equal(candidate.actor.items.get("baseitem00000000").system.quantity,2);
  });
  await t.test("ActiveEffect create, update and delete", async () => {
    for(const token of [native,candidate]){
      const c=token.delta.effects,e=new c.documentClass({_id:"effect0000000000",name:"Effect",type:"base",changes:[],disabled:false}, {parent:token.delta,parentCollection:"effects"});c.set(e.id,e);
    }
    await reloadBoth();
    for(const token of [native,candidate]) token.delta.effects.get("effect0000000000").updateSource({disabled:true});
    await reloadBoth();
    for(const token of [native,candidate]) token.delta.effects.delete("effect0000000000");
    await reloadBoth();
  });
  await t.test("base Actor inventory and ownership changes invalidate reuse", async () => {
    base.updateSource({items:[{_id:"baseitem00000000",system:{quantity:15}}],ownership:{player0000000000:1}});
    await reloadBoth();
    assert.equal(candidate.actor.items.get("baseitem00000000").system.quantity,15);
    assert.equal(candidate.canUserModify(users[0],"update"),false);
    for(const token of [native,candidate]) token.delta.updateSource({ownership:{player0000000000:3}});
    await reloadBoth();assert.equal(candidate.canUserModify(users[0],"update"),true);
  });
  await t.test("raw in-place changes and source replacement rebuild affected documents", async () => {
    for(const token of [native,candidate]) token.delta._source.items[0].system.quantity=42;
    await reloadBoth();
    for(const token of [native,candidate]) token.delta._source.items[0]=foundry.utils.deepClone(token.delta._source.items[0]);
    await reloadBoth();
    const item=candidate.delta.items.get("deltaitem0000000");
    assert.equal(item._source,candidate.delta._source.items.find(row=>row._id===item.id));
  });
  await t.test("unread Actor snapshot retains the native load-time state", async () => {
    for(const token of [native,candidate]) token.delta.updateSource({"system.hp":3});
    await original.call(native); await load(candidate);
    for(const token of [native,candidate]) token.delta.updateSource({"system.hp":2});
    assert.deepEqual(candidate.actor.toObject(),native.actor.toObject());
    await reloadBoth();
  });
  await t.test("external Actor source mutation does not survive another load", async () => {
    candidate.actor.updateSource({"system.hp":-123});
    await reloadBoth();assert.equal(candidate.actor.system.hp,2);
  });
  await t.test("shared private Item snapshots retain load-time values and never alias live documents", async () => {
    await reloadBoth();
    await original.call(native); await load(candidate);
    for (const token of [native,candidate]) token.delta.items.get("deltaitem0000000")._source.system.quantity=51;
    assert.deepEqual(candidate.actor.toObject(),native.actor.toObject(),"the unread Actor still sees its earlier inventory snapshot");
    assert.equal(candidate.actor.items.get("deltaitem0000000").system.quantity,42);
    await reloadBoth();
    const view=candidate.actor;
    view.items.get("deltaitem0000000")._source.system.quantity=-100;
    assert.equal(candidate.delta.items.get("deltaitem0000000")._source.system.quantity,51);
    await reloadBoth();
    assert.equal(candidate.actor.items.get("deltaitem0000000").system.quantity,51);
  });
  await t.test("custom Item reset and schema field initialization retain fresh load-time snapshots", async () => {
    await reloadBoth();
    const item=candidate.delta.items.get("deltaitem0000000");
    const initialize=item._initialize;
    item._initialize=function (...args) {this._source.system.quantity=52; return initialize.apply(this,args);};
    await load(candidate);
    assert.equal(candidate.actor.items.get(item.id).system.quantity,52);
    delete item._initialize;
    for(const token of [native,candidate])token.delta.items.get(item.id)._source.system.quantity=51;
    await reloadBoth();
    const field=candidate.delta.items.get(item.id).schema.get("system"), originalInitialize=field.initialize;
    field.initialize=function (value,document,...args) {
      if(document===candidate.delta.items.get(item.id))value.quantity=53;
      return originalInitialize.call(this,value,document,...args);
    };
    try {
      await load(candidate);
      assert.equal(candidate.actor.items.get(item.id).system.quantity,53);
    } finally {delete field.initialize;}
    for(const token of [native,candidate])token.delta.items.get(item.id)._source.system.quantity=51;
    await reloadBoth();
  });
  await t.test("linked, unlinked and missing base Actor follow native behavior", async () => {
    for(const token of [native,candidate]) token.updateSource({actorLink:true});
    await reloadBoth();assert.equal(candidate.actor,candidate.baseActor);
    for(const token of [native,candidate]) token.updateSource({actorLink:false});
    await reloadBoth();
    db.Actor.get=async()=>null;
    await reloadBoth();assert.equal(candidate.actor,null);
    db.Actor.get=getBase;await reloadBoth();
  });
  await t.test("800 managed Item snapshots preserve all native data across reload, damage and embedded mutation", async () => {
    const heavyData=foundry.utils.deepClone(data);
    heavyData.tokens[0].delta.items=Array.from({length:800},(_,i)=>({
      _id:String(i).padStart(16,"0"),name:"Gear",type:"gear",
      system:{quantity:3,functions:{condition:{enabled:true,value:100,max:100}},tags:["fixture",String(i)]}
    }));
    const left=new db.Scene(foundry.utils.deepClone(heavyData)).tokens.get("token00000000000");
    const right=new db.Scene(foundry.utils.deepClone(heavyData)).tokens.get("token00000000000");
    for(let n=0;n<3;n++){
      for(const token of [left,right]){
        token.updateSource({x:n*10});
        token.delta.updateSource({system:{hp:10-n}});
      }
      await original.call(left);await load(right);
      // Materialize both snapshots only after the live source has changed.
      for(const token of [left,right])token.delta.items.get("0000000000000000")._source.system.quantity=20+n;
      assert.deepEqual(right.actor.toObject(),left.actor.toObject());
      assert.deepEqual(right.toObject(),left.toObject());
      assert.equal(right.actor.items.size,801);
    }
  });
  await t.test("custom ActorDelta source serialization is retained", async () => {
    const token=new db.Scene(foundry.utils.deepClone(data)).tokens.get("token00000000000");
    await load(token);
    const originalToObject=token.delta.toObject;
    token.delta.toObject=function (...args){const source=originalToObject.apply(this,args);source.system={hp:123};return source;};
    await load(token);
    assert.equal(token.actor.system.hp,123);
  });
  await t.test("other versions and systems retain the native loader", async () => {
    let calls=0;game.system.id="different-system";
    await loadTokenRelatedDocuments(candidate,()=>{calls++});
    game.system.id="fallout-maw";release.version="14.999";
    await loadTokenRelatedDocuments(candidate,()=>{calls++});
    release.version="14.361";assert.equal(calls,2);
  });
  await t.test("native backend scalar writes exclude inventory; embedded changes still persist", async () => {
    globalThis.options={debug:false};
    const written=[];
    fakeDB.batch=()=>({db:fakeDB,put(key,value){written.push({key,value});return this;},
      del(){return this;},clear(){written.length=0;},async write(){}});
    const backendFile=path.join(core,"dist/database/backend/server-backend.mjs");
    const patched=buildServerPatch(nativeTokenText,nativeBackendText)["dist/database/backend/server-backend.mjs"];
    const importBackend = async text => {
      const absoluteImports=text.replace(/from"(\.\.?\/[^\"]+)"/g,(_match,relative)=>`from"${new URL(relative,pathToFileURL(backendFile)).href}"`);
      return (await import('data:text/javascript;base64,'+Buffer.from(absoluteImports).toString('base64'))).default;
    };
    const Backend=await importBackend(patched),NativeBackend=await importBackend(nativeBackendText);
    const operation=(changes)=>({updates:[{_id:candidate.id,...changes}],parent:candidate.parent,
      parentUuid:candidate.parent.uuid,_sideEffects:[]});
    const writesItems=()=>written.some(row=>row.key.includes('.delta.items.'));
    await new NativeBackend()._updateDocuments(db.Token,operation({x:500}),users[2]);
    assert.ok(writesItems(),'native undefined flag rewrites embedded inventory');
    written.length=0;
    const backend=new Backend();
    await backend._updateDocuments(db.Token,operation({x:600}),users[2]);
    assert.equal(writesItems(),false,'coordinate update only writes Token/parent metadata');
    assert.ok(written.some(row=>row.key.endsWith(candidate.id)),'token itself is persisted');
    written.length=0;
    await backend._updateDocuments(db.Token,operation({delta:{items:[{_id:'deltaitem0000000',system:{quantity:99}}]}}),users[2]);
    assert.ok(writesItems(),'explicit embedded modification persists inventory');
    assert.equal(candidate.delta.items.get('deltaitem0000000').system.quantity,99);
  });
});
