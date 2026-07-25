/* Durable-outbox + escaping suite (the client half of score-entry safety).
   Uses the real VoxCore module from public/app-core.js with a fake
   localStorage, talking to a real isolated server instance. */
const { test } = require('node:test');
const assert = require('node:assert');
const VoxCore = require('../public/app-core.js');
const { startServer, api } = require('./helpers');

function fakeStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); },
  };
}

function sendVia(req, session) {
  return async e => {
    const r = await req('POST', '/api/games', { body: e, session });
    if (r.status !== 200) {
      const err = new Error((r.body && r.body.error) || ('error ' + r.status));
      err.status = r.status;
      throw err;
    }
    return r.body;
  };
}

test('failed submission is durably queued, never reported saved-and-discarded', async () => {
  const storage = fakeStorage();
  let network = false; // offline
  const ob = VoxCore.createOutbox({ storage, key: 'ob', send: async e => { if (!network) throw new Error('network'); return { ok: true }; } });
  const q = ob.add({ no: 99, score: 187, strikes: 4, spares: 2, date: '2026-07-09' });
  assert.equal(q.ok, true, 'add() only claims success when the entry persisted');
  assert.ok(q.entry.clientId, 'entry gets a client mutation id');
  assert.equal(ob.size(), 1, 'entry survives in storage');
  // reload from the same storage (simulates app restart) — still queued
  const ob2 = VoxCore.createOutbox({ storage, key: 'ob', send: async () => { throw new Error('network'); } });
  assert.equal(ob2.size(), 1, 'queued score survives a reload');
  const r = await ob2.flush();
  assert.equal(r.sent.length, 0);
  assert.equal(r.kept.length, 1, 'failed flush keeps the entry');
  assert.equal(ob2.size(), 1, 'nothing silently discarded');
  assert.ok(ob2.list()[0].lastError, 'failure reason recorded');
});

test('add() reports failure when local persistence is impossible', () => {
  const broken = { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => {} };
  const ob = VoxCore.createOutbox({ storage: broken, key: 'ob', send: async () => ({}) });
  const q = ob.add({ no: 99, score: 100, date: '2026-07-09' });
  assert.equal(q.ok, false, 'caller must show an accurate retry error, not "saved"');
});

test('retried queued submission creates exactly one server game', async () => {
  const srv = await startServer();
  try {
    const req = api(srv.base);
    const cs = (await req('POST', '/api/coach/verify', { body: { pin: srv.coachPin } })).body.session;
    const tok = (await req('GET', '/api/invites', { coachSession: cs })).body.players.find(p => p.no === 99).token;
    const s99 = (await req('POST', '/api/claim', { body: { token: tok, pin: '1234' } })).body.session;

    const storage = fakeStorage();
    const ob = VoxCore.createOutbox({ storage, key: 'ob', send: sendVia(req, s99) });
    const q = ob.add({ no: 99, score: 154, strikes: 3, spares: 1, date: '2026-07-09' });
    assert.equal(q.ok, true);

    const r1 = await ob.flush();
    assert.equal(r1.sent.length, 1, 'flush delivers the queued game');
    assert.equal(ob.size(), 0, 'delivered entry leaves the outbox');

    // a retry of the same mutation (e.g. response was lost) must not duplicate
    const ob2 = VoxCore.createOutbox({ storage: fakeStorage(), key: 'ob', send: sendVia(req, s99) });
    ob2.add({ no: 99, score: 154, strikes: 3, spares: 1, date: '2026-07-09', clientId: q.entry.clientId });
    const r2 = await ob2.flush();
    assert.equal(r2.sent.length, 1);
    assert.equal(r2.sent[0].duplicate, true, 'server recognises the retry');
    const st = await req('GET', '/api/state', { session: s99 });
    const games = st.body.players.find(p => p.no === 99).games;
    assert.equal(games.length, 1, 'exactly one game despite the retry');
  } finally { await srv.stop(); }
});

test('remove() takes a queued entry out (Undo before sync)', () => {
  const storage = fakeStorage();
  const ob = VoxCore.createOutbox({ storage, key: 'ob', send: async () => ({}) });
  const q = ob.add({ no: 99, score: 120, date: '2026-07-09' });
  assert.equal(ob.size(), 1);
  assert.equal(ob.remove(q.entry.clientId), true);
  assert.equal(ob.size(), 0);
});

