# Changelog

Perubahan per tiket (Conventional Commits). Format mengikuti Keep a Changelog; belum ada rilis bernomor (artefak penelitian).

## [Belum dirilis]

### M0-01 workspace dan tooling

- Ditambah: pnpm workspace (`packages/*`, `services/*`, `tools/*`), TypeScript 6.0 `strict` + `noUncheckedIndexedAccess`, ESLint 10 (typescript-eslint strict) + Prettier, Jest 30 + ts-jest, `.nvmrc` Node 24, `packageManager` pnpm 12.14.0.
- Ditambah: tes `tests/repo/lint-rules.spec.ts` yang menjalankan ESLint CLI pada fixture dan membuktikan aturan `console.*`, `any`, `catch {}` kosong, dan promise mengambang ditegakkan.
- Dependensi (hanya dev, semuanya dari ADR-0002): `typescript`, `eslint`, `@eslint/js`, `typescript-eslint`, `prettier`, `jest`, `ts-jest`, `@types/jest`, `@types/node`. Lisensi seluruh pohon: MIT, ISC, BSD-2/3, Apache-2.0, BlueOak-1.0.0, CC-BY-4.0 (`caniuse-lite`, hanya data alat dev, tidak dikirim), `(MIT OR CC0-1.0)`.
- `pnpm audit --prod --audit-level high`: tidak ada kerentanan. `pnpm audit` penuh: **1 advisory moderate** pada `sprintf-js` (transitif dari Jest, tanpa versi perbaikan, hanya alat uji, tidak masuk produksi); di bawah ambang CI (high), dicatat sebagai pengecualian tertulis (security-checklist S-60).
- Catatan: TypeScript 7 belum didukung `ts-jest` dan `typescript-eslint`, jadi versi dikunci di `~6.0.3`; skrip build dependensi ditolak lewat `allowBuilds` (`@parcel/watcher`, `unrs-resolver` tidak diperlukan).
