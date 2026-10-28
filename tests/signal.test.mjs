import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSignal } from './signal-harness.mjs';

function start(lang = 'en') {
  const app = loadSignal();
  app.evaluate(`S.settings.lang = ${JSON.stringify(lang)}; connecting = false; applyLang(); show('home');`);
  return app;
}
function right(app, chapter, puzzle, raw) {
  return app.evaluate(`isRight(STORIES[lang].chapters[${chapter - 1}].puzzles[${puzzle - 1}], ${JSON.stringify(raw)})`);
}
function unlock(app, index) {
  app.evaluate(`CHAPTERS.slice(0, ${index}).forEach(ch => chState(ch).done = true); openChapter(${index});`);
}
function submit(app, raw) {
  const form = app.element('puzzle').querySelector('form');
  assert.ok(form, 'actual production answer form must be rendered');
  form.querySelector('input').value = raw;
  form.dispatchEvent({type:'submit'});
  return form;
}
function prepareLastPuzzle(app) {
  app.evaluate(`const ch = CHAPTERS[0]; ch.puzzles.slice(0, -1).forEach(p => Object.assign(pState(ch,p), {solved:true,tries:1,first:true})); openChapter(0);`);
}

for (const lang of ['en', 'fr', 'es']) {
  test(`${lang}: numeric grading preserves signs, decimal punctuation and fraction values`, () => {
    const app = start(lang);
    for (const raw of ['7', '+7', '7.00', '7,00', '$7.00', '7 dollars', '7 dólares']) assert.equal(right(app,5,2,raw), true, raw);
    for (const raw of ['-7', '−7', '-7 dollars', '700', '7/0', '7.1']) assert.equal(right(app,5,2,raw), false, raw);
    for (const raw of ['1.5', '1,5', '1 1/2', '3/2', '6/4', '1 and 1/2', '1et1/2', '1y1/2', '1,5 miles']) assert.equal(right(app,4,2,raw), true, raw);
    for (const raw of ['15', '11/2', '-1.5', '−3/2', '-1 1/2', '1/0', '1,2,3']) assert.equal(right(app,4,2,raw), false, raw);
    assert.equal(right(app,2,1,'-25'), false);
    assert.equal(right(app,2,1,'25 years'), true);
  });
  test(`${lang}: duration answers accept localized hours and minutes without changing their value`, () => {
    const app = start(lang);
    for (const raw of ['85', '85 minutes', '1:25', '1h25', '1h25m', '1 hour 25 minutes', '1heure25', '1 heure et 25 minutes', '1hora25', '1 hora y 25 minutos', 'una hora y 25 minutos']) assert.equal(right(app,6,2,raw), true, raw);
    for (const raw of ['-85', '-1h25', '1:26', '1h26', '125', '1:85']) assert.equal(right(app,6,2,raw), false, raw);
  });
  test(`${lang}: double-submitting a correct form only records one first-try solve`, () => {
    const app = start(lang); app.evaluate('openChapter(0)');
    const answer = app.evaluate('CHAPTERS[0].puzzles[0].answers[0]');
    const form = submit(app, answer); form.dispatchEvent({type:'submit'});
    assert.equal(app.evaluate('today().solved'), 1);
    assert.equal(app.evaluate('chState(CHAPTERS[0]).puzzles.p1.tries'), 1);
    assert.equal(app.evaluate('chState(CHAPTERS[0]).puzzles.p1.first'), true);
    assert.equal(form.querySelector('button').disabled, true);
    app.advance(500);
    assert.equal(app.evaluate('currentPuzzle().id'), 'p2');
  });
}

test('numeric story aliases agree with numeric answers rather than bypassing arithmetic', () => {
  const app = start();
  const mismatches = app.evaluate(`(() => {
    const issues = [];
    for (const [language, story] of Object.entries(STORIES)) {
      for (const ch of story.chapters) for (const p of ch.puzzles) {
        if (p.num === undefined) continue;
        for (const alias of p.answers) {
          const parsed = parseNum(alias);
          if (Number.isFinite(parsed) && Math.abs(parsed - p.num) >= 1e-9) issues.push({language,ch:ch.id,p:p.id,alias,parsed});
        }
      }
    }
    return issues;
  })()`);
  assert.equal(mismatches.length, 0, JSON.stringify(mismatches));
});

