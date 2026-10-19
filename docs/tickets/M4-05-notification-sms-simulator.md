# M4-05: Notification dan SMS simulator

- Milestone: M4
- Spec: notification.md
- Bergantung pada: M0-04, M3-01
- Ukuran: M
- Cabang: `feat/m4-05-notification-sms-simulator` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement-spec (paralel)

## Tujuan

Registrasi kontak berkunci pseudonim domain dan pengiriman SMS generik lewat simulator.

## Kriteria penerimaan

- [ ] `register` idempoten (201 lalu 200), `contact_registry` berkunci pseudonim (FR-19, TF-01); `send`: `resolve-domain`→kontak→SMS→log tanpa isi pesan, `FAILED` pada setiap kegagalan, tanpa retry pengiriman (FR-08, FR-20, TF-02).
- [ ] HP hanya di `contact_registry` dan simulator (pemindai kenari; E(s) Notification 1/6); simulator: endpoint uji hanya dengan env uji, tidak ada HP di log (D-08).
- [ ] AZ-32, AZ-33, AZ-41, AZ-42 (N1..N4).

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Integrasi dengan PostgreSQL asli dan `SmsGateway` palsu serta simulator nyata.

## Catatan keamanan

- HP tidak pernah di log atau metrik atau pesan error.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, CLAUDE.md). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
