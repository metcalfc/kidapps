import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDm } from './dm-harness.mjs';

const read = (app, expression) => JSON.parse(app.evaluate(`JSON.stringify(${expression})`));
function editor(app, {cells = {}, things = {}, edges = [], fill = '.'} = {}) {
  app.evaluate(`(() => {
    progress.xp = 2000;
    const M = {W:12,H:9,cells:Array(108).fill(${JSON.stringify(fill)}),ground:Array(108).fill('s'),edges:new Map(${JSON.stringify(edges)}),things:${JSON.stringify(things)}};
    M.cells[106]='S'; M.cells[107]='E'; Object.assign(M.cells,${JSON.stringify(cells)}); normalize(M);
    const d = {id:'editor-state',v:2,size:'small',title:'Editor checks',rev:1,things:M.things}; mapStore(d,M);
    forge.dungeons=[d]; Object.assign(ed,{d,M,tool:'select',sel:-1,stroke:null,undo:[]}); feView.s=20;
    renderTools(); renderInspect(); renderBudget(); forgeSave();
  })()`);
}
function place(app, tool, x, y = 0) {
  app.evaluate(`ed.tool=${JSON.stringify(tool)}; feDown({fx:${x+.5},fy:${y+.5}}); feUp();`);
}
function select(app, x, y = 0) { place(app,'select',x,y); }
function button(app, label) {
  const found = app.element('fe-inspect').querySelectorAll('button').find(b => b.textContent === label || b.textContent.startsWith(label));
  assert.ok(found, `inspector should offer ${label}`); return found;
}
function pointer(app, type, id, x, y = .5) {
  app.element('fe-map').dispatchEvent({type,pointerId:id,pointerType:'touch',button:0,clientX:x*20,clientY:y*20});
}
function pinch(app, firstX, secondX) {
  pointer(app,'pointerdown',1,firstX); pointer(app,'pointerdown',2,secondX);
  pointer(app,'pointerup',1,firstX); pointer(app,'pointerup',2,secondX);
}
function type(app, value) {
  const input=app.element('fe-sign'); input.value=value; input.dispatchEvent({type:'input'});
}
function undo(app) { app.element('fe-undo').click(); }
function saved(app) { return read(app,"JSON.parse(localStorage.getItem('pda-forge')).dungeons[0]"); }

test('pinching cancels temporary placement and rebuilds the selected piece controls on the saved map', () => {
  const app=loadDm(); editor(app);
  app.evaluate("ed.size='s';"); place(app,'$',0);
  const before=read(app,'edSnapshot()'), revision=app.evaluate('ed.d.rev');
  pinch(app,1.5,3.5); // The first finger temporarily puts a chest at cell 1.
  assert.deepEqual(read(app,'edSnapshot()'),before);
  assert.equal(app.evaluate('ed.d.rev'),revision);
  assert.equal(app.evaluate('ed.sel'),0,'the previously highlighted chest stays selected');
  button(app,'Large:').click();
  assert.equal(app.evaluate('ed.M.cells.slice(0,2).join(\'\')'),'$.');
  assert.equal(app.evaluate('ed.d.cells.slice(0,2)'),'$.');
  assert.deepEqual(read(app,'ed.M.things[0]'),{size:'l'});
  assert.deepEqual(saved(app).things[0],{size:'l'});
  assert.equal(saved(app).cells.slice(0,2),'$.','the canceled chest must never reappear in a test or reload');
});

test('canceling the first placement clears its selection and leaves the next-piece setup usable', () => {
  const app=loadDm(); editor(app);
  app.evaluate("ed.tool='$'; ed.size='s'; renderInspect();");
  pinch(app,.5,3.5);
  assert.equal(app.evaluate('ed.sel'),-1);
  assert.doesNotMatch(app.element('fe-inspect').textContent,/Editing the highlighted piece/);
  button(app,'Large:').click(); place(app,'$',2);
  assert.equal(app.evaluate('ed.d.cells.slice(0,3)'),'..$');
  assert.deepEqual(saved(app).things[2],{size:'l'});
});

test('a canceled selection gesture leaves sign edits attached to the restored map', () => {
  const app=loadDm(); editor(app,{cells:{0:'s'},things:{0:{text:'Old clue'}}});
  select(app,0); pinch(app,.5,3.5); type(app,'New clue');
  assert.equal(app.evaluate('ed.M.things[0].text'),'New clue');
  assert.equal(saved(app).things[0].text,'New clue');
});

test('pointer cancellation discards a room preview without saving or adding undo history', () => {
  const app=loadDm(); editor(app,{fill:' '});
  const before=read(app,'edSnapshot()'); app.evaluate("ed.tool='room';");
  pointer(app,'pointerdown',1,.5,.5); pointer(app,'pointermove',1,2.5,2.5);
  pointer(app,'pointercancel',1,2.5,2.5);
  assert.deepEqual(read(app,'edSnapshot()'),before);
  assert.equal(app.evaluate('ed.d.rev'),1);
  assert.equal(app.evaluate('ed.undo.length'),0);
  assert.equal(app.evaluate('ed.preview'),null);
  assert.equal(saved(app).cells,before.cells,'the canceled preview must not dig out its nine floor squares');
  // A later ordinary gesture can still commit after pointer state was cleared.
  pointer(app,'pointerdown',2,.5); pointer(app,'pointerup',2,.5);
  assert.equal(saved(app).cells[0],'.'); assert.equal(app.evaluate('ed.d.rev'),2);
});

