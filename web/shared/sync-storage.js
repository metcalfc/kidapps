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
  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(fail(transaction.error));
      transaction.onabort = () => reject(fail(transaction.error));
    });
  }
  async function database(factory) {
    let opening;
    try { opening = factory.open('kidapps-sync-journals', 1); } catch (error) { throw fail(error); }
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
    return record;
  }
  async function writeRecord(db, id, entries) {
    const transaction = db.transaction('journals', 'readwrite'), done = transactionDone(transaction);
    try { transaction.objectStore('journals').put({entries}, id); }
    catch (error) { transaction.abort(); await done.catch(() => {}); throw fail(error); }
    await done;
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
    let saved;
    try { saved = await readRecord(db, id); } catch (error) { db.close(); throw error; }
    const entries = Object.fromEntries(names.map(name => [name, saved && saved.entries && typeof saved.entries[name] === 'string' ? saved.entries[name] : null]));
    let legacy;
    try { legacy = Object.fromEntries(names.map(name => [name, storage.getItem(name)])); }
    catch (error) { db.close(); throw fail(error); }
    const pendingName = names[1], legacyPending = legacy[pendingName], savedPending = entries[pendingName];
    if (legacyPending && savedPending && legacyPending !== savedPending && (!mutation(legacyPending) || mutation(legacyPending) !== mutation(savedPending))) {
      db.close(); throw fail(new Error('Another window has a different pending save. Let that window finish saving, then try again.'));
    }
    // A legacy pending mutation must be replayed, including after a response was lost.
    // An existing journal wins when both copies identify that same mutation.
    if (!saved || (legacyPending && !savedPending)) {
      names.forEach(name => { if (legacy[name] !== null) entries[name] = legacy[name]; });
    }
    try { await writeRecord(db, id, {...entries}); }
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
          writing = writeRecord(db, id, snapshot).then(() => { persisted = target; }).finally(() => { writing = null; });
        }
        await writing;
      }
    }
    return Object.freeze({
      getItem(name) { allowed(name); return entries[name]; },
      setItem(name, value) { allowed(name); value = String(value); if (entries[name] !== value) { entries[name] = value; revision++; } },
      removeItem(name) { allowed(name); if (entries[name] !== null) { entries[name] = null; revision++; } },
      flush,
    });
  }
  root.KidSyncStorage = Object.freeze({open});
})(typeof globalThis !== 'undefined' ? globalThis : this);
