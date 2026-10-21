# CLAUDE.md — PrivPay

Prototipe e-wallet microservices untuk skripsi (Privacy-by-Design, pseudonimisasi dinamis). Artefak penelitian, bukan produk produksi, tetapi dibangun dengan standar rekayasa serius. Baca juga: `SECURITY.md`, `docs/PRD_RINGKAS.md`, `docs/DESIGN_DECISIONS.md`, `docs/CONTEXT.md`.

Bahasa: percakapan dengan user dalam Indonesia. Kode, identifier, nama berkas, perintah, komentar kode, dan pesan commit dalam Inggris. Dokumen di `docs/` mengikuti bahasa yang sudah dipakai berkasnya.

## Sumber kebenaran

1. `docs/DESIGN_DECISIONS.md` dan ADR di `docs/adr/` (yang Accepted).
2. PRD v2.4 (`docs/PRD_RINGKAS.md`; lengkap di `docs/reference/PRD_PrivPay_v2.4_lengkap.md`).
3. `docs/spec/` dan `docs/tickets/` (dibuat di Fase 3 dan 4).
Bila bertabrakan, yang lebih atas menang. Jangan mengarang kebutuhan. Ambiguitas masuk `docs/OPEN_QUESTIONS.md` lalu tanyakan user. Keputusan berstatus FINAL tidak diubah tanpa ADR yang disetujui user.

## Stack (dari PRD; butir bertanda "usulan" menunggu konfirmasi, lihat ADR-0002)

- TypeScript (strict) + NestJS untuk semua layanan. Node 24 (`.nvmrc`), pnpm workspaces via corepack (ADR-0002 Accepted). PostgreSQL target 16; fase lokal memakai 18 di localhost:5432 (deviasi, ADR-0004); versi/host/port dari env, objek berawalan `privpay_`.
- PostgreSQL 16, satu instans per layanan, tanpa foreign key lintas basis data. Driver `pg` + migrasi SQL maju-saja, tanpa ORM (usulan).
- Kong (plugin kustom `privacy-tokenizer`, Lua), Keycloak, Docker Compose, Prometheus + Grafana. Fase lokal tanpa Docker (ADR-0004): `gateway-adapter` NestJS menggantikan Kong sementara, PostgreSQL 16 lokal; Docker dan Kong menyusul setelah M4 stabil.
- Mode hanya `baseline` dan `proposed` (ADR-0003).
- Kripto: hanya modul `node:crypto` (HMAC-SHA256, AES-256-GCM). Dilarang menulis kripto sendiri atau menambah pustaka kripto tanpa ADR.
- Uji: Jest + Supertest (usulan), database tes di PostgreSQL lokal pada fase lokal (Testcontainers setelah Docker tersedia, ADR-0004), Postman/Newman, k6.

## Perintah (diisi/diperbarui di milestone M0; jangan mengarang yang belum ada)

```
pnpm install --frozen-lockfile   # instal. `corepack enable` butuh admin (EPERM di mesin ini): pakai `corepack pnpm <perintah>`
pnpm lint                         # ESLint + Prettier --check
pnpm typecheck                    # tsc --noEmit di semua paket
pnpm build                        # tsc -b: paket dan layanan ke dist/ (N-04); jalankan layanan: `node services/<nama>/dist/main.js`
pnpm test                         # unit
pnpm test:smoke                   # build, lalu tiap layanan hasil build dijalankan sebagai proses (health, SIGTERM di Linux)
pnpm --filter @privpay/dev-idp run make-secrets   # sekali: rahasia klien dev-idp di secrets/ (tidak menimpa); lihat tools/dev-idp/README.md
pnpm test:integration             # butuh PostgreSQL lokal (`scripts/db/bootstrap.ps1` sekali); DB tes dibuat ulang bersih tiap run (ADR-0004)
pnpm test:security                # kasus TK-xx
pnpm audit --prod --audit-level high
gitleaks detect --log-opts="--all" --redact -v --config .gitleaks.toml   # secret scan; v8.30.1, sama dengan CI dan pre-commit
docker compose up -d --build      # seluruh sistem (NFR-19); DITUNDA sampai M4 stabil (ADR-0004), belum ada
pnpm newman                       # koleksi Postman, kedua mode
pnpm pii-scan                     # pemindai nilai kenari (payload, DB, log)
```

gitleaks di Windows: `winget install Gitleaks.Gitleaks`. Bila shell belum memuat `%LOCALAPPDATA%\Microsoft\WinGet\Links` di PATH, panggil dengan path lengkap `"$LOCALAPPDATA/Microsoft/WinGet/Links/gitleaks.exe"`. Allowlist PSEU-token dan UUID contoh hanya berlaku di `docs/` dan `tests/`, tidak di `services/` atau `packages/`.

