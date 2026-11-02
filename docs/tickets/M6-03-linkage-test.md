# M6-03: Uji penautan baseline vs proposed

- Milestone: M6
- Spec: pengujian-dan-pengukuran.md 7
- Bergantung pada: M6-02
- Ukuran: M
- Cabang: `feat/m6-03-linkage-test` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

Tingkat keberhasilan penautan lintas layanan pada kedua mode.

## Kriteria penerimaan

- [ ] Join lintas basis data lewat pseudonim nol baris pada proposed; baseline tertaut penuh; penautan dalam satu layanan dan satu purpose selama TTL dilaporkan jujur (S-71, S-72).

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Skrip penautan terhadap salinan basis data.

## Catatan keamanan

- Hasil bukan bukti formal; batas ditulis.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, aturan proyek). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
