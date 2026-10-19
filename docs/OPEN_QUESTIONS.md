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
| S-01 | Perbandingan nilai rahasia dengan `timingSafeEqual`: tes dan tinjauan kode; belum diuji di prototipe | CLAUDE.md, T-10, ADR-0011 | KRITERIA PENERIMAAN tiket M1-02 (`platform-dan-ci.md` bagian 15) |
| S-02 | `ON CONFLICT` paralel pada `POST /transaction` (dua permintaan identik bersamaan, penantian pemenang, batas `HTTP_TIMEOUT_MS`) sebagai tes integrasi M4 | ADR-0009, NFR-23 | KRITERIA PENERIMAAN tiket M4-01 (`transaction.md` bagian 8) |
| S-03 | Batasi `aud` token aktor ke layanan tujuan | ADR-0007, T-15 | DITERIMA (K-03) |
| S-04 | `X-Actor-Token` ditolak bila `Authorization` sudah token manusia (`ADMIN_CONSOLE`) | ADR-0007 | DISETUJUI, tulis di spec |
| S-05 | `POST /identity` idempoten; perilaku `revoke_subject` untuk subjek tanpa token dan tanpa brankas | ADR-0005 | RINCIAN SPEC |
| S-06 | TF-15 [strategi C] tidak cukup sebagai penjaga konkurensi; jalankan berulang di M2 | ADR-0010 | KRITERIA PENERIMAAN tiket M2-05 (TF-15 khusus, `privacy-service.md` bagian 12) |
| S-07 | Penulisan audit lewat koneksi `privpay_app` tanpa `RETURNING`; pembacaan lewat `privpay_auditor` (dua pool); belum diuji | ADR-0010 | KRITERIA PENERIMAAN tiket M2-04 (`privacy-service.md` bagian 12) |

## F. Keputusan spec (diterima Fanny dengan nilai bawaan, Gerbang 3)

Nilai bawaan dipakai spec sampai diputuskan. "Dampak" menunjukkan spec yang berubah bila jawabannya lain.

