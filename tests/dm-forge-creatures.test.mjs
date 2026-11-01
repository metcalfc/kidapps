import test from 'node:test';
import assert from 'node:assert/strict';
import {loadDm} from './dm-harness.mjs';

const read = (app, expression) => JSON.parse(app.evaluate(`JSON.stringify(${expression})`));
function editor(app, additions = {}) {
  app.evaluate(`(() => {
    progress.xp = 2000;
    const M = {W:12,H:9,cells:Array(108).fill('.'),ground:Array(108).fill('s'),edges:new Map(),things:{}};
    M.cells[106] = 'S'; M.cells[107] = 'E';
    M.cells[0] = 'm'; M.things[0] = {mon:'Goblin'};
    for(const [i, item] of Object.entries(${JSON.stringify(additions)})) {
      M.cells[i] = item.cell; if(item.thing) M.things[i] = item.thing;
    }
    const d = {id:'creatures',v:2,size:'small',title:'Creature checks',things:M.things,rev:1};
    normalize(M); mapStore(d,M);
    forge.dungeons = [d];
    Object.assign(ed,{d,M,tool:'select',sel:0,stroke:null,undo:[]});
    renderInspect();
  })()`);
}
function chooseMonster(app, name) {
  const picker = app.element('fe-mon'); picker.value = name; picker.dispatchEvent({type:'change'});
}

test('every creature shows the same Forge HP, armor, attack and damage used in combat', async () => {
  const app = loadDm();
  editor(app);
  // This broad stats check acknowledges narration; the narration suite checks the pause itself.
  app.evaluate(`const statsMonsterAttack=fpMonsterAttack; fpMonsterAttack=(...args)=>{
    const response=statsMonsterAttack(...args); $('fp-enc').querySelector('.fp-monster-turn').querySelector('button').click(); return response;
  };`);
  const monsters = read(app, 'MONSTERS');
  for(const monster of monsters) {
    const expectedHp = Math.max(4, Math.round(monster.hp / 3));
    const stats = read(app, `forgeMonster(${JSON.stringify(monster.n)})`);
    assert.equal(stats.hp, expectedHp, monster.n);
    assert.equal(stats.ac, monster.ac, monster.n);
    assert.equal(stats.atk, monster.atk, monster.n);
    assert.equal(stats.bonus, 4, monster.n);
    app.evaluate(`ed.tool='m'; ed.sel=-1; ed.mon=${JSON.stringify(monster.n)}; renderInspect();`);
    const inspector = app.element('fe-inspect').textContent;
    assert.ok(inspector.includes(`${expectedHp} HP`), `${monster.n}: ${inspector}`);
    assert.ok(inspector.includes(`AC ${monster.ac}`), `${monster.n}: ${inspector}`);
    assert.ok(inspector.includes(monster.atk), `${monster.n}: ${inspector}`);
    assert.ok(inspector.includes('+4'), `${monster.n}: ${inspector}`);

    // The first hero attack misses, the monster rolls 10 + 4 = AC 14 and
    // minimum damage, then critical greatsword hits finish the fight.
    const damage = monster.atk.match(/^(\d+)d(\d+)([+-]\d+)?$/);
    assert.ok(damage, monster.atk);
    const minimum = +damage[1] + +(damage[3] || 0);
    const rolls = [.999999, 0, .45, ...Array(+damage[1]).fill(0), .999999, ...Array(4).fill(.999999)];
    if(expectedHp > 27) rolls.push(0, .999999, ...Array(4).fill(.999999));
    app.random(rolls);
    app.evaluate(`fp.hp=fp.max=1000; fp.kills=0; settings.level=8; $('fp-enc').textContent='';
      forgeAsk = async () => 'first';`);
    const fight=app.evaluate(`fpFight($('fp-enc'),${JSON.stringify(monster.n)})`);
    assert.ok(app.element('fp-enc').textContent.includes(`${expectedHp} / ${expectedHp} HP · AC ${monster.ac}`), monster.n);
    await fight;
    assert.equal(app.evaluate('fp.hp'), 1000 - minimum, `${monster.n} damage must use its displayed dice`);
    assert.equal(app.evaluate('fp.kills'), 1, monster.n);
  }
});

test('placing or enlarging a monster cannot cover another creature or map feature', () => {
  const features = {
    m:{mon:'Kobold'}, S:null, E:null, k:null,
    $:{size:'l'}, t:{trap:'spiked',depth:30}, s:{text:'Keep this sign'},
  };
  for(const [cell, thing] of Object.entries(features)) {
    for(const action of ['inspect','place']) {
      const app = loadDm(); editor(app, {1:{cell,thing}});
      const before = read(app, 'edSnapshot()');
      if(action === 'inspect') chooseMonster(app, 'Ogre');
      else app.evaluate("ed.tool='m'; ed.mon='Ogre'; feDown({fx:.5,fy:.5}); feUp();");
      assert.deepEqual(read(app, 'edSnapshot()'), before, `${action} over ${cell} must preserve every piece`);
      assert.equal(app.evaluate('ed.d.rev'), 1, `${action} over ${cell} must not save a change`);
      assert.match(app.element('fe-read').textContent, /empty|room|bigger|overlap/i);
    }
  }
});

