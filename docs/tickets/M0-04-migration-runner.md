# M0-04: Runner migrasi maju-saja

- Milestone: M0
- Spec: platform-dan-ci.md 10
- Bergantung pada: M0-05
- Ukuran: M
- Cabang: `chore/m0-04-migration-runner` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

Runner kecil buatan sendiri untuk berkas SQL bernomor dengan checksum, dijalankan hanya oleh peran pemilik skema.

## Kriteria penerimaan

- [ ] Berkas `NNNN_nama.sql` di `migrations/{common,proposed,baseline}/`; `schema_migrations(version, name, checksum, applied_at)` dengan SHA-256 (ADR-0002).
- [ ] Berkas terapan yang berubah isinya → gagal; celah atau duplikat nomor → gagal; satu migrasi satu transaksi, kegagalan membatalkan semuanya; dijalankan dua kali tanpa efek.
- [ ] Dijalankan oleh peran selain pemilik skema → gagal sebelum mengubah apa pun; tanpa fitur rollback otomatis.
- [ ] Folder mode mengikuti `PRIVACY_MODE` (ADR-0006).

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Integrasi dengan peran asli: checksum berubah, urutan, peran salah, transaksi batal, idempoten.

## Catatan keamanan

- SQL berparameter; nama berkas tervalidasi; runner tidak pernah terhubung sebagai peran runtime.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, aturan proyek). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
