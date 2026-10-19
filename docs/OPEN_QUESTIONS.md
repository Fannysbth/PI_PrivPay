# Pertanyaan terbuka dan kontradiksi (untuk /grill-me dan /grill-with-docs)

Disusun dari pembacaan PRD v2.4 (rev 186) dan Metodologi v8. Kolom "Usulan bawaan" adalah default yang boleh dipakai bila user tidak punya preferensi, tetapi tetap harus dikonfirmasi. Status: `TERBUKA` / `TERJAWAB` / `DITUNDA`.

## A. Kontradiksi di dalam PRD (perlu errata; PRD lengkap tidak diubah oleh Claude Code)

| ID | Temuan | Lokasi PRD | Usulan bawaan | Status |
| --- | --- | --- | --- | --- |
| E-01 | Jumlah gerbang tidak konsisten: KPI dan US-06 menyebut "4 gate", 7.4 dan 6 (Empat pilar) menyebut lima gerbang | 1 (KPI), 3 (US-06) vs 7.4 | Lima gerbang + syarat tambahan (policy `boleh_dibuka`, peran auditor) | TERJAWAB (lima gerbang + dua syarat tambahan; Fase 1b) |
| E-02 | TF-06 masih mengharapkan `subject_id` dikembalikan oleh audit; v2.4 melarangnya (D-01) | 18.1 TF-06 | Tulis ulang TF-06: audit rutin mengembalikan token P7 tanpa identitas (selaras TK-22), dan alur pembukaan diuji di TK-21/TK-23..28 | TERJAWAB (TF-06 ditulis ulang di spec) |
| E-03 | Contoh kontrak `/de-pseudonymize` belum memuat `disclosure_id` dan responsnya masih menampilkan `subject_id`+NIK+nama | 10 Kontrak inti | Ikuti 7.4: permintaan wajib `disclosure_id`; respons hanya atribut yang disetujui | TERJAWAB (`{pseudonym, purpose, disclosure_id}` wajib; respons `{mapping_id, attributes}` tanpa `subject_id`) |
| E-04 | "Kedua puluh satu kasus" padahal TK-01..TK-28 (28 kasus) | 18.3 | 28 kasus | TERJAWAB (28 kasus) |
| E-05 | Katalog action audit belum memuat `DISCLOSURE_REQUESTED/APPROVED/REJECTED`; baris RESOLVE_NOTIF_DOMAIN memuat reason GATE 5 (salin-tempel keliru) | 12 | Tambahkan tiga action; bersihkan reason | TERJAWAB (tiga action ditambah; reason GATE 5 pindah ke `DE_PSEUDONYMIZE`) |
| E-06 | `audit_log.disclosure_id` hanya disebut sebagai komentar, tidak ada di DDL; belum ada kolom untuk "nama atribut" yang dibuka | 11, 7.4 | Tambah kolom `disclosure_id UUID REFERENCES disclosure_request(id)` dan `detail JSONB` terbatas (daftar nama atribut saja, tanpa nilai), dengan CHECK/validator | TERJAWAB (diubah: `disclosure_id` FK + `attribute_names TEXT[]` dengan CHECK ∈ {customer_id, nik, nama}, bukan JSONB) |
| E-07 | Tabel kode error belum memuat `DISCLOSURE_NOT_FOUND`, `DISCLOSURE_NOT_APPROVED`, `DISCLOSURE_EXPIRED`, `REQUESTER_MISMATCH`, `SELF_APPROVAL`, `INVALID_BASIS`, `ATTRIBUTE_NOT_ALLOWED` | 10 | Tambahkan beserta HTTP status dari 7.4 dan TK-23..27 | TERJAWAB (ADR-0008; kode klien menjadi delapan) |
| E-08 | Riwayat revisi berhenti di v2.3 dan judul masih "v2"; widget use case, sequence E, ERD belum digambar ulang untuk v2.4 (catatan memori proyek) | Lampiran B | Tambah baris v2.4 | DITANGANI Fanny (PRD diperbarui terpisah) |
| E-09 | TK dikatakan menghasilkan "reason" tertentu (mis. 403 DISCLOSURE_NOT_APPROVED) sementara Gateway menyamarkan semua reason menjadi `ACCESS_DENIED` ke klien eksternal | 10 vs 18.3 | Tes keamanan dijalankan di dua lapis: antar-layanan (reason rinci) dan lewat Gateway (hanya `ACCESS_DENIED`) | TERJAWAB (dua lapis; ADR-0008) |

## B. Keputusan yang belum ditetapkan PRD