Status perintah (diperbarui per tiket): **sudah ada**: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm test`, `gitleaks` (M0-01), `pnpm build` dan `pnpm test:smoke` (M1-01, N-04: `tsc` membangun, `node dist` menjalankan; `tsx` hanya untuk pengembangan), dan `pnpm test:integration` (M0-05; butuh `scripts/db/bootstrap.ps1` sudah dijalankan dan `.env.test` atau `PG_HOST`/`PG_PORT`/`PG_SECRETS_DIR`, lihat `scripts/db/README.md`). **Belum ada:** `pnpm test:security` (M3-06), `pnpm audit` selain `--prod` bersih (lihat CHANGELOG), `pnpm newman` (M6-01), `pnpm pii-scan` (M2-10), `docker compose` (DK-01). Gunakan `corepack pnpm <perintah>` bila `pnpm` tidak ada di PATH.

Gerbang lokal sebelum menyatakan tiket selesai: lint, typecheck, test, test:integration, audit, dan pemindaian secret (`gitleaks detect`). Tampilkan keluarannya.

## Struktur repo

```
services/{gateway,auth,privacy-service,transaction-service,fraud-service,
          notification-service,reconciliation-service,bank-simulator,sms-simulator}
tools/dev-idp           # penerbit JWT tiruan fase lokal (ADR-0004); diganti Keycloak di fase Docker
packages/common        # tipe, error, logger berredaksi, klien HTTP (timeout/retry), zod schema bersama
tests/{functional,security,pii-scan,performance}
deploy/                # compose, konfigurasi Kong/Keycloak/Prometheus
secrets/               # HANYA README dan .gitkeep di git; isi tidak pernah di-commit
docs/{adr,spec,tickets,security,qa,reference}
prototypes/            # kode sekali pakai, dihapus setelah ADR; tidak boleh diimpor
```

## Invarian arsitektur (PRD Bagian 5; melanggar = bug keamanan)

1. Hanya Gateway dan Privacy Service yang boleh menerima `customer_id`/nomor rekening mentah (dan NIK, nama dari formulir pendaftaran).
2. Layanan hilir meminta token baru dengan `source_pseudonym`, tidak pernah dengan `subject_id`.
3. Privacy Service tidak memanggil layanan lain. Panggilan searah dari Gateway ke bawah.
4. Satu layanan satu basis data; tidak ada akses lintas basis data.
5. Token satu layanan tidak berlaku di layanan lain (tidak ada join lewat pseudonim).
6. Log aplikasi hanya memuat token dan `transaction_id`.
7. `requesting_service` selalu dari klaim JWT, tidak pernah dari body.
8. Privacy Service mati = gagal tertutup (503). Tidak ada fallback ke data mentah.

## Larangan keras

- Menyimpan, mencatat (log, audit, error, trace, metrik, komentar, fixture), atau meletakkan di URL/query: NIK, nama, email, HP, nomor rekening, `customer_id`, `subject_id`, secret, JWT, nilai atribut hasil pembukaan identitas. Audit log hanya mencatat nama atribut, bukan nilainya.
- Data pribadi asli di mana pun. Data uji hanya fiktif dan jelas palsu.
- Meng-commit secret/kunci/`.env`/isi `secrets/`. Membaca `.env` atau `secrets/`. Menaruh kunci di image, argumen build, atau log.
- Melewati, melonggarkan, menghapus, atau men-skip tes agar hijau. Mematikan lint/typecheck/hook (`--no-verify`) tanpa izin.
- SQL dengan string concatenation; selalu parameter. Menonaktifkan verifikasi TLS.
- `console.log` di kode layanan (pakai logger berredaksi dari `packages/common`).
- `git push --force`, mengubah riwayat, atau merge tanpa persetujuan user. Commit langsung ke `main`.
- Menambah dependensi tanpa menyebut alasan, lisensi, dan hasil `pnpm audit`. Utamakan pustaka standar.
- Mengubah Tabel 1/2/3/5/6 PRD, panjang token, tiga kunci terpisah, atau TTL tanpa ADR.

## Konvensi kode

- `strict` TypeScript, tanpa `any` (gunakan `unknown` + validasi). Semua input batas (HTTP, env, pesan) divalidasi dengan skema (zod) dan menolak field tak dikenal.
- Konfigurasi dari env yang divalidasi saat start; gagal cepat bila hilang. Rahasia (kunci, kata sandi) dibaca dari berkas lewat `<NAME>_FILE`, bukan nilai mentah di env. Nilai TTL/ambang dari env (PRD 17), bukan literal.
- Waktu lewat `Clock` yang bisa disuntik, selalu UTC (NFR-20). Tes tidak memakai `sleep` nyata.
- Perbandingan nilai rahasia dengan `timingSafeEqual`. IV AES-GCM acak 12 byte per penulisan; AAD sesuai PRD 6.2.
- Error: kelas error domain dengan `code`, `reason`, HTTP status (PRD 10, tabel kode error). Respons error seragam (NFR-25). Ke klien eksternal hanya delapan `code` (ADR-0008); `reason` rinci hanya antar-layanan dan audit.
- Panggilan antar-layanan: timeout 3 detik, maksimum 2 retry berbackoff, hanya untuk operasi idempoten (NFR-12).
- Setiap operasi token menulis tepat satu baris audit (SUCCESS atau DENIED), di transaksi basis data yang sama bila memungkinkan.
- Git: branch `feat|fix|chore/<id>-<slug>`, Conventional Commits, PR kecil. Satu tiket satu PR. Jangan commit berkas hasil build.
- Komentar menjelaskan "mengapa" dan merujuk ID kebutuhan (mis. `// PRD 7.1 STEP 1`), bukan mengulang kode.

