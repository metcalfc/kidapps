import test from 'node:test';
import assert from 'node:assert/strict';
import {loadDm} from './dm-harness.mjs';

const read = (app, expression) => JSON.parse(app.evaluate(`JSON.stringify(${expression})`));
const settle = async () => { for(let i=0;i<40;i++)await Promise.resolve(); };
const turnCard = app => {
  const card=app.document.querySelector('.fp-monster-turn');
  assert.ok(card,"the monster's turn should have its own visible card");
  return card;
};
function start(app, hp=100) {
  app.evaluate(`(() => {
    const M={W:12,H:9,cells:Array(108).fill(' '),ground:Array(108).fill('s'),edges:new Map(),things:{1:{mon:'Zombie'}}};
    M.cells[0]='S';M.cells[1]='m';M.cells[2]='E';normalize(M);
    const d={id:'narration',v:2,size:'small',title:'See the monster roll',rev:1,things:M.things};mapStore(d,M);forge.dungeons=[d];
    forgePlay(d,'test');fp.hp=fp.max=${hp};settings.level=8;
  })()`);
}
function continueTurn(app) {
  const buttons=turnCard(app).querySelectorAll('button');
  assert.equal(buttons.length,1,'narration offers one acknowledgement, without a graded answer');
  assert.equal(buttons[0].textContent,'Continue');buttons[0].click();
}
function grade(app,answer) {
  const box=app.element('fp-enc'), input=box.querySelector('input');
  if(input)input.value=String(answer);
  else {
    const choice=box.querySelectorAll('button').find(b=>b.textContent===answer);
    assert.ok(choice,`the question must offer ${answer}`);choice.click();
  }
  box.querySelectorAll('button').find(b=>b.textContent==='Check').click();
  assert.equal(box.querySelector('.feedback').classList.contains('good'),true,box.textContent);
}
async function nextQuestion(app) {
  const next=app.element('fp-enc').querySelectorAll('button').find(b=>!b.disabled&&['Next','Continue'].includes(b.textContent));
  assert.ok(next,'the graded question must offer a next step');next.click();await settle();
}
const question = app => app.element('fp-enc').querySelector('.q').textContent;
function longsword(app) {
  return app.evaluate("(HERO_WEAPONS.findIndex(([name])=>name==='longsword')+.5)/HERO_WEAPONS.length");
}

