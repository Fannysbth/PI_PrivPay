# Spesifikasi: data dan migrasi

Sumber: PRD 11 (skema final), 12, 16; ADR-0002, 0006, 0010, 0011; keputusan E-06. DDL PRD 11 berlaku apa adanya kecuali perubahan yang tercantum di bawah (**[Δ PRD]**). Satu layanan satu basis data, tanpa foreign key lintas basis data (invarian 4).

## 1. Tanggung jawab

Menetapkan skema, peran basis data dan hak aksesnya, indeks, batasan (CHECK/UNIQUE), perbedaan skema per mode, dan data awal (seed) yang boleh ada. Alat migrasi: `platform-dan-ci.md` bagian 10.

## 2. Aturan umum

- PostgreSQL (target 16, lokal 18, ADR-0004); waktu `TIMESTAMPTZ`, selalu UTC; uang `NUMERIC(18,2)` (rupiah bilangan bulat, qa C-12); tipe `uuid` untuk `id`.
- SQL berparameter saja. Hak akses minimal: aplikasi tidak pernah terhubung sebagai pemilik skema.
- Migrasi per mode (ADR-0006): `migrations/common/` (tabel yang sama di kedua mode), `migrations/proposed/`, `migrations/baseline/`. Mode `baseline` **tidak** menjalankan migrasi Privacy Service (Privacy tidak dipanggil, PRD 17); basis data privacy tidak dipakai di mode itu.
- **Identifier baris untuk kripto [Δ PRD, ADR-0011]:** kolom `id` pada `pseudonym_mapping` dan `identity_vault` dibangkitkan **aplikasi** (UUID v4) sebelum INSERT karena menjadi bagian AAD; `DEFAULT gen_random_uuid()` tetap ada sebagai jaring pengaman tetapi tidak dipakai jalur normal.

## 3. Peran basis data (E-22, ADR-0004)

| Basis data | Pemilik skema | Runtime | Lainnya |
| --- | --- | --- | --- |
| `privpay_privacy` | `privpay_privacy_owner` | `privpay_app` (`privacy_app` pada PRD) | `privpay_auditor` (`auditor_role` pada PRD) |
| `privpay_transaction` | `privpay_transaction_owner` | `privpay_transaction_app` | |
| `privpay_fraud` | `privpay_fraud_owner` | `privpay_fraud_app` | |
| `privpay_notification` | `privpay_notification_owner` | `privpay_notification_app` | |
| `privpay_reconciliation` | `privpay_reconciliation_owner` | `privpay_reconciliation_app` | |

`privpay_test_admin` (CREATEDB, anggota semua peran pemilik) membuat ulang database `privpay_<svc>_test`. Tidak ada superuser PrivPay. Kata sandi peran dibangkitkan ke `secrets/privpay_<peran>_password` dan dibaca lewat `*_FILE`.

## 4. privacy-db

DDL PRD 11 (`pseudonym_mapping`, `transaction_status`, `audit_log`, `identity_vault`, `disclosure_request`) berlaku, dengan perubahan:

**[Δ PRD] `audit_log`** (E-06):

- Tambah `disclosure_id UUID REFERENCES disclosure_request(id)` dan `attribute_names TEXT[]` dengan `CONSTRAINT chk_attribute_names CHECK (attribute_names IS NULL OR attribute_names <@ ARRAY['customer_id','nik','nama']::text[])`. Diverifikasi di prototipe P-3: `{'hp'}` dan teks bebas ditolak (`23514`).
- `disclosure_request` harus dibuat sebelum `audit_log` (urutan migrasi).
- `reason VARCHAR(32)` memuat semua reason baru (terpanjang `DISCLOSURE_NOT_APPROVED`, 23 karakter). `action VARCHAR(32)`: katalog di `privacy-service.md` bagian 9.
- Kolom `prev_hash` dan `row_hash` tetap nullable dan tidak diisi (rantai hash hanya dirancang, bagian 9.3).

**Hak akses (diuji dengan peran asli, bukan diasumsikan):**

```sql
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO privpay_app, privpay_auditor;
REVOKE UPDATE, DELETE ON audit_log FROM privpay_app;           -- TK-10
GRANT  INSERT          ON audit_log TO   privpay_app;
GRANT  SELECT          ON audit_log TO   privpay_auditor;
GRANT  SELECT, INSERT, UPDATE ON pseudonym_mapping, transaction_status, identity_vault, disclosure_request TO privpay_app;
REVOKE ALL ON identity_vault FROM privpay_auditor;             -- S-35
```

