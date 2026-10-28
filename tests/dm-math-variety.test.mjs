import test from 'node:test';
import assert from 'node:assert/strict';
import {loadDm} from './dm-harness.mjs';

// Expected 2024 encounter budgets per hero, independent of the generator's table.
const budgets = {1:[50,75,100],2:[100,150,200],3:[150,225,400],4:[250,375,500],
  5:[500,750,1100],6:[600,1000,1400],7:[750,1300,1700],8:[1000,1700,2100]};
const ranks = [[0,50],[100,100],[250,200],[500,450],[850,700],[1300,1800],[2000,99999]];
const labels = ['Easier than Low','Low','Moderate','High'];
const dice = text => {const [,n,sides,bonus] = text.match(/^(\d+)d(\d+)([+-]\d+)?$/);return {n:+n,sides:+sides,bonus:+(bonus||0)};};
const average = text => {const roll=dice(text);return roll.n*(roll.sides+1)/2+roll.bonus;};
const tally = (counts, value) => {counts[value]=(counts[value]||0)+1;};

test('encounter ratings are correct, balanced and nonrepeating across every party, level and rank',()=>{
  const app=loadDm({seed:683297});
  const monsters=app.evaluate('MONSTERS.map(mon=>({name:mon.n,plural:mon.pl,xp:mon.xp}))');
  let largeGroups=0;
  for(let level=1;level<=8;level++)for(let party=3;party<=6;party++)for(const [xp,cap]of ranks){
    app.evaluate(`settings.level=${level};settings.party=Array.from({length:${party}},(_,i)=>'Hero '+i);progress.xp=${xp};`);
    const samples=app.evaluate('Array.from({length:72},()=>genEncounterBuild())'), counts={},budgetCounts={};
    let previous,previousBudget;
    for(const problem of samples){
      const [,amount,name,shownParty,shownLevel]=problem.flavor.match(/: (\d+) (.+) against (\d+) level-(\d+) heroes/);
      const mon=monsters.find(m=>m.name===name||m.plural===name);
      assert.ok(mon,problem.flavor);assert.ok(mon.xp<=cap,problem.flavor);
      assert.equal(+shownParty,party);assert.equal(+shownLevel,level);
      const count=+amount,total=count*mon.xp,thresholds=budgets[level].map(n=>n*party);
      assert.ok(Number.isInteger(count)&&count>=1);if(count>9)largeGroups++;
      assert.equal(problem.steps[1].answer,total);
      const expected=total>=thresholds[2]?'High':total>=thresholds[1]?'Moderate':total>=thresholds[0]?'Low':'Easier than Low';
      assert.equal(problem.steps[2].answer,expected,problem.flavor);
      assert.notEqual(expected,previous,'do not repeat the rating on adjacent practice questions');
      previous=expected;tally(counts,expected);
      const asked=problem.steps[0].q.match(/A (Low|Moderate|High) difficulty/)[1];
      assert.equal(problem.steps[0].answer,thresholds[['Low','Moderate','High'].indexOf(asked)]);
      assert.notEqual(asked,previousBudget,'the first budget calculation must not repeat consecutively');
      previousBudget=asked;tally(budgetCounts,asked);
    }
    for(const label of labels)assert.equal(counts[label],18,`level ${level}, party ${party}, XP ${xp}: ${label}`);
    for(const difficulty of ['Low','Moderate','High'])assert.equal(budgetCounts[difficulty],24,`level ${level}, party ${party}, XP ${xp}: ${difficulty} budget`);
  }
  assert.ok(largeGroups>0,'large real-party budgets must remain reachable using low-rank monsters');
});

test('repeated random draws cannot repeat the same budget calculation four times',()=>{
  const app=loadDm();
  app.random(Array(2000).fill(.999999));
  const samples=app.evaluate('Array.from({length:30},()=>genEncounterBuild())');
  const expected={Low:600,Moderate:900,High:1600};
  let previous;
  for(let i=0;i<samples.length;i++){
    const step=samples[i].steps[0],difficulty=step.q.match(/A (Low|Moderate|High) difficulty/)[1];
    assert.equal(step.answer,expected[difficulty]);
    assert.notEqual(step.q,previous,'a different monster story must also offer a different budget calculation');
    previous=step.q;
    if(i%3===2)assert.deepEqual(Array.from(samples.slice(i-2,i+1),p=>p.steps[0].answer).sort((a,b)=>a-b),[600,900,1600]);
  }
});

