# Changelog

Perubahan per tiket (Conventional Commits). Format mengikuti Keep a Changelog; belum ada rilis bernomor (artefak penelitian).

## [Belum dirilis]

### M0-01 workspace dan tooling

- Ditambah: pnpm workspace (`packages/*`, `services/*`, `tools/*`), TypeScript 6.0 `strict` + `noUncheckedIndexedAccess`, ESLint 10 (typescript-eslint strict) + Prettier, Jest 30 + ts-jest, `.nvmrc` Node 24, `packageManager` pnpm 12.14.0.
- Ditambah: tes `tests/repo/lint-rules.spec.ts` (10 tes): menjalankan ESLint CLI pada fixture untuk `console.*`, `any`, `catch {}` kosong, promise mengambang, dan tes terfokus/dilewati (`.only`, `.skip`, `xit`); memeriksa `strict` dan `noUncheckedIndexedAccess` pada konfigurasi TypeScript efektif; memeriksa `typecheck` mencakup folder `src` dan `test` di packages, services, tools; memeriksa Node dan pnpm dikunci.
- Dependensi (hanya dev). Dua kelompok menurut ADR-0002: **dinamai ADR** ("ESLint (typescript-eslint strict) + Prettier", "Jest", TypeScript): `typescript`, `eslint`, `typescript-eslint`, `prettier`, `jest`. **Pelengkap yang diperlukan agar yang dinamai berfungsi, tidak disebut ADR dan dicatat di sini:** `@eslint/js` (konfigurasi dasar ESLint), `ts-jest` (menjalankan tes TypeScript di Jest), `@types/jest` dan `@types/node` (tipe; `@types/node` dikunci ke 24 mengikuti Node 24). ADR-0002 tidak mengunci nomor versi alat; versi dipilih dan dikunci lewat lockfile.
- Lisensi seluruh pohon (264 MIT, 26 ISC, 15 Apache-2.0, 11 BSD-3-Clause, 8 BSD-2-Clause, 7 BlueOak-1.0.0, 1 `(MIT OR CC0-1.0)`, 1 CC-BY-4.0 yaitu `caniuse-lite`, hanya data alat dev dan tidak dikirim); tidak ada lisensi copyleft.
- `pnpm audit --prod --audit-level high`: tidak ada kerentanan. `pnpm audit` penuh: **1 advisory moderate** pada `sprintf-js` (transitif dari Jest, tanpa versi perbaikan, hanya alat uji, tidak masuk produksi); di bawah ambang CI (high), dicatat sebagai pengecualian tertulis (security-checklist S-60).
- Catatan: TypeScript 7 belum didukung `ts-jest` dan `typescript-eslint`, jadi versi dikunci di `~6.0.3`; skrip build dependensi ditolak lewat `allowBuilds` (`@parcel/watcher`, `unrs-resolver` tidak diperlukan).
