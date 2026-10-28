import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDm } from './dm-harness.mjs';

// Rule expectations come from the 2024 Free Rules / SRD 5.2.1:
// https://www.dndbeyond.com/sources/dnd/free-rules/playing-the-game
// https://www.dndbeyond.com/sources/dnd/free-rules/rules-glossary
// https://www.dndbeyond.com/srd

function gradeChoice(app, problem, answer, moduleId, generator) {
  app.evaluate(`
    current.module = MODULES.find(m => m.id === ${JSON.stringify(moduleId)});
    current.problem = Object.assign(${JSON.stringify(problem)}, {from:${JSON.stringify(moduleId)}, gen:${JSON.stringify(generator)}});
    current.step = 0; current.tries = 0; current.choice = null;
    show('module'); renderSteps();
  `);
  const before = app.evaluate(`(progress.modules[${JSON.stringify(moduleId)}] || {}).correct || 0`);
  const choice = app.element('steps').querySelectorAll('.choices button').find(b => b.textContent === answer);
  assert.ok(choice, 'answer must be offered by the rendered question');
  choice.click();
  app.element('check-btn').click();
  assert.ok(app.element('feedback').classList.contains('good'), app.element('feedback').textContent);
  assert.equal(app.evaluate(`progress.modules[${JSON.stringify(moduleId)}].correct`), before + 1);
}

test('a natural 20 does not automatically pass an ordinary saving throw', () => {
  const app = loadDm();
  const cases = app.evaluate('Array.from({length:500}, () => genAdvRules())');
  const save = cases.find(p => /natural 20.*saving throw/i.test(p.flavor));
  assert.ok(save, 'exercise must teach a natural-20 ordinary saving throw');
  assert.match(save.steps[0].answer, /fail/i);
  assert.doesNotMatch(save.steps[0].answer, /automatic success/i);
  gradeChoice(app, save, save.steps[0].answer, 'd20', 'genAdvRules');
});

test('a natural 20 on a death save still restores 1 HP', () => {
  const app = loadDm();
  // Hero selection, existing successes, failures, and a natural 20.
  app.random([0, 0, 0, .999999]);
  const problem = app.evaluate('genDeathSave()');
  assert.match(problem.flavor, /roll.*20/);
  assert.equal(problem.steps[0].answer, 'Back up with 1 HP');
  gradeChoice(app, problem, 'Back up with 1 HP', 'survive', 'genDeathSave');
});

test('Finesse accepts equal modifiers and chooses the higher unequal one', () => {
  const app = loadDm();
  const graded = new Set();
  for (const problem of app.evaluate('Array.from({length:1000}, () => genFinesse())')) {
    const [, strength, dexterity] = problem.flavor.match(/Strength (\d+), Dexterity (\d+)/).map(Number);
    const step = problem.steps[0], str = Math.floor((strength - 10) / 2), dex = Math.floor((dexterity - 10) / 2);
    if (str === dex) assert.match(step.answer, /either/i);
    else assert.equal(step.answer, str > dex ? 'Strength' : 'Dexterity', `Strength ${strength}, Dexterity ${dexterity}`);
    assert.ok(step.choices.includes(step.answer));
    if (!graded.has(step.answer)) {
      gradeChoice(app, {flavor:'Finesse fixture', steps:[step]}, step.answer, 'armory', 'genFinesse');
      graded.add(step.answer);
    }
  }
  assert.equal(graded.size, 3);
});

test('standing Long Jump rounds down for odd Strength scores', () => {
  const app = loadDm();
  for (let strength = 8; strength <= 20; strength++) {
    app.random([(strength - 8 + .1) / 13, 0]);
    const problem = app.evaluate('genJump()');
    assert.equal(problem.steps[0].answer, strength);
    assert.equal(problem.steps[1].answer, Math.floor(strength / 2));
  }
});

test('difficult-terrain exercises never demand unaffordable or negative movement', () => {
  const app = loadDm();
  for (const problem of app.evaluate('Array.from({length:1000}, () => genDifficultTerrain())')) {
    const speed = Number(problem.flavor.match(/Speed (\d+)/)[1]);
    const cost = problem.steps[0].answer, remaining = problem.steps[1].answer;
    assert.ok(cost <= speed, problem.flavor);
    assert.ok(remaining >= 0, problem.flavor);
    assert.equal(cost + remaining, speed);
  }
});

test('standing from Prone rounds its movement cost down, and preserves the remainder', () => {
  const app = loadDm();
  for (const speed of [25, 30, 35, 40]) {
    app.random([0, ([25, 30, 35, 40].indexOf(speed) + .1) / 4]);
    const problem = app.evaluate('genProneStand()');
    assert.equal(problem.steps[0].answer, Math.floor(speed / 2));
    assert.equal(problem.steps[1].answer, speed - Math.floor(speed / 2));
  }
});

