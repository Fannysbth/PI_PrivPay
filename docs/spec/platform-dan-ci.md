# Spesifikasi: platform dan CI

Sumber: PRD 10, 14, 17; ADR-0002, 0004, 0006, 0007, 0008; aturan proyek; SECURITY.md. Bagian yang berbeda dari teks PRD ditandai **[Δ PRD]** dan dirangkum di `01-perubahan-prd.md`. Butir bertanda **[K-nn]** adalah keputusan spec yang diterima Fanny (bawaan, Gerbang 3) (daftar di `OPEN_QUESTIONS.md` bagian F).

## 1. Tanggung jawab

Menyediakan fondasi bersama semua layanan: tata letak repo, paket `packages/common`, konfigurasi dan rahasia, format error, logging berredaksi, klien HTTP antar-layanan, verifikasi token (ADR-0007), runner migrasi, harness tes basis data, `dev-idp`, dan gerbang CI. Tidak berisi logika bisnis satu layanan pun.

## 2. Tata letak dan modul

```
services/{gateway,privacy-service,transaction-service,fraud-service,notification-service,
          reconciliation-service,bank-simulator,sms-simulator}/   # tiap layanan: src/, test/, migrations/{proposed,baseline}/
tools/dev-idp/                                                    # pengganti Keycloak pada fase lokal (ADR-0004)
packages/common/                                                  # lihat bagian 3
scripts/db/                                                       # bootstrap basis data (sudah ada)
tests/{functional,security,pii-scan,performance}/
```

`services/auth` pada struktur aturan proyek dipakai untuk Keycloak pada fase Docker; pada fase lokal digantikan `tools/dev-idp` (ADR-0004).

Prinsip desain (skill `codebase-design`): modul dalam dengan interface kecil, seam hanya di tempat sesuatu benar-benar bervariasi. Seam yang dibenarkan: **repositori per mode** (dua adapter: baseline dan proposed, ADR-0006), **Clock** (sistem dan palsu), **HttpClient** (nyata dan palsu untuk tes). Tidak ada seam lain yang dibuat "untuk jaga-jaga".

## 3. `packages/common`: modul dan interface

