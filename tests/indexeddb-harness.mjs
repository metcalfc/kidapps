import assert from 'node:assert/strict';

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
// IndexedDB readwrite transactions on one object store are serialized. Request
// callbacks run before commit, and can enqueue the conditional put being tested.
export function indexedDB() {
  const records = new Map(), stores = new Set(), held = [], queue = [];
  let active = false;
  const backend = {
    holdWrites:false, failNextWrite:false,
    release() { assert.ok(held.length, 'a transaction must be waiting'); held.shift()(); },
    read(namespace = 'dm:OTTER-4821') { return clone(records.get(JSON.stringify([namespace, 'pda-save']))); },
  };
  const advance = () => {
    if(active || !queue.length) return;
    active = true; const next = queue.shift(); queueMicrotask(next);
  };
  const db = {
    objectStoreNames:{contains:name => stores.has(name)},
    createObjectStore:name => stores.add(name), close() {},
    transaction(_name, mode) {
      const operations = [], staged = new Map(); let stopped = false, begun = false, scheduled = false, processing = false;
      const transaction = {
        objectStore:() => ({
          get(key) { const request = {}; operations.push({kind:'get',key,request}); pump(); return request; },
          put(value, key) { const request = {}; operations.push({kind:'put',key,value:clone(value),request}); pump(); return request; },
        }),
        abort() { if(stopped) return; stopped = true; transaction.error = new Error('aborted'); queueMicrotask(() => { transaction.onabort?.(); active = false; advance(); }); },
      };
      const complete = () => {
        if(stopped) return;
        if(mode === 'readwrite' && backend.failNextWrite) {
          backend.failNextWrite = false; transaction.error = new Error('IndexedDB quota failure'); transaction.abort(); return;
        }
        stopped = true; for(const [key,value] of staged) records.set(key,clone(value));
        transaction.oncomplete?.(); active = false; advance();
      };
      const run = () => {
        scheduled = false; if(stopped) return; processing = true;
        while(operations.length && !stopped) {
          const operation = operations.shift();
          if(operation.kind === 'get') operation.request.result = clone(staged.has(operation.key) ? staged.get(operation.key) : records.get(operation.key));
          else { staged.set(operation.key,clone(operation.value)); operation.request.result = operation.key; }
          operation.request.onsuccess?.();
        }
        processing = false; if(!stopped) mode === 'readwrite' && backend.holdWrites ? held.push(complete) : complete();
      };
      function pump() { if(begun && !scheduled && !processing) { scheduled = true; queueMicrotask(run); } }
      queue.push(() => { begun = true; pump(); }); advance();
      return transaction;
    },
  };
  backend.factory = {open() {
    const request = {result:db};
    queueMicrotask(() => { if(!stores.size) request.onupgradeneeded?.(); request.onsuccess?.(); }); return request;
  }};
  return backend;
}
