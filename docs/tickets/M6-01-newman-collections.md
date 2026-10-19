# M6-01: Koleksi Newman untuk kedua mode

- Milestone: M6
- Spec: pengujian-dan-pengukuran.md 8
- Bergantung pada: M5-03, M3-06
- Ukuran: M
- Cabang: `feat/m6-01-newman-collections` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

TF-01..17 dan TK-01..28 otomatis lewat `pnpm newman`.

## Kriteria penerimaan

- [ ] Semua kasus lulus pada kedua mode (TK khusus privasi hanya proposed); tiap folder menyiapkan datanya sendiri; skema JSON error (delapan kode) divalidasi (NFR-25).

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Newman terhadap layanan lokal.

## Catatan keamanan

- Data fiktif.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, CLAUDE.md). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
