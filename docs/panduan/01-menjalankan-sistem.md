# 01. Menjalankan sistem secara lokal (tanpa Docker)

Bab ini berisi langkah dari repo yang baru di-clone sampai sembilan proses berjalan dan bisa dicoba lewat `curl`. Fase lokal tidak memakai Docker (ADR-0004, [`docs/adr/0004-lingkungan-lokal-tanpa-docker.md`](../adr/0004-lingkungan-lokal-tanpa-docker.md)); Docker Compose, Kong, dan Keycloak adalah pekerjaan fase berikutnya (DK-01 sampai DK-06).

## Apa yang sudah dan belum saya buktikan

Langkah 1 (build), 3 (migrasi: `up to date`), 4 (rahasia, di direktori sementara), dan 5 (sembilan proses) di bawah **dijalankan sungguhan** pada 2026-10-23 (Windows 11, Node 24.12, pnpm 12.14 lewat corepack, PostgreSQL lokal), termasuk seluruh alur di bagian "Mencoba alurnya". Langkah 2 (`.env` dan `bootstrap.ps1`) dan pemasangan dependensi hanya diperiksa, tidak diulang. Dua hal tidak bisa saya ulang dari nol karena mesin ini sudah dipakai untuk pengembangan dan saya tidak boleh menghapus databasenya:

- **Instalasi bersih** (`node_modules` kosong) dan **`bootstrap.ps1` pada server PostgreSQL kosong**: perintahnya saya tuliskan dari berkas aslinya ([`scripts/db/README.md`](../../scripts/db/README.md), [`scripts/db/bootstrap.ps1`](../../scripts/db/bootstrap.ps1)), tetapi pada sesi ini hanya diperiksa, tidak dijalankan. Skrip itu idempoten dan diuji dua kali berturut-turut di CI (`scripts/ci/bootstrap-twice.sh`).
- **Menyalakan mode baseline secara manual** (lihat bagian khusus di bawah). Yang terbukti: proses hasil build mau start di kedua mode, dan skenario yang sama lulus di kedua mode lewat tes.

**Tidak ada satu perintah yang menyalakan semuanya.** `package.json` tidak punya skrip `start`; `docker compose up` belum ada (ditunda, ADR-0004). Sembilan proses dijalankan satu per satu, dan layanan **tidak membaca `.env`**: mereka hanya membaca `process.env` ([`packages/common/src/nest/run-service.ts`](../../packages/common/src/nest/run-service.ts)). `.env.example` adalah daftar rujukan, bukan berkas yang dimuat. Karena itu skrip peluncur di bawah mengisi lingkungan tiap proses sendiri. Skrip itu **bukan bagian repo**; ia contoh yang saya uji.

## Prasyarat

| Kebutuhan | Keterangan |
| --- | --- |
| Node 24 | `.nvmrc` berisi `24`; `package.json` mensyaratkan `>=24 <25` |
| pnpm lewat corepack | pakai `corepack pnpm <perintah>`. `corepack enable` butuh hak admin di mesin ini (EPERM), jadi jangan mengandalkan `pnpm` langsung ([`CLAUDE.md`](../../CLAUDE.md), bagian Perintah) |
| PostgreSQL | target 16; fase lokal memakai versi yang terpasang (18 di mesin pengembang, ADR-0004). Perlu `psql` di `PATH` untuk `bootstrap.ps1` |
| PowerShell 5.1+ | untuk `scripts/db/bootstrap.ps1` dan skrip peluncur contoh. Git Bash dipakai untuk `curl` |
| `curl` dan `node` | untuk mencoba alurnya |

Docker **tidak** dibutuhkan.

## Langkah 1: pasang dependensi dan bangun

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm build
```

`build` menjalankan `tsc -b tsconfig.build.json` dan menaruh hasilnya di `dist/` tiap paket dan layanan. Layanan dijalankan dari hasil build (`node services/<nama>/dist/main.js`), bukan dari TypeScript (keputusan N-04, [`docs/OPEN_QUESTIONS.md`](../OPEN_QUESTIONS.md)). Terverifikasi: build selesai tanpa galat dan berkas `dist/main.js` ada untuk gateway, privacy, dan dev-idp.

## Langkah 2: siapkan `.env` dan database

1. Salin `.env.example` menjadi `.env` (berkas ini di-ignore git). Untuk langkah ini hanya baris `PG_*` yang dibaca skrip bootstrap: `PG_HOST`, `PG_PORT`, `PG_ADMIN_USER`, dan `PG_ADMIN_PASSWORD` (atau `PG_ADMIN_PASSWORD_FILE`). Administratornya boleh superuser atau peran dengan `CREATEROLE` dan `CREATEDB`. Jangan tempelkan kata sandi itu di chat atau di berkas lain.
2. Jalankan sekali:

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts/db/bootstrap.ps1
   ```

   Skrip ini membuat lima database (`privpay_privacy`, `privpay_transaction`, `privpay_fraud`, `privpay_notification`, `privpay_reconciliation`), peran pemilik skema dan peran runtime per database, `privpay_auditor` (baca-saja untuk audit) dan `privpay_test_admin`. Kata sandi peran dibangkitkan ke `secrets/<peran>_password` (tidak pernah ke git, tidak pernah dicetak). Tabel ada di [`scripts/db/README.md`](../../scripts/db/README.md).
