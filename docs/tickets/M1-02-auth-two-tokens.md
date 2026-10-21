# M1-02: `common`: `authenticate` (dua token) dan `safeEqual`

- Milestone: M1
- Spec: platform-dan-ci.md 7, 15
- Bergantung pada: M1-01
- Ukuran: M
- Cabang: `feat/m1-02-auth-two-tokens` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

Verifikasi token layanan dan token aktor sesuai ADR-0007 serta pembungkus perbandingan rahasia konstan-waktu.

## Kriteria penerimaan

- [ ] `requesting_service` hanya dari `azp` token `Authorization` lewat allowlist; token aktor/klaim/body tidak memengaruhinya (D-16, TK-07).
- [ ] Token aktor harus manusia (`azp=admin-console`, tepat satu peran); token layanan atau nasabah sebagai aktor ditolak; token manusia di `Authorization` menolak `X-Actor-Token`.
- [ ] RS256 saja (`none` dan HS256 ditolak), `iss`, `exp`, `aud` diperiksa; `aud` token aktor dibatasi ke layanan di jalur peran (K-03).
- [ ] **Kriteria wajib hasil Fase 2:** semua perbandingan rahasia lewat `safeEqual` (`timingSafeEqual` dengan pemeriksaan panjang), dengan tes unit dan aturan lint/Semgrep yang melarang `===` antara rahasia `Buffer`.

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Tes hasil prototipe identity-check (riwayat git `a887931`) ditulis ulang sebagai tes tiket; tambah tes `safeEqual` panjang berbeda dan nilai sama/berbeda.

## Catatan pelaksanaan

- `safeEqual` dan `signJwt`/`verifyJwt` (RS256, semua kasus negatif token) sudah ada dari M1-01 (N-12). Tiket ini membangun `authenticate` di atasnya (allowlist `azp`, token aktor, aturan `aud` K-03) dan memegang aturan lint/Semgrep terhadap `===` pada rahasia.

## Catatan keamanan

- Tidak ada header peran atau aktor polos; token tidak pernah dicatat.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, CLAUDE.md). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
