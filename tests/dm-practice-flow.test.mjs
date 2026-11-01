import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDm } from './dm-harness.mjs';

const read = (app, expression) => JSON.parse(app.evaluate(`JSON.stringify(${expression})`));
const longestRun = values => {
  let longest = 0, run = 0, previous;
  for (const value of values) { run = value === previous ? run + 1 : 1; longest = Math.max(longest, run); previous = value; }
  return longest;
};

test('practice bags cover every outcome before refilling and retain deliberate weights', () => {
  const app = loadDm();
  const draws = read(app, `Array.from({length:120}, () => practicePick('coverage-fixture', ['below','low','moderate','high']))`);
  for (let i = 0; i < draws.length; i += 4) assert.equal(new Set(draws.slice(i, i + 4)).size, 4);
  assert.equal(longestRun(draws), 1);
  const weighted = read(app, `Array.from({length:120}, () => practicePick('weighted-fixture', ['build','build','fit']))`);
  assert.equal(weighted.filter(v => v === 'build').length, 80);
  assert.equal(weighted.filter(v => v === 'fit').length, 40);
  assert.ok(longestRun(weighted) <= 2);
});

test('a cooldown preserves the undrawn exercises instead of resetting their bag', () => {
  const app = loadDm();
  const draws = read(app, `[
    practicePick('cooldown-fixture', ['a','b','c'], v => v==='a'),
    practicePick('cooldown-fixture', ['a','b','c'], v => v==='a'),
    practicePick('cooldown-fixture', ['a','b','c']),
    practicePick('cooldown-fixture', ['a','b','c'])
  ]`);
  assert.deepEqual(draws.slice(0, 2), ['a', 'a']);
  assert.deepEqual(draws.slice(2).sort(), ['b', 'c']);
});

test('every lesson schedules its question types without long runs at starting and advanced settings', () => {
  const app = loadDm();
  for (const [level, xp] of [[1, 0], [8, 2000]]) {
    app.evaluate(`settings.level=${level}; progress.xp=${xp}; progress.review={};`);
    const samples = read(app, `MODULES.filter(m => m.gens.length).map(m => {
      current.module=m;
      return {id:m.id, expected:[...new Set(m.gens.map(g => g.name))], draws:Array.from({length:120}, () => { nextProblem(); return current.problem.gen; })};
    })`);
    for (const { id, expected, draws } of samples) {
      assert.deepEqual([...new Set(draws)].sort(), expected.sort(), `${id}, level ${level}, XP ${xp}`);
      if (expected.length > 1) assert.ok(longestRun(draws) <= 2, `${id} repeated a type too often`);
    }
  }
});

test('review cannot monopolize a lesson even when only Encounter Build is due', () => {
  const app = loadDm();
  const samples = read(app, `(() => {
    current.module=MODULES.find(m => m.id==='encounter'); progress.review={genEncounterBuild:2};
    return Array.from({length:600}, () => { nextProblem(); return {gen:current.problem.gen,review:current.problem.review}; });
  })()`);
  assert.ok(samples.some(p => p.review), 'review must still be scheduled');
  assert.ok(samples.some(p => p.gen === 'genEncounterFit'), 'division practice must still be scheduled');
  assert.ok(longestRun(samples.map(p => p.gen)) <= 2);
});

test('mixed, daily and boss practice cover every lesson without long generator runs', () => {
  for (const mode of ['mixed', 'daily', 'boss']) {
    const app = loadDm();
    const result = read(app, `(() => {
      const lessons=MODULES.filter(m => m.gens.length);
      current.module={id:${JSON.stringify(mode)},title:'Mixed practice',mixed:true,gens:[]};
      boss.active=${mode === 'boss'};
      const draws=Array.from({length:lessons.length*4}, () => { nextProblem(); return {from:current.problem.from,gen:current.problem.gen,review:current.problem.review}; });
      return {expected:lessons.map(m => m.id),draws};
    })()`);
    const n = result.expected.length;
    for (let i = 0; i < result.draws.length; i += n) {
      assert.deepEqual(result.draws.slice(i, i + n).map(p => p.from).sort(), result.expected.slice().sort(), mode);
    }
    assert.ok(longestRun(result.draws.map(p => p.gen)) <= 2, mode);
    if (mode === 'boss') assert.ok(result.draws.every(p => !p.review));
  }
});

