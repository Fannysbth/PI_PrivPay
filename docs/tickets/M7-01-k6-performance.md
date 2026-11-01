# M7-01: Skrip k6 dan pengukuran performa (ditunda)

- Milestone: M7
- Spec: pengujian-dan-pengukuran.md 8
- Bergantung pada: M6-01, DK-01, DK-02
- Ukuran: L
- Cabang: `feat/m7-01-k6-performance` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement (setelah Docker)

## Tujuan

Pengukuran p95/throughput 5 pengulangan bergantian pada konfigurasi final.

## Kriteria penerimaan

- [ ] Sesuai PRD 18.4 dan syarat validitas ADR-0004: gateway sama untuk kedua mode, batas sumber daya sama, data mentah dilampirkan, interval kepercayaan t(4 db), tidak ada angka dari lingkungan lokal (NFR-01, NFR-02, NFR-03, US-11).

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Skrip k6 dan lampiran data mentah.

## Catatan keamanan

- Rate limit dimatikan identik di kedua mode.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, aturan proyek). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
