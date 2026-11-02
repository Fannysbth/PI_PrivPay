# M3-03: `GET /audit-log`, timeline, summary

- Milestone: M3
- Spec: privacy-service.md 4.8
- Bergantung pada: M2-04, M3-02
- Ukuran: M
- Cabang: `feat/m3-03-audit-log-read` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

Pembacaan audit lewat pool auditor dengan filter, paginasi, dan peringatan sederhana.

## Kriteria penerimaan

- [ ] Filter `service`, `status`, `reason`, `pseudonym`, `transaction_id`, `from`, `to`, plus `action` dan `disclosure_id` (E-27); `limit` 50 (maks 200) + `cursor` (FR-14, S-55).
- [ ] Timeline naik menurut waktu; summary `{total, denied, alerts}` dengan tiga DENIED dalam lima menit; tiap pembacaan menulis satu `VIEW_AUDIT_LOG` (US-13).
- [ ] AZ-13, AZ-14, AZ-15 (N1..N4); dibaca lewat pool `auditor`.

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Integrasi: kueri gabungan benar; `limit` > 200 → 422.

## Catatan keamanan

- Respons tidak memuat PII; `attribute_names` hanya nama.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, aturan proyek). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
