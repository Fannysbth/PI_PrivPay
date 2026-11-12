# 02. Layanan satu per satu

Untuk tiap layanan: tugas, endpoint, tabel, port dan adapter, berkas kunci, dan **urutan baca yang disarankan**. Semua path dari akar repo. Semua layanan dibangun dari kerangka yang sama (lihat bagian `packages/common` di akhir), jadi struktur foldernya mirip:

```
services/<nama>/
  src/main.ts              4 baris: runService({ service, modules: <nama>Modules() })
  src/<nama>.module.ts     AKAR KOMPOSISI: baca config, bangun pool/klien, pilih adaptor menurut mode
  src/<nama>-http.ts       pemeriksa pemanggil + skema input (zod), tanpa logika bisnis
  src/<domain>/            logika bisnis; TIDAK boleh mengimpor folder mode
  src/proposed/            SQL dan adaptor khusus mode proposed
  src/baseline/            SQL dan adaptor khusus mode baseline
  migrations/{proposed,baseline}/   tabel per mode
  test/                    tes unit (*.spec.ts) dan integrasi (*.integration.spec.ts)
```

Dua aturan yang menjelaskan banyak hal:

- **Akar komposisi** (`*.module.ts`) adalah satu-satunya tempat yang boleh menyebut mode dan mengimpor folder `proposed/` atau `baseline/`. Itu dijaga oleh tes arsitektur [`tests/repo/mode-folders.spec.ts`](../../tests/repo/mode-folders.spec.ts) (ADR-0006).
- Setiap `*-http.ts` melakukan hal yang sama berurutan: **buktikan siapa pemanggil dulu, baru baca body**. Alasannya: layanan lain tidak boleh belajar apa pun tentang skema dari penolakan.

---

## Gateway (`services/gateway`)

**Tugas.** Pintu tunggal klien eksternal. Untuk tiap permintaan: bukti pemanggil (401), hitung laju per pemanggil (429), apakah rute ada (422), apakah perannya boleh (403), apakah ukuran dan bentuk benar (422), baru teruskan dengan kredensial yang ditentukan rute. Untuk rute yang membawa identitas, **tokenizer** mengganti `customer_id` dan nomor rekening menjadi token sebelum diteruskan. Urutan ini ditulis di komentar kelas `Gateway` ([`services/gateway/src/gateway.ts`](../../services/gateway/src/gateway.ts)) dan diputuskan di N-19.

**Endpoint** (tabel rute: [`services/gateway/src/routes.ts`](../../services/gateway/src/routes.ts); ID AZ dari [`docs/spec/endpoints.md`](../spec/endpoints.md)):

| Rute | Siapa | Ke mana |
| --- | --- | --- |
| `POST /register` (AZ-01, tanpa token) | anonim, dibatasi per alamat sumber | alur registrasi, `registration.ts` |
| `POST /notification/register` (AZ-02) | nasabah | Notification, dengan token domain P5 |
| `POST /transaction` (AZ-03) | nasabah | Transaction, dengan token P1 dan P2 |
| `GET /transaction/held`, `POST /transaction/{id}/review` (AZ-04, AZ-05) | analis fraud | Transaction |
| `POST /reconciliation/audit-request`, `POST /reconciliation/disclosure` (AZ-06, AZ-07) | auditor | Reconciliation |
| `POST /reconciliation/run` (AZ-08) | admin | Reconciliation |
| `POST /settlement/report` (AZ-09) | bank | Reconciliation, rekening menjadi token P6 |
| `POST /disclosure-requests`, `.../{id}/approve`, `.../{id}/reject` (AZ-10..12) | auditor, admin | Privacy, token manusia diteruskan apa adanya |
| `GET /audit-log`, `/audit-log/timeline/{pseudonym}`, `/audit-log/summary` (AZ-13..15) | auditor, admin | Privacy |
| `POST /pseudonym/{p}/revoke`, `POST /subject/revoke` (AZ-16, AZ-17) | admin | Privacy |
| `GET /health`, `GET /metrics` | internal | dilayani kerangka |

Rute di luar tabel dijawab 422 `VALIDATION_ERROR` bagi pemanggil yang sudah terbukti, dan 401 bagi yang belum (N-18): keberadaan rute tidak bisa dibaca secara anonim.