3. Untuk tes integrasi dan migrasi, salin `.env.test.example` menjadi `.env.test` (isinya `PG_HOST`, `PG_PORT`, `PG_SECRETS_DIR`; tanpa kata sandi). `pnpm db:migrate` dan `pnpm test:integration` memuatnya lewat `--env-file-if-exists=.env.test`.

## Langkah 3: buat tabel (migrasi)

```powershell
corepack pnpm db:migrate
```

Contoh keluaran pada database yang sudah termigrasi (terverifikasi):

```
privacy: up to date
transaction: up to date
fraud: up to date
notification: up to date
reconciliation: up to date
```

Pada database kosong, baris itu berisi nama berkas yang diterapkan. Migrasi hanya maju, tidak pernah menghapus, dan dijalankan oleh peran pemilik skema, bukan peran runtime ([`packages/common/src/migrate.ts`](../../packages/common/src/migrate.ts)). Mode diambil dari `PRIVACY_MODE` (bawaan `proposed`, [`packages/common/src/bin/db-migrate.ts`](../../packages/common/src/bin/db-migrate.ts)).

Perintah ini **tidak jalan otomatis** dan tidak menyentuh database tes. Jalankan lagi setiap kali ada migrasi baru.

## Langkah 4: rahasia untuk dev-idp dan Privacy

Layanan membaca rahasia dari berkas yang disebut variabel `<NAMA>_FILE`; nilai mentah di env ditolak ([`packages/common/src/config.ts`](../../packages/common/src/config.ts), `readSecret`). Dua kelompok berkas dibutuhkan selain kata sandi database dari langkah 2:

1. **Rahasia klien** untuk lima service account dev-idp (`api-gateway`, `transaction`, `fraud`, `notification`, `reconciliation`), satu berkas per klien, nama `<klien>_client_secret`:

   ```powershell
   corepack pnpm --filter @privpay/dev-idp run make-secrets
   ```

   Direktori tujuan diatur `DEV_IDP_SECRETS_DIR` (bawaan `./secrets`). Skrip tidak menimpa berkas yang ada dan hanya mencetak nama berkas ([`tools/dev-idp/scripts/make-secrets.mjs`](../../tools/dev-idp/scripts/make-secrets.mjs)).
2. **Tiga kunci Privacy**, masing-masing 32 byte acak dalam heks, **harus berbeda** satu sama lain (FR-30): `pseudonym_hmac_secret` (K_token), `blind_index_secret` (K_index), `field_encryption_key` (K_field). **Tidak ada skrip lokal yang membuatnya**; hanya CI yang memakai `openssl rand -hex 32` (`.github/workflows/ci.yml`). Alternatif tanpa openssl, terverifikasi:

   ```powershell
   node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex')+'\n')" > secrets/pseudonym_hmac_secret
   ```

   (ulangi untuk dua berkas lain). Privacy menolak start bila salah satu hilang, panjangnya bukan 32 byte, atau dua kunci sama ([`services/privacy-service/src/crypto/keys.ts`](../../services/privacy-service/src/crypto/keys.ts), `createKeys` dan `loadKeys`).

Skrip peluncur di bawah memakai direktori sementara untuk kedua kelompok ini supaya `secrets/` pribadimu tidak tersentuh.

## Langkah 5: nyalakan sembilan proses

Tabel proses, port, dan variabel lingkungan (semua loopback; `BIND_HOST` hanya boleh `127.0.0.1` atau `::1`, [`packages/common/src/nest/service-config.ts`](../../packages/common/src/nest/service-config.ts)):