| Modul | Interface (yang harus diketahui pemanggil) | Catatan |
| --- | --- | --- |
| `config` | `loadConfig(zodObject, env, {strictPrefixes?})` mengembalikan objek bertipe; gagal cepat dengan daftar nama variabel bermasalah (`missing`, `empty`, `invalid`, `unknown`), tanpa nilai; tidak pernah gagal-terbuka (kegagalan tingkat skema dilaporkan sebagai `(config)`) | Variabel tak dikenal ditolak untuk prefiks yang dinyatakan ketat oleh layanan (`strictPrefixes`, opt-in agar variabel lingkungan lain tidak ditolak); rahasia lewat `readSecret(env, 'NAME')` dan `readKey(env, 'NAME', bytes)` yang membaca berkas dari `NAME_FILE` (maks 4 KiB), menolak `NAME` mentah di env |
| `clock` | `interface Clock { now(): Date }`, `SystemClock`, `FakeClock(start)` dengan `advance(seconds)` dan `set(instant)` | Selalu UTC (NFR-20); instant berbentuk teks wajib memuat `Z` atau offset; tes tidak memakai `sleep` nyata; pemeriksaan `TZ=UTC` proses ada di M0-06 |
| `errors` | `DomainError(reason)`; `REASONS` (status antar-layanan dan kode klien per reason); `toWireError(err, requestId)` dan `toClientError(err, requestId)` | Bagian 4. Kode, status, dan pesan diturunkan dari tabel `REASONS` sehingga pemanggil tidak dapat menyetel status atau pesan sendiri; `requestId` yang bukan UUID diganti `[INVALID]`; reason tak dikenal menjadi 500 |
| `logger` | `createLogger({service, level?, destination?})`; `logger.info(event, fields)` | pino; hanya field `LogFields` (daftar putih); lihat bagian 5; `console.*` dilarang (ESLint + pre-commit) |
| `nest` (`@privpay/common/nest`) | `createServiceApp({service, modules?}, env, {clock?, delay?, logDestination?, closeables?})` mengembalikan `{app, httpServer, listen(), close()}`; `runService({service, modules?})` untuk `main.ts`; `serviceConfigSchema`; `SERVICE_IDS` | Bagian 8, 9. `BIND_HOST` hanya loopback (AZ-43), `TZ` hanya UTC (NFR-20); `/health` dan `/metrics` bagian 8; error seragam (gateway tanpa `reason`); `close()` menunggu permintaan berjalan sampai `SHUTDOWN_TIMEOUT_MS`, lalu menutup `closeables` |
| `http` | `createHttpClient({baseUrls, timeoutMs, maxRetries, serviceToken?, ...}).request({service, method, path, body?, idempotent, requestId?, authorization?, actorToken?})`; `httpConfigSchema` (`HTTP_TIMEOUT_MS` 3000, `HTTP_MAX_RETRY` 0..2, bawaan 2); `createTokenCache({fetchToken, clock})`; `Delay` (`RealDelay`, `FakeDelay`) | Bagian 6. Pemanggil menyebut nama layanan dan path, bukan URL (URL hanya dari konfigurasi, API7); tidak ada header bebas (hanya `Authorization`, `X-Actor-Token`, `X-Request-Id`, `Content-Type` yang diatur klien dan divalidasi polanya); setelah percobaan habis, 502/503/504, kegagalan jaringan, dan timeout menjadi `DomainError('SERVICE_UNAVAILABLE')` dengan `cause` berupa kategori (`timeout`, `network`, `unavailable`, `too_large`, `parse`); request yang salah dibentuk menjadi `INTERNAL_ERROR` sebelum apa pun dikirim |
| `auth` | `verifyServiceToken(authorization)` mengembalikan `{requestingService}`; `verifyActorToken(token)` mengembalikan `{actorId, role}`; `authenticate(headers)` | ADR-0007; bagian 7 |
| `safeEqual` | `safeEqual(a, b)` pembungkus `timingSafeEqual` dengan pemeriksaan panjang (hasil `false` bila panjang beda) | Wajib untuk setiap perbandingan nilai rahasia |
| `jwt` | `signJwt(claims, {privateKey, kid})` dan `verifyJwt(token, {clock, issuer, audience, resolveKey})` | RS256 saja: `none`, HS256 (termasuk kunci publik sebagai rahasia HMAC), algoritma lain, `crit`, `kid` tak dikenal, tanda tangan salah, `iss`/`aud`/`exp` salah, `nbf`/`iat` di masa depan ditolak; tanpa toleransi; gagal = `UNAUTHENTICATED` dengan kategori pendek sebagai `cause` (tanpa isi token). Dipakai dev-idp (M1-01) dan `authenticate` (M1-02). Opsi `maxLifetimeSeconds` (penerima mengisi 300) menolak token dengan `exp - iat` lebih besar atau tanpa `iat` (NFR-21); tanda tangan diperiksa sebelum payload diurai |
| `schemas` | zod schema bersama: `Pseudonym`, `TransactionId`, `Purpose`, `ServiceId`, `SubjectType`, kontrak antar-layanan | Perubahan skema memecahkan tes kontrak (qa-checklist D) |
| `db` | `createPool(role)` membaca host/port dari env dan kata sandi dari berkas; `withTransaction(pool, fn)` | Tidak ada ORM; SQL berparameter saja |
| `migrate` | `migrate(pool, dir)` | Bagian 10 |

Kriteria interface: modul `errors`, `config`, dan `auth` diuji lewat interface publiknya, bukan internalnya.

### 3.1 Tipe bersama dan katalog env (satu sumber)

Spec lain merujuk ke sini dan tidak mengulang pola. Tipe bersama (zod di `packages/common`, menolak field tak dikenal): `Pseudonym` `^PSEU-[0-9A-F]{8}$`; `TransactionId` `^TX-[0-9]{1,29}$`; `CustomerId` `^CUST-[0-9]{6}$`; `AccountNumber` `^[0-9]{8,20}$` (K-06); `Amount` bilangan bulat rupiah ≥ 1 (K-16); `Geohash` `^[0-9b-hjkmnp-z]{1,12}$`; `MerchantId` `^MRC-[0-9]{3,}$`; `Phone` `^08[0-9]{8,12}$`; `Nik` `^[0-9]{16}$`; `BankReference` `^[A-Z0-9-]{1,32}$`; `IdempotencyKey` UUID.

