# تثبيت شهادة التوقيع الداخلية كموثوقة على جهاز.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\trust-internal-signing.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\trust-internal-signing.ps1 -Scope LocalMachine
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\trust-internal-signing.ps1 -ExePath ".\dist-desktop\School-Attendance-Setup-3.6.0-x64.exe"
#
# CurrentUser لا يحتاج صلاحيات مدير. LocalMachine يحتاج PowerShell كمسؤول.
# يستخدم certutil لتجنب نافذة تأكيد تثبيت شهادة الجذر في الأتمتة.

[CmdletBinding()]
param(
  [string]$CertificatePath = '',
  [ValidateSet('CurrentUser', 'LocalMachine')]
  [string]$Scope = 'CurrentUser',
  [string]$ExePath = ''
)

$ErrorActionPreference = 'Stop'

if (-not $CertificatePath) {
  $candidates = @(
    (Join-Path $PSScriptRoot 'codesign\school-attendance-codesign.cer'),
    (Join-Path $PSScriptRoot '..\secrets\codesign\school-attendance-codesign.cer')
  )
  $CertificatePath = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
if (-not $CertificatePath -or -not (Test-Path -LiteralPath $CertificatePath)) {
  throw 'Certificate not found. Pass -CertificatePath or place school-attendance-codesign.cer in tools\codesign.'
}

$resolved = (Resolve-Path -LiteralPath $CertificatePath).Path
$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($resolved)

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)

if ($Scope -eq 'LocalMachine' -and -not $isAdmin) {
  throw 'LocalMachine requires an elevated (Run as administrator) PowerShell window.'
}

Write-Host "Certificate : $($cert.Subject)"
Write-Host "Thumbprint  : $($cert.Thumbprint)"
Write-Host "Valid until : $($cert.NotAfter.ToString('yyyy-MM-dd'))"
Write-Host "Scope       : $Scope"
Write-Host ''

$scopeArgs = @()
if ($Scope -eq 'CurrentUser') { $scopeArgs = @('-user') }

foreach ($storeName in @('Root', 'TrustedPublisher')) {
  & certutil @scopeArgs -addstore -f $storeName $resolved | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "certutil failed to add the certificate to $Scope\$storeName (exit code $LASTEXITCODE)."
  }
  Write-Host "[+] Trusted in $Scope\$storeName"
}

Write-Host ''

if ($ExePath) {
  if (-not (Test-Path -LiteralPath $ExePath)) { throw "Executable not found: $ExePath" }
  $signature = Get-AuthenticodeSignature -LiteralPath $ExePath
  $signature | Format-List Status, StatusMessage, SignerCertificate
  if ($signature.Status -ne 'Valid') {
    Write-Warning 'Signature is not Valid. Confirm the file was signed with this certificate thumbprint.'
  }
} else {
  Write-Host 'Done. Verify a signed file with:'
  Write-Host '  Get-AuthenticodeSignature ".\dist-desktop\School-Attendance-Setup-3.6.0-x64.exe" | Format-List Status, SignerCertificate'
}
