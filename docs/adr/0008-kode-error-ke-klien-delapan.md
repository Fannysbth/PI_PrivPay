# ADR-0008: Kode error yang tampak ke klien eksternal menjadi delapan

- Status: Accepted (disetujui Fanny, Fase 1b, 2026-10-19)
- Tanggal: 2026-10-19
- Pengambil keputusan: Fanny
- Terkait: PRD 10 (format error seragam, tabel kode error), NFR-10, NFR-25, TF-08, FR-35, E-07, E-09

## Konteks

PRD 10 menyatakan klien eksternal hanya melihat enam `code`: `UNAUTHENTICATED` (401), `ACCESS_DENIED` (403), `VALIDATION_ERROR` (422), `RATE_LIMITED` (429), `SERVICE_UNAVAILABLE` (503), `INTERNAL_ERROR` (500). Namun TF-08 mengharapkan klien menerima 409 untuk `IDEMPOTENCY_CONFLICT`, dan `NOT_HELD` (409) berlaku untuk review analis fraud (FR-35). Keduanya tidak dapat dipenuhi bersamaan dengan "hanya enam kode".

## Keputusan

1. Set `code` ke klien eksternal menjadi **delapan**: enam di atas ditambah `IDEMPOTENCY_CONFLICT` (409) dan `NOT_HELD` (409). Keduanya tidak membocorkan keberadaan token atau identitas.
2. Semua penolakan Privacy Service (`TOKEN_NOT_FOUND`, `SERVICE_MISMATCH`, `PURPOSE_MISMATCH`, `EXPIRED`, `REVOKED`, `POLICY_NOT_ALLOWED`, `FORBIDDEN_ROLE`, `TX_TERMINAL`, `DISCLOSURE_*`, `REQUESTER_MISMATCH`, `SELF_APPROVAL`) tetap tampil sebagai `ACCESS_DENIED` 403 di klien; token ada atau tidak tetap tak terbedakan (NFR-10).
3. `INVALID_BASIS` dan `ATTRIBUTE_NOT_ALLOWED` tampil sebagai `VALIDATION_ERROR` 422 di klien.
4. Antar-layanan, tabel kode error ditambah tujuh reason: `DISCLOSURE_NOT_FOUND` (404), `DISCLOSURE_NOT_APPROVED` (403), `DISCLOSURE_EXPIRED` (410), `REQUESTER_MISMATCH` (403), `SELF_APPROVAL` (403), `INVALID_BASIS` (422), `ATTRIBUTE_NOT_ALLOWED` (422).
5. Setiap TK diuji di dua lapis: antar-layanan (reason rinci dan tepat satu baris audit `DENIED`) dan lewat Gateway (hanya kode klien, bentuk identik untuk token ada dan tidak ada).

## Konsekuensi

- Dampak pada keamanan dan privasi: tidak menambah informasi yang bisa dipakai menebak token; tidak ada perubahan pada NFR-10.
- Dampak pada pengujian: skema JSON respons error divalidasi untuk delapan kode (NFR-25).
- Yang harus diubah: aturan proyek, `PRD_RINGKAS.md`, `qa-checklist.md`, `security-checklist.md`, `docs/PRD_ERRATA.md`.

## Tambahan (2026-10-31, ADR-0015)

Penolakan yang dihasilkan Kong sendiri (token, ukuran, laju, hulu tidak ada) ditulis ulang oleh satu skrip `post-function` ke bentuk `{error:{code,message,request_id}}` dengan salah satu dari enam kode di atas; 413 menjadi 422 `VALIDATION_ERROR`. Tidak ada kode atau status baru. Jawaban adapter tidak diubah.

## Kapan ditinjau ulang

Bila PRD 10 direvisi atau ada kode klien baru yang diusulkan.
