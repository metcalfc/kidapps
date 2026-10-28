import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

const context = vm.createContext({ crypto: { randomUUID } });
vm.runInContext(readFileSync(new URL('../web/shared/merge.js', import.meta.url), 'utf8'), context);
const merge = context.KidMerge;
const copy = value => JSON.parse(JSON.stringify(value));
const plain = value => copy(value);
const day = '2026-10-30'; // Friday, a school day.
const chain = () => ({ v: 1, updatedAt: 1, bank: 0, bestChain: 0, days: {}, facts: {}, tickets: [], merged: [], settings: { tries: 100, weekdayCap: 45, weekendCap: 90, sound: true } });
const signal = () => ({ v: 1, updatedAt: 1, settings: { sound: true, lang: 'en' }, chapters: {}, byLang: {}, days: {} });
const savedChapter = (puzzles = {}) => ({ docs: [], done: false, puzzles });
const solved = (overrides = {}) => ({ solved: true, tries: 1, hints: 0, first: true, answer: 'ANSWER', at: 10, ...overrides });

test('stable equality ignores object key order while preserving array order and values', () => {
  assert.equal(merge.equal({ a: 1, nested: { b: 2, c: 3 } }, { nested: { c: 3, b: 2 }, a: 1 }), true);
  assert.equal(merge.equal({ ids: ['a', 'b'] }, { ids: ['b', 'a'] }), false);
  assert.equal(merge.equal({ amount: 1 }, { amount: '1' }), false);
  assert.equal(merge.equal({ value: null }, {}), false);
});

test('unchanged local snapshots return a clone of remote without manufacturing default fields', () => {
  for (const app of ['chain', 'signal']) {
    const base = app === 'chain' ? chain() : signal();
    const local = Object.fromEntries(Object.entries(copy(base)).reverse());
    const remote = app === 'chain'
      ? { bank: 40, days: { [day]: { tries: 12 } }, facts: { '2x3': { n: 2, ok: 1, ms: 900 } }, tickets: [], settings: { sound: false } }
      : { chapters: { c1: { docs: ['d3', 'd1'], puzzles: { p1: solved() } } }, byLang: {}, days: { [day]: { secs: 40 } }, settings: { sound: false } };
    const result = merge[app](base, local, remote);
    assert.deepEqual(plain(result), remote);
    result.settings.sound = true;
    assert.equal(remote.settings.sound, false);
  }
});

test('Chain adds only branch deltas, including independent 30- and 45-second credits', () => {
  const base = chain();
  base.bank = 100;
  base.days[day] = { tries: 10, bonusTries: 0, earned: 100, correct: 8, redeemed: 0, bestChain: 4, lightning: 2 };
  base.facts['3x4'] = { n: 10, ok: 8, ms: 2000 };
  const local = copy(base), remote = copy(base);
  local.bank += 30; remote.bank += 45;
  local.days[day].earned += 30; remote.days[day].earned += 45;
  local.days[day].tries += 3; remote.days[day].tries += 4;
  local.days[day].bonusTries += 10; remote.days[day].bonusTries += 20;
  local.days[day].bestChain = 6; remote.days[day].bestChain = 7;
  local.facts['3x4'].n += 3; remote.facts['3x4'].n += 4;
  local.facts['3x4'].ok += 3; remote.facts['3x4'].ok += 4;
  local.bestChain = 6; remote.bestChain = 7;
  const result = merge.chain(base, local, remote);
  assert.equal(result.bank, 175);
  assert.equal(result.days[day].earned, 175);
  assert.equal(result.days[day].tries, 17);
  assert.equal(result.days[day].bonusTries, 30);
  assert.equal(result.days[day].bestChain, 7);
  assert.equal(result.facts['3x4'].n, 17);
  assert.equal(result.facts['3x4'].ok, 15);
  assert.equal(result.bestChain, 7);
});

test('a confirmed spend is deducted once and its ticket is retained once', () => {
  const base = chain(); base.bank = 600;
  base.days[day] = { redeemed: 0 };
  const local = copy(base), remote = copy(base);
  local.bank -= 300; local.days[day].redeemed = 5;
  local.tickets.push({ id: 'ticket-a', at: 1, min: 5 });
  const result = merge.chain(base, local, remote);
  assert.equal(result.bank, 300);
  assert.equal(result.days[day].redeemed, 5);
  const unchanged = merge.chain(local, local, result);
  assert.equal(unchanged.bank, 300);
  assert.equal(unchanged.days[day].redeemed, 5);
  assert.equal(unchanged.tickets.length, 1);
});

