# M4-02: Orkestrasi Transaction (Fraud, Notification, re-issue, status)

- Milestone: M4
- Spec: transaction.md 4, 5
- Bergantung pada: M4-01, M4-04, M4-05, M2-07
- Ukuran: L
- Cabang: `feat/m4-02-transaction-orchestration` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

Alur B dan C: keputusan fraud, notifikasi, token kedaluwarsa, dan pembaruan status.

## Kriteria penerimaan

- [ ] Di bawah/atas ambang; `ALLOW`/`HOLD`/`BLOCK` (skor disuntik); Fraud mati → `HELD` + `FRAUD_UNAVAILABLE` (FR-40, NFR-24, TF-02, TF-03, TF-11).
- [ ] Notification mati → tetap `COMPLETED`; PATCH gagal dicatat; token kedaluwarsa di tengah proses → re-issue lalu coba satu kali lagi (FR-10, FR-17, TF-04).
- [ ] Retry hanya untuk operasi idempoten (uji injeksi keterlambatan) (NFR-12); `SubjectReferencePort` dengan adapter proposed.

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Integrasi dengan Privacy, Fraud, Notification asli atau palsu menurut seam; `FakeClock`/`FakeDelay`.

## Catatan keamanan

- `fraud_token`/`notif_token` tidak disimpan; tidak ada fallback ke data mentah.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, CLAUDE.md). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