| Proses | Entri | Port | Variabel penting (selain `PRIVACY_MODE`, `PORT`, `IDP_URL`) |
| --- | --- | --- | --- |
| dev-idp | `tools/dev-idp/dist/main.js` | 4000 | `NODE_ENV=development`, `DEV_IDP_ENABLED=true`, `DEV_IDP_SECRETS_DIR` |
| Privacy | `services/privacy-service/dist/main.js` | 4001 | `GRACE_PERIOD_SECONDS`, `PSEUDONYM_KEY_VERSION`, enam `TTL_*`, `DISCLOSURE_APPROVAL_TTL_SECONDS`, `RETENTION_DAYS`, `RETENTION_JOB_RUN_UTC`, tiga `*_FILE` kunci |
| Transaction | `services/transaction-service/dist/main.js` | 4002 | `FRAUD_AMOUNT_THRESHOLD`, `TX_PENDING_TIMEOUT_SECONDS`, `TX_SWEEP_INTERVAL_SECONDS`, `PRIVACY_SERVICE_URL`, `FRAUD_SERVICE_URL`, `NOTIFICATION_SERVICE_URL`, `TRANSACTION_CLIENT_SECRET_FILE` |
| Fraud | `services/fraud-service/dist/main.js` | 4003 | `FRAUD_AMOUNT_THRESHOLD`, `FRAUD_ODD_HOUR_START`, `FRAUD_ODD_HOUR_END`, `FRAUD_HOLD_THRESHOLD`, `FRAUD_BLOCK_THRESHOLD`, `FRAUD_HISTORY_DAYS` |
| Notification | `services/notification-service/dist/main.js` | 4004 | `PRIVACY_SERVICE_URL`, `SMS_SIMULATOR_URL`, `NOTIFICATION_CLIENT_SECRET_FILE` |
| Reconciliation | `services/reconciliation-service/dist/main.js` | 4005 | `RECON_DAILY_RUN_UTC`, `PRIVACY_SERVICE_URL`, `TRANSACTION_SERVICE_URL`, `RECONCILIATION_CLIENT_SECRET_FILE` |
| bank-simulator | `services/bank-simulator/dist/main.js` | 4006 | `GATEWAY_URL`, `BANK_USERNAME`, `BANK_SIMULATOR_TEST_ENDPOINTS=true` |
| sms-simulator | `services/sms-simulator/dist/main.js` | 4007 | `SMS_SIMULATOR_TEST_ENDPOINTS=true` |
| Gateway | `services/gateway/dist/main.js` | 4010 | `PRIVACY_SERVICE_URL`, `TRANSACTION_SERVICE_URL`, `RECONCILIATION_SERVICE_URL`, `NOTIFICATION_SERVICE_URL`, `API_GATEWAY_CLIENT_SECRET_FILE` |

Semua layanan yang memakai PostgreSQL juga butuh `PG_HOST`, `PG_PORT`, dan `PG_SECRETS_DIR` (tempat `*_password` peran runtime dari langkah 2). Skrip di bawah mendapatkannya dari `.env.test` lewat `node --env-file-if-exists=.env.test`, sehingga kamu tidak perlu mengulangnya.

Port 4000 sampai 4005 dan 4007 mengikuti `.env.example`; **4006 dan 4010 adalah pilihan saya** karena repo tidak menetapkan port untuk bank-simulator dan Gateway. Urutan menyalakan tidak dipaksa kode: kesembilan proses saya nyalakan serentak dan semua menjawab `/health` dalam beberapa detik, karena kunci publik dev-idp baru diambil saat token pertama diperiksa. Urutan yang masuk akal tetap dev-idp, Privacy, lalu sisanya.

### Skrip peluncur PowerShell (terverifikasi)

Simpan sebagai berkas bebas (misalnya `start-privpay.ps1` di luar repo), jalankan dari akar repo setelah `corepack pnpm build`:

```powershell
powershell -ExecutionPolicy Bypass -File start-privpay.ps1 -SecretsDir C:\temp\privpay-secrets -LogDir C:\temp\privpay-logs
```