**Tabel.** Tidak punya database. Batas laju disimpan di memori (`RateLimiter`, jendela satu menit).

**Port dan adapter.**

| Port | Adapter | Mode |
| --- | --- | --- |
| `PrivacyPort` ([`tokenizer/privacy-port.ts`](../../services/gateway/src/tokenizer/privacy-port.ts)): `pseudonymize`, `pseudonymizeBatch` (P1+P2 satu panggilan, ADR-0019), `storeIdentity`, `revokeCustomer` | `HttpPrivacyPort` (memanggil Privacy; gagal tertutup bila 5xx atau jawaban bukan token) | proposed |
| | `PassthroughPrivacyPort` ([`baseline/passthrough-privacy-port.ts`](../../services/gateway/src/baseline/passthrough-privacy-port.ts)): mengembalikan `customer_id`/rekening apa adanya setelah memeriksa bentuknya; `storeIdentity` dan `revokeCustomer` tidak melakukan apa pun | baseline |
| | `FakePrivacyPort` (hanya untuk tes) | tes |

`Tokenizer` ([`tokenizer/tokenizer.ts`](../../services/gateway/src/tokenizer/tokenizer.ts)) murni: tidak tahu mode, hanya memakai `PrivacyPort`. Payload ke hilir dibangun dari daftar izin, bukan dengan menghapus field dari input. `nik`, `nama`, `email` boleh dikirim klien tetapi **dibuang** (FR-03).

**Berkas kunci, urutan baca:**

1. [`src/gateway.ts`](../../services/gateway/src/gateway.ts): kelas `Gateway.handle`, jantung urutan pemeriksaan.
2. [`src/routes.ts`](../../services/gateway/src/routes.ts): tabel rute, siapa boleh, skema tiap rute, `RouteTable.match`.
3. [`src/tokenizer/tokenizer.ts`](../../services/gateway/src/tokenizer/tokenizer.ts) dan [`schemas.ts`](../../services/gateway/src/tokenizer/schemas.ts): apa yang diganti jadi token.
4. [`src/registration.ts`](../../services/gateway/src/registration.ts): `RegistrationFlow.register` dan `compensate`.
5. [`src/gateway.module.ts`](../../services/gateway/src/gateway.module.ts): akar komposisi, satu ternary yang memilih port menurut mode.
6. [`src/error-masker.ts`](../../services/gateway/src/error-masker.ts) dan [`src/rate-limiter.ts`](../../services/gateway/src/rate-limiter.ts): dua komponen kecil.

Tes: `services/gateway/test/` (unit dan kontrak), `test/gateway-baseline.spec.ts`, dan E2E seluruh tumpukan di `test/e2e/`.

---

## dev-idp (`tools/dev-idp`)

**Tugas.** Penerbit JWT tiruan untuk fase lokal (pengganti Keycloak, ADR-0004, ADR-0007). Menolak start kecuali `NODE_ENV` adalah `development` atau `test`, `DEV_IDP_ENABLED=true`, dan hanya mengikat ke loopback.

**Endpoint.** `POST /token` (dua jenis: `client_credentials` untuk service account, `dev_login` untuk manusia), `GET /.well-known/jwks.json`, `POST /admin/users` dan `DELETE /admin/users/{customer_id}` (hanya klien `api-gateway`). Rincian di [`tools/dev-idp/README.md`](../../tools/dev-idp/README.md).

**Tabel.** Tidak ada; semuanya di memori. Setiap restart menerbitkan kunci RSA baru dan melupakan pelanggan yang dibuat lewat API admin.

**Isi token.** RS256, `iss=privpay-dev-idp`, `azp` (klien), `aud` (layanan tujuan, atau layanan di jalur peran bagi manusia), `roles` (manusia: tepat satu), `customer_id` hanya untuk `customer-app`. Masa berlaku maksimum 300 detik.

**Berkas kunci, urutan baca:**

