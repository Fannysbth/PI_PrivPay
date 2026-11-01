# M5-01: Skema dan repositori baseline semua layanan

- Milestone: M5
- Spec: data-dan-migrasi.md 9
- Bergantung pada: M4-09
- Ukuran: L
- Cabang: `feat/m5-01-baseline-schemas-repos` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement-spec (paralel per layanan)

## Tujuan

Kolom identitas pada mode baseline lewat repositori per mode.

## Kriteria penerimaan

- [ ] Migrasi baseline untuk transaction, fraud, notification, reconciliation dengan kolom sesuai tabel perbedaan skema; adapter repositori baseline (FR-23, US-09).
- [ ] Tes arsitektur: kode domain tidak mengimpor folder per mode.

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Integrasi dengan skema baseline asli.

## Catatan keamanan

- Baseline memegang data asli: tidak boleh aktif pada konfigurasi proposed (env divalidasi).

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, aturan proyek). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
