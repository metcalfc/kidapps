import test from 'node:test';
import assert from 'node:assert/strict';
import { loadChain } from './chain-harness.mjs';

const read = (app, expression) => JSON.parse(app.evaluate(`JSON.stringify(${expression})`));
async function play(app) {
  app.evaluate('S.settings.sound = false; readyResolve();');
  app.element('playBtn').click();
  await app.settle();
}
function question(app, a, b) {
  app.evaluate(`cur = {a:${a},b:${b}}; typed = ''; locked = false; t0 = performance.now(); $('qa').textContent = cur.a; $('qb').textContent = cur.b; $('revealNote').textContent = ''; renderAns('');`);
}
function keys(app, value) {
  for (const digit of String(value)) {
    const key = app.element('pad').querySelectorAll('button').find(button => button.dataset.k === digit);
    app.element('pad').dispatchEvent({type:'pointerdown',target:key});
  }
}
function refill(app) {
  app.evaluate('openParent();');
  app.element('resetTries').click(); app.element('resetTries').click();
  app.element('parentClose').click();
}

test('all 144 multiplication facts grade correctly through the production keypad', async () => {
  const app = loadChain(); app.evaluate('S.settings.tries = 300;'); await play(app);
  for(let a = 1; a <= 12; a++) for(let b = 1; b <= 12; b++) {
    question(app,a,b); keys(app,a*b);
    assert.equal(app.element('ans').classList.contains('right'),true,`${a} × ${b}`);
    app.advance(170);
  }
  assert.equal(app.evaluate('today().tries'),144);
  assert.equal(app.evaluate('today().correct'),144);
  assert.equal(app.evaluate('chain'),144);
});

test('Pause and Resume preserve the question, typed digits, chain, retry queue, and active answer time', async () => {
  const app = loadChain(); await play(app); question(app,7,8);
  app.evaluate('chain=9; retry=[{a:6,b:7,due:99}]; renderChain(false);');
  app.advance(1200); keys(app,'5');
  app.element('homeBtn').click();
  assert.equal(app.element('playBtn').textContent,'Resume');
  app.advance(60000);
  await play(app);
  assert.deepEqual(read(app,'cur'),{a:7,b:8}); assert.equal(app.evaluate('typed'),'5');
  assert.equal(app.evaluate('chain'),9); assert.deepEqual(read(app,'retry'),[{a:6,b:7,due:99}]);
  app.advance(700); keys(app,'6');
  assert.equal(app.evaluate('chain'),10);
  assert.equal(app.evaluate('today().lightning'),1);
  assert.equal(app.evaluate('S.bank'),56); // (16 + 8) × 1.5, plus the 20-second chain jackpot.
  assert.equal(app.evaluate("S.facts['7x8'].ms"),1900);
});

test('wrong-answer feedback freezes while paused and resumes with the original correct equation', async () => {
  const app = loadChain(); await play(app); question(app,7,8); keys(app,55);
  const oldReveal = [...app.timers.values()].find(timer => timer.due === app.now()+380).fn;
  const count = app.evaluate('qCount');
  app.advance(100); app.element('homeBtn').click(); app.advance(60000);
  assert.equal(app.element('revealNote').textContent,''); assert.equal(app.evaluate('qCount'),count);
  await play(app);
  oldReveal(); // A callback already queued by the browser must also be harmless after rearming.
  assert.equal(app.element('revealNote').textContent,'');
  app.advance(279); assert.equal(app.element('revealNote').textContent,'');
  app.advance(1); assert.equal(app.element('revealNote').textContent,'7 × 8 = 56');
  assert.equal(app.evaluate('typed'),'56');
  app.advance(1319); assert.equal(app.evaluate('qCount'),count);
  app.advance(1); assert.equal(app.evaluate('qCount'),count+1);
  assert.equal(app.element('revealNote').textContent,'');
});

test('a correct answer waiting for the next question also preserves its remaining pause time', async () => {
  const app=loadChain(); await play(app); question(app,6,9); keys(app,54);
  app.advance(50); app.element('homeBtn').click(); const count=app.evaluate('qCount');
  app.advance(60000); assert.equal(app.evaluate('qCount'),count);
  await play(app); app.advance(119); assert.equal(app.evaluate('qCount'),count);
  app.advance(1); assert.equal(app.evaluate('qCount'),count+1);
});

