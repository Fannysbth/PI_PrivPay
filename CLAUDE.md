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
pnpm dev:keys                     # tiga kunci Privacy ke secrets/ (tidak menimpa, tidak membaca); lihat scripts/dev/README.md
pnpm dev:up [--mode baseline]     # nyalakan semua proses lokal (proposed bawaan; baseline di database sendiri, N-50); Ctrl+C atau `pnpm dev:down` menghentikan
pnpm test:integration             # butuh PostgreSQL lokal (`scripts/db/bootstrap.ps1` sekali); DB tes dibuat ulang bersih tiap run (ADR-0004)
pnpm db:migrate [layanan]         # buat/perbarui tabel database PENGEMBANGAN layanan (privpay_privacy, dst.; nama tetap, tidak pernah database tes) sebagai pemilik skema; maju-saja, tidak pernah menghapus; tidak jalan otomatis. Jalankan tiap kali menggabung ke main setelah gerbang hijau, supaya isi database bisa diperiksa
pnpm db:pg16 up|status|down        # PostgreSQL 16.15 dalam satu kontainer (127.0.0.1:15432, rahasia di secrets/pg16/) untuk migrasi/tes terhadap 16; down menghapus kontainer dan volumenya; lihat scripts/db/README.md
pnpm db:test-databases [list|drop]  # daftar database privpay_* (layanan vs sisa tes, sesi terbuka); drop hanya sisa tes dan menuntut ketikan "DROP <jumlah>"
pnpm test:security                # kasus TK-xx sisi Privacy, dua lapis (layanan dan Gateway); butuh PostgreSQL seperti test:integration
pnpm audit --prod --audit-level high
gitleaks detect --log-opts="--all" --redact -v --config .gitleaks.toml   # secret scan; v8.30.1, sama dengan CI dan pre-commit
pnpm docker:secrets               # sekali: semua rahasia Compose ke secrets/docker/, termasuk CA dan sertifikat TLS dev (butuh `openssl`; tidak menimpa, tidak membaca, hanya nama berkas dicetak)
pnpm test:edge                    # DK-02b: spec *.docker.spec.ts (butuh Docker): vektor kontrak Lua + luacheck di kontainer sekali pakai; payload scan hilir dan fail-closed Privacy dimatikan butuh tumpukan menyala (PRIVPAY_STACK_MODE=proposed|baseline, dengan docs/postman/compose.postman.yml)
pnpm docker:edge-check <mode> [base|expiry|limits]   # DK-02a: mutasi atas tepi Kong dari host (token rusak/kedaluwarsa, ukuran, laju, TLS); butuh Compose + docs/postman/compose.postman.yml; fase expiry/limits butuh tumpukan dinyalakan dengan ACCESS_TOKEN_TTL_SECONDS=2 / KONG_RATE_LIMIT_PER_MINUTE=20 dan idp, gateway, kong-config, kong dibuat ulang bersama
pnpm docker:keycloak-check         # DK-04: Keycloak profil `keycloak` (`docker compose ... --profile keycloak up -d --wait keycloak`, jangan bersama `idp` di tumpukan penuh): JWKS satu kunci sig, klaim akun layanan dan nasabah, rahasia salah ditolak
pnpm docker:newman <mode>         # koleksi Postman lewat Kong (kontainer Newman terpin di jaringan edge, TLS diverifikasi dengan CA dev)
pnpm docker:net-check <mode>      # tumpukan menyala: jangkauan antarjaringan dan jalur TLS Gateway-Privacy dari dalam kontainer (DK-03)
pnpm secret-scan:tree             # gitleaks atas berkas yang akan di-commit (tanpa secrets/ yang di-ignore, tempat kunci PEM TLS dev); `gitleaks ... --all` tetap untuk riwayat
pnpm docker:compose <proposed|baseline> up -d --build --wait   # tumpukan penuh DK-01a; `... run --rm smoke` (register, bayar, daftar ditahan dari dalam jaringan); `... down -v` membersihkan hanya volume proyek ini
pnpm newman                       # koleksi Postman, kedua mode
pnpm pii-scan                     # pemindai nilai kenari (payload, DB, log)
```

gitleaks di Windows: `winget install Gitleaks.Gitleaks`. Bila shell belum memuat `%LOCALAPPDATA%\Microsoft\WinGet\Links` di PATH, panggil dengan path lengkap `"$LOCALAPPDATA/Microsoft/WinGet/Links/gitleaks.exe"`. Allowlist PSEU-token dan UUID contoh hanya berlaku di `docs/` dan `tests/`, tidak di `services/` atau `packages/`.

Status perintah (diperbarui per tiket): **sudah ada**: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm test`, `gitleaks` (M0-01), `pnpm db:migrate` (di luar tiket, atas permintaan Fanny: database layanan `privpay_*` sebelumnya kosong karena migrasi hanya dijalankan tes pada database sementara), `pnpm db:test-databases` (M0-05), `pnpm pii-scan` (M2-10: pemindai kenari v1; spec unit di `tests/pii-scan` dan integrasi atas Privacy, Transaction, Fraud, Notification, Reconciliation, dan alur E2E lewat Gateway, butuh PostgreSQL; sejak M5-01 juga kontrol positif atas skema baseline, pemindai wajib menemukan data asli di sana), `pnpm build` dan `pnpm test:smoke` (M1-01, N-04: `tsc` membangun, `node dist` menjalankan; `tsx` hanya untuk pengembangan), dan `pnpm test:integration` (M0-05; butuh `scripts/db/bootstrap.ps1` sudah dijalankan dan `.env.test` atau `PG_HOST`/`PG_PORT`/`PG_SECRETS_DIR`, lihat `scripts/db/README.md`). `pnpm db:pg16` (DK-05; tes integrasi, keamanan, dan migrasi lulus di PostgreSQL 16.15, lihat ADR-0004). `pnpm test:security` (M3-06: TK-01..06, 08, 09, 13..15; TK-07 dan TK-10 ada di tes tiketnya). **Sudah ada (DK-02a):** Kong 3.9.4 OSS di depan adapter (`docker:edge-check`, `docker:newman`, ADR-0015). **Belum ada:** `pnpm audit` selain `--prod` bersih (lihat CHANGELOG), `pnpm newman` lokal (M6-01), plugin Lua tokenizer (DK-02b/c), Keycloak, TLS dan tiga jaringan, k6 (DK-02..06, M6, M7); Compose DK-01a dan tiga jaringan + TLS Gateway-Privacy DK-03 sudah ada (lihat CHANGELOG). Gunakan `corepack pnpm <perintah>` bila `pnpm` tidak ada di PATH.

