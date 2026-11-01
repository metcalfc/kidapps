import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDm } from './dm-harness.mjs';

const read = (app, expression) => JSON.parse(app.evaluate(`JSON.stringify(${expression})`));
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function start(app, { cells = {0:'S', 1:'E'}, edges = [], things = {}, ground = {} } = {}) {
  app.evaluate(`(() => {
    const M = {W:12, H:9, cells:Array(108).fill(' '), ground:Array(108).fill('s'), edges:new Map(${JSON.stringify(edges)}), things:${JSON.stringify(things)}};
    Object.assign(M.cells, ${JSON.stringify(cells)}); Object.assign(M.ground, ${JSON.stringify(ground)}); normalize(M);
    const d = {id:'objects', v:2, size:'small', title:'The brass door', intro:'Find the hidden library.', rev:7, things:M.things};
    mapStore(d, M); forge.dungeons=[d]; forgePlay(d, 'test');
  })()`);
}
function grade(app, answer) {
  const box = app.element('fp-enc'), input = box.querySelector('input');
  if (input) input.value = String(answer);
  else {
    const choice = box.querySelectorAll('button').find(b => b.textContent === answer);
    assert.ok(choice, `choice ${answer} must be present`); choice.click();
  }
  box.querySelectorAll('button').find(b => b.textContent === 'Check').click();
  assert.equal(box.querySelector('.feedback').classList.contains('good'), true, box.textContent);
}
async function next(app) {
  const button = app.element('fp-enc').querySelectorAll('button').find(b => !b.disabled && ['Next', 'Continue'].includes(b.textContent));
  assert.ok(button, 'a correct answer should offer the next step'); button.click(); await settle();
}
const question = app => app.element('fp-enc').querySelector('.q').textContent;

test('all floor, wall, door, chest, sign, key, start and exit settings survive sharing', () => {
  const app = loadDm();
  start(app, {
    cells:{0:'S', 1:'k', 2:'$', 3:'$', 4:'$', 5:'s', 6:'E'},
    ground:{1:'c', 2:'w'},
    edges:[
      ['v1,0', {m:'stone', door:'door', manual:true}],
      ['v2,0', {m:'cave', door:'locked', manual:true}],
      ['v3,0', {m:'wood', door:'portcullis', manual:true}],
      ['v4,0', {m:'bars', door:'secret', manual:true}],
    ],
    things:{2:{size:'s'}, 3:{size:'m'}, 4:{size:'l'}, 5:{text:'The key opens the library. <Keep it!>'}},
  });
  const original = read(app, 'fp.d'), shared = read(app, 'forgeClean(JSON.parse(JSON.stringify(fp.d)))');
  for (const field of ['title', 'intro', 'cells', 'ground', 'walls', 'things']) {
    assert.deepEqual(shared[field], original[field], `${field} should survive the share/import path`);
  }
});

test('doors can only be built between two floor squares', () => {
  for (const kind of ['door', 'locked', 'portcullis', 'secret']) {
    const app = loadDm(); start(app);
    app.evaluate(`ed.M = mapOf(fp.d); ed.d = fp.d; ed.door = '${kind}'; ed.stroke = {changed:false}; placeDoor({fx:0,fy:.5});`);
    assert.equal(app.evaluate('ed.stroke.changed'), false, `${kind} should not lead into rock or outside the map`);
    assert.equal(app.evaluate("ed.M.edges.get('v0,0').door"), null);
    app.evaluate('placeDoor({fx:2,fy:.5});');
    assert.equal(app.evaluate('ed.stroke.changed'), false, `${kind} should not lead into an undug square`);
    assert.equal(app.evaluate("ed.M.edges.get('v2,0').door"), null);
    app.evaluate('placeDoor({fx:1,fy:.5});');
    assert.equal(app.evaluate("ed.M.edges.get('v1,0').door"), kind, 'the same door is valid between floor squares');
  }
});

test('a legacy locked door facing rock cannot spend a key or open', async () => {
  const app = loadDm();
  start(app, {edges:[['v2,0', {m:'stone', door:'locked', manual:true}]]});
  app.evaluate('fp.pos = 1; fp.keys = 1;');
  await app.evaluate('fpMove(2)');
  assert.equal(app.evaluate('fp.pos'), 1);
  assert.equal(app.evaluate('fp.keys'), 1);
  assert.equal(app.evaluate("fp.opened.has('v2,0')"), false);
});

test('stone, cave and iron bars block movement, with bars allowing sight', async () => {
  for (const material of ['stone', 'cave', 'bars']) {
    const app = loadDm();
    start(app, {edges:[['v1,0', {m:material, door:null, manual:true}]]});
    assert.equal(app.evaluate('fp.seen.has(1)'), material === 'bars', `${material} visibility`);
    await app.evaluate('fpMove(1)');
    assert.equal(app.evaluate('fp.pos'), 0, `${material} must block walking`);
    assert.equal(app.evaluate('fp.over'), false);
  }
});

test('the start, ordinary door and exit used in play match the saved map', async () => {
  const app = loadDm();
  start(app, {cells:{24:'S', 25:'E'}, edges:[['v1,2', {m:'stone', door:'door', manual:true}]]});
  assert.equal(app.evaluate('fp.pos'), 24);
  assert.match(app.element('fp-read').textContent, /Find the hidden library/);
  await app.evaluate('fpMove(25)');
  assert.equal(app.evaluate('fp.pos'), 25);
  assert.equal(app.evaluate("fp.opened.has('v1,2')"), true);
  assert.equal(app.evaluate('fp.over'), true);
  assert.equal(app.evaluate('fp.d.tested'), 7);
  assert.equal(app.evaluate('fp.d.cells[24] + fp.d.cells[25]'), 'SE', 'a test run must preserve the builder’s map');
});