test('correct choice and stale controls cannot change tries, hints or solve totals after success', () => {
  const app = start();
  app.evaluate('openChapter(0)'); submit(app,'9:10'); app.advance(500);
  const choices = app.element('puzzle').querySelectorAll('.choice');
  const hint = app.element('puzzle').querySelector('.pactions').querySelector('button');
  choices[0].click(); choices[1].click(); hint.click(); choices[0].click();
  assert.equal(app.evaluate('today().solved'), 2);
  assert.equal(app.evaluate('chState(CHAPTERS[0]).puzzles.p2.tries'), 1);
  assert.equal(app.evaluate('chState(CHAPTERS[0]).puzzles.p2.hints'), 0);
  assert.equal(app.evaluate('chState(CHAPTERS[0]).puzzles.p2.first'), true);
});

test('changing language from a later chapter resets view and document without crossing progress', () => {
  const app = start(); unlock(app,4);
  app.element('docTabs').children[1].click();
  assert.equal(app.evaluate('curDoc.id'), 'c5d2');
  app.evaluate("setLang('fr')");
  assert.equal(app.element('home').hidden,false);
  assert.equal(app.element('chapter').hidden,true);
  assert.equal(app.evaluate('curCh'),0);
  assert.equal(app.evaluate('curDoc === CHAPTERS[0].docs[0]'),true);
  assert.equal(app.evaluate('Object.keys(S.byLang.fr || {}).length'),0);
  app.element('continueBtn').click();
  assert.equal(app.evaluate('curDoc === STORIES.fr.chapters[0].docs[0]'),true);
  assert.equal(app.element('docView').textContent.includes('Voici les notes'),true);
  assert.equal(app.evaluate('chState(CHAPTERS[0]).docs.includes("c5d2")'),false);
  assert.equal(app.element('chStars').textContent,'0 étoiles sur 12');
  assert.match(app.element('docView').querySelector('.gl-note').textContent,/anglais/);
});

test('switching language after solving cannot show an old chapter completion overlay', () => {
  const app = start(); prepareLastPuzzle(app);
  submit(app,'9:14');
  const stale = app.timers().find(t=>t.delay===500).fn;
  app.evaluate("setLang('es')"); app.advance(500); stale();
  assert.equal(app.element('doneOverlay').hidden,true);
  assert.equal(app.element('home').hidden,false);
  assert.equal(app.evaluate('Object.keys(S.byLang.es || {}).length'),0);
  assert.equal(app.evaluate('S.chapters.c1.done'),true);
});

test('navigation away from a completed chapter cancels stale completion callbacks', () => {
  const app = start(); prepareLastPuzzle(app); submit(app,'9:14');
  const stale = app.timers().find(t=>t.delay===500).fn;
  app.element('chBack').click(); app.advance(500); stale();
  assert.equal(app.element('home').hidden,false);
  assert.equal(app.element('doneOverlay').hidden,true);
});

test('reset from chapter five returns home and restores later chapter locks', () => {
  const app = start(); unlock(app,4); app.evaluate('openParent()');
  app.element('wipeAll').click(); app.element('wipeAll').click();
  app.element('parentClose').click();
  assert.equal(app.element('home').hidden,false);
  assert.equal(app.element('chapter').hidden,true);
  assert.equal(app.evaluate('curCh'),0);
  assert.equal(app.evaluate('curDoc === CHAPTERS[0].docs[0]'),true);
  assert.equal(app.evaluate('Object.keys(S.chapters).length'),0);
  const cases = app.element('cases').children;
  assert.equal(cases[0].disabled,false);
  assert.ok(cases.slice(1).every(b=>b.disabled));
});

test('reset after a final answer also invalidates old form and completion callback identities', () => {
  const app = start(); prepareLastPuzzle(app); const form=submit(app,'9:14');
  const stale=app.timers().find(t=>t.delay===500).fn;
  app.evaluate('openParent()'); app.element('wipeAll').click(); app.element('wipeAll').click();
  form.dispatchEvent({type:'submit'}); stale(); app.advance(500);
  assert.equal(app.evaluate('today().solved'),1,'reset clears case progress, not historic daily activity');
  assert.equal(app.evaluate('Object.keys(S.chapters).length'),0);
  assert.equal(app.element('doneOverlay').hidden,true);
});

test('normal chapter completion still shows its story once', () => {
  const app = start(); prepareLastPuzzle(app); submit(app,'9:14'); app.advance(500);
  assert.equal(app.element('doneOverlay').hidden,false);
  assert.match(app.element('doneStory').textContent,/only one tower/);
  app.element('doneNext').click();
  assert.equal(app.evaluate('curCh'),1);
  assert.equal(app.element('doneOverlay').hidden,true);
});

