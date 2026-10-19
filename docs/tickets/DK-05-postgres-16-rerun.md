# DK-05: Ulang tes skema di PostgreSQL 16

- Milestone: DK (fase Docker, setelah M4 stabil, ADR-0004)
- Spec: data-dan-migrasi.md 11
- Bergantung pada: DK-01
- Ukuran: S
- Cabang: `chore/dk-05-postgres-16-rerun` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

Menutup deviasi PostgreSQL 18 lokal.

## Kriteria penerimaan

- [ ] Seluruh tes integrasi dan keamanan lulus di PostgreSQL 16; hasil dicatat di ADR-0004.

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Tes yang sama di 16.

## Catatan keamanan

- Termasuk `REVOKE/GRANT` dengan peran asli.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, CLAUDE.md). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
