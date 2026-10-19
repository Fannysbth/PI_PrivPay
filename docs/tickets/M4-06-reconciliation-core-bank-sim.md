# M4-06: Reconciliation inti dan bank simulator

- Milestone: M4
- Spec: reconciliation.md 3.1, 3.2, 4
- Bergantung pada: M4-01, M2-11
- Ukuran: L
- Cabang: `feat/m4-06-reconciliation-core-bank-sim` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement-spec (paralel)

## Tujuan

Pencocokan settlement D1..D4, laporan settlement, run manual, dan simulator bank.

## Kriteria penerimaan

- [ ] `Reconciler`: dua item cocok → `MATCHED`, item tak berpasangan → `PARTIAL`, tak satu pun → `MISMATCHED`; token D2 = token D3; HELD tidak ikut (total 1.535.000 pada data PRD 16); `TOKEN_NOT_FOUND` tidak menghentikan batch (FR-21, FR-41, TF-05, TF-16, C-10).
- [ ] Laporan tak valid → 422 tanpa token terbit; tidak ada rekening di basis data; satu laporan per tanggal (K-22, K-05) (FR-32, TF-13, S-38).
- [ ] Endpoint Transaction `GET /transaction/completed` (E-23) dan scheduler `RECON_DAILY_RUN_UTC` (K-23); AZ-08, AZ-29, AZ-34, AZ-35, AZ-40.

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Unit `Reconciler`; integrasi dengan transaksi dan Privacy; bank simulator menyuntik kasus tak valid.

## Catatan keamanan

- Tidak ada identitas di reconciliation-db.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, CLAUDE.md). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