test('independent affordable spends combine before retaining the newest tickets', () => {
  const base = chain(); base.bank = 600;
  const local = copy(base), remote = copy(base);
  local.bank = remote.bank = 300;
  local.days[day] = remote.days[day] = { redeemed: 5 };
  remote.tickets = Array.from({ length: 80 }, (_, i) => ({ id: `old-${i}`, at: i, min: 5 }));
  local.tickets = [{ id: 'local', at: 100, min: 5 }, copy(remote.tickets[0])];
  const result = merge.chain(base, local, remote);
  assert.equal(result.bank, 0);
  assert.equal(result.days[day].redeemed, 10);
  assert.equal(result.tickets.length, 80);
  assert.equal(new Set(result.tickets.map(t => t.id)).size, 80);
  assert.ok(result.tickets.some(t => t.id === 'local'));
  assert.equal(result.tickets.some(t => t.id === 'old-0'), false);
});

test('ticket retention deduplicates before keeping both devices’ recent receipts', () => {
  const base = chain(), local = copy(base), remote = copy(base);
  const history = Array.from({ length: 80 }, (_, i) => ({ id: `ticket-${i}`, at: i, min: 5 }));
  local.tickets = [...copy(history), { id: 'new-local', at: 100, min: 5 }];
  remote.tickets = [...copy(history), { id: 'new-remote', at: 101, min: 5 }];
  for (const result of [merge.chain(base, local, remote), merge.legacy('chain', local, remote)]) {
    assert.equal(result.tickets.length, 80);
    assert.ok(result.tickets.some(t => t.id === 'new-local'));
    assert.ok(result.tickets.some(t => t.id === 'new-remote'));
    assert.equal(result.tickets.some(t => t.id === 'ticket-0'), false);
    assert.equal(result.tickets.some(t => t.id === 'ticket-1'), false);
  }
});

test('both apps retain the latest 120 day keys after merging old and concurrent history', () => {
  const dates = Array.from({ length: 140 }, (_, i) => new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10));
  for (const app of ['chain', 'signal']) {
    const base = app === 'chain' ? chain() : signal(), local = copy(base), remote = copy(base);
    const field = app === 'chain' ? 'tries' : 'secs';
    for (const key of dates.slice(0, 130)) base.days[key] = { [field]: 1 };
    local.days = copy(base.days); remote.days = copy(base.days);
    local.days[dates[139]] = { [field]: 3 }; remote.days[dates[138]] = { [field]: 4 };
    local.days[dates[129]][field] += 2; remote.days[dates[129]][field] += 3;
    const result = merge[app](base, local, remote);
    assert.equal(Object.keys(result.days).length, 120);
    assert.equal(result.days[dates[0]], undefined);
    assert.equal(result.days[dates[139]][field], 3);
    assert.equal(result.days[dates[138]][field], 4);
    assert.equal(result.days[dates[129]][field], 6);
    assert.equal(Object.keys(merge.legacy(app, local, remote).days).length, 120);
  }
});

test('a winning Chain reset also bounds retained history from its generation', () => {
  const base = chain(), local = chain(), remote = chain();
  local.reset = { at: 2, id: 'new' }; remote.reset = { at: 1, id: 'old' };
  for (let i = 0; i < 140; i++) local.days[new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10)] = { tries: 1 };
  local.tickets = Array.from({ length: 100 }, (_, i) => ({ id: `ticket-${i}`, at: i, min: 5 }));
  const result = merge.chain(base, local, remote);
  assert.equal(Object.keys(result.days).length, 120);
  assert.equal(result.tickets.length, 80);
  assert.equal(result.tickets[0].id, 'ticket-20');
  assert.equal(result.tickets.at(-1).id, 'ticket-99');
});

test('concurrent overspending conflicts instead of creating a negative bank', () => {
  const base = chain(); base.bank = 600;
  const local = copy(base), remote = copy(base);
  local.bank = remote.bank = 0;
  assert.throws(() => merge.chain(base, local, remote), error => error.code === 'conflict' && error.details.bank === -600);
});

