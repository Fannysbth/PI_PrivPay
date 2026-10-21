# HANDOFF (2026-10-21): Gerbang 3 M2 selesai, menunggu persetujuan merge

Untuk memulai sesi baru tanpa kehilangan konteks. Sumber kebenaran tetap `CLAUDE.md`, `docs/DESIGN_DECISIONS.md`, ADR, PRD.

## Status

- `main` (lokal, **belum di-push**, di `491229e`) memuat M0, M1, M2 sampai M2-09 (tanpa M2-08, M2-10, M2-11), alat pembersih DB tes, lapisan HTTP Privacy (M2-12), tabel tautan transaksi (K-28, K-29; ADR-0013) dan `endOfLine: "auto"` untuk Prettier.
- `feat/m2-gerbang-3` (lokal, **belum di-push, belum di-merge**, tujuh commit di atas `main`): M2-08 brankas identitas (`POST /identity`), M2-10 pemindai kenari v1 (`pnpm pii-scan`), M2-11 `Tokenizer` Gateway dengan rute AZ-03 (`POST /transaction`) dan AZ-09 (`POST /settlement/report`) dan enam vektor kontrak, perbaikan `/code-review`, keputusan N-25..N-27, dan dua perbaikan tes (UUID uji dibangun saat jalan; penantian job retensi tanpa batas polling).
- `backup/m2-gerbang-3-sebelum-rewrite`: cadangan cabang di atas **sebelum** riwayat lokalnya ditulis ulang (supaya tiga UUID fiktif `Idempotency-Key` di berkas tes bawah `services/` tidak ada di commit mana pun; pohon akhir identik, `git diff` ke cadangan kosong). Cadangan itu masih memuat commit lama `094c77d`, jadi `gitleaks --log-opts="--all"` mentah menandainya. Pemindaian riwayat penuh tanpa cadangan: `--log-opts="--exclude=refs/heads/backup/* --all"`, bersih. Hapus cabang cadangan bila tidak dibutuhkan lagi, lalu `--all` bersih.

## Hasil gerbang penuh `feat/m2-gerbang-3` (dua putaran berturut-turut, satu proses pada satu waktu, tanpa lari tumpang tindih)

| Langkah | Putaran 1 | Putaran 2 |
| --- | --- | --- |
| eslint + prettier | hijau | hijau |
| typecheck | hijau | hijau |
| unit (2 worker) | hijau, 51 suite, 1027 tes | hijau, 51 suite, 1027 tes |
| integrasi | hijau, 15 suite, 323 tes | hijau, 15 suite, 323 tes |
| smoke | hijau, 20 tes | hijau, 20 tes |
| audit --prod | tidak ada kerentanan | tidak ada kerentanan |
| gitleaks riwayat (tanpa cabang cadangan) | bersih | bersih |

`/code-review` dan `/security-review` dijalankan; tidak ada temuan keamanan dengan keyakinan ≥ 8. Temuan review yang ditolak dan alasannya ada di pesan laporan sesi (settlement per kelompok 16, token tersisa saat satu subjek gagal, `transaction_id` per proses sesuai K-17, urutan validasi di `/identity`, retry `pseudonymize` idempoten).

### Catatan lari bermasalah (diamati, belum dibuktikan)

- Lari `test:integration` oleh pengguna di terminal gagal di 13 suite dengan gejala dua proses memakai database tes yang sama (`pg_database_datname_index` duplikat, tabel hilang di tengah tes, baris tes lain ikut terhitung). **Diduga** lari tumpang tindih pada database tes yang sama (mis. sisa gerbang latar belakang yang dihentikan sistem karena memori). Tidak dibuktikan dengan mengulang tumpang tindih; saat dijalankan sendirian suite yang sama hijau.
- Satu kali, tes M2-09 `step 1 does not wait for a row in use` gagal (`expired` 2, seharusnya 1) saat lari penuh, padahal lulus 8 dari 8 saat sendirian dan tetap lulus ketika batas polling dipaksa 1. Penyebab **belum terbukti**; dugaan: batas 3000 polling `pg_locks` habis sebelum job mencapai `UPDATE` pada mesin berat, sehingga kunci baris dilepas terlalu cepat. Celahnya ditutup di tes (commit `250d020`); kode produksi tidak berubah. Bila muncul lagi, selidiki sebagai bug nyata.
- Ada **39 database tes sisa** (`pnpm db:test-databases list`). Tidak menghalangi tes (`createTestDb` menghapus yang bernama sama), tetapi bersihkan dengan `pnpm db:test-databases drop` di terminal interaktif dan ketik `DROP 39` (alat menolak konfirmasi lewat pipa).
- Satu gerbang penuh memakan puluhan menit di mesin ini; `test:integration` saja sekitar 7 sampai 13 menit. Jalankan satu proses pada satu waktu.

