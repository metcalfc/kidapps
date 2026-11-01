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
function choiceButton(app, correct) {
  const text = app.evaluate(`currentPuzzle().choices.find(c => !!c.ok === ${correct}).t`);
  return app.element('puzzle').querySelectorAll('.choice').find(button => button.textContent === text);
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
  test(`${lang}: explicit units must match the numeric question`, () => {
    const app = start(lang);
    const quantities = [
      {chapter:2, puzzle:1, value:25, unit:'years', suffixes:['year','years','an','ans','año','años']},
      {chapter:2, puzzle:4, value:22, unit:'years', suffixes:['years','ans','años']},
      {chapter:3, puzzle:4, value:21, unit:'minutes', suffixes:['minute','minutes','min','mins','minuto','minutos']},
      {chapter:4, puzzle:2, value:1.5, unit:'miles', suffixes:['mile','miles','mille','milles','milla','millas']},
      {chapter:5, puzzle:2, value:7, unit:'dollars', suffixes:['dollar','dollars','dólar','dólares']},
      {chapter:6, puzzle:2, value:85, unit:'minutes', suffixes:['minutes','min','minutos']},
    ];
    for (const quantity of quantities) {
      const {chapter,puzzle,value,unit,suffixes} = quantity;
      assert.equal(app.evaluate(`CHAPTERS[${chapter-1}].puzzles[${puzzle-1}].unit`),unit);
      for (const suffix of suffixes) {
        for (const raw of [`${value} ${suffix}`,`${value}${suffix}`]) assert.equal(right(app,chapter,puzzle,raw),true,raw);
      }
      for (const [other, suffix] of [['years','años'],['minutes','minutes'],['miles','millas'],['dollars','dollars']]) {
        if (other !== unit) assert.equal(right(app,chapter,puzzle,`${value}${suffix}`),false,`${unit}: ${value}${suffix}`);
      }
      if (unit !== 'dollars') assert.equal(right(app,chapter,puzzle,`$${value}`),false,`${unit}: currency symbol`);
    }
    assert.equal(right(app,2,1,'0:25'),false,'clock notation denotes minutes');
    assert.equal(right(app,2,1,'25minutes'),false);
    assert.equal(right(app,4,2,'1.5years'),false);
    assert.equal(right(app,6,2,'85miles'),false);
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

test('all declared answer aliases still grade correctly in every language', () => {
  const app = start();
  const failures = app.evaluate(`(() => {
    const failures = [];
    for (const [language, story] of Object.entries(STORIES)) for (const ch of story.chapters) for (const p of ch.puzzles) {
      for (const alias of p.answers || []) if (!isRight(p, alias)) failures.push({language,ch:ch.id,p:p.id,alias});
    }
    return failures;
  })()`);
  assert.equal(failures.length,0,JSON.stringify(failures));
});

test('correct choice and stale controls cannot change tries, hints or solve totals after success', () => {
  const app = start();
  app.evaluate('openChapter(0)'); submit(app,'9:10'); app.advance(500);
  const correct = choiceButton(app,true), wrong = choiceButton(app,false);
  const hint = app.element('puzzle').querySelector('.pactions').querySelector('button');
  correct.click(); wrong.click(); hint.click(); correct.click();
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

for (const language of ['en','fr','es']) {
  test(`${language}: document tabs and local hints preserve the unfinished answer and focus`,()=>{
    const app = start(language); app.evaluate('openChapter(0)');
    const originalForm = app.element('puzzle').querySelector('form');
    const original = originalForm.querySelector('input'); original.value='9:'; original.focus();
    app.element('docTabs').children[1].click();
    let input = app.element('puzzle').querySelector('input');
    assert.equal(input.value,'9:'); assert.equal(app.document.activeElement,input);
    app.element('puzzle').querySelector('.pactions').querySelector('button').click();
    input = app.element('puzzle').querySelector('input');
    assert.equal(input.value,'9:'); assert.equal(app.document.activeElement,input);
    assert.equal(app.element('puzzle').querySelector('.hints').children.length,1);
    original.value='9:10'; originalForm.dispatchEvent({type:'submit'});
    assert.equal(app.evaluate('chState(CHAPTERS[0]).puzzles.p1.tries'),0,'replaced controls are inactive');
    submit(app,'9:10');
    assert.equal(app.evaluate('chState(CHAPTERS[0]).puzzles.p1.solved'),true);
  });

  test(`${language}: all multiple-choice questions reshuffle on each presentation and retain wrong selections`,()=>{
    const catalog = start(language).evaluate(`CHAPTERS.flatMap((ch,chapter) => ch.puzzles.flatMap((p,puzzle) => p.choices ? [{chapter,puzzle}] : []))`);
    assert.equal(catalog.length,9);
    for (const {chapter,puzzle} of catalog) {
      const app=start(language); app.random(Array(8).fill(0));
      app.evaluate(`CHAPTERS.slice(0,${chapter}).forEach(ch => chState(ch).done=true);
        const ch=CHAPTERS[${chapter}];ch.puzzles.slice(0,${puzzle}).forEach(p=>Object.assign(pState(ch,p),{solved:true,tries:1}));openChapter(${chapter});`);
      const label=`chapter ${chapter+1}, puzzle ${puzzle+1}`;
      const original=app.element('puzzle').querySelectorAll('.choice').map(button=>button.textContent);
      const correct=choiceButton(app,true);
      assert.equal(original.indexOf(correct.textContent),original.length-1,label);
      assert.equal(app.evaluate('currentPuzzle().choices[0].ok'),true,'rendering must not mutate the story');
      const wrong=choiceButton(app,false), wrongText=wrong.textContent; wrong.click();
      assert.equal(app.evaluate('renderedPuzzle.ps.tries'),1,label);
      app.random(Array(8).fill(.999999));
      app.element('puzzle').querySelector('.pactions').querySelector('button').click();
      const hinted=app.element('puzzle').querySelectorAll('.choice').map(button=>button.textContent);
      assert.equal(hinted.indexOf(choiceButton(app,true).textContent),0,'a hint presents a fresh order');
      assert.notDeepEqual(hinted,original,label);
      app.random(Array(8).fill(0));
      app.element('docTabs').children[1].click();
      const documentOrder=app.element('puzzle').querySelectorAll('.choice').map(button=>button.textContent);
      assert.equal(documentOrder.indexOf(choiceButton(app,true).textContent),documentOrder.length-1,'document lookup presents a fresh order');
      assert.notDeepEqual(documentOrder,hinted,label);
      app.random(Array(8).fill(.999999));
      app.evaluate('const next=clone(S);const progress=lang==="en"?next.chapters:next.byLang[lang];progress[CHAPTERS[curCh].id].puzzles[currentPuzzle().id].hints=2;applySyncedState(next)');
      const after=app.element('puzzle').querySelectorAll('.choice');
      assert.equal(after.findIndex(button=>button.textContent===choiceButton(app,true).textContent),0,'a remote hint presents a fresh order');
      assert.deepEqual(after.map(button=>button.textContent).sort(),original.slice().sort(),'every presentation keeps the same answer choices');
      const stillWrong=after.find(button=>button.textContent===wrongText);
      assert.equal(stillWrong.classList.contains('no'),true,label);
      assert.equal(app.element('puzzle').querySelector('.feedback').hidden,false,label);
      stillWrong.click();
      assert.equal(app.evaluate('renderedPuzzle.ps.tries'),1,'a previously rejected choice is not counted twice');
      correct.dispatchEvent({type:'click'});
      assert.equal(app.evaluate('renderedPuzzle.ps.solved'),false,'controls from an earlier presentation cannot submit an answer');
      assert.equal(app.evaluate('renderedPuzzle.ps.tries'),1);
      const currentCorrect=choiceButton(app,true);app.pressKey(currentCorrect,'Enter');
      assert.equal(app.evaluate('renderedPuzzle.ps.solved'),true,label);
    }
  });
}

for (const language of ['fr','es']) {
  test(`${language}: Enter and Space on a nested glossary word open its definition without grading the choice`,()=>{
    for (const key of ['Enter',' ']) {
      const app=start(language);app.evaluate('openChapter(0)');submit(app,'9:10');app.advance(500);
      const choice=app.element('puzzle').querySelectorAll('.choice').find(button=>button.querySelector('.gl'));
      assert.ok(choice,'translated choices include glossary buttons');
      const word=choice.querySelector('.gl');
      let bubbled=false;
      choice.addEventListener('keydown',event=>{if(event.target===word)bubbled=true;});
      app.pressKey(word,key);
      assert.equal(bubbled,true,'the key event reaches the choice container');
      assert.equal(app.evaluate('renderedPuzzle.ps.tries'),0);
      assert.equal(app.evaluate('renderedPuzzle.ps.solved'),false);
      assert.equal(app.element('gloss').hidden,false,'the native word-button action opens the definition');
      assert.equal(app.element('gloss').querySelector('b').textContent,word.textContent);
      app.pressKey(choiceButton(app,true),key);
      assert.equal(app.evaluate('renderedPuzzle.ps.tries'),1);
      assert.equal(app.evaluate('renderedPuzzle.ps.solved'),true,'choice keyboard activation still grades');
    }
  });
}

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

for (const screen of ['home','notebook']) {
  for (const language of ['en','fr','es']) {
    test(`${language}: an ACK on ${screen} preserves drafts and wrong-answer history while choices reshuffle on return`,()=>{
      const app=start(language);app.evaluate('openChapter(0)');
      const oldForm=app.element('puzzle').querySelector('form');
      oldForm.querySelector('input').value='9:';
      app.evaluate(`show(${JSON.stringify(screen)});applySyncedState(clone(S));openChapter(0)`);
      assert.equal(app.element('puzzle').querySelector('input').value,'9:');
      oldForm.querySelector('input').value='9:10';oldForm.dispatchEvent({type:'submit'});
      assert.equal(app.evaluate('renderedPuzzle.ps.tries'),0,'offscreen controls remain inactive');
      submit(app,'9:10');app.random(Array(8).fill(.999999));app.advance(500);
      const original=app.element('puzzle').querySelectorAll('.choice').map(button=>button.textContent);
      assert.equal(original.indexOf(choiceButton(app,true).textContent),0);
      const wrong=choiceButton(app,false),wrongText=wrong.textContent;wrong.click();
      const feedback=app.element('puzzle').querySelector('.feedback').textContent;
      app.random(Array(8).fill(0));
      app.evaluate(`show(${JSON.stringify(screen)});applySyncedState(clone(S));openChapter(0)`);
      const choices=app.element('puzzle').querySelectorAll('.choice');
      assert.notDeepEqual(choices.map(button=>button.textContent),original);
      assert.equal(choices.findIndex(button=>button.textContent===choiceButton(app,true).textContent),choices.length-1);
      const rejected=choices.find(button=>button.textContent===wrongText);
      assert.equal(rejected.classList.contains('no'),true);
      assert.equal(app.element('puzzle').querySelector('.feedback').textContent,feedback);
      rejected.click();
      assert.equal(app.evaluate('renderedPuzzle.ps.tries'),1,'a rejected answer stays counted once');
      const saved=JSON.parse(app.evaluate("localStorage.getItem(LS_KEY)"));
      const progress=language==='en'?saved.chapters:saved.byLang[language];
      assert.deepEqual(Object.keys(progress.c1.puzzles.p2).sort(),['first','hints','solved','tries']);
    });
  }
}

test('offscreen ACK sessions stay separate by language and do not survive that language’s reset',()=>{
  const app=start();app.evaluate('openChapter(0)');
  app.element('puzzle').querySelector('input').value='English draft';
  app.evaluate("setLang('fr');openChapter(0)");
  app.element('puzzle').querySelector('input').value='French draft';
  app.evaluate("show('notebook');applySyncedState(clone(S));setLang('en');openChapter(0)");
  assert.equal(app.element('puzzle').querySelector('input').value,'English draft');
  app.evaluate("show('home');const next=clone(S);next.chapters={};KidMerge.stampReset(next,'en');applySyncedState(next);openChapter(0)");
  assert.equal(app.element('puzzle').querySelector('input').value,'','a reset creates a new English session');
  app.evaluate("setLang('fr');openChapter(0)");
  assert.equal(app.element('puzzle').querySelector('input').value,'French draft','an English reset preserves French work');
});
