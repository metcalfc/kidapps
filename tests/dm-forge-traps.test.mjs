import test from 'node:test';
import assert from 'node:assert/strict';
import {loadDm} from './dm-harness.mjs';

const read = (app, expression) => JSON.parse(app.evaluate(`JSON.stringify(${expression})`));
const settle = async () => { for(let i=0;i<30;i++) await Promise.resolve(); };
const question = app => app.element('fp-enc').querySelector('.q').textContent;
function button(app, id, label) {
  const found = app.element(id).querySelectorAll('button').find(b => b.textContent === label || b.textContent.startsWith(label));
  assert.ok(found, `${id} should offer ${label}`); return found;
}
function grade(app, answer) {
  const box = app.element('fp-enc'), input = box.querySelector('input');
  if(input) input.value = String(answer);
  else button(app, 'fp-enc', answer).click();
  button(app, 'fp-enc', 'Check').click();
  assert.equal(box.querySelector('.feedback').classList.contains('good'), true, box.textContent);
}
async function next(app, rolls = []) {
  app.random(rolls);
  const b = app.element('fp-enc').querySelectorAll('button').find(b => !b.disabled && ['Continue','Next','Roll them'].includes(b.textContent));
  assert.ok(b, 'the question should offer a next step'); b.click(); await settle();
}
function editor(app, trap = 'spike', depth = 10) {
  app.evaluate(`(() => {
    const M={W:12,H:9,cells:Array(108).fill('.'),ground:Array(108).fill('s'),edges:new Map(),things:{}};
    M.cells[12]='S'; M.cells[107]='E';
    const d={id:'traps',v:2,size:'small',title:'Trap checks',rev:1,things:M.things}; mapStore(d,M);
    forge.dungeons=[d]; Object.assign(ed,{d,M,tool:'t',trap:${JSON.stringify(trap)},depth:${depth},sel:-1,stroke:null,undo:[]});
    renderTools(); renderInspect();
  })()`);
}
function place(app, x = 1, y = 1) { app.evaluate(`feDown({fx:${x+.5},fy:${y+.5}}); feUp();`); }
function play(app, shared = false) {
  app.evaluate(`forgePlay(${shared ? 'forgeClean(JSON.parse(JSON.stringify(ed.d)))' : 'ed.d'},'${shared ? 'friend' : 'test'}','trap-share'); fp.hp=fp.max=1000;`);
}
function startTrap(app, made) {
  app.random(made ? [0,.999999,.999999] : [.999999,0,0]);
  return app.evaluate('fpMove(13)');
}

test('changing a just-placed trap edits that trap and the tested/shared map uses its final depth and spikes', async () => {
  for(const shared of [false,true]) {
    const app = loadDm(); editor(app); place(app);
    button(app,'fe-inspect','Spiked pit').click();
    button(app,'fe-inspect','30 ft:').click();
    assert.deepEqual(read(app,'ed.d.things[13]'), {trap:'spiked',depth:30});
    assert.match(app.element('fe-inspect').textContent,/Editing the highlighted piece/);
    assert.match(app.element('fe-inspect').textContent,/3d6 falling damage plus 2d10/);
    play(app,shared);
    const moving=startTrap(app,false); grade(app,'Failed'); await next(app);
    assert.match(question(app),/fall 30 feet/); grade(app,3);
    await next(app,[0,.2,.4,.3,.4]); // 1 + 2 + 3 falling, 4 + 5 spikes.
    assert.match(question(app),/2d10/); grade(app,15); await next(app); await moving;
    assert.equal(app.evaluate('fp.hp'),985);
    assert.equal(app.evaluate('fp.pits.has(13)'),true);
    assert.equal(app.evaluate('ed.d.cells[13]'),'t');
    assert.deepEqual(read(app,'ed.d.things[13]'),{trap:'spiked',depth:30});
  }
});

test('every pit type and depth uses exactly its built dice, and a successful save avoids all damage', async () => {
  for(const trap of ['pit','spiked']) for(const depth of [10,20,30]) for(const made of [false,true]) {
    const app=loadDm(); editor(app,trap,depth); place(app); play(app,true);
    const moving=startTrap(app,made); grade(app,made?'Made it':'Failed'); await next(app);
    if(!made) {
      assert.match(question(app),new RegExp(`fall ${depth} feet`)); grade(app,depth/10);
      await next(app,Array(5).fill(0));
      const damage=depth/10+(trap==='spiked'?2:0);
      if(trap==='spiked') assert.match(question(app),/spikes.*2d10/);
      else assert.doesNotMatch(question(app),/spikes/);
      grade(app,damage); await next(app);
    }
    await moving;
    assert.equal(app.evaluate('fp.hp'),1000-(made?0:depth/10+(trap==='spiked'?2:0)),`${trap} ${depth} save ${made}`);
    await app.evaluate('fpMove(12)'); await app.evaluate('fpMove(13)');
    assert.equal(app.element('fp-enc').hidden,true,'an opened pit does not trigger a second hidden trap');
  }
});

test('spike traps use 2d6 and halve odd totals rounded down on a successful save', async () => {
  for(const made of [false,true]) {
    const app=loadDm(); editor(app); place(app); play(app);
    assert.match(app.element('fe-inspect').textContent,/2d6 damage.*Half damage, rounded down/);
    const moving=startTrap(app,made); grade(app,made?'Made it':'Failed'); await next(app,[.34,.5]); // 3 + 4.
    assert.match(question(app),/2d6: 3 and 4/); grade(app,made?3:7); await next(app); await moving;
    assert.equal(app.evaluate('fp.hp'),made?997:993);
    assert.equal(app.evaluate('fp.M.cells[13]'),'.');
  }
});

