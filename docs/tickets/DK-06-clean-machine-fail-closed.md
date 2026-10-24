# DK-06: NFR-19 mesin bersih dan fail-closed dengan Privacy dimatikan

- Milestone: DK (fase Docker, setelah M4 stabil, ADR-0004)
- Spec: pengujian-dan-pengukuran.md 7
- Bergantung pada: DK-01, M6-04
- Ukuran: M
- Cabang: `chore/dk-06-clean-machine-fail-closed` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

`docker compose up` dari mesin bersih tanpa langkah manual selain env dan secret.

## Kriteria penerimaan

- [ ] Rekaman uji NFR-19 (R-01); fail-closed dengan Privacy dimatikan di compose.

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Uji dari mesin bersih.

## Catatan keamanan

- Tidak ada langkah manual yang menyentuh rahasia.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, CLAUDE.md). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