| ID | Keputusan spec (nilai bawaan) | Dampak | Status |
| --- | --- | --- | --- |
| K-01 | reason `DISCLOSURE_NOT_PENDING` 409 untuk approve/reject di luar status PENDING | PV 4.10, PL 4 | DITERIMA (bawaan, Gerbang 3) |
| K-02 | reason `TRANSACTION_NOT_FOUND` 404 untuk audit-request pada `transaction_id` tak dikenal | RC 3.3, TX 3.4 | DITERIMA (bawaan, Gerbang 3) |
| K-03 | `aud` token aktor dibatasi ke layanan di jalur peran (auditor, fraud_analyst, admin) | PL 7.6 | DITERIMA (bawaan, Gerbang 3) (S-03) |
| K-04 | `CHECK` nilai pada `transactions.status` dan `fraud_decision` | DM 5 | DITERIMA (bawaan, Gerbang 3) |
| K-05 | `UNIQUE (batch_id, bank_reference)` pada `settlement_items` | DM 8, RC 3.1 | DITERIMA (bawaan, Gerbang 3) |
| K-06 | pola nomor rekening `^[0-9]{8,20}$` | PV 4, GW 3 | DITERIMA (bawaan, Gerbang 3) |
| K-07 | `INVALID_BASIS`/`ATTRIBUTE_NOT_ALLOWED` juga ditulis sebagai audit DENIED (tanpa baris `disclosure_request`) | PV 4.10 | DITERIMA (bawaan, Gerbang 3) |
| K-08 | filter `action` dan `disclosure_id` pada `GET /audit-log` | PV 4.8 | DITERIMA (bawaan, Gerbang 3) (E-27) |
| K-09 | status transaksi terminal di Privacy tidak dapat kembali ke non-terminal (409 `TX_TERMINAL`) | PV 4.7 | DITERIMA (bawaan, Gerbang 3) |
| K-10 | `POST /identity` idempoten (201 lalu 200) | PV 4.9 | DITERIMA (bawaan, Gerbang 3) |
| K-11 | token `expired` dapat dicabut; pencabutan ulang idempoten | PV 4.5 | DITERIMA (bawaan, Gerbang 3) |
| K-12 | batas body 16 KiB, pola `case_ref`, batas 20 percobaan tabrakan nilai pseudonym | PV 4, 7.2 | DITERIMA (bawaan, Gerbang 3) |
| K-13 | brankas hilang saat pembukaan → `TOKEN_NOT_FOUND` 404 | PV 7.8 | DITERIMA (bawaan, Gerbang 3) |
| K-14 | rute `POST /register` di Gateway dan pembatasan laju per alamat sumber untuk rute itu | GW 3, 6, 7 | DITERIMA (bawaan, Gerbang 3) (E-26) |
| K-15 | rute `POST /reconciliation/disclosure` | RC 3.4, GW 3 | DITERIMA (bawaan, Gerbang 3) (E-25) |
| K-16 | `amount` ≥ 1 (SECURITY.md: non-negatif); pola `geohash` dan `merchant_id` | GW 3, TX 3.1 | DITERIMA (bawaan, Gerbang 3) |
| K-17 | `transaction_id` = `TX-` + epoch milidetik + penghitung 3 digit | GW 4 | DITERIMA (bawaan, Gerbang 3) |
| K-18 | endpoint Transaction untuk Reconciliation: `GET /transaction/completed`, `GET /transaction/{id}` | TX 3.4, RC 3.2/3.3 | DITERIMA (bawaan, Gerbang 3) (E-23, E-24) |
| K-19 | env baru `TX_SWEEP_INTERVAL_SECONDS` (30) | TX 5 | DITERIMA (bawaan, Gerbang 3) (E-28) |
| K-20 | env baru `FRAUD_HOLD_THRESHOLD`/`FRAUD_BLOCK_THRESHOLD`; bobot dan pengali dari `risk_rules` (dibaca runtime, `active=false` dilewati), ambang uang/jam dari env | FR 4 | DITERIMA (bawaan, Gerbang 3) (E-28) |
| K-21 | teks templat SMS dan env `SMS_SIMULATOR_TEST_ENDPOINTS`/`SMS_SIMULATOR_FAIL` | NT 3.2, 4 | DITERIMA (bawaan, Gerbang 3) |
| K-22 | status batch: `unmatched = (#item − matched) + (#transaksi − matched)`; satu laporan per tanggal; perilaku bila laporan atau Privacy tidak ada | RC 3.1, 3.2 | DITERIMA (bawaan, Gerbang 3) |
| K-23 | env baru `RECON_DAILY_RUN_UTC` (`00:10`) | RC 3.2 | DITERIMA (bawaan, Gerbang 3) (E-28) |
| K-24 | format nilai kenari dan lokasi `tests/pii-scan` untuk proxy pengamat | PP 6 | DITERIMA (bawaan, Gerbang 3) |
| K-25 | pemenang idempotensi yang masih `PENDING`: penantian hingga `HTTP_TIMEOUT_MS` lewat `Delay`, lalu 200 atau 409 | TX 5 | DITERIMA (bawaan, Gerbang 3) |
| K-26 | env baru `RETENTION_JOB_RUN_UTC` (`01:00`) untuk job retensi harian | PV 7.11 | DITERIMA (bawaan, Gerbang 3) (E-28) |

## G. Keputusan implementasi M0 yang diambil sementara (menunggu Fanny)

