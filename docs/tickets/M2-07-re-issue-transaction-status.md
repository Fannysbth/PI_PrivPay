# M2-07: `POST /re-issue` dan `PATCH /transaction-status`

- Milestone: M2
- Spec: privacy-service.md 4.4, 4.7, 7.7
- Bergantung pada: M2-05
- Ukuran: M
- Cabang: `feat/m2-07-re-issue-transaction-status` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

Penerbitan ulang token pada transaksi non-terminal dan pelacakan status transaksi.

## Kriteria penerimaan

- [ ] Re-issue: transaksi terminal → 409 `TX_TERMINAL`; token lama `expired`; token baru berbeda; **dipanggil dua kali memberi hasil sama** (aman diulang) (FR-10, FR-11, TK-09, C-05).
- [ ] `PATCH /transaction-status`: upsert idempoten; status terminal tidak kembali ke non-terminal (K-09); tidak diaudit (FR-17).
- [ ] AZ-23, AZ-24 (N1..N4).

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Integrasi dengan `FakeClock`; baris `transaction_status` tidak ada = non-terminal.

## Catatan keamanan

- Hanya `TRANSACTION`; re-issue tidak mengubah layanan atau purpose token.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, CLAUDE.md). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