**[M4-10]** Penjadwal job: `TX_SWEEP_INTERVAL_SECONDS`, `RETENTION_JOB_RUN_UTC`, `RETENTION_DAYS`, `RECON_DAILY_RUN_UTC` wajib (gagal cepat); `SCHEDULER_ENABLED` (`true`/`false`) opsional: tanpa nilai, job menyala kecuali `NODE_ENV=test`; satu instans per layanan.

Env: yang sudah ada di `.env.example` tetap berlaku (`PRIVACY_MODE`, `GRACE_PERIOD_SECONDS`, `TTL_*`, `DISCLOSURE_APPROVAL_TTL_SECONDS`, `PSEUDONYM_KEY_VERSION`, `RETENTION_DAYS`, `FRAUD_AMOUNT_THRESHOLD`, `FRAUD_ODD_HOUR_START/END`, `HTTP_TIMEOUT_MS`, `HTTP_MAX_RETRY`, `TX_PENDING_TIMEOUT_SECONDS`, `RATE_LIMIT_ENABLED`, `RATE_LIMIT_PER_MINUTE`, `ACCESS_TOKEN_TTL_SECONDS`, `PG_HOST`, `PG_PORT`, `PG_SECRETS_DIR`, `LOG_LEVEL`, `TZ`). **Usulan baru, belum ada di `.env.example` dan ditambahkan di tiket yang memakainya setelah disetujui (E-28):** `FRAUD_HOLD_THRESHOLD` (50) dan `FRAUD_BLOCK_THRESHOLD` (90) [K-20]; `TX_SWEEP_INTERVAL_SECONDS` (30) [K-19]; `RECON_DAILY_RUN_UTC` (`00:10`) [K-23]; `RETENTION_JOB_RUN_UTC` (`01:00`) [K-26]; `SMS_SIMULATOR_TEST_ENDPOINTS`, `SMS_SIMULATOR_FAIL` [K-21]; `DEV_IDP_ENABLED`; berkas rahasia `<NAMA>_FILE` per layanan.

## 4. Format error dan kode **[Δ PRD]**

Bentuk tunggal (NFR-25): `{ "error": { "code", "reason", "message", "request_id" } }`.

**Ke klien eksternal (delapan `code`, ADR-0008):** `UNAUTHENTICATED` 401, `ACCESS_DENIED` 403, `VALIDATION_ERROR` 422, `RATE_LIMITED` 429, `SERVICE_UNAVAILABLE` 503, `INTERNAL_ERROR` 500, `IDEMPOTENCY_CONFLICT` 409, `NOT_HELD` 409. `reason` tidak pernah dikirim ke klien; `message` generik.

**Antar-layanan:** `code` dan `reason` rinci. Pemetaan reason (HTTP):

| reason | HTTP | Tampil ke klien sebagai |
| --- | --- | --- |
| `TOKEN_NOT_FOUND` | 404 | `ACCESS_DENIED` 403 |
| `SERVICE_MISMATCH`, `PURPOSE_MISMATCH`, `REVOKED`, `POLICY_NOT_ALLOWED`, `FORBIDDEN_ROLE` | 403 | `ACCESS_DENIED` 403 |
| `EXPIRED` | 410 | `ACCESS_DENIED` 403 |
| `TX_TERMINAL` | 409 | `ACCESS_DENIED` 403 |
| `DISCLOSURE_NOT_FOUND` | 404 | `ACCESS_DENIED` 403 |
| `DISCLOSURE_NOT_APPROVED`, `REQUESTER_MISMATCH`, `SELF_APPROVAL` | 403 | `ACCESS_DENIED` 403 |
| `DISCLOSURE_EXPIRED` | 410 | `ACCESS_DENIED` 403 |
| `DISCLOSURE_NOT_PENDING` **[K-01]** | 409 | `ACCESS_DENIED` 403 |
| `INVALID_BASIS`, `ATTRIBUTE_NOT_ALLOWED` | 422 | `VALIDATION_ERROR` 422 |
| `VALIDATION_ERROR` | 422 | `VALIDATION_ERROR` 422 |
| `IDEMPOTENCY_CONFLICT`, `NOT_HELD` | 409 | sama |
| `TRANSACTION_NOT_FOUND` **[K-02]** | 404 | `ACCESS_DENIED` 403 |
| tak terduga | 500 | `INTERNAL_ERROR`, tanpa detail |

