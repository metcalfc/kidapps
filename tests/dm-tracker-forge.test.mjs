import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDm } from './dm-harness.mjs';

const read = (app, expression) => JSON.parse(app.evaluate(`JSON.stringify(${expression})`));
const hero = (extra = {}) => ({id:1, name:'Pip', init:10, hp:0, max:20, ac:14, kind:'hero', conds:[], ds:[0,0], status:'down', ...extra});
function roster(app, list, extra = {}) {
  app.evaluate(`trk = trkNormalize(${JSON.stringify({round:1, turn:0, started:true, list, ...extra})}); renderTracker();`);
}
function open(app, index = 0) {
  if (!app.document.querySelector('.trk-panel')) app.element('trk-row-' + index).click();
}
function damage(app, amount, critical = false) {
  open(app);
  app.element('trk-amt-' + app.evaluate('trk.turn')).value = String(amount);
  const panel = app.document.querySelector('.trk-panel');
  panel.querySelectorAll('input').find(input => input.type === 'checkbox').checked = critical;
  panel.querySelectorAll('button').find(button => button.textContent === 'Damage').click();
}

test('new combat starts with highest Initiative; later edits preserve the active combatant', () => {
  const app = loadDm();
  roster(app, [hero({id:1, name:'Pip', init:10, hp:20}), hero({id:2, name:'Mara', init:20, hp:20})], {started:false});
  assert.equal(app.element('trk-next').disabled, true);
  app.element('trk-start').click();
  assert.equal(app.evaluate('trk.list[trk.turn].name'), 'Mara');
  assert.equal(app.evaluate('trk.round'), 1);
  assert.equal(app.element('trk-next').disabled, false);
  app.element('trk-row-0').click();
  const initiative = app.element('trk-init-0');
  initiative.value = '1'; initiative.dispatchEvent({type:'change'});
  assert.deepEqual(read(app, 'trk.list.map(c => c.name)'), ['Pip', 'Mara']);
  assert.equal(app.evaluate('trk.list[trk.turn].name'), 'Mara');
  app.element('trk-start').click();
  assert.equal(app.evaluate('trk.list[trk.turn].name'), 'Pip');
  assert.equal(app.evaluate('trk.round'), 1);
});

test('removing an earlier combatant preserves the active turn; removing the last active one starts a new round', () => {
  const app = loadDm();
  roster(app, [hero({id:1,name:'Mara',hp:20}), hero({id:2,name:'Pip',hp:20}), hero({id:3,name:'Finn',hp:20})], {turn:1,round:3});
  app.element('trk-row-0').click();
  app.document.querySelector('.trk-panel').querySelectorAll('button').find(button => button.textContent === 'Remove from fight').click();
  assert.equal(app.evaluate('trk.list[trk.turn].name'), 'Pip');
  assert.equal(app.evaluate('trk.round'), 3);
  app.element('trk-next').click();
  assert.equal(app.evaluate('trk.list[trk.turn].name'), 'Finn');
  app.element('trk-row-1').click();
  app.document.querySelector('.trk-panel').querySelectorAll('button').find(button => button.textContent === 'Remove from fight').click();
  assert.equal(app.evaluate('trk.list[trk.turn].name'), 'Pip');
  assert.equal(app.evaluate('trk.round'), 4);
});

test('damage at 0 HP records one failure, a Critical Hit records two, and three failures cause death', () => {
  const app = loadDm();
  roster(app, [hero()]);
  damage(app, 1);
  assert.deepEqual(read(app, 'trk.list[0].ds'), [0,1]);
  assert.equal(app.evaluate('trk.list[0].status'), 'down');
  damage(app, 1, true);
  assert.deepEqual(read(app, 'trk.list[0].ds'), [0,3]);
  assert.equal(app.evaluate('trk.list[0].status'), 'dead');
  assert.match(app.element('trk-note').textContent, /three failures/);
  app.evaluate("trk = trkNormalize(JSON.parse(localStorage.getItem('pda-tracker'))); renderTracker();");
  assert.equal(app.evaluate('trk.list[0].status'), 'dead');
  assert.match(app.element('trk-list').textContent, /Dead/);
  app.element('trk-amt-0').value = '1';
  app.element('trk-heal-0').click();
  assert.equal(app.evaluate('trk.list[0].hp'), 0);
  assert.equal(app.evaluate('trk.list[0].status'), 'dead');
});

test('massive damage kills both an already down hero and a newly reduced hero', () => {
  const app = loadDm();
  roster(app, [hero()]);
  damage(app, 20);
  assert.equal(app.evaluate('trk.list[0].status'), 'dead');
  assert.match(app.element('trk-note').textContent, /instant death/);
  roster(app, [hero({hp:6,status:'up'})]);
  damage(app, 26);
  assert.equal(app.evaluate('trk.list[0].status'), 'dead');
  roster(app, [hero({hp:6,status:'up'})]);
  damage(app, 25);
  assert.equal(app.evaluate('trk.list[0].status'), 'down');
});

