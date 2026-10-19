# ADR-0002: Stack pendukung dan tooling

- Status: Accepted (disetujui Fanny, Fase 1a, 2026-10-19), dengan perubahan: runner migrasi sendiri menggantikan node-pg-migrate; Node 24; PostgreSQL 16 sebagai target dengan 18 di fase lokal (lihat Keputusan)
- Tanggal: 2026-10-19
- Terkait: PRD 17, D-21, Q-01, Q-15

## Konteks

PRD menetapkan TypeScript+NestJS, PostgreSQL 16, Kong, Keycloak, Docker Compose, Newman, k6, Prometheus+Grafana. Yang belum ditetapkan: manajer paket, runner tes, akses DB, migrasi, validasi, logger, linter, alat keamanan.

## Usulan (setiap butir bisa ditolak sendiri-sendiri)

| Area | Usulan | Alasan |
| --- | --- | --- |
| Runtime | Node.js LTS aktif (versi dikunci di `.nvmrc` dan `engines`) | Stabil, didukung NestJS |
| Paket | pnpm workspaces, lockfile di-commit | Instal deterministik, `--frozen-lockfile` di CI |
| Bahasa | TypeScript `strict`, `noUncheckedIndexedAccess` | Cegah kelas bug null/indeks |
| Akses DB | Driver `pg`, SQL eksplisit berparameter, tanpa ORM | Indeks unik parsial, `FOR UPDATE`, `REVOKE/GRANT`, enum, dan hak akses per peran harus terlihat dan teruji, bukan disembunyikan ORM |
| Migrasi | SQL maju-saja (node-pg-migrate atau berkas SQL bernomor), dijalankan sebagai peran pemilik skema | Jejak perubahan skema, hak akses peran |
| Validasi | zod di semua batas (HTTP, env) | Satu sumber skema, menolak field tak dikenal |
| Logger | pino dengan `redact` untuk kunci sensitif dan lint yang melarang `console.*` | Pencegahan kebocoran PII (NFR-15) |
| Tes | Jest + Supertest; PostgreSQL asli untuk perilaku yang bergantung SQL (lokal pada fase awal, Testcontainers setelah Docker; lihat ADR-0004) | Bawaan NestJS; DB asli, bukan mock |
| Lint/format | ESLint (typescript-eslint strict) + Prettier; luacheck untuk Lua | |
| Keamanan CI | gitleaks, `pnpm audit`, CodeQL, Semgrep, Trivy, hadolint, dependency-review | Lihat `.github/workflows/ci.yml` |
| Commit | Conventional Commits | Riwayat terbaca |
| Pin | Versi image dan GitHub Action dipin (tag, lalu digest/SHA) | Rantai pasok |

## Keputusan

Seluruh usulan pada tabel diterima, dengan penyesuaian:

- **Migrasi:** berkas SQL bernomor, maju-saja, dengan runner kecil buatan sendiri (tabel `schema_migrations` + checksum, dijalankan sebagai peran pemilik skema); tanpa `node-pg-migrate` dan tanpa fitur rollback otomatis. Runner ini satu tiket kecil dengan tes: checksum berubah, urutan, dijalankan oleh peran yang salah. Alasan: pustaka standar didahulukan, `REVOKE/GRANT` terlihat sebagai SQL biasa.
- **Runtime:** Node 24 (terpasang 24.12.0; dikunci lewat `.nvmrc` dan `engines`), pnpm lewat `corepack`.
- **PostgreSQL:** target 16 (PRD, D-21). Fase lokal memakai 18 di localhost:5432 sebagai deviasi tercatat di ADR-0004; versi, host, dan port dari env, tes skema diulang di 16 pada fase Docker.

Jangan memasang dependensi di luar daftar ini tanpa alasan, lisensi, dan hasil `pnpm audit`.

## Konsekuensi

Dampak keamanan: kontrol pencegah kebocoran PII dan rantai pasok dibangun sejak M0. Dampak pengukuran: semua layanan memakai tumpukan sama sehingga perbandingan baseline vs proposed adil.
