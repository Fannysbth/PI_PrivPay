# M4-08: Alur pendaftaran di Gateway

- Milestone: M4
- Spec: gateway-tokenizer.md 6
- Bergantung pada: M2-08, M4-05, M1-01
- Ukuran: M
- Cabang: `feat/m4-08-registration-flow` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

Pendaftaran A2→A5→A3→A4 dengan kompensasi.

## Kriteria penerimaan

- [ ] Urutan A2, A5, A3, A4; HP baru tersimpan di Notification hanya setelah A3 berhasil; respons 201 `{status:"REGISTERED"}` tanpa data asli (TF-01, FR-19, FR-42, ADR-0005).
- [ ] Tes gagal per langkah: kompensasi `revoke_subject` + hapus pengguna; A4 idempoten dan dicoba ulang; tidak ada PII di log.
- [ ] AZ-01, AZ-02 (N1..N4, laju per alamat sumber, K-14).

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Integrasi end-to-end dengan `dev-idp`, Privacy, Notification; injeksi kegagalan per langkah.

## Catatan keamanan

- Pengguna yatim saat kompensasi gagal dicatat sebagai risiko sisa.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, CLAUDE.md). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
