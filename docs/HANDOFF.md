# HANDOFF (2026-10-21): dari Gerbang 2 M2 ke Gerbang 3

Untuk memulai sesi baru tanpa kehilangan konteks. Sumber kebenaran tetap `CLAUDE.md`, `docs/DESIGN_DECISIONS.md`, ADR, PRD.

## Status

- `main` (lokal, **belum di-push**) memuat M0, M1, M2 sampai M2-09 (tanpa M2-08, M2-10, M2-11), alat pembersih DB tes, lapisan HTTP Privacy (M2-12) dan tabel tautan transaksi (K-28, K-29; ADR-0013, `docs/security/review-K28.md`). Gerbang penuh di `main` setelah merge hijau: eslint, typecheck, 935 unit, 296 integrasi, 20 smoke, audit prod, gitleaks. Cabang tidak dihapus.
- `chore/prettier-eol-auto` (belum di-merge, satu commit): `endOfLine: "auto"` di `.prettierrc.json`, supaya `pnpm lint` hijau di Windows (`core.autocrlf=true` menulis CRLF di working tree). Di `main` `pnpm lint` masih merah di Windows sampai cabang ini di-merge.

## Keputusan yang sudah final (jangan ditanya lagi)

K-27 (semua penolakan keputusan diaudit DENIED), K-29 (bentuk 3 menolak sumber `revoked`), K-30 (terminal final; terminal ke terminal lain 409), K-31, K-32 (`requesting_service = PRIVACY_SERVICE` pada `PURGE_IDENTITY`), K-33 (catatan M3-02), K-28 = opsi (b)+(d) (ADR-0013, E-30). Urutan validasi, basis, atribut, token, pola field audit: sudah disetujui sebelumnya.

## Keputusan K-28 yang sudah disetujui Fanny (2026-10-21)

Kunci `transaction_link` empat kolom (`transaction_id`, `subject_type`, `service_id`, `purpose`); penolakan transaction id yang sama dengan pseudonym lain = `IDEMPOTENCY_CONFLICT` 409 (jalur setelah token pertama kedaluwarsa: re-issue di Transaction Service, M4); `privpay_app` mendapat `DELETE` hanya pada `transaction_link` (tes TK-10 membuktikan tetap tanpa `DELETE` pada `pseudonym_mapping`, `identity_vault`, `disclosure_request`, `transaction_status`, `audit_log`). Re-issue tidak pernah membuat tautan (temuan security review).

## Belum teruji / belum ada

- Fail-closed dengan Privacy mati di compose (butuh Docker, M7): tidak dinyatakan lulus. Autentikasi token layanan diuji di tingkat HTTP Privacy; TK-16 belum.
- `RetentionJob` belum dipasang ke siklus hidup proses (ada `nextRunAt`, belum dijadwalkan). `revoke_subject` (M3-02) harus mengosongkan kedua kolom bersama `purged_at` dan menghapus tautan, dengan kunci baris yang sama dengan job.
- Body bukan JSON dari pemanggil tanpa token mendapat 422 sebelum 401 (parser JSON di bootstrap bersama). Dicatat, belum diubah.
- Belum ada: M2-08 (brankas identitas), M2-10 (pemindai kenari), M2-11 (tokenizer gateway), M3-xx, `pnpm test:security`, `pnpm newman`, `pnpm pii-scan`, Docker.

## Langkah berikutnya

1. Merge `chore/prettier-eol-auto` ke `main` bila setuju.
2. Gerbang 3: tiket M2-08, M2-10, M2-11 lalu M3 (satu tiket sekali jalan, `/tdd`, dua review untuk tiket inti, gerbang penuh di akhir tiket). Catatan M3-02 dari K-33 dan tautan transaksi di atas.
3. Sebelum M4: `/improve-codebase-architecture` setelah M4 dan M5 sesuai alur; Docker menyusul setelah M4 stabil (ADR-0004).

Aturan hemat tetap berlaku: dokumentasi singkat sekali per tiket, mutasi hanya pada pengaman terpenting (timeout, pemulihan otomatis), dua review hanya untuk tiket inti, keluaran ringkas.