Hasil prototipe: `privpay_app` tidak dapat UPDATE/DELETE/TRUNCATE `audit_log` dan tidak dapat membacanya; `privpay_auditor` hanya SELECT pada `audit_log` dan tidak dapat membaca `identity_vault` maupun `pseudonym_mapping`; `chk_four_eyes` menolak `approver_id = requester_id` meski ditulis langsung. Tidak ada `DELETE` untuk `privpay_app` pada tabel mana pun (penghapusan fisik di luar cakupan), kecuali `transaction_link` (migrasi 0003, ADR-0013: retensi menghapus tautan bersama pengosongan identitas barisnya).

**Indeks:** semua indeks PRD 11 (`uq_mapping_active` unik parsial `WHERE status='active'`, `idx_mapping_pseudonym`, `idx_mapping_expiry`, `idx_mapping_tx`, `idx_mapping_purge`, `idx_audit_*`). Pencarian utama wajib memakai indeks (NFR-04), diverifikasi dengan `EXPLAIN` pada ≥ 20.000 baris dengan pengaturan planner bawaan (lulus di prototipe).

**Kolom kripto** (`pseudonym_mapping.subject_id_enc`, `identity_vault.*_enc`): `key_version(uint16 BE) || IV(12) || ciphertext || tag(16)`; AAD terikat baris, lihat `privacy-service.md` bagian 5. Dump basis data tidak boleh menampilkan plaintext (FR-25).

**Batasan yang ditegakkan basis data:** `chk_purged`, `chk_vault_purged`, `chk_mapping_complete`, `chk_vault_complete`, `chk_four_eyes`, `chk_disclosure_decided`, `chk_requested_attrs` (tiga terakhir tambahan N-24, E-29), `chk_attribute_names`, `UNIQUE (pseudonym)`, `UNIQUE (customer_lookup)`. Pengosongan setengah (hanya `purged_at`) ditolak `23514` (diuji).

## 5. transaction-db (mode proposed)

DDL PRD 11 apa adanya: `merchants`, `transactions` (dengan `idempotency_key VARCHAR(64) UNIQUE`). Tidak ada kolom `fraud_token` maupun `notif_token`. Tidak ada kolom identitas (FR-16, S-38).

- `transactions.status`: `PENDING`, `COMPLETED`, `HELD`, `FAILED`. `CHECK` pada nilai status dan pada `fraud_decision` (`ALLOW`, `HOLD_FOR_VERIFICATION`, `BLOCK`, `FRAUD_UNAVAILABLE`) ditambahkan **[K-04]** (PRD tidak memuat CHECK; tujuannya mencegah nilai bebas).
- Idempotensi (ADR-0009): perbandingan memakai kolom `customer_pseudonym`, `account_pseudonym`, `merchant_id`, `amount`, `geohash`; tidak ada kolom sidik jari.
- Seed: tiga merchant (`MRC-001..003`) dari PRD 16.

## 6. fraud-db

DDL PRD 11: `fraud_assessments` (tanpa `transaction_id`), `risk_rules`. Seed `risk_rules` (bobot dan parameter dari PRD 10/16) dan, hanya pada data uji, riwayat awal `h01` dan `h02`. Indeks `idx_fraud_profile (pseudonym, assessed_at DESC)`.

## 7. notification-db

DDL PRD 11: `contact_registry (pseudonym PK, phone, channel, registered_at)`, `notification_log` (tanpa isi pesan). `phone` adalah satu-satunya PII asli di luar Privacy dan IdP (D-08); kolom `channel` `CHECK (channel IN ('SMS'))`.

## 8. reconciliation-db

DDL PRD 11: `settlement_batches`, `settlement_items`, `audit_requests`. Tidak ada nomor rekening dan tidak ada hasil pembukaan identitas (T-14).

- `settlement_items`: tambah `UNIQUE (batch_id, bank_reference)` **[K-05]** untuk mencegah item ganda dalam satu batch (PRD hanya menyebut `bank_reference` tanpa keunikan).
- `settlement_batches.status` `CHECK IN ('MATCHED','PARTIAL','MISMATCHED')`.

## 9. Perbedaan skema pada mode baseline (PRD 11 akhir)

Kolom pseudonim diganti kolom identitas asli, selebihnya sama:

| Basis data | proposed | baseline |
| --- | --- | --- |
| transaction-db | `customer_pseudonym`, `account_pseudonym` | `customer_id`, `account_number` |
| fraud-db | `pseudonym` | `customer_id` |
| reconciliation-db | `settlement_items.account_pseudonym` | `settlement_items.account_number` |
| notification-db | `contact_registry.pseudonym` | `contact_registry.customer_id` sebagai kunci |

