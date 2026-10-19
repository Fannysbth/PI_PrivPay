# Changelog

Perubahan per tiket (Conventional Commits). Format mengikuti Keep a Changelog; belum ada rilis bernomor (artefak penelitian).

## [Belum dirilis]

### M0-02 `@privpay/common`: config, Clock, error, logger

- Ditambah: `packages/common` (`@privpay/common`) dengan modul `config` (`loadConfig`, `readSecret`, `readKey`: rahasia hanya dari berkas lewat `NAME_FILE`, nilai mentah di env ditolak, pesan error hanya memuat nama variabel), `clock` (`SystemClock`, `FakeClock`), `errors` (delapan kode klien, tabel reason ADR-0008, `toWireError`/`toClientError`), dan `logger` (pino; hanya field `LogFields`, field lain dibuang dan namanya dicatat di `dropped_fields`, nilai field diperiksa polanya, nama peristiwa divalidasi).
- 71 tes `common` (81 seluruhnya). Review menemukan dan memperbaiki, dengan tes yang gagal dulu: bypass kunci prototipe di logger (`constructor`, `toString`, `__proto__`), `loadConfig` yang gagal-terbuka pada `refine` tingkat skema, nama kunci mirip data di `dropped_fields`, `service` yang dapat ditimpa, tanggal tanpa zona waktu di `FakeClock`, dan `requestId` yang dipantulkan. Mutasi manual yang membuat tes gagal: logger menyimpan field tak dikenal, error klien menampilkan `reason`, rahasia mentah di env diterima, nama kunci diulang, config gagal-terbuka, `FakeClock` menerima instant tanpa zona, `requestId` dipantulkan.
- Dependensi runtime baru (keduanya dari ADR-0002): `zod` (validasi env dan batas, MIT) dan `pino` (logger berredaksi, MIT; membawa 12 paket transitif MIT/ISC: `@pinojs/redact`, `atomic-sleep`, `on-exit-leak-free`, `pino-abstract-transport`, `pino-std-serializers`, `process-warning`, `quick-format-unescaped`, `real-require`, `safe-stable-stringify`, `sonic-boom`, `split2`, `thread-stream`). `pnpm audit --prod --audit-level high`: tidak ada kerentanan.
- Catatan: `exports` paket menunjuk langsung ke `src/index.ts`; langkah build untuk Docker ditentukan di M0-06/DK-01.

### M0-01 workspace dan tooling

- Ditambah: pnpm workspace (`packages/*`, `services/*`, `tools/*`), TypeScript 6.0 `strict` + `noUncheckedIndexedAccess`, ESLint 10 (typescript-eslint strict) + Prettier, Jest 30 + ts-jest, `.nvmrc` Node 24, `packageManager` pnpm 12.14.0.
- Ditambah: tes `tests/repo/lint-rules.spec.ts` (10 tes): menjalankan ESLint CLI pada fixture untuk `console.*`, `any`, `catch {}` kosong, promise mengambang, dan tes terfokus/dilewati (`.only`, `.skip`, `xit`); memeriksa `strict` dan `noUncheckedIndexedAccess` pada konfigurasi TypeScript efektif; memeriksa `typecheck` mencakup folder `src` dan `test` di packages, services, tools; memeriksa Node dan pnpm dikunci.
- Dependensi (hanya dev). Dua kelompok menurut ADR-0002: **dinamai ADR** ("ESLint (typescript-eslint strict) + Prettier", "Jest", TypeScript): `typescript`, `eslint`, `typescript-eslint`, `prettier`, `jest`. **Pelengkap yang diperlukan agar yang dinamai berfungsi, tidak disebut ADR dan dicatat di sini:** `@eslint/js` (konfigurasi dasar ESLint), `ts-jest` (menjalankan tes TypeScript di Jest), `@types/jest` dan `@types/node` (tipe; `@types/node` dikunci ke 24 mengikuti Node 24). ADR-0002 tidak mengunci nomor versi alat; versi dipilih dan dikunci lewat lockfile.
- Lisensi seluruh pohon (264 MIT, 26 ISC, 15 Apache-2.0, 11 BSD-3-Clause, 8 BSD-2-Clause, 7 BlueOak-1.0.0, 1 `(MIT OR CC0-1.0)`, 1 CC-BY-4.0 yaitu `caniuse-lite`, hanya data alat dev dan tidak dikirim); tidak ada lisensi copyleft.
- `pnpm audit --prod --audit-level high`: tidak ada kerentanan. `pnpm audit` penuh: **1 advisory moderate** pada `sprintf-js` (transitif dari Jest, tanpa versi perbaikan, hanya alat uji, tidak masuk produksi); di bawah ambang CI (high), dicatat sebagai pengecualian tertulis (security-checklist S-60).
- Catatan: TypeScript 7 belum didukung `ts-jest` dan `typescript-eslint`, jadi versi dikunci di `~6.0.3`; skrip build dependensi ditolak lewat `allowBuilds` (`@parcel/watcher`, `unrs-resolver` tidak diperlukan).
