> **Status 2026-10-31 (ADR-0017):** realm dan pemetaan klaim terbukti (`pnpm test:edge tests/docker/keycloak-claims`); penyambungan ke Compose dan layanan belum (N-56).

# DK-04: Keycloak: realm, klien, pemetaan klaim

- Milestone: DK (fase Docker, setelah M4 stabil, ADR-0004)
- Spec: platform-dan-ci.md 12
- Bergantung pada: DK-01, M1-02
- Ukuran: M
- Cabang: `chore/dk-04-keycloak` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

Menggantikan `dev-idp` dengan Keycloak dan memetakan klaim.

## Kriteria penerimaan

- [ ] Klaim `azp`, `aud`, peran, `customer_id` sama dengan `dev-idp`; masa berlaku ≤ 5 menit (NFR-21); tes `authenticate` lulus tanpa perubahan.

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Tes M1-02 terhadap Keycloak.

## Catatan keamanan

- Rahasia klien dari Docker secret.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, aturan proyek). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