Aturan: kegagalan yang tidak dikenal menjadi 500 `INTERNAL_ERROR`; detail hanya di log dengan `request_id` (E-05 qa). `catch {}` kosong dilarang (lint). Token tidak ada dan bukan milik pemanggil tidak boleh terbedakan dari sisi klien (NFR-10).

## 5. Logging

- pino, level dari env `LOG_LEVEL`. Hanya field berikut yang boleh dicatat: `request_id`, `transaction_id`, token (`PSEU-...`), `route`, `status`, `latency_ms`, `reason`, nama kejadian; `service` ditetapkan saat logger dibuat dan tidak dapat ditimpa. Fungsi `logger` menerima objek bertipe `LogFields` (bukan `Record<string, unknown>`); field di luar daftar tidak dapat dikompilasi dan, bila lolos lewat cast, dibuang saat berjalan (nama kunci yang mirip data dicatat sebagai `[invalid_key]`). Nilai tiap field diperiksa polanya (UUID, `TX-` + angka, `PSEU-` + 8 heks, templat rute tanpa deretan angka panjang, status 100..599, latensi ≤ 1 jam, `reason` dari `REASONS`); yang tidak cocok menjadi `[INVALID]`. Nama kejadian harus berpola `^[a-z][a-z0-9_.-]{0,63}$`.
- Tidak ada lapis `redact` pino: daftar putih membuang semua kunci lain sehingga `redact` tidak akan pernah terpicu dan tidak dapat diuji. Lapis kedua adalah validasi pola nilai (di atas). **[Δ spec: PRD NFR-15 tidak menyebut `redact`; ADR-0002 menyebutnya sebagai alat, dan dibuang karena tidak berfungsi pada rancangan daftar putih.]**
- Body permintaan tidak pernah dicatat, juga bukan pada tingkat `debug` (NFR-15).
- Pesan error untuk validasi env tidak memuat nilai (E-09).

## 6. Klien HTTP antar-layanan (NFR-12, qa E-03)

- **[ADR-0018]** Satu pengecualian: `POST /reconciliation/run` (operasi batch admin) memakai `BATCH_HTTP_TIMEOUT_MS` (bawaan 60000) lewat `timeoutMs` per permintaan; rute lain tidak.
- Timeout `HTTP_TIMEOUT_MS` (3000), maksimum `HTTP_MAX_RETRY` (2) percobaan ulang dengan backoff eksponensial dan jitter, **hanya** bila `idempotent: true` pada pemanggilan.
- Yang dianggap idempoten: `POST /pseudonymize` (token aktif dipakai ulang), `POST /resolve-domain`, `POST /re-issue` (percobaan kedua mengembalikan token baru yang sama karena penerbitan memakai ulang baris aktif; dibuktikan tes), `PATCH /transaction-status`, `POST /notification/register` (upsert), `GET`. Yang tidak: `POST /notification/send`, `POST /fraud/assess` (menulis riwayat), `POST /identity` sebelum dibuat idempoten (lihat privacy-service 4.9), `POST /de-pseudonymize` (sekali pakai).
- Retry hanya untuk kegagalan jaringan, timeout, dan 502/503/504. Kegagalan 4xx tidak diulang.
- Header baku: `X-Request-Id` diteruskan atau dibangkitkan, `Authorization: Bearer <service JWT>`, `X-Actor-Token` bila ada.
- Token layanan di-cache sampai `exp` dikurangi 30 detik (NFR-21), diperbarui dengan penguncian agar tidak ada badai permintaan token.
- Klien tidak mengikuti redirect dan menolak URL dari input (API7): URL layanan hanya dari konfigurasi.