test('HP tracking shows the actual subtraction before clamping overkill to zero', () => {
  const app = loadDm();
  app.evaluate('progress.xp = 200'); // Unlock low-HP monsters eligible for this exercise.
  const problems = app.evaluate('Array.from({length:1000}, () => genHpTrack())');
  const overkill = problems.filter(p => {
    const values = p.flavor.match(/has (\d+) HP.*for (\d+), then again for (\d+)/);
    return values && Number(values[1]) - Number(values[2]) - Number(values[3]) < 0;
  });
  assert.ok(overkill.length, 'fixture must exercise overkill');
  for (const problem of overkill) {
    const [, hp, first, second] = problem.flavor.match(/has (\d+) HP.*for (\d+), then again for (\d+)/).map(Number);
    assert.equal(problem.steps[0].answer, 0);
    assert.ok(problem.steps[0].solution.includes(String(hp - first - second)), problem.steps[0].solution);
    assert.match(problem.steps[0].solution, /0/);
  }
});

test('dice comparisons offer unique choices and a mathematically correct answer', () => {
  const app = loadDm();
  for (const problem of app.evaluate('Array.from({length:1000}, () => genDiceCompare())')) {
    const step = problem.steps[0];
    assert.equal(new Set(step.choices).size, step.choices.length, problem.flavor);
    const [a, b] = problem.flavor.match(/\d+d\d+(?:[+-]\d+)?/g);
    assert.notEqual(a, b, 'compare different dice expressions');
    const average = text => { const [, n, sides, bonus] = text.match(/(\d+)d(\d+)([+-]\d+)?/); return Number(n) * (Number(sides) + 1) / 2 + Number(bonus || 0); };
    const expected = average(a) > average(b) ? a : average(a) < average(b) ? b : 'Same on average';
    assert.equal(step.answer, expected, problem.flavor);
  }
});

test('all lesson generators return usable questions at starting and advanced ranks', () => {
  const app = loadDm();
  for (const [level, xp] of [[1, 0], [8, 2000]]) {
    app.evaluate(`settings.level = ${level}; progress.xp = ${xp};`);
    const issues = app.evaluate(`(() => {
      const issues = [];
      for (const [name, entry] of Object.entries(GEN_INDEX)) {
        for (let sample = 0; sample < 100; sample++) {
          const problem = entry.gen();
          const report = reason => issues.push({name, sample, reason});
          if (!problem.flavor || typeof problem.flavor !== 'string') report('missing story text');
          if (!Array.isArray(problem.steps) || !problem.steps.length) { report('no steps'); continue; }
          for (const step of problem.steps) {
            if (!step.q || typeof step.q !== 'string') report('missing question');
            if (step.choices) {
              if (new Set(step.choices).size !== step.choices.length) report('duplicate choices');
              if (!step.choices.includes(step.answer)) report('answer is not an offered choice');
            } else if (typeof step.answer !== 'number' || !Number.isFinite(step.answer)) {
              report('numeric answer is not finite');
            }
            for (const text of [problem.flavor, step.q, step.hint, step.solution]) {
              if (typeof text !== 'string' || /\\bundefined\\b|\\bNaN\\b|\\[object Object\\]/.test(text)) report('invalid generated text');
            }
          }
        }
      }
      return issues;
    })()`);
    assert.equal(issues.length, 0, `level ${level}, XP ${xp}: ${JSON.stringify(issues.slice(0, 5))}`);
  }
});

test('opening the boss bookmark shows the boss picker without a lesson-generator error', () => {
  const app = loadDm({ boot: true, hash: '#boss' });
  assert.equal(app.element('view-boss').hidden, false);
  assert.equal(app.element('view-module').hidden, true);
  assert.ok(app.element('boss-grid').children.length);
  assert.equal(app.evaluate('boss.active'), false);
});

test('leaving a boss through navigation restores lesson grading without ghost attacks', () => {
  const app = loadDm({ boot: true });
  app.element('nav-boss').click();
  app.element('boss-kobold').click();
  assert.equal(app.evaluate('boss.active'), true);
  const hp = app.evaluate('boss.hp');
  app.element('nav-home').click();
  assert.equal(app.evaluate('boss.active'), false);
  app.element('card-dice').click();
  assert.equal(app.element('view-module').hidden, false);
  assert.equal(app.element('quest').parentElement, app.element('view-module').querySelector('.panel'));
  app.evaluate(`current.problem = { from:'dice', gen:'genDiceMaxMin', steps:[{q:'Fixture',answer:4,hint:'Add.',solution:'4.'}] }; current.step = 0; current.tries = 0; renderSteps();`);
  app.element('answer-input').value = '4';
  app.element('check-btn').click();
  assert.equal(app.evaluate('boss.hp'), hp);
  assert.equal(app.element('quest').hidden, false);
  assert.ok(app.element('next-btn'));
});
