// Large sync journals belong in IndexedDB, separate from the app's small working-copy keys.
// The mirror keeps KidSync's synchronous reads and writes; flush is the durability barrier.
(function (root) {
  'use strict';
  const fail = cause => {
    const error = new Error('Could not preserve this device’s sync journal. Please try again.');
    error.code = 'unavailable'; error.cause = cause; return error;
  };
  const request = value => new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(fail(value.error));
  });
  // Writer receipts share large immutable map payloads. Reloads may keep their
  // provenance without storing another full dungeon collection for each receipt.
  // The latest entries remain readable by older builds; writer slots and receipts
  // use this versioned internal encoding, hydrated before any journal operation.
  const SNAPSHOTS = ['base', 'ui', 'remote', 'local', 'candidate'];
  const PACKED = Symbol('packed journal'), packedEntries = new WeakMap(), packedReceipts = new WeakMap();
  function packRecord(record) {
    const payloads = {...record[PACKED]?.payloads}, interned = new Map(Object.entries(payloads).map(([id,node]) => [JSON.stringify(node),id])), values = new Map();
    let nextPayload = Object.keys(payloads).reduce((max,id)=>Math.max(max,parseInt(id,36)),-1) + 1;
    function encode(value) {
      const text = JSON.stringify(value);
      if(values.has(text)) return values.get(text);
      let node = Array.isArray(value) ? ['a', value.map(encode)]
        : value && typeof value === 'object' ? ['o', Object.entries(value).map(([key, item]) => [key, encode(item)])]
        : ['v', value];
      const encoded = JSON.stringify(node);
      if((typeof value === 'string' && value.length > 128) || encoded.length > 256) {
        let id = interned.get(encoded);
        if(id === undefined) { id = (nextPayload++).toString(36); payloads[id] = node; interned.set(encoded, id); }
        node = ['r', id];
      }
      values.set(text, node); return node;
    }
    function compact(value) {
      if(packedReceipts.has(value)) return packedReceipts.get(value);
      const result = {...value};
      for(const key of SNAPSHOTS) if(result[key] && typeof result[key] === 'object') result[key] = {_journalValue:encode(result[key])};
      if(result.adoption) result.adoption = compact(result.adoption);
      return result;
    }
    function entry(text) {
      if(typeof text !== 'string') return text;
      try { const value = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? JSON.stringify(compact(value)) : text; } catch (_) { return text; }
    }
    const writers = Object.fromEntries(Object.entries(record.writers || {}).map(([owner, slot]) => [owner,
      {...slot, entries:packedEntries.get(slot.entries) || Object.fromEntries(Object.entries(slot.entries || {}).map(([name, text]) => [name, entry(text)]))}]));
    const receipts = Object.fromEntries(Object.entries(record.receipts || {}).map(([id, receipt]) => [id, compact(receipt)]));
    const used = new Set();
    function keep(node) {
      if(node[0] === 'r') { if(!used.has(node[1])) { used.add(node[1]); keep(payloads[node[1]]); } }
      else if(node[0] === 'a') node[1].forEach(keep);
      else if(node[0] === 'o') node[1].forEach(([,value])=>keep(value));
    }
    function scan(value) {
      if(!value || typeof value !== 'object') return;
      if(Object.prototype.hasOwnProperty.call(value,'_journalValue')) keep(value._journalValue);
      else Object.values(value).forEach(scan);
    }
    for(const slot of Object.values(writers)) for(const text of Object.values(slot.entries)) {
      try { scan(JSON.parse(text)); } catch (_) {}
    }
    Object.values(receipts).forEach(scan);
    const {[PACKED]:previous, ...plain} = record;
    return {...plain, compact:1, writers, receipts, payloads:Object.fromEntries([...used].map(id=>[id,payloads[id]]))};
  }
  function unpackRecord(record) {
    if(!record || record.compact !== 1) return record;
    const decoded = new Map();
    function decode(node) {
      if(!Array.isArray(node)) throw fail(new Error('Invalid journal payload.'));
      if(node[0] === 'v') return node[1];
      if(node[0] === 'a') return node[1].map(decode);
      if(node[0] === 'o') return Object.fromEntries(node[1].map(([key, value]) => [key, decode(value)]));
      if(node[0] === 'r') {
        if(!decoded.has(node[1])) decoded.set(node[1], decode(record.payloads[node[1]]));
        return decoded.get(node[1]);
      }
      throw fail(new Error('Invalid journal payload kind.'));
    }
    function expand(value) {
      const result = {...value};
      for(const key of SNAPSHOTS) if(result[key] && Object.prototype.hasOwnProperty.call(result[key], '_journalValue')) result[key] = decode(result[key]._journalValue);
      if(result.adoption) result.adoption = expand(result.adoption);
      return result;
    }
    function entry(text) {
      if(typeof text !== 'string') return text;
      let value; try { value = JSON.parse(text); } catch (_) { return text; }
      return value && typeof value === 'object' && !Array.isArray(value) ? JSON.stringify(expand(value)) : text;
    }
    const writers = Object.fromEntries(Object.entries(record.writers || {}).map(([owner, slot]) => {
      const entries = {};
      for(const [name,text] of Object.entries(slot.entries || {})) {
        let loaded = false, hydrated;
        Object.defineProperty(entries,name,{enumerable:true,get(){ if(!loaded) { hydrated=entry(text); loaded=true; } return hydrated; }});
      }
      packedEntries.set(entries,slot.entries); return [owner,{...slot,entries}];
    }));
    const receipts = Object.fromEntries(Object.entries(record.receipts || {}).map(([id, receipt]) => {
      const result = {};
      for(const [key,value] of Object.entries(receipt)) {
        if(SNAPSHOTS.includes(key) && value && Object.prototype.hasOwnProperty.call(value,'_journalValue')) {
          Object.defineProperty(result,key,{enumerable:true,get:()=>decode(value._journalValue)});
        } else result[key] = value;
      }
      packedReceipts.set(result,receipt); return [id,result];
    }));
    const {payloads, compact, ...rest} = record;
    return {...rest, writers, receipts, [PACKED]:record};
  }
  function rememberReceipt(record, entries) {
    if(packedEntries.has(entries)) return;
    const text = Object.entries(entries || {}).find(([name]) => name.endsWith(':sync'))?.[1];
    let meta; try { meta = JSON.parse(text); } catch (_) { return; }
    if(meta?.adoption?.id) {
      record.receipts = {...record.receipts};
      if(!record.receipts[meta.adoption.id]) record.receipts[meta.adoption.id] = {...meta.adoption, base:meta.base};
    }
  }
  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(fail(transaction.error));
      transaction.onabort = () => reject(fail(transaction.error));
    });
  }
  async function database(factory) {
    let opening;
    // Older adapters replace whole records and cannot safely write writer slots.
    // Upgrading closes their existing connections and prevents a v1 reopen.
    try { opening = factory.open('kidapps-sync-journals', 2); } catch (error) { throw fail(error); }
    opening.onupgradeneeded = () => {
      if (!opening.result.objectStoreNames.contains('journals')) opening.result.createObjectStore('journals');
    };
    return new Promise((resolve, reject) => {
      opening.onsuccess = () => {
        const db = opening.result; db.onversionchange = () => db.close(); resolve(db);
      };
      opening.onerror = () => reject(fail(opening.error));
      opening.onblocked = () => reject(fail(new Error('Another window is using an older sync journal.')));
    });
  }
  async function readRecord(db, id) {
    const transaction = db.transaction('journals', 'readonly'), done = transactionDone(transaction);
    // Observe both promises even if the request fails, to avoid an unhandled abort rejection.
    const [record] = await Promise.all([request(transaction.objectStore('journals').get(id)), done]);
    return unpackRecord(record);
  }
  // Read and update inside one serialized readwrite transaction. A tab only owns
  // its writer slot; a stale mirror can never replace another tab's pending save.
  async function updateRecord(db, id, change) {
    const transaction = db.transaction('journals', 'readwrite'), done = transactionDone(transaction);
    let failure;
    try {
      const store = transaction.objectStore('journals'), reading = store.get(id);
      reading.onsuccess = () => {
        try { store.put(packRecord(change(unpackRecord(reading.result) || {})), id); }
        catch (error) { failure = error; transaction.abort(); }
      };
      reading.onerror = () => { failure = reading.error; };
    } catch (error) { failure = error; transaction.abort(); }
    try { await done; } catch (error) { throw failure ? fail(failure) : error; }
  }
  async function writeRecord(db, id, owner, entries) {
    await updateRecord(db, id, record => {
      const sequence = (record.sequence || 0) + 1, writers = {...record.writers};
      const pendingName = Object.keys(entries).find(name => name.endsWith(':pending'));
      const completed = !entries[pendingName] && mutation(writers[owner]?.entries?.[pendingName]);
      if (completed) for (const [writer, slot] of Object.entries(writers)) {
        if (mutation(slot.entries?.[pendingName]) === completed) writers[writer] = {...slot, entries:{...entries}};
      }
      writers[owner] = {entries, sequence};
      const next = {...record, entries, writers, sequence};
      // Migrate the receipts in existing slots as well as recording the new one.
      for(const slot of Object.values(writers)) rememberReceipt(next, slot.entries);
      return next;
    });
  }
  const mutation = text => { try { return JSON.parse(text).mutation; } catch (_) { return undefined; } };

  async function open(options) {
    const key = options && options.key, namespace = options && options.namespace;
    if (typeof key !== 'string' || !key || typeof namespace !== 'string' || !namespace) throw new Error('Sync storage requires a key and an account namespace.');
    const storage = options.storage === undefined ? root.localStorage : options.storage;
    const factory = options.indexedDB === undefined ? root.indexedDB : options.indexedDB;
    const names = [key + ':sync', key + ':pending'], allowed = name => {
      if (!names.includes(name)) throw new Error('This sync journal cannot access another storage key.');
    };
    if (!factory) {
      return Object.freeze({
        getItem(name) { allowed(name); return storage.getItem(name); },
        setItem(name, value) { allowed(name); storage.setItem(name, value); },
        removeItem(name) { allowed(name); storage.removeItem(name); },
        async flush() {},
      });
    }
    const db = await database(factory), id = JSON.stringify([namespace, key]);
    // A new document always receives a new owner, even when duplicate-tab copied
    // sessionStorage. The hint resumes its predecessor without sharing ownership.
    const owner = options.owner || (root.crypto?.randomUUID ? root.crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));
    let resume = options.resume;
    try { if (!resume) resume = root.sessionStorage?.getItem(id + ':writer'); root.sessionStorage?.setItem(id + ':writer', owner); } catch (_) {}
    let saved;
    try { saved = await readRecord(db, id); } catch (error) { db.close(); throw error; }
    const resumed = saved?.writers?.[resume]?.entries || saved?.entries;
    let migrated = false;
    try { migrated = !!JSON.parse(resumed?.[names[0]]).migrated; } catch (_) {}
    const initialMeta = {base:options.initial, migrated};
    if(options.bootReceipt) initialMeta.adoption = {id:options.bootReceipt, ui:options.initial, remote:options.initial, covered:false};
    const entries = options.fresh ? {
      [names[0]]:JSON.stringify(initialMeta),
      [names[1]]:null,
    } : Object.fromEntries(names.map(name => [name, resumed && typeof resumed[name] === 'string' ? resumed[name] : null]));
    let legacy;
    try { legacy = Object.fromEntries(names.map(name => [name, storage.getItem(name)])); }
    catch (error) { db.close(); throw fail(error); }
    const pendingName = names[1], legacyPending = legacy[pendingName], savedPending = entries[pendingName];
    if (legacyPending && savedPending && legacyPending !== savedPending && (!mutation(legacyPending) || mutation(legacyPending) !== mutation(savedPending))) {
      db.close(); throw fail(new Error('Another window has a different pending save. Let that window finish saving, then try again.'));
    }
    // A legacy pending mutation must be replayed, including after a response was lost.
    // An existing journal wins when both copies identify that same mutation.
    if (!options.fresh && (!saved || (legacyPending && !savedPending))) {
      names.forEach(name => { if (legacy[name] !== null) entries[name] = legacy[name]; });
    }
    try {
      if(options.fresh && Object.values(legacy).some(value => value !== null)) {
        await writeRecord(db, id, owner + ':legacy', {...legacy});
      }
      await writeRecord(db, id, owner, {...entries});
    }
    catch (error) { db.close(); throw error; }
    // A second tab may have changed a legacy entry while IndexedDB was committing it.
    // Never remove that newer value, and never remove anything before the commit.
    names.forEach(name => {
      try { if (legacy[name] !== null && storage.getItem(name) === legacy[name]) storage.removeItem(name); } catch (_) {}
    });

    let revision = 0, persisted = 0, writing = null;
    async function flush() {
      while (persisted < revision) {
        if (!writing) {
          const target = revision, snapshot = {...entries};
          writing = writeRecord(db, id, owner, snapshot).then(() => { persisted = target; }).finally(() => { writing = null; });
        }
        await writing;
      }
    }
    async function pendingRecords() {
      const record = await readRecord(db, id), ownMutation = mutation(entries[pendingName]);
      const found = new Map();
      for (const slot of Object.values(record?.writers || {})) {
        const text = slot.entries?.[pendingName], id = mutation(text);
        if (id && id !== ownMutation && !found.has(id)) found.set(id, JSON.parse(text));
      }
      return [...found.values()];
    }
    async function workingBase(components) {
      const record = await readRecord(db, id), base = {}, receipts = Object.values(record?.receipts || {});
      for (const [field, component] of Object.entries(components)) {
        const receipt = record?.receipts?.[component.adoption];
        const text = record?.writers?.[component.writer]?.entries?.[names[0]];
        const source = receipt?.base || (text ? JSON.parse(text).base : null);
        if (source && Object.prototype.hasOwnProperty.call(source, field)) base[field] = source[field];
        // A successful pending write already includes this writer's displayed
        // intent. Advance only the same origin receipt and a persisted UI sequence
        // that includes that intent; older copies must still receive it once.
        let covered = -1;
        for (const checkpoint of receipts) {
          const ui = checkpoint.receipts?.[field];
          if (!checkpoint.covered || !ui || !component.writer || ui.writer !== component.writer
            || ui.adoption !== component.adoption || !Number.isSafeInteger(ui.sequence)
            || ui.sequence > component.sequence || ui.sequence <= covered) continue;
          if (checkpoint.ui && Object.prototype.hasOwnProperty.call(checkpoint.ui, field)) {
            covered = ui.sequence; base[field] = checkpoint.ui[field];
          }
        }
      }
      return base;
    }
    async function updatePending(mutationId, pending, remote) {
      await updateRecord(db, id, record => {
        const update = entries => {
          if (mutation(entries?.[pendingName]) !== mutationId) return entries;
          const next = {...entries};
          if (pending) next[pendingName] = JSON.stringify(pending);
          else {
            const previous = JSON.parse(entries[pendingName]);
            next[pendingName] = null;
            next[names[0]] = JSON.stringify({base:remote, migrated:true,
              adoption:{id:previous.mutation, ui:previous.ui, remote, covered:true, receipts:previous.receipts}});
          }
          return next;
        };
        const writers = Object.fromEntries(Object.entries(record.writers || {}).map(([writer, slot]) => [writer, {...slot, entries:update(slot.entries)}]));
        const next = {...record, writers, entries:update(record.entries)};
        for(const slot of Object.values(writers)) rememberReceipt(next, slot.entries);
        return next;
      });
    }
    return Object.freeze({
      owner, pendingRecords, updatePending, workingBase,
      getItem(name) { allowed(name); return entries[name]; },
      setItem(name, value) { allowed(name); value = String(value); if (entries[name] !== value) { entries[name] = value; revision++; } },
      removeItem(name) { allowed(name); if (entries[name] !== null) { entries[name] = null; revision++; } },
      flush,
    });
  }
  root.KidSyncStorage = Object.freeze({open});
})(typeof globalThis !== 'undefined' ? globalThis : this);
