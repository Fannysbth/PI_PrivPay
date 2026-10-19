# M4-01: Transaction inti dan idempotensi

- Milestone: M4
- Spec: transaction.md 3.1, 5.1; data-dan-migrasi.md 5
- Bergantung pada: M2-11, M0-04
- Ukuran: L
- Cabang: `feat/m4-01-transaction-core-idempotency` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

Skema transaction-db proposed, `POST /transaction`, dan idempotensi tanpa sidik jari rahasia.

## Kriteria penerimaan

- [ ] Skema tanpa kolom identitas (FR-16, S-38); `201`/`200`/`409` untuk isi sama, beda `amount`/`merchant_id`/`geohash`/rekening/pelanggan, replay setelah re-issue, replay di luar jendela (FR-36, NFR-23, TF-08).
- [ ] **`ON CONFLICT` paralel (kriteria wajib hasil Fase 2):** 2 dan 20 permintaan identik bersamaan, ≥ 20 putaran, PostgreSQL asli dengan peran asli: tepat satu baris, semua respons 200/201 dengan `transaction_id` sama, tanpa 5xx; isi beda bersamaan: satu menang, lainnya 409; pemenang berhenti di `PENDING` → 409 setelah penantian dengan `FakeDelay` (K-25).
- [ ] Validasi: `merchant_id` dikenal, `amount` ≥ 1 (K-16); AZ-26 (N1..N4).

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Integrasi PostgreSQL asli; ulang hasil prototipe idempotensi (riwayat `a887931`) terhadap basis data sungguhan.

## Catatan keamanan

- Tidak ada identitas di tabel/log; hanya `API_GATEWAY` memanggil.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, CLAUDE.md). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
