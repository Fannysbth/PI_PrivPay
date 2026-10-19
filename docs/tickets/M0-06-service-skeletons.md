# M0-06: Skeleton layanan (health, metrics, shutdown, env) dan simulator

- Milestone: M0
- Spec: platform-dan-ci.md 8, 9; endpoints.md AZ-43
- Bergantung pada: M0-02
- Ukuran: L
- Cabang: `chore/m0-06-service-skeletons` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

Kerangka NestJS untuk gateway, privacy, transaction, fraud, notification, reconciliation, bank-simulator, dan sms-simulator lewat satu modul bootstrap bersama.

## Kriteria penerimaan

- [ ] Tiap layanan: `GET /health` (`{status, service, mode, time}`) dan `GET /metrics` (Prometheus, tanpa label berisi token atau identitas) (NFR-14).
- [ ] Validasi env saat start (gagal cepat), `TZ=UTC`, penutupan anggun (berhenti menerima koneksi, menyelesaikan permintaan berjalan, menutup pool) (NFR-20, qa E-08).
- [ ] Terikat hanya ke `127.0.0.1`; format error seragam lewat filter pengecualian bersama (NFR-25).
- [ ] Modul bootstrap bersama (`@privpay/common/nest`) sehingga tiap `main.ts` hanya memanggilnya; tidak ada duplikasi kerangka.

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Supertest per layanan: health/metrics, env hilang → start gagal, SIGTERM menyelesaikan permintaan berjalan, `AZ-43` (tidak terikat ke antarmuka non-loopback).
- Metrik tidak memuat label dengan nilai token (uji dengan permintaan berisi nilai kenari).

## Catatan keamanan

- Metrik dan health tidak pernah memuat PII; filter pengecualian tidak membocorkan stack trace atau SQL (S-42).

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, CLAUDE.md). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