test('refilling tries keeps actual attempts, accuracy and earned time, and cannot stack unused refills', async () => {
  const app=loadChain();
  app.evaluate('S.settings.tries=10; today().tries=10; today().correct=8; today().earned=400; S.bank=400; renderHome();');
  assert.equal(app.element('playBtn').disabled,true);
  refill(app);
  assert.deepEqual(read(app,'({tries:today().tries,correct:today().correct,earned:today().earned,bonus:today().bonusTries,left:triesLeft()})'),{tries:10,correct:8,earned:400,bonus:10,left:10});
  refill(app); assert.equal(app.evaluate('triesLeft()'),10);
  assert.equal(app.element('hRight').textContent,'8 right of 10');
  await play(app);
  for(let i=0;i<10;i++) { question(app,2,3); keys(app,6); app.advance(170); }
  app.advance(700);
  assert.equal(app.element('done').hidden,false);
  assert.equal(app.element('dTitle').textContent,'You have used all 20 tries today');
  assert.equal(app.element('dRight').textContent,'18 / 20');
  assert.equal(app.evaluate('triesLeft()'),0);
  assert.ok(app.evaluate('today().earned')>400);
});

test('completion copy follows a custom ten-try limit', async () => {
  const app=loadChain(); app.evaluate('S.settings.tries=10;'); await play(app);
  for(let i=0;i<10;i++) { question(app,3,4); keys(app,12); app.advance(170); }
  app.advance(700);
  assert.equal(app.element('dTitle').textContent,'You have used all 10 tries today');
});

test('refilling while the last-answer completion is paused resumes play instead of running an obsolete completion', async () => {
  const app=loadChain(); app.evaluate('S.settings.tries=10; today().tries=9;'); await play(app);
  question(app,3,4); keys(app,12); app.advance(200); app.element('homeBtn').click();
  refill(app); await play(app); const count=app.evaluate('qCount');
  app.advance(670);
  assert.equal(app.element('play').hidden,false); assert.equal(app.element('done').hidden,true);
  assert.equal(app.evaluate('qCount'),count+1);
  assert.equal(app.evaluate('triesLeft()'),10);
});

test('a limit reached by another update prevents an already displayed question spending an extra try', async () => {
  const app=loadChain(); await play(app); question(app,7,8);
  app.evaluate('today().tries=S.settings.tries;'); keys(app,56);
  assert.equal(app.evaluate('today().tries'),100); assert.equal(app.evaluate('today().correct'),0);
  assert.equal(app.element('done').hidden,false);
});

test('Start over discards paused session state and invalidates old feedback callbacks', async () => {
  const app=loadChain(); await play(app); question(app,7,8); keys(app,55);
  const oldReveal=[...app.timers.values()].find(timer=>timer.due===app.now()+380).fn;
  app.element('homeBtn').click(); app.evaluate('openParent();');
  app.element('wipeAll').click(); app.element('wipeAll').click(); app.element('parentClose').click();
  await play(app); const current=read(app,'cur'); oldReveal(); app.advance(380);
  assert.deepEqual(read(app,'cur'),current); assert.equal(app.element('revealNote').textContent,'');
  assert.equal(app.evaluate('chain'),0); assert.equal(app.evaluate('today().tries'),0);
});

test('a paused game resumed on a new date starts a fresh daily session', async () => {
  const app=loadChain(); await play(app); app.evaluate('chain=9;');
  app.element('homeBtn').click(); app.advance(24*60*60*1000); await play(app);
  assert.equal(app.evaluate('chain'),0); assert.equal(app.evaluate('sess.day===todayKey()'),true);
  assert.equal(app.evaluate('today().tries'),0);
});

test('speed thresholds and nearest-second rounding match the published scoring rules', async () => {
  for(const [milliseconds,gain] of [[2000,24],[2001,20],[3500,20],[3501,17],[6000,17],[6001,16]]) {
    const app=loadChain(); await play(app); question(app,2,3); app.advance(milliseconds); keys(app,6);
    assert.equal(app.evaluate('S.bank'),gain,`${milliseconds}ms`);
  }
  const app=loadChain(); await play(app); question(app,2,3); app.evaluate('chain=9;'); app.advance(4000); keys(app,6);
  assert.equal(app.evaluate('S.bank'),46); // round((16 + 1) × 1.5) + 20.
});
