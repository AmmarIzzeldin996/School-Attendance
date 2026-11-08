// Preflight verification without Google services.
// Checks syntax, include wiring, API/UI contract and forbidden placeholders.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'src');
const problems = [];

function read(name) {
  return readFileSync(resolve(src, name), 'utf8');
}

const gsFiles = readdirSync(src).filter((name) => name.endsWith('.gs')).sort();
if (gsFiles.length < 12) problems.push('server sources missing: ' + gsFiles.length);

let policy = {};
for (const name of gsFiles) {
  const text = read(name);
  try {
    new vm.Script(text, { filename: name });
  } catch (error) {
    problems.push(name + ': syntax error: ' + error.message);
  }
  if (name === '01_Config.gs') {
    for (const match of text.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*):\s*\{/gm)) policy[match[1]] = true;
  }
  if (/TODO|FIXME|not implemented/i.test(text)) problems.push(name + ': placeholder marker found');
}
if (Object.keys(policy).length < 30) problems.push('ACTION_POLICY_ parse produced ' + Object.keys(policy).length + ' actions');

const index = read('Index.html');
const includes = [...index.matchAll(/include\('([^']+)'\)/g)].map((match) => match[1]);
for (const name of includes) {
  if (!existsSync(resolve(src, name + '.html'))) problems.push('Index.html includes missing file: ' + name);
}
if (includes[includes.length - 1] !== 'ui_Settings') problems.push('ui_Settings must be the last include before boot');
if (!index.includes('SA.boot()')) problems.push('Index.html never calls SA.boot()');
if (/https?:\/\//i.test(index)) problems.push('Index.html loads a remote asset');

const uiFiles = readdirSync(src).filter((name) => /^ui_.*\.html$/.test(name) && name !== 'ui_Vendor.html');
const called = new Set();
const forbidden = [/\.innerHTML\b/, /\bouterHTML\b/, /\bdocument\.write\b/, /\beval\s*\(/, /\bnew Function\b/, /\binsertAdjacentHTML\b/];
for (const name of uiFiles) {
  const text = read(name);
  for (const match of text.matchAll(/\bapi\(\s*'([^']+)'/g)) called.add(match[1]);
  for (const pattern of forbidden) {
    if (pattern.test(text)) problems.push(name + ': forbidden DOM sink ' + pattern);
  }
  if (/<script[^>]+src=/i.test(text)) problems.push(name + ': remote script tag');
}
for (const action of called) {
  if (!policy[action]) problems.push('UI calls undeclared action: ' + action);
}
for (const action of Object.keys(policy)) {
  if (action !== 'ping' && !called.has(action)) problems.push('action never called by UI: ' + action);
}

const vendor = read('ui_Vendor.html');
if (vendor.length < 80000) problems.push('vendor bundle looks truncated: ' + vendor.length);
for (const global of ['SAQR', 'qrcode']) {
  if (!vendor.includes(global)) problems.push('vendor bundle missing global: ' + global);
}

if (problems.length) {
  console.error('verify: FAILED');
  for (const problem of problems) console.error(' - ' + problem);
  process.exit(1);
}
console.log('verify: OK — ' + gsFiles.length + ' server files, ' + uiFiles.length + ' UI files, ' + Object.keys(policy).length + ' actions');
