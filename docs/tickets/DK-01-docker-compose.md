# DK-01: Docker Compose dan secret

- Milestone: DK (fase Docker, setelah M4 stabil, ADR-0004)
- Spec: platform-dan-ci.md 14, 16
- Bergantung pada: M4-09
- Ukuran: L
- Cabang: `chore/dk-01-docker-compose` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

Seluruh sistem lewat satu `docker compose up` dengan Docker secret.

## Kriteria penerimaan

- [ ] Compose dengan jaringan dan secret; pemindaian image dan `docker history` tanpa rahasia (NFR-22, TK-18).
- [ ] Job e2e CI diaktifkan.

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Pemeriksaan `docker compose config` dan Trivy.

## Catatan keamanan

- Kontainer non-root, `cap_drop: [ALL]`, `no-new-privileges` (S-06).

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, aturan proyek). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
