# Tinjauan keamanan milestone M1

Cakupan: `tools/dev-idp`, `packages/common` (`safeEqual`, `jwt`, `authenticate`, bootstrap Nest, klien HTTP, logger, error), `services/gateway` (tabel rute, JWKS, pembatas laju, `ErrorMasker`, `Gateway.handle`), perubahan build dan CI, aturan lint perbandingan rahasia, `.gitignore`. Cabang `feat/m1-03-gateway-core`.

Cara: tinjauan independen oleh agen terpisah yang hanya membaca (checklist `security-checklist.md` untuk butir yang jatuh tempo sampai M1, lalu perburuan cacat di luar checklist), dilengkapi bukti yang saya jalankan sendiri. Status: **lulus** (ada bukti), **belum teruji** (butuh CI di GitHub, Docker, atau pengaturan repositori yang belum ada), **n/a**, **ditunda**. Butir tanpa bukti dihitung belum lulus. Tidak ada Critical atau High.

## Checklist

| # | Status | Bukti |
| --- | --- | --- |
| S-01 | lulus (lokal); CI belum teruji | `gitleaks detect --log-opts="--all"`: tanpa temuan pada seluruh riwayat; pemindaian staged pada setiap commit. Job `secrets` CI belum pernah berjalan |
| S-02 | lulus | `git ls-files secrets .env*` hanya `secrets/README.md`, `.env.example`, `.env.test.example`; `tests/repo/gitignore.spec.ts` (21 tes) memakai `git check-ignore --no-index` |
| S-04 | belum teruji | belum ada image (ADR-0004); pemindai rahasia Trivy hanya di CI |
| S-05 | n/a (sebagian) | belum ada compose. Setara lokal: `make-secrets.mjs` membuat rahasia acak 32 byte (`wx`, mode 0600 yang diabaikan Windows), `readServiceSecrets` menolak rahasia pendek atau kembar |
| S-06 | n/a | belum ada kontainer; fase Docker (DK-01) |
| S-07 | lulus (lokal) | `BIND_HOST` hanya `127.0.0.1` atau `::1` (`service-config.ts`); tes loopback per layanan menolak koneksi ke alamat lain (`nest-service.spec.ts`). Konfigurasi `pg_hba` PostgreSQL tidak diperiksa di M1. `/health` dan `/metrics` Gateway di antarmuka luar adalah utang fase Docker (N-05) |
| S-08 | lulus (isi); CI belum teruji | semua Action dipin ke SHA dan image ke digest, `permissions: contents: read`, hanya job CodeQL menulis `security-events`; `tests/repo/ci-workflow.spec.ts` (19 tes). Workflow belum berjalan di GitHub (N-07) |
| S-10 | lulus | `gateway.spec.ts` "TK-19": tanpa token, kedaluwarsa, penanda tangan asing, tanda tangan diubah, `alg=none`, HS256 dengan kunci publik, `Bearer` tak sahih: semua 401, tanpa panggilan hilir; `jwt.spec.ts` (RS256 saja, `crit` ditolak, base64url non-kanonik ditolak). Catatan: butir menyebut Kong; pada fase lokal Gateway adalah `gateway-adapter` (ADR-0004) |
| S-11 | lulus | `authenticate.ts` (umur maksimum 300 detik, `iat` wajib), dev-idp `ACCESS_TOKEN_TTL_SECONDS` 1..300 (konfigurasi dan konstruktor), `token-cache.ts` (selisih 30 detik), tes pembaruan token Gateway setelah 271 detik |
| S-40 | lulus (cakupan M1) | skema zod ketat per rute Gateway (body dan query, field tak dikenal 422), dev-idp `strictObject`; N3 untuk 13 rute |
| S-41 | lulus | tidak ada SQL pada cakupan M1 |
| S-44 | lulus (separuh); separuh Kong ditunda | Gateway tidak punya log akses selain daftar putih pino; tes "no token, secret, pseudonym or case reference in log or metrics". Redaksi log Kong menunggu fase Docker |
| S-45 | lulus | aturan ESLint `no-console` dan pencarian: tidak ada `console.*` di kode layanan, paket, dan alat (hanya skrip `make-secrets.mjs`, di luar lint, mencetak nama berkas) |
| S-51 | lulus | `rate-limiter.spec.ts` dan `gateway.spec.ts` "TK-11": 429, `Retry-After`, per pemanggil, `FakeClock`, `RATE_LIMIT_ENABLED=false` |
| S-60 | lulus (lokal); CI belum teruji | `pnpm audit --prod --audit-level high`: tanpa kerentanan |
| S-61 | belum teruji | CodeQL dan Semgrep hanya di CI |
| S-62 | belum teruji | Trivy hanya di CI |
| S-63 | belum teruji | `dependency-review` hanya pada PR di GitHub |
| S-64 | lulus | alasan, lisensi, dan hasil audit dependensi tercatat di CHANGELOG per tiket: M0-06 (NestJS 11, `reflect-metadata`, `rxjs`, `supertest`, `@types/*`), M0-07 (`yaml`), M1-01..M1-03 (tidak ada paket baru di lockfile; hanya dideklarasikan di paket baru). Tinjauan agen menandai gagal karena tidak membaca CHANGELOG |
| S-65 | belum teruji | `.github/dependabot.yml` mencakup npm, docker, github-actions; pengaturan repositori tidak dapat diverifikasi dari sini |
| S-74 | lulus | `users.dev.json` memakai `nasabah.uji.*`, `CUST-0001xx`; rahasia fiktif `fake-secret-*`; pseudonim tes dibentuk saat berjalan |

