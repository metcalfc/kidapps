/* Conditional save transport for Chain Reaction and Signal. This separate URL also lets an
   already-installed app load the new protocol while its previous service worker is active. */
(function () {
  'use strict';
  function error(code, message) { const e = new Error(message || code); e.code = code; return e; }
  function doc(app, code, name) {
    const url = '/' + app + '/api/saves/' + encodeURIComponent(code) + '/' + encodeURIComponent(name);
    let lastText = null, queue = Promise.resolve();
    function request(method, body, headers) {
      const operation = queue.then(() => performRequest(method, body, headers));
      queue = operation.catch(() => {});
      return operation;
    }
    async function performRequest(method, body, headers) {
      let response;
      const serialized = body === undefined ? undefined : JSON.stringify(body);
      // Fetch keepalive has a small body budget. Larger Forge backups use an
      // ordinary request; durable pending writes still survive closing the app.
      const keepalive = method === 'PUT' && new TextEncoder().encode(serialized).byteLength <= 48 * 1024;
      try {
        response = await fetch(url, { method, cache:'no-store', keepalive,
          headers:headers || {}, body:serialized });
      } catch (_) { throw error('unavailable', 'Could not reach the server.'); }
      if (response.status === 412) throw error('conflict', 'This save changed on another device.');
      if (response.status === 429) throw error('resource_exhausted', 'Please try again in a moment.');
      if (method === 'GET' && response.status === 404) {
        lastText = '';
        return { exists:false, data:() => undefined, metadata:{hasPendingWrites:false, etag:'*', fingerprint:''} };
      }
      if (!response.ok) throw error(response.status === 404 ? 'not_granted' : 'unavailable');
      const text = await response.text(), data = JSON.parse(text);
      const etag = response.headers.get('ETag');
      if (!etag) throw error('unavailable', 'The server has not finished updating.');
      lastText = text;
      return { exists:true, data:() => data, metadata:{hasPendingWrites:false, etag, fingerprint:text} };
    }
    return {
      get:() => request('GET'),
      commit(data, {mutation, etag}) {
        const headers = {'Content-Type':'application/json', 'X-Kidapps-Mutation':mutation};
        headers[etag === '*' ? 'If-None-Match' : 'If-Match'] = etag;
        return request('PUT', data, headers);
      },
      onSnapshot(callback) {
        let stopped = false, timer = 0, delivered = lastText;
        const tick = async () => {
          clearTimeout(timer);
          if (stopped) return;
          if (document.visibilityState === 'visible') {
            try { const snapshot = await request('GET'); if (!stopped && snapshot.metadata.fingerprint !== delivered && callback(snapshot) !== false) delivered = snapshot.metadata.fingerprint; }
            catch (_) { /* An offline device retries when it is visible again. */ }
          }
          if (!stopped) timer = setTimeout(tick, 20000);
        };
        const wake = () => { if (document.visibilityState === 'visible') tick(); };
        document.addEventListener('visibilitychange', wake);
        addEventListener('online', wake); addEventListener('focus', wake);
        timer = setTimeout(tick, 20000);
        return () => {
          stopped = true; clearTimeout(timer);
          document.removeEventListener('visibilitychange', wake);
          removeEventListener('online', wake); removeEventListener('focus', wake);
        };
      },
    };
  }
  window.KidSyncStore = {doc};
})();
