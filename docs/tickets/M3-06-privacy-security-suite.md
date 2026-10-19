# M3-06: Suite keamanan sisi Privacy (dua lapis)

- Milestone: M3
- Spec: pengujian-dan-pengukuran.md 4
- Bergantung pada: M3-05, M2-11
- Ukuran: M
- Cabang: `feat/m3-06-privacy-security-suite` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

Menjalankan TK-01..TK-10 dan TK-13..TK-15 di lapis layanan dan lapis Gateway.

## Kriteria penerimaan

- [ ] Lapis layanan: reason rinci dan tepat satu baris audit DENIED; lapis Gateway: hanya `ACCESS_DENIED` dan respons identik untuk token ada dan tidak ada (NFR-10, ADR-0008).
- [ ] TK-01..TK-06, TK-08, TK-09, TK-13..TK-15 lulus pada kedua lapis; TK-07 dan TK-10 sudah di tiket masing-masing.

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- `pnpm test:security`.

## Catatan keamanan

- Tidak ada kasus yang dilewati atau dilonggarkan.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, CLAUDE.md). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