1. [`src/registry.ts`](../../tools/dev-idp/src/registry.ts): siapa boleh minta token untuk audience apa (`SERVICE_AUDIENCES`, `CLIENT_ROLES`, `ROLE_AUDIENCES`).
2. [`src/identity-provider.ts`](../../tools/dev-idp/src/identity-provider.ts): `IdentityProvider.token`, `serviceToken`, `humanToken`, `createCustomer`.
3. [`src/http.ts`](../../tools/dev-idp/src/http.ts): skema ketat untuk `/token` dan `/admin/users`.
4. [`users.dev.json`](../../tools/dev-idp/users.dev.json) dan [`src/seed.ts`](../../tools/dev-idp/src/seed.ts): sembilan pengguna fiktif.

---

## Privacy Service (`services/privacy-service`)

**Tugas.** Satu-satunya pemegang pemetaan token ke subjek dan brankas identitas. Menerbitkan token (tiga bentuk), menukar token antar layanan, menerbitkan ulang token kedaluwarsa, menyelesaikan domain notifikasi, mencabut, menyimpan identitas, menjalankan alur pembukaan identitas empat mata, mencatat audit, dan menghapus identitas lama (retensi). **Hanya mode proposed.** Tidak memanggil layanan lain.

**Endpoint** (pengontrol di [`privacy.module.ts`](../../services/privacy-service/src/privacy.module.ts), logika di [`privacy-http.ts`](../../services/privacy-service/src/privacy-http.ts)):

| Endpoint | Pemanggil sah | Berkas logika |
| --- | --- | --- |
| `POST /pseudonymize` (tiga bentuk: identitas, pertukaran, dari transaksi) | Gateway; Transaction; Reconciliation | `token/token-service.ts`: `generate`, `exchange`, `generateFromTransaction` |
| `POST /pseudonymize/batch` (1 sampai 2 elemen bentuk 1; ADR-0019) | Gateway | `TokenService.generateBatch` |
| `POST /resolve-domain` | Notification | `TokenService.resolveDomain` |
| `POST /re-issue` | Transaction | `TokenService.reIssue` |
| `PATCH /transaction-status` | Transaction | `token/transaction-status.ts` |
| `POST /identity` | Gateway | `identity/identity-vault.ts`: `IdentityVault.store` |
| `POST /pseudonym/{p}/revoke`, `POST /subject/revoke` | admin lewat konsol; Gateway untuk kompensasi (ADR-0014) | `revocation/revocation-service.ts` |
| `POST /disclosure-requests`, `.../{id}/approve`, `.../{id}/reject` | auditor, admin | `disclosure/disclosure-service.ts` |
| `POST /de-pseudonymize` | Reconciliation atas nama auditor | `disclosure/de-pseudonymize-service.ts` |
| `GET /audit-log`, `/audit-log/timeline/{p}`, `/audit-log/summary` | auditor, admin | `audit/audit-log-service.ts`, `audit/audit-reader.ts` |

**Tabel** ([`migrations/proposed/`](../../services/privacy-service/migrations/proposed)): `pseudonym_mapping` (token, subjek terenkripsi, blind index, masa berlaku, status), `transaction_status`, `identity_vault` (NIK, nama, HP, rekening, `customer_id`, semuanya terenkripsi per kolom), `disclosure_request`, `audit_log` (append-only lewat hak akses), `transaction_link` (K-28, ADR-0013). Constraint penting: indeks unik parsial `uq_mapping_active` (satu token aktif per subjek, layanan, tujuan), `chk_four_eyes` (`approver_id <> requester_id`), `chk_purged`, `chk_mapping_complete`, `chk_attribute_names`. Hak akses di `0002_privacy_grants.sql`: peran aplikasi hanya `INSERT` pada `audit_log`, auditor hanya `SELECT`, tidak ada `DELETE` di mana pun kecuali `transaction_link`.

**Port dan adapter.** Privacy tidak punya klien keluar. Seamnya ke dalam:

- `AuditedOperation` ([`audit/audited-operation.ts`](../../services/privacy-service/src/audit/audited-operation.ts)): **satu jalur** untuk setiap operasi. Membuka transaksi, menjalankan pekerjaan, menulis tepat satu baris audit di transaksi yang sama, lalu commit. Penolakan yang merupakan keputusan dilempar sebagai `DeniedOperation` dan meninggalkan satu baris `DENIED` (transaksi penolakan sendiri, karena transaksi operasi sudah di-rollback).
- Dua pool database: peran aplikasi (menulis) dan peran auditor (hanya membaca audit).
- `PolicyEngine` ([`policy/policy-engine.ts`](../../services/privacy-service/src/policy/policy-engine.ts)) dengan tabel di [`policy/tables.ts`](../../services/privacy-service/src/policy/tables.ts): murni, tanpa I/O.

**Berkas kunci, urutan baca:**

1. [`src/policy/tables.ts`](../../services/privacy-service/src/policy/tables.ts) lalu [`policy-engine.ts`](../../services/privacy-service/src/policy/policy-engine.ts): Tabel 1, 2, 3, 5, 6 sebagai kode.
2. [`src/crypto/`](../../services/privacy-service/src/crypto): `keys.ts` (tiga kunci), `derive.ts` (`TokenMint`, `BlindIndex`), `parts.ts` (pengodean dan AAD), `field-cipher.ts` (AES-GCM). Dibahas di [04](04-keamanan.md).
3. [`src/audit/audited-operation.ts`](../../services/privacy-service/src/audit/audited-operation.ts) dan [`audit-entry.ts`](../../services/privacy-service/src/audit/audit-entry.ts).
4. [`src/token/token-service.ts`](../../services/privacy-service/src/token/token-service.ts): `issue` (inti penerbitan, kunci penasihat, token dipakai ulang), lalu `exchange`.
5. [`src/disclosure/disclosure-service.ts`](../../services/privacy-service/src/disclosure/disclosure-service.ts) lalu [`de-pseudonymize-service.ts`](../../services/privacy-service/src/disclosure/de-pseudonymize-service.ts).
6. [`src/revocation/`](../../services/privacy-service/src/revocation), [`src/retention/retention-job.ts`](../../services/privacy-service/src/retention/retention-job.ts), [`src/identity/identity-vault.ts`](../../services/privacy-service/src/identity/identity-vault.ts).
7. [`migrations/proposed/*.sql`](../../services/privacy-service/migrations/proposed): cocokkan dengan kode di atas.

Tes: `services/privacy-service/test/` (termasuk `security/` untuk TK-xx dan `pii-scan.integration.spec.ts`).

---

## Transaction (`services/transaction-service`)

**Tugas.** Memproses `POST /transaction` secara idempoten, mengorkestrasi Fraud dan Notification, mengabari Privacy tentang status, menyediakan antrean transaksi `HELD` dan keputusan analis, menyapu transaksi `PENDING` yang macet, dan melayani Reconciliation dengan data transaksi tanpa identitas.

**Endpoint** ([`transaction.module.ts`](../../services/transaction-service/src/transaction.module.ts)): `POST /transaction` (Gateway), `GET /transaction/held` dan `POST /transaction/{id}/review` (Gateway atas nama analis), `GET /transaction/completed?date=` dan `GET /transaction/{id}` (Reconciliation; di baseline jawaban kedua memuat `account_number`, N-46).

**Tabel** (`migrations/proposed/`, `migrations/baseline/`): `merchants` (tiga pedagang fiktif), `transactions`. Di proposed kolomnya `customer_pseudonym` dan `account_pseudonym`; di baseline `customer_id` dan `account_number`. Kolom `privacy_synced_at` dan `privacy_rejected_at` menandai apakah Privacy sudah mendengar status akhir (migrasi proposed 0003 dan 0004).

**Port dan adapter** ([`transaction/ports.ts`](../../services/transaction-service/src/transaction/ports.ts)):

| Port | Adapter proposed | Adapter baseline |
| --- | --- | --- |
| `SubjectReferencePort` (`forFraud`, `forNotification`, `reissue`) | `ProposedSubjectReferences`: tukar token lewat Privacy | `BaselineSubjectReferences`: menyerahkan `customer_id` apa adanya |
| `PrivacyStatusClient` (`patchStatus`) | `HttpPrivacyClient` | `BaselinePrivacyStatus`: tidak melakukan apa pun |
| `FraudClient`, `NotificationClient` | `HttpFraudClient`, `HttpNotificationClient` (sama di kedua mode) | sama |
| `TransactionRepository` + `SubjectSql` | `proposed/subject-sql.ts` | `baseline/subject-sql.ts` |