Gerbang lokal sebelum menyatakan tiket selesai: lint, typecheck, test, test:integration, audit, dan pemindaian secret: `pnpm secret-scan:tree` (berkas yang akan di-commit, tanpa allowlist, sekaligus memeriksa `secrets/` tetap di-gitignore) dan `gitleaks detect --log-opts="--all"` (riwayat penuh). Tampilkan keluarannya. `gitleaks detect --no-git` mentah tidak dipakai lagi sebagai gerbang: ia ikut membaca `secrets/` yang di-gitignore (kunci PEM TLS dev).

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
- Tes tidak boleh memuat nama database layanan asli (`privpay_privacy`, `privpay_transaction`, dst.) pada kode yang dapat menghapus, mengubah, atau menjatuhkan; tes memakai `privpay_<layanan>_test_<sufiks>` lewat `createTestDb`. Tes yang membuat database tes tambahan menghapusnya lagi di `afterAll`.
- Tidak ada klien lain (pgAdmin, psql, IDE) yang terhubung ke database `privpay_*` selama tes berjalan: sesi superuser tidak dapat diakhiri `privpay_test_admin`, sehingga `createTestDb` gagal dengan `TestDatabaseBusyError`. Lihat sisa dan sesi dengan `pnpm db:test-databases`.
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

## Pelajaran berulang (retro M3, `docs/RETRO_M3.md`)

