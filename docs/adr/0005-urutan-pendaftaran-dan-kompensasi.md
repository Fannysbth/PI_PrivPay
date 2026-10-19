# ADR-0005: Urutan alur pendaftaran A2, A5, A3, A4 dengan kompensasi

- Status: Accepted (disetujui Fanny)
- Tanggal: 2026-10-19
- Pengambil keputusan: Fanny
- Terkait: PRD 9 alur A, FR-42, FR-44, Q-08, D-08, ADR-0004

## Konteks

PRD 9 mengurutkan pendaftaran A2 (buat pengguna di IdP), A3 (token P5), A4 (daftarkan HP di Notification), A5 (`POST /identity` ke brankas). Bila A5 gagal setelah A4, nomor HP sudah tersimpan di Notification dan kompensasinya membutuhkan endpoint hapus kontak yang tidak ada di daftar endpoint PRD 10 (endpoint di luar daftar dilarang, API9).

## Pemeriksaan ketergantungan (dilakukan sebelum mengubah urutan)

- A5 hanya membutuhkan `customer_id` (keluaran A2). Brankas dikunci oleh `customer_lookup = HMAC(K_index, CUSTOMER || customer_id)`, yang dihitung dari `customer_id` sendiri; tidak membutuhkan token atau baris mapping dari A3.
- A3 tidak membutuhkan keluaran A5.
- A4 membutuhkan `notification_domain_id` dari A3, jadi A4 tetap setelah A3.

## Keputusan

Urutan menjadi **A2 → A5 → A3 → A4**. Notification (satu-satunya PII di luar Privacy dan IdP, D-08) paling akhir.

| Gagal di | Kompensasi |
| --- | --- |
| A2 | tidak ada yang perlu dibatalkan |
| A5 | hapus pengguna IdP |
| A3 | `revoke_subject` (mengosongkan brankas, `PURGE_IDENTITY`) + hapus pengguna IdP, atau coba ulang (NFR-12) |
| A4 | coba ulang (idempoten: upsert berkunci pseudonim domain); bila tetap gagal: `revoke_subject` + hapus pengguna IdP |

Semua langkah dan kompensasi idempoten. Tidak ada endpoint baru; `revoke_subject` sudah ada di PRD 7 dan 10.

## Konsekuensi

- Positif: HP baru masuk Notification setelah semua langkah lain berhasil; tidak butuh endpoint hapus kontak.
- Negatif / utang: kompensasi sendiri dapat gagal dan meninggalkan pengguna IdP yatim; dicatat sebagai keterbatasan dan ditangani di spec (log hanya token dan `transaction_id`/ID korelasi, tanpa PII).
- Detail untuk spec: `POST /identity` harus idempoten (percobaan ulang tidak boleh melanggar `UNIQUE customer_lookup`); perilaku `revoke_subject` untuk subjek tanpa token dan tanpa brankas harus ditetapkan (mis. jumlah 0, tanpa baris audit palsu).
- Dampak pada keamanan dan privasi: kebocoran PII akibat kegagalan parsial berkurang; jalur gagal tertutup tetap berlaku.
- Dampak pada pengujian: kasus gagal per langkah (A2..A4) menjadi tes integrasi; TF-01 tetap berlaku.
- Yang harus diubah: PRD 9 alur A (dicatat di `docs/PRD_ERRATA.md` E-16; `docs/reference/` tidak diedit), spec `gateway-tokenizer`.

## Kapan ditinjau ulang

Bila PRD alur A direvisi, atau bila Notification mendapat endpoint penghapusan kontak.
