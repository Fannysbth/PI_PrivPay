# M0-01: Workspace, tooling, dan skeleton monorepo

- Milestone: M0
- Spec: platform-dan-ci.md 2, 14
- Bergantung pada: tidak ada
- Ukuran: M
- Cabang: `chore/m0-01-workspace-tooling` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

Menyediakan pnpm workspace, TypeScript strict, ESLint + Prettier, Jest, dan tata letak folder sehingga semua gerbang lokal berjalan dari root pada skeleton.

## Kriteria penerimaan

- [ ] `corepack pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test` berjalan dari root (aturan proyek, platform-dan-ci 14).
- [ ] `.nvmrc` Node 24 dan `engines`/`packageManager` terkunci (ADR-0002).
- [ ] TypeScript `strict` dan `noUncheckedIndexedAccess`; ESLint typescript-eslint strict melarang `any`, `console.*`, `catch {}` kosong, dan promise tak ditangani (S-45, qa E-06).
- [ ] Dependensi hanya yang ada di ADR-0002; tiap dependensi baru dilaporkan: alasan, lisensi, hasil `pnpm audit` (aturan proyek).

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- `tests/repo/lint-rules.spec.ts`: menjalankan ESLint pada fixture berisi `console.log`, `any`, `catch {}` dan memastikan tiap pelanggaran dilaporkan (bukti konfigurasi benar-benar menegakkan aturan).

## Catatan keamanan

- Tidak ada rahasia di repo; `node_modules/` dan hasil build tidak ter-commit; versi alat dikunci lewat lockfile.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, aturan proyek). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