**[M5-01, N-42]** Kolom lain yang menyimpan subjek ikut berganti nama supaya skema tidak berbohong: `notification_log.sender_pseudonym` dan `recipient_pseudonym` menjadi `sender_customer_id` dan `recipient_customer_id` di baseline. Panjang kolom: `customer_id` 16, `account_number` 20 (format Gateway); `settlement_items` baseline memakai `CHECK account_number ~ '^[0-9]{8,20}$'` sebagai pengganti pemeriksaan token. Kolom `privacy_synced_at` dan `privacy_rejected_at` tetap ada di transaction-db baseline (kode domain satu untuk kedua mode; Privacy tidak dipanggil, klien status tanpa-aksi menandai baris sebagai terdengar). Tes paritas (`tests/baseline/schema-parity.ts`) membandingkan kolom, tipe, nullability, dan hak peran runtime kedua mode setelah kolom identitas dipetakan. Mode baseline: migrasi memakai folder `baseline/` saja (tanpa `common/`, karena migrasi lama ada di `proposed/`).

Aturan: kolom tambahan khusus baseline tidak boleh dimuat pada migrasi `common`. Tes arsitektur (ADR-0006) menjaga agar kode domain tidak mengimpor apa pun dari `migrations/` atau dari folder repositori per mode. Jumlah kolom identitas per layanan menjadi bukti pendukung E(s) (inspeksi skema, `pengujian-dan-pengukuran.md`).

## 10. Data awal dan data uji

- Seluruh data fiktif dan jelas palsu (D-24). `CUST-000101..000103`, rekening `1234567801..03`, merchant `MRC-001..003`, nomor HP `0812000000xx`, email `*@example.test` dari PRD 16.
- Fixture uji berada di `tests/` dan tidak pernah memuat nilai yang meniru data nyata. Nilai kenari (canary) unik per atribut per pelanggan dibangkitkan oleh pembangun data uji, bukan ditulis tangan (lihat `pengujian-dan-pengukuran.md` bagian 5).
- 1.000 pelanggan sintetis dengan riwayat Fraud awal untuk M7 dibangkitkan skrip deterministik (seed acak tetap) dan dipulihkan ke keadaan yang sama sebelum tiap run.
- Tidak ada seed di migrasi aplikasi kecuali tabel kebijakan (`risk_rules`, `merchants`).

## 11. Kriteria penerimaan

| Tiket | Kriteria | ID |
| --- | --- | --- |
| M2-01 | Migrasi privacy-db sesuai bagian 4; tes SQL dengan peran asli untuk `REVOKE/GRANT`, `chk_*`, indeks unik parsial, `chk_attribute_names` | TK-10, S-34, S-35, S-22, FR-15, FR-25 |
| M2-01 | `EXPLAIN` pada 20.000 baris tanpa `Seq Scan` untuk pencarian `subject_lookup`+layanan+purpose+status dan `pseudonym` | NFR-04 |
| M0-05 | peran dan database tiap layanan terbentuk idempoten; peran runtime tidak dapat mengubah skema; keanggotaan sementara admin pada peran pemilik dicabut di akhir skrip dan statusnya dicetak (hanya `privpay_test_admin` yang punya `SET`/`INHERIT` sesudahnya; opsi ADMIN bawaan PostgreSQL 16+ untuk pembuat peran tidak dapat dicabut admin non-superuser; idempotensi diuji dengan menjalankan skrip dua kali di CI, M0-07, dan memeriksa `pg_auth_members`; kegagalan di tengah skrip diperbaiki dengan menjalankan ulang) | NFR-09, ADR-0004 |
| M4-01, M4-04, M4-05, M4-06 | migrasi tiap layanan bisnis (proposed); inspeksi skema: tidak ada kolom identitas | FR-16, FR-21, S-38, NFR-17 |
| M5-01 | migrasi baseline tiap layanan dan repositori baseline | FR-23, US-09 |
| semua | tes migrasi dijalankan di PostgreSQL 18 sekarang dan **diulang di 16** pada fase Docker (DK-05) | ADR-0004 |

## 12. Di luar cakupan

Penghapusan fisik baris mapping dan audit (PRD 6.2 butir 4), rotasi `K_index` (hanya prosedur tertulis), partisi tabel, replikasi.

## 13. Keputusan spec (diterima Fanny, bawaan, Gerbang 3)

K-04 `CHECK` nilai pada `transactions.status`/`fraud_decision`. K-05 `UNIQUE (batch_id, bank_reference)` pada `settlement_items`.
