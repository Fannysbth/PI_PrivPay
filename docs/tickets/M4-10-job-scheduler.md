# M4-10: Penjadwalan job berkala

- Milestone: M4
- Spec: privacy-service.md 7.11, transaction.md 5 langkah 6, reconciliation.md 3.2
- Bergantung pada: M2-09, M4-03, M4-06
- Ukuran: M
- Cabang: `feat/m4-10-penjadwal` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /tdd, lalu /simplify dan /code-review

## Tujuan

Menghubungkan `RetentionJob` (K-26), `PendingSweeper.sweep` dan `resync` (K-19), dan job harian Reconciliation (K-23, `RECON_DAILY_RUN_UTC`) ke siklus hidup proses layanan masing-masing lewat satu penjadwal bersama. Sebelum tiket ini ketiganya ada, teruji, tetapi tidak pernah berjalan di proses nyata (dicatat "belum dijadwalkan" sejak M2-09).

## Kriteria penerimaan

- [ ] Satu `Scheduler` di `packages/common`: jadwal `every` (detik) dan `daily` (HH:MM UTC); waktu dari `Clock` yang disuntik, timer dari `Timers` yang disuntik (S-36, K-19, K-23, K-26).
- [ ] Jam dan interval dari env, wajib, divalidasi saat start: `TX_SWEEP_INTERVAL_SECONDS`, `RETENTION_DAYS`, `RETENTION_JOB_RUN_UTC`, `RECON_DAILY_RUN_UTC`; jadwal yang tak mungkin berjalan menghentikan start walau job mati.
- [ ] Mulai setelah layanan menerima permintaan (sesudah `listen`); berhenti rapi di `close`: timer dibatalkan, job yang berjalan ditunggu, sebelum kolam basis data ditutup.
- [ ] Satu job tidak tumpang tindih dengan dirinya (kemunculan yang jatuh saat job berjalan dilewati, tidak diantrekan, tidak dikejar).
- [ ] Galat di job ditangkap dan dicatat sebagai nama job dan `reason` saja (tanpa pesan galat), proses jalan terus.
- [ ] Mati secara bawaan di lingkungan tes (`NODE_ENV=test`) kecuali `SCHEDULER_ENABLED=true`; nilai selain `true`/`false` menghentikan start.
- [ ] Asumsi satu instans didokumentasikan (dua instans menjalankan setiap job dua kali).
- [ ] Bukti: tes dengan `FakeClock` dan `FakeTimers` (berjalan sesuai jadwal, tidak tumpang tindih, shutdown menunggu job, galat tidak mematikan proses, tidak ada handle tersisa); mutasi untuk guard tumpang tindih dan shutdown; E2E dengan layanan asli (retensi mengosongkan identitas setelah 90 hari, `resync` memulihkan status Privacy, rekonsiliasi hari kemarin); satu proses nyata dijalankan dengan timer asli.

## Tes dulu (tdd)

Seam yang diuji: `Scheduler` (jam dan timer palsu), siklus hidup `createServiceApp` (start sesudah listen, stop sebelum sumber daya), pemasangan per layanan terhadap basis data asli.

## Catatan keamanan

- Log job hanya memuat nama job dan `reason` (invarian 6); pesan galat dapat memuat nilai dan tidak dicatat.
- Job berjalan dengan peran basis data layanan itu sendiri; tidak ada hak baru.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, aturan proyek). Tambahan tiket ini: kriteria di atas dan penutupan butir S-36 hanya bila terbukti.
