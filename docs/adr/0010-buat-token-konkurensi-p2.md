# ADR-0010: buat_token aman terhadap konkurensi hanya dengan kunci per-kombinasi (hasil prototipe P-2)

- Status: Accepted (disetujui Fanny, 2026-10-19; strategi C sebagai mekanisme utama, strategi B sebagai alternatif)
- Tanggal: 2026-10-19
- Pengambil keputusan: Fanny
- Terkait: PRD 7.1 (buat_token), PRD 7.6, PRD 11, T-05, T-06, FR-33, TF-07, TF-15, C-02, C-03, C-04, TK-10, S-22, S-34, S-35, ADR-0004

## Konteks

PRD 7.1 menulis STEP 1 buat_token sebagai `SELECT ... FOR UPDATE` pada kombinasi (lookup, layanan, purpose), lalu menandai baris aktif yang kedaluwarsa, mencari baris aktif, dan baru INSERT. Pertanyaan P-2: apakah itu cukup di PostgreSQL sungguhan dengan permintaan paralel yang sama, dengan koneksi sebagai peran runtime asli?

## Opsi yang diuji (prototipe sekali pakai, `prototypes/p2-p3-privacy-db/`)

- **A** — persis PRD: `FOR UPDATE`, tandai expired, cari, INSERT (`ON CONFLICT (pseudonym) DO NOTHING` untuk tabrakan token).
- **B** — A, lalu ulangi seluruh transaksi bila indeks unik parsial `uq_mapping_active` dilanggar.
- **C** — A, didahului `pg_advisory_xact_lock(hashtextextended(lookup|layanan|purpose, 0))` dalam transaksi yang sama.

## Hasil (PostgreSQL 18 di localhost:5432, peran `privpay_app`, pool 25 koneksi, 50 permintaan paralel)

- **A gagal.** 20 putaran x 50 permintaan pertama-kali untuk subjek baru: **456 dari 1000 permintaan ditolak** dengan `23505 uq_mapping_active`. Penyebabnya: `FOR UPDATE` pada baris yang belum ada tidak mengunci apa pun, sehingga dua transaksi sama-sama tidak menemukan baris aktif dan sama-sama INSERT.
- **B dan C: 0 penolakan** pada eksperimen yang sama. Pada `node --test p2.test.mjs`, 9 dari 9 tes lulus: satu `reused:false` dan 49 `reused:true`, satu baris aktif per subjek, token sama untuk semua pemanggil (TF-07/C-03); setelah TTL, tepat satu token baru dan baris lama `expired` tanpa pelanggaran unique (TF-15/C-02); token berbeda per layanan/purpose dan per subjek (FR-05); tabrakan nilai pseudonym diulang dari nonce baru sampai 4 percobaan (C-04).
- B bekerja lewat percobaan ulang dan tampak jauh lebih lambat dalam satu kali pengamatan kasar. Itu bukan data performa dan tidak boleh dilaporkan (ADR-0004).
- **Hak akses dengan peran asli (diuji, bukan diasumsikan):** `privpay_app` tidak dapat UPDATE, DELETE, atau TRUNCATE `audit_log`; `privpay_auditor` hanya SELECT (UPDATE, DELETE, INSERT ditolak `42501`); `privpay_auditor` tidak dapat membaca `identity_vault` maupun `pseudonym_mapping`; `privpay_app` tidak dapat membaca `audit_log`; `chk_four_eyes` menolak `approver_id = requester_id` meski ditulis langsung (`23514`). **Mutasi:** mengganti kondisi kunci advisory menjadi `if (false)` membuat tes TF-07/C-03 [strategi C] dan FR-05 gagal dengan `23505`. Tes TF-15 [strategi C] tidak ikut gagal pada satu kali jalan, jadi tes itu saja tidak cukup sebagai penjaga dan harus dijalankan berulang di tiket M2. Mutasi pada tes hak akses tidak dilakukan.

## Keputusan

1. buat_token memakai **C**: kunci advisory transaksi per (lookup, layanan, purpose) sebagai langkah pertama. Ini menggantikan `FOR UPDATE` sebagai mekanisme pencegah penerbitan ganda. `FOR UPDATE` boleh tetap ada untuk baris yang sudah ada, tetapi tidak boleh dianggap cukup. **Strategi B** (ulang transaksi saat `uq_mapping_active` dilanggar) dicatat sebagai alternatif bila kunci advisory tidak dapat dipakai (mis. pooler mode transaksi).
2. Tabrakan nilai pseudonym ditangani dengan `INSERT ... ON CONFLICT (pseudonym) DO NOTHING RETURNING id` dan ulang dari STEP 2 bila 0 baris. `INSERT` biasa yang melanggar unique membatalkan seluruh transaksi PostgreSQL, sehingga "ulangi dari STEP 2" pada PRD 7.1 tidak dapat berjalan di transaksi yang sama.
3. Penulisan audit memakai koneksi `privpay_app` (INSERT saja); pembacaan `/audit-log` memakai koneksi `privpay_auditor` (SELECT saja): dua pool terpisah di Privacy Service.
4. `docs/PRD_ERRATA.md` mencatat selisih ini (E-19).

## Batas bukti (jangan dilebihkan)

- Satu mesin, PostgreSQL 18 (bukan 16); ulangi di 16 pada fase Docker.
- 50 tugas paralel dengan pool 25 koneksi; bukan beban produksi.
- Waktu tidak dipakai sebagai bukti performa.

## Dampak

- Keamanan: menutup T-05 (race penerbitan ganda) dengan bukti, dan T-06 (blokir indeks oleh baris kedaluwarsa) lewat penandaan di dalam kunci yang sama.
- Pengujian: TF-07, TF-15, C-03, C-04 menjadi tes integrasi wajib di tiket M2 dengan 50 permintaan paralel dan koneksi per peran.
- Yang harus diubah: spec `privacy-service` (algoritma buat_token), `PRD_ERRATA.md`, `qa-checklist.md` C-03.

## Kapan ditinjau ulang

Setelah tes skema diulang di PostgreSQL 16 (fase Docker), atau bila pooler koneksi (mis. PgBouncer mode transaksi) dipakai, karena kunci advisory bergantung pada sesi/transaksi.