- Sebelum gerbang: periksa memori bebas; satu proses pada satu waktu; bila proses dihentikan sistem dua kali, berhenti dan laporkan. Kegagalan pool saat memori sempit baru dianggap bug bila terulang saat memori longgar.
- Memori (keputusan 24 Okt): gerbang penuh dijalankan dengan Docker Desktop dimatikan (`docker desktop stop`, lalu `wsl --shutdown`) dan memori bebas minimal 5 GB; di bawah itu berhenti dan laporkan. Sesi dengan Docker menyala boleh mulai dari 2,5 GB bebas, tanpa putaran penuh (gerbang terarah saja).
- Tes konkurensi memaksa tumpang tindih tanpa `sleep` (kunci ditahan sesi lain) dan dibuktikan dengan mutasi: pengaman dihapus, tes harus gagal, lalu kode dikembalikan.
- Commit hanya setelah lint dan typecheck hijau (rangkai dengan `&&`). Baca tanda tangan dan satuan API (mis. `FakeClock.advance` memakai detik) sebelum menulis fixture; fixture salah bukan alasan mengubah kode.
- Compose (DK-02a): bila `idp` dibuat ulang, buat ulang `gateway`, `kong-config`, dan `kong` bersamanya (`up -d --force-recreate idp gateway kong-config kong`): dev-idp membuat kunci baru tiap start, Kong membaca kuncinya hanya saat `kong-config` jalan, dan adapter menyimpan JWKS lama sampai cooldown 30 detik.
- Spek yang butuh Docker (tumpukan menyala atau kontainer sekali pakai) memakai nama `*.docker.spec.ts` (dijalankan `pnpm test:edge`, bukan `pnpm test`) dan data unik per run (UUID acak, indeks kanari dari waktu): data tumpukan dan log bertahan antar-run, nilai literal membuat run kedua 409/422 atau lulus palsu dari log lama.
- Sisa database tes: pengguna menjalankan `! corepack pnpm db:test-databases drop` (butuh terminal interaktif). Jangan menyimpan branch cadangan berisi fixture lama; `gitleaks --all` harus bersih tanpa allowlist.

- Sebelum setiap commit yang menyentuh `services/`: jalankan `gitleaks detect --no-git --redact --config .gitleaks.toml` pada pohon kerja. UUID dan token contoh dibentuk saat tes berjalan (mis. `['7c9e6679', '7425', '40de', '944b', 'e07fc1f90ae7'].join('-')`), tidak ditulis literal di `services/` (allowlist hanya untuk `docs/` dan `tests/`); literal yang terlanjur masuk commit membuat `gitleaks --all` merah dan hanya bisa dibersihkan dengan menulis ulang riwayat.

- (Retro M4, `docs/RETRO_M4.md`) Skrip penyunting dan mutasi ditulis ke berkas, bukan heredoc Bash berisi tanda kutip tunggal. Setelah Prettier, cocokkan pola dari teks yang sudah diformat; setelah proses mutasi dihentikan paksa, periksa berkas sudah kembali.
- Tes yang membuka sumber daya nyata (timer, soket, kolam) menutupnya di `finally`: satu asersi gagal tidak boleh meninggalkan handle (Jest menunggu satu jam). Jam palsu satu tumpukan layanan hanya maju (token yang disimpan cache membawa `iat`).
- Tes habis waktu atau gagal tak stabil: baca stempel waktu log lebih dulu; lompatan jam berarti mesin tidur, bukan bug. Keluaran sebuah skill review bukan balasan akhir: lanjutkan sampai laporan akhir yang diminta.

## Catatan keputusan: lingkungan Docker (24 Okt)

- Tumpukan penuh Docker Compose dijalankan di laptop (pilihan penuh, bukan hibrida). Tempat pengukuran akhir (M6, M7) diputuskan nanti; sebelum itu semua diuji dengan Docker lokal, dan kinerja tidak diklaim sebelum lingkungan ukurnya diputuskan.
- Aturan Compose untuk DK-01: batas CPU dan memori tiap kontainer sama di kedua mode; PostgreSQL dikecilkan, satu instans per layanan; Prometheus, Grafana, dan cAdvisor sebagai profil terpisah untuk M7; batas WSL dinaikkan bertahap dan diukur. Bila tumpukan penuh tidak stabil, turun ke hibrida berdasarkan angka dan catat sebagai keterbatasan.

## Menjaga berkas ini tetap berguna

Singkat dan faktual. Tambahkan aturan baru hanya dari kesalahan yang benar-benar berulang (hasil `/retro`), dengan persetujuan user.
