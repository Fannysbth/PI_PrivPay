# M2-09: Job retensi

- Milestone: M2
- Spec: privacy-service.md 7.11
- Bergantung pada: M2-05
- Ukuran: M
- Cabang: `feat/m2-09-retention-job` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

Menandai kedaluwarsa dan mengosongkan identitas mapping yang tidak berlaku lebih dari `RETENTION_DAYS`.

## Kriteria penerimaan

- [ ] Langkah 1 dan 2 sesuai PRD; satu audit `PURGE_IDENTITY` per baris dengan `actor_id=SYSTEM`; `chk_purged` terpenuhi; `mapping_id` audit tetap valid (FR-31, NFR-18, C-06).
- [ ] `generate_from_transaction` atas baris `purged` → `TOKEN_NOT_FOUND`; kueri pemeriksaan retensi nol baris (TF-14); jam job dari `RETENTION_JOB_RUN_UTC` (K-26); `RETENTION_DAYS` dari env.
- [ ] Brankas tidak ikut job.

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Integrasi dengan `FakeClock` dan data berumur > 90 hari.

## Catatan keamanan

- Tidak ada penghapusan fisik; job tidak mencatat identitas.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, CLAUDE.md). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