test('concurrent redemption respects weekday and weekend limits', () => {
  for (const [key, each] of [['2026-10-30', 25], ['2026-10-31', 50]]) {
    const base = chain(); base.bank = 12000;
    const local = copy(base), remote = copy(base);
    local.bank -= each * 60; remote.bank -= each * 60;
    local.days[key] = { redeemed: each }; remote.days[key] = { redeemed: each };
    assert.throws(() => merge.chain(base, local, remote), error => error.code === 'conflict' && error.details.day === key);
  }
});

test('unchanged local settings preserve remote changes; explicit local edits win', () => {
  const base = chain(); base.settings.pin = '1111';
  const local = copy(base), remote = copy(base);
  local.settings.sound = false;
  remote.settings.weekdayCap = 60; remote.settings.pin = '2222';
  const result = merge.chain(base, local, remote);
  assert.equal(result.settings.weekdayCap, 60);
  assert.equal(result.settings.pin, '2222');
  assert.equal(result.settings.sound, false);
  local.settings.pin = '3333';
  assert.equal(merge.chain(base, local, remote).settings.pin, '3333');
  delete local.settings.pin;
  assert.equal(Object.hasOwn(merge.chain(base, local, remote).settings, 'pin'), false);
});

test('fact timing is untouched without new local correct answers', () => {
  const base = chain(); base.facts['4x5'] = { n: 10, ok: 8, ms: 2000 };
  const local = copy(base), remote = copy(base);
  remote.facts['4x5'] = { n: 11, ok: 9, ms: 1900 };
  local.settings.sound = false;
  assert.equal(merge.chain(base, local, remote).facts['4x5'].ms, 1900);
  local.facts['4x5'] = { n: 11, ok: 9, ms: 1800 };
  assert.equal(merge.chain(base, local, base).facts['4x5'].ms, 1800);
  const estimate = merge.chain(base, local, remote).facts['4x5'].ms;
  assert.ok(estimate >= 1800 && estimate <= 1900);
});

test('an omitted pruned day does not subtract another device’s counters', () => {
  const base = chain(); base.days[day] = { tries: 10, earned: 100 };
  const local = copy(base), remote = copy(base);
  delete local.days[day]; remote.days[day].tries = 12;
  const result = merge.chain(base, local, remote);
  assert.equal(result.days[day].tries, 12);
  assert.equal(result.days[day].earned, 100);
});

test('legacy Chain migration keeps an existing server bank and never doubles identical counters', () => {
  const old = chain(); old.updatedAt = 10; old.bank = 600;
  old.days[day] = { tries: 10, earned: 600, redeemed: 0 };
  old.facts['2x3'] = { n: 10, ok: 10, ms: 2000 };
  const same = merge.legacy('chain', old, copy(old));
  assert.equal(same.bank, 600);
  assert.equal(same.days[day].tries, 10);
  assert.equal(same.facts['2x3'].n, 10);
  const newer = copy(old); newer.updatedAt = 20; newer.bank = 300; newer.settings.sound = false;
  newer.merged = ['imported-game'];
  const imported = merge.legacy('chain', newer, old);
  assert.equal(imported.bank, 600);
  assert.equal(imported.settings.sound, false);
  assert.equal(merge.legacy('chain', imported, imported).bank, 600);
  assert.deepEqual(plain(imported.merged), ['imported-game']);
});

test('a newer stale legacy timestamp cannot restore minutes already redeemed on the server', () => {
  const local = chain(); local.updatedAt = 20; local.bank = 616;
  const remote = chain(); remote.updatedAt = 10; remote.bank = 16;
  remote.days[day] = { redeemed: 10 };
  remote.tickets.push({ id: 'already-redeemed', at: 10, min: 10 });
  const migrated = merge.legacy('chain', local, remote);
  assert.equal(migrated.bank, 16);
  assert.equal(migrated.days[day].redeemed, 10);
  assert.equal(migrated.tickets[0].id, 'already-redeemed');
  const afterBootPractice = copy(local); afterBootPractice.bank += 30;
  assert.equal(merge.chain(local, afterBootPractice, migrated).bank, 46);
});

