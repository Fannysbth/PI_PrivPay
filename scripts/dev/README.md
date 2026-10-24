# scripts/dev: menyalakan sistem secara lokal (3c, N-50)

Tiga perintah, tanpa Docker (ADR-0004). Port dan lingkungan tiap proses ditulis di satu tempat: `services.cjs`.

| Perintah | Fungsi |
| --- | --- |
| `corepack pnpm dev:keys` | membuat tiga kunci Privacy (`pseudonym_hmac_secret`, `blind_index_secret`, `field_encryption_key`; 32 byte acak, heks) di `secrets/` atau `DEV_SECRETS_DIR`. Tidak membaca dan tidak menimpa berkas yang ada; hanya nama berkas yang dicetak. |
| `corepack pnpm dev:up [--mode proposed\|baseline] [--secrets-dir <dir>] [--log-dir <dir>]` | menyalakan proses mode itu dari hasil build, menunggu `/health`, lalu tetap di latar depan; Ctrl+C menghentikan semuanya. Log dan `pids.json` ada di `.dev-run/logs` (di-ignore git). Penghitung `customer_id` dev-idp ada di `.dev-state/<mode>` (di-ignore git; buang bersama database Privacy bila database direset, N-51). |
| `corepack pnpm dev:down [--log-dir <dir>]` | menghentikan proses yang dicatat `dev:up` (di Windows pembunuhan paksa). |

Urutan pertama kali: `corepack pnpm build`, `scripts/db/bootstrap.ps1` (sekali), `corepack pnpm db:migrate` (database proposed), `corepack pnpm --filter @privpay/dev-idp run make-secrets`, `corepack pnpm dev:keys`, lalu `corepack pnpm dev:up`.

## Port

dev-idp 4000, Privacy 4001, Transaction 4002, Fraud 4003, Notification 4004, Reconciliation 4005, bank-simulator 4006, sms-simulator 4007, Gateway 4010. 4006 dan 4010 adalah pilihan repo ini; yang lain mengikuti `.env.example`.

## Mode baseline

Baseline tidak menyalakan Privacy dan tidak boleh diberi `PRIVACY_SERVICE_URL` (N-47). Skema baseline berbeda dari proposed, tetapi nama database layanan tetap, jadi baseline berjalan di database sendiri: `dev:up --mode baseline` membuat ulang `privpay_<layanan>_test_devbl` (Transaction, Fraud, Notification, Reconciliation) dari nol lewat `createTestDb` dan migrasi `baseline/`, lalu menyalakan layanan dengan `PG_DATABASE_SUFFIX=devbl`. Database proposed tidak disentuh. `corepack pnpm db:test-databases` menampilkannya sebagai sisa tes; `drop` menghapusnya.

Baseline menyimpan identitas asli menurut rancangan; pakai hanya data fiktif.
