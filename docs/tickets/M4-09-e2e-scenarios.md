# M4-09: Skenario ujung ke ujung TX-10001..10003

- Milestone: M4
- Spec: pengujian-dan-pengukuran.md 5
- Bergantung pada: M4-02, M4-03, M4-06, M4-08
- Ukuran: M
- Cabang: `feat/m4-09-e2e-scenarios` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

Tiga skenario transaksi lulus ujung ke ujung pada mode proposed.

## Kriteria penerimaan

- [ ] TF-02 (normal), TF-03 (mencurigakan, `HELD`, skor 75), TF-04 (token kedaluwarsa, re-issue) lulus dengan data PRD 16.
- [ ] Pemindai kenari: nol temuan identitas di Transaction, Fraud, Reconciliation (FR-16, FR-18, FR-21).

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Skenario berjalan lewat Gateway dengan `FakeClock` untuk TF-04.

## Catatan keamanan

- Pemindai kenari di semua jalur.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, aturan proyek). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