test('legacy bank policy preserves zero balances, matching balances, and local-only saves', () => {
  const local = chain(); local.updatedAt = 20; local.bank = 600;
  const remote = chain(); remote.updatedAt = 10;
  assert.equal(merge.legacy('chain', local, remote).bank, 0);
  remote.bank = 600;
  assert.equal(merge.legacy('chain', local, remote).bank, 600);
  assert.equal(merge.legacy('chain', local, undefined).bank, 600);
});

test('fresh local defaults cannot replace an existing legacy bank or settings', () => {
  const local = chain(); local.updatedAt = 0;
  const remote = chain(); remote.updatedAt = 100; remote.bank = 700; remote.settings.pin = '1234'; remote.settings.tries = 150;
  const result = merge.legacy('chain', local, remote);
  assert.equal(result.bank, 700);
  assert.equal(result.settings.pin, '1234');
  assert.equal(result.settings.tries, 150);
});

test('a newer Chain reset discards the entire old progress generation in either direction', () => {
  const base = chain(); base.bank = 600; base.reset = { at: 1, id: 'old' };
  const reset = chain(); reset.reset = { at: 2, id: 'new' };
  const stale = copy(base); stale.bank += 300; stale.days[day] = { tries: 5 }; stale.tickets.push({ id: 'stale', min: 5 });
  for (const [local, remote] of [[reset, stale], [stale, reset]]) {
    const result = merge.chain(base, local, remote);
    assert.equal(result.bank, 0);
    assert.deepEqual(plain(result.days), {});
    assert.deepEqual(plain(result.tickets), []);
    assert.deepEqual(plain(result.reset), reset.reset);
  }
});

test('post-reset branches share a zero base instead of subtracting the previous generation', () => {
  const base = chain(); base.bank = 600; base.reset = { at: 1, id: 'old' };
  const local = chain(), remote = chain();
  local.reset = remote.reset = { at: 2, id: 'new' };
  local.bank = 30; remote.bank = 45;
  assert.equal(merge.chain(base, local, remote).bank, 75);
});

test('Signal unions independent documents and puzzles while preserving the best completion', () => {
  const base = signal();
  base.chapters.c1 = savedChapter({ p1: { solved: false, tries: 1, hints: 0, first: false } });
  base.chapters.c1.docs = ['d1'];
  base.days[day] = { secs: 10, docs: 1, solved: 0 };
  const local = copy(base), remote = copy(base);
  local.chapters.c1.docs.push('d2'); remote.chapters.c1.docs.push('d3');
  local.chapters.c1.puzzles.p1 = solved({ tries: 2, hints: 1, first: false, at: 11, answer: 'LOCAL' });
  remote.chapters.c1.puzzles.p1 = solved({ tries: 2, hints: 0, first: true, at: 12, answer: 'REMOTE' });
  local.chapters.c1.puzzles.p2 = solved(); remote.chapters.c1.puzzles.p3 = solved();
  local.days[day] = { secs: 40, docs: 2, solved: 1 }; remote.days[day] = { secs: 55, docs: 2, solved: 1 };
  const result = merge.signal(base, local, remote);
  assert.deepEqual(new Set(result.chapters.c1.docs), new Set(['d1', 'd2', 'd3']));
  assert.equal(Object.keys(result.chapters.c1.puzzles).length, 3);
  const p1 = result.chapters.c1.puzzles.p1;
  assert.equal(p1.tries, 3);
  assert.equal(p1.solved, true);
  assert.equal(p1.hints, 0);
  assert.equal(p1.first, true);
  assert.equal(p1.answer, 'REMOTE');
  assert.equal(result.days[day].secs, 85);
  assert.equal(result.days[day].docs, 3);
  assert.equal(result.days[day].solved, 2);
});

test('Signal languages merge independently and preserve an existing chapter completion', () => {
  const base = signal(), local = copy(base), remote = copy(base);
  local.chapters.c1 = savedChapter({ p1: solved() });
  local.byLang.fr = { c1: savedChapter({ p1: solved() }) };
  remote.byLang.es = { c1: { ...savedChapter({ p1: solved() }), done: true, doneAt: 50 } };
  const result = merge.signal(base, local, remote);
  assert.equal(result.chapters.c1.puzzles.p1.solved, true);
  assert.equal(result.byLang.fr.c1.puzzles.p1.solved, true);
  assert.equal(result.byLang.es.c1.done, true);
  assert.equal(result.byLang.es.c1.doneAt, 50);
});