test('a key opens one locked door and the open door needs no second key', async () => {
  const app = loadDm();
  start(app, {cells:{0:'S', 1:'k', 2:'.', 3:'E'}, edges:[['v2,0', {m:'stone', door:'locked', manual:true}]]});
  await app.evaluate('fpMove(1)');
  assert.equal(app.evaluate('fp.keys'), 1);
  await app.evaluate('fpMove(2)');
  assert.equal(app.evaluate('fp.keys'), 0);
  assert.equal(app.evaluate("fp.opened.has('v2,0')"), true);
  await app.evaluate('fpMove(1)'); await app.evaluate('fpMove(2)');
  assert.equal(app.evaluate('fp.pos'), 2);
  assert.equal(app.evaluate('fp.keys'), 0);
  assert.equal(app.evaluate('fp.d.cells[1]'), 'k', 'a collected key remains in the saved dungeon');
});

test('portcullises stay shut after a failed Strength check and open after success', async () => {
  const app = loadDm();
  start(app, {edges:[['v1,0', {m:'stone', door:'portcullis', manual:true}]]});
  assert.equal(app.evaluate('fp.seen.has(1)'), true);
  app.random([.999999, 0, 0]);
  const failure = app.evaluate('fpMove(1)');
  assert.match(question(app), /Strength check/); grade(app, 'Too heavy'); await next(app); await failure;
  assert.equal(app.evaluate('fp.pos'), 0);
  assert.equal(app.evaluate("fp.opened.has('v1,0')"), false);
  app.random([0, .999999, .999999]);
  const success = app.evaluate('fpMove(1)');
  grade(app, 'Lifted it'); await next(app); await success;
  assert.equal(app.evaluate('fp.pos'), 1);
  assert.equal(app.evaluate("fp.opened.has('v1,0')"), true);
});

test('secret doors block sight and movement until a successful Investigation search', async () => {
  const app = loadDm();
  start(app, {edges:[['v1,0', {m:'stone', door:'secret', manual:true}]]});
  assert.equal(app.evaluate('fp.seen.has(1)'), false);
  await app.evaluate('fpMove(1)'); assert.equal(app.evaluate('fp.pos'), 0);
  app.random([.999999, 0, 0]);
  const failure = app.evaluate('fpSearch()'); grade(app, 'Fail'); await next(app); await failure;
  assert.equal(app.evaluate("fp.found.has('v1,0')"), false);
  app.random([0, .999999, .999999]);
  const success = app.evaluate('fpSearch()'); grade(app, 'Success'); await next(app); await success;
  assert.equal(app.evaluate("fp.found.has('v1,0')"), true);
  await app.evaluate('fpMove(1)');
  assert.equal(app.evaluate('fp.pos'), 1);
  assert.equal(app.evaluate("fp.opened.has('v1,0')"), true);
});

test('wooden walls can be left intact or smashed using their stated AC and hit points', async () => {
  const app = loadDm(); start(app, {edges:[['v1,0', {m:'wood', door:null, manual:true}]]});
  const leave = app.evaluate('fpMove(1)');
  app.element('fp-enc').querySelectorAll('button').find(b => b.textContent === 'Leave it').click();
  await settle(); await leave;
  assert.equal(app.evaluate('fp.pos'), 0);
  const smash = app.evaluate('fpMove(1)');
  const weapon = app.evaluate("(MELEE_WEAPONS.findIndex(([n]) => n === 'greatsword') + .5) / MELEE_WEAPONS.length");
  app.random([weapon, .999999, .999999, .999999, .999999, .999999]);
  app.element('fp-enc').querySelectorAll('button').find(b => b.textContent === 'Smash it').click(); await settle();
  assert.match(question(app), /Armor Class 15/); grade(app, 'Hit');
  app.random([.999999, .999999, .999999, .999999]); await next(app);
  grade(app, 27); await next(app); await smash;
  assert.equal(app.evaluate('fp.pos'), 1);
  assert.equal(app.evaluate("fp.opened.has('v1,0')"), true);
  assert.match(app.element('fp-log').textContent, /planks give way/);
});

test('each placed chest awards its configured gold once and a sign reads the builder’s exact text', async () => {
  for (const [size, gold] of [['s',20], ['m',50], ['l',100]]) {
    const app = loadDm();
    start(app, {cells:{0:'S', 1:'$', 2:'s', 3:'E'}, things:{1:{size}, 2:{text:'Turn left <br> & keep the key.'}}});
    const opening = app.evaluate('fpMove(1)'), q = question(app);
    let match, answer;
    if (q.endsWith('How much treasure is that in all?')) answer = gold;
    else if (q.includes('just the gem')) { match = q.match(/and (\d+) gems? worth (\d+) gold pieces each/); answer = +match[1] * +match[2]; }
    else if (q.endsWith('How many gold coins are there?')) { match = q.match(/Its (\d+) gems? (?:is|are) worth (\d+) gold pieces each/); answer = gold - +match[1] * +match[2]; }
    else { match = q.match(/has (\d+) gems worth (\d+) gold pieces altogether/); answer = +match[2] / +match[1]; }
    grade(app, answer); await next(app); await opening;
    assert.equal(app.evaluate('fp.gold'), gold);
    await app.evaluate('fpMove(0)'); await app.evaluate('fpMove(1)');
    assert.equal(app.evaluate('fp.gold'), gold);
    await app.evaluate('fpMove(2)');
    assert.equal(app.element('fp-read').querySelector('p').textContent, 'Turn left <br> & keep the key.');
    assert.equal(app.evaluate('fp.d.things[1].size'), size);
    assert.equal(app.evaluate('fp.d.cells[1]'), '$');
  }
});
