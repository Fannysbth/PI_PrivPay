# M2-11: Modul `Tokenizer` dan rute tokenisasi (transaksi, settlement)

- Milestone: M2
- Spec: gateway-tokenizer.md 4, 5, 8
- Bergantung pada: M1-03, M2-05, M2-10
- Ukuran: L
- Cabang: `feat/m2-11-gateway-tokenizer` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

Tokenisasi `customer_id` dan rekening di Gateway, pembuangan NIK/nama/email, 503 saat Privacy mati, dan tokenisasi laporan settlement.

## Kriteria penerimaan

- [ ] Muatan keluar dibangun dari daftar putih; nilai kenari NIK/nama/email/`customer_id`/rekening tidak ada di dalamnya (FR-02, FR-03).
- [ ] Privacy mati/timeout → 503 dan tidak ada panggilan hilir; penolakan Privacy → `ACCESS_DENIED` (FR-38, NFR-11, TK-16).
- [ ] `transaction_id` unik (K-17); `Idempotency-Key` wajib (422).
- [ ] Settlement: validasi sebelum tokenisasi (item tak valid → 422, nol token terbit); token sama dengan alur D2 (FR-32, TF-13); AZ-03, AZ-09.
- [ ] `PrivacyPort` dengan adapter HTTP dan palsu; vektor kontrak `tests/security/gateway-contract/*.json`.

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Unit `Tokenizer` murni (tanpa NestJS) dan integrasi dengan Privacy asli; pemindai kenari pada muatan keluar.

## Catatan keamanan

- Gagal tertutup tanpa fallback; log tanpa body; modul bersih dari NestJS untuk paritas dengan plugin Lua.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, CLAUDE.md). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
