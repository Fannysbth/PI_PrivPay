# Tiket

Dipecah dari `docs/spec/` (Fase 4). Setiap tiket satu berkas, satu cabang, satu PR kecil. Keterlacakan FR/NFR/TF/TK ke tiket ke tes: `docs/spec/00-traceability.md`; daftar endpoint, peran, dan tes otorisasi negatif: `docs/spec/endpoints.md`. Skill `to-tickets` dan `implement` tidak tersedia di sesi ini; tiket dibuat manual dengan disiplin yang sama.

## Definisi selesai per tiket (CLAUDE.md)

- [ ] Kriteria penerimaan terpenuhi dan tiap kriteria punya tes yang merujuk ID-nya.
- [ ] Tes ditulis lebih dulu dan terbukti gagal dengan alasan yang benar (merah lalu hijau); seam yang diuji disepakati sebelum tes ditulis.
- [ ] lint, typecheck, test, test:integration, audit dependensi, dan pemindaian secret (`gitleaks`) hijau; keluarannya ditampilkan.
- [ ] Tidak ada PII di log, audit, atau fixture (pemindai kenari lulus bila sudah ada).
- [ ] Jalur error dan batas waktu sesuai `docs/qa/qa-checklist.md`.
- [ ] `/code-review` dijalankan; temuan valid diperbaiki, yang ditolak dijelaskan.
- [ ] Dokumentasi, ADR, CHANGELOG, dan bagian Perintah di CLAUDE.md diperbarui.
- [ ] PR kecil: deskripsi menjelaskan perubahan dan bukti; dependensi baru disertai alasan, lisensi, hasil `pnpm audit`.
- [ ] Untuk tiket endpoint: tes otorisasi negatif `AZ-nn` (N1 tanpa kredensial, N2 pemanggil/peran salah, N3 field tak dikenal, N4 `requesting_service` palsu).

## Urutan dan ketergantungan

Gerbang M5 tetap berlaku: tidak ada pengukuran performa sebelum mode baseline dan proposed sama-sama berjalan. M7 dan seluruh DK bergantung pada Docker (ADR-0004). Di M0, urutan pengerjaan: M0-01, M0-02, M0-03, M0-05, M0-04, M0-06, M0-07 (runner migrasi membutuhkan harness DB dari M0-05).

### M0

| Tiket | Judul | Ukuran | Bergantung pada | Cara |
| --- | --- | --- | --- | --- |
| [M0-01](M0-01-workspace-tooling.md) | Workspace, tooling, dan skeleton monorepo | M | - | /implement |
| [M0-02](M0-02-common-core.md) | `common`: config, Clock, error, logger berredaksi | M | M0-01 | /implement |
| [M0-03](M0-03-common-http-client.md) | `common`: klien HTTP antar-layanan (timeout, retry, request id) | M | M0-02 | /implement |
| [M0-05](M0-05-db-bootstrap-harness.md) | Bootstrap DB multi-layanan dan harness DB tes | M | M0-02 | /implement |
| [M0-04](M0-04-migration-runner.md) | Runner migrasi maju-saja | M | M0-05 | /implement |
| [M0-06](M0-06-service-skeletons.md) | Skeleton layanan (health, metrics, shutdown, env) dan simulator | L | M0-02 | /implement |
| [M0-07](M0-07-ci-pipeline.md) | CI: lint, typecheck, unit, integrasi, audit, gitleaks, SAST | M | M0-01, M0-04 | /implement |

### M1

| Tiket | Judul | Ukuran | Bergantung pada | Cara |
| --- | --- | --- | --- | --- |
| [M1-01](M1-01-dev-idp.md) | `dev-idp`: penerbit JWT tiruan khusus dev | M | M0-06 | /implement |
| [M1-02](M1-02-auth-two-tokens.md) | `common`: `authenticate` (dua token) dan `safeEqual` | M | M1-01 | /implement |
| [M1-03](M1-03-gateway-core.md) | `gateway-adapter` inti: JWT, laju, rute, penyamaran error | L | M1-02, M0-06 | /implement |

### M2