| ID | Pertanyaan | Mengapa penting | Usulan bawaan | Status |
| --- | --- | --- | --- | --- |
| Q-01 | Monorepo dan tooling: pnpm workspaces, versi Node, Jest vs Vitest, ESLint, Prettier, pustaka validasi (zod), logger (pino + redaction), migrasi (node-pg-migrate atau SQL polos) | Berpengaruh ke semua tiket | Lihat ADR-0002 | TERJAWAB (ADR-0002 Accepted; runner migrasi sendiri; Node 24, PostgreSQL 16 port 5433) |
| Q-02 | Satu basis kode tiga mode: skema DB hilir berbeda di baseline (kolom identitas) vs proposed (kolom pseudonim). Cara memisahkan: adapter repositori per mode, migrasi per mode, atau kolom generik? | Risiko duplikasi logika bisnis dan bias pengukuran | Antarmuka repositori dengan dua implementasi; logika bisnis di atasnya identik | TERJAWAB (ADR-0006, termasuk tes kesetaraan perilaku) |
| Q-03 | Mode `static` untuk uji penautan | Ruang lingkup M5/M6 | Tidak berlaku: hanya dua kondisi, baseline dan proposed (ADR-0003). Uji penautan membandingkan keduanya | TERJAWAB |
| Q-04 | Asal `customer_id` (CUST-xxxxxx): atribut Keycloak, dibangkitkan Gateway, atau dibangkitkan layanan lain? Sumber klaim JWT? | Gateway membacanya dari klaim; A2 "Diterima customer_id" | Dibangkitkan saat A2 lewat atribut pengguna Keycloak, masuk klaim `customer_id` | TERJAWAB (ADR-0007: dev-idp membangkitkan CUST-NNNNNN) |
| Q-05 | "Konsol admin" tidak punya UI (UI out of scope). Apakah hanya klien API berperan admin/auditor lewat Gateway dengan `requesting_service=ADMIN_CONSOLE`? | Tabel 3 memakai ADMIN_CONSOLE sebagai pemanggil | Ya; satu service account/klaim peran `admin`/`auditor` lewat Gateway | TERJAWAB (ADR-0004, ADR-0007) |
| Q-06 | Bank simulator dan SMS simulator: kontainer terpisah (Node kecil)? Siapa yang memegang kredensialnya? Bagaimana SMS "terkirim" diverifikasi di tes? | Tes TF-02, TF-13, pemindai PII (HP keluar ke penyedia SMS) | Dua kontainer kecil; SMS simulator merekam pesan di memori dan mengeksposnya hanya untuk tes | TERJAWAB (ADR-0004) |
| Q-07 | Desain peran dan klaim Keycloak: peran, service account, audience, masa berlaku, cara Gateway menyuntik `requesting_service` | NFR-21; D-16 | Satu klien per layanan, peran realm untuk manusia, access token ≤ 5 menit | TERJAWAB (ADR-0007: pola dua token) |
| Q-08 | Pendaftaran bersifat multi-langkah (A2 Keycloak, A3, A4, A5). Bagaimana bila A5 gagal setelah A2 sukses? Kompensasi (hapus pengguna) atau status pendaftaran tertunda? | Konsistensi data, FR-42 | Saga dengan kompensasi eksplisit dan idempoten (hapus pengguna Keycloak bila A5 gagal); rincian di spec | TERJAWAB (ADR-0005: urutan A2, A5, A3, A4) |
| Q-09 | Tiga jaringan Docker (PRD 17) tidak diuraikan di teks; pembagian zona kepercayaan dan layanan mana di jaringan mana; TLS dev (CA sendiri) untuk jalur Gateway→Privacy dan klien→Kong | NFR-06, ancaman sniffing | `edge` (Kong), `business` (Transaction, Fraud, Notification, Reconciliation), `privacy` (Privacy Service + privacy-db); hanya Kong dan layanan bisnis yang menjangkau Privacy | TERJAWAB untuk fase lokal (ADR-0004: allowlist + loopback); TLS dan tiga jaringan Docker = utang NFR-06 |
| Q-10 | Plugin Lua di Kong atau `gateway-adapter` | Risiko jadwal M2 | Putuskan setelah prototipe P-1 | DITUNDA ke fase Docker (ADR-0004) |
| Q-11 | Ruang token 32 bit: kolisi akan muncul pada ~65 ribu token (paradoks ulang tahun) dan penebakan token valid secara teoretis mungkin (4,3 miliar). Diterima sebagai FINAL; perlu mitigasi operasional | D-11, ancaman enumerasi | Rate limit + audit `TOKEN_NOT_FOUND` + peringatan pada summary; tidak mengubah format | TERJAWAB (diterima; tes tabrakan lewat penyuntikan HMAC, C-04) |
| Q-12 | Rantai hash audit (`prev_hash`/`row_hash`): dikerjakan atau hanya dirancang? Pertanyaan ini juga terbuka untuk dosen | Konkurensi tulis (serialisasi penulisan audit) menambah kompleksitas | Rancang saja; jangan implementasi sebelum M3 stabil | TERJAWAB (hanya dirancang; `prev_hash`/`row_hash` nullable; rancangan singkat di spec) |
| Q-13 | `pii-scan` memindai log kontainer, payload antar-layanan, dan isi DB. Bagaimana menangkap payload antar-layanan (proxy tap, log tingkat debug, atau pencatatan di tes)? | Metrik utama E(s) | Proxy pengamat di jaringan uji + dump DB + log; keputusan di spec pengujian | TERJAWAB (proxy pengamat dengan URL dari env; hanya di memori; + dump DB + log; tiket tersendiri di M2) |
| Q-14 | Bentuk `Idempotency-Key` pada transaksi paralel: penguncian di DB atau advisory lock | NFR-23 | Unique constraint pada `idempotency_key` + penanganan konflik | TERJAWAB (ADR-0009: bandingkan token + atribut; jendela efektif = TTL P1) |
| Q-15 | Strategi migrasi: forward-only, satu skema per layanan, pengguna DB berperan (`privacy_app`, `auditor_role`) dibuat oleh siapa dan kapan | NFR-09, TK-10 | Skrip inisialisasi DB di deploy/ + migrasi aplikasi | TERJAWAB (`scripts/db/bootstrap.sql` oleh superuser; pemilik skema ≠ peran runtime; GRANT/REVOKE di migrasi; DB tes dibuat ulang tiap run) |
| Q-16 | Spesifikasi hardware untuk pengukuran M7 | PRD mensyaratkan ≥ 4 vCPU, 8 GB | Lingkungan dev boleh dipakai untuk bukti kebenaran; angka final dari VPS | DITUNDA |

