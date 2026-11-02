# M0-05: Bootstrap DB multi-layanan dan harness DB tes

- Milestone: M0
- Spec: platform-dan-ci.md 11; data-dan-migrasi.md 3
- Bergantung pada: M0-02
- Ukuran: M
- Cabang: `chore/m0-05-db-bootstrap-harness` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

Memperluas `scripts/db/bootstrap.*` menjadi satu database dan pasangan peran per layanan, dan menyediakan harness yang membuat ulang database uji bersih tiap run.

## Kriteria penerimaan

- [ ] Bootstrap idempoten membuat database `privpay_<svc>` dan peran `privpay_<svc>_owner`/`privpay_<svc>_app` untuk transaction, fraud, notification, reconciliation (privacy tetap `privpay_privacy_owner`, `privpay_app`, `privpay_auditor`); tidak membuat superuser dan hanya menyentuh objek `privpay_*` (ADR-0004, NFR-09).
- [ ] Keanggotaan sementara admin pada peran pemilik dicabut di akhir skrip: setelah bootstrap hanya `privpay_test_admin` yang punya `SET`/`INHERIT` pada peran pemilik (tes `M0-05 only the test admin can use the schema owner roles after the bootstrap`), dan statusnya dicetak. Opsi ADMIN yang PostgreSQL 16+ berikan ke pembuat peran tidak dapat dicabut oleh admin non-superuser dan tetap tercatat di `pg_auth_members` tanpa hak pakai (koreksi ADR-0004). Kegagalan di tengah diperbaiki dengan menjalankan ulang.
- [ ] Idempotensi dua kali jalan: butuh kredensial admin, yang sengaja tidak dibaca tes lokal; diuji otomatis di CI (M0-07) dan diperiksa manual lokal (lihat CHANGELOG).
- [ ] Harness `createTestDb(service)` membuat ulang `privpay_<svc>_test` oleh `privpay_test_admin`, menjalankan skema lewat peran pemilik, dan mengembalikan pool untuk peran runtime asli; menolak nama selain `privpay_*`; host/port dari env.

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Integrasi (butuh bootstrap sudah dijalankan oleh Fanny): `M0-05 bootstrap creates roles and a database for every service`, `M0-05 runtime role cannot alter the schema`, `M0-05 harness recreates a clean database on every run`.
- Tes yang bergantung pada hasil bootstrap akan merah sampai Fanny menjalankan `scripts/db/bootstrap.ps1`; itu perilaku yang benar, bukan alasan untuk melewati tes.

## Catatan keamanan

- Kata sandi peran dibangkitkan ke `secrets/` dan tidak pernah dicetak; admin dibaca dari `.env` oleh skrip, bukan oleh agen; tanpa kata sandi di argumen baris perintah.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, aturan proyek). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
