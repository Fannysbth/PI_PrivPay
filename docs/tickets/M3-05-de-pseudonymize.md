# M3-05: `POST /de-pseudonymize` lima gerbang

- Milestone: M3
- Spec: privacy-service.md 4.3, 7.8
- Bergantung pada: M3-04, M2-08
- Ukuran: L
- Cabang: `feat/m3-05-de-pseudonymize` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

Satu-satunya jalan identitas keluar dari Privacy dengan atribut yang disetujui saja.

## Kriteria penerimaan

- [ ] Gerbang berurutan, berhenti di kegagalan pertama; syarat `boleh_dibuka` dan peran auditor (FR-09, TK-02, TK-08, TK-15, TK-23, TK-28).
- [ ] Lolos: hanya atribut yang disetujui, HP dan rekening tidak pernah; status `USED`; audit dengan `attribute_names` dan `disclosure_id` dalam satu transaksi (TK-21, FR-43).
- [ ] Sekali pakai dan paralel: dua pemakaian bersamaan → tepat satu berhasil; setelah 600 detik → 410 `DISCLOSURE_EXPIRED` (TK-26); brankas hilang → `TOKEN_NOT_FOUND` (K-13).
- [ ] AZ-22 (N1..N4).

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Integrasi dengan `FakeClock`; tes paralel pada persetujuan yang sama.

## Catatan keamanan

- Nilai atribut tidak masuk audit/log; hanya atribut ∩ Tabel 5 yang didekripsi.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, CLAUDE.md). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
