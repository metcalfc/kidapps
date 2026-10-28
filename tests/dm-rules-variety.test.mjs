import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDm } from './dm-harness.mjs';

// D&D 2024 Finesse and Thrown rules: a thrown melee weapon keeps its melee
// ability, including the Strength/Dexterity choice granted by Finesse.
// https://www.dndbeyond.com/sources/dnd/br-2024/equipment
const either = 'Either: the modifiers are equal';
const modifier = score => Math.floor((score - 10) / 2);
const outcomes = ['Strength', 'Dexterity', either];
const ranks = [0, 100, 250, 500, 850, 1300, 2000];
const profiles = Array.from({length:8}, (_, i) => i + 1).flatMap(level => ranks.map(xp => ({level, xp})));
function configure(app, profile) {
  app.evaluate(`settings.level = ${profile.level}; progress.xp = ${profile.xp}; if(typeof practiceBags !== 'undefined') practiceBags.clear();`);
}
function abilities(problem) {
  const match = problem.flavor.match(/Strength (\d+), Dexterity (\d+)/);
  assert.ok(match, problem.flavor);
  const strength = Number(match[1]), dexterity = Number(match[2]);
  assert.ok(strength >= 8 && strength <= 20);
  assert.ok(dexterity >= 8 && dexterity <= 20);
  return {strength, dexterity, str:modifier(strength), dex:modifier(dexterity)};
}
function finesseAnswer(str, dex) { return str === dex ? either : str > dex ? 'Strength' : 'Dexterity'; }
function checkChoices(step, positions) {
  assert.equal(new Set(step.choices).size, step.choices.length);
  assert.ok(step.choices.includes(step.answer));
  positions.add(step.choices.indexOf(step.answer));
}

test('Finesse covers Strength, Dexterity and equal modifiers with correct damage and shuffled answers at every level and rank', () => {
  const app = loadDm({seed:524317});
  let unequalScoreTie = false;
  const scorePairs = new Set();
  for (const profile of profiles) {
    configure(app, profile);
    const problems = app.evaluate('Array.from({length:300}, () => genFinesse())');
    const counts = new Map(), positions = new Set();
    let previous;
    for (const problem of problems) {
      const {strength, dexterity, str, dex} = abilities(problem), step = problem.steps[0];
      scorePairs.add(`${strength}/${dexterity}`);
      unequalScoreTie ||= strength !== dexterity && str === dex;
      assert.equal(step.answer, finesseAnswer(str, dex), problem.flavor);
      assert.notEqual(step.answer, previous, 'the next practice outcome should differ');
      previous = step.answer;
      counts.set(step.answer, (counts.get(step.answer) || 0) + 1);
      checkChoices(step, positions);
      const roll = Number(problem.steps[1].q.match(/shows (\d+)/)[1]);
      assert.equal(problem.steps[1].answer, roll + Math.max(str, dex));
    }
    for (const outcome of outcomes) assert.ok(counts.get(outcome) >= 90, `${JSON.stringify(profile)}: ${outcome}`);
    assert.equal(positions.size, 3, JSON.stringify(profile));
  }
  assert.equal(unequalScoreTie, true, 'equal modifiers must include unequal ability scores');
  assert.equal(scorePairs.size, 169, 'all pairs in the comparable 8–20 ranges are reachable');
});

test('action practice covers all twelve actions, including the three previously unreachable answers', () => {
  const app = loadDm({seed:73429});
  const expected = ['Attack','Dash','Disengage','Dodge','Help','Hide','Influence','Magic','Ready','Search','Study','Utilize'];
  for (const profile of profiles) {
    configure(app, profile);
    const problems = app.evaluate('Array.from({length:60}, () => genActions())');
    const answers = new Set(), positions = new Set();
    let previous;
    for (const problem of problems) {
      const step = problem.steps[0];
      answers.add(step.answer);
      assert.notEqual(step.answer, previous);
      previous = step.answer;
      checkChoices(step, positions);
      if (/strike the Goblin with a sword/.test(problem.flavor)) assert.equal(step.answer, 'Attack');
      if (/casting time of one Action/.test(problem.flavor)) assert.equal(step.answer, 'Magic');
      if (/nonmagical lever now/.test(problem.flavor)) assert.equal(step.answer, 'Utilize');
    }
    assert.deepEqual([...answers].sort(), [...expected].sort());
    assert.equal(positions.size, 4);
  }
});