test('flush(filter) only sends eligible entries and leaves the rest untouched', async () => {
  const storage = fakeStorage();
  let sentNos = [];
  const ob = VoxCore.createOutbox({ storage, key: 'ob', send: async e => { sentNos.push(e.no); return { ok: true, game: { id: 'g' + e.no } }; } });
  ob.add({ no: 99, score: 100, date: '2026-07-09' }); // current user
  ob.add({ no: 38, score: 120, date: '2026-07-09' }); // a different user's stranded entry
  const r = await ob.flush(e => e.no === 99);
  assert.equal(r.sent.length, 1);
  assert.deepEqual(sentNos, [99], 'only the eligible entry is attempted (no 403 spam for no 38)');
  assert.equal(ob.size(), 1, 'the other user\'s entry is preserved');
  assert.equal(ob.list()[0].no, 38);
});

test('entries added during a flush are not lost', async () => {
  const storage = fakeStorage();
  let release;
  const gate = new Promise(res => { release = res; });
  const ob = VoxCore.createOutbox({ storage, key: 'ob', send: async () => { await gate; return { ok: true }; } });
  ob.add({ no: 99, score: 111, date: '2026-07-09' });
  const flushing = ob.flush();
  ob.add({ no: 99, score: 222, date: '2026-07-09' }); // arrives mid-flush
  release();
  await flushing;
  assert.equal(ob.size(), 1, 'mid-flush addition survives');
  assert.equal(ob.list()[0].score, 222);
});

test('esc() neutralises executable markup from imported/displayed data', () => {
  const { esc, idAttr } = VoxCore;
  const evil = '<img src=x onerror=alert(1)>"\'&';
  const out = esc(evil);
  assert.ok(!out.includes('<') && !out.includes('>'), 'angle brackets escaped');
  assert.ok(!out.includes('"') && !out.includes("'"), 'quotes escaped (attribute-safe)');
  assert.equal(esc('2026-07-09'), '2026-07-09', 'normal dates unchanged');
  assert.equal(idAttr('abc-123_XYZ'), 'abc-123_XYZ', 'safe ids unchanged');
  assert.equal(idAttr("x') ; alert(1)//"), 'xalert1', 'attribute injection stripped from ids');
});

test('team split validation enforces size, gender, cap, and fixed leads', () => {
  const roster = [
    { no: 1, g: 'M', pt: 2 }, { no: 2, g: 'M', pt: 2 }, { no: 3, g: 'M', pt: 2 },
    { no: 4, g: 'F', pt: 2 }, { no: 5, g: 'F', pt: 2 }, { no: 6, g: 'F', pt: 2 },
    { no: 7, g: 'M', pt: 2 }, { no: 8, g: 'M', pt: 2 }, { no: 9, g: 'M', pt: 2 },
    { no: 10, g: 'M', pt: 2 }, { no: 11, g: 'M', pt: 2 }, { no: 12, g: 'M', pt: 2 },
    { no: 13, g: 'M', pt: 2 }, { no: 14, g: 'M', pt: 2 }, { no: 15, g: 'M', pt: 2 },
  ];
  const valid = {
    1: 'A', 2: 'B', 3: 'C', 4: 'A', 5: 'B', 6: 'C',
    7: 'A', 8: 'A', 9: 'A', 10: 'B', 11: 'B', 12: 'B', 13: 'C', 14: 'C', 15: 'C',
  };
  assert.equal(VoxCore.teamSplitError(roster, valid, 25, { A: 1, B: 2, C: 3 }), null);

  const twoWomenInA = { ...valid, 5: 'A', 7: 'B' };
  assert.match(VoxCore.teamSplitError(roster, twoWomenInA, 25, { A: 1, B: 2, C: 3 }), /one woman/i);

  const wrongLead = { ...valid, 1: 'B', 2: 'A' };
  assert.match(VoxCore.teamSplitError(roster, wrongLead, 25, { A: 1, B: 2, C: 3 }), /lead/i);

  assert.match(VoxCore.teamSplitError(roster, valid, 9, { A: 1, B: 2, C: 3 }), /cap/i);
});
