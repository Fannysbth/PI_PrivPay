# DK-02: Plugin Kong `privacy-tokenizer` (P-1)

> **DK-02b selesai (ADR-0016, 2026-10-31):** plugin tokenisasi tiga rute; `/register` tetap di adapter.
>
> **Dipecah (keputusan Fanny, 2026-10-31, ADR-0015):** DK-02a (Kong OSS di depan adapter, selesai), DK-02b, titik keputusan DK-02c. Q-10 dibatalkan. Tiket ini tetap sebagai induk; kriteria plugin Lua dinilai di DK-02b/c.

- Milestone: DK (fase Docker, setelah M4 stabil, ADR-0004)
- Spec: gateway-tokenizer.md 11
- Bergantung pada: DK-01, M2-11
- Ukuran: L
- Cabang: `chore/dk-02-kong-plugin` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

Plugin Lua dengan paritas perilaku terhadap vektor kontrak; keputusan Lua vs adapter permanen (Q-10).

## Kriteria penerimaan

- [ ] Lolos vektor kontrak yang sama; luacheck bersih; catat pilihan gateway untuk pengukuran.

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Vektor kontrak.

## Catatan keamanan

- Gagal tertutup 503.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, CLAUDE.md). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
