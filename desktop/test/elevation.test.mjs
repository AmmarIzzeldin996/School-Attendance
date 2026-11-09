import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readApproval, helperScript, approvalPath } from '../lib/elevation.js';

const dirs = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-elevation-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (ignored) { /* تنظيف */ }
  }
});

describe('recovery approval gate', () => {
  it('rejects a missing approval file', () => {
    const result = readApproval({ dir: tempDir(), nonce: 'abc' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('missing');
  });

  it('accepts a fresh approval with the matching nonce', () => {
    const dir = tempDir();
    fs.writeFileSync(approvalPath(dir), JSON.stringify({ nonce: 'abc', at: 1000 }), 'utf8');
    const result = readApproval({ dir, nonce: 'abc', now: 1000 + 30000 });
    expect(result.ok).toBe(true);
    expect(result.data.nonce).toBe('abc');
  });

  it('tolerates a UTF-8 BOM from PowerShell', () => {
    const dir = tempDir();
    fs.writeFileSync(approvalPath(dir), '\uFEFF' + JSON.stringify({ nonce: 'bom', at: 5000 }), 'utf8');
    expect(readApproval({ dir, nonce: 'bom', now: 6000 }).ok).toBe(true);
  });

  it('rejects a mismatched nonce', () => {
    const dir = tempDir();
    fs.writeFileSync(approvalPath(dir), JSON.stringify({ nonce: 'right', at: 1000 }), 'utf8');
    expect(readApproval({ dir, nonce: 'wrong', now: 2000 }).reason).toBe('nonce');
  });

  it('rejects an expired approval', () => {
    const dir = tempDir();
    fs.writeFileSync(approvalPath(dir), JSON.stringify({ nonce: 'abc', at: 1000 }), 'utf8');
    expect(readApproval({ dir, nonce: 'abc', now: 1000 + 10 * 60 * 1000 }).reason).toBe('expired');
  });

  it('rejects an approval stamped far in the future', () => {
    const dir = tempDir();
    fs.writeFileSync(approvalPath(dir), JSON.stringify({ nonce: 'abc', at: 10 * 60 * 1000 }), 'utf8');
    expect(readApproval({ dir, nonce: 'abc', now: 0 }).reason).toBe('expired');
  });

  it('rejects malformed approval content', () => {
    const dir = tempDir();
    fs.writeFileSync(approvalPath(dir), 'not json', 'utf8');
    expect(readApproval({ dir, nonce: 'abc', now: 1000 }).reason).toBe('invalid');
  });

  it('builds a helper that locks the approval folder to administrators', () => {
    const dir = tempDir();
    const script = helperScript('nonce-123', dir);
    expect(script).toContain('S-1-5-32-544');
    expect(script).toContain('S-1-5-18');
    expect(script).toContain('S-1-5-32-545');
    expect(script).toContain('SetAccessRuleProtection($true, $false)');
    expect(script).toContain("nonce = 'nonce-123'");
    expect(script).toContain('UtcNow.ToUnixTimeMilliseconds()');
    expect(script).toContain(dir.replace(/'/g, "''"));
  });
});
