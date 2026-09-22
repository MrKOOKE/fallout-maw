import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
const source = fs.readFileSync(new URL("../src/items/dropped-items.mjs", import.meta.url), "utf8");
function fixture({ failCommit=false, failStage=0, owner=true, gm=false }={}) {
  const events=[]; const actor={uuid:"Actor.a",testUserPermission:()=>owner};const token={id:"token"};const scene={tokens:{get:()=>token}};
  let index=0;
  const deps={
    game:{ users:{get:()=>({isGM:gm})},scenes:{get:()=>scene}},resolveDroppedActor:async uuid=>uuid==="Actor.tool" ? {uuid} : actor,
    doesTokenRepresentActor:()=>true,getActorDropPosition:()=>({x:10,y:20}),
    foundry:{utils:{randomID:()=>`entry${++index}`}},normalizeDroppedItemData:(data,quantity)=>({...data,quantity}),toInteger:Number,
    addDroppedItemsToScene:async(_actor,entries)=>{if(failStage)throw new Error("stage failed");for(const entry of entries)events.push(["drop",entry.entryId,entry.quantity]);return {id:"tile"};},
    executeInventoryMutation:async plan=>{events.push(["commit",plan]);if(failCommit)throw new Error("commit failed");},
    rollbackDroppedItemEntry:async(_tile,id)=>events.push(["rollback",id])
  };
  const implementation=source.match(/async function performInventoryWithDroppedItems\([^]*?\n\}/)[0];
  const run=new Function(...Object.keys(deps),`${implementation};return performInventoryWithDroppedItems;`)(...Object.values(deps));
  const payload={actorUuid:actor.uuid,sceneId:"scene",tokenId:"token",drops:[{data:{name:"A"},quantity:3},{data:{name:"B"},quantity:7}],deletes:["source"],creates:[],updates:[],expectedItems:[{_id:"source"}],reason:"craft"};
  return{run,events,payload,actor};
}
test("overflow is created on the ground before the exact inventory snapshot is consumed",async()=>{
  const {run,events,payload,actor}=fixture();
  assert.deepEqual(await run(payload,"player"),{dropped:2});
  assert.deepEqual(events.slice(0,2),[["drop","entry1",3],["drop","entry2",7]]);
  assert.equal(events[2][0],"commit");assert.equal(events[2][1].actor,actor);
  assert.deepEqual(events[2][1].expectedItems,payload.expectedItems);
});
test("failed inventory mutation rolls back every staged ground entry",async()=>{
  const {run,events,payload}=fixture({failCommit:true});
  await assert.rejects(run(payload,"player"),/commit failed/);
  assert.deepEqual(events.slice(-2),[["rollback","entry2"],["rollback","entry1"]]);
});
test("failed batch ground write does not consume the inputs",async()=>{
  const {run,events,payload}=fixture({failStage:2});
  await assert.rejects(run(payload,"player"),/stage failed/);
  assert.deepEqual(events,[]);
});
test("players cannot perform overflow mutations on actors they do not own",async()=>{
  const {run,events,payload}=fixture({owner:false});await assert.rejects(run(payload,"player"),/Нет прав/);assert.deepEqual(events,[]);
});

test("only GM may attach tool mutations and both actors commit together before reporting overflow", async () => {
  for (const gm of [false, true]) {
    const {run,events,payload}=fixture({gm});
    payload.additionalMutations=[{actorUuid:"Actor.tool",updates:[{_id:"tool","system.supply.value":2}],deletes:[],expectedItems:[{_id:"tool"}]}];
    if (!gm) { await assert.rejects(run(payload,"player"),/мастер/); assert.deepEqual(events,[]); continue; }
    await run(payload,"gm");
    const plans=events.find(e=>e[0]==="commit")[1];
    assert.equal(plans.length,2); assert.equal(plans[0].actor.uuid,"Actor.a"); assert.equal(plans[1].actor.uuid,"Actor.tool");
    assert.deepEqual(plans[1].expectedItems,[{_id:"tool"}]);
  }
});