test('poison dart descriptions and play agree on base damage and poison for both saves', async () => {
  for(const made of [false,true]) {
    const app=loadDm(); editor(app,'dart'); place(app); play(app);
    assert.match(app.element('fe-inspect').textContent,/1d4 damage.*Constitution.*2d6 poison damage/);
    const moving=startTrap(app,made); grade(app,made?'Resisted':'Poisoned'); await next(app,[.999999,0,.999999]);
    grade(app,made?4:11); await next(app); await moving;
    assert.equal(app.evaluate('fp.hp'),made?996:989);
  }
});

test('a net only restrains, with a successful Strength check or three failed checks freeing the hero', async () => {
  for(const made of [false,true]) {
    const app=loadDm(); editor(app,'net'); place(app); play(app);
    assert.match(app.element('fe-inspect').textContent,/3 failed checks.*net deals no damage/);
    const moving=startTrap(app,made);
    for(let i=0;i<(made?1:3);i++) {
      assert.match(question(app),/Strength check/); grade(app,made?'Free!':'Still stuck');
      await next(app,[.999999,0,0]);
    }
    await moving;
    assert.equal(app.evaluate('fp.hp'),1000,'a net must not invent damaging rats');
    assert.doesNotMatch(app.element('fp-log').textContent,/rats|nibble/i);
    assert.equal(app.evaluate('fp.M.cells[13]'),'.');
  }
});

test('painting and editing a connected pit preserves its footprint and leaves separate traps alone', async () => {
  const app=loadDm(); editor(app,'pit',10);
  app.evaluate('feDown({fx:1.5,fy:1.5}); feMove({fx:2.5,fy:1.5}); feUp();');
  assert.equal(app.evaluate('ed.sel'),14);
  button(app,'fe-inspect','Spiked pit').click(); button(app,'fe-inspect','30 ft:').click();
  assert.deepEqual(read(app,'[ed.d.things[13],ed.d.things[14]]'),[{trap:'spiked',depth:30},{trap:'spiked',depth:30}]);
  button(app,'fe-tools','✶Trap').click(); // Set up a separate, shallower pit.
  assert.equal(app.evaluate('ed.sel'),-1);
  button(app,'fe-inspect','Pit').click(); button(app,'fe-inspect','10 ft:').click(); place(app,3,1);
  play(app); const moving=startTrap(app,true); grade(app,'Made it'); await next(app); await moving;
  assert.deepEqual(read(app,'[...fp.pits].sort((a,b)=>a-b)'),[13,14]);
  assert.equal(app.evaluate('fp.M.cells[15]'),'t');
  assert.equal(app.evaluate('fp.d.cells.slice(13,16)'),'ttt');
});

test('dragging a single-square spike, net or dart does not silently build extra traps', () => {
  for(const trap of ['spike','net','dart']) {
    const app=loadDm(); editor(app,trap);
    app.evaluate('feDown({fx:1.5,fy:1.5}); feMove({fx:4.5,fy:1.5}); feUp();');
    assert.equal(app.evaluate("ed.d.cells.split('t').length-1"),1,trap);
    assert.equal(app.evaluate('ed.sel'),13);
    assert.deepEqual(read(app,'ed.d.things[13]'),{trap});
  }
});

test('creatures, chests and signs changed immediately after placement save the displayed choice', () => {
  const app=loadDm(); editor(app);
  app.evaluate("progress.xp=2000; ed.tool='m'; ed.mon='Goblin';"); place(app);
  app.element('fe-mon').value='Ogre'; app.element('fe-mon').dispatchEvent({type:'change'});
  assert.equal(app.evaluate('ed.d.things[13].mon'),'Ogre');
  app.evaluate("ed.sel=-1; ed.tool='$'; ed.size='s';"); place(app,5,1);
  button(app,'fe-inspect','Large:').click(); assert.equal(app.evaluate('ed.d.things[17].size'),'l');
  app.evaluate("ed.sel=-1; ed.tool='s';"); place(app,6,1);
  app.element('fe-sign').value='Watch for the ogre.'; app.element('fe-sign').dispatchEvent({type:'input'});
  assert.equal(app.evaluate('ed.d.things[18].text'),'Watch for the ogre.');
});

test('door transitions cannot be raced to collect a key twice or skip a trap', async () => {
  const app=loadDm(); editor(app,'spike'); place(app);
  app.evaluate("ed.M.cells[14]='k'; ed.M.edges.set('v1,1',{m:'stone',door:'door',manual:true}); mapStore(ed.d,ed.M);");
  play(app); app.random([.999999,0,0]);
  const first=app.evaluate('fpMove(13)'), second=app.evaluate('fpMove(13)');
  await second; await settle();
  assert.equal(app.evaluate('fp.busy'),true);
  assert.equal(app.evaluate('fp.pos'),13);
  await app.evaluate('fpMove(14)'); assert.equal(app.evaluate('fp.keys'),0);
  grade(app,'Failed'); await next(app,[0,0]); grade(app,2); await next(app); await first;
  assert.equal(app.evaluate('fp.hp'),998); assert.equal(app.evaluate('fp.busy'),false);
  await app.evaluate('fpMove(14)'); assert.equal(app.evaluate('fp.keys'),1);
  await app.evaluate('fpMove(30)'); assert.equal(app.evaluate('fp.pos'),14,'moves must stay adjacent');
});
