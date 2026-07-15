/* Direct unit tests for the ten-pin scoring engine in public/app-core.js —
   the exact code the browser runs. */
const { test } = require('node:test');
const assert = require('node:assert');
const {
  frameState, frameComplete, rollTxt,
  createScoreEntry, updateScoreEntry, beginScoreSubmission, endScoreSubmission,
  localDate, offlineSessionIdentity, fetchWithTimeout,
} = require('../public/app-core.js');

const rep = (v, n) => Array.from({ length: n }, () => v);

test('perfect game: 12 strikes = 300', () => {
  const fs_ = frameState(rep(10, 12));
  assert.equal(fs_.total, 300);
  assert.equal(fs_.strikes, 12);
  assert.equal(fs_.spares, 0);
  assert.equal(fs_.done, true);
});

test('all spares (5,5) with a 5 bonus = 150', () => {
  const rolls = [...rep(5, 20), 5]; // ten 5+5 frames + one bonus roll
  const fs_ = frameState(rolls);
  assert.equal(fs_.total, 150);
  assert.equal(fs_.spares, 10);
  assert.equal(fs_.strikes, 0);
  assert.equal(fs_.done, true);
});

test('all open frames (3,4) = 70', () => {
  const fs_ = frameState([].concat(...rep([3, 4], 10)));
  assert.equal(fs_.total, 70);
  assert.equal(fs_.strikes, 0);
  assert.equal(fs_.spares, 0);
  assert.equal(fs_.done, true);
});

test('gutter game = 0 and completes after 20 rolls', () => {
  const fs_ = frameState(rep(0, 20));
  assert.equal(fs_.total, 0);
  assert.equal(fs_.done, true);
});

test('strike bonus counts the next two rolls', () => {
  const fs_ = frameState([10, 3, 4]);
  assert.equal(fs_.total, 24); // (10+3+4) + (3+4)
  assert.equal(fs_.strikes, 1);
});

test('spare bonus counts the next roll only', () => {
  const fs_ = frameState([6, 4, 5, 2]);
  assert.equal(fs_.total, 22); // (10+5) + (5+2)
  assert.equal(fs_.spares, 1);
});

test('consecutive strikes chain bonuses (turkey start)', () => {
  const fs_ = frameState([10, 10, 10, 2, 3]);
  // f1=30, f2=22, f3=15, f4=5
  assert.equal(fs_.total, 72);
  assert.equal(fs_.strikes, 3);
});

test('tenth frame: spare then bonus strike', () => {
  const rolls = [...rep(0, 18), 4, 6, 10];
  const fs_ = frameState(rolls);
  assert.equal(fs_.total, 20);
  assert.equal(fs_.spares, 1);
  assert.equal(fs_.strikes, 1, 'bonus strike after a tenth-frame spare counts');
  assert.equal(fs_.done, true);
});

test('tenth frame: strike earns two bonus rolls', () => {
  const rolls = [...rep(0, 18), 10, 3, 4];
  const fs_ = frameState(rolls);
  assert.equal(fs_.total, 17);
  assert.equal(fs_.strikes, 1);
  assert.equal(fs_.done, true);
});

test('tenth frame: open frame ends the game after two rolls', () => {
  const rolls = [...rep(0, 18), 3, 4];
  const fs_ = frameState(rolls);
  assert.equal(fs_.total, 7);
  assert.equal(fs_.done, true);
  const frames = fs_.frames;
  assert.equal(frameComplete(frames, 9), true);
});

test('tenth frame: three strikes counted individually', () => {
  const rolls = [...rep(0, 18), 10, 10, 10];
  const fs_ = frameState(rolls);
  assert.equal(fs_.total, 30);
  assert.equal(fs_.strikes, 3);
  assert.equal(fs_.done, true);
});

test('incomplete game: running total, not done, correct pins remaining', () => {
  let fs_ = frameState([]);
  assert.equal(fs_.total, 0);
  assert.equal(fs_.done, false);
  assert.equal(fs_.remain, 10);
  fs_ = frameState([7]);
  assert.equal(fs_.remain, 3, 'only 3 pins stand after a 7');
  assert.equal(fs_.done, false);
  fs_ = frameState([10]);
  assert.equal(fs_.remain, 10, 'fresh rack after a strike');
  fs_ = frameState([...rep(0, 18), 10, 3]);
  assert.equal(fs_.remain, 7, 'tenth-frame bonus rolls track standing pins');
  assert.equal(fs_.done, false);
});

test('a spare is never scored from a single roll', () => {
  const fs_ = frameState([5, 5, 3]);
  assert.equal(fs_.spares, 1);
  const partial = frameState([5]);
  assert.equal(partial.spares, 0);
  assert.equal(partial.total, 5);
});

test('rollTxt renders X, /, - and pin counts', () => {
  assert.equal(rollTxt([10], 0, 0), 'X');
  assert.equal(rollTxt([7, 3], 1, 0), '/');
  assert.equal(rollTxt([0, 4], 0, 0), '-');
  assert.equal(rollTxt([7, 2], 1, 0), '2');
  assert.equal(rollTxt([10, 10, 10], 1, 9), 'X', 'tenth-frame second strike');
  assert.equal(rollTxt([4, 6, 10], 1, 9), '/', 'tenth-frame spare');
});

test('an explicitly entered gutter score is submittable', () => {
  const untouched = createScoreEntry();
  assert.equal(beginScoreSubmission(untouched, () => 'unused').ok, false, 'untouched form is not a game');
  const entered = updateScoreEntry(untouched, { score: 0 });
  const started = beginScoreSubmission(entered, () => 'gutter-1');
  assert.equal(started.ok, true);
  assert.equal(started.entry.score, 0);
  assert.equal(started.clientId, 'gutter-1');
});

test('score submission is single-flight and reuses its id on retry', () => {
  const entered = updateScoreEntry(createScoreEntry(), { score: 140 });
  const first = beginScoreSubmission(entered, () => 'score-1');
  assert.equal(first.ok, true);
  assert.equal(beginScoreSubmission(first.entry, () => 'score-2').ok, false, 'double tap is ignored while saving');
  assert.equal(updateScoreEntry(first.entry, { score: 141 }).score, 140, 'entry cannot change mid-submit');
  const retry = beginScoreSubmission(endScoreSubmission(first.entry), () => 'score-2');
  assert.equal(retry.ok, true);
  assert.equal(retry.clientId, 'score-1', 'lost-response retry keeps the original id');
  const edited = updateScoreEntry(endScoreSubmission(retry.entry), { score: 141 });
  const changed = beginScoreSubmission(edited, () => 'score-3');
  assert.equal(changed.clientId, 'score-3', 'editing creates a new mutation');
});

test('localDate formats the browser calendar day instead of UTC', () => {
  const localMidnight = new Date(2026, 6, 16, 0, 30, 0);
  assert.equal(localDate(localMidnight), '2026-07-16');
});

test('offline resume requires a session-matching known-player binding', () => {
  const binding = { session: 'session-a', no: 99, isCoach: false };
  assert.deepEqual(offlineSessionIdentity('session-a', binding, [99, 149]), { no: 99, isCoach: false });
  assert.equal(offlineSessionIdentity('session-b', binding, [99, 149]), null, 'another session cannot reuse the binding');
  assert.equal(offlineSessionIdentity('session-a', binding, [149]), null, 'unknown cached player is rejected');
});

test('fetchWithTimeout aborts a stalled request', async () => {
  const stalledFetch = (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    }, { once: true });
  });
  await assert.rejects(
    fetchWithTimeout(stalledFetch, '/api/state', {}, 5),
    err => err && err.name === 'AbortError',
  );
});
