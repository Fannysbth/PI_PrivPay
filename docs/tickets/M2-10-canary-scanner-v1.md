# M2-10: Pemindai kenari v1

- Milestone: M2
- Spec: pengujian-dan-pengukuran.md 6
- Bergantung pada: M0-06
- Ukuran: M
- Cabang: `feat/m2-10-canary-scanner-v1` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

Pembangun nilai kenari, proxy pengamat (memori saja), dump DB, dan tangkap log untuk memeriksa kebocoran sejak M2.

## Kriteria penerimaan

- [ ] Nilai kenari unik per atribut per pelanggan, berformat valid tetapi jelas palsu (K-24); tidak pernah ditulis tangan.
- [ ] Proxy pengamat memindai payload di memori dan hanya mengeluarkan temuan `{atribut, lokasi, layanan}`; tidak ada payload atau nilai di keluaran atau disk.
- [ ] Nol temuan pada `audit_log` dan log Privacy (NFR-15, FR-15, S-43); pemindai gagal bila kenari ditanam di log (uji positif).

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Uji positif (kenari ditanam → terdeteksi) dan negatif (bersih → nol temuan); keluaran pemindai diperiksa tidak memuat nilai.

## Catatan keamanan

- Pemindai sendiri tidak boleh menjadi tempat kebocoran PII.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, CLAUDE.md). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
