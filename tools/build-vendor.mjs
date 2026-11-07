// Builds src/ui_Vendor.html from pinned npm packages.
// Run once per dependency upgrade: npm run vendor
import { build } from 'esbuild';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const out = resolve(here, '.vendor.js');

await build({
  entryPoints: [resolve(here, 'vendor-entry.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2017'],
  outfile: out,
  legalComments: 'none',
});

const code = (await readFile(out, 'utf8')).replace(/<\/script/gi, '<\\/script');
const html = [
  '<!-- GENERATED FILE. Do not edit. Run: npm run vendor -->',
  '<script>',
  code,
  '</script>',
  '',
].join('\n');

await mkdir(resolve(root, 'src'), { recursive: true });
await writeFile(resolve(root, 'src/ui_Vendor.html'), html, 'utf8');
console.log('src/ui_Vendor.html', (html.length / 1024).toFixed(1) + ' KB');