## Pengujian

- Tes dulu (`/tdd`). Nama tes memuat ID: `TK-07 rejects raw subject_id from TRANSACTION`.
- Kasus negatif keamanan sama pentingnya dengan jalur sukses. Hak akses DB diuji dengan koneksi peran terkait.
- Integrasi memakai PostgreSQL asli (lokal pada fase awal, Testcontainers setelah Docker; ADR-0004), bukan mock, untuk apa pun yang menyangkut indeks unik parsial, `FOR UPDATE`, `REVOKE/GRANT`. Tes terhubung sebagai peran sungguhan (`privacy_app`, `auditor_role`); migrasi dijalankan peran pemilik skema.
- Kriteria yang butuh Docker (NFR-19, fail-closed dengan Privacy Service dimatikan di compose, M7) tidak boleh dinyatakan lulus sebelum diuji. Angka latensi/throughput dari lingkungan lokal tidak masuk laporan.
- Tes harus deterministik dan mandiri; tidak bergantung urutan.
- Tes yang menyentuh shell atau jaringan tidak boleh bergantung pada `bash` mana yang ada di PATH atau jumlah antarmuka jaringan aktif: pakai pembantu `tcp-probe` (batas waktu sendiri, serentak), paksa LF lewat `.gitattributes`, dan jalankan gerbang sekali dengan `C:\Windows\System32` di depan PATH (WSL `bash`) sebelum menyatakan tiket yang menyentuh shell/jaringan selesai.

## Definisi selesai (per tiket)

- [ ] Kriteria penerimaan tiket terpenuhi dan tiap kriteria punya tes yang merujuk ID-nya.
- [ ] lint, typecheck, test, test:integration, audit, pemindaian secret hijau; keluaran ditampilkan.
- [ ] Tidak ada PII di log/audit/fixture (pemindai kenari lulus bila sudah ada).
- [ ] Jalur error dan batas waktu ditangani sesuai `docs/qa/qa-checklist.md`.
- [ ] `/code-review` dijalankan, temuan valid diperbaiki.
- [ ] Dokumentasi/ADR/CHANGELOG/bagian Perintah diperbarui.
- [ ] PR kecil, deskripsi menjelaskan perubahan dan bukti.
Definisi selesai milestone: tambah `/security-review`, centang bagian relevan di `docs/security/security-checklist.md`, dan persetujuan user.

## Alur kerja dan gerbang

Urutan: `/grill-me` → `/grill-with-docs` → `/prototype` (bila perlu) → `/to-spec` → `/to-tickets` → per tiket `/tdd` + `/implement` (atau `/implement-spec`) → `/code-review` → akhir milestone `/security-review` → `/retro`. `/diagnosing-bugs` saat ada kegagalan; `/improve-codebase-architecture` setelah M4 dan M5. Rinciannya di `PROMPT_AWAL.md`.
Berhenti dan minta persetujuan user di setiap gerbang fase/milestone. Berhenti dan tanya juga bila: keputusan FINAL harus berubah, tugas memaksa melanggar larangan, dua percobaan memperbaiki hal yang sama gagal, atau kebutuhan ambigu.

## Subagent

Subagent mematuhi berkas ini. Satu subagent satu tiket. Tidak menyentuh berkas bersama (compose, `packages/common`, nomor migrasi) kecuali tiketnya memberi kepemilikan. Koordinator memverifikasi hasil dengan menjalankan tes sendiri.

## Menjaga berkas ini tetap berguna

Singkat dan faktual. Tambahkan aturan baru hanya dari kesalahan yang benar-benar berulang (hasil `/retro`), dengan persetujuan user.
