/* VOX STARS shared client core — loaded by public/index.html and unit-tested
   directly in Node (test/scoring.test.js, test/outbox.test.js).
   Contains: HTML escaping, the ten-pin frame scorer, and the durable
   score outbox used for offline-safe score entry. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VoxCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  // ids/tokens rendered into attribute positions: keep only known-safe chars
  function idAttr(s) { return String(s).replace(/[^A-Za-z0-9_-]/g, ''); }

  /* ============ FRAME-BY-FRAME SCORER (real ten-pin math) ============ */
  function frameState(rolls) {
    let frames = [], i = 0, r = rolls.slice();
    for (let f = 0; f < 10 && i < r.length; f++) { if (f < 9) { if (r[i] === 10) { frames.push([10]); i++; } else { frames.push(r.slice(i, i + 2)); i += Math.min(2, r.length - i); } } else { frames.push(r.slice(i)); i = r.length; } }
    let total = 0, strikes = 0, spares = 0; const flat = rolls;
    for (let f = 0, p = 0; f < 10; f++) {
      const fr = frames[f]; if (!fr || fr.length === 0) break;
      if (f < 9) {
        if (fr[0] === 10) { total += 10 + (flat[p + 1] || 0) + (flat[p + 2] || 0); strikes++; p += 1; }
        else if ((fr[0] + (fr[1] || 0)) === 10 && fr.length >= 2) { total += 10 + (flat[p + 2] || 0); spares++; p += 2; }
        else { total += (fr[0] || 0) + (fr[1] || 0); p += fr.length; }
      } else {
        total += fr.reduce((x, y) => x + y, 0);
        const a0 = fr[0], b0 = (fr[1] == null ? null : fr[1]), c0 = (fr[2] == null ? null : fr[2]);
        if (a0 === 10) { strikes++; if (b0 === 10) { strikes++; if (c0 === 10) strikes++; } else if (b0 != null && c0 != null && b0 + c0 === 10) spares++; }
        else if (b0 != null && a0 + b0 === 10) { spares++; if (c0 === 10) strikes++; }
      }
    }
    let curFrame = frames.length ? frames[frames.length - 1] : [], fIdx = frames.length - 1, remain = 10;
    const lastComplete = frameComplete(frames, fIdx);
    if (fIdx < 0 || lastComplete) remain = 10;
    else if (fIdx < 9) remain = curFrame[0] === 10 ? 10 : (10 - (curFrame[0] || 0));
    else { const a = curFrame[0], b = curFrame[1]; if (curFrame.length === 1) remain = a === 10 ? 10 : (10 - a); else if (curFrame.length === 2) remain = (a === 10) ? (b === 10 ? 10 : (10 - b)) : 10; }
    const done = frames.length === 10 && frameComplete(frames, 9);
    return { frames, total, strikes, spares, remain, done };
  }
  function frameComplete(frames, f) { if (f < 0 || !frames[f]) return false; const fr = frames[f]; if (f < 9) return fr[0] === 10 || fr.length >= 2; if (fr[0] === 10 || (fr[0] + (fr[1] || 0) === 10)) return fr.length >= 3; return fr.length >= 2; }
  function rollTxt(fr, i, fnum) {
    if (!fr || fr[i] === undefined) return '';
    const v = fr[i];
    if (fnum < 9) { if (i === 0 && v === 10) return 'X'; if (i === 1 && (fr[0] + v === 10)) return '/'; return v === 0 ? '-' : String(v); }
    if (v === 10) return 'X'; if (i > 0 && fr[i - 1] !== 10 && (fr[i - 1] + v === 10)) return '/'; return v === 0 ? '-' : String(v);
  }

  /* ============ DURABLE SCORE OUTBOX ============
     A score that can't reach the server is persisted locally with a client
     mutation id, shown as "Queued — not yet synced", and retried after
     reconnect. The server dedupes on clientId so retries can't duplicate. */
  function uuid() {
    try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
    return 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }

  function createScoreEntry() {
    return { score: 0, strikes: 0, spares: 0, entered: false, clientId: null, submitting: false };
  }
  function updateScoreEntry(entry, patch) {
    if (entry && entry.submitting) return entry;
    return Object.assign({}, entry || createScoreEntry(), patch || {}, {
      entered: true,
      clientId: null,
      submitting: false,
    });
  }
  function beginScoreSubmission(entry, makeId) {
    if (!entry || !entry.entered || entry.submitting) return { ok: false, entry };
    const next = Object.assign({}, entry, {
      clientId: entry.clientId || makeId(),
      submitting: true,
    });
    return { ok: true, entry: next, clientId: next.clientId };
  }
  function endScoreSubmission(entry) {
    return Object.assign({}, entry || createScoreEntry(), { submitting: false });
  }
  function localDate(date) {
    const d = date || new Date();
    const pad = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function offlineSessionIdentity(session, binding, knownNos) {
    if (!session || !binding || binding.session !== session || !Array.isArray(knownNos)) return null;
    const no = Number(binding.no);
    if (!knownNos.some(x => Number(x) === no)) return null;
    return { no, isCoach: binding.isCoach === true };
  }
  async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
    const controller = new AbortController();
    const timeout = Math.max(1, Number(timeoutMs) || 10000);
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      return await fetchImpl(url, Object.assign({}, options || {}, { signal: controller.signal }));
    } finally {
      clearTimeout(timer);
    }
  }

  function createOutbox(opts) {
    const storage = opts.storage, key = opts.key, send = opts.send;
    let busy = false;
    function read() { try { const d = JSON.parse(storage.getItem(key)); return Array.isArray(d) ? d : []; } catch (e) { return []; } }
    function write(list) { try { storage.setItem(key, JSON.stringify(list)); return true; } catch (e) { return false; } }
    return {
      newClientId: uuid,
      list: read,
      size: () => read().length,
      // returns { ok:true, entry } only once the entry is durably queued;
      // { ok:false } means the caller must NOT claim the score was saved/queued
      add(entry) {
        const e = Object.assign({}, entry, { clientId: entry.clientId || uuid(), queuedAt: entry.queuedAt || Date.now() });
        const list = read();
        if (list.some(x => x.clientId === e.clientId)) return { ok: true, entry: e };
        list.push(e);
        return write(list) ? { ok: true, entry: e } : { ok: false };
      },
      remove(clientId) {
        const list = read();
        const next = list.filter(x => x.clientId !== clientId);
        if (next.length === list.length) return false;
        return write(next);
      },
      // retry entries matching `filter` (default all); entries are removed only
      // on server-confirmed success, failures are kept (never silently discarded)
      // with the last error noted, and non-eligible entries are left untouched
      async flush(filter) {
        if (busy) return { sent: [], kept: [] };
        busy = true;
        try {
          const eligible = read().filter(e => !filter || filter(e));
          if (!eligible.length) return { sent: [], kept: [] };
          const sent = [], keptMeta = {};
          for (const e of eligible) {
            try { const r = await send(e); sent.push({ entry: e, game: r && r.game, duplicate: !!(r && r.duplicate) }); }
            catch (err) { keptMeta[e.clientId] = { tries: (e.tries || 0) + 1, lastError: (err && err.message) || 'network' }; }
          }
          const sentIds = new Set(sent.map(s => s.entry.clientId));
          // re-read so entries queued mid-flush and non-eligible entries survive
          const next = read().filter(e => !sentIds.has(e.clientId))
            .map(e => keptMeta[e.clientId] ? Object.assign({}, e, keptMeta[e.clientId]) : e);
          write(next);
          return { sent, kept: eligible.filter(e => keptMeta[e.clientId]) };
        } finally { busy = false; }
      },
    };
  }

  return {
    esc, idAttr, frameState, frameComplete, rollTxt, createOutbox, uuid,
    createScoreEntry, updateScoreEntry, beginScoreSubmission, endScoreSubmission,
    localDate, offlineSessionIdentity, fetchWithTimeout,
  };
});
