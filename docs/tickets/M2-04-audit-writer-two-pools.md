# M2-04: `AuditWriter`/`AuditReader` dan dua pool koneksi

- Milestone: M2
- Spec: privacy-service.md 3, 9
- Bergantung pada: M2-01, M0-05
- Ukuran: M
- Cabang: `feat/m2-04-audit-writer-two-pools` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

Penulisan audit satu baris per operasi dan pembacaan audit lewat pool terpisah.

## Kriteria penerimaan

- [ ] **Kriteria wajib hasil Fase 2 (dua pool):** `INSERT` audit lewat `privpay_app` tanpa `RETURNING` berhasil; pembacaan lewat `privpay_auditor` berhasil; pool `auditor` tidak dapat menulis atau membaca mapping/brankas; pool `app` tidak dapat membaca audit.
- [ ] Tepat satu baris audit per operasi (SUCCESS dan DENIED); sukses di transaksi yang sama dengan perubahan keadaan; penolakan lewat transaksi singkat terpisah; bila audit gagal ditulis, operasi gagal (FR-13).
- [ ] Tipe `AuditEntry` tidak dapat memuat nilai identitas; `attribute_names` hanya nama (FR-15).

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Integrasi dengan peran asli untuk setiap kombinasi pool×tabel; tes bahwa kegagalan menulis audit menggagalkan operasi.

## Catatan keamanan

- Penulisan audit tanpa PII; tidak ada jalur menulis audit selain `AuditWriter`.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, CLAUDE.md). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
