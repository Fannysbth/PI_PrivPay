# M4-04: Fraud Service

- Milestone: M4
- Spec: fraud.md
- Bergantung pada: M0-04, M2-11
- Ukuran: M
- Cabang: `feat/m4-04-fraud-service` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement-spec (paralel dengan M4-05, M4-06 setelah M4-01)

## Tujuan

Mesin aturan berbobot dengan riwayat berkunci pseudonim FRAUD_DETECTION.

## Kriteria penerimaan

- [ ] `RiskEngine`: contoh PRD (skor 10 lalu 75), cold start dengan dua aturan terlewat, batas ambang 1.000.000, batas jam 05:59/06:00/21:59/22:00, skor maks 75, pemetaan `BLOCK` via unit (FR-37, TF-03, TF-12, C-07).
- [ ] Tabel tanpa kolom identitas dan tanpa `transaction_id`; tidak dapat di-join ke transaction-db (FR-18, S-71).
- [ ] Validasi (field tak dikenal, `tx_hour` 0..23, geohash); AZ-31 (N1..N4); env `FRAUD_HOLD_THRESHOLD`/`FRAUD_BLOCK_THRESHOLD` (K-20).

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Unit `RiskEngine` tabel kasus; integrasi PostgreSQL asli.

## Catatan keamanan

- Tidak ada identitas; hanya `TRANSACTION` memanggil.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, CLAUDE.md). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
