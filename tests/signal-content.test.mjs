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
// Load just the English story and its map dependency, without booting the app.
const html = readFileSync(new URL('index.html', storyDirectory), 'utf8');
const storyStart = html.indexOf('const MAP =');
const storyEnd = html.indexOf('const $ =', storyStart);
assert.ok(storyStart !== -1 && storyEnd > storyStart, 'English story boundaries are present');
vm.runInContext(html.slice(storyStart, storyEnd) + '\nwindow.SIGNAL_STORIES.en = { chapters: STORY_EN };', context);
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
const assertTimeAnswer = (p, expected) => assert.ok(
  p.answers.some(answer => /\d{1,2}\s*(?:h|:)\s*\d{2}/.test(answer) && time(answer) === expected),
  `${p.id}: an accepted time must match the source time`,
);
const wording = {
  en: { duration: /four minutes/, approximate: /about/i, required: /at least (\d+) minutes/, arrival: /reached the shed[^.]+/ },
  fr: { duration: /quatre minutes/, approximate: /environ/, required: /au moins (\d+) minutes/, arrival: /arrivés à la cabane[^.]+/ },
  es: { duration: /cuatro minutos/, approximate: /aproximadamente/i, required: /por lo menos (\d+) minutos/, arrival: /Llegamos a la casita[^.]+/ },
};