test('slot practice includes untouched and exhausted level-1 slots and counts only spells explicitly cast with slots', () => {
  const app = loadDm({seed:827111});
  for (const profile of profiles) {
    configure(app, profile);
    const problems = app.evaluate('Array.from({length:500}, () => genSlots())');
    const remainingByLevel = new Map();
    for (const problem of problems) {
      const level = Number(problem.flavor.match(/is level (\d+)/)[1]);
      const total = Number(problem.flavor.match(/with (\d+) level-1 spell slots/)[1]);
      assert.equal(total, level === 1 ? 2 : level === 2 ? 3 : 4);
      const cast = problem.flavor.match(/Magic Missile|Shield|Thunderwave|Sleep|Burning Hands|Detect Magic/g) || [];
      assert.equal(problem.steps[0].answer, total - cast.length, problem.flavor);
      assert.ok(problem.steps[0].answer >= 0 && problem.steps[0].answer <= total);
      if (!cast.length) assert.match(problem.flavor, /have not used any level-1 slots/);
      else assert.match(problem.flavor, /using a level-1 slot for each spell/);
      if (!remainingByLevel.has(level)) remainingByLevel.set(level, new Set());
      remainingByLevel.get(level).add(problem.steps[0].answer);
    }
    for (let level=1; level<=5; level++) {
      const remaining = remainingByLevel.get(level), total = level === 1 ? 2 : level === 2 ? 3 : 4;
      assert.ok(remaining?.has(0), `${JSON.stringify(profile)}: level ${level} exhausted`);
      assert.ok(remaining.has(total), `${JSON.stringify(profile)}: level ${level} untouched`);
    }
  }
});

test('ranged practice distinguishes bows, thrown melee weapons and thrown Finesse weapons without changing their rules', () => {
  const app = loadDm({seed:173227});
  const families = {
    dagger:'finesse', spear:'thrown', handaxe:'thrown', javelin:'thrown',
    shortbow:'ammunition', longbow:'ammunition', 'light crossbow':'ammunition', 'heavy crossbow':'ammunition', 'hand crossbow':'ammunition',
  };
  let unequalScoreTie = false, strengthWeaponDespiteHigherDex = false, bowDespiteHigherStrength = false;
  for (const profile of profiles) {
    configure(app, profile);
    const problems = app.evaluate('Array.from({length:450}, () => genRanged())');
    const answers = new Set(), weapons = new Set(), positions = new Set();
    for (const problem of problems) {
      const {strength, dexterity, str, dex} = abilities(problem);
      const name = Object.keys(families).find(weapon => problem.flavor.includes(` a ${weapon} (`));
      assert.ok(name, problem.flavor);
      weapons.add(name);
      const kind = families[name], expected = kind === 'ammunition' ? 'Dexterity' : kind === 'thrown' ? 'Strength' : finesseAnswer(str, dex);
      assert.equal(problem.steps[0].answer, expected, problem.flavor);
      answers.add(expected);
      checkChoices(problem.steps[0], positions);
      const abilityModifier = kind === 'ammunition' ? dex : kind === 'thrown' ? str : Math.max(str, dex);
      assert.equal(problem.steps[1].answer, abilityModifier + 1 + Math.ceil(profile.level / 4));
      if (kind === 'finesse') unequalScoreTie ||= strength !== dexterity && str === dex;
      if (kind === 'thrown') strengthWeaponDespiteHigherDex ||= dex > str;
      if (kind === 'ammunition') bowDespiteHigherStrength ||= str > dex;
    }
    assert.deepEqual([...answers].sort(), [...outcomes].sort());
    assert.deepEqual([...weapons].sort(), Object.keys(families).sort());
    assert.equal(positions.size, 3);
  }
  assert.equal(unequalScoreTie, true);
  assert.equal(strengthWeaponDespiteHigherDex, true, 'throwing a handaxe or spear cannot switch to Dexterity');
  assert.equal(bowDespiteHigherStrength, true, 'a bow cannot switch to Strength');
});
