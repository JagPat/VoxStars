#!/usr/bin/env node
/* Lightweight syntax check (npm run check) for the server, browser scripts,
   tests, and every inline <script> block in public/index.html. */
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
  'public/roster.js',
  'public/sw.js',
  'scripts/check.js',
  ...fs.readdirSync(path.join(root, 'lib', 'optimizer')).filter(f => f.endsWith('.js')).map(f => 'lib/optimizer/' + f),
  ...fs.readdirSync(path.join(root, 'test')).filter(f => f.endsWith('.js')).map(f => 'test/' + f),
];
for (const f of files) check(path.join(root, f), f);

// inline (non-src) <script> blocks in the single-page client
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
if (!(html.indexOf('src="roster.js"') < html.indexOf('src="app-core.js"'))) {
  failures++; console.error('FAIL roster.js must load before app-core.js');
}
for (const required of ['Championship Safe', 'Franchise Balanced', 'Data-quality queue', 'Mark official list submitted']) {
  if (!html.includes(required)) { failures++; console.error('FAIL missing optimizer UI copy: ' + required); }
}
if (html.includes('Split strategy')) { failures++; console.error('FAIL legacy split strategy controls remain'); }
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
