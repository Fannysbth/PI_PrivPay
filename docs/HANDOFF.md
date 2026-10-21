# HANDOFF (2026-10-21): dari Gerbang 2 M2 ke Gerbang 3

Untuk memulai sesi baru tanpa kehilangan konteks. Sumber kebenaran tetap `CLAUDE.md`, `docs/DESIGN_DECISIONS.md`, ADR, PRD.

## Status

- `main` (lokal, **belum di-push**) memuat M0, M1, M2 sampai M2-09 (tanpa M2-08, M2-10, M2-11) dan alat pembersih DB tes (`chore/m0-05-test-db-cleanup`). Gerbang penuh di `main` hijau, kecuali `prettier --check` di Windows karena CRLF dari `core.autocrlf=true` (isi kode lolos dengan `--end-of-line auto`; CI memakai LF).
- Cabang bertingkat **belum di-merge** (menunggu persetujuan): `feat/m2-12-privacy-http-layer` (lapisan HTTP Privacy, JWKS di `packages/common`, penjaga M0-06 daftar putih) lalu `feat/k28-transaction-link` di atasnya (tabel `transaction_link`, K-29, ADR-0013, `docs/security/review-K28.md`). Ujung cabang: gerbang penuh hijau (lint, typecheck, 935 unit, 296 integrasi, 20 smoke, audit prod bersih, gitleaks bersih). Dua review dan mutasi dijalankan untuk keduanya; `/security-review` K-28: satu Medium, diperbaiki.
- Stash dibuang (konflik; salinan alat pembersih terbukti sudah ada di `a72ffdf`). Tidak ada branch yang dihapus.

## Keputusan yang sudah final (jangan ditanya lagi)

K-27 (semua penolakan keputusan diaudit DENIED), K-29 (bentuk 3 menolak sumber `revoked`), K-30 (terminal final; terminal ke terminal lain 409), K-31, K-32 (`requesting_service = PRIVACY_SERVICE` pada `PURGE_IDENTITY`), K-33 (catatan M3-02), K-28 = opsi (b)+(d) (ADR-0013, E-30). Urutan validasi, basis, atribut, token, pola field audit: sudah disetujui sebelumnya.

## Perlu konfirmasi Fanny (keputusan baru, dikerjakan dengan bawaan)

1. Kunci `transaction_link` adalah `(transaction_id, subject_type, service_id, purpose)`, bukan `transaction_id` saja: P1 (CUSTOMER) dan P2 (ACCOUNT) serta token hasil pertukaran memakai transaction id yang sama dan akan saling menolak.
2. Penolakan "transaction id sama, pseudonym lain" memakai reason `IDEMPOTENCY_CONFLICT` (409) yang sudah ada. Akibatnya `POST /pseudonymize` bentuk 1 dengan transaction id yang sama setelah token pertamanya kedaluwarsa ditolak; jalurnya re-issue (Transaction Service, M4).
3. Re-issue tidak pernah membuat tautan; tanpa tautan yang menunjuk token lama, `IDEMPOTENCY_CONFLICT` (temuan security review).
4. `privpay_app` mendapat `DELETE` hanya pada `transaction_link` (pengecualian dari "tanpa DELETE").

## Belum teruji / belum ada

- Fail-closed dengan Privacy mati di compose (butuh Docker, M7): tidak dinyatakan lulus. Autentikasi token layanan diuji di tingkat HTTP Privacy; TK-16 belum.
- `RetentionJob` belum dipasang ke siklus hidup proses (ada `nextRunAt`, belum dijadwalkan). `revoke_subject` (M3-02) harus mengosongkan kedua kolom bersama `purged_at` dan menghapus tautan, dengan kunci baris yang sama dengan job.
- Body bukan JSON dari pemanggil tanpa token mendapat 422 sebelum 401 (parser JSON di bootstrap bersama). Dicatat, belum diubah.
- Belum ada: M2-08 (brankas identitas), M2-10 (pemindai kenari), M2-11 (tokenizer gateway), M3-xx, `pnpm test:security`, `pnpm newman`, `pnpm pii-scan`, Docker.

## Langkah berikutnya

1. Fanny meninjau dan menyetujui merge `feat/m2-12-privacy-http-layer` lalu `feat/k28-transaction-link` ke `main` (lokal, tanpa push); jalankan gerbang penuh setelah merge.
2. Konfirmasi empat butir di atas (bagian "Perlu konfirmasi").
3. Gerbang 3: tiket M2-08, M2-10, M2-11 lalu M3 (satu tiket sekali jalan, `/tdd`, dua review untuk tiket inti, gerbang penuh di akhir tiket). Catatan M3-02 dari K-33 dan tautan transaksi di atas.
4. Sebelum M4: `/improve-codebase-architecture` setelah M4 dan M5 sesuai alur; Docker menyusul setelah M4 stabil (ADR-0004).

Aturan hemat tetap berlaku: dokumentasi singkat sekali per tiket, mutasi hanya pada pengaman terpenting (timeout, pemulihan otomatis), dua review hanya untuk tiket inti, keluaran ringkas.
