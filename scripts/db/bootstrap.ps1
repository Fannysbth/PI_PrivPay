#requires -Version 5.1
<#
  PrivPay local database bootstrap (ADR-0004).
  Reads PG_* settings from the repo's local .env (admin password is never printed or passed on a command line),
  generates passwords for the privpay_* roles into secrets/ when missing, then runs bootstrap.sql through psql.
  Only privpay_* objects are created or altered. Safe to re-run.
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$envFile = Join-Path $root '.env'
if (-not (Test-Path $envFile)) { throw ".env not found at repo root. Copy .env.example to .env and fill PG_ADMIN_USER / PG_ADMIN_PASSWORD." }

# Parse only PG_* keys; ignore everything else so unrelated values are never touched.
$cfg = @{}
foreach ($line in Get-Content -LiteralPath $envFile) {
  if ($line -match '^\s*(PG_[A-Z_]+)\s*=\s*(.*?)\s*$') {
    $v = $Matches[2]
    if ($v -match '^"(.*)"$' -or $v -match "^'(.*)'$") { $v = $Matches[1] } else { $v = ($v -replace '\s+#.*$', '') }
    $cfg[$Matches[1]] = $v
  }
}
foreach ($k in 'PG_HOST', 'PG_PORT', 'PG_ADMIN_USER') {
  if (-not $cfg.ContainsKey($k) -or [string]::IsNullOrWhiteSpace($cfg[$k])) { throw "$k is missing in .env" }
}
if ($cfg.ContainsKey('PG_ADMIN_PASSWORD_FILE') -and $cfg['PG_ADMIN_PASSWORD_FILE']) {
  $adminPw = (Get-Content -LiteralPath $cfg['PG_ADMIN_PASSWORD_FILE'] -Raw).Trim()
} elseif ($cfg.ContainsKey('PG_ADMIN_PASSWORD') -and $cfg['PG_ADMIN_PASSWORD']) {
  $adminPw = $cfg['PG_ADMIN_PASSWORD']
} else { throw 'Set PG_ADMIN_PASSWORD or PG_ADMIN_PASSWORD_FILE in .env' }

$secretsDir = if ($cfg.ContainsKey('PG_SECRETS_DIR') -and $cfg['PG_SECRETS_DIR']) { $cfg['PG_SECRETS_DIR'] } else { './secrets' }
if (-not [System.IO.Path]::IsPathRooted($secretsDir)) { $secretsDir = Join-Path $root $secretsDir }
New-Item -ItemType Directory -Force -Path $secretsDir | Out-Null

function Get-OrCreateSecret([string]$name) {
  $path = Join-Path $secretsDir $name
  if (-not (Test-Path -LiteralPath $path)) {
    $bytes = New-Object byte[] 24
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($bytes); $rng.Dispose()
    $pw = [Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')
    [System.IO.File]::WriteAllText($path, $pw, (New-Object System.Text.UTF8Encoding($false)))
  }
  return ([System.IO.File]::ReadAllText($path)).Trim()
}

$names = @{
  PRIVPAY_PW_PRIVACY_OWNER = 'privpay_privacy_owner_password'
  PRIVPAY_PW_APP           = 'privpay_app_password'
  PRIVPAY_PW_AUDITOR       = 'privpay_auditor_password'
  PRIVPAY_PW_TEST_ADMIN    = 'privpay_test_admin_password'
}

$touched = @('PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD') + @($names.Keys)
try {
  $env:PGHOST = $cfg['PG_HOST']; $env:PGPORT = $cfg['PG_PORT']
  $env:PGUSER = $cfg['PG_ADMIN_USER']; $env:PGPASSWORD = $adminPw
  foreach ($k in $names.Keys) { Set-Item -Path "Env:$k" -Value (Get-OrCreateSecret $names[$k]) }

  & psql -X -v ON_ERROR_STOP=1 -d postgres -f (Join-Path $PSScriptRoot 'bootstrap.sql')
  if ($LASTEXITCODE -ne 0) { throw "psql failed with exit code $LASTEXITCODE" }
}
finally {
  foreach ($k in $touched) { Remove-Item -Path "Env:$k" -ErrorAction SilentlyContinue }
}