## 7. Autentikasi dan otorisasi (ADR-0007)

`authenticate(headers)` mengembalikan `{requestingService, actor?}` dengan aturan berikut, semuanya diuji (identity-check Fase 2 menjadi tes tiket):

1. `Authorization: Bearer` wajib; verifikasi RS256 lewat JWKS (`alg` selain RS256 ditolak, termasuk `none` dan HS256), `iss`, `exp`, dan `aud` memuat layanan penerima.
2. `requestingService` dari klaim `azp` melalui allowlist: `api-gateway`→`API_GATEWAY`, `transaction`→`TRANSACTION`, `fraud`→`FRAUD`, `notification`→`NOTIFICATION`, `reconciliation`→`RECONCILIATION`, `admin-console`→`ADMIN_CONSOLE`, `bank-simulator`→`BANK`. Klaim lain, header lain, dan body tidak pernah memengaruhinya (D-16).
3. Bila `requestingService` bukan `ADMIN_CONSOLE`, `X-Actor-Token` opsional; bila ada, harus token manusia valid (`azp=admin-console`, tepat satu peran dari `admin`/`auditor`/`fraud_analyst`) dan memberi `actorId` dari `sub` serta `role`.
4. Bila `Authorization` sudah token manusia (`ADMIN_CONSOLE`), `X-Actor-Token` ditolak (tidak ada identitas ganda); aktor diambil dari token itu sendiri.
5. Token nasabah (`azp=customer-app`, membawa `customer_id`) hanya diterima oleh Gateway dan tidak pernah diteruskan ke hilir.
6. **[Δ PRD / usulan W-03, K-03]** Pembatasan `aud` token aktor: `aud` token manusia hanya memuat layanan yang dilewati operasi perannya, sehingga layanan hilir lain tidak dapat memakai ulang token itu: `auditor`: `api-gateway`, `reconciliation-service`, `privacy-service`; `fraud_analyst`: `api-gateway`, `transaction-service`; `admin`: `api-gateway`, `privacy-service`, `reconciliation-service` **[N-17]** (administrator menjalankan rekonsiliasi, AZ-08). Layanan hilir yang diretas tetap dapat memakai ulang token pada layanan di jalurnya selama ≤ 5 menit (T-15, risiko sisa).
7. Perbandingan nilai rahasia (kunci, rahasia klien) hanya lewat `safeEqual`; aturan lint `no-restricted-syntax` melarang `===`, `!==`, `==`, dan `Buffer.equals` pada operan bernama rahasia (N-16).
8. **[N-13, N-14]** Hanya service account membawa `X-Actor-Token`; token sahih untuk layanan lain 403, bukan 401; header ganda 401; `roles`/`customer_id` pada jenis pemanggil yang salah 401, sama untuk token `Authorization` dan token aktor; token aktor yang sahih tetapi bukan orang admin-console (layanan, nasabah, bank) 403 `not_a_person`; peran orang di luar jalurnya 403 `role_not_here` walau `aud` memuatnya (penerima memeriksa `ROLE_SERVICES` sendiri, K-03); skema `Bearer` tidak peka huruf besar-kecil (RFC 7235).

## 8. `/health` dan `/metrics` (NFR-14)

Semua layanan mengekspos `GET /health` (`{status, service, mode, time}`; `mode` dari `PRIVACY_MODE`) dan `GET /metrics` (format Prometheus; hitung permintaan dan latensi per rute, tanpa label berisi token atau identitas). Keduanya hanya pada antarmuka `127.0.0.1` (fase lokal) dan jaringan internal (fase Docker). Metrik tidak boleh memuat PII (larangan keras).

## 9. Siklus hidup proses

Validasi env saat start (gagal cepat), penutupan anggun (berhenti menerima koneksi, menyelesaikan permintaan berjalan sampai batas waktu, menutup pool), `TZ=UTC`. Aplikasi menolak start bila rahasia hilang, kosong, atau panjang salah; pada Privacy Service tiga kunci harus 32 byte dan saling berbeda (FR-30).

## 10. Runner migrasi (ADR-0002)