## Keputusan yang sudah final (jangan ditanya lagi)

K-27 (semua penolakan keputusan diaudit DENIED), K-29 (bentuk 3 menolak sumber `revoked`), K-30 (terminal final; terminal ke terminal lain 409), K-31, K-32 (`requesting_service = PRIVACY_SERVICE` pada `PURGE_IDENTITY`), K-33 (catatan M3-02), K-28 = opsi (b)+(d) (ADR-0013, E-30). Urutan validasi, basis, atribut, token, pola field audit: sudah disetujui sebelumnya.

Gerbang 3 (`docs/OPEN_QUESTIONS.md`): **N-25** `POST /identity` memakai kunci penasihat + `SELECT FOR UPDATE` + `INSERT`/`UPDATE`, bukan `ON CONFLICT DO UPDATE`, karena AAD terikat id baris (spec 4.9 diperbarui; tes delapan pemanggilan serentak). **N-26** nama kenari berhuruf (`Kenari` + enam huruf), pemindai terbukti mendeteksinya. **N-27** batas badan settlement tetap 64 KiB, jumlah item turun ke 500 (`MAX_SETTLEMENT_ITEMS`; spec gateway-tokenizer 5 dan reconciliation diperbarui).

K-28 (disetujui 2026-10-21): kunci `transaction_link` empat kolom (`transaction_id`, `subject_type`, `service_id`, `purpose`); transaction id yang sama dengan pseudonym lain = `IDEMPOTENCY_CONFLICT` 409; `privpay_app` mendapat `DELETE` hanya pada `transaction_link`; re-issue tidak pernah membuat tautan.

## Belum teruji / belum ada

- Fail-closed dengan Privacy mati di compose (butuh Docker, M7): tidak dinyatakan lulus. Fail-closed diuji di tingkat Gateway (Privacy tidak terjangkau, 5xx, jawaban bukan pseudonym: 503 tanpa panggilan hilir) dengan Privacy asli dihentikan di tes integrasi, bukan di compose.
- `RetentionJob` belum dipasang ke siklus hidup proses (ada `nextRunAt`, belum dijadwalkan). `revoke_subject` (M3-02) harus mengosongkan kedua kolom bersama `purged_at` dan menghapus tautan, dengan kunci baris yang sama dengan job.
- Rute `/register` dan `/notification/register` serta `RegistrationFlow` belum ada (M4-08). Plugin Lua belum diuji terhadap vektor kontrak (DK-02).
- Body bukan JSON dari pemanggil tanpa token mendapat 422 sebelum 401 (parser JSON di bootstrap bersama). Dicatat, belum diubah.
- Belum ada: M3-xx, `pnpm test:security`, `pnpm newman`, Docker.

## Langkah berikutnya

1. Persetujuan Anda untuk merge `feat/m2-gerbang-3` ke `main` (dan menghapus cabang cadangan bila tidak perlu). Belum dilakukan.
2. M3-01 sampai M3-06 (satu tiket sekali jalan, `/tdd`, dua review untuk tiket inti, gerbang penuh di akhir tiket), lalu `/security-review` milestone untuk M2/M3. Catatan M3-02 dari K-33 dan tautan transaksi di atas.
3. Sebelum M4: `/improve-codebase-architecture` setelah M4 dan M5 sesuai alur; Docker menyusul setelah M4 stabil (ADR-0004).

Aturan hemat tetap berlaku: dokumentasi singkat sekali per tiket, mutasi hanya pada pengaman terpenting (timeout, pemulihan otomatis), dua review hanya untuk tiket inti, keluaran ringkas.