**Berkas kunci, urutan baca:**

1. [`src/transaction/ports.ts`](../../services/transaction-service/src/transaction/ports.ts): seam mode. Baca komentar paling atas dulu.
2. [`src/transaction/processor.ts`](../../services/transaction-service/src/transaction/processor.ts): `process`, `orchestrate`, `decide`, `replay` (idempotensi, ADR-0009).
3. [`src/transaction/followups.ts`](../../services/transaction-service/src/transaction/followups.ts): `notify`, `patchPrivacy`, `withReissue`.
4. [`src/transaction/status-machine.ts`](../../services/transaction-service/src/transaction/status-machine.ts), [`repository.ts`](../../services/transaction-service/src/transaction/repository.ts) (`TRANSACTION_SQL`, `SubjectSql`).
5. [`src/transaction/review.ts`](../../services/transaction-service/src/transaction/review.ts), [`sweeper.ts`](../../services/transaction-service/src/transaction/sweeper.ts), [`reads.ts`](../../services/transaction-service/src/transaction/reads.ts).
6. [`src/transaction.module.ts`](../../services/transaction-service/src/transaction.module.ts): bagaimana mode memilih adaptor (`httpNeighbours`).

Tes: `services/transaction-service/test/` (termasuk `mode.integration.spec.ts` dan `baseline-repository.integration.spec.ts`).

---

## Fraud (`services/fraud-service`)

**Tugas.** Menilai risiko satu transaksi dari riwayat penilaian sebelumnya milik pelanggan yang sama. Tidak memanggil siapa pun.

**Endpoint.** `POST /fraud/assess` (hanya Transaction). Input: `pseudonym` (di baseline berisi `customer_id`; nama field kawat tidak berubah), `amount`, `tx_hour`, `geohash`. Output: `risk_score`, `decision`, `rules_fired`, `rules_skipped`, `prior_count`.

**Tabel.** `fraud_assessments` (kunci riwayat: `pseudonym` di proposed, `customer_id` di baseline; tanpa `transaction_id`, supaya tidak bisa di-join ke Transaction), `risk_rules` (bobot dan aktif/tidak, dibaca saat runtime).

**Aturan** ([`risk/engine.ts`](../../services/fraud-service/src/risk/engine.ts), `RiskEngine.evaluate`, murni): `AMOUNT_OVER_THRESHOLD` (+10), `ODD_HOUR_OUTSIDE_06_22` (+20), `AMOUNT_OVER_3X_AVG` (+25), `NEW_LOCATION_VS_LAST_3` (+20); bobot dari tabel `risk_rules`. Pada **cold start** (riwayat kosong) dua aturan terakhir dilewati. Skor >= `FRAUD_HOLD_THRESHOLD` (50) menjadi `HOLD_FOR_VERIFICATION`; >= `FRAUD_BLOCK_THRESHOLD` (90) menjadi `BLOCK`. Skor maksimum 75, jadi `BLOCK` tidak tercapai dengan bobot bawaan (keterbatasan PRD 20, diuji dengan mengubah bobot).

**Jendela riwayat.** Riwayat hanya mencakup `FRAUD_HISTORY_DAYS` (30) hari terakhir di kedua mode, dinyatakan di SQL (`assessed_at >= $2`; N-45).

**Port dan adapter.** `AssessmentRepository` + `SubjectSql`; `FraudAssessor` ([`risk/assessor.ts`](../../services/fraud-service/src/risk/assessor.ts)) menggabungkan riwayat, aturan, dan penulisan satu baris.

**Urutan baca:** `risk/engine.ts`, `risk/assessor.ts`, `risk/repository.ts`, `proposed/subject-sql.ts` dibanding `baseline/subject-sql.ts`, `fraud.module.ts`, `fraud-http.ts`.

---

## Notification (`services/notification-service`)

**Tugas.** Menyimpan nomor HP per pelanggan (satu-satunya data pribadi di luar Privacy dan IdP, keputusan D-08) dan mengirim SMS generik dengan teks tetap berisi jumlah, tanpa nama atau rekening.

