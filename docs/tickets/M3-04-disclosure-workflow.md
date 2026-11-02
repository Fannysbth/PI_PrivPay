# M3-04: Alur permintaan pembukaan identitas

- Milestone: M3
- Spec: privacy-service.md 4.10, 7.9, 8
- Bergantung pada: M3-03, M2-06
- Ukuran: L
- Cabang: `feat/m3-04-disclosure-workflow` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

Permintaan, persetujuan, dan penolakan pembukaan identitas empat mata.

## Kriteria penerimaan

- [ ] PENDING→APPROVED→USED, REJECTED, EXPIRED; transisi ilegal ditolak (qa C-09); `DISCLOSURE_NOT_PENDING` 409 (K-01).
- [ ] Penyetuju = pemohon → 403 `SELF_APPROVAL`, status tetap PENDING, juga ditegakkan `chk_four_eyes` (TK-24); tanpa peran admin → `FORBIDDEN_ROLE` (TK-25).
- [ ] `INVALID_BASIS`/`ATTRIBUTE_NOT_ALLOWED` → 422 tanpa baris `disclosure_request`, audit DENIED (TK-27, K-07); persetujuan berlaku 600 detik dari env.
- [ ] AZ-10, AZ-11, AZ-12 (N1..N4).

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Integrasi dengan `FakeClock`; tulis langsung ke DB untuk `chk_four_eyes`.

## Catatan keamanan

- Pemohon dan penyetuju berperan berbeda; tidak ada nilai identitas di audit.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, aturan proyek). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
