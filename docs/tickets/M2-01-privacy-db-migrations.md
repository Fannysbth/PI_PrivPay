# M2-01: Migrasi privacy-db dan hak akses per peran

- Milestone: M2
- Spec: data-dan-migrasi.md 4, 11
- Bergantung pada: M0-04
- Ukuran: M
- Cabang: `feat/m2-01-privacy-db-migrations` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

Skema privacy-db final (PRD 11 + E-06) dengan `REVOKE/GRANT` yang diuji memakai peran asli.

## Kriteria penerimaan

- [ ] Migrasi `pseudonym_mapping`, `transaction_status`, `audit_log` (+ `disclosure_id`, `attribute_names` + `chk_attribute_names`), `identity_vault`, `disclosure_request` (`chk_four_eyes`) dan semua indeks (FR-15, FR-25).
- [ ] `privpay_app` tidak dapat UPDATE/DELETE/TRUNCATE atau membaca `audit_log`; `privpay_auditor` hanya SELECT `audit_log` dan tidak dapat membaca `identity_vault`/`pseudonym_mapping` (TK-10, S-34, S-35).
- [ ] `chk_purged`, `chk_vault_purged`, `chk_four_eyes` menolak pelanggaran meski ditulis langsung (`23514`, S-22).
- [ ] `EXPLAIN` pada ≥ 20.000 baris tanpa `Seq Scan` untuk pencarian `subject_lookup`+layanan+purpose+status dan `pseudonym` (NFR-04).

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Integrasi dengan koneksi per peran; hasil prototipe P-2/P-3 (riwayat `a887931`) menjadi acuan kasus.

## Catatan keamanan

- Aplikasi tidak pernah terhubung sebagai pemilik skema; tidak ada kolom `subject_id` di `audit_log`.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, CLAUDE.md). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
