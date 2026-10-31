# ADR-0015: Kong OSS di depan gateway-adapter di kedua mode; adapter bukan pengganti permanen

- Status: Accepted (keputusan Fanny, 2026-10-31, instruksi sesi DK-02a; bentuk galat dipilih "post-function kecil")
- Tanggal: 2026-10-31
- Pengambil keputusan: Fanny
- Terkait: ADR-0004, ADR-0007, ADR-0008, ADR-0003, Q-09, Q-10, N-05, DK-02a, Metodologi Tabel III

## Konteks

ADR-0004 memakai `gateway-adapter` NestJS sebagai pengganti Kong sementara. DK-02 (plugin Lua `privacy-tokenizer`) dihentikan 2026-10-24 karena adapter bukan hanya tokenizer: ia memeriksa `aud`/`azp`/peran per rute, skema ketat, token layanan per hulu, `ErrorMasker`, alur pendaftaran dengan kompensasi. Kong OSS hanya memberi tanda tangan JWT, pembatas laju, dan batas ukuran. Keputusan Fanny: pengembangan diselesaikan dulu dengan komponen standar industri, lalu pengujian. Urutan: DK-02a, DK-02b, titik keputusan DK-02c, DK-04, DK-06, penutup DK, M6, M7.

## Keputusan

1. **Q-10 ("adapter permanen") dibatalkan.** Adapter tidak lagi dipertimbangkan sebagai pengganti tetap Kong. Apa yang akhirnya ada di Lua dan apa di adapter diputuskan di DK-02c; DK-02a tidak memutuskannya.
2. **DK-02a:** Kong 3.9.4 tanpa basis data (deklaratif) berdiri di depan `gateway-adapter` di kedua mode. Hanya fitur Kong OSS: `jwt`, `rate-limiting`, `request-size-limiting`, `correlation-id`, `request-termination`, `prometheus`, `post-function`.
3. **Pembagian tugas.** Kong: TLS di tepi (CA dev, TLS 1.2+, tanpa port HTTP), tanda tangan RS256 dan `exp` JWT (umur ≤ 300 detik, ADR-0007 butir 7), `iss` (kunci consumer), token hanya dari header `Authorization`, batas ukuran 64 KiB, batas laju per alamat klien. Adapter tetap: `aud`, `azp`, peran per rute, skema, tokenisasi, pendaftaran, pembatas laju per pemanggil (FR-26) dan per alamat untuk `/register` (K-14). `aud` tidak dapat diperiksa plugin `jwt` OSS, jadi tetap hanya di adapter.
4. **Kunci publik.** Saat start, langkah `kong-config` mengambil JWKS dev-idp, mengubahnya menjadi consumer JWT RSA, dan menulis berkas deklaratif ke volume. Hanya kunci publik; tidak ada rahasia di berkas. Tepat satu kunci RS256; selain itu start gagal. dev-idp membuat kunci baru tiap start, jadi dibuat ulang bersama `gateway`, `kong-config`, `kong`. Keycloak (DK-04) menerbitkan kunci stabil; langkahnya sama.
5. **Bentuk galat (ADR-0008).** Template galat Kong hanya menerima pesan dan request-id, bukan status. Satu skrip Lua kecil di plugin `post-function` (dibangkitkan dari tabel kode yang sama dengan adapter) menulis ulang galat yang dihasilkan Kong sendiri (sumber bukan "service") ke `{error:{code,message,request_id}}`: 401 UNAUTHENTICATED, 403 ACCESS_DENIED, 429 RATE_LIMITED, 502/503/504 SERVICE_UNAVAILABLE, 5xx lain INTERNAL_ERROR, dan 4xx lain (termasuk 413) menjadi 422 VALIDATION_ERROR. Tidak ada kode error baru. Jawaban adapter tidak disentuh.
6. **N-05.** Adapter tidak dipublikasikan. Di listener publik Kong, `/metrics` ditolak (token ditanyakan dulu, lalu 422) dan `/health` dijawab Kong sendiri dengan status saja, tanpa mode (N-54b, 2026-10-31). Metrik Kong ada di listener status internal (port 8100, tidak dipublikasikan).
7. **Alamat klien.** `EDGE_PROXY_HOPS=1` membuat adapter memakai entri terakhir `X-Forwarded-For` (yang ditambahkan Kong) sebagai kunci batas `/register`; tanpa itu seluruh pendaftaran berbagi satu ember (alamat Kong).

## Konsekuensi

- Positif: tepi memakai komponen standar; kegagalan token, ukuran, dan laju terjadi sebelum adapter menerima permintaan; bentuk galat satu.
- Negatif / utang: ini Lua pertama di repo, tanpa kerangka uji Lua (dibuktikan lewat mutasi HTTP `pnpm docker:edge-check` dan pembanding teks pada tabel kode). Kunci dev-idp yang berubah membuat Kong menolak sampai dibuat ulang. Titik tambahan di jalur: latensi tidak diklaim dari lingkungan lokal.
- Yang harus diubah: Postman (base_url `https`, CA dev), net-check, tes statis Compose, CLAUDE.md, spek gateway-tokenizer 11.

## Kapan ditinjau ulang

Di DK-02c (pembagian Lua vs adapter), dan saat Keycloak menggantikan dev-idp (DK-04).
