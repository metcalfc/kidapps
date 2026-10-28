// Pure three-way merges for saves shared by multiple devices. The server deduplicates
// mutation IDs; this layer combines only the changes since the supplied common base.
(function (root) {
  'use strict';
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
  const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
  const number = (value, fallback = 0) => Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : fallback;
  const keys = (...values) => [...new Set(values.flatMap(value => Object.keys(object(value))))];
  const union = (...arrays) => [...new Set(arrays.flatMap(value => Array.isArray(value) ? value : []))];
  const counter = (base, local, remote, mode) => mode === 'legacy'
    ? Math.max(0, number(local), number(remote))
    : Math.max(0, number(remote, number(base)) + number(local, number(base)) - number(base));
  const retainDays = days => Object.fromEntries(Object.keys(object(days)).sort().slice(-120).map(key => [key, days[key]]));

  function conflict(reason, details) {
    const error = new Error(reason);
    error.code = 'conflict';
    error.details = details;
    throw error;
  }

  // Missing local fields are deletions for settings, but untouched counters use the
  // base value. This keeps a pruned day from subtracting another device's activity.
  function fields(base, local, remote) {
    base = object(base); local = object(local); remote = object(remote);
    const result = clone(remote);
    for (const key of keys(base, local)) {
      if (own(base, key) === own(local, key) && equal(base[key], local[key])) continue;
      if (own(local, key)) result[key] = clone(local[key]); else delete result[key];
    }
    return result;
  }

  function generation(value) { return { at: number(value && value.at), id: String(value && value.id || '') }; }
  function compareGeneration(a, b) {
    a = generation(a); b = generation(b);
    return a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }
  const sameGeneration = (a, b) => compareGeneration(a, b) === 0;
  const latestGeneration = (a, b) => clone(compareGeneration(a, b) >= 0 ? a : b);

  function stampReset(state, language) {
    let id;
    if (root.crypto && typeof root.crypto.randomUUID === 'function') id = root.crypto.randomUUID();
    else if (root.crypto && typeof root.crypto.getRandomValues === 'function') {
      id = Array.from(root.crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16).padStart(8, '0')).join('');
    } else id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + '-' + Math.random().toString(36).slice(2);
    const previous = language === undefined ? state.reset : object(state.resets)[language];
    const value = { at: Math.max(Date.now(), number(previous && previous.at) + 1), id };
    if (language === undefined) state.reset = value;
    else { state.resets = object(state.resets); state.resets[language] = value; }
    return clone(value);
  }

  function meaningful(state) {
    return number(state.bank) !== 0 || number(state.bestChain) > 0 ||
      Object.keys(object(state.days)).length > 0 || Object.keys(object(state.facts)).length > 0 ||
      Object.keys(object(state.chapters)).length > 0 || Object.values(object(state.byLang)).some(p => Object.keys(object(p)).length) ||
      (Array.isArray(state.tickets) && state.tickets.length > 0) || !!object(state.settings).pin || !!object(state.settings).lang;
  }
  function newer(local, remote) {
    if (number(local.updatedAt) !== number(remote.updatedAt)) return number(local.updatedAt) > number(remote.updatedAt) ? local : remote;
    return meaningful(local) && !meaningful(remote) ? local : remote;
  }
  function top(base, local, remote, mode) {
    const result = mode === 'legacy' ? clone(newer(local, remote)) : fields(base, local, remote);
    result.updatedAt = Math.max(number(local.updatedAt), number(remote.updatedAt));
    result.settings = mode === 'legacy' ? clone(object(newer(local, remote).settings)) : fields(base.settings, local.settings, remote.settings);
    return result;
  }

  function dayMap(base, local, remote, names, mode) {
    const result = {};
    for (const day of keys(base, local, remote)) {
      const b = object(base && base[day]), l = object(local && local[day]), r = object(remote && remote[day]);
      const item = fields(b, l, r);
      for (const name of names) item[name] = counter(b[name], l[name], r[name], mode);
      if (own(b, 'bestChain') || own(l, 'bestChain') || own(r, 'bestChain')) item.bestChain = Math.max(number(l.bestChain), number(r.bestChain));
      result[day] = item;
    }
    return retainDays(result);
  }

  function factMap(base, local, remote, mode) {
    const result = {};
    for (const key of keys(base, local, remote)) {
      const b = object(base && base[key]), l = object(local && local[key]), r = object(remote && remote[key]);
      const item = fields(b, l, r);
      item.n = counter(b.n, l.n, r.n, mode);
      item.ok = counter(b.ok, l.ok, r.ok, mode);
      const localNew = Math.max(0, number(l.ok, number(b.ok)) - number(b.ok));
      if (mode === 'legacy') item.ms = number(l.ms) && number(r.ms) ? Math.round((number(l.ms) * number(l.ok) + number(r.ms) * number(r.ok)) / Math.max(1, number(l.ok) + number(r.ok))) : number(l.ms) || number(r.ms);
      else if (!localNew) item.ms = number(r.ms, number(b.ms));
      else if (number(r.ok, number(b.ok)) === number(b.ok) && number(r.ms, number(b.ms)) === number(b.ms)) item.ms = number(l.ms);
      else {
        // ms is an EMA, not raw samples. Weight the new branch approximately;
        // an unchanged local snapshot must never change the remote estimate.
        const remoteCount = number(r.ok, number(b.ok));
        item.ms = Math.round((number(r.ms, number(b.ms)) * remoteCount + number(l.ms) * localNew) / Math.max(1, remoteCount + localNew));
      }
      result[key] = item;
    }
    return result;
  }

  function tickets(local, remote) {
    const result = new Map();
    for (const ticket of [...(Array.isArray(remote) ? remote : []), ...(Array.isArray(local) ? local : [])]) {
      if (!ticket || typeof ticket !== 'object') continue;
      const key = ticket.id === undefined ? JSON.stringify(ticket) : String(ticket.id);
      if (!result.has(key)) result.set(key, clone(ticket));
    }
    return [...result.values()].sort((a, b) => number(a.at) - number(b.at) || String(a.id).localeCompare(String(b.id))).slice(-80);
  }

  function dayCap(day, settings) {
    const match = day.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return Infinity;
    const weekday = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3])).getUTCDay();
    return weekday === 0 || weekday === 6 ? number(settings.weekendCap, 90) : number(settings.weekdayCap, 45);
  }

  function chainMerge(base, local, remote, mode = 'three-way') {
    base = object(base); local = object(local); remote = object(remote);
    if (mode !== 'legacy' && equal(base, local)) return clone(remote);
    const result = top(base, local, remote, mode);
    const generationDiffers = !sameGeneration(local.reset, remote.reset);
    if (generationDiffers) {
      const winner = compareGeneration(local.reset, remote.reset) > 0 ? local : remote;
      for (const name of ['bank', 'bestChain', 'days', 'facts', 'tickets', 'merged']) {
        if (own(winner, name)) result[name] = clone(winner[name]); else delete result[name];
      }
      result.days = retainDays(object(result.days));
      result.tickets = tickets(result.tickets, []);
      result.reset = clone(winner.reset);
      return result;
    }
    if (!sameGeneration(base.reset, local.reset)) base = {};
    result.reset = latestGeneration(local.reset, remote.reset);
    // Without a recorded common base, a newer local timestamp cannot prove an
    // unspent balance: an older client may have kept writing after another device
    // redeemed minutes. Keep the existing server bank; known post-boot changes
    // are applied later by the controller's normal three-way merge.
    result.bank = mode === 'legacy' ? number(own(remote, 'bank') ? remote.bank : local.bank)
      : number(remote.bank, number(base.bank)) + number(local.bank, number(base.bank)) - number(base.bank);
    if (result.bank < 0) conflict('The screen time bank changed on another device. Refresh before cashing in.', { bank: result.bank });
    result.bestChain = Math.max(number(local.bestChain), number(remote.bestChain));
    result.days = dayMap(base.days, local.days, remote.days, ['tries', 'bonusTries', 'correct', 'earned', 'redeemed', 'lightning'], mode);
    result.facts = factMap(base.facts, local.facts, remote.facts, mode);
    result.tickets = tickets(local.tickets, remote.tickets);
    result.merged = union(local.merged, remote.merged);
    if (mode !== 'legacy') {
      for (const [day, item] of Object.entries(result.days)) {
        const localRedeemed = number(local.days && local.days[day] && local.days[day].redeemed);
        const baseRedeemed = number(base.days && base.days[day] && base.days[day].redeemed);
        const cap = dayCap(day, result.settings);
        if (localRedeemed > baseRedeemed && item.redeemed > cap) conflict('The daily screen time limit changed on another device. Refresh before cashing in.', { day, redeemed: item.redeemed, cap });
      }
    }
    return result;
  }

  function puzzleMerge(base, local, remote, mode) {
    base = object(base); local = object(local); remote = object(remote);
    const result = fields(base, local, remote);
    result.tries = counter(base.tries, local.tries, remote.tries, mode);
    const completed = [local, remote].filter(p => p.solved);
    result.solved = completed.length > 0;
    result.first = completed.some(p => p.first);
    if (completed.length) {
      completed.sort((a, b) => number(a.hints) - number(b.hints) || Number(!!b.first) - Number(!!a.first) || number(a.at, Infinity) - number(b.at, Infinity));
      const best = completed[0];
      result.hints = number(best.hints);
      for (const key of ['answer', 'at']) { if (own(best, key)) result[key] = clone(best[key]); else delete result[key]; }
    } else result.hints = Math.max(number(local.hints), number(remote.hints));
    return result;
  }
  function progressMerge(base, local, remote, mode) {
    const result = {};
    for (const ch of keys(base, local, remote)) {
      const b = object(base && base[ch]), l = object(local && local[ch]), r = object(remote && remote[ch]);
      const item = fields(b, l, r);
      item.docs = union(l.docs, r.docs);
      item.done = !!(l.done || r.done);
      const completedAt = [l, r].filter(c => c.done && number(c.doneAt) > 0).map(c => number(c.doneAt));
      if (completedAt.length) item.doneAt = Math.min(...completedAt);
      item.puzzles = {};
      for (const id of keys(b.puzzles, l.puzzles, r.puzzles)) item.puzzles[id] = puzzleMerge(b.puzzles && b.puzzles[id], l.puzzles && l.puzzles[id], r.puzzles && r.puzzles[id], mode);
      result[ch] = item;
    }
    return result;
  }
  function languageProgress(state, language) { return language === 'en' ? object(state.chapters) : object(object(state.byLang)[language]); }
  function signalMerge(base, local, remote, mode = 'three-way') {
    base = object(base); local = object(local); remote = object(remote);
    if (mode !== 'legacy' && equal(base, local)) return clone(remote);
    const result = top(base, local, remote, mode);
    result.byLang = {}; result.resets = {};
    const languages = union(['en'], keys(base.byLang, local.byLang, remote.byLang), keys(base.resets, local.resets, remote.resets));
    for (const language of languages) {
      const bg = object(base.resets)[language], lg = object(local.resets)[language], rg = object(remote.resets)[language];
      const generationValue = latestGeneration(lg, rg);
      if (generationValue) result.resets[language] = generationValue;
      let progress;
      if (!sameGeneration(lg, rg)) progress = clone(languageProgress(compareGeneration(lg, rg) > 0 ? local : remote, language));
      else progress = progressMerge(sameGeneration(bg, lg) ? languageProgress(base, language) : {}, languageProgress(local, language), languageProgress(remote, language), mode);
      if (language === 'en') result.chapters = progress; else result.byLang[language] = progress;
    }
    // Reading-time/day totals span all languages and are not cleared by a language reset.
    result.days = dayMap(base.days, local.days, remote.days, ['secs', 'solved', 'docs'], mode);
    return result;
  }

  root.KidMerge = Object.freeze({
    equal,
    chain: (base, local, remote) => chainMerge(base, local, remote),
    signal: (base, local, remote) => signalMerge(base, local, remote),
    legacy: (app, local, remote) => {
      if (app === 'chain') return chainMerge({}, local, remote, 'legacy');
      if (app === 'signal') return signalMerge({}, local, remote, 'legacy');
      throw new Error('Unknown app: ' + app);
    },
    stampReset,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