- Berkas `NNNN_nama.sql` bernomor di `services/<svc>/migrations/{common,proposed,baseline}/`; runner menjalankan `common` lalu folder mode dari `PRIVACY_MODE`. Maju-saja, tanpa rollback otomatis.
- Tabel `schema_migrations(version, name, checksum, applied_at)`; checksum SHA-256 isi berkas. Berkas yang sudah diterapkan dan berubah isinya: gagal. Urutan harus rapat dan naik. Dijalankan **hanya** oleh peran pemilik skema; peran lain: gagal sebelum mengubah apa pun.
- Satu migrasi dalam satu transaksi; kegagalan membatalkan seluruhnya.
- Kriteria penerimaan (M0-04): tes checksum berubah, tes urutan (celah dan duplikat), tes peran salah, tes transaksi batal, tes idempoten bila dijalankan dua kali.

## 11. Basis data lokal dan harness tes (ADR-0004)

- Semua objek berawalan `privpay_`; host, port, versi dari env (`PG_HOST`, `PG_PORT`). `scripts/db/bootstrap.ps1` membuat database dan peran per layanan; diperluas di M0-05 menjadi satu database dan pasangan peran `privpay_<svc>_owner` dan `privpay_<svc>_app` per layanan (untuk Privacy: `privpay_privacy_owner`, `privpay_app`, `privpay_auditor`, E-22). Keanggotaan admin dicabut di akhir skrip (ADR-0004).
- Harness tes: database `privpay_<svc>_test` dibuat ulang bersih tiap run oleh `privpay_test_admin`, migrasi dijalankan sebagai pemilik skema, tes terhubung sebagai peran runtime. Tes tidak bergantung urutan dan tidak berbagi database antar berkas tes yang berjalan paralel.
- Tidak ada angka performa dari lingkungan lokal yang boleh masuk laporan; hasil E(s) dan tes keamanan sah sebagai bukti kebenaran.

## 12. `dev-idp` (ADR-0004, ADR-0007)

Penerbit JWT tiruan khusus dev. Menolak start bila `NODE_ENV=production` atau `DEV_IDP_ENABLED` bukan `true`, dan hanya mengikat `127.0.0.1`.

- Kunci RS256 dibuat saat start, tidak pernah ditulis ke disk atau repo. `GET /.well-known/jwks.json`.
- `POST /token`: `client_credentials` untuk service account (`client_secret` dibaca dari berkas `secrets/<klien>_client_secret`, dibandingkan dengan `safeEqual`) dan `dev_login` untuk pengguna seed (hanya `username`, tanpa kata sandi nyata).
- Klaim: `iss=privpay-dev-idp`, `sub`, `azp`, `aud` (daftar), `iat`, `exp` (≤ 300 detik), `roles` (manusia: tepat satu), `customer_id` (hanya `customer-app`). `iss` jelas bertuliskan dev.
- Admin khusus Gateway (`POST /admin/users`, `DELETE /admin/users/{id}`) untuk A2 dan kompensasi (ADR-0005): hanya untuk `azp=api-gateway`; membangkitkan `CUST-NNNNNN` berurutan mulai `CUST-000101`.
- Seed fiktif di `tools/dev-idp/users.dev.json` yang jelas palsu: 3 nasabah (PRD 16), 2 admin, 2 auditor, 1 fraud analyst, 1 bank. Tidak ada PII nyata.
- **Utang fase Docker (DK-04):** pemetaan klaim `dev-idp` ke Keycloak (protocol mapper, atribut pengguna, klien, `aud`).

## 13. Simulator

`sms-simulator`: lihat `notification.md`. `bank-simulator`: lihat `reconciliation.md`. Keduanya tidak memanggil layanan selain tujuan yang tercantum dan tidak mencatat PII.

## 14. Gerbang CI dan pemeriksaan lokal

