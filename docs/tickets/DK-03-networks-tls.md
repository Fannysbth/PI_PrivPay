# DK-03: Tiga jaringan Docker dan TLS (NFR-06)

- Milestone: DK (fase Docker, setelah M4 stabil, ADR-0004)
- Spec: platform-dan-ci.md 16
- Bergantung pada: DK-01
- Ukuran: M
- Cabang: `chore/dk-03-networks-tls` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

Zona `edge`/`business`/`privacy` dan TLS Gateway→Privacy dengan CA dev.

## Kriteria penerimaan

- [ ] Hanya Kong dan layanan bisnis menjangkau Privacy; TLS pada jalur identitas mentah (NFR-06).

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Pemeriksaan konektivitas dan sertifikat.

## Catatan keamanan

- Utang NFR-06 ditutup di sini.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, aturan proyek). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
