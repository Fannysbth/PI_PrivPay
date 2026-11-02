# M4-03: Review, daftar `HELD`, pembersih `PENDING`

- Milestone: M4
- Spec: transaction.md 3.2, 3.3, 5.6
- Bergantung pada: M4-02
- Ukuran: M
- Cabang: `feat/m4-03-transaction-review-held` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

Peninjauan analis atas transaksi `HELD` dan penyapuan transaksi menggantung.

## Kriteria penerimaan

- [ ] Daftar `HELD` tanpa identitas, paginasi kursor; `APPROVE`/`REJECT` dengan `reviewed_by`, status Privacy diperbarui, notifikasi `TX_COMPLETED`/`TX_REJECTED` (FR-34, FR-35, TF-09, TF-10).
- [ ] Bukan `HELD` → 409 `NOT_HELD`; review ganda paralel: satu berhasil (baris terkunci).
- [ ] Pembersih: `PENDING` lewat `TX_PENDING_TIMEOUT_SECONDS` → `FAILED` dengan `Clock` (FR-39, TF-17).
- [ ] AZ-04, AZ-05 (Gateway) dan AZ-27, AZ-28 (layanan).

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Integrasi; `FakeClock` untuk pembersih.

## Catatan keamanan

- Peran `fraud_analyst` dari token aktor; teks bebas tidak ada.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, aturan proyek). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