| Tiket | Judul | Ukuran | Bergantung pada | Cara |
| --- | --- | --- | --- | --- |
| [M2-01](M2-01-privacy-db-migrations.md) | Migrasi privacy-db dan hak akses per peran | M | M0-04 | /implement |
| [M2-02](M2-02-crypto-module.md) | Modul `Crypto`: AES-GCM dengan AAD baris, blind index, token, kunci | M | M1-02 | /implement |
| [M2-03](M2-03-policy-engine.md) | `PolicyEngine`: Tabel 1, 2, 3, 5, 6 sebagai konfigurasi | M | M1-02 | /implement |
| [M2-04](M2-04-audit-writer-two-pools.md) | `AuditWriter`/`AuditReader` dan dua pool koneksi | M | M2-01, M0-05 | /implement |
| [M2-05](M2-05-buat-token-generate.md) | `buat_token` dan `POST /pseudonymize` bentuk 1 | L | M2-02, M2-03, M2-04 | /implement |
| [M2-06](M2-06-exchange-and-from-transaction.md) | `POST /pseudonymize` bentuk 2 (pertukaran) dan bentuk 3 (dari transaksi) | M | M2-05 | /implement |
| [M2-07](M2-07-re-issue-transaction-status.md) | `POST /re-issue` dan `PATCH /transaction-status` | M | M2-05 | /implement |
| [M2-08](M2-08-identity-vault.md) | `POST /identity` dan brankas identitas | M | M2-02, M2-04 | /implement |
| [M2-09](M2-09-retention-job.md) | Job retensi | M | M2-05 | /implement |
| [M2-10](M2-10-canary-scanner-v1.md) | Pemindai kenari v1 | M | M0-06 | /implement |
| [M2-11](M2-11-gateway-tokenizer.md) | Modul `Tokenizer` dan rute tokenisasi (transaksi, settlement) | L | M1-03, M2-05, M2-10 | /implement |

### M3

| Tiket | Judul | Ukuran | Bergantung pada | Cara |
| --- | --- | --- | --- | --- |
| [M3-01](M3-01-resolve-domain.md) | `POST /resolve-domain` | S | M2-06 | /implement |
| [M3-02](M3-02-revoke-token-subject.md) | Pencabutan token dan subjek | M | M2-08, M2-05 | /implement |
| [M3-03](M3-03-audit-log-read.md) | `GET /audit-log`, timeline, summary | M | M2-04, M3-02 | /implement |
| [M3-04](M3-04-disclosure-workflow.md) | Alur permintaan pembukaan identitas | L | M3-03, M2-06 | /implement |
| [M3-05](M3-05-de-pseudonymize.md) | `POST /de-pseudonymize` lima gerbang | L | M3-04, M2-08 | /implement |
| [M3-06](M3-06-privacy-security-suite.md) | Suite keamanan sisi Privacy (dua lapis) | M | M3-05, M2-11 | /implement |

### M4

| Tiket | Judul | Ukuran | Bergantung pada | Cara |
| --- | --- | --- | --- | --- |
| [M4-01](M4-01-transaction-core-idempotency.md) | Transaction inti dan idempotensi | L | M2-11, M0-04 | /implement |
| [M4-02](M4-02-transaction-orchestration.md) | Orkestrasi Transaction (Fraud, Notification, re-issue, status) | L | M4-01, M4-04, M4-05, M2-07 | /implement |
| [M4-03](M4-03-transaction-review-held.md) | Review, daftar `HELD`, pembersih `PENDING` | M | M4-02 | /implement |
| [M4-04](M4-04-fraud-service.md) | Fraud Service | M | M0-04, M2-11 | /implement-spec |
| [M4-05](M4-05-notification-sms-simulator.md) | Notification dan SMS simulator | M | M0-04, M3-01 | /implement-spec |
| [M4-06](M4-06-reconciliation-core-bank-sim.md) | Reconciliation inti dan bank simulator | L | M4-01, M2-11 | /implement-spec |
| [M4-07](M4-07-reconciliation-audit-disclosure.md) | Audit-request dan pemicu pembukaan | M | M4-06, M3-05 | /implement |
| [M4-08](M4-08-registration-flow.md) | Alur pendaftaran di Gateway | M | M2-08, M4-05, M1-01 | /implement |
| [M4-09](M4-09-e2e-scenarios.md) | Skenario ujung ke ujung TX-10001..10003 | M | M4-02, M4-03, M4-06, M4-08 | /implement |
| [M4-10](M4-10-job-scheduler.md) | Penjadwalan job berkala (retensi, pembersih, harian) | M | M2-09, M4-03, M4-06 | /tdd |

