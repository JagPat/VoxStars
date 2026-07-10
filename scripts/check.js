#!/usr/bin/env node
/* Lightweight syntax check (npm run check) for the server, the shared client
   core, the tests, and every inline <script> block in public/index.html. */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
let failures = 0;

function check(file, label) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    console.log('ok   ' + label);
  } catch (e) {
    failures++;
    console.error('FAIL ' + label + '\n' + String(e.stderr || e.message));
  }
}

const files = [
  'server.js',
  'public/app-core.js',
  'scripts/check.js',
  ...fs.readdirSync(path.join(root, 'test')).filter(f => f.endsWith('.js')).map(f => 'test/' + f),
];
for (const f of files) check(path.join(root, f), f);

// inline (non-src) <script> blocks in the single-page client
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const blocks = [...html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  .filter(m => !(m[1] && /\bsrc\s*=/.test(m[1])));
if (!blocks.length) { failures++; console.error('FAIL no inline <script> found in public/index.html'); }
blocks.forEach((m, i) => {
  const tmp = path.join(os.tmpdir(), `voxstars-inline-${process.pid}-${i}.js`);
  fs.writeFileSync(tmp, m[2]);
  check(tmp, `public/index.html inline <script> #${i + 1}`);
  try { fs.unlinkSync(tmp); } catch (_) {}
});

console.log(failures ? `\n${failures} file(s) failed` : '\nall files pass syntax check');
process.exit(failures ? 1 : 0);
