#requires -Version 5.1
<#
  PostgreSQL 16 in one throwaway container for migrations, integration tests and security tests (DK-05, ADR-0004).
  Same roles and rights as the local bootstrap: it runs scripts/db/bootstrap.ps1 against the container (twice on a new
  volume, to prove it is idempotent). The local PostgreSQL 18 is never touched.

    pg16.ps1 up      start (or reuse) the container, bootstrap it, print the three variables the tests need
    pg16.ps1 status  show whether it runs
    pg16.ps1 down    remove the container AND its volume (only objects named privpay-dk05-*)

  Secrets (admin password, role passwords) are made under secrets/pg16/ (gitignored, never overwritten, never printed).
#>
param(
  [Parameter(Position = 0)][ValidateSet('up', 'status', 'down')][string]$Action = 'status',
  # Same image and digest as the Compose stack (deploy/compose/docker-compose.yml): one PostgreSQL 16 for everything.
  [string]$Image = 'postgres:16.15@sha256:9e2cf6287f25c3151f4c9421ccce2b17f3e60061c111a29165e0d2cdd9ff0a97',
  [int]$Port = $(if ($env:PG16_PORT) { [int]$env:PG16_PORT } else { 15432 })
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$name = 'privpay-dk05-pg16'
$volume = 'privpay-dk05-pg16-data'
$secretsDir = Join-Path $root 'secrets\pg16'
$adminFile = Join-Path $secretsDir 'pg16_admin_password'
$envFile = Join-Path $secretsDir 'bootstrap.env'

function Test-Container { (& docker ps -a --filter "name=^/$name$" --format '{{.Names}}') -eq $name }

switch ($Action) {
  'status' {
    if (Test-Container) { & docker ps -a --filter "name=^/$name$" --format '{{.Names}}  {{.Status}}  {{.Ports}}' } else { 'not present' }
  }
  'down' {
    if (Test-Container) { & docker rm -f -v $name | Out-Null }
    $v = & docker volume ls -q --filter "name=^$volume$"
    if ($v) { & docker volume rm $volume | Out-Null }
    'removed container and volume of this ticket (nothing else touched)'
  }
  'up' {
    New-Item -ItemType Directory -Force -Path $secretsDir | Out-Null
    if (-not (Test-Path -LiteralPath $adminFile)) {
      $bytes = New-Object byte[] 24
      $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create(); $rng.GetBytes($bytes); $rng.Dispose()
      $pw = [Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')
      [System.IO.File]::WriteAllText($adminFile, $pw, (New-Object System.Text.UTF8Encoding($false)))
    }
    if (-not (Test-Container)) {
      # Small on purpose (DK-05): the engine settings stay at their defaults, only the box is limited.
      & docker run -d --name $name --label privpay.ticket=dk05 `
        --memory 768m --cpus 2 `
        -p "127.0.0.1:${Port}:5432" `
        -v "${volume}:/var/lib/postgresql/data" `
        -v "${adminFile}:/run/secrets/pg16_admin_password:ro" `
        -e POSTGRES_USER=pg16_admin -e POSTGRES_PASSWORD_FILE=/run/secrets/pg16_admin_password `
        $Image | Out-Null
      if ($LASTEXITCODE -ne 0) { throw 'docker run failed' }
    } else { & docker start $name | Out-Null }

    # The image restarts once after its init phase, so wait for a real query rather than the first pg_isready.
    $ready = $false
    $ErrorActionPreference = 'Continue'   # psql writes to stderr while the server starts; that is not an error here
    for ($i = 0; $i -lt 60 -and -not $ready; $i++) {
      & docker exec $name psql -U pg16_admin -d postgres -tAc 'select 1' 2>$null | Out-Null
      if ($LASTEXITCODE -eq 0) { $ready = $true } else { Start-Sleep -Seconds 1 }
    }
    $ErrorActionPreference = 'Stop'
    if (-not $ready) { throw 'PostgreSQL 16 did not become ready within 60 seconds' }

    $lines = @("PG_HOST=127.0.0.1", "PG_PORT=$Port", "PG_ADMIN_USER=pg16_admin", "PG_ADMIN_PASSWORD_FILE=$adminFile", "PG_SECRETS_DIR=$secretsDir")
    [System.IO.File]::WriteAllText($envFile, ($lines -join "`n") + "`n", (New-Object System.Text.UTF8Encoding($false)))
    foreach ($run in 1..2) {
      & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'bootstrap.ps1') -EnvFile $envFile
      if ($LASTEXITCODE -ne 0) { throw "bootstrap run $run failed" }
    }
    "ready. For the tests set, in the shell that runs them:"
    "  `$env:PG_HOST='127.0.0.1'; `$env:PG_PORT='$Port'; `$env:PG_SECRETS_DIR='$secretsDir'"
  }
}