| Gerbang | Perintah | Fase |
| --- | --- | --- |
| lint | `pnpm lint` (ESLint typescript-eslint strict + Prettier; larangan `console.*`, `any`, `catch {}`, `.only`/`.skip`) | lokal + CI |
| typecheck | `pnpm typecheck` (`strict`, `noUncheckedIndexedAccess`) | lokal + CI |
| unit | `pnpm test` | lokal + CI |
| integrasi | `pnpm test:integration` (PostgreSQL lokal; di CI service container PostgreSQL) | lokal + CI |
| keamanan | `pnpm test:security` (TK-xx) | lokal + CI |
| audit | `pnpm audit --prod --audit-level high` | lokal + CI |
| secret | `gitleaks detect --log-opts="--all" --redact -v --config .gitleaks.toml` | lokal + CI + pre-commit |
| SAST dan lain-lain | CodeQL, Semgrep, Trivy, hadolint, dependency-review | CI (Trivy image dan hadolint aktif bila ada Dockerfile) |
| e2e compose | Newman + `pii-scan` pada kedua mode | **ditunda** sampai Docker (DK-01) |

Dependensi baru: alasan, lisensi, hasil `pnpm audit` di PR (aturan proyek). Semua Action dipin ke SHA commit dan semua image ke digest (M0-07); `tests/repo/ci-workflow.spec.ts` menjaganya. Job `integration` membangkitkan kata sandi admin PostgreSQL 16 per run dan menjalankan `scripts/ci/bootstrap-twice.sh` (bootstrap dua kali, snapshot katalog identik).

## 15. Kriteria penerimaan

| Tiket | Kriteria | ID |
| --- | --- | --- |
| M0-01 | `pnpm install --frozen-lockfile`, `lint`, `typecheck`, `test` berjalan dari root pada skeleton; `.nvmrc` Node 24 | aturan proyek |
| M0-02 | `config`: start gagal tanpa/kosong/salah panjang rahasia, pesan tanpa nilai; `clock`: `FakeClock`; `logger`: tes bahwa nilai kenari di field terlarang tidak muncul pada keluaran; `errors`: bentuk seragam, 8 kode klien | NFR-10, NFR-15, NFR-20, NFR-22, NFR-25, E-09 |
| M0-03 | timeout 3 detik, maks 2 retry dengan jitter, tidak ada retry untuk non-idempoten, `X-Request-Id` diteruskan (uji injeksi keterlambatan) | NFR-12, NFR-16 |
| M0-04 | runner migrasi (bagian 10) | ADR-0002 |
| M0-05 | bootstrap multi-layanan idempoten; keanggotaan admin dicabut dan dilaporkan; DB tes dibuat ulang tiap run | ADR-0004 |
| M0-06 | tiap layanan: `/health`, `/metrics`, shutdown anggun, validasi env; `mode` pada `/health` | NFR-14, NFR-20, E-08 |
| M0-07 | CI hijau pada kerangka; gitleaks dengan konfigurasi bersama | S-60..S-65 |
| M1-01 | `dev-idp` (bagian 12): token ≤ 300 detik, JWKS, menolak start di luar lokal | NFR-21 |
| M1-02 | `authenticate` (bagian 7), semua kasus negatif; `safeEqual` dipakai di setiap perbandingan rahasia (pencarian impor dan tes unit) | FR-09, D-16, TK-07, TK-08, NFR-21 |

**Kriteria wajib dari hasil Fase 2 (bukan catatan):** (a) semua perbandingan nilai rahasia memakai `safeEqual` dan ada tes unitnya serta aturan lint/Semgrep yang melarang `===` antara `Buffer` rahasia (M1-02); (b) `timingSafeEqual` tidak boleh dilewati dengan pembandingan string biasa pada rahasia klien `dev-idp`.

## 16. Di luar cakupan

Keycloak, Kong, Docker Compose, TLS antar-layanan, tiga jaringan Docker, Prometheus/Grafana dan pengukuran sumber daya (semua fase Docker, DK-xx), rotasi kunci otomatis, UI.

## 17. Keputusan spec (diterima Fanny, bawaan, Gerbang 3)

K-01 reason `DISCLOSURE_NOT_PENDING` 409 untuk approve/reject pada status selain PENDING (PRD diam). K-02 reason `TRANSACTION_NOT_FOUND` 404 untuk audit-request pada `transaction_id` tak dikenal. K-03 pembatasan `aud` token aktor (butir 7.6).