```powershell
#requires -Version 5.1
param(
  [Parameter(Mandatory = $true)][string]$SecretsDir,
  [Parameter(Mandatory = $true)][string]$LogDir
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $SecretsDir, $LogDir | Out-Null
$SecretsDir = (Resolve-Path $SecretsDir).Path
$LogDir = (Resolve-Path $LogDir).Path

# 1. rahasia klien dev-idp (tidak menimpa), lalu tiga kunci Privacy: 32 byte acak dalam heks, semuanya berbeda
$env:DEV_IDP_SECRETS_DIR = $SecretsDir
node tools/dev-idp/scripts/make-secrets.mjs
foreach ($name in 'pseudonym_hmac_secret', 'blind_index_secret', 'field_encryption_key') {
  $path = Join-Path $SecretsDir $name
  if (-not (Test-Path $path)) {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    [System.IO.File]::WriteAllText($path, (($bytes | ForEach-Object { $_.ToString('x2') }) -join '') + "`n")
  }
}
Remove-Item Env:DEV_IDP_SECRETS_DIR

# 2. satu proses per layanan; anak proses mewarisi lingkungan sesi ini
$common = @{ PRIVACY_MODE = 'proposed'; TZ = 'UTC'; IDP_URL = 'http://127.0.0.1:4000' }
$started = @()
function Start-Service-Process([string]$Name, [int]$Port, [string]$Entry, [hashtable]$Extra) {
  $all = $common + $Extra + @{ PORT = "$Port" }
  foreach ($key in $all.Keys) { Set-Item -Path "Env:$key" -Value $all[$key] }
  try {
    $process = Start-Process -FilePath node -ArgumentList '--env-file-if-exists=.env.test', $Entry -PassThru -NoNewWindow `
      -RedirectStandardOutput (Join-Path $LogDir "$Name.log") -RedirectStandardError (Join-Path $LogDir "$Name.err.log")
    $script:started += [pscustomobject]@{ Name = $Name; Port = $Port; Pid = $process.Id }
  }
  finally { foreach ($key in $all.Keys) { Remove-Item -Path "Env:$key" -ErrorAction SilentlyContinue } }
}
$secret = { param($file) Join-Path $SecretsDir $file }
Start-Service-Process 'idp' 4000 'tools/dev-idp/dist/main.js' @{ NODE_ENV = 'development'; DEV_IDP_ENABLED = 'true'; DEV_IDP_SECRETS_DIR = $SecretsDir }
Start-Service-Process 'privacy' 4001 'services/privacy-service/dist/main.js' @{
  GRACE_PERIOD_SECONDS = '30'; PSEUDONYM_KEY_VERSION = '1'; TTL_PAYMENT_PROCESSING = '900'; TTL_FRAUD_DETECTION = '2592000'
  TTL_NOTIFICATION = '900'; TTL_NOTIFICATION_REGISTRATION = '31536000'; TTL_DAILY_RECONCILIATION = '86400'
  TTL_INTERNAL_AUDIT = '600'; DISCLOSURE_APPROVAL_TTL_SECONDS = '600'; RETENTION_DAYS = '90'; RETENTION_JOB_RUN_UTC = '01:00'
  PSEUDONYM_HMAC_SECRET_FILE = (& $secret 'pseudonym_hmac_secret'); BLIND_INDEX_SECRET_FILE = (& $secret 'blind_index_secret')
  FIELD_ENCRYPTION_KEY_FILE = (& $secret 'field_encryption_key')
}
Start-Service-Process 'transaction' 4002 'services/transaction-service/dist/main.js' @{
  FRAUD_AMOUNT_THRESHOLD = '1000000'; TX_PENDING_TIMEOUT_SECONDS = '300'; TX_SWEEP_INTERVAL_SECONDS = '30'
  PRIVACY_SERVICE_URL = 'http://127.0.0.1:4001'; FRAUD_SERVICE_URL = 'http://127.0.0.1:4003'
  NOTIFICATION_SERVICE_URL = 'http://127.0.0.1:4004'; TRANSACTION_CLIENT_SECRET_FILE = (& $secret 'transaction_client_secret')
}
Start-Service-Process 'fraud' 4003 'services/fraud-service/dist/main.js' @{
  FRAUD_AMOUNT_THRESHOLD = '1000000'; FRAUD_ODD_HOUR_START = '22'; FRAUD_ODD_HOUR_END = '6'
  FRAUD_HOLD_THRESHOLD = '50'; FRAUD_BLOCK_THRESHOLD = '90'; FRAUD_HISTORY_DAYS = '30'
}
Start-Service-Process 'notification' 4004 'services/notification-service/dist/main.js' @{
  PRIVACY_SERVICE_URL = 'http://127.0.0.1:4001'; SMS_SIMULATOR_URL = 'http://127.0.0.1:4007'
  NOTIFICATION_CLIENT_SECRET_FILE = (& $secret 'notification_client_secret')
}
Start-Service-Process 'reconciliation' 4005 'services/reconciliation-service/dist/main.js' @{
  RECON_DAILY_RUN_UTC = '00:10'; PRIVACY_SERVICE_URL = 'http://127.0.0.1:4001'
  TRANSACTION_SERVICE_URL = 'http://127.0.0.1:4002'; RECONCILIATION_CLIENT_SECRET_FILE = (& $secret 'reconciliation_client_secret')
}
Start-Service-Process 'bank' 4006 'services/bank-simulator/dist/main.js' @{
  GATEWAY_URL = 'http://127.0.0.1:4010'; BANK_USERNAME = 'bank.uji.1'; BANK_SIMULATOR_TEST_ENDPOINTS = 'true'
}
Start-Service-Process 'sms' 4007 'services/sms-simulator/dist/main.js' @{ SMS_SIMULATOR_TEST_ENDPOINTS = 'true' }
Start-Service-Process 'gateway' 4010 'services/gateway/dist/main.js' @{
  PRIVACY_SERVICE_URL = 'http://127.0.0.1:4001'; TRANSACTION_SERVICE_URL = 'http://127.0.0.1:4002'
  RECONCILIATION_SERVICE_URL = 'http://127.0.0.1:4005'; NOTIFICATION_SERVICE_URL = 'http://127.0.0.1:4004'
  API_GATEWAY_CLIENT_SECRET_FILE = (& $secret 'api-gateway_client_secret')
}
$started | ConvertTo-Json | Set-Content (Join-Path $LogDir 'pids.json')

# 3. tunggu /health tiap layanan (dibatasi 60 detik)
foreach ($svc in $started) {
  $answer = $null
  for ($i = 0; $i -lt 60 -and -not $answer; $i++) {
    try { $answer = Invoke-RestMethod -Uri "http://127.0.0.1:$($svc.Port)/health" -TimeoutSec 2 } catch { Start-Sleep -Seconds 1 }
  }
  '{0,-14} port {1}  {2}' -f $svc.Name, $svc.Port, $(if ($answer) { "$($answer.status) mode=$($answer.mode)" } else { 'NO ANSWER' })
}
```

Keluaran yang diharapkan dan yang saya lihat: sembilan baris `ok mode=proposed`, misalnya `{"status":"ok","service":"gateway","mode":"proposed","time":"2026-10-23T10:18:52.804Z"}` pada `GET /health`. Catatan operasional:

- `-NoNewWindow` membuat semua proses berbagi konsol skrip. Di jendela PowerShell biasa skrip kembali setelah baris `health`; bila dijalankan dari alat tanpa terminal, perintah luar akan terlihat "menggantung" karena anak proses masih memegang pipa keluaran (saya mengalaminya; prosesnya tetap sehat).
- Log tiap proses ada di `$LogDir\<nama>.log` (JSON, satu baris per kejadian).
- Menghentikan semuanya:

  ```powershell
  Get-Content C:\temp\privpay-logs\pids.json | ConvertFrom-Json | ForEach-Object { Stop-Process -Id $_.Pid -ErrorAction SilentlyContinue }
  ```

  Saya menjalankannya dan sembilan port kembali bebas. Di Windows tidak ada SIGTERM untuk anak proses, jadi ini mematikan paksa (jalur penutupan anggun hanya teruji di Linux/CI, lihat catatan di `tests/smoke/built-service.smoke.spec.ts`).

### Setara dalam Git Bash (terverifikasi)

Bila lebih nyaman memakai Git Bash, pola yang sama: tiap layanan dijalankan sebagai `env VAR=... node --env-file-if-exists=.env.test <entri> > log 2>&1 &`. Contoh satu layanan:

```bash
env PRIVACY_MODE=proposed TZ=UTC IDP_URL=http://127.0.0.1:4000 PORT=4002 \
  FRAUD_AMOUNT_THRESHOLD=1000000 TX_PENDING_TIMEOUT_SECONDS=300 TX_SWEEP_INTERVAL_SECONDS=30 \
  PRIVACY_SERVICE_URL=http://127.0.0.1:4001 FRAUD_SERVICE_URL=http://127.0.0.1:4003 \
  NOTIFICATION_SERVICE_URL=http://127.0.0.1:4004 TRANSACTION_CLIENT_SECRET_FILE="$S/transaction_client_secret" \
  node --env-file-if-exists=.env.test services/transaction-service/dist/main.js > transaction.log 2>&1 &
```

Variabel tiap layanan sama dengan tabel di atas. Menghentikan: `kill <pid>` untuk tiap proses (terverifikasi, port bebas kembali).

## Mencoba alurnya (terverifikasi)

Semua panggilan ke Gateway (`http://127.0.0.1:4010`) memakai JWT dari dev-idp. dev-idp tidak meminta kata sandi: `dev_login` cukup dengan nama pengguna seed (fiktif; [`tools/dev-idp/users.dev.json`](../../tools/dev-idp/users.dev.json)). Itu disengaja dan sebab dev-idp tak boleh terjangkau dari luar mesin.

Pengguna seed: nasabah `nasabah.uji.101`, `.102`, `.103` (`CUST-000101` sampai `103`); `admin.uji.1`, `admin.uji.2`; `auditor.uji.1`, `auditor.uji.2`; analis fraud `analis.uji.1`; bank `bank.uji.1`.

```bash
# token nasabah: klien customer-app, pengguna seed (token tidak dicetak di sini)
T=$(curl -s -X POST http://127.0.0.1:4000/token -H 'content-type: application/json' \
  -d '{"grant_type":"dev_login","client_id":"customer-app","username":"nasabah.uji.101"}' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).access_token))")
```

Klien menurut peran: `customer-app` (nasabah), `admin-console` (admin, auditor, analis), `bank-simulator` (bank). Pengguna hanya boleh masuk lewat kliennya sendiri.

Berikut urutan yang saya jalankan beserta jawaban nyata (id dan UUID dipersingkat; token JWT tidak pernah dicetak). Alur ini diurai langkah demi langkah dengan nama berkas dan fungsi di [03-alur-end-to-end.md](03-alur-end-to-end.md).

| # | Panggilan | Hasil |
| --- | --- | --- |
| 1 | `POST /notification/register` sebagai nasabah 101, `{"phone":"081200000001","channel":"SMS"}` (AZ-02) | 200 `{"status":"REGISTERED"}` |
| 2 | `POST /register` tanpa token, formulir lengkap dengan nilai fiktif (NIK `9999500000000042`, nama `Kenari Demo`, HP `0899900000042`, rekening `9999000042`, email `canary-42@example.test`, username `demo.pengguna.42`) | 201 `{"status":"REGISTERED"}`; dev-idp memberi `CUST-000104` |
| 3 | `POST /transaction` 35.000 dari rekening tadi, `Idempotency-Key` UUID baru | 201 `{"transaction_id":"TX-1792750777003000","status":"COMPLETED"}` (di bawah ambang, Fraud tidak ditanya) |
| 4 | `POST /transaction` 50.000 dengan kunci yang sama dua kali | pertama 201, kedua **200** dengan `transaction_id` yang sama (idempotensi, ADR-0009) |
| 5 | `POST /transaction` 1.000.000 (geohash `qqgu7`), lalu 8.000.000 (geohash `qqt8h`) | pertama `COMPLETED` (cold start, skor 10), kedua **`HELD`** (skor 55 = 10 + 25 + 20) |
| 6 | `GET http://127.0.0.1:4007/__test/messages` | empat SMS: "Transaksi Rp35000 berhasil.", "...Rp50000 berhasil.", "...Rp1000000 berhasil.", "Transaksi Rp8000000 sedang diverifikasi." |
| 7 | analis: `GET /transaction/held` | satu item: jumlah 8.000.000, `risk_score` 55, `fraud_decision` `HOLD_FOR_VERIFICATION`; tanpa token dan tanpa identitas |
| 8 | analis: `POST /transaction/{id}/review` `{"decision":"APPROVE","reason_code":"CONFIRMED_BY_CUSTOMER"}` | 200 `COMPLETED`; mengulang: **409 `NOT_HELD`**; nasabah memanggil `/transaction/held`: **403 `ACCESS_DENIED`** |
| 9 | auditor: `POST /reconciliation/audit-request` `{"transaction_id":"TX-...","reason_code":"DISPUTE"}` | 200 `{"request_id","transaction_id","audit_token":"PSEU-80995ADF","amount":8000000,"status":"COMPLETED"}`; tidak ada identitas |
| 10 | auditor: `POST /disclosure-requests` `{"audit_token","basis":"DISPUTE","case_ref":"KASUS-2026-042","attributes":["nama"]}` | 201 `{"disclosure_id","status":"PENDING"}` |
| 11 | auditor mencoba menyetujui permintaannya sendiri | **403 `ACCESS_DENIED`** (ditolak karena **peran**: hanya `admin` boleh menyetujui; pemeriksaan `SELF_APPROVAL` baru berlaku bila satu orang memegang kedua peran, lihat [04](04-keamanan.md)) |
| 12 | admin: `POST /disclosure-requests/{id}/approve` | 200 `APPROVED`, `expires_at` tepat 600 detik kemudian |
| 13 | auditor: `POST /reconciliation/disclosure` `{"audit_token","disclosure_id"}` | 200 `{"attributes":{"nama":"Kenari Demo"}}` |
| 14 | pembukaan yang sama sekali lagi | **403 `ACCESS_DENIED`** (sekali pakai; di Privacy tercatat `DISCLOSURE_NOT_APPROVED`) |
| 15 | auditor: `GET /audit-log?action=DE_PSEUDONYMIZE&limit=5` | satu `SUCCESS` dengan `attribute_names:["nama"]` (tanpa nilai) dan satu `DENIED` |
| 16 | `POST http://127.0.0.1:4006/simulate/settlement` `{"batch_date":"<hari ini UTC>"}` | 200; mengirim 2 baris seed (rekening `1234567801`, `1234567803`) lewat Gateway; gateway_status 202 |
| 17 | bank: `POST /settlement/report` untuk tanggal yang sama | **409 `IDEMPOTENCY_CONFLICT`**: satu laporan per tanggal (K-22); ini terjadi karena simulator sudah mengisi batch hari itu |
| 18 | admin: `POST /reconciliation/run` `{"date":"<hari ini>"}` | 200 `tx_count:4, matched:0, unmatched:6, status:MISMATCHED` (rekening nasabah baru tidak ada di laporan seed) |
| 19 | nasabah 101 membayar 35.000 dari `1234567801`; nasabah 103 membayar 1.500.000 dari `1234567803`; `run` lagi | `tx_count:7, matched:2, unmatched:5, status:PARTIAL` (dua cocok dengan pasangan token rekening + jumlah) |
| 20 | admin: `POST /subject/revoke` `{"subject_type":"CUSTOMER","subject_id":"CUST-000104"}` | 200 `{"revoked_count":5}` |
| 21 | nasabah 104 membayar lagi setelah dicabut | 201 `COMPLETED`: token baru diterbitkan karena Gateway boleh menerbitkan lagi (batas yang diketahui, lihat [08](08-batasan-dan-pertanyaan-dosen.md)); SMS tidak terkirim karena token domain P5 sudah dicabut |

Dua catatan hasil yang penting untuk dipahami:

- **Audit log setelah semua langkah itu** (`GET /audit-log?limit=200`, 66 baris) merangkum: 12 `GENERATE_TOKEN OK` oleh `API_GATEWAY`, 10 `REUSED_ACTIVE`, 6 `EXCHANGE_TOKEN OK` oleh `TRANSACTION`, 6 `RESOLVE_NOTIF_DOMAIN OK` dan 2 `DENIED TOKEN_NOT_FOUND` oleh `NOTIFICATION`, 1 `STORE_IDENTITY`, `DISCLOSURE_REQUESTED/APPROVED`, `DE_PSEUDONYMIZE` satu `SUCCESS` dan satu `DENIED`, 5 `REVOKE_SUBJECT` dan 1 `PURGE_IDENTITY`. Dua `DENIED` pada Notification cocok dengan dua kejadian yang saya picu: nasabah 103 yang belum mendaftarkan HP, dan nasabah 104 setelah dicabut. Tidak ada token P5 untuk dipecahkan, jadi SMS gagal tanpa menggagalkan transaksi (atribusi ini kesimpulan dari urutan kejadian dan dua baris `notification_failed` di log Transaction; baris audit tidak saya cocokkan satu per satu).
- **Log aplikasi tidak memuat nilai fiktif demo.** Saya mencari NIK, nama, HP, rekening, email, dan `CUST-000104` di semua berkas log: tidak ada yang cocok. Log hanya memuat `request_id`, `route`, `status`, `latency_ms`, `transaction_id`, `reason` ([`packages/common/src/logger.ts`](../../packages/common/src/logger.ts)). Dua baris `warn` di log Transaction (`notification_failed`, alasan `SERVICE_UNAVAILABLE`) adalah dua kasus SMS gagal di atas.

`GET /health` dan `GET /metrics` tersedia di tiap layanan hanya di loopback (AZ-43, N-05).

Data yang tertulis di database pengembangan oleh percobaan ini (transaksi fiktif, token, baris audit) tetap ada; itu isi normal `privpay_*` yang boleh diperiksa. Tidak ada tombol "reset" di repo.

## Mode baseline secara manual

Mode ditentukan `PRIVACY_MODE` pada **setiap** proses, dan skema database berbeda per mode. Nama database tetap (`SERVICE_DBS` di [`packages/common/src/db.ts`](../../packages/common/src/db.ts)), jadi satu mesin tidak bisa menjalankan dua mode bersamaan, dan database yang sudah dimigrasi proposed tidak bisa dimigrasi baseline. Yang saya uji:

```powershell
$env:PRIVACY_MODE = 'baseline'; corepack pnpm db:migrate transaction
```

menghasilkan `db:migrate failed: checksum_changed` dan keluar dengan kode 1, tanpa mengubah apa pun (riwayat migrasi proposed tidak cocok dengan berkas baseline; pengaman `migrate`).

Konsekuensi praktis, **belum saya jalankan karena menghapus database pengembangan**: menjalankan baseline secara manual berarti memakai database yang bersih (menjatuhkan lalu membuat ulang kelima database lewat `bootstrap.ps1`, atau server PostgreSQL lain), `PRIVACY_MODE=baseline corepack pnpm db:migrate`, lalu menyalakan **delapan** proses (tanpa Privacy Service) dengan `PRIVACY_MODE=baseline` dan **tanpa** `PRIVACY_SERVICE_URL`. Jalur yang sudah teruji untuk baseline:

- Tes E2E `services/gateway/test/e2e/equivalence.integration.spec.ts` menjalankan skenario yang sama di kedua mode dengan database tes terpisah per mode.
- Tes asap `tests/smoke/built-service.smoke.spec.ts` menjalankan hasil build tiap layanan di baseline dan proposed sebagai proses nyata.

Aturan yang menolak konfigurasi setengah-beralih, terverifikasi pada proses hasil build (pesan hanya menyebut nama variabel):

| Konfigurasi | Hasil |
| --- | --- |
| Transaction, `PRIVACY_MODE=baseline` dengan `PRIVACY_SERVICE_URL` terisi | `transaction-service: Invalid configuration: PRIVACY_SERVICE_URL (invalid)`, kode keluar 1 |
| Transaction, `PRIVACY_MODE=proposed` tanpa `PRIVACY_SERVICE_URL` | `... PRIVACY_SERVICE_URL (missing)`, kode keluar 1 |
| Privacy Service dengan `PRIVACY_MODE=baseline` | ditolak (`PRIVACY_MODE` tidak valid) bila variabel lainnya lengkap; teruji di `tests/smoke/built-service.smoke.spec.ts` dan `services/privacy-service/test/config.spec.ts`. Bila variabel lain masih kurang, yang dilaporkan lebih dulu adalah variabel yang hilang (aturan baru dicek setelah bentuk dasar lolos) |

## Masalah yang mungkin kamu temui

| Gejala | Penyebab dan jalan keluar |
| --- | --- |
| `corepack enable` gagal EPERM | tidak perlu; selalu `corepack pnpm ...` |
| Layanan keluar dengan `Invalid configuration: X (missing)` | variabel `X` belum diset; pesan hanya menyebut nama, tidak nilai ([`packages/common/src/config.ts`](../../packages/common/src/config.ts)) |
| `X_FILE (unreadable)` atau `(invalid)` | berkas rahasia tidak ada, kosong, atau panjang kunci salah |
| `startup_failed` di log, tanpa nama | port sudah dipakai atau PostgreSQL tak terjangkau; alasan sengaja tidak dirinci ke log |
| Permintaan 503 dari Gateway | salah satu hilir mati (gagal tertutup); cek `/health` tiap port |
| `TestDatabaseBusyError` saat `pnpm test:integration` | ada klien (pgAdmin, psql) yang terhubung ke database `privpay_*`; putuskan, lihat [`scripts/db/README.md`](../../scripts/db/README.md) |
| Hasil `HELD` tidak muncul | skor harus >= 50: perlu riwayat dulu (transaksi pertama di atas ambang adalah cold start, skor 10), lalu jumlah lebih dari tiga kali rata-rata dan lokasi baru |

## Verifikasi cepat tanpa menyalakan semuanya

```powershell
corepack pnpm test:smoke
```

membangun lalu menjalankan hasil build tiap layanan sebagai proses nyata di kedua mode (36 tes pada gerbang terakhir) dan memeriksa penolakan konfigurasi tak konsisten. Bab [06](06-pengujian.md) menjelaskan jenis tes lain.
