import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDm } from './dm-harness.mjs';

const read = (app, expression) => JSON.parse(app.evaluate(`JSON.stringify(${expression})`));
const numeric = {q:'Average damage?',answer:5.5,hint:'Eleven divided by two.',solution:'5.5 damage.'};
const choice = {q:'Which ability?',choices:['Strength','Dexterity','Either'],answer:'Either',hint:'Compare the modifiers.',solution:'The modifiers are equal.'};

function present(app, mode, step = numeric, challenge = false) {
  if(mode === 'lesson') {
    app.evaluate(`current.module=MODULES.find(m=>m.id==='dice');
      current.problem={from:'dice',gen:'genDiceAverage',steps:[${JSON.stringify(step)}],reviewClean:true,challenge:${challenge}};
      current.step=0;current.tries=0;current.choice=null;renderSteps();`);
    return {box:app.element('steps'),input:app.element('steps').querySelector('input'),check:app.element('check-btn'),feedback:app.element('feedback')};
  }
  app.evaluate(`globalThis.askResult=forgeAsk($('fp-enc'),${JSON.stringify(step)});`);
  const box = app.element('fp-enc');
  return {box,input:box.querySelector('input'),check:box.querySelector('.actions button'),feedback:box.querySelector('.feedback')};
}
function submit(ui, value) {
  if(ui.input) ui.input.value = value;
  else ui.box.querySelectorAll('.choices button').find(b=>b.textContent===value).click();
  ui.check.click();
}
function replay(ui) {
  ui.check.dispatchEvent({type:'click'});
  if(ui.input) ui.input.dispatchEvent({type:'keydown',key:'Enter'});
}
const graded = (app, mode) => mode === 'lesson' ? read(app, 'progress.modules.dice || {correct:0,tries:0}') : read(app, '({correct:forge.stats.right,tries:forge.stats.tries})');

test('the shared attempt transition leaves inputs unchanged and resolves only once', () => {
  const app = loadDm();
  const result = read(app, `(() => {
    const state=Object.freeze({phase:'answering',tries:0}),step=Object.freeze(${JSON.stringify(numeric)});
    const empty=questionAttempt(state,step,'');
    const hint=questionAttempt(state,step,'7');
    const answer=questionAttempt(hint.state,step,'5 1/2');
    const duplicate=questionAttempt(answer.state,step,'5.5');
    const canceled=questionAttempt({phase:'canceled',tries:0},step,'5.5');
    return {state,empty:empty.kind,hint,answer,duplicate:duplicate.kind,canceled:canceled.kind};
  })()`);
  assert.deepEqual(result.state,{phase:'answering',tries:0});
  assert.equal(result.empty,'empty-number');
  assert.equal(result.hint.kind,'hint');
  assert.deepEqual(result.hint.state,{phase:'answering',tries:1});
  assert.equal(result.answer.result,'second');
  assert.equal(result.answer.state.phase,'resolved');
  assert.equal(result.duplicate,'ignored');
  assert.equal(result.canceled,'ignored');
});

for(const mode of ['lesson','forge']) {
  test(`${mode} preserves numeric parsing, tolerance and first/second/missed rewards`, async () => {
    for(const [answers,gain,correct,result] of [
      [['+5.51'],mode==='lesson'?10:5,1,'first'],
      [['8','11/2'],mode==='lesson'?5:2,1,'second'],
      [['8','9'],0,0,'missed'],
    ]) {
      const app=loadDm(),ui=present(app,mode);
      submit(ui,'not a number');
      assert.match(ui.feedback.textContent,/Type a number/);
      assert.equal(app.evaluate('progress.xp'),0);
      assert.equal(graded(app,mode).tries,0);
      for(let i=0;i<answers.length;i++) {
        submit(ui,answers[i]);
        if(i===0&&answers.length===2) {
          assert.match(ui.feedback.textContent,/Not quite.*Eleven divided by two/);
          assert.equal(graded(app,mode).tries,0);
        }
      }
      assert.equal(app.evaluate('progress.xp'),gain);
      assert.deepEqual(graded(app,mode),{correct,tries:1});
      const progress=app.evaluate('JSON.stringify(progress)'),stats=app.evaluate('JSON.stringify(forge.stats)');
      replay(ui);
      assert.equal(app.evaluate('JSON.stringify(progress)'),progress,'queued checks cannot grade a resolved question');
      assert.equal(app.evaluate('JSON.stringify(forge.stats)'),stats);
      assert.ok(ui.input.disabled);
      if(mode==='forge') {
        ui.box.querySelector('.actions button').click();
        assert.equal(await app.evaluate('askResult'),result);
      }
    }
  });

  test(`${mode} shares choice selection and ignores canceled or detached controls`, async () => {
    const app=loadDm(),ui=present(app,mode,choice);
    ui.check.click();
    assert.match(ui.feedback.textContent,/Pick one of the choices/);
    submit(ui,'Strength');
    assert.match(ui.feedback.textContent,/Not quite.*Compare the modifiers/);
    submit(ui,'Either');
    assert.equal(app.evaluate('progress.xp'),mode==='lesson'?5:2);
    assert.equal(ui.box.querySelectorAll('.choices button').find(b=>b.textContent==='Either').getAttribute('aria-pressed'),'true');
    replay(ui);
    assert.deepEqual(graded(app,mode),{correct:1,tries:1});
    if(mode==='forge') {
      ui.box.querySelector('.actions button').click();
      assert.equal(await app.evaluate('askResult'),'second');
    }
    const old=present(app,mode),next=present(app,mode);
    old.input.value='5.5'; replay(old);
    assert.deepEqual(graded(app,mode),{correct:1,tries:1});
    app.evaluate("show('home')");
    next.input.value='5.5'; replay(next);
    assert.deepEqual(graded(app,mode),{correct:1,tries:1});
    if(mode==='forge') assert.equal(await app.evaluate('askResult'),'canceled');
  });
}