test('a Signal reset affects only its language and keeps shared reading-day totals', () => {
  const base = signal(); base.resets = { fr: { at: 1, id: 'old' } };
  base.byLang.fr = { c1: savedChapter({ p1: solved() }) };
  base.days[day] = { secs: 10, solved: 1, docs: 1 };
  const local = copy(base), remote = copy(base);
  local.byLang.fr = {}; local.resets.fr = { at: 2, id: 'reset' };
  remote.byLang.fr.c1.puzzles.p2 = solved();
  remote.byLang.es = { c1: savedChapter({ p1: solved() }) };
  remote.days[day].secs += 20;
  const result = merge.signal(base, local, remote);
  assert.deepEqual(plain(result.byLang.fr), {});
  assert.equal(result.byLang.es.c1.puzzles.p1.solved, true);
  assert.equal(result.days[day].secs, 30);
  assert.deepEqual(plain(merge.signal(base, remote, local).byLang.fr), {});
});

test('legacy Signal migration unions progress using maximum unknown-baseline counters', () => {
  const local = signal(), remote = signal();
  local.chapters.c1 = savedChapter({ p1: solved({ tries: 5 }) });
  remote.chapters.c1 = savedChapter({ p1: solved({ tries: 5 }), p2: solved() });
  local.days[day] = remote.days[day] = { secs: 30, docs: 2, solved: 1 };
  remote.updatedAt = 10; remote.settings.sound = false;
  const result = merge.legacy('signal', local, remote);
  assert.equal(result.chapters.c1.puzzles.p1.tries, 5);
  assert.equal(result.chapters.c1.puzzles.p2.solved, true);
  assert.equal(result.days[day].secs, 30);
  assert.equal(result.settings.sound, false);
});

test('an unchanged baseline does not add Signal attempts or reading time again', () => {
  const base = signal(); base.chapters.c1 = savedChapter({ p1: solved({ tries: 3 }) });
  base.days[day] = { secs: 10, docs: 1, solved: 1 };
  const remote = copy(base); remote.days[day].secs = 40; remote.chapters.c1.puzzles.p1.tries = 4;
  const result = merge.signal(base, base, remote);
  assert.equal(result.chapters.c1.puzzles.p1.tries, 4);
  assert.equal(result.days[day].secs, 40);
});

test('reset stamps identify independent resets without changing unrelated state', () => {
  const state = signal(); state.chapters.c1 = savedChapter({ p1: solved() });
  const first = merge.stampReset(state, 'fr'), second = merge.stampReset(state, 'es');
  assert.notEqual(first.id, second.id);
  assert.ok(Number.isFinite(first.at));
  assert.deepEqual(plain(state.resets.fr), plain(first));
  assert.equal(state.chapters.c1.puzzles.p1.solved, true);
  const chainState = chain(); merge.stampReset(chainState);
  assert.ok(chainState.reset.id);
  assert.equal(chainState.resets, undefined);
});

test('all merge entry points leave input snapshots untouched and return JSON-serializable state', () => {
  for (const app of ['chain', 'signal']) {
    const base = app === 'chain' ? chain() : signal(), local = copy(base), remote = copy(base);
    const before = JSON.stringify([base, local, remote]);
    const result = merge[app](base, local, remote);
    merge.legacy(app, local, remote);
    assert.equal(JSON.stringify([base, local, remote]), before);
    assert.doesNotThrow(() => JSON.stringify(result));
    result.settings.sound = false;
    assert.equal(local.settings.sound, true);
    assert.equal(remote.settings.sound, true);
  }
});


test('reset generations advance beyond a previously observed future clock stamp', () => {
  for (const language of [undefined, 'fr']) {
    const state = language === undefined ? chain() : signal();
    const previous = {at:Date.now() + 60000, id:'previous'};
    if (language === undefined) state.reset = previous; else state.resets = {[language]:previous};
    const first = merge.stampReset(state, language), second = merge.stampReset(state, language);
    assert.equal(first.at, previous.at + 1); assert.equal(second.at, first.at + 1);
  }
});
