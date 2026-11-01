# M2-03: `PolicyEngine`: Tabel 1, 2, 3, 5, 6 sebagai konfigurasi

- Milestone: M2
- Spec: privacy-service.md 6
- Bergantung pada: M1-02
- Ukuran: M
- Cabang: `feat/m2-03-policy-engine` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

Evaluasi kebijakan murni: baris Tabel 1, cara terbit, pemanggil sah, peran, pertukaran Tabel 2, dan atribut Tabel 5.

## Kriteria penerimaan

- [ ] Tujuh konteks P1..P7 dan dua pertukaran X1, X2 persis PRD; semua kombinasi lain → `POLICY_NOT_ALLOWED` (FR-04, FR-27, FR-28).
- [ ] Cara terbit dan pemanggil sah per Tabel 3; P7 mensyaratkan peran `auditor` (`FORBIDDEN_ROLE`); `boleh_dibuka` hanya P7.
- [ ] TTL per purpose dari env, bukan literal (aturan proyek).

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Unit tabel kasus: tiap baris sah, tiap kombinasi di luar tabel (TK-06, TK-13, TK-14, TK-15 pada tingkat unit).

## Catatan keamanan

- Mengubah isi tabel membutuhkan ADR; tes mengunci isi tabel terhadap PRD.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, aturan proyek). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
