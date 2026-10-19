# M1-03: `gateway-adapter` inti: JWT, laju, rute, penyamaran error

- Milestone: M1
- Spec: gateway-tokenizer.md 2, 3, 7
- Bergantung pada: M1-02, M0-06
- Ukuran: L
- Cabang: `feat/m1-03-gateway-core` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

Inti Gateway: validasi JWT, pembatas laju, tabel rute dengan peran, dan `ErrorMasker` delapan kode.

## Kriteria penerimaan

- [ ] 401 untuk JWT tidak ada/kedaluwarsa/tanda tangan salah (TK-19, FR-01); peran per rute diperiksa; rute di luar `RouteTable` tidak ada.
- [ ] 429 `RATE_LIMITED` melewati `RATE_LIMIT_PER_MINUTE` per `azp+sub` dengan `FakeClock`; `RATE_LIMIT_ENABLED=false` mematikannya (TK-11, FR-26, NFR-08).
- [ ] `ErrorMasker`: setiap reason antar-layanan menjadi salah satu dari delapan kode; respons untuk token ada dan tidak ada identik kecuali `request_id` (TK-12, NFR-10, NFR-25).
- [ ] Tes AZ untuk rute yang sudah ada di tabel rute (AZ-04..AZ-08, AZ-10..AZ-17) pada lapis Gateway: N1, N2, N3, N4.

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Seam: `RouteTable.match`, `RateLimiter.allow`, `ErrorMasker.toClient`; Supertest pada aplikasi Gateway dengan hilir palsu.

## Catatan keamanan

- Header tak dikenal tidak diteruskan; JWT nasabah tidak diteruskan ke hilir; body tidak dicatat.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, CLAUDE.md). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
