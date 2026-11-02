# M2-08: `POST /identity` dan brankas identitas

- Milestone: M2
- Spec: privacy-service.md 4.9
- Bergantung pada: M2-02, M2-04
- Ukuran: M
- Cabang: `feat/m2-08-identity-vault` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

Menyimpan NIK, nama, HP, rekening terenkripsi per kolom dengan AAD terikat baris.

## Kriteria penerimaan

- [ ] Hanya `API_GATEWAY`; pemanggil lain → `POLICY_NOT_ALLOWED`, tanpa baris brankas, audit `STORE_IDENTITY` DENIED (FR-42, TK-20).
- [ ] Idempoten: 201 lalu 200; `ON CONFLICT (customer_lookup) DO UPDATE`; dump hanya ciphertext (FR-25).
- [ ] Validasi `nik`/`hp`/`rekening`/`nama`; audit tanpa nilai identitas (K-10).
- [ ] AZ-25 (N1..N4).

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Integrasi: dump kolom, pindah ciphertext antar pelanggan dan kolom ditolak saat dibaca.

## Catatan keamanan

- Tidak ada identitas di log atau audit; `customer_id` hanya hasil lookup dan ciphertext.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, aturan proyek). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
