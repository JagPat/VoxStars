/* Test harness: spawns an isolated server per suite.
   - fresh temporary DATA_DIR (never the real ./data or a deployed URL)
   - PORT=0 so the OS picks an unused local port
   - a random test-only coach PIN via the environment
   - always shut down and cleaned up via stop() */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server.js');

function randomPin() { return 'test-' + crypto.randomBytes(8).toString('hex'); }
function tmpDataDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'voxstars-test-')); }

// Never let the outer environment silently rewrite a test's configuration:
// strip every var the server reads before we set the test-only values.
const CONTROLLED_ENV = ['NODE_ENV', 'DATA_DIR', 'PORT', 'COACH_PIN', 'AUTH_SALT', 'TRUST_PROXY',
  'VOX_TEST_SESSION_TTL_MS', 'VOX_TEST_FROZEN_NOW'];
function cleanBaseEnv() {
  const env = { ...process.env };
  for (const k of CONTROLLED_ENV) delete env[k];
  return env;
}

// Start a server; resolves { base, port, dataDir, coachPin, child, stop, stdout, stderr }.
function startServer(opts = {}) {
  const dataDir = opts.dataDir || tmpDataDir();
  const coachPin = opts.coachPin !== undefined ? opts.coachPin : randomPin();
  const env = {
    ...cleanBaseEnv(),
    NODE_ENV: 'test',
    DATA_DIR: dataDir,
    PORT: '0',
    ...(coachPin === null ? {} : { COACH_PIN: coachPin }),
    ...(opts.env || {}),
  };
  if (coachPin === null) delete env.COACH_PIN;
  const args = [];
  if (opts.preload) for (const m of [].concat(opts.preload)) { args.push('-r', m); }
  args.push(SERVER);
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const io = { stdout: '', stderr: '' };
  child.stdout.on('data', d => { io.stdout += d; });
  child.stderr.on('data', d => { io.stderr += d; });

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return; settled = true;
      child.kill('SIGKILL');
      reject(new Error('server did not start in time\nstdout: ' + io.stdout + '\nstderr: ' + io.stderr));
    }, 10000);
    const tryReady = () => {
      const m = io.stdout.match(/running on :(\d+)/);
      if (m && !settled) {
        settled = true; clearTimeout(timer);
        const port = Number(m[1]);
        resolve({
          base: 'http://127.0.0.1:' + port,
          port, dataDir, coachPin, child, io,
          stop: () => stopServer(child, dataDir, opts.keepDataDir),
        });
      }
    };
    child.stdout.on('data', tryReady);
    child.on('exit', code => {
      if (settled) return; settled = true; clearTimeout(timer);
      reject(new Error('server exited early (code ' + code + ')\nstdout: ' + io.stdout + '\nstderr: ' + io.stderr));
    });
  });
}

function stopServer(child, dataDir, keepDataDir) {
  return new Promise(resolve => {
    const done = () => {
      if (!keepDataDir) { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {} }
      resolve();
    };
    if (child.exitCode !== null) return done();
    child.on('exit', done);
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 2000).unref();
  });
}

// Spawn a server expected to fail on startup; resolves { code, stdout, stderr }.
function expectStartupFailure(env = {}) {
  const dataDir = tmpDataDir();
  const child = spawn(process.execPath, [SERVER], {
    env: { ...cleanBaseEnv(), DATA_DIR: dataDir, PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const io = { stdout: '', stderr: '' };
  child.stdout.on('data', d => { io.stdout += d; });
  child.stderr.on('data', d => { io.stderr += d; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('startup-failure server still running')); }, 8000);
    child.on('exit', code => {
      clearTimeout(timer);
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
      resolve({ code, stdout: io.stdout, stderr: io.stderr });
    });
  });
}

// Small JSON API client bound to a base URL.
function api(base) {
  return async (method, p, { body, session, coachSession, headers } = {}) => {
    const h = { 'Content-Type': 'application/json', ...(headers || {}) };
    if (session) h['x-session'] = session;
    if (coachSession) h['x-coach-session'] = coachSession;
    const r = await fetch(base + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    let data = null;
    const text = await r.text();
    try { data = JSON.parse(text); } catch (_) { data = text; }
    return { status: r.status, body: data };
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const legacyPinHash = (pin, salt) => crypto.createHash('sha256').update(String(pin) + ':' + salt).digest('hex');

module.exports = { startServer, expectStartupFailure, api, sleep, tmpDataDir, randomPin, legacyPinHash };
