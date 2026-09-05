/**
 * Run from a Foundry script macro:
 * await (await import('/systems/fallout-maw/tests/foundry/document-update-benchmark.mjs')).run();
 * Uses unsaved documents only. No hooks, global patches, collector, or database writes.
 */
export async function run({counts = [0, 50, 200], repeats = 3, native = false, includeItemUpdates = true} = {}) {
  const rows = [];
  const output = document.createElement('pre');
  output.style.cssText = 'position:fixed;inset:60px 20px 20px auto;width:620px;overflow:auto;background:#181818;color:white;z-index:99999;padding:20px;white-space:pre-wrap';
  output.textContent = 'Document update benchmark: starting';
  output.addEventListener('dblclick', () => output.remove());
  document.body.append(output);
  try {
  const ActorClass = CONFIG.Actor.documentClass;
  const TokenClass = CONFIG.Token.documentClass;
  const gear = game.actors.contents.flatMap(a => a.items.contents).find(i => i.type === 'gear');
  const itemSource = gear?.toObject() ?? {name: 'Benchmark gear', type: 'gear'};
  const time = (label, count, callback) => {
    callback(0);
    const samples = [];
    for (let i = 1; i <= repeats; i++) {
      const start = performance.now();
      callback(i);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    rows.push({items: count, operation: label, medianMs: +samples[Math.floor(samples.length / 2)].toFixed(2), maxMs: +samples.at(-1).toFixed(2)});
    output.textContent = JSON.stringify(rows, null, 2);
  };
  for (const count of counts) {
    const items = Array.from({length: count}, (_, i) => ({...foundry.utils.deepClone(itemSource), _id: String(i).padStart(16, '0')}));
    const actor = new ActorClass({_id: foundry.utils.randomID(), name: 'Unsaved benchmark', type: 'character', items});
    // These documents never belong to a scene or world collection.
    actor._registerDependentToken = () => {};
    class BenchmarkToken extends TokenClass { get baseActor() { return actor; } }
    const tokenId = foundry.utils.randomID();
    const token = new BenchmarkToken({_id: tokenId, name: 'Unsaved benchmark', actorId: actor.id, actorLink: false, delta: {_id: tokenId}});
    if (native) {
      actor._updateCommit = foundry.documents.Actor.prototype._updateCommit;
      token.delta.syntheticActor._updateCommit = foundry.documents.Actor.prototype._updateCommit;
      token.delta.updateSource = foundry.documents.ActorDelta.prototype.updateSource;
    }
    time('Actor health updateSource', count, i => actor.updateSource({'system.resources.health.spent': i % 2}));
    time('Token x updateSource', count, i => token.updateSource({x: i % 2}));
    time('ActorDelta health updateSource', count, i => token.delta.updateSource({system: {resources: {health: {spent: i % 2}}}}));
    if (count && includeItemUpdates) time('ActorDelta one Item updateSource', count, i => token.delta.updateSource({items: [{_id: items[0]._id, system: {quantity: 1 + (i % 2)}}]}));
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  output.textContent = 'COMPLETE: Foundry ' + game.version + '; ' + (native ? 'native' : 'current') + '; double-click to close\n' + JSON.stringify(rows, null, 2);
  return rows;
  } catch(error) { output.textContent += '\nERROR: ' + error.stack; throw error; }
}

/** Compare complete source and prepared data with the native engine on unsaved pairs. */
export async function verify() {
  const checks = [];
  const output = document.createElement('pre');
  output.style.cssText = 'position:fixed;inset:60px 20px 20px auto;width:620px;overflow:auto;background:#181818;color:white;z-index:99999;padding:20px;white-space:pre-wrap';
  output.addEventListener('dblclick', () => output.remove());
  document.body.append(output);
  const canonical = value => JSON.stringify(value, (_key, child) => {
    if (child && Object.getPrototypeOf(child) === Object.prototype) return Object.fromEntries(Object.keys(child).sort().map(key => [key, child[key]]));
    return child;
  });
  const assertSame = (label, a, b) => {
    if (canonical(a) !== canonical(b)) throw new Error(label + ': native/current differ');
    checks.push(label);
    output.textContent = checks.join('\n');
  };
  try {
    const item = game.actors.contents.flatMap(a => a.items.contents).find(i => i.type === 'gear');
    const source = { _id: foundry.utils.randomID(), name: 'Unsaved verification', type: 'character', items: [item?.toObject() ?? {name:'Gear',type:'gear'}] };
    const actor = new CONFIG.Actor.documentClass(source);
    actor._registerDependentToken = () => {};
    class VerificationToken extends CONFIG.Token.documentClass { get baseActor() { return actor; } }
    const id = foundry.utils.randomID();
    const tokenSource = {_id:id, name:source.name, actorId:actor.id, actorLink:false, delta:{_id:id}};
    const native = new VerificationToken(foundry.utils.deepClone(tokenSource));
    const current = new VerificationToken(foundry.utils.deepClone(tokenSource));
    native.delta.updateSource = foundry.documents.ActorDelta.prototype.updateSource;
    native.actor._updateCommit = foundry.documents.Actor.prototype._updateCommit;
    const itemId = actor.items.contents[0].id;
    const changes = [
      {system:{resources:{health:{spent:1}}}},
      {'system.resources.actionPoints.spent':2,'system.resources.dodge.spent':1},
      {flags:{'fallout-maw':{benchmarkValue:17}}},
      {'flags.fallout-maw.benchmarkValue':18, system:{resources:{health:{spent:3}}}},
      {items:[{_id:itemId, system:{quantity:2}}]},
      {system:{resources:{health:{spent:4}}}},
      {flags:{'fallout-maw':{'-=benchmarkValue':null}}},
      {system:{resources:{health:{spent:0}}}}
    ];
    for (const [index, change] of changes.entries()) {
      const a = native.delta.updateSource(foundry.utils.deepClone(change));
      const b = current.delta.updateSource(foundry.utils.deepClone(change));
      assertSame('diff ' + index, a, b);
      assertSame('delta source ' + index, native.delta.toObject(), current.delta.toObject());
      assertSame('actor source ' + index, native.actor.toObject(), current.actor.toObject());
      assertSame('actor prepared ' + index, native.actor.toObject(false), current.actor.toObject(false));
      native.reset(); current.reset();
      assertSame('parent reset ' + index, native.actor.toObject(false), current.actor.toObject(false));
    }
    const prior = current.actor.toObject();
    current.delta.updateSource({system:{resources:{health:{spent:7}}}}, {dryRun:true});
    assertSame('dryRun unchanged', prior, current.actor.toObject());
    const plain = new CONFIG.Actor.documentClass(foundry.utils.deepClone(source));
    const reference = new CONFIG.Actor.documentClass(foundry.utils.deepClone(source));
    reference._updateCommit = foundry.documents.Actor.prototype._updateCommit;
    const preparedItem = plain.items.contents[0].system;
    plain.items.contents[0].system.quantity = 999;
    reference.items.contents[0].system.quantity = 999;
    plain.updateSource({system:{resources:{health:{spent:1}}}});
    reference.updateSource({system:{resources:{health:{spent:1}}}});
    assertSame('item prepared mutation restored', reference.toObject(false), plain.toObject(false));
    if (plain.items.contents[0].system !== preparedItem) throw new Error('Item model reuse did not activate');
    checks.push('item model reused');
    output.textContent = 'PASS: ' + checks.length + ' real Foundry checks\n' + checks.join('\n');
    return checks;
  } catch(error) { output.textContent += '\nFAIL: ' + error.stack; throw error; }
}