**Endpoint.** `POST /notification/register` (Gateway; upsert menurut kunci pelanggan) dan `POST /notification/send` (Transaction). Pada send, kegagalan Privacy atau SMS dijawab `FAILED`, bukan galat: transaksi tetap `COMPLETED`.

**Tabel.** `contact_registry` (kunci: token domain P5 di proposed, `customer_id` di baseline; `phone`), `notification_log` (pengirim, penerima, templat, status; tanpa isi pesan). Di baseline kolom log bernama `sender_customer_id` dan `recipient_customer_id` (N-42).

**Port dan adapter.**

| Port | Adapter proposed | Adapter baseline |
| --- | --- | --- |
| `PrivacyClient.resolveDomain` ([`notification/service.ts`](../../services/notification-service/src/notification/service.ts)) | `HttpPrivacyClient`: `POST /resolve-domain` | `BaselinePrivacyClient`: mengembalikan token apa adanya |
| `SmsGateway.send` | `HttpSmsGateway` ke sms-simulator (sama di kedua mode) | sama |
| `ContactRepository` + `SubjectSql` | `proposed/subject-sql.ts` | `baseline/subject-sql.ts` |

**Urutan baca:** `notification/service.ts` (`NotificationService.send`), `notification/contacts.ts`, `notification/adapters.ts`, `notification-http.ts`, `notification.module.ts`.

**sms-simulator** (`services/sms-simulator`): menerima `POST /sms` hanya dari Notification, menyimpan pesan di memori. Endpoint `GET`/`DELETE /__test/messages` hanya dipasang bila `SMS_SIMULATOR_TEST_ENDPOINTS=true`; bila mati, rute itu tidak ada dan dijawab 422 seragam (N-30).

---

## Reconciliation (`services/reconciliation-service`)

**Tugas.** (1) Menyimpan laporan penyelesaian bank dan mencocokkannya dengan transaksi `COMPLETED` hari itu. (2) Audit rutin: mengembalikan token P7 dan data transaksi, tanpa identitas (D-01). (3) Meneruskan pembukaan identitas ke Privacy dengan token auditor.

**Endpoint.** `POST /reconciliation/settlement-report` (Gateway), `POST /reconciliation/run` (admin), `POST /reconciliation/audit-request` dan `POST /reconciliation/disclosure` (auditor). Ada juga penjadwal harian `RECON_DAILY_RUN_UTC` yang menjalankan `run` untuk kemarin.

**Tabel.** `settlement_batches` (satu per tanggal), `settlement_items` (token rekening di proposed, `account_number` di baseline, jumlah, referensi bank, `matched`), `audit_requests` (alasan berkode dan pelaku; tanpa teks bebas).

**Cara mencocokkan** ([`reconciliation/reconciler.ts`](../../services/reconciliation-service/src/reconciliation/reconciler.ts), `match`, murni): pasangan `(rujukan rekening, jumlah)` satu lawan satu; transaksi dengan id terkecil mengambil referensi bank terkecil, jadi hasilnya deterministik. Status: `MATCHED` bila tak ada selisih, `MISMATCHED` bila tak ada yang cocok padahal ada data, selain itu `PARTIAL` (K-22).

**Port dan adapter** ([`reconciliation/ports.ts`](../../services/reconciliation-service/src/reconciliation/ports.ts)):

| Port | Adapter proposed | Adapter baseline |
| --- | --- | --- |
| `PrivacyClient` (`accountSubjectRef`, `auditToken`, `open`) | `HttpPrivacyClient` ([`clients.ts`](../../services/reconciliation-service/src/reconciliation/clients.ts)) | `BaselinePrivacyClient` ([`baseline/privacy-client.ts`](../../services/reconciliation-service/src/baseline/privacy-client.ts)): rekening dari `byId` Transaction; `auditToken` dan `open` menjawab 503 |
| `TransactionClient` (`completedOn`, `byId`) | `HttpTransactionClient` | sama |
| `ReconciliationRepository` + `SubjectSql` | `proposed/` | `baseline/` |

**Urutan baca:** `reconciliation/service.ts` (`run`, `auditRequest`, `disclose`), `reconciler.ts`, `repository.ts`, `clients.ts`, `reconciliation-http.ts`, `reconciliation.module.ts`.