test('the real next-question and review flow varies the first budget step, not just the final rating',()=>{
  const app=loadDm();
  app.random(Array(5000).fill(.1));
  app.evaluate("current.module=MODULES.find(m=>m.id==='encounter'); progress.review={genEncounterBuild:2}; nextProblem();");
  const questions=[],answers=new Set();
  let reviewed=false;
  for(let index=0;index<15;index++){
    const problem=app.evaluate('current.problem');
    if(problem.gen==='genEncounterBuild'){
      const shown=app.element('steps').querySelector('.q').textContent;
      assert.equal(shown,problem.steps[0].q);
      assert.notEqual(shown,questions.at(-1));
      questions.push(shown);answers.add(problem.steps[0].answer);
      reviewed ||= problem.review;
    }
    for(let step=0;step<problem.steps.length;step++){
      const answer=problem.steps[step].answer;
      if(problem.steps[step].choices)app.element('steps').querySelectorAll('.choices button').find(b=>b.textContent===answer).click();
      else app.element('answer-input').value=String(answer);
      app.element('check-btn').click();
      assert.ok(app.element('feedback').classList.contains('good'),app.element('feedback').textContent);
      app.element('next-btn').click();
    }
  }
  assert.ok(reviewed,'the repeated calculation must also be prevented when review selects the exercise');
  assert.ok(questions.length>=6);
  assert.deepEqual([...answers].sort((a,b)=>a-b),[600,900,1600]);
});

test('encounter fit always practices division with all difficulties and both remainder cases',()=>{
  const app=loadDm({seed:693182});
  const monsters=app.evaluate('MONSTERS.map(mon=>({name:mon.n,plural:mon.pl,xp:mon.xp}))');
  for(let level=1;level<=8;level++)for(let party=3;party<=6;party++)for(const [xp,cap]of ranks){
    app.evaluate(`settings.level=${level};settings.party=Array.from({length:${party}},(_,i)=>'Hero '+i);progress.xp=${xp};`);
    const samples=app.evaluate('Array.from({length:60},()=>genEncounterFit())'), counts={},remainders={};
    for(const problem of samples){
      assert.equal(problem.steps.length,2,'fit must never fall back to encounter classification');
      const [,difficulty,shownParty,shownLevel,budget,advanceCount,advanceName,spent,available,mainName,cost]=problem.flavor.match(/a (Low|Moderate|High) fight for your (\d+) level-(\d+) heroes\. The full budget is (\d+) XP\. You already added (\d+) (.+), costing (\d+) XP, so (\d+) XP remains\. Each (.+) costs (\d+) XP\./);
      assert.equal(+shownParty,party);assert.equal(+shownLevel,level);
      assert.equal(+budget,budgets[level][['Low','Moderate','High'].indexOf(difficulty)]*party);
      const advance=monsters.find(m=>m.name===advanceName||m.plural===advanceName),main=monsters.find(m=>m.name===mainName);
      assert.ok(advance&&main,problem.flavor);assert.ok(advance.xp<=cap&&main.xp<=cap,problem.flavor);
      assert.equal(+spent,+advanceCount*advance.xp);assert.equal(+cost,main.xp);assert.equal(+available,+budget-Number(spent));
      const count=problem.steps[0].answer,left=problem.steps[1].answer;
      assert.equal(count,Math.floor(+available/Number(cost)));assert.equal(left,+available-count*Number(cost));
      assert.ok(count>=1&&left>=0&&left<Number(cost));assert.equal(+spent+count*Number(cost)+left,+budget);
      assert.match(problem.steps[0].q,/remaining/);tally(counts,difficulty);tally(remainders,left===0?'zero':'positive');
    }
    for(const difficulty of ['Low','Moderate','High'])assert.equal(counts[difficulty],20,`level ${level}, party ${party}, XP ${xp}: ${difficulty}`);
    assert.equal(remainders.zero,30);assert.equal(remainders.positive,30);
  }
});