Butir milestone lain ditunda: S-03, S-30..S-33, S-36, S-50, S-53 (M2); S-12..S-16, S-20..S-26, S-34, S-35, S-37, S-42, S-55 (M3); S-27 (M4/M6); S-38, S-43, S-52, S-54 (M4); S-70..S-73 (M6).

## Temuan di luar checklist

| # | Tingkat | Temuan | Tindak lanjut |
| --- | --- | --- | --- |
| 1 | Medium | Reload JWKS yang ditahan atau gagal menahan atau menggagalkan permintaan ber-`kid` yang sudah dikenal | **Diperbaiki**: kunci yang dikenal dan belum basi dijawab dari memori sebelum menunggu reload (`jwks.spec.ts`, tes IdP lambat dan gagal) |
| 2 | Medium | dev-idp: `NODE_ENV` opsional; `dev_login` tanpa kredensial; `/token` tanpa pembatas tebakan rahasia | **Diperbaiki sebagian**: `NODE_ENV` wajib `development` atau `test`, selain itu (termasuk kosong) start ditolak. Sisanya diterima sebagai sifat dev-idp (loopback, README mencatatnya). Pembatas tebakan rahasia: N-23 |
| 3 | Low | Badan hilir non-JSON dikirim sebagai `text/html`; `x-powered-by`; tanpa `nosniff` | **Diperbaiki**: badan non-JSON dari hilir menjadi 500 tanpa teks; `x-powered-by` dimatikan; `X-Content-Type-Options: nosniff` pada semua jawaban |
| 4 | Low | Badan JSON anonim diurai sebelum 401 (batas 100 KB); alat Lua di CI tidak dipin; aturan Semgrep registri tidak dipin | Ditunda ke N-23 (pin saat plugin Lua dan Semgrep dipakai; batas pra-autentikasi perlu dinaikkan untuk settlement 64 KiB) |
| 5 | Low | Token manusia diteruskan apa adanya ke Privacy (`human-token`); layanan hilir yang diretas dapat memakainya ulang ke Gateway hingga 5 menit | Risiko sisa yang sudah tercatat (ADR-0007, T-15); jalur `aud` per peran (K-03) membatasinya. Tidak diubah |
| 6 | Low | Aturan lint perbandingan rahasia berdasarkan nama | Diterima dan tercatat (N-16); S-33 ditinjau manual di M2 |
| 7 | Low | Jendela tetap pembatas laju memungkinkan hingga dua kali kuota di pergantian jendela; `RATE_LIMIT_ENABLED=false` tanpa peringatan; tidak ada pemeriksaan ulang `jti` | Diterima (spec memilih jendela tetap; token ≤ 5 menit); catat di N-23 |

Tidak ditemukan: kebingungan algoritma, injeksi `kid`, SSRF (alamat hilir hanya dari konfigurasi, path dan parameter divalidasi ketat, `redirect: manual`), injeksi header, pelanggaran invarian 1 sampai 8 pada rute M1, kebocoran token lewat log, metrik, atau rantai `cause`, `X-Actor-Token` klien diteruskan.

## Ringkasan

Tidak ada temuan Critical atau High; dua Medium dan satu Low diperbaiki dengan tes lebih dulu. 15 butir lulus, 7 butir belum teruji karena butuh CI di GitHub, Docker, atau pengaturan repositori (S-01 CI, S-04, S-08 CI, S-61, S-62, S-63, S-65), S-05 dan S-06 n/a. Persetujuan milestone ada pada Fanny.