**bank-simulator** (`services/bank-simulator`): `POST /simulate/settlement` membangun laporan seed (rekening `1234567801` 35.000 dan `1234567803` 1.500.000) dengan kesalahan yang bisa disuntik (`EMPTY_ACCOUNT`, `NEGATIVE_AMOUNT`, `UNPAIRED`) lalu mengirimnya ke Gateway sebagai bank. Rutenya tidak ada kecuali `BANK_SIMULATOR_TEST_ENDPOINTS=true`.

---

## `packages/common`

Pustaka bersama, bukan layanan. Urutan baca yang saya sarankan, dari yang paling sering ketemu:

| Berkas | Isi | Mengapa penting |
| --- | --- | --- |
| [`src/mode.ts`](../../packages/common/src/mode.ts) | `PrivacyMode`, `assertBaselineMode`, `subjectRefShape`, `privacyUrlMatchesMode`, `privacyBaseUrl` | seluruh aturan mode di satu tempat |
| [`src/config.ts`](../../packages/common/src/config.ts) | `loadConfig` (validasi zod, hanya nama variabel dilaporkan), `readSecret`, `readKey` (rahasia hanya dari berkas `*_FILE`) | gagal cepat dan tanpa membocorkan nilai |
| [`src/errors.ts`](../../packages/common/src/errors.ts) | `DomainError`, `REASONS`, delapan kode klien, `toWireError` vs `toClientError` | satu bentuk error di mana-mana (ADR-0008) |
| [`src/authenticate.ts`](../../packages/common/src/authenticate.ts), [`jwt.ts`](../../packages/common/src/jwt.ts), [`jwks.ts`](../../packages/common/src/jwks.ts) | verifikasi JWT RS256, `authenticate` (pola dua token), cache kunci publik | dasar semua otorisasi (ADR-0007) |
| [`src/http.ts`](../../packages/common/src/http.ts) | `createHttpClient`: timeout 3 detik, maksimum 2 percobaan ulang hanya untuk operasi idempoten, jalur dan token divalidasi | NFR-12 |
| [`src/db.ts`](../../packages/common/src/db.ts), [`migrate.ts`](../../packages/common/src/migrate.ts), [`db-migrate.ts`](../../packages/common/src/db-migrate.ts) | `SERVICE_DBS`, `createPool`, `withTransaction`, runner migrasi sendiri (tanpa ORM) | satu database per layanan |
| [`src/logger.ts`](../../packages/common/src/logger.ts) | logger yang hanya menerima field dari daftar izin dan memvalidasi bentuknya | invarian log |
| [`src/clock.ts`](../../packages/common/src/clock.ts), [`delay.ts`](../../packages/common/src/delay.ts), [`scheduler.ts`](../../packages/common/src/scheduler.ts) | `Clock`/`FakeClock`, penantian yang bisa diinjeksi, penjadwal job | waktu selalu disuntik, tes tanpa `sleep` |
| [`src/token-cache.ts`](../../packages/common/src/token-cache.ts), [`safe-equal.ts`](../../packages/common/src/safe-equal.ts) | cache token layanan, perbandingan rahasia waktu-tetap | NFR-21, S-33 |
| [`src/nest/service-app.ts`](../../packages/common/src/nest/service-app.ts), [`run-service.ts`](../../packages/common/src/nest/run-service.ts) | kerangka semua layanan: `/health`, `/metrics`, format error, satu baris log per permintaan, mati anggun | `main.ts` tiap layanan hanya memanggil `runService` |
| [`src/testing/`](../../packages/common/src/testing) | `createTestDb`, `FakeTimers`, pembersih database tes | dipakai tes integrasi, bukan produksi |

Kebiasaan penting yang akan terus ketemu: **konfigurasi lewat zod dan gagal cepat**, **rahasia dari berkas**, **waktu lewat `Clock`**, **error lewat `DomainError(reason, cause)`** dengan `cause` berupa kategori pendek (tidak pernah nilai), dan **`PRIVACY_MODE` dibaca lewat `modeConfigShape`** di skema tiap layanan.
