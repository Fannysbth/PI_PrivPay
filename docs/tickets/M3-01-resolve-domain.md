# M3-01: `POST /resolve-domain`

- Milestone: M3
- Spec: privacy-service.md 4.2, 7.6
- Bergantung pada: M2-06
- Ukuran: S
- Cabang: `feat/m3-01-resolve-domain` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

Menerjemahkan `notif_token` ke pseudonim domain P5, bukan identitas.

## Kriteria penerimaan

- [ ] Hanya `NOTIFICATION`; reason `TOKEN_NOT_FOUND`/`SERVICE_MISMATCH`/`PURPOSE_MISMATCH`/`REVOKED`/`EXPIRED`/`POLICY_NOT_ALLOWED` dengan satu audit (FR-08).
- [ ] Respons berisi `PSEU-...` saja; AZ-21 (N1..N4).

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Integrasi: tiap gerbang gagal berhenti di kegagalan pertama.

## Catatan keamanan

- Hasil tidak pernah `subject_id`.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, aturan proyek). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