test('a monster can grow into empty floor and shrink without leaving occupied squares', () => {
  const app = loadDm(); editor(app);
  chooseMonster(app, 'Hill Giant');
  assert.equal(app.evaluate('ed.d.things[0].mon'), 'Hill Giant');
  assert.equal(app.evaluate('monsterSquares(ed.M).size'), 9);
  chooseMonster(app, 'Goblin');
  assert.equal(app.evaluate('ed.d.things[0].mon'), 'Goblin');
  assert.deepEqual(read(app, '[...monsterSquares(ed.M)]'), [[0,0]]);
});

test('map validation catches overlapping creature footprints and covered features', () => {
  for(const feature of ['m','S','E','k','$','t','s']) {
    const app = loadDm();
    const things = {m:{mon:'Kobold'}, $:{size:'s'}, t:{trap:'pit',depth:10}, s:{text:'Hello'}};
    editor(app, {1:{cell:feature,thing:things[feature]}});
    app.evaluate("ed.M.things[0].mon='Ogre'; mapStore(ed.d,ed.M);");
    const problems = read(app, 'forgeProblems(ed.d)');
    assert.ok(problems.some(p => /Ogre/.test(p)), `covered ${feature}: ${problems}`);
  }
  const app = loadDm(); editor(app);
  app.evaluate(`ed.M.cells[0]='.'; delete ed.M.things[0];
    ed.M.cells[1]=ed.M.cells[12]='m'; ed.M.things[1]={mon:'Ogre'}; ed.M.things[12]={mon:'Ogre'}; mapStore(ed.d,ed.M);`);
  assert.ok(read(app, 'forgeProblems(ed.d)').some(p => /Ogre/.test(p)), 'footprints may overlap even when neither covers the other anchor');
});

test('entering any square of a Large or Huge creature fights that creature once', async () => {
  const app = loadDm();
  const creatures = read(app, 'MONSTERS.filter(m => monSpan(m.n)>1).map(m => ({name:m.n,span:monSpan(m.n)}))');
  for(const {name,span} of creatures) {
    for(let dy=0;dy<span;dy++) for(let dx=0;dx<span;dx++) {
      const result = await app.evaluate(`(async () => {
        const M={W:12,H:9,cells:Array(108).fill('.'),ground:Array(108).fill('s'),edges:new Map(),things:{26:{mon:${JSON.stringify(name)}}}};
        M.cells[0]='S'; M.cells[26]='m'; M.cells[107]='E';
        const covered=footprint(M,26,${span}), target=26+${dy}*12+${dx};
        const before=steps(M,target).find(([j])=>!covered.includes(j));
        // Interior Huge squares use an adjacent covered square as the hero's
        // current position, without changing the built creature footprint.
        const start=before ? before[0] : target-1;
        const d={v:2,size:'small',title:'Footprints',things:M.things}; mapStore(d,M);
        const fought=[]; fpFight=async (_box,n)=>{fought.push(n);fp.kills++;};
        forgePlay(d,'test'); fp.pos=start; await fpMove(target);
        const left=fp.occ.size; await fpMove(start); await fpMove(target);
        return {fought,left,anchor:fp.M.cells[26],source:d.cells[26]};
      })()`);
      assert.deepEqual(JSON.parse(JSON.stringify(result)), {fought:[name],left:0,anchor:'.',source:'m'}, `${name} square ${dx},${dy}`);
    }
  }
});

test('sharing cleanup preserves every creature choice, size and footprint on every map size', () => {
  const app = loadDm();
  const result = read(app, `Object.keys(SIZES).flatMap(size => MONSTERS.map(mon => {
    const S=SIZES[size], cells=Array(S.w*S.h).fill('.'); cells[0]='S'; cells[cells.length-1]='E'; cells[S.w+1]='m';
    const d={v:2,size,title:mon.n,cells:cells.join(''),ground:'c'.repeat(cells.length),walls:'.'.repeat(wallCount(S.w,S.h)),things:{[S.w+1]:{mon:mon.n}}};
    const clean=forgeClean(JSON.parse(JSON.stringify(d))), M=mapOf(clean);
    return {size,name:mon.n,cleanName:clean.things[S.w+1].mon,cells:clean.cells===d.cells,span:monSpan(mon.n),occupied:monsterSquares(M).size};
  }))`);
  for(const map of result) {
    assert.equal(map.cleanName, map.name, `${map.size} ${map.name}`);
    assert.equal(map.cells, true, `${map.size} ${map.name}`);
    assert.equal(map.occupied, map.span ** 2, `${map.size} ${map.name}`);
  }
});

test('shared maps with overlapping creatures are rejected; a valid high-budget map remains playable', async () => {
  const app = loadDm(); editor(app, {1:{cell:'t',thing:{trap:'spiked',depth:30}}});
  app.evaluate(`ed.d.things[0].mon='Ogre';
    globalThis.fetch=async()=>({ok:true,status:200,json:async()=>JSON.parse(JSON.stringify(ed.d))});`);
  await app.evaluate("forgeJoin('OTTER-4821')");
  assert.match(app.element('forge-join-msg').textContent,/repair/);
  assert.equal(app.evaluate('fp.M'),null);
  assert.equal(app.evaluate("forge.played['OTTER-4821']"),undefined);

  // A visitor's rank must not impose their building budget on a friend's map.
  app.evaluate("ed.M.cells[1]='.'; delete ed.M.things[1]; mapStore(ed.d,ed.M); progress.xp=0; ed.d.things[0].mon='Young Green Dragon';");
  await app.evaluate("forgeJoin('OTTER-4821')");
  assert.equal(app.evaluate('fp.mode'),'friend');
  assert.equal(app.evaluate('fp.M.things[0].mon'),'Young Green Dragon');
});
