# M6-02: E(s), kelas data, presisi/recall

- Milestone: M6
- Spec: pengujian-dan-pengukuran.md 6
- Bergantung pada: M2-10, M5-03
- Ukuran: M
- Cabang: `feat/m6-02-exposure-metrics` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

Skrip paparan E(s) per layanan dengan rincian per kelas.

## Kriteria penerimaan

- [ ] E(s) teramati = nilai harapan Tabel IV pada kedua mode; `E_umum`/`E_spesifik` dilaporkan terpisah; presisi/recall; jalur audit dilaporkan sebagai paparan terkontrol (FR-24, NFR-17, S-70, US-10).

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Skrip diuji dengan data kenari.

## Catatan keamanan

- Skrip tidak menulis nilai kenari ke keluaran.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, CLAUDE.md). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
