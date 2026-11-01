# ADR-0012: Penutup Fase 2 (prototipe dihapus, hasil tersimpan di ADR dan riwayat git)

- Status: Accepted
- Tanggal: 2026-10-19
- Pengambil keputusan: Fanny
- Terkait: ADR-0004, ADR-0007, ADR-0009, ADR-0010, ADR-0011

## Konteks

Fase 2 menjawab ketidakpastian teknis yang dapat merusak desain: konkurensi `buat_token` (P-2), kripto field dan blind index (P-3), serta dua cek awal atas ADR-0007 dan ADR-0009. P-1 (plugin Kong) ditunda ke fase Docker (ADR-0004).

## Keputusan

Prototipe dihapus dari pohon kerja pada commit terpisah, sesuai aturan proyek ("kode sekali pakai, dihapus setelah ADR"). Kodenya tetap menjadi sumber primer di riwayat git:

- `a887931` dan `2755840` (branch `chore/phase2-prototypes`): `prototypes/idempotency-check/`, `prototypes/identity-check/`, `prototypes/p2-p3-privacy-db/`.
- Menjalankan ulang: checkout `2755840`, pastikan `scripts/db/bootstrap.ps1` sudah dijalankan, lalu di `prototypes/p2-p3-privacy-db/` jalankan `corepack pnpm install` dan `PG_HOST=localhost PG_PORT=5432 node --test p2.test.mjs p3.test.mjs`; dua cek awal dijalankan dengan `node --test <berkas>` tanpa database.

## Hasil yang menjadi dasar keputusan

| Prototipe | Hasil | ADR |
| --- | --- | --- |
| P-2 buat_token paralel | PRD 7.1 tidak aman terhadap konkurensi; kunci advisory per kombinasi + `ON CONFLICT (pseudonym) DO NOTHING` | 0010 (Accepted) |
| P-3 kripto field | Format blob, penyandian dengan awalan panjang, AAD terikat `id` baris; 15 dari 15 tes | 0011 (Accepted) |
| Cek ADR-0009 | TF-08 "isi beda → 409" tetap teruji tanpa sidik jari rahasia (model dalam memori) | 0009 |
| Cek ADR-0007 | `requesting_service` hanya dari token layanan; aturan tambahan `ADMIN_CONSOLE` | 0007 |

Jumlah tes pada commit `2755840`: P-2 10, P-3 15, ADR-0007 10, ADR-0009 9.

## Yang tidak diuji (menjadi butir spec Fase 3, `docs/OPEN_QUESTIONS.md` bagian E)

`timingSafeEqual`, `ON CONFLICT` paralel untuk `POST /transaction` di PostgreSQL sungguhan, pembatasan `aud` token aktor, dua pool koneksi audit (tulis `privpay_app`, baca `privpay_auditor`), dan seluruh hasil di PostgreSQL 16 (diulang saat fase Docker). Tidak ada angka performa yang boleh diambil dari prototipe (ADR-0004).

## Keadaan sesudah penghapusan

- Database uji `privpay_privacy_test_p2`, `_p2x`, dan `_p3` sudah di-drop; tersisa `privpay_privacy` dan peran dari `scripts/db/bootstrap.ps1`.
- Berkas kata sandi di `secrets/` tetap ada dan tidak di-commit.
- Dependensi `pg` berada di folder prototipe yang dihapus; dependensi resmi masuk di tiket M0 dengan alasan, lisensi, dan hasil audit (ADR-0002).
