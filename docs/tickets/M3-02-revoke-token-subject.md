# M3-02: Pencabutan token dan subjek

- Milestone: M3
- Spec: privacy-service.md 4.5, 4.6, 7.10
- Bergantung pada: M2-08, M2-05
- Ukuran: M
- Cabang: `feat/m3-02-revoke-token-subject` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

Mencabut satu token atau semua token subjek dan mengosongkan brankas.

## Kriteria penerimaan

- [ ] `/pseudonym/{p}/revoke`: `revoked` dengan `revoked_at`; pemakaian berikutnya `REVOKED`; idempoten; token `expired` dapat dicabut (FR-12, TK-04, K-11).
- [ ] `/subject/revoke`: semua token aktif dicabut, satu audit per token, brankas dikosongkan dengan `PURGE_IDENTITY`, jumlah dikembalikan; subjek tanpa apa pun → satu audit DENIED dan 0 (FR-29, FR-44, TK-17).
- [ ] AZ-16, AZ-17 (peran `admin`; N1..N4).

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Integrasi + jalur Gateway (TK-17 dua lapis).

## Catatan keamanan

- Tidak ada penghapusan fisik mapping.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, CLAUDE.md). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