## C. Pertanyaan yang memang dikembalikan ke dosen pembimbing (jangan diputuskan sendiri)

PRD 20, nomor 1..7: modul Audit di dalam Privacy Service, rantai hash, pemisahan paparan umum/spesifik, dua kondisi (baseline/proposed; static dibatalkan, ADR-0003), retensi 90 hari, finalitas Tabel 1/2, jendela 30 hari di Fraud. Claude Code mengikuti default PRD dan menandai di spec bahwa bagian itu menunggu jawaban dosen.

## D. Referensi yang belum diverifikasi (bukan urusan kode, jangan dikutip sebagai fakta di README)

Pasal 4 UU PDP, EDPB Guidelines 01/2025 par. 22, Flegel 2005, Petersen PET-CON 2018.

## E. Butir wajib untuk spec dan tiket Fase 3 (hasil Fase 2, belum teruji atau menunggu rincian)

| ID | Butir | Sumber | Status |
| --- | --- | --- | --- |
| S-01 | Perbandingan nilai rahasia dengan `timingSafeEqual`: tes dan tinjauan kode; belum diuji di prototipe | CLAUDE.md, T-10, ADR-0011 | BELUM TERUJI |
| S-02 | `ON CONFLICT` paralel pada `POST /transaction` (dua permintaan identik bersamaan, penantian pemenang, batas `HTTP_TIMEOUT_MS`) sebagai tes integrasi M4 | ADR-0009, NFR-23 | BELUM TERUJI |
| S-03 | Batasi `aud` token aktor ke layanan tujuan | ADR-0007, T-15 | USULAN |
| S-04 | `X-Actor-Token` ditolak bila `Authorization` sudah token manusia (`ADMIN_CONSOLE`) | ADR-0007 | DISETUJUI, tulis di spec |
| S-05 | `POST /identity` idempoten; perilaku `revoke_subject` untuk subjek tanpa token dan tanpa brankas | ADR-0005 | RINCIAN SPEC |
| S-06 | TF-15 [strategi C] tidak cukup sebagai penjaga konkurensi; jalankan berulang di M2 | ADR-0010 | RINCIAN TIKET |
| S-07 | Penulisan audit lewat koneksi `privpay_app` tanpa `RETURNING`; pembacaan lewat `privpay_auditor` (dua pool); belum diuji | ADR-0010 | BELUM TERUJI |
