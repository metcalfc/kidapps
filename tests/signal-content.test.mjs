import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const storyDirectory = process.env.SIGNAL_STORY_DIR
  ? pathToFileURL(process.env.SIGNAL_STORY_DIR.replace(/\/?$/, '/'))
  : new URL('../web/signal/', import.meta.url);
const context = vm.createContext({ window: {} });
for (const language of ['fr', 'es']) {
  vm.runInContext(readFileSync(new URL(`story-${language}.js`, storyDirectory), 'utf8'), context);
}
const stories = context.window.SIGNAL_STORIES;
const chapter = (language, id) => stories[language].chapters.find(c => c.id === id);
const puzzle = (language, ch, id) => chapter(language, ch).puzzles.find(p => p.id === id);
const document = (language, ch, id) => chapter(language, ch).docs.find(d => d.id === id);
const textKey = text => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, '');
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const shift = (text, amount) => text.replace(/[A-Z]/g, c => alphabet[(alphabet.indexOf(c) + amount + 26) % 26]);
const money = text => Number(text.match(/\d+[.,]\d{2}/)[0].replace(',', '.'));
const time = text => {
  const match = text.match(/(\d{1,2})\s*(?:h|:)\s*(\d{2})/);
  assert.ok(match, `missing time in ${text}`);
  let hours = Number(match[1]);
  if (hours < 12) hours += 12; // All story times being compared are afternoon/evening.
  return hours * 60 + Number(match[2]);
};

