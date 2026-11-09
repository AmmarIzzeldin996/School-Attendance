'use strict';

// بوابة أمان لاستعادة كلمة مرور المشرف:
// لا تُنفَّذ الاستعادة إلا بعد موافقة مسؤول Windows عبر نافذة UAC.
// المساعد المرتفع الصلاحيات يكتب ملف موافقة يحوي nonce عشوائيًا في مجلد
// محمي (ProgramData) لا يملك المستخدم العادي صلاحية الكتابة فيه.
// التطبيق يتحقق من الـnonce والطابع الزمني قبل تنفيذ الاستعادة.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const APPROVAL_NAME = 'recovery-approval.json';
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_AGE_MS = 180000;

function defaultDir() {
  return path.join(process.env.ProgramData || 'C:\\ProgramData', 'SchoolAttendanceDesktop');
}

function approvalPath(dir) {
  return path.join(dir || defaultDir(), APPROVAL_NAME);
}

function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function powershellExe() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function helperScript(nonce, dir) {
  const file = approvalPath(dir);
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$dir = ' + psQuote(dir),
    '$file = ' + psQuote(file),
    'New-Item -ItemType Directory -Path $dir -Force | Out-Null',
    '$acl = New-Object System.Security.AccessControl.DirectorySecurity',
    '$acl.SetAccessRuleProtection($true, $false)',
    '$admin = New-Object System.Security.Principal.SecurityIdentifier("S-1-5-32-544")',
    '$system = New-Object System.Security.Principal.SecurityIdentifier("S-1-5-18")',
    '$users = New-Object System.Security.Principal.SecurityIdentifier("S-1-5-32-545")',
    '$inherit = [System.Security.AccessControl.InheritanceFlags]"ContainerInherit, ObjectInherit"',
    '$none = [System.Security.AccessControl.PropagationFlags]"None"',
    '$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($admin, "FullControl", $inherit, $none, "Allow")))',
    '$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($system, "FullControl", $inherit, $none, "Allow")))',
    '$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($users, "ReadAndExecute", $inherit, $none, "Allow")))',
    'Set-Acl -Path $dir -AclObject $acl',
    '$payload = [ordered]@{ nonce = ' + psQuote(nonce) + '; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); user = $env:USERNAME }',
    '$json = $payload | ConvertTo-Json -Compress',
    '[System.IO.File]::WriteAllText($file, $json, (New-Object System.Text.UTF8Encoding($false)))',
    'exit 0'
  ].join('\r\n');
  return script;
}

function readApproval(options) {
  const settings = options || {};
  const file = approvalPath(settings.dir);
  if (!fs.existsSync(file)) return { ok: false, reason: 'missing' };
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    return { ok: false, reason: 'invalid' };
  }
  if (!data || typeof data.nonce !== 'string' || data.nonce !== settings.nonce) {
    return { ok: false, reason: 'nonce' };
  }
  const at = Number(data.at);
  if (!Number.isFinite(at)) return { ok: false, reason: 'time' };
  const now = typeof settings.now === 'number' ? settings.now : Date.now();
  const age = now - at;
  if (age < -60000 || age > (settings.maxAgeMs || DEFAULT_MAX_AGE_MS)) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, data };
}

function requestApproval(options) {
  const settings = options || {};
  const dir = settings.dir || defaultDir();
  const timeoutMs = settings.timeoutMs || DEFAULT_TIMEOUT_MS;
  const now = typeof settings.now === 'function' ? settings.now : Date.now;
  const nonce = settings.nonce || crypto.randomBytes(32).toString('hex');
  const logger = settings.logger || null;

  return new Promise((resolve) => {
    let scriptFile;
    try {
      scriptFile = path.join(os.tmpdir(), 'sa-recovery-' + process.pid + '-' + nonce.slice(0, 10) + '.ps1');
      fs.writeFileSync(scriptFile, helperScript(nonce, dir), 'utf8');
    } catch (error) {
      resolve({ ok: false, reason: 'helper', message: error && error.message ? error.message : String(error) });
      return;
    }

    const argumentList = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + scriptFile + '"';
    const launcher = 'Start-Process -FilePath ' + psQuote(powershellExe()) +
      ' -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList ' + psQuote(argumentList);

    const child = spawn(powershellExe(), [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', launcher
    ], { windowsHide: true });

    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { fs.unlinkSync(scriptFile); } catch (ignored) { /* ملف مؤقت */ }
      if (!result.ok && logger) {
        logger.warn('recovery_approval_failed', { reason: result.reason, message: result.message || '' });
      }
      resolve(result);
    };

    timer = setTimeout(() => {
      try { child.kill(); } catch (ignored) { /* انتهت العملية */ }
      finish({ ok: false, reason: 'timeout' });
    }, timeoutMs);

    child.on('error', (error) => finish({ ok: false, reason: 'spawn', message: error && error.message }));
    child.on('close', (code) => {
      if (code !== 0) {
        finish({ ok: false, reason: 'cancelled' });
        return;
      }
      finish(readApproval({ dir: dir, nonce: nonce, now: now() }));
    });
  });
}

module.exports = { requestApproval, readApproval, helperScript, approvalPath, defaultDir };
