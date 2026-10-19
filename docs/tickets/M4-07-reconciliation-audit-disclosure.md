# M4-07: Audit-request dan pemicu pembukaan

- Milestone: M4
- Spec: reconciliation.md 3.3, 3.4
- Bergantung pada: M4-06, M3-05
- Ukuran: M
- Cabang: `feat/m4-07-reconciliation-audit-disclosure` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

Audit rutin berbasis pseudonim dan perantara pembukaan identitas bersyarat.

## Kriteria penerimaan

- [ ] `audit-request`: token P7 + data transaksi tanpa identitas (pemindai kenari); satu baris `audit_requests` dan satu audit Privacy; peran auditor wajib (FR-22, TK-22, TF-06 ditulis ulang).
- [ ] `disclosure` (E-25): hanya atribut yang disetujui diteruskan, tidak disimpan di DB/log/metrik; penolakan diteruskan (FR-09, FR-43, TK-21, S-27, T-14).
- [ ] `GET /transaction/{id}` (E-24) dan `TRANSACTION_NOT_FOUND` (K-02); AZ-06, AZ-07, AZ-30, AZ-36, AZ-37.

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Integrasi lengkap pemohon→penyetuju→pembukaan; pemindai kenari pada reconciliation-db.

## Catatan keamanan

- Hasil pembukaan tidak disimpan di mana pun.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, CLAUDE.md). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
