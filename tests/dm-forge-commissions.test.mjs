import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDm } from './dm-harness.mjs';

const read = (app, expression) => JSON.parse(app.evaluate(`JSON.stringify(${expression})`));
function map(app, cells, edges = [], things = {}, intro = '') {
  app.evaluate(`(() => {
    const M = {W:12,H:9,cells:Array(108).fill(' '),ground:Array(108).fill('s'),edges:new Map(${JSON.stringify(edges)}),things:${JSON.stringify(things)}};
    Object.assign(M.cells,${JSON.stringify(cells)}); normalize(M);
    const d = {id:'commission-map',v:2,size:'small',title:'The commission',intro:${JSON.stringify(intro)},things:M.things,rev:1,tested:0};
    mapStore(d,M); forge.dungeons = [d];
  })()`);
}

test('commissions receive distinct IDs even with the same clock and repeated random draws', () => {
  const app = loadDm();
  app.evaluate('Date.now = () => 42; Math.random = () => 0; forge.board = []; forgeBoard();');
  const original = read(app, 'forge.board.map(c => c.id)');
  assert.equal(new Set(original).size, 3);
  app.evaluate('forge.board.shift(); forgeBoard();');
  const next = read(app, 'forge.board.map(c => c.id)');
  assert.equal(new Set(next).size, 3);
  assert.ok(!original.includes(next.at(-1)), 'replacing a completed commission must not reuse a recent ID');
});

test('different devices use independent commission identities even when their clocks match', () => {
  const devices = ['device-a', 'device-b'].map(identity => {
    const app = loadDm();
    app.evaluate(`Date.now = () => 42; Math.random = () => 0; globalThis.crypto = {randomUUID:() => '${identity}'}; forge.board = []; forgeBoard();`);
    return read(app, 'forge.board.map(c => c.id)');
  });
  assert.equal(new Set(devices.flat()).size, 6);
});

test('legacy duplicate IDs are repaired and claiming one commission preserves the other jobs', () => {
  const app = loadDm();
  map(app, {0:'S',1:'s',2:'s',3:'E'}, [], {1:{text:'Follow the green light'},2:{text:'Keep the bronze key'}}, 'We found a cave. A dragon slept there. We left a sign.');
  app.evaluate(`forge.board = [{kind:'story',id:'duplicate'},{kind:'area',id:'duplicate',n:24},{kind:'perimeter',id:'keep-this-id',p:20}]; renderBoard();`);
  const before = read(app, 'forge.board.map(c => ({kind:c.kind,id:c.id}))');
  assert.equal(new Set(before.map(c => c.id)).size, 3);
  assert.equal(before.find(c => c.kind === 'perimeter').id, 'keep-this-id');
  assert.equal(app.evaluate('forgeBoard()'), false, 'repaired IDs should remain stable');
  const story = app.element('forge-board').querySelectorAll('.commission').find(card => card.textContent.includes('The bard wants a tale'));
  story.querySelector('button').click();
  const after = read(app, 'forge.board.map(c => c.id)');
  for (const item of before.filter(c => c.kind !== 'story')) assert.ok(after.includes(item.id), `${item.kind} must remain after the story reward`);
  assert.equal(app.evaluate('forge.stats.commissions'), 1);
});

test('story commission states and applies the same three-word minimum for both signs', () => {
  const app = loadDm();
  assert.match(app.evaluate('COMMISSIONS.story.text()'), /at least three words each/);
  map(app, {0:'S',1:'s',2:'s',3:'E'}, [], {1:{text:'Turn left'},2:{text:'Stay here'}}, 'Here is a cave. It holds treasure. Beware the dragon.');
  assert.equal(app.evaluate('COMMISSIONS.story.find()'), null);
  app.evaluate("forge.dungeons[0].things[1].text = 'Turn left here'; forge.dungeons[0].things[2].text = 'Keep your key';");
  assert.equal(app.evaluate('COMMISSIONS.story.find().d.id'), 'commission-map');
});

test('a secret-only room does not qualify when a wooden wall is another way in', () => {
  const app = loadDm();
  map(app, {0:'S',1:'.',2:'.',12:'E'}, [
    ['v1,0',{m:'stone',door:'secret',manual:true}],
    ['v2,0',{m:'wood',door:null,manual:true}],
    ['h0,1',{m:'stone',door:'door',manual:true}],
  ]);
  assert.equal(app.evaluate('COMMISSIONS.secret.find()'), null);
  app.evaluate(`const repaired = mapOf(forge.dungeons[0]); repaired.edges.get('v2,0').m = 'stone'; mapStore(forge.dungeons[0],repaired);`);
  assert.deepEqual(read(app, 'COMMISSIONS.secret.find().r.cells'), [1]);
});

test('a hidden wooden secret door is itself smashable, so it is not the only way into a secret-only room', () => {
  const app = loadDm();
  map(app, {0:'S',1:'.',12:'E'}, [
    ['v1,0',{m:'wood',door:'secret',manual:true}],
    ['h0,1',{m:'stone',door:'door',manual:true}],
  ]);
  assert.equal(app.evaluate('COMMISSIONS.secret.find()'), null);
});

test('wood against undug rock and partial wood partitions inside a room do not create another entrance', () => {
  const app = loadDm();
  map(app, {0:'S',1:'.',2:'.',12:'E',13:'.',14:'.'}, [
    ['v1,0',{m:'stone',door:'secret',manual:true}],
    ['h0,1',{m:'stone',door:'door',manual:true}],
    ['v1,1',{m:'stone',door:null,manual:true}],
    ['h1,1',{m:'wood',door:null,manual:true}],
    ['v3,0',{m:'wood',door:null,manual:true}],
  ]);
  const cells = read(app, 'COMMISSIONS.secret.find().r.cells').sort((a,b) => a-b);
  assert.deepEqual(cells, [1,2,13,14]);
});