for (const language of ['fr', 'es']) {
  test(`${language}: all six cipher messages decode to the intended answers`, () => {
    // These fixtures describe the displayed cipher aids, independently of answer aliases.
    const morse = { '-': 'T', '---': 'O', '..-': 'U', '.-.': 'R', '.': 'E' };
    const grid = ['ABCDE', 'FGHIK', 'LMNOP', 'QRSTU', 'VWXYZ'];
    const keypad = { 2: 'ABC', 3: 'DEF', 4: 'GHI', 5: 'JKL', 6: 'MNO', 7: 'PQRS', 8: 'TUV', 9: 'WXYZ' };
    const expected = language === 'fr'
      ? ['TOUR', 'EN HAUT', 'LIVRES', 'HOLLOW HILL', 'REPONDS', 'NM UNTR DMSDMC']
      : ['TORRE', 'MIRA ARRIBA', 'BIBLIOTECA', 'HOLLOW HILL', 'RESPONDE', 'SD NHLNR'];
    const definitions = [['c1', 'p3'], ['c2', 'p3'], ['c3', 'p2'], ['c4', 'p1'], ['c5', 'p3'], ['c6', 'p4']];
    definitions.forEach(([ch, id], index) => {
      const p = puzzle(language, ch, id);
      let decoded;
      if (p.aid === 'morse') decoded = p.code.map(c => morse[c]).join('');
      if (p.aid === 'numbers') decoded = p.code.map(n => {
        assert.ok(Number.isInteger(Number(n) / 2) && n >= 2 && n <= 52);
        return alphabet[Number(n) / 2 - 1];
      }).join('');
      if (p.aid === 'grid') decoded = p.code.split(/\s*\/\s*/).map(word => word.split(/\s+/).map(c => grid[Number(c[1]) - 1][alphabet.indexOf(c[0])]).join('')).join(' ');
      if (p.aid === 'keypad') decoded = p.code.map(c => keypad[c[0]][Number(c[1]) - 1]).join('');
      if (p.aid === 'wheel') decoded = shift(p.code, ch === 'c2' ? -3 : 1986 - 1961);
      assert.equal(decoded, expected[index], `${ch}/${id}`);
      assert.ok(p.answers.some(answer => textKey(answer) === textKey(decoded)), `${ch}/${id}: intended decoded answer is offered`);
    });
  });

  test(`${language}: the four-minute signal ends at the accepted time`, () => {
    const story = document(language, 'c1', 'c1d1').body[1];
    const duration = language === 'fr' ? /quatre minutes/ : /cuatro minutos/;
    assert.match(story, duration);
    const end = time(story) + 4;
    const acceptedTime = `${Math.floor(end / 60)}:${String(end % 60).padStart(2, '0')}`;
    assert.ok(puzzle(language, 'c1', 'p4').answers.includes(acceptedTime));
  });

  test(`${language}: year arithmetic is an approximation of elapsed years and an exact cipher key`, () => {
    const oldArticle = document(language, 'c2', 'c2d1');
    const newArticle = document(language, 'c2', 'c2d2');
    const oldYear = Number(oldArticle.meta.match(/19\d{2}/)[0]);
    const newYear = Number(newArticle.meta.match(/19\d{2}/)[0]);
    const startYear = Number(oldArticle.body[0].match(/1939/)[0]);
    const silence = puzzle(language, 'c2', 'p1');
    assert.equal(silence.num, newYear - oldYear);
    assert.equal(puzzle(language, 'c2', 'p4').num, oldYear - startYear);
    assert.match(silence.q, language === 'fr' ? /environ/ : /aproximadamente/i);
    assert.match(silence.clue, language === 'fr' ? /environ/ : /aproximadamente/i);
    const finalMessage = puzzle(language, 'c6', 'p4');
    assert.equal(shift(finalMessage.code, newYear - oldYear).replace(/\s/g, '').toLowerCase(), textKey(finalMessage.answers[0]));
  });

  test(`${language}: bus answers follow the timetable and leave enough research time`, () => {
    const notebook = document(language, 'c3', 'c3d2');
    const closing = time(notebook.body[1]);
    const pianoEnds = time(notebook.body[2]);
    const requiredMinutes = Number(notebook.body[2].match(/(?:au moins|por lo menos) (\d+) (?:minutes|minutos)/)[1]);
    const timetable = document(language, 'c3', 'c3d3').body.find(b => b.table).table;
    const possible = timetable[0].slice(1).map((bus, i) => ({ bus, leaves: time(timetable[1][i + 1]), arrives: time(timetable[3][i + 1]) }))
      .filter(bus => bus.leaves >= pianoEnds && bus.arrives + requiredMinutes <= closing);
    const latest = possible.reduce((a, b) => a.leaves > b.leaves ? a : b);
    assert.match(latest.bus, / C$/);
    const departure = `${Math.floor(latest.leaves / 60)}:${String(latest.leaves % 60).padStart(2, '0')}`;
    assert.ok(puzzle(language, 'c3', 'p3').answers.includes(departure));
    assert.equal(puzzle(language, 'c3', 'p4').num, latest.arrives - latest.leaves);
  });

  test(`${language}: the alphabetic card drawer matches the book title`, () => {
    const card = document(language, 'c4', 'c4d2');
    const drawer = card.title.match(/(?:tiroir|cajón) ([A-Z])/)[1];
    const title = card.body.find(b => b.lines).lines[2];
    assert.equal(title[0].toUpperCase(), drawer);
    assert.ok(document(language, 'c4', 'c4d1').body.some(line => typeof line === 'string' && line.includes(title.replace(/\.$/, ''))));
  });

  test(`${language}: map distance is 1.5 miles, without a wrong 11/2 alias`, () => {
    const mapDocument = document(language, 'c4', 'c4d3');
    const places = mapDocument.body.find(b => b.map).map.places;
    const library = Object.entries(places).find(([, value]) => /biblioth|biblioteca/i.test(value[1]))[0];
    const tower = Object.entries(places).find(([, value]) => value[1] === 'Hollow Hill')[0];
    const quarterMile = mapDocument.body.find(line => typeof line === 'string' && line.includes('1/4'));
    assert.ok(quarterMile);
    const blocks = Math.abs(library.charCodeAt(0) - tower.charCodeAt(0)) + Math.abs(Number(library[1]) - Number(tower[1]));
    const p = puzzle(language, 'c4', 'p2');
    assert.equal(p.num, blocks / 4);
    assert.equal(p.num, 1.5);
    assert.equal(p.answers.includes('11/2'), false);
  });

  test(`${language}: the receipt's missing price is the stated seven dollars`, () => {
    const receipt = document(language, 'c5', 'c5d2').body.find(b => b.table).table;
    const batteries = Number(receipt[1][0].match(/\d+/)[0]) * money(receipt[1][1]);
    const antenna = money(receipt[2][2]);
    const total = money(receipt[4][2]);
    assert.equal(puzzle(language, 'c5', 'p2').num, total - batteries - antenna);
    assert.equal(total - batteries - antenna, 7);
  });

  test(`${language}: arrival is explicit and supports the 85-minute answer`, () => {
    const story = document(language, 'c6', 'c6d1').body[0];
    const arrival = story.match(language === 'fr' ? /arrivés à la cabane[^.]+/ : /Llegamos a la casita[^.]+/);
    assert.ok(arrival, 'the source must state arrival, rather than only a ride up the road');
    const arrivalTime = time(arrival[0]);
    const p = puzzle(language, 'c6', 'p2');
    assert.equal(time(p.q), arrivalTime);
    const broadcast = time(document(language, 'c6', 'c6d2').body[2]);
    assert.equal(p.num, broadcast - arrivalTime);
    assert.equal(p.num, 85);
  });

  test(`${language}: natural written time answers remain available to learners`, () => {
    const expectedTimes = language === 'fr'
      ? ['vingt et une heures quatorze', 'à vingt et une heures quatorze', 'neuf heures quatorze']
      : ['las nueve y catorce', 'a las nueve y catorce', 'las nueve y catorce de la noche'];
    const answers = puzzle(language, 'c1', 'p4').answers.map(textKey);
    for (const answer of expectedTimes) assert.ok(answers.includes(textKey(answer)), answer);
    const durations = puzzle(language, 'c6', 'p2').answers.map(textKey);
    assert.ok(durations.includes(textKey(language === 'fr' ? 'une heure et vingt-cinq minutes' : 'una hora y veinticinco minutos')));
  });
}

test('Spanish explains that the cipher uses A–Z without Ñ', () => {
  // Spanish has 27 letters; the story's cipher intentionally uses the 26-letter aid.
  // https://www.rae.es/sites/default/files/Principales_novedades_de_la_Ortografia_de_la_lengua_espanola.pdf
  const hint = puzzle('es', 'c6', 'p4').hints[1];
  assert.match(hint, /código usa 26 letras, sin la Ñ/);
  assert.doesNotMatch(hint, /abecedario tiene 26 letras/);
});