| ID | Keputusan (nilai sementara) | Dampak | Status |
| --- | --- | --- | --- |
| N-01 | NestJS seri 11 (11.2.7, CommonJS), bukan 12 (ESM-only): toolchain uji (Jest + ts-jest, CJS) tidak memuat paket ESM-only; pindah ke ESM mengubah seluruh repo. Ditinjau ulang bila repo berpindah ke ESM | `packages/common/package.json`, M0-06 | DITERIMA (Fanny, gerbang M0) |
| N-02 | Rute tak dikenal, metode salah, badan JSON rusak, dan badan terlalu besar dijawab `VALIDATION_ERROR` 422 (delapan kode ADR-0008 tidak punya NOT_FOUND); 401, 403, 429, 503 dari kerangka dipetakan ke kode yang sama | `nest/service-app.ts` | DITERIMA (Fanny, gerbang M0) |
| N-03 | Gateway menjawab dengan `toClientError` (tanpa `reason`), layanan lain dengan `toWireError` (ADR-0008 butir 4) | `nest/service-app.ts` | DITERIMA (Fanny, gerbang M0) |
| N-04 | Cara menjalankan layanan sebagai proses (build `tsc` ke `dist` atau runner TypeScript) belum diputuskan: `main.ts` ada dan `runService` diuji, tetapi belum ada skrip `start`. Diperlukan sebelum e2e lokal (M6-01); usul: keputusan di awal M1 | M0-06, M1 | DIPUTUSKAN (Fanny, gerbang M0): `tsc` membangun ke `dist`, layanan dijalankan dengan `node dist/main.js` (dev, e2e, CI); `tsx` hanya untuk pengembangan. Diterapkan di M1-01 |
| N-05 | `GET /health` (memuat `mode`) dan `GET /metrics` pada gateway hanya aman karena terikat ke 127.0.0.1 (S-07, AZ-43). Pada fase Docker gateway menerima lalu lintas luar, jadi kedua rute harus dipisah ke antarmuka/port internal atau diblokir di Kong sebelum DK-01 | M0-06, DK-01 | DITERIMA (Fanny, gerbang M0); pemisahan dikerjakan di fase Docker |
| N-06 | Job `integration` memulai PostgreSQL 16 lewat langkah `docker run` (digest dipin), bukan `services:` seperti tertulis di spec bagian 14 dan tiket M0-07, karena kata sandi admin dibangkitkan per run dan nilai `services:` ditetapkan sebelum langkah apa pun berjalan | M0-07, `platform-dan-ci.md` 14 | DITERIMA (Fanny, gerbang M0) |
| N-07 | Action CI naik beberapa versi mayor dari draf (checkout v4→v7, setup-node v4→v7, pnpm/action-setup v4→v6, upload-artifact v4→v7) saat dipin ke SHA; trivy-action dipin ke v0.36.0 tanpa verifikasi integritas. Workflow belum pernah dijalankan di GitHub | M0-07 | TERBUKA: diperiksa Fanny setelah run CI pertama. **Utang: workflow belum dijalankan di GitHub; cabang belum di-push (keputusan Fanny)** |
| N-08 | `POST /admin/users` menerima hanya `{username}` (zod ketat); dev-idp tidak menyimpan NIK, nama, e-mail, atau kata sandi (minimisasi data; e-mail masuk Keycloak di DK-04). M4-08 menyesuaikan isian A2 | M1-01, gateway-tokenizer.md 63 | DIAMBIL SEMENTARA, menunggu Fanny |
| N-09 | Nomor `CUST-` pembuatan baru berlanjut setelah seed (`CUST-000104`, dst.; seed memakai 000101..103) dan tidak dipakai ulang setelah dihapus; `DELETE /admin/users/{customer_id}` idempoten, seed tidak dapat dihapus (422) | M1-01, ADR-0007 butir 5 | DIAMBIL SEMENTARA, menunggu Fanny |
| N-10 | Daftar `aud` yang boleh diminta tiap service account diturunkan dari alur panggilan satu arah (api-gateway: privacy, transaction, notification, reconciliation, dev-idp; transaction: privacy, fraud, notification; fraud dan notification: privacy; reconciliation: privacy, transaction); spec tidak memuat graf panggilan eksplisit. Satu tempat: `tools/dev-idp/src/registry.ts` | M1-01, M2+, M4 | DIAMBIL SEMENTARA; tiket yang menambah panggilan baru menambah barisnya |
| N-11 | Token sahih tetapi bukan untuk dev-idp, atau milik klien lain atau manusia, ke `/admin/users` dijawab 403 (AZ-38/39 "klien lain atau manusia → 403"); tanpa token, kedaluwarsa, atau rusak dijawab 401. `POST /token` menerima JSON (bukan form OAuth); kredensial salah, klien tak dikenal, dan pengguna tak dikenal sama-sama 401 tanpa petunjuk | M1-01, endpoints.md AZ-38/39 | DIAMBIL SEMENTARA, menunggu Fanny |
| N-12 | `safeEqual` dan `signJwt`/`verifyJwt` dikerjakan di M1-01 (dibutuhkan penerbit token); M1-02 membangun `authenticate` di atasnya dan tetap memegang aturan lint/Semgrep terhadap `===` pada rahasia. Perbandingan rahasia klien memakai digest SHA-256 kedua sisi lalu `safeEqual`, sehingga panjang rahasia tidak terbaca dan klien tak dikenal memakan waktu yang sama | M1-01, M1-02 | DIAMBIL SEMENTARA, menunggu Fanny |