test('lesson challenge, daily completion and boss callbacks run once per resolved answer', () => {
  const challengeApp=loadDm(),challengeUi=present(challengeApp,'lesson',numeric,true);
  submit(challengeUi,'5.5'); replay(challengeUi);
  assert.equal(challengeApp.evaluate('progress.xp'),20);

  const dailyApp=loadDm(),dailyUi=present(dailyApp,'lesson');
  dailyApp.evaluate("current.module={id:'daily',mixed:true};daily().done=DAILY_GOAL-1;");
  submit(dailyUi,'5.5'); replay(dailyUi);
  assert.equal(dailyApp.evaluate('progress.xp'),35);
  assert.equal(dailyApp.evaluate('daily().done'),5);
  assert.equal(dailyApp.evaluate('daily().streak'),1);

  for(const [answers,expected] of [[['5.5'],[true]],[['7','5.5'],[false]],[['7','8'],['attack']]]) {
    const app=loadDm(),ui=present(app,'lesson');
    app.evaluate("boss.active=true;globalThis.hits=[];bossHit=first=>hits.push(first);bossAttack=()=>hits.push('attack');");
    for(const answer of answers) submit(ui,answer);
    replay(ui);
    assert.deepEqual(read(app,'hits'),expected);
  }
});

test('stale lesson Continue cannot advance a new question', () => {
  const app=loadDm(),old=present(app,'lesson');
  submit(old,'5.5');
  const next=app.element('next-btn');
  next.click();
  const problem=app.evaluate('current.problem');
  next.dispatchEvent({type:'click'});
  assert.equal(app.evaluate('current.problem'),problem);
});

test('canceling Forge play settles the question and rejects its play continuation', async () => {
  const app=loadDm();
  app.evaluate(`globalThis.playResult=fpAsk($('fp-enc'),${JSON.stringify(numeric)}).then(()=>false,error=>error===FP_CANCELED);`);
  const box=app.element('fp-enc'),input=box.querySelector('input'),check=box.querySelector('.actions button');
  app.evaluate('fpCancel()');
  assert.equal(await app.evaluate('playResult'),true);
  input.value='5.5'; replay({input,check});
  assert.equal(app.evaluate('progress.xp'),0);
  assert.equal(app.evaluate('forge.stats.tries'),0);
});

test('generated lesson references cover every supported encounter level and die', () => {
  const app=loadDm();
  const references=read(app, `({encounter:MODULES.find(m=>m.id==='encounter').lesson,dice:MODULES.find(m=>m.id==='dice').lesson,thresholds:XP_THRESH,averages:DICE_AVG})`);
  const rows=[...references.encounter.matchAll(/<tr><td>(\d+)<\/td>(.*?)<\/tr>/g)].map(([,level,cells])=>[level,[...cells.matchAll(/<td>(\d+)<\/td>/g)].map(m=>Number(m[1]))]);
  assert.deepEqual(Object.fromEntries(rows),references.thresholds);
  assert.equal(rows.length,8);
  for(const [die,average] of Object.entries(references.averages)) {
    assert.ok(references.dice.includes(`<td>d${die}</td>`));
    assert.ok(references.dice.includes(`<td>${average}</td>`));
  }
});

test('selecting the active Boss view keeps its current question answerable', () => {
  const app=loadDm(),ui=present(app,'lesson');
  app.evaluate("boss.active=true;bossHit=()=>{};show('boss');");
  submit(ui,'5.5');
  assert.equal(app.evaluate('progress.xp'),10);
});

test('replacing or leaving the commission question cannot claim its reward through old controls', async () => {
  for(const action of ['renderBoard()','renderForge()',"forgeEdit('commission-map')","show('home')"]) {
    const app=loadDm();
    app.evaluate(`forge.dungeons=[{id:'commission-map',v:2,size:'small',title:'One square',cells:'S'+' '.repeat(107),ground:'s'.repeat(108),walls:'.'.repeat(237),things:{},rev:1}];
      forge.board=[{kind:'area',id:'area-job',n:1}];renderBoard();`);
    const card=app.element('forge-board').querySelectorAll('.commission').find(c=>c.textContent.includes('exactly 1 squares'));
    card.querySelector('button').click();
    const box=card.querySelector('.ask'),input=box.querySelector('input'),check=box.querySelector('.actions button');
    app.evaluate(action);
    input.value='20'; replay({input,check});
    await Promise.resolve();
    assert.equal(app.evaluate('progress.xp'),0,action);
    assert.equal(app.evaluate('forge.stats.commissions || 0'),0,action);
    assert.equal(app.evaluate("forge.board.some(c=>c.id==='area-job')"),true,action);
  }
});
