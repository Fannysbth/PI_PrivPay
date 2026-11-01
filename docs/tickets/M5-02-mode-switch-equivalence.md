# M5-02: Pengalih mode dan tes kesetaraan perilaku

- Milestone: M5
- Spec: pengujian-dan-pengukuran.md 5; transaction.md 8
- Bergantung pada: M5-01
- Ukuran: M
- Cabang: `feat/m5-02-mode-switch-equivalence` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

Satu env `PRIVACY_MODE` mengalihkan mode; suite perilaku yang sama lulus di kedua repositori.

## Kriteria penerimaan

- [ ] Suite perilaku (TF yang berlaku pada kedua mode) lulus pada repositori baseline dan proposed (FR-23).
- [ ] Kombinasi env yang tidak konsisten ditolak saat start.

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Tes kontrak repositori yang diparametrisasi atas kedua adapter.

## Catatan keamanan

- Mode `static` tidak ada (ADR-0003).

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, aturan proyek). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
