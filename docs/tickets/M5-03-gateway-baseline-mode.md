# M5-03: Gateway mode baseline

- Milestone: M5
- Spec: gateway-tokenizer.md 8
- Bergantung pada: M5-02, M2-11
- Ukuran: S
- Cabang: `feat/m5-03-gateway-baseline-mode` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

Mode passthrough pada `Tokenizer` tanpa memanggil Privacy.

## Kriteria penerimaan

- [ ] Identitas diteruskan apa adanya, Privacy tidak dipanggil, JWT/laju/`transaction_id`/`ErrorMasker` identik (FR-23).

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Vektor kontrak mode baseline.

## Catatan keamanan

- Hanya aktif bila `PRIVACY_MODE=baseline`.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, aturan proyek). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
