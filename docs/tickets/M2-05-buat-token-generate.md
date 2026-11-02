# M2-05: `buat_token` dan `POST /pseudonymize` bentuk 1

- Milestone: M2
- Spec: privacy-service.md 4.1, 7.1..7.3, 12
- Bergantung pada: M2-02, M2-03, M2-04
- Ukuran: L
- Cabang: `feat/m2-05-buat-token-generate` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

Penerbitan token dari identitas (khusus Gateway) dengan kunci advisory per kombinasi dan penandaan kedaluwarsa.

## Kriteria penerimaan

- [ ] 50 permintaan paralel (≥ 5 putaran) untuk kombinasi sama: satu `reused:false`, 49 `reused:true`, satu baris aktif, tanpa error (TF-07, NFR-13, C-03, T-05).
- [ ] **Tes penjaga yang dapat diulang:** tanpa kunci advisory skenario itu ditolak `23505 uq_mapping_active`; tabrakan nilai pseudonym diulang dari nonce baru dengan `ON CONFLICT (pseudonym) DO NOTHING` (C-04).
- [ ] **TF-15 khusus (hasil Fase 2):** tes berurutan tanpa konkurensi: terbitkan, majukan `FakeClock` melewati TTL, terbitkan lagi → berhasil, pseudonym berbeda, baris lama `expired`; tes harus gagal sendirian bila penandaan kedaluwarsa dihapus; tes SQL langsung membuktikan `23505` tanpa penandaan (TF-15, FR-33, C-02, T-06).
- [ ] `status_efektif` batas grace tepat (C-01); `EXPLAIN` tanpa `Seq Scan` pada ≥ 20.000 baris (NFR-04).
- [ ] AZ-18: `TRANSACTION` mengirim `subject_id` → `POLICY_NOT_ALLOWED` (TK-07, TK-06) dan tes N1..N4.

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Integrasi PostgreSQL asli, peran asli, `FakeClock`; seam: `TokenService.generate` dan endpoint.

## Catatan keamanan

- Tidak ada `FOR UPDATE` sebagai satu-satunya pencegah; `subject_id` tidak pernah di log; `requesting_service` dari `azp`.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, aturan proyek). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