### M5

| Tiket | Judul | Ukuran | Bergantung pada | Cara |
| --- | --- | --- | --- | --- |
| [M5-01](M5-01-baseline-schemas-repos.md) | Skema dan repositori baseline semua layanan | L | M4-09 | /implement-spec |
| [M5-02](M5-02-mode-switch-equivalence.md) | Pengalih mode dan tes kesetaraan perilaku | M | M5-01 | /implement |
| [M5-03](M5-03-gateway-baseline-mode.md) | Gateway mode baseline | S | M5-02, M2-11 | /implement |

### M6

| Tiket | Judul | Ukuran | Bergantung pada | Cara |
| --- | --- | --- | --- | --- |
| [M6-01](M6-01-newman-collections.md) | Koleksi Newman untuk kedua mode | M | M5-03, M3-06 | /implement |
| [M6-02](M6-02-exposure-metrics.md) | E(s), kelas data, presisi/recall | M | M2-10, M5-03 | /implement |
| [M6-03](M6-03-linkage-test.md) | Uji penautan baseline vs proposed | M | M6-02 | /implement |
| [M6-04](M6-04-fail-closed-test.md) | Uji gagal tertutup (proses Privacy dimatikan) | S | M2-11, M2-10 | /implement |

### M7

| Tiket | Judul | Ukuran | Bergantung pada | Cara |
| --- | --- | --- | --- | --- |
| [M7-01](M7-01-k6-performance.md) | Skrip k6 dan pengukuran performa (ditunda) | L | M6-01, DK-01, DK-02 | /implement |

### Fase Docker (DK)

| Tiket | Judul | Ukuran | Bergantung pada | Cara |
| --- | --- | --- | --- | --- |
| [DK-01](DK-01-docker-compose.md) | Docker Compose dan secret | L | M4-09 | /implement |
| [DK-02](DK-02-kong-plugin.md) | Plugin Kong `privacy-tokenizer` (P-1) | L | DK-01, M2-11 | /implement |
| [DK-03](DK-03-networks-tls.md) | Tiga jaringan Docker dan TLS (NFR-06) | M | DK-01 | /implement |
| [DK-04](DK-04-keycloak.md) | Keycloak: realm, klien, pemetaan klaim | M | DK-01, M1-02 | /implement |
| [DK-05](DK-05-postgres-16-rerun.md) | Ulang tes skema di PostgreSQL 16 | S | DK-01 | /implement |
| [DK-06](DK-06-clean-machine-fail-closed.md) | NFR-19 mesin bersih dan fail-closed dengan Privacy dimatikan | M | DK-01, M6-04 | /implement |

## Rekomendasi cara kerja per milestone

- **`/implement` (berurutan)** untuk M0, M1, M2, M3: tiket saling bergantung dan menyentuh berkas bersama (`packages/common`, nomor migrasi, `pnpm-lock.yaml`).
- **`/implement-spec` (paralel, satu subagen satu tiket)** hanya untuk M4-04 (Fraud), M4-05 (Notification), M4-06 (Reconciliation) setelah M4-01 selesai, dan untuk M5-01 per layanan. Syaratnya: tiap subagen memegang tepat satu tiket, mengikuti CLAUDE.md, tidak menyentuh berkas bersama (compose, `packages/common`, nomor migrasi) kecuali tiketnya memberi kepemilikan, dan koordinator menjalankan tes sendiri sebelum menerima hasil.
- Karena kedua skill tidak tersedia, "paralel" berarti subagen biasa dengan aturan yang sama, atas persetujuan di Gerbang milestone.

## GitHub issue

Tiket belum dibuat sebagai GitHub issue. Atas persetujuan Fanny, tiap berkas ini dapat dijadikan issue dengan judul `<ID>: <judul>` dan isi berkasnya; tidak dilakukan sebelum disetujui.