test('every creature explains its weapon, attack arithmetic, damage and HP change before Continue',async()=>{
  const app=loadDm();start(app,1000);
  const monsters=read(app,'MONSTERS');
  for(const monster of monsters){
    const parsed=monster.atk.match(/^(\d+)d(\d+)([+-]\d+)?$/), count=+parsed[1], modifier=+(parsed[3]||0), damage=count+modifier;
    app.evaluate('fp.hp=1000;');
    const before=read(app,'({xp:progress.xp,stats:forge.stats})');
    app.random([.45,...Array(count).fill(0),.731234]); // d20 10 + 4 meets hero AC 14; minimum damage dice.
    let completed=false;
    const attack=app.evaluate(`fpMonsterAttack($('fp-enc'),forgeMonster(${JSON.stringify(monster.n)}))`).then(()=>{completed=true;});
    await settle();
    const card=turnCard(app), text=card.textContent;
    assert.match(text,/Monster['’]s turn/i,monster.n);
    assert.ok(text.includes(monster.n),monster.n);
    assert.ok(text.includes(monster.weapon),`${monster.n} must name its ${monster.weapon}`);
    const verbs={bite:'bites at',claws:'slashes its claws at',claw:'slashes its claw at',slam:'lashes out with a slam at',stinger:'stabs its stinger at'};
    assert.ok(text.includes(verbs[monster.weapon]||`swings its ${monster.weapon} at`),`${monster.n} should describe its action`);
    assert.match(text,/10\s*\+\s*4\s*=\s*14/,monster.n);
    assert.match(text,/(?:AC|Armor Class)\s*14/i,monster.n);
    assert.ok(text.includes(monster.atk),`${monster.n} must show its ${monster.atk} damage expression`);
    const sum=Array(count).fill('1').join('\\s*\\+\\s*')+(modifier>0?`\\s*\\+\\s*${modifier}`:'');
    assert.match(text,new RegExp(`${sum}\\s*=\\s*${damage}\\b`),`${monster.n} should explain the rolled damage sum`);
    assert.match(text,new RegExp(`1000[\\s\\S]*\\b${1000-damage}\\b`),`${monster.n} HP before and after`);
    assert.equal(app.evaluate('fp.hp'),1000-damage,'damage is applied before the explanation appears');
    assert.equal(completed,false,'the card waits for acknowledgement');
    assert.equal(card.querySelectorAll('input').length,0,'the explanation is not another quiz');
    assert.deepEqual(read(app,'({xp:progress.xp,stats:forge.stats})'),before,'narration does not award question XP');
    assert.equal(app.evaluate('Math.random()'),.731234,'narration uses only the original attack and damage rolls');
    continueTurn(app);await attack;
    assert.equal(completed,true);
    assert.deepEqual(read(app,'({xp:progress.xp,stats:forge.stats})'),before);
  }
});

test('an ordinary miss explains the failed total and consumes no damage dice',async()=>{
  const app=loadDm();start(app,40);app.random([.4,.731234]); // d20 9 + 4 = 13, below AC 14.
  const attack=app.evaluate("fpMonsterAttack($('fp-enc'),forgeMonster('Orc'))");await settle();
  const text=turnCard(app).textContent;
  assert.match(text,/9\s*\+\s*4\s*=\s*13/);
  assert.match(text,/(?:AC|Armor Class)\s*14/i);
  assert.match(text,/miss/i);
  assert.match(text,/(?:no damage|0 damage|damage[^.]*0)/i);
  assert.match(text,/40[\s\S]*40/,'a miss shows unchanged HP');
  assert.equal(app.evaluate('fp.hp'),40);
  assert.equal(app.evaluate('Math.random()'),.731234);
  continueTurn(app);await attack;
});

test('a natural 1 explains its automatic miss even with a bonus that would meet AC',async()=>{
  const app=loadDm();start(app,40);app.random([0,.731234]);
  const attack=app.evaluate("fpMonsterAttack($('fp-enc'),{...forgeMonster('Goblin'),bonus:20})");await settle();
  const text=turnCard(app).textContent;
  assert.match(text,/1\s*\+\s*20\s*=\s*21/);
  assert.match(text,/natural 1[^.]*miss/i);
  assert.equal(app.evaluate('fp.hp'),40);
  assert.equal(app.evaluate('Math.random()'),.731234);
  continueTurn(app);await attack;
});

test('a natural 20 doubles all damage dice and adds the modifier once',async()=>{
  const app=loadDm();start(app,40);
  app.random([.999999,0,.2,.4,.6,.731234]); // A critical Dire Wolf bite rolls four d6.
  const stats=read(app,"forgeMonster('Dire Wolf')"), modifier=+stats.atk.match(/([+-]\d+)$/)[1];
  const damage=1+2+3+4+modifier;
  const attack=app.evaluate("fpMonsterAttack($('fp-enc'),forgeMonster('Dire Wolf'))");await settle();
  const text=turnCard(app).textContent;
  assert.match(text,/20\s*\+\s*4\s*=\s*24/);
  assert.match(text,/natural 20/i);
  assert.match(text,/Critical Hit/i);
  assert.ok(text.includes(stats.atk));
  assert.ok(text.includes(`4d6+${modifier}`),'both original d6 are doubled');
  assert.match(text,/1\s*\+\s*2\s*\+\s*3\s*\+\s*4/,'the individual four dice are visible');
  assert.match(text,new RegExp(`40[\\s\\S]*\\b${40-damage}\\b`));
  assert.equal(app.evaluate('fp.hp'),40-damage);
  assert.equal(app.evaluate('Math.random()'),.731234,'critical damage consumes exactly four dice');
  continueTurn(app);await attack;
});

test('a lethal attack clamps HP to zero while keeping the full damage explanation visible',async()=>{
  const app=loadDm();start(app,3);app.random([.45,.999999]); // Orc 1d12 + 3 = 15.
  const attack=app.evaluate("fpMonsterAttack($('fp-enc'),forgeMonster('Orc'))");await settle();
  const text=turnCard(app).textContent;
  assert.ok(text.includes('1d12+3'));
  assert.match(text,/12\s*\+\s*3\s*=\s*15/);
  assert.match(text,/3[\s\S]*0/,'HP before and after remain visible');
  assert.equal(app.evaluate('fp.hp'),0);
  assert.equal(app.evaluate('fp.over'),false,'the caller can show defeat after acknowledgement');
  continueTurn(app);await attack;
});

test('combat pauses on the monster explanation before asking for the next hero attack',async()=>{
  const app=loadDm();start(app,100);app.random([longsword(app),0]);
  const fight=app.evaluate('fpMove(1)');
  assert.match(question(app),/d20 roll is 1 /);grade(app,'Miss');
  app.random([.45,0]);await nextQuestion(app);
  assert.match(turnCard(app).textContent,/Zombie/);
  assert.equal(app.evaluate('fp.hp'),98);
  assert.equal(app.evaluate('fp.busy'),true);
  const xp=app.evaluate('progress.xp'), tries=app.evaluate('forge.stats.tries');
  await app.evaluate('fpWait()');await app.evaluate('fpMove(2)');await settle();
  assert.ok(app.document.querySelector('.fp-monster-turn'));
  assert.equal(app.evaluate('fp.pos'),1);
  assert.equal(app.evaluate('progress.xp'),xp);
  assert.equal(app.evaluate('forge.stats.tries'),tries);
  app.random([.999999]);continueTurn(app);await settle();
  assert.match(question(app),/d20 roll is 20 /);
  assert.equal(app.evaluate('progress.xp'),xp,'Continue itself awards no XP');
  grade(app,'Hit');app.random([.999999,.999999]);await nextQuestion(app);
  grade(app,19);await nextQuestion(app);await fight;
  assert.equal(app.evaluate('fp.kills'),1);
  assert.equal(app.evaluate('fp.busy'),false);
  assert.equal(app.evaluate('fp.hp'),98);
});

test('lethal retaliation remains readable until Continue then shows defeat',async()=>{
  const app=loadDm();start(app,1);app.random([longsword(app),0]);
  const fight=app.evaluate('fpMove(1)');grade(app,'Miss');
  app.random([.45,0]);await nextQuestion(app);
  assert.equal(app.evaluate('fp.hp'),0);
  assert.equal(app.evaluate('fp.over'),false);
  assert.match(turnCard(app).textContent,/Zombie/);
  assert.doesNotMatch(app.element('fp-enc').textContent,/You are down/);
  continueTurn(app);await fight;
  assert.equal(app.evaluate('fp.over'),true);
  assert.match(app.element('fp-enc').textContent,/You are down/);
  assert.equal(app.evaluate('fp.kills'),0);
  assert.equal(app.evaluate('fp.turn'),0);
});

test('leaving or replaying cancels a monster explanation without resuming the old fight',async()=>{
  for(const action of ["show('home')","forgePlay(fp.d,'test')"]){
    const app=loadDm();start(app,100);app.random([longsword(app),0]);
    let finished=false;const fight=app.evaluate('fpMove(1)').then(()=>{finished=true;});grade(app,'Miss');
    app.random([.45,0]);await nextQuestion(app);
    const button=turnCard(app).querySelector('button'), xp=app.evaluate('progress.xp');
    app.evaluate(action);await settle();
    assert.equal(finished,true,action);await fight;
    const state=read(app,'({session:fp.session,hp:fp.hp,kills:fp.kills,pos:fp.pos,turn:fp.turn,busy:fp.busy,monsters:[...fp.monsters]})');
    button.click();await settle();
    assert.deepEqual(read(app,'({session:fp.session,hp:fp.hp,kills:fp.kills,pos:fp.pos,turn:fp.turn,busy:fp.busy,monsters:[...fp.monsters]})'),state,action);
    assert.equal(app.evaluate('progress.xp'),xp,action);
    assert.equal(app.evaluate('fp.busy'),false,action);
    if(action.startsWith('forgePlay')){
      assert.equal(app.evaluate('fp.hp'),app.evaluate('fp.max'));
      assert.equal(app.evaluate('fp.turn'),0);
      assert.equal(app.evaluate('fp.monsters.get(1).pos'),1);
    }
  }
});
