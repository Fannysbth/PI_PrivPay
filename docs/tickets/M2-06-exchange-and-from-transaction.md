# M2-06: `POST /pseudonymize` bentuk 2 (pertukaran) dan bentuk 3 (dari transaksi)

- Milestone: M2
- Spec: privacy-service.md 4.1, 7.4, 7.5
- Bergantung pada: M2-05
- Ukuran: M
- Cabang: `feat/m2-06-exchange-and-from-transaction` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

Pertukaran token X1/X2 dan penerbitan P6/P7 dari `transaction_id`.

## Kriteria penerimaan

- [ ] Pertukaran: STEP 0 pasangan Tabel 2; token ada/milik pemanggil/status; konteks sumber; penolakan dengan reason tepat dan satu audit DENIED (FR-07, FR-28, TK-01, TK-07, TK-13).
- [ ] Bentuk 3: P6 dan P7 dari baris P1/P2 termasuk `expired`; baris `purged` → `TOKEN_NOT_FOUND`; P7 membutuhkan aktor `auditor` (FR-09 bagian terbit).
- [ ] AZ-19 dan AZ-20 (N1..N4).

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Integrasi: matriks pemanggil×bentuk; baris retensi `purged`.

## Catatan keamanan

- Tidak ada penerimaan `subject_id` dari layanan hilir; hasil tidak membocorkan `subject_id`.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, CLAUDE.md). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
