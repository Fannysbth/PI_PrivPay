# M6-04: Uji gagal tertutup (proses Privacy dimatikan)

- Milestone: M6
- Spec: pengujian-dan-pengukuran.md 7
- Bergantung pada: M2-11, M2-10
- Ukuran: S
- Cabang: `feat/m6-04-fail-closed-test` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

Mematikan proses Privacy saat transaksi dan memeriksa 503 serta nol kebocoran.

## Kriteria penerimaan

- [ ] 503 di Gateway, tidak ada payload berisi data asli ke hilir (kenari di proxy), waktu pemulihan dicatat (TK-16, NFR-11, S-50). Versi Compose (Privacy dimatikan, satu instans tanpa replika) ditunda ke DK-06.

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Skrip uji mematikan proses.

## Catatan keamanan

- Tidak ada fallback ke data mentah.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, aturan proyek). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
