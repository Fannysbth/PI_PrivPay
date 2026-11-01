# M1-01: `dev-idp`: penerbit JWT tiruan khusus dev

- Milestone: M1
- Spec: platform-dan-ci.md 12; endpoints.md AZ-38, AZ-39
- Bergantung pada: M0-06
- Ukuran: M
- Cabang: `feat/m1-01-dev-idp` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

IdP lokal RS256 dengan JWKS, klien, peran, dan akun seed fiktif sesuai ADR-0007.

## Kriteria penerimaan

- [ ] Menolak start bila `NODE_ENV=production` atau `DEV_IDP_ENABLED` bukan `true`; hanya `127.0.0.1`; kunci RS256 dibuat saat start dan tidak ditulis ke disk (ADR-0004).
- [ ] `POST /token` (client_credentials, dev_login), `GET /.well-known/jwks.json`; token ≤ 300 detik, `aud` per layanan, `iss` bertuliskan dev (NFR-21); `client_secret` dibandingkan dengan `safeEqual`.
- [ ] Seed fiktif: 3 nasabah, 2 admin, 2 auditor, 1 fraud analyst, 1 bank; manusia tepat satu peran; `CUST-NNNNNN` mulai `CUST-000101` (ADR-0007).
- [ ] `POST /admin/users`, `DELETE /admin/users/{id}` hanya klien `api-gateway` (AZ-38, AZ-39).

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Tes AZ-38/39 (N1..N4) dan kredensial salah → 401; token kedaluwarsa dan `aud` sesuai klaim.

## Catatan pelaksanaan

- N-04 (Fanny, gerbang M0) diterapkan di tiket ini: `pnpm build` dan `pnpm test:smoke`, `exports` `@privpay/common` dengan kondisi `source`/`default`, dev-idp dibangun dan dijalankan seperti layanan.
- `safeEqual` dan `signJwt`/`verifyJwt` dikerjakan di sini karena dibutuhkan penerbit token (N-12). `ServiceDefinition.modules` boleh berupa fungsi yang menerima env dan clock (validasi konfigurasi layanan lewat jalur gagal-cepat yang sama).
- Keputusan sementara N-08..N-11 di `docs/OPEN_QUESTIONS.md` bagian G. Seed dan klaim: `tools/dev-idp/README.md`.

## Catatan keamanan

- Tidak ada kata sandi nyata; rahasia klien dari berkas `secrets/`; utang DK-04 (pemetaan ke Keycloak) dicatat.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, aturan proyek). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