test('three successes stabilize and clear both counts; damage ends stability; 1 HP healing clears saves', () => {
  const app = loadDm();
  roster(app, [hero({ds:[0,2]})]); open(app);
  for(let i = 0; i < 3; i++) app.document.querySelector('.ds').querySelector('.ok').querySelector('button').click();
  assert.equal(app.evaluate('trk.list[0].status'), 'stable');
  assert.deepEqual(read(app, 'trk.list[0].ds'), [0,0]);
  assert.equal(app.document.querySelector('.ds'), null);
  app.evaluate("trk = trkNormalize(JSON.parse(localStorage.getItem('pda-tracker'))); renderTracker();");
  assert.equal(app.evaluate('trk.list[0].status'), 'stable');
  damage(app, 2);
  assert.equal(app.evaluate('trk.list[0].status'), 'down');
  assert.deepEqual(read(app, 'trk.list[0].ds'), [0,1]);
  app.element('trk-amt-0').value = '1'; app.element('trk-heal-0').click();
  assert.equal(app.evaluate('trk.list[0].hp'), 1);
  assert.equal(app.evaluate('trk.list[0].status'), 'up');
  assert.deepEqual(read(app, 'trk.list[0].ds'), [0,0]);
});

test('natural 1 on a death save records two failures', () => {
  const app = loadDm(); roster(app, [hero()]); open(app);
  app.document.querySelector('.ds').querySelectorAll('button').find(button => button.textContent.startsWith('Natural 1:')).click();
  assert.deepEqual(read(app, 'trk.list[0].ds'), [0,2]);
});

test('legacy tracker saves preserve an ongoing round and migrate stable and dead outcomes', () => {
  const app = loadDm();
  const raw = {round:4, turn:1, list:[hero({ds:[3,2],status:undefined}), hero({id:2,ds:[1,3],status:undefined})]};
  const normalized = read(app, `trkNormalize(${JSON.stringify(raw)})`);
  assert.equal(normalized.started, true);
  assert.equal(normalized.round, 4); assert.equal(normalized.turn, 1);
  assert.equal(normalized.list[0].status, 'stable'); assert.deepEqual(normalized.list[0].ds, [0,0]);
  assert.equal(normalized.list[1].status, 'dead');
  assert.equal(read(app, 'trkNormalize(trkDefaults())').started, false);
});

test('pits share a footprint only when their type and depth match and no wall separates them', () => {
  const app = loadDm();
  const groups = read(app, `(() => {
    const M = {W:4,H:1,cells:['t','t','t','t'],ground:['s','s','s','s'],edges:new Map(),things:{0:{trap:'pit',depth:10},1:{trap:'pit',depth:10},2:{trap:'pit',depth:30},3:{trap:'spiked',depth:30}}};
    const result = [pitGroup(M,0),pitGroup(M,2),pitGroup(M,3)];
    M.edges.set('v1,0',{m:'stone'}); result.push(pitGroup(M,0)); return result;
  })()`);
  assert.deepEqual(groups, [[0,1],[2],[3],[0]]);
});

test('a partial interior wall is constructed once and does not change the floor perimeter', () => {
  const app = loadDm();
  const room = read(app, `(() => {
    const M = {W:3,H:3,cells:Array(9).fill('.'),ground:Array(9).fill('s'),edges:new Map(),things:{}};
    normalize(M); M.edges.set('v1,1',{m:'stone',door:'portcullis',manual:true});
    const r = forgeRooms(M).rooms[0]; ed.M = M; measureAt({x:1,y:1});
    return {rooms:forgeRooms(M).rooms.length,walls:r.walls,perimeter:r.perimeter,doors:r.doors.length};
  })()`);
  assert.deepEqual(room, {rooms:1,walls:13,perimeter:12,doors:1});
  assert.match(app.element('fe-read').textContent, /perimeter.*60 ft/);
  assert.match(app.element('fe-read').textContent, /Built walls and doors total.*65 ft/);
});

test('Forge budget pluralizes portcullises and spiked pit choices include spike damage', () => {
  const app = loadDm();
  const label = app.evaluate(`(() => {
    const M = {W:12,H:9,cells:Array(108).fill('.'),ground:Array(108).fill('s'),edges:new Map(),things:{}};
    for(const k of ['v1,0','v2,0']) M.edges.set(k,{m:'stone',door:'portcullis',manual:true});
    const d = {size:'small',things:{}}; mapStore(d,M);
    ed.M=M; ed.tool='t'; ed.trap='spiked'; ed.depth=10; ed.sel=-1; renderInspect();
    return forgeCosts(d).lines.find(line => line[1]===2 && line[2]===8)[0];
  })()`);
  assert.equal(label, 'Portcullises');
  assert.match(app.element('fe-inspect').textContent, /1d6 \+ 2d10/);
  assert.match(app.element('fe-inspect').textContent, /3d6 \+ 2d10/);
});
