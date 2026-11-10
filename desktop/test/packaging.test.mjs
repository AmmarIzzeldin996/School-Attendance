import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'));

// أي مجلد يُحمَّل وقت التشغيل يجب أن يكون داخل حزمة asar، وإلا فشل التطبيق
// المثبّت بـ Cannot find module رغم نجاحه في وضع التطوير.
const RUNTIME_PATTERNS = [
  'main.js',
  'preload.js',
  'server.js',
  'lib/**/*',
  'vm/**/*',
  'sync/**/*',
  'backup/**/*',
  'data/**/*',
  'ui/**/*',
  'package.json'
];

describe('desktop packaging', () => {
  it('includes every runtime module in the packaged app', () => {
    const files = pkg.build && pkg.build.files;
    expect(Array.isArray(files)).toBe(true);
    RUNTIME_PATTERNS.forEach((pattern) => {
      expect(files, 'missing build.files entry: ' + pattern).toContain(pattern);
    });
  });

  it('ships the GAS sources as read-only extra resources', () => {
    const resources = pkg.build.extraResources || [];
    const source = resources.find((entry) => entry.to === 'app-src');
    expect(source).toBeTruthy();
    expect(source.from).toBe('../src');
    expect(fs.existsSync(path.resolve(desktop, source.from))).toBe(true);
  });

  it('parses every runtime and UI script', () => {
    const roots = ['main.js', 'preload.js', 'server.js', 'lib', 'vm', 'sync', 'backup', 'data', 'ui'];
    const files = [];
    roots.forEach((entry) => {
      const target = path.join(desktop, entry);
      if (!fs.existsSync(target)) return;
      if (fs.statSync(target).isFile()) { files.push(target); return; }
      const walk = (dir) => {
        fs.readdirSync(dir, { withFileTypes: true }).forEach((item) => {
          const full = path.join(dir, item.name);
          if (item.isDirectory()) walk(full);
          else if (item.name.endsWith('.js')) files.push(full);
        });
      };
      walk(target);
    });
    expect(files.length).toBeGreaterThan(10);
    files.forEach((file) => {
      const source = fs.readFileSync(file, 'utf8');
      expect(() => new vm.Script(source, { filename: file }), file).not.toThrow();
    });
  });

  it('keeps the scanner capture input out of the document scroll area', () => {
    const css = fs.readFileSync(path.resolve(desktop, '../src/ui_Styles.html'), 'utf8');
    const rule = /\.scan-capture\s*\{([^}]*)\}/.exec(css);
    expect(rule).toBeTruthy();
    expect(rule[1]).toMatch(/position:\s*fixed/);
    expect(rule[1]).not.toMatch(/left:\s*-/);
  });

  it('keeps code signing optional and targets x64 Windows', () => {
    expect(pkg.build.forceCodeSigning).toBe(false);
    const targets = (pkg.build.win.target || []).map((entry) => entry.target);
    expect(targets).toContain('nsis');
    expect(targets).toContain('portable');
    (pkg.build.win.target || []).forEach((entry) => {
      expect(entry.arch).toContain('x64');
    });
  });
});