function presentExample(app) {
  app.evaluate(`
    current.module=MODULES.find(m => m.id==='encounter');
    current.problem={from:'encounter',gen:'genEncounterBuild',reviewClean:true,steps:[
      {q:'Party budget?',answer:600,hint:'Four times 150.',solution:'600 XP.'},
      {q:'Monster XP?',answer:900,hint:'Add the XP.',solution:'900 XP.'},
      {q:'Difficulty?',choices:['Low','Moderate','High'],answer:'Moderate',hint:'Compare.',solution:'Moderate.'}
    ]}; current.step=0; current.tries=0; current.choice=null; renderSteps();
  `);
}
function answer(app, value) {
  const step = read(app, 'current.problem.steps[current.step]');
  if (step.choices) app.element('steps').querySelectorAll('.choices button').find(b => b.textContent === String(value)).click();
  else app.element('answer-input').value = String(value);
  app.element('check-btn').click();
}
function finishExample(app) {
  while (true) {
    answer(app, read(app, 'current.problem.steps[current.step].answer'));
    if (app.evaluate('current.step === current.problem.steps.length - 1')) break;
    app.element('next-btn').click();
  }
}

test('missing a budget calculation cannot be cleared by the other steps of the same example', () => {
  const app = loadDm();
  presentExample(app);
  answer(app, -999); answer(app, -999);
  assert.equal(app.evaluate('progress.review.genEncounterBuild'), 2);
  assert.equal(app.evaluate('progress.reviewPrompts.genEncounterBuild'), 'Party budget?');
  const bagState = app.evaluate('JSON.stringify([...practiceBags])');
  app.evaluate("sessionStorage.setItem('pda-parent','1'); renderParent()");
  assert.match(app.element('p-review').textContent, /Party budget\?.*2 more complete examples/);
  assert.equal(app.evaluate('JSON.stringify([...practiceBags])'), bagState, 'the parent report must not consume practice outcomes');
  app.element('next-btn').click();
  finishExample(app);
  assert.equal(app.evaluate('progress.review.genEncounterBuild'), 2);

  presentExample(app);
  answer(app, 600);
  assert.equal(app.evaluate('progress.review.genEncounterBuild'), 2, 'one step is not a complete example');
  app.element('next-btn').click(); finishExample(app);
  assert.equal(app.evaluate('progress.review.genEncounterBuild'), 1);
  presentExample(app); finishExample(app);
  assert.equal(app.evaluate('progress.review.genEncounterBuild'), undefined);
  const saved = JSON.parse(app.evaluate("localStorage.getItem('pda-progress')"));
  assert.equal(saved.review.genEncounterBuild, undefined);
  assert.equal(saved.reviewPrompts.genEncounterBuild, undefined);
});

test('a hint on any step keeps a review example outstanding', () => {
  const app = loadDm();
  app.evaluate('progress.review={genEncounterBuild:2}');
  presentExample(app);
  answer(app, -999); answer(app, 600);
  app.element('next-btn').click(); finishExample(app);
  assert.equal(app.evaluate('progress.review.genEncounterBuild'), 2);
  presentExample(app); finishExample(app);
  assert.equal(app.evaluate('progress.review.genEncounterBuild'), 1);
});

test('single-step review requires two new unassisted examples', () => {
  const app = loadDm();
  app.evaluate(`
    current.module=MODULES.find(m => m.id==='encounter');
    current.problem={from:'encounter',gen:'fixture',steps:[{answer:1}],reviewClean:true};
    current.step=0; current.tries=1; record(false);
  `);
  assert.equal(app.evaluate('progress.review.fixture'), 2);
  for (const remaining of [1, 0]) {
    app.evaluate('current.problem.reviewClean=true; current.tries=0; record(true)');
    assert.equal(app.evaluate('progress.review.fixture || 0'), remaining);
  }
});

test('renaming a generator implementation retains its saved review ID and clears the legacy queue', () => {
  const app=loadDm();
  app.random(Array(500).fill(.1));
  app.evaluate(`Object.defineProperty(genEncounterBuild,'name',{value:'buildEncounterLesson'});
    current.module=MODULES.find(m=>m.id==='encounter');
    progress.review={genEncounterBuild:2};progress.reviewPrompts={genEncounterBuild:'Legacy missed budget?'};
  `);
  assert.equal(app.evaluate('generatorId(genEncounterBuild)'),'genEncounterBuild');
  assert.equal(app.evaluate('GEN_INDEX.genEncounterBuild.gen.name'),'buildEncounterLesson');
  for(const remaining of [1,0]) {
    app.evaluate('nextProblem()');
    assert.equal(app.evaluate('current.problem.gen'),'genEncounterBuild');
    assert.equal(app.evaluate('current.problem.review'),true,'the legacy saved key must still be scheduled for review');
    finishExample(app);
    assert.equal(app.evaluate('progress.review.genEncounterBuild || 0'),remaining);
  }
  const saved=JSON.parse(app.evaluate("localStorage.getItem('pda-progress')"));
  assert.deepEqual(saved.review,{});
  assert.deepEqual(saved.reviewPrompts,{});
  assert.equal(app.evaluate('GEN_INDEX.buildEncounterLesson'),undefined);
});