test('a background save ACK preserves typed text and the live answer handler', async()=>{
  const app=start();app.evaluate('openChapter(0)');
  const form=app.element('puzzle').querySelector('form'),input=form.querySelector('input');
  input.value='9:10';input.focus();
  app.evaluate(`remote = {
    get:async()=>({exists:true,data:()=>clone(S),metadata:{etag:'one'}}),
    commit:async data=>({exists:true,data:()=>data,metadata:{etag:'two'}})
  }; dirty=true;`);
  await app.evaluate('flush()');
  assert.equal(app.element('puzzle').querySelector('form'),form,'statistics-only ACK must not replace the form');
  assert.equal(input.value,'9:10');assert.equal(app.document.activeElement,input);
  form.dispatchEvent({type:'submit'});
  assert.equal(app.evaluate('today().solved'),1);assert.equal(app.evaluate('chState(CHAPTERS[0]).puzzles.p1.first'),true);
});

test('remote statistics preserve the form even when an English save has no explicit language setting',()=>{
  const app=start();app.evaluate('delete S.settings.lang; openChapter(0)');
  const form=app.element('puzzle').querySelector('form');form.querySelector('input').value='9:';
  app.evaluate('const next=clone(S);next.days.extra={secs:30};applySyncedState(next)');
  assert.equal(app.element('puzzle').querySelector('form'),form);
  assert.equal(form.querySelector('input').value,'9:');
});

test('an ACK during the success delay still advances once and shows chapter completion',()=>{
  const app=start();prepareLastPuzzle(app);const form=submit(app,'9:14');
  app.evaluate('const next=clone(S);next.days.extra={secs:30};applySyncedState(next)');
  assert.equal(app.element('puzzle').querySelector('form'),form);
  app.advance(500);
  assert.equal(app.element('doneOverlay').hidden,false);
  assert.equal(app.evaluate('today().solved'),1);
});

test('updated hints rerender the question while preserving its unfinished typed answer',()=>{
  const app=start();app.evaluate('openChapter(0)');
  const input=app.element('puzzle').querySelector('form').querySelector('input');input.value='9:';input.focus();
  app.evaluate('const next=clone(S);next.chapters.c1.puzzles.p1.hints=1;applySyncedState(next)');
  const replacement=app.element('puzzle').querySelector('form').querySelector('input');
  assert.equal(replacement.value,'9:');assert.equal(app.document.activeElement,replacement);
  assert.equal(app.element('puzzle').querySelector('.hints').children.length,1);
  replacement.value='9:10';app.element('puzzle').querySelector('form').dispatchEvent({type:'submit'});
  assert.equal(app.evaluate('chState(CHAPTERS[0]).puzzles.p1.solved'),true);
});

test('a remote reset invalidates old controls and a pending completion animation',()=>{
  const app=start();prepareLastPuzzle(app);const form=submit(app,'9:14');const stale=app.timers().find(t=>t.delay===500).fn;
  app.evaluate("const next=clone(S);next.chapters={};KidMerge.stampReset(next,'en');applySyncedState(next)");
  form.dispatchEvent({type:'submit'});stale();app.advance(500);
  assert.equal(app.element('home').hidden,false);assert.equal(app.element('doneOverlay').hidden,true);
  assert.equal(app.evaluate('Object.keys(S.chapters).length'),0);
});

test('complementary merged puzzle halves derive chapter completion and unlock the next chapter',()=>{
  for(const language of ['en','fr','es']){
    const app=start(language);
    app.evaluate(`const initial=clone(S),left=clone(S),right=clone(S);
      const chapter=CHAPTERS[0], split=Math.ceil(chapter.puzzles.length/2);
      const progress=state=>lang==='en'?state.chapters:(state.byLang[lang]??={});
      progress(left)[chapter.id]={docs:[],puzzles:{},done:false};progress(right)[chapter.id]={docs:[],puzzles:{},done:false};
      chapter.puzzles.forEach((p,i)=>{progress(i<split?left:right)[chapter.id].puzzles[p.id]={solved:true,tries:1,hints:0,at:i+1};});
      applySyncedState(KidMerge.signal(initial,left,right));`);
    assert.equal(app.evaluate('prog()[CHAPTERS[0].id].done'),true,language);
    assert.equal(app.evaluate('unlocked(1)'),true,language);
    app.evaluate('openChapter(1)');assert.equal(app.evaluate('curCh'),1,language);
  }
});
