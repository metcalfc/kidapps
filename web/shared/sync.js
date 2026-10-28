// Durable compare-and-swap saves. Each pending write keeps its mutation ID across
// reloads so a lost response can be replayed without applying practice or a debit twice.
(function (root) {
  'use strict';
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.keys(item).sort().reduce((result, key) => { result[key] = item[key]; return result; }, {}) : item);
  const equal = (a, b) => stable(a) === stable(b);
  const fail = message => { const error = new Error(message); error.code = 'unavailable'; return error; };
  const mutationId = () => root.crypto && typeof root.crypto.randomUUID === 'function' ? root.crypto.randomUUID()
    : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + '-' + Math.random().toString(36).slice(2);

  function create({key, initial, merge, legacy = (_local, remote) => remote}) {
    const metaKey = key + ':sync', pendingKey = key + ':pending';
    const read = name => { try { const value = root.localStorage.getItem(name); return value ? JSON.parse(value) : null; } catch (_) { return null; } };
    const write = (name, value) => {
      try { root.localStorage.setItem(name, JSON.stringify(value)); }
      catch (_) { throw fail('Could not preserve the pending save on this device.'); }
    };
    let meta = read(metaKey) || {base:clone(initial), migrated:false};
    let pending = read(pendingKey);
    // Establish the common base before the app can record any new practice.
    // If storage is temporarily unavailable, writes still require durable storage below.
    try { write(metaKey, meta); } catch (_) {}
    const storeMeta = () => write(metaKey, meta);
    const storePending = value => { write(pendingKey, value); pending = value; };
    const clearPending = () => {
      try { root.localStorage.removeItem(pendingKey); }
      catch (_) { throw fail('Could not finish saving on this device.'); }
      pending = null;
    };
    const confirmed = remote => {
      const next = {base:clone(remote), migrated:true};
      write(metaKey, next); meta = next;
    };
    const unpack = snapshot => snapshot && snapshot.exists ? clone(snapshot.data()) : undefined;
    const tag = snapshot => snapshot && snapshot.exists ? snapshot.metadata && snapshot.metadata.etag : '*';

    function reconcile(local, remote) {
      if (pending || remote === undefined) return clone(local);
      const seed = meta.migrated ? remote : legacy(clone(meta.base), clone(remote));
      const desired = merge(clone(meta.base), clone(local), clone(seed));
      confirmed(remote);
      return desired;
    }

    async function prepare(ref, local, ui) {
      const snapshot = await ref.get(), remote = unpack(snapshot);
      const previousBase = clone(meta.base);
      // Compute without advancing the baseline: until the pending intent is durable,
      // the caller still displays the old local snapshot and must be able to retry it.
      const seed = remote === undefined ? undefined : meta.migrated ? remote : legacy(clone(meta.base), clone(remote));
      const candidate = remote === undefined ? clone(local) : merge(clone(meta.base), clone(local), clone(seed));
      if (remote !== undefined && equal(candidate, remote)) { confirmed(remote); return remote; }
      // For a missing document the first write contains all existing local progress.
      // Keep the original baseline for a race with another device creating the document.
      const record = {mutation:mutationId(), base:remote === undefined ? previousBase : remote,
        local:clone(candidate), ui:clone(ui), kind:'save', candidate:clone(candidate), etag:tag(snapshot)};
      storeMeta(); storePending(record);
      if (remote !== undefined) confirmed(remote);
      return undefined;
    }

    async function commitPending(ref) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const record = pending;
        let snapshot;
        try {
          // Replay exactly what was durably recorded before fetching. The server checks
          // mutation IDs before its ETag, including when the original response was lost.
          snapshot = await ref.commit(clone(record.candidate), {mutation:record.mutation, etag:record.etag});
        } catch (error) {
          if (!error || error.code !== 'conflict') throw error;
          const current = await ref.get(), remote = unpack(current);
          let candidate;
          try { candidate = remote === undefined ? clone(record.local) : merge(clone(record.base), clone(record.local), clone(remote)); }
          catch (mergeError) {
            // A known rejected CAS proves this mutation was not applied. A business
            // conflict can now be discarded; ambiguous network errors never take this path.
            if (mergeError && mergeError.code === 'conflict') {
              confirmed(remote); clearPending(); mergeError.remote = clone(remote);
            }
            throw mergeError;
          }
          storePending({...record, candidate:clone(candidate), etag:tag(current)});
          continue;
        }
        const saved = unpack(snapshot);
        if (saved === undefined) throw fail('The server did not return the saved document.');
        // Persist the confirmed base before deleting the replayable pending record.
        confirmed(saved); clearPending();
        return {saved, record};
      }
      throw fail('The save changed repeatedly. Please try again.');
    }

    async function save(ref, local) {
      // local is the live UI object. Re-read it after each await to preserve practice
      // performed while a request was in flight. Callers serialize save and transact.
      let intent = clone(local), ui = clone(local);
      for (let writeCount = 0; writeCount < 8; writeCount++) {
        if (!pending) {
          const alreadySaved = await prepare(ref, intent, ui);
          if (!pending) {
            const desired = merge(ui, clone(local), alreadySaved);
            if (equal(desired, alreadySaved)) return clone(alreadySaved);
            intent = desired; ui = clone(local); continue;
          }
        }
        const {saved, record} = await commitPending(ref);
        // ui is what the app displayed, including for an unacknowledged transaction.
        // Using record.local here would incorrectly credit an unshown spend back.
        const desired = merge(clone(record.ui), clone(local), clone(saved));
        if (equal(desired, saved)) return clone(saved);
        intent = desired; ui = clone(local);
      }
      throw fail('More local changes are waiting to save. Please try again.');
    }

    async function transact(ref, local, change, result, options = {}) {
      if (options.mutation !== undefined && (typeof options.mutation !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(options.mutation))) {
        const error = new Error('Mutation IDs must be 8 to 128 ASCII letters, digits, periods, underscores, colons or hyphens.'); error.code = 'invalid_argument'; throw error;
      }
      if (pending && pending.kind === 'transaction') {
        const previousResult = clone(pending.result);
        return {state:await save(ref, local), result:previousResult};
      }
      await save(ref, local);
      const snapshot = await ref.get(), remote = unpack(snapshot);
      if (remote === undefined) throw fail('The saved document disappeared. Please try again.');
      confirmed(remote);
      const ui = clone(local), draft = clone(remote);
      let candidate;
      try { const changed = change(draft); candidate = merge(clone(remote), changed === undefined ? draft : changed, clone(remote)); }
      catch (error) { if (error && error.code === 'conflict') error.remote = clone(remote); throw error; }
      storePending({mutation:options.mutation || mutationId(), base:clone(remote), local:clone(candidate), ui,
        kind:'transaction', result:clone(result), candidate:clone(candidate), etag:tag(snapshot)});
      return {state:await save(ref, local), result:clone(result)};
    }

    return Object.freeze({reconcile, save, transact, get hasPending() { return !!pending; }});
  }

  root.KidSync = Object.freeze({create});
})(typeof globalThis !== 'undefined' ? globalThis : this);
