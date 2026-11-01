import test from 'node:test';
import assert from 'node:assert/strict';
import {loadDm} from './dm-harness.mjs';

const settle=async()=>{for(let turn=0;turn<30;turn++)await Promise.resolve();};
const box=app=>app.element('fp-enc');
const prompt=app=>box(app).querySelector('.q').textContent;
function grade(app,answer){
  const input=box(app).querySelector('input');
  if(input)input.value=String(answer);
  else{
    const choice=box(app).querySelectorAll('button').find(button=>button.textContent===answer);
    assert.ok(choice,`choice ${answer} must be present`);choice.click();
  }
  box(app).querySelectorAll('button').find(button=>button.textContent==='Check').click();
  const feedback=box(app).querySelector('.feedback');
  assert.equal(feedback.classList.contains('good'),true,feedback.textContent);
  return feedback.textContent;
}
async function proceed(app){
  const next=box(app).querySelectorAll('button').find(button=>!button.disabled&&['Next','Continue'].includes(button.textContent));
  assert.ok(next,'the graded question must offer a next step');next.click();await settle();
}
function weaponFraction(app,name,melee=false){
  const index=app.evaluate(`${melee?'MELEE_WEAPONS':'HERO_WEAPONS'}.findIndex(([name])=>name===${JSON.stringify(name)})`);
  assert.ok(index>=0,`weapon ${name} must be available`);
  return (index+.5)/app.evaluate(`${melee?'MELEE_WEAPONS':'HERO_WEAPONS'}.length`);
}
function ready(app){app.evaluate('fp.hp=fp.max=100; fp.gold=0; fp.kills=0; settings.level=8;');}
function chestMath(question){
  let match;
  if(question.endsWith('How much treasure is that in all?')){
    match=question.match(/holds (\d+) gold pieces and (\d+) gems? worth (\d+) gold each/);
    assert.ok(match,question);return {kind:'total',answer:+match[1]+(+match[2])*(+match[3])};
  }
  if(question.includes('just the gem')){
    match=question.match(/holds (\d+) gold coins and (\d+) gems? worth (\d+) gold pieces each/);
    assert.ok(match,question);return {kind:'gems',answer:(+match[2])*(+match[3])};
  }
  if(question.endsWith('How many gold coins are there?')){
    match=question.match(/holds (\d+) gold pieces of treasure in all\. Its (\d+) gems? (?:is|are) worth (\d+) gold pieces each/);
    assert.ok(match,question);return {kind:'coins',answer:+match[1]-(+match[2])*(+match[3])};
  }
  match=question.match(/has (\d+) gems worth (\d+) gold pieces altogether/);
  assert.ok(match,question);assert.ok(+match[1]>=2,'division should use at least two gems');
  return {kind:'each',answer:+match[2]/+match[1]};
}

test('all chest sizes vary the requested calculation and still award their fixed full loot',async()=>{
  for(const [size,gold]of [['s',20],['m',50],['l',100]]){
    const app=loadDm({seed:85127});ready(app);
    const kinds=new Map(),answers=new Set();let previousKind;
    for(let index=0;index<32;index++){
      const opening=app.evaluate(`fpChest($('fp-enc'),{size:'${size}'})`),question=prompt(app),math=chestMath(question);
      assert.notEqual(math.kind,previousKind,'consecutive chests should practice different calculations');
      previousKind=math.kind;kinds.set(math.kind,(kinds.get(math.kind)||0)+1);answers.add(math.answer);
      assert.equal(app.evaluate('fp.gold'),index*gold,'loot waits until the chest question is completed');
      grade(app,math.answer);await proceed(app);await opening;
      assert.equal(app.evaluate('fp.gold'),(index+1)*gold);
    }
    assert.deepEqual([...kinds.keys()].sort(),['coins','each','gems','total']);
    for(const count of kinds.values())assert.equal(count,8,'each bag should cover every calculation');
    assert.ok(answers.size>=3,`${size} chest answers must vary, got ${[...answers]}`);
    assert.equal(app.evaluate('forge.stats.right'),32);
  }
});

