import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { planActorInventoryRepair, planInventoryRepair } from '../../src/inventory/repair.mjs';

const core = process.env.FALLOUT_MAW_FOUNDRY_CORE;
test('inventory repair uses independent native Item output and isolates custom serializers', {skip:!core}, async t => {
  await import(pathToFileURL(path.join(core,'common/server.mjs')));
  foundry.applications = {api:{DialogV2:class{}},ux:{FormDataExtended:class{}},handlebars:{renderTemplate:async()=>''}};
  globalThis.game = {release:{version:'14.361'},settings:{get:()=>({base:{},types:{}})},i18n:{localize:x=>x,format:x=>x},
    system:{id:'fallout-maw',version:'0.2.1',documentTypes:{Item:{gear:{},ability:{},trauma:{},disease:{}}}},
    model:{Item:{gear:{},ability:{},trauma:{},disease:{}},ActiveEffect:{base:{}}}};
  const models = await import('../../src/data/models/item-data-models.mjs');
  globalThis.CONFIG = {Item:{documentClass:foundry.documents.BaseItem,dataModels:{gear:models.GearDataModel}},ActiveEffect:{dataModels:{}},Folder:{}};
  const Item = foundry.documents.BaseItem;
  const create = (i=0, Class=Item) => new Class({_id:String(i).padStart(16,'0'),name:'Repair fixture',type:'gear',
    system:{quantity:1,weight:1,container:{parentId:''},placement:{mode:'inventory',x:i+1,y:1,width:1,height:1},functions:{weapon:{enabled:true}}}});
  await t.test('repair mutations and returned plans cannot mutate the native source', () => {
    const item=create();item.updateSource({'system.container.parentId':'missing000000000'});
    const before=item.toObject();
    const plan=planInventoryRepair([item],{columns:4,rows:1});
    assert.ok(plan.updates.length);assert.deepEqual(plan,planInventoryRepair([before],{columns:4,rows:1}));
    assert.deepEqual(item.toObject(),before);
    plan.updates[0]['system.container.parentId']='different';assert.deepEqual(item.toObject(),before);
  });
  await t.test('custom serializers that return shared source stay detached', () => {
    class CustomItem extends Item {toObject(){return this._source;}}
    const item=create(1,CustomItem);item.updateSource({'system.container.parentId':'missing000000000'});
    const before=structuredClone(item._source);
    assert.ok(planInventoryRepair([item],{columns:4,rows:1}).updates.length);
    assert.deepEqual(item._source,before);
  });
  await t.test('custom Item shims and plain toObject adapters retain independent cloning', () => {
    class CustomItem extends Item {static shimData(){return shared;}}
    const shared=create(2).toObject();shared.system.container.parentId='missing000000000';
    const item=create(2,CustomItem),before=structuredClone(shared);
    assert.ok(planInventoryRepair([item],{columns:4,rows:1}).updates.length);
    assert.deepEqual(shared,before);
    const adapter={...shared,toObject:()=>shared};
    assert.ok(planInventoryRepair([adapter],{columns:4,rows:1}).updates.length);assert.deepEqual(shared,before);
  });
  await t.test('800 native Items produce the same plan with one versus two copies', () => {
    const items=Array.from({length:800},(_,i)=>create(i));
    const serialize=Item.prototype.toObject, times={nativeSingle:[],previousDouble:[]};
    let expected;
    for(let round=0;round<3;round++)for(const double of [true,false]){
      for(const item of items){if(double)item.toObject=function(){return serialize.call(this)};else delete item.toObject;}
      const start=performance.now();const plan=planInventoryRepair(items,{columns:800,rows:1});
      times[double?'previousDouble':'nativeSingle'].push(performance.now()-start);
      if(!expected)expected=plan;else assert.deepEqual(plan,expected);
    }
    assert.equal(items.length,800);t.diagnostic(JSON.stringify(times));
  });
  await t.test('automatic repair captures native Items then plans from the full immutable snapshot', async () => {
    const {repairActorInventory}=await import('../../src/inventory/migration.mjs');
    const items=Array.from({length:800},(_,i)=>create(i));
    const actor={id:'fixture-actor',documentName:'Actor',type:'character',items,
      system:{inventory:{columns:800,rows:1},trade:{infiniteInventory:false}}};
    const user={id:'fixture-gm',active:true,isGM:true};game.user=user;game.users=[user];game.users.activeGM=user;
    const times={previousAutomatic:[],currentAutomatic:[]};
    for(let round=0;round<3;round++) {
      let start=performance.now();
      const previousSnapshot=Array.from(items,item=>foundry.utils.deepClone(item.toObject()));
      const previousPlan=await planActorInventoryRepair(actor,{}, {items:previousSnapshot,isNonInventoryPlacementValid:()=>true});
      times.previousAutomatic.push(performance.now()-start);
      start=performance.now();
      const result=await repairActorInventory(actor,{automatic:true,race:{},render:false});
      times.currentAutomatic.push(performance.now()-start);
      assert.equal(result.changed,false); // This fixture never invokes document writes.
      assert.deepEqual({updates:result.updates,repairs:result.repairs,lockedStorage:result.lockedStorage},previousPlan);
      assert.deepEqual(items.map(item=>item.toObject()),previousSnapshot);
    }
    t.diagnostic(JSON.stringify(times));
  });
});
