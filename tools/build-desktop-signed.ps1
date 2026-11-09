# بناء تطبيق سطح المكتب موقّعًا بالشهادة الداخلية.
# يقرأ مسار PFX وكلمة مروره من secrets\codesign (غير ملتزم في Git)،
# ثم يشغّل electron-builder. لا تُطبع كلمة المرور في المخرجات.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\build-desktop-signed.ps1

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$pfx = Join-Path $root 'secrets\codesign\school-attendance-codesign.pfx'
$passwordFile = Join-Path $root 'secrets\codesign\pfx-password.txt'

if (-not (Test-Path -LiteralPath $pfx)) {
  throw "Signing certificate not found: $pfx`nCreate it first or place the PFX there."
}
if (-not (Test-Path -LiteralPath $passwordFile)) {
  throw "PFX password file not found: $passwordFile"
}

$env:CSC_LINK = (Resolve-Path -LiteralPath $pfx).Path
$env:CSC_KEY_PASSWORD = (Get-Content -LiteralPath $passwordFile -Raw).Trim()

try {
  & npm.cmd run desktop:dist
  if ($LASTEXITCODE -ne 0) { throw "electron-builder failed with exit code $LASTEXITCODE" }
} finally {
  Remove-Item Env:CSC_LINK -ErrorAction SilentlyContinue
  Remove-Item Env:CSC_KEY_PASSWORD -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host 'Verifying signatures:'
Get-ChildItem (Join-Path $root 'dist-desktop') -Filter '*.exe' |
  ForEach-Object {
    $sig = Get-AuthenticodeSignature -LiteralPath $_.FullName
    [pscustomobject]@{
      File = $_.Name
      Status = $sig.Status
      Signer = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { '' }
    }
  } |
  Format-Table -AutoSize
