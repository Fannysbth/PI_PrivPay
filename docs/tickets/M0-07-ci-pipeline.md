# M0-07: CI: lint, typecheck, unit, integrasi, audit, gitleaks, SAST

- Milestone: M0
- Spec: platform-dan-ci.md 14
- Bergantung pada: M0-01, M0-04
- Ukuran: M
- Cabang: `chore/m0-07-ci-pipeline` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

Mengaktifkan job CI untuk gerbang lokal dengan PostgreSQL service container, dan memin Action ke SHA.

## Kriteria penerimaan

- [ ] Job `quality` (lint, typecheck, unit), `integration` (PostgreSQL 16 service + bootstrap + `test:integration`/`test:security`), `dependencies` (`pnpm audit --prod --audit-level high`), `secrets` (gitleaks bersama) (S-60..S-65).
- [ ] Job `integration` menjalankan `scripts/db/bootstrap.sql` dua kali pada PostgreSQL service dengan admin sekali pakai (kata sandi dibangkitkan per run) dan memeriksa bahwa katalog peran, database, dan `pg_auth_members` identik antara jalan pertama dan kedua, serta tidak ada `SET`/`INHERIT` selain `privpay_test_admin` pada peran pemilik (idempotensi M0-05, NFR-09).
- [ ] Setiap GitHub Action dipin ke commit SHA dan `permissions:` minimal (S-08); versi Node dari `.nvmrc`.
- [ ] Job e2e berbasis compose tetap tidak aktif sampai DK-01 (ADR-0004).

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Berkas workflow divalidasi sintaksnya secara lokal; job dijalankan di GitHub setelah Fanny mendorong cabang (belum teruji sampai itu).

## Catatan keamanan

- Tidak ada rahasia di workflow; kata sandi DB CI dibangkitkan per run; log CI tanpa PII.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, aturan proyek). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