test('actual party-size limits still produce every encounter rating',()=>{
  const app=loadDm({seed:8921});
  for(const [names,expected]of [[0,4],[1,3],[2,3],[7,6],[12,6]]){
    app.evaluate(`settings.level=3;settings.party=Array.from({length:${names}},(_,i)=>'Hero '+i);progress.xp=0;`);
    const problems=app.evaluate('Array.from({length:8},()=>genEncounterBuild())');
    assert.equal(new Set(problems.map(p=>p.steps[2].answer)).size,4);
    for(const p of problems)assert.match(p.flavor,new RegExp('against '+expected+' level-3 heroes'));
  }
});

test('dice comparisons balance first, second and tied averages and shuffle the correct position',()=>{
  const app=loadDm({seed:93012}),counts={},positions={},ties=new Set();
  let previous;
  for(const problem of app.evaluate('Array.from({length:12000},()=>genDiceCompare())')){
    const [a,b]=problem.flavor.match(/\d+d\d+(?:[+-]\d+)?/g),step=problem.steps[0];
    assert.notEqual(a,b);assert.equal(new Set(step.choices).size,3);
    const outcome=average(a)>average(b)?'first':average(a)<average(b)?'second':'same';
    const expected=outcome==='first'?a:outcome==='second'?b:'Same on average';
    assert.equal(step.answer,expected);assert.ok(step.choices.includes(expected));
    assert.notEqual(outcome,previous);previous=outcome;
    tally(counts,outcome);tally(positions,step.choices.indexOf(expected));
    if(outcome==='same')ties.add([a,b].sort().join('|'));
  }
  assert.deepEqual(counts,{first:4000,second:4000,same:4000});
  for(const position of [0,1,2])assert.ok(positions[position]>3000&&positions[position]<5000,JSON.stringify(positions));
  assert.ok(ties.size>20,'equal-average cases must have more than one repeated pair');
});

test('critical-hit examples cover single- and multiple-die weapons with one damage bonus',()=>{
  const app=loadDm({seed:4219}),counts={};
  for(const problem of app.evaluate('Array.from({length:200},()=>genCrit())')){
    const attack=dice(problem.flavor.match(/\((\d+d\d+(?:[+-]\d+)?)\)/)[1]);
    const rolls=problem.steps[1].q.match(/show ([\d, ]+)\./)[1].split(',').map(Number);
    assert.equal(problem.steps[0].answer,2*attack.n);assert.equal(rolls.length,2*attack.n);
    assert.ok(rolls.every(n=>n>=1&&n<=attack.sides));
    assert.equal(problem.steps[1].answer,rolls.reduce((a,b)=>a+b,0)+attack.bonus);
    tally(counts,problem.steps[0].answer);
  }
  assert.equal(counts[2],100);assert.equal(counts[4],100);
});

test('starting HP tracking varies unlocked monsters and keeps the first hit nonlethal',()=>{
  const app=loadDm({seed:73195}),seen=new Set(),outcomes=new Set();
  const allowed=app.evaluate('MON().map(mon=>({name:mon.n,hp:mon.hp}))');
  for(const problem of app.evaluate('Array.from({length:1000},()=>genHpTrack())')){
    const [,name,hp,first,second]=problem.flavor.match(/^The (.+) has (\d+) HP\..*for (\d+), then again for (\d+)\./);
    const mon=allowed.find(m=>m.name===name);assert.ok(mon);assert.equal(mon.hp,+hp);seen.add(name);
    assert.ok(+first>0&&+first<Number(hp),'the monster must still be alive for the second hit');assert.ok(+second>0);
    const remaining=Number(hp)-Number(first)-Number(second);
    assert.equal(problem.steps[0].answer,Math.max(0,remaining));outcomes.add(remaining<=0?'down':'survives');
  }
  assert.equal(seen.size,allowed.length);assert.equal(outcomes.size,2);
});
