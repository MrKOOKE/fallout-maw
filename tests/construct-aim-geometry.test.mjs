import test from "node:test";
import assert from "node:assert/strict";
import { advanceConstructRotation, calculateConstructAimRotation, constructLocalToWorld, isConstructAimWithinSector } from "../src/utils/construct-aim-geometry.mjs";
test("a turret travels degrees per second through the short path across north", () => {
  assert.equal(advanceConstructRotation(179, -179, 90, 1/90), -180);
  assert.equal(advanceConstructRotation(0, 90, 60, 0.5), 30);
  assert.equal(advanceConstructRotation(80, 90, 60, 1), 90);
});
test("world direction removes body angle and measures around the attachment", () => {
  assert.equal(calculateConstructAimRotation({origin:{x:10,y:20},point:{x:110,y:20},bodyRotation:90}),0);
  assert.equal(calculateConstructAimRotation({origin:{x:10,y:20},point:{x:10,y:20}}),null);
  assert.deepEqual(constructLocalToWorld({x:.5,y:0},{x:0,y:0,width:100,height:200,rotation:90}),{x:150,y:100});
});
test("the actual limited sector rejects a shot the visual has clamped", () => {
  assert.equal(isConstructAimWithinSector(60,{minRotation:-30,maxRotation:30},30),true);
  assert.equal(isConstructAimWithinSector(90,{minRotation:-30,maxRotation:30},30),false);
  assert.equal(isConstructAimWithinSector(-179,{minRotation:-180,maxRotation:180}),true);
});
test("a bounded turret turns through its legal arc rather than across the rear stop", () => {
  assert.equal(advanceConstructRotation(170, -170, 90, .5, { minRotation: -170, maxRotation: 170 }), 125);
  assert.equal(advanceConstructRotation(-170, 170, 90, .5, { minRotation: -170, maxRotation: 170 }), -125);
  assert.equal(advanceConstructRotation(-175, -150, 90, .5,
    { minRotation: -170, maxRotation: 170, anchorRotation: 20 }), 140);
});