for (const language of ['en', 'fr', 'es']) {
  test(`${language}: all six cipher messages decode to the intended answers`, () => {
    // These fixtures describe the displayed cipher aids, independently of answer aliases.
    const morse = { '-': 'T', '---': 'O', '..-': 'U', '.--': 'W', '.-.': 'R', '.': 'E' };
    const grid = ['ABCDE', 'FGHIK', 'LMNOP', 'QRSTU', 'VWXYZ'];
    const keypad = { 2: 'ABC', 3: 'DEF', 4: 'GHI', 5: 'JKL', 6: 'MNO', 7: 'PQRS', 8: 'TUV', 9: 'WXYZ' };
    const expected = {
      en: ['TOWER', 'LOOK UP', 'LIBRARY', 'HOLLOW HILL', 'REPLY', 'VD GDZQ XNT'],
      fr: ['TOUR', 'EN HAUT', 'LIVRES', 'HOLLOW HILL', 'REPONDS', 'NM UNTR DMSDMC'],
      es: ['TORRE', 'MIRA ARRIBA', 'BIBLIOTECA', 'HOLLOW HILL', 'RESPONDE', 'SD NHLNR'],
    }[language];
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
      if (ch !== 'c6') {
        const source = document(language, ch, { c1: 'c1d2', c2: 'c2d3', c3: 'c3d1', c4: 'c4d2', c5: 'c5d3' }[ch]);
        const displayed = source.body.find(b => b.code || b.pencil);
        if (p.aid === 'morse') {
          const groups = displayed.code.trim().split(/\s{2,}/).map(group => group.replace(/\s/g, '').replaceAll('•', '.').replaceAll('–', '-'));
          assert.equal(groups.join(' '), p.code.join(' '), `${ch}: source beeps match puzzle`);
        } else {
          const sourceCode = (displayed.code || displayed.pencil).replace(/[\s·]/g, '');
          const puzzleCode = (Array.isArray(p.code) ? p.code.join('') : p.code).replace(/\s/g, '');
          assert.ok(sourceCode.includes(puzzleCode), `${ch}: displayed document contains the code being solved`);
        }
      } else {
        const letter = document(language, ch, 'c6d2').body[3];
        assert.ok(textKey(letter).includes(textKey(p.code)), 'the final letter names the plaintext being encoded');
      }
    });
  });

  test(`${language}: the signal start answer follows the notebook`, () => {
    const start = time(document(language, 'c1', 'c1d1').body[1]);
    assert.equal(start, 21 * 60 + 10);
    assertTimeAnswer(puzzle(language, 'c1', 'p1'), start);
  });

  test(`${language}: the four-minute signal ends at the accepted time`, () => {
    const story = document(language, 'c1', 'c1d1').body[1];
    assert.match(story, wording[language].duration);
    const end = time(story) + 4;
    assertTimeAnswer(puzzle(language, 'c1', 'p4'), end);
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
    assert.match(silence.q, wording[language].approximate);
    assert.match(silence.clue, wording[language].approximate);
    const finalMessage = puzzle(language, 'c6', 'p4');
    assert.match(finalMessage.hints[0], new RegExp(`${newYear} − ${oldYear} = ${newYear - oldYear}`));
  });

  test(`${language}: bus answers follow the timetable and leave enough research time`, () => {
    const notebook = document(language, 'c3', 'c3d2');
    const closing = time(notebook.body[1]);
    const pianoEnds = time(notebook.body[2]);
    const requiredMinutes = Number(notebook.body[2].match(wording[language].required)[1]);
    const timetable = document(language, 'c3', 'c3d3').body.find(b => b.table).table;
    const possible = timetable[0].slice(1).map((bus, i) => ({ bus, leaves: time(timetable[1][i + 1]), arrives: time(timetable[3][i + 1]) }))
      .filter(bus => bus.leaves >= pianoEnds && bus.arrives + requiredMinutes <= closing);
    const latest = possible.reduce((a, b) => a.leaves > b.leaves ? a : b);
    assert.match(latest.bus, / C$/);
    assertTimeAnswer(puzzle(language, 'c3', 'p3'), latest.leaves);
    assert.equal(puzzle(language, 'c3', 'p4').num, latest.arrives - latest.leaves);
  });

  test(`${language}: the alphabetic card drawer matches the book title`, () => {
    const card = document(language, 'c4', 'c4d2');
    const drawer = card.title.match(/(?:catalog:|tiroir|cajón) ([A-Z])/)[1];
    const title = card.body.find(b => b.lines).lines[2];
    assert.equal(title[0].toUpperCase(), drawer);
    assert.ok(document(language, 'c4', 'c4d1').body.some(line => typeof line === 'string' && line.includes(title.replace(/\.$/, ''))));
  });

  test(`${language}: map distance is 1.5 miles, without a wrong 11/2 alias`, () => {
    const mapDocument = document(language, 'c4', 'c4d3');
    const places = mapDocument.body.find(b => b.map).map.places;
    const library = Object.entries(places).find(([, value]) => /library|biblioth|biblioteca/i.test(value[1]))[0];
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
    const arrival = story.match(wording[language].arrival);
    assert.ok(arrival, 'the source must state arrival, rather than only a ride up the road');
    const arrivalTime = time(arrival[0]);
    const p = puzzle(language, 'c6', 'p2');
    assert.equal(time(p.q), arrivalTime);
    const broadcast = time(document(language, 'c6', 'c6d2').body[2]);
    assert.equal(p.num, broadcast - arrivalTime);
    assert.equal(p.num, 85);
  });

  test(`${language}: natural written time answers remain available to learners`, () => {
    const expectedTimes = {
      en: ['9:14', '9:14pm'],
      fr: ['vingt et une heures quatorze', 'à vingt et une heures quatorze', 'neuf heures quatorze'],
      es: ['las nueve y catorce', 'a las nueve y catorce', 'las nueve y catorce de la noche'],
    }[language];
    const answers = puzzle(language, 'c1', 'p4').answers.map(textKey);
    for (const answer of expectedTimes) assert.ok(answers.includes(textKey(answer)), answer);
    const durations = puzzle(language, 'c6', 'p2').answers.map(textKey);
    assert.ok(durations.includes(textKey({ en: '1 hour and 25 minutes', fr: 'une heure et vingt-cinq minutes', es: 'una hora y veinticinco minutos' }[language])));
  });

  test(`${language}: all nine multiple-choice answers have supporting story evidence`, () => {
    // Semantic expectations come from reading the source documents, not choice positions or ok flags.
    const expected = {
      en: [/Truckers talk.*only beeped/, /Agnes Pell.*ten past nine.*same time/, /Cut it in half/, /^Agnes Pell$/, /ABC order/, /Haven't sold a radio tube in twenty years/, /helping a friend.*left alone/, /missed.*puzzle game.*hoped.*answer/, /Said yes/],
      fr: [/camionneurs parlent.*seulement des bips/, /Agnes Pell.*21 h 10.*signal/, /diviser par deux/, /^Agnes Pell$/, /ordre A, B, C/, /pas vendu de lampe radio depuis vingt ans/, /aide une amie.*tranquille/, /jeu du soir avec Walt.*manquait.*réponse/, /dit oui/],
      es: [/camioneros hablan.*solo hace pitidos/, /Agnes Pell.*nueve y diez.*misma hora/, /corto por la mitad/, /^Agnes Pell$/, /orden de la A a la Z/, /No vendo un tubo de radio desde hace veinte años/, /Ayuda a una amiga.*paz/, /Extrañaba.*acertijos.*quería una respuesta/, /Dijo que sí/],
    }[language];
    const evidence = {
      en: [/truckers talk.*don't beep/is, /Agnes Pell.*ten minutes past nine/s, /numbers are doubled/, /His wife.*every Tuesday.*passed away/s, /alphabetical order.*A to F/s, /Radio tube, type 6L6/, /HOLD FOR A.P.*privacy.*earned it/s, /puzzle every night.*house got very quiet.*play the game again/s, /approved a plan.*turn the old WLRK shed.*station/s],
      fr: [/camionneurs parlent.*pas de bips/s, /Agnes Pell.*vingt et une heures dix/s, /nombres sont doublés/, /Sa femme.*chaque mardi.*mort de Walt/s, /ordre alphabétique.*A à F/s, /Lampe radio, type 6L6/, /POUR A.P.*tranquilles.*méritent/s, /énigme chaque soir.*maison était très silencieuse.*pour jouer encore/s, /approuvé un projet.*va devenir.*radio/s],
      es: [/camioneros hablan.*No hacen pitidos/s, /Agnes Pell.*nueve y diez/s, /doble/, /Su esposa.*martes.*murió/s, /orden alfabético.*A a la F/s, /Tubo de radio, tipo 6L6/, /GUARDAR PARA A.P.*privacidad.*ganaron/s, /acertijo cada noche.*casa quedó muy callada.*jugar otra vez/s, /aprobó un plan.*va a ser.*estación de radio/s],
    }[language];
    const cases = [
      ['c1', 'p2', 'c1d1'], ['c2', 'p2', 'c2d1'], ['c3', 'p1', 'c3d1'],
      ['c4', 'p3', 'c4d1'], ['c4', 'p4', 'c4d1'], ['c5', 'p1', 'c5d2'],
      ['c5', 'p4', 'c5d1'], ['c6', 'p1', 'c6d1'], ['c6', 'p3', 'c6d2'],
    ];
    cases.forEach(([ch, id, source], i) => {
      const p = puzzle(language, ch, id);
      const correct = p.choices.filter(choice => choice.ok);
      assert.equal(correct.length, 1, `${ch}/${id}: exactly one correct choice`);
      assert.match(correct[0].t, expected[i], `${ch}/${id}: intended meaning`);
      assert.match(JSON.stringify(document(language, ch, source).body), evidence[i], `${ch}/${id}: source supports the answer`);
      assert.ok(p.choices.filter(choice => !choice.ok).every(choice => choice.why), `${ch}/${id}: distractors explain their mistake`);
    });
    assert.equal(stories[language].chapters.reduce((n, ch) => n + ch.puzzles.filter(p => p.choices).length, 0), cases.length);
    assert.equal(stories[language].chapters.reduce((n, ch) => n + ch.puzzles.length, 0), 24);
  });

  test(`${language}: Monday's library visit can include Sunday's recording and Monday's newspaper`, () => {
    const dates = [
      ['c1', 'c1d1', 'meta', 12], ['c2', 'c2d2', 'meta', 15], ['c3', 'c3d1', 'title', 19],
      ['c3', 'c3d2', 'meta', 20], ['c4', 'c4d1', 'meta', 20], ['c5', 'c5d1', 'meta', 22],
      ['c5', 'c5d2', 'meta', 18], ['c6', 'c6d1', 'meta', 27],
    ];
    const weekdays = {
      en: [/Sunday/i, /Monday/i, /Tuesday/i, /Wednesday/i, /Thursday/i, /Friday|FRI/i, /Saturday/i],
      fr: [/dimanche/i, /lundi/i, /mardi/i, /mercredi/i, /jeudi/i, /vendredi|VEN\./i, /samedi/i],
      es: [/domingo/i, /lunes/i, /martes/i, /miércoles/i, /jueves/i, /viernes|VIE/i, /sábado/i],
    }[language];
    for (const [ch, id, field, day] of dates) {
      const dateText = document(language, ch, id)[field];
      assert.match(dateText, new RegExp(`\\b${day}\\b`));
      assert.match(dateText, /sept/i);
      assert.match(dateText, weekdays[new Date(Date.UTC(1986, 8, day)).getUTCDay()], `${ch}/${id}: actual calendar weekday`);
    }
    assert.match(chapter(language, 'c1').outro, { en: /On Monday/, fr: /Lundi/, es: /El lunes/ }[language]);
    assert.doesNotMatch(chapter(language, 'c1').outro, /Tomorrow|Demain|Mañana/i);
    assert.match(document(language, 'c1', 'c1d1').body[1], { en: /^Last night/, fr: /^Hier soir/, es: /^Anoche/ }[language]);
    assert.match(document(language, 'c2', 'c2d3').title, weekdays[0]); // September 14, before Monday's visit.
    const nightsBeforeVisit = (Date.UTC(1986, 8, 27) - Date.UTC(1986, 8, 11)) / 86400000;
    assert.equal(nightsBeforeVisit, 16);
    assert.match(document(language, 'c6', 'c6d1').body[3], { en: /sixteen nights/, fr: /seize soirs/, es: /dieciséis noches/ }[language]);
  });

  test(`${language}: the finale sends separate Morse beeps for the coded letters`, () => {
    const finale = chapter(language, 'c6').outro;
    assert.match(finale, { en: /tapped out the letters on the brass key/, fr: /bips courts et longs avec la clé morse/, es: /pitidos cortos y largos con la llave/ }[language]);
    assert.doesNotMatch(finale, /held down/);
    const spokenLetters = finale.match(/: ([A-Z](?:[-, ]+[A-Z])+)[.!]/)[1].replace(/[-, ]/g, '');
    const intendedReply = { en: 'VDGDZQXNT', fr: 'NMUNTRDMSDMC', es: 'SDNHLNR' }[language];
    assert.equal(spokenLetters, intendedReply);
  });
}

test('French plan glossary covers Rosa’s idea and the town map', () => {
  assert.match(chapter('fr', 'c1').outro, /Rosa a un plan/);
  assert.match(document('fr', 'c4', 'c4d3').title, /Plan/);
  assert.match(stories.fr.glossary.plan, /plan/);
  assert.match(stories.fr.glossary.plan, /map/);
});

test('Spanish explains that the cipher uses A–Z without Ñ', () => {
  // Spanish has 27 letters; the story's cipher intentionally uses the 26-letter aid.
  // https://www.rae.es/sites/default/files/Principales_novedades_de_la_Ortografia_de_la_lengua_espanola.pdf
  const hint = puzzle('es', 'c6', 'p4').hints[1];
  assert.match(hint, /código usa 26 letras, sin la Ñ/);
  assert.doesNotMatch(hint, /abecedario tiene 26 letras/);
});