test('small movements over an erased door or wall preserve the floor and pieces beside it', () => {
  for(const edge of [{m:'stone',door:'locked',manual:true},{m:'stone',door:null,manual:true},{m:'bars',door:null,manual:true}]) {
    const app=loadDm(); editor(app,{cells:{0:'s',1:'k'},things:{0:{text:'Keep this clue'}},edges:[['v1,0',edge]]});
    app.evaluate("ed.tool='erase'; feDown({fx:1,fy:.5}); feMove({fx:1.01,fy:.5}); feMove({fx:.99,fy:.5}); feUp();");
    assert.equal(app.evaluate('ed.d.cells.slice(0,2)'),'sk',JSON.stringify(edge));
    assert.equal(saved(app).things[0].text,'Keep this clue');
    if(edge.door) assert.equal(app.evaluate("ed.M.edges.get('v1,0').door"),null);
    else assert.equal(app.evaluate("ed.M.edges.has('v1,0')"),false);
    // Filling a floor square on a separate, deliberate stroke still works.
    place(app,'erase',1); assert.equal(saved(app).cells[1],' ');
  }
});

test('undo reverses a creature change before removing an unrelated later placement', () => {
  const app=loadDm(); editor(app);
  app.evaluate("ed.mon='Goblin';"); place(app,'m',0); place(app,'$',5); select(app,0);
  app.element('fe-mon').value='Ogre'; app.element('fe-mon').dispatchEvent({type:'change'});
  assert.equal(saved(app).things[0].mon,'Ogre');
  undo(app);
  assert.equal(saved(app).things[0].mon,'Goblin');
  assert.equal(saved(app).cells[5],'$','undoing the creature edit preserves the unrelated chest');
  assert.equal(app.evaluate('ed.M.things[0].mon'),'Goblin');
  undo(app);
  assert.equal(saved(app).cells[5],'.'); assert.equal(saved(app).cells[0],'m');
});

test('undo restores chest size and ignores choosing its current size again', () => {
  const app=loadDm(); editor(app); app.evaluate("ed.size='s';"); place(app,'$',0);
  const revision=app.evaluate('ed.d.rev'); button(app,'Small:').click();
  assert.equal(app.evaluate('ed.d.rev'),revision);
  button(app,'Large:').click(); undo(app);
  assert.equal(saved(app).cells[0],'$'); assert.equal(saved(app).things[0].size,'s');
  undo(app); assert.equal(saved(app).cells[0],'.');
});

test('pit type and depth edits undo the entire footprint one change at a time', () => {
  const app=loadDm(); editor(app);
  app.evaluate("ed.tool='t'; ed.trap='pit'; ed.depth=10; feDown({fx:1.5,fy:1.5}); feMove({fx:2.5,fy:1.5}); feUp();");
  button(app,'Spiked pit').click(); button(app,'30 ft:').click();
  assert.deepEqual(read(app,'[ed.d.things[13],ed.d.things[14]]'),[{trap:'spiked',depth:30},{trap:'spiked',depth:30}]);
  undo(app);
  assert.deepEqual([saved(app).things[13],saved(app).things[14]],[{trap:'spiked',depth:10},{trap:'spiked',depth:10}]);
  undo(app);
  assert.deepEqual([saved(app).things[13],saved(app).things[14]],[{trap:'pit',depth:10},{trap:'pit',depth:10}]);
  undo(app); assert.equal(saved(app).cells.slice(13,15),'..');
});

test('sign typing coalesces within a focus session and preserves separate later editing sessions', () => {
  const app=loadDm(); editor(app); place(app,'s',0);
  for(const text of ['W','Wa','Watch','Watch the gate.']) type(app,text);
  undo(app);
  assert.equal(saved(app).cells[0],'s'); assert.equal(saved(app).things[0].text,'');
  select(app,0); type(app,'First clue');
  app.element('fe-sign').dispatchEvent({type:'blur'}); app.element('fe-sign').focus();
  type(app,'Second clue'); type(app,'Second clue, corrected');
  undo(app); assert.equal(saved(app).things[0].text,'First clue');
  undo(app); assert.equal(saved(app).things[0].text,'');
  undo(app); assert.equal(saved(app).cells[0],'.');
});

test('undo during an unfinished stroke cancels that stroke before touching previous work', () => {
  const app=loadDm(); editor(app); place(app,'$',0);
  app.evaluate("ed.tool='room'; feDown({fx:3.5,fy:1.5}); feMove({fx:5.5,fy:3.5});");
  undo(app); assert.equal(saved(app).cells[0],'$'); assert.equal(app.evaluate('ed.stroke'),null);
  undo(app); assert.equal(saved(app).cells[0],'.');
});