test('a higher-level hero can miss a Zombie on natural 1 and then score a natural-20 Critical Hit',async()=>{
  const app=loadDm({seed:9147});ready(app);
  app.random([weaponFraction(app,'longsword'),0]);
  const fight=app.evaluate("fpFight($('fp-enc'),'Zombie')");
  assert.match(prompt(app),/d20 roll is 1 /);
  assert.match(grade(app,'Miss'),/natural 1 always misses/);
  app.random([0,.999999]);await proceed(app); // Enemy misses; its turn waits for Continue.
  assert.equal(app.evaluate('fp.hp'),100);assert.match(box(app).textContent,/Monster's turn.*natural 1 always misses/);
  await proceed(app);assert.match(prompt(app),/d20 roll is 20 /);
  assert.match(grade(app,'Hit'),/Critical Hit/);
  app.random([0,.999999]);await proceed(app); // 1 + 8, with the +3 modifier once.
  assert.match(prompt(app),/1d8\+3 becomes 2d8\+3/);
  assert.match(prompt(app),/dice show 1 and 8, and you add 3/);
  grade(app,12);await proceed(app);await fight;
  assert.equal(app.evaluate('fp.kills'),1);assert.equal(app.evaluate('fp.hp'),100);
  assert.match(app.element('fp-log').textContent,/hit the Zombie for 12/);
});

test('an ordinary hit keeps the normal damage die and modifier',async()=>{
  const app=loadDm({seed:7481});ready(app);
  app.random([weaponFraction(app,'longsword'),.05]); // Roll 2 + 6 exactly meets the Zombie's AC 8.
  const fight=app.evaluate("fpFight($('fp-enc'),'Zombie')");
  assert.match(prompt(app),/d20 roll is 2 /);assert.match(grade(app,'Hit'),/2 \+ 6 = 8/);
  app.random([.999999]);await proceed(app);
  assert.match(prompt(app),/longsword deals 1d8\+3/);assert.doesNotMatch(prompt(app),/Critical Hit/);
  grade(app,11);await proceed(app);await fight;
  assert.equal(app.evaluate('fp.kills'),1);assert.match(app.element('fp-log').textContent,/hit the Zombie for 11/);
});

test('a monster natural 20 doubles its damage dice and adds its modifier once',async()=>{
  const app=loadDm({seed:4217});ready(app);
  app.random([weaponFraction(app,'longsword'),0]);
  const fight=app.evaluate("fpFight($('fp-enc'),'Zombie')");grade(app,'Miss');
  app.random([.999999,0,.999999,.999999]);await proceed(app); // Enemy 20, damage 1 + 6 + 1.
  assert.equal(app.evaluate('fp.hp'),92);assert.match(app.element('fp-log').textContent,/Critical Hit! The Zombie's slam hits you for 8/);
  assert.match(box(app).textContent,/1d6\+1 becomes 2d6\+1/);
  await proceed(app); // Acknowledge the monster's turn, then the hero rolls 20.
  grade(app,'Hit');app.random([.999999,.999999]);await proceed(app);grade(app,19);await proceed(app);await fight;
  assert.equal(app.evaluate('fp.kills'),1);assert.equal(app.evaluate('fp.hp'),92);
});

test('smashing a wall includes natural misses and doubles every greatsword die on a critical',async()=>{
  const app=loadDm({seed:8847});ready(app);
  app.random([weaponFraction(app,'greatsword',true),0]);
  const smashing=app.evaluate("fpSmash($('fp-enc'))");
  assert.match(prompt(app),/d20 roll is 1 /);assert.match(grade(app,'Miss'),/natural 1 always misses/);
  app.random([.999999]);await proceed(app);
  assert.match(prompt(app),/d20 roll is 20 /);assert.match(grade(app,'Hit'),/Critical Hit/);
  app.random([0,.2,.4,.6]);await proceed(app); // Four d6: 1, 2, 3, 4; +3 once = 13.
  assert.match(prompt(app),/2d6\+3 becomes 4d6\+3/);
  assert.match(prompt(app),/dice show 1, 2, 3 and 4, and you add 3/);
  grade(app,13);await proceed(app);await smashing;
  assert.match(app.element('fp-log').textContent,/planks give way/);
});
