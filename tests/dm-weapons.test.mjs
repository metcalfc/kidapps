import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDm } from './dm-harness.mjs';

const read = (app, expression) => JSON.parse(app.evaluate(`JSON.stringify(${expression})`));

test('combat presets preserve ordered dice, modifiers, melee weights and attack wording', () => {
  const app = loadDm();
  const expected = [
    ['longsword','1d8+3','You swing your longsword'],
    ['greataxe','1d12+3','You swing your greataxe'],
    ['shortbow','1d6+2','You shoot your shortbow'],
    ['dagger','1d4+2','You stab with your dagger'],
    ['fire bolt','1d10','You cast fire bolt'],
    ['rapier','1d8+3','You thrust your rapier'],
    ['warhammer','1d8+2','You swing your warhammer'],
    ['quarterstaff','1d6+1','You swing your quarterstaff'],
    ['greatsword','2d6+3','You swing your greatsword'],
  ];
  assert.deepEqual(read(app,'HERO_WEAPONS.map(([name,dice]) => [name,dice,heroAttack(name)])'),expected);
  assert.deepEqual(read(app,'MELEE_WEAPONS'),expected.filter(([name])=>name!=='shortbow'&&name!=='fire bolt').map(([name,dice])=>[name,dice]));
  assert.equal(app.evaluate('HERO_ATTACKS.filter(preset => preset.spell).length'),1);
  assert.equal(app.evaluate("heroAttackRule(HERO_ATTACKS.find(preset => preset.name==='fire bolt')).category"),'spell');
});

test('weapon lesson pools follow structured rules when display labels and catalog positions change', () => {
  const app = loadDm({seed:531721});
  app.evaluate(`WEAPONS.reverse();
    for(const key of Object.keys(WEAPON_PROPERTY_NAMES)) WEAPON_PROPERTY_NAMES[key]='Translated '+key;`);
  const attackNames = new Set();
  const expectedAttackNames = ['dagger','shortsword','scimitar','rapier','longsword','warhammer','quarterstaff','spear','greatsword','greataxe','maul','glaive','halberd'];
  for(const problem of app.evaluate('Array.from({length:500},()=>genAttackBonus())')) {
    const name = problem.flavor.match(/proficient with the (.+)\./)[1];
    assert.ok(expectedAttackNames.includes(name),problem.flavor); attackNames.add(name);
  }
  assert.deepEqual([...attackNames].sort(),expectedAttackNames.sort());
  const finesse = new Set(), versatile = new Set(), ranged = new Set();
  for(const problem of app.evaluate('Array.from({length:200},()=>genFinesse())')) finesse.add(problem.flavor.match(/attacks with a (.+) \(/)[1]);
  for(const problem of app.evaluate('Array.from({length:200},()=>genVersatile())')) {
    const [,name,one,two] = problem.flavor.match(/has a (.+): (\d+d\d+) in one hand, or (\d+d\d+) in two hands/);
    versatile.add(name);
    assert.equal(two,name==='longsword'||name==='warhammer'?'1d10':'1d8');
    assert.equal(one,name==='longsword'||name==='warhammer'?'1d8':'1d6');
  }
  for(const problem of app.evaluate('Array.from({length:100},()=>genRanged())')) {
    ranged.add(problem.flavor.match(/(?:shoots|throws) a (.+?) \(/)[1]);
    assert.match(problem.flavor,/Translated/,'display labels can change without changing the weapon pool');
  }
  assert.deepEqual([...finesse].sort(),['dagger','rapier','scimitar','shortsword']);
  assert.deepEqual([...versatile].sort(),['longsword','quarterstaff','spear','warhammer']);
  assert.deepEqual([...ranged].sort(),['dagger','hand crossbow','handaxe','heavy crossbow','javelin','light crossbow','longbow','shortbow','spear']);
});
