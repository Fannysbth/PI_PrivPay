# Spesifikasi: pengujian dan pengukuran

Sumber: PRD 18 (rencana pengujian), 13, 14; Bab Metodologi v8 bagian D; `docs/qa/qa-checklist.md`; `docs/security/security-checklist.md`; ADR-0003 (hanya baseline dan proposed), 0004 (fase lokal), 0006, 0008. **[K-nn]** diterima Fanny (bawaan, Gerbang 3).

## 1. Tanggung jawab

Menetapkan cara bukti dihasilkan: piramida tes, harness, kasus TF-01..TF-17 dan TK-01..TK-28 dalam dua lapis, pemindai kenari dan metrik paparan E(s), uji penautan baseline vs proposed, uji gagal tertutup, koleksi Newman, dan (ditunda) pengukuran k6. Tidak ada kata "lulus" tanpa keluaran perintah yang dijalankan.

## 2. Piramida dan lokasi

| Tingkat | Alat | Lokasi | Isi |
| --- | --- | --- | --- |
| Unit | Jest | `services/*/src/**/*.spec.ts`, `packages/common` | logika murni: `PolicyEngine`, `status_efektif`, kripto, `RiskEngine`, `Reconciler`, `Tokenizer`, `RateLimiter` |
| Integrasi | Jest + Supertest | `services/*/test/` | per layanan dengan PostgreSQL asli dan **peran asli**: SQL, indeks, `REVOKE/GRANT`, konkurensi |
| Kontrak | Jest | `packages/common` | skema antar-layanan; perubahan skema memecahkan tes |
| Keamanan | Jest + Supertest dan Newman | `tests/security/` | TK-xx dua lapis (bagian 4) |
| Ujung ke ujung | Newman + `pii-scan` | `tests/functional/`, `tests/pii-scan/` | TF-xx dan TK-xx pada kedua mode; fase lokal terhadap layanan yang berjalan lokal (tanpa compose, ADR-0004) |
| Performa | k6 | `tests/performance/` | **ditunda** sampai konfigurasi final (bagian 8) |

## 3. Aturan tes

1. **Tes dulu** (skill `tdd`): sebelum menulis tes, seam yang diuji ditulis dan disetujui; tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, baru implementasi minimal.
2. Nama tes memuat ID: `TK-07 rejects raw subject_id from TRANSACTION`, `TF-15 issues again after the TTL without violating uq_mapping_active`.
3. Deterministik dan mandiri: tanpa `sleep` nyata (`FakeClock`, `FakeDelay`), tanpa ketergantungan urutan, database uji dibuat ulang bersih tiap run oleh `privpay_test_admin`, satu database uji per berkas yang berjalan paralel.
4. PostgreSQL asli untuk apa pun yang menyangkut indeks unik parsial, `FOR UPDATE`/kunci advisory, `REVOKE/GRANT`, `CHECK`; tidak ada mock untuk itu.
5. **Tes penjaga untuk proteksi kritis:** setiap proteksi yang buktinya bergantung pada "tes harus gagal bila proteksi dihapus" punya tes penjaga yang dapat diulang di repo, bukan mutasi manual: kunci advisory `buat_token` (skenario paralel ditolak `uq_mapping_active` tanpa kunci), penandaan kedaluwarsa (TF-15 khusus, `privacy-service.md` M2-05), `chk_four_eyes` (tulis langsung ditolak), `audit_log` append-only (UPDATE/DELETE ditolak peran asli).
6. Tidak ada `.only`, `.skip`, `xit` (pre-commit); tes yang kadang gagal adalah bug dan dikarantina dengan tiket, bukan di-retry.
7. Fixture hanya data fiktif; nilai kenari dibangkitkan, bukan ditulis tangan.

## 4. Pengujian keamanan dalam dua lapis (E-09, ADR-0008)

Setiap TK dijalankan di:

- **Lapis layanan (Jest + Supertest langsung ke Privacy atau layanan terkait):** kode dan `reason` rinci sesuai PRD 10/ADR-0008, dan **tepat satu** baris `audit_log` `DENIED` untuk penolakan oleh Privacy (dihitung dengan `privpay_auditor`).
- **Lapis Gateway (Newman via Gateway):** klien hanya melihat salah satu dari delapan `code`, tanpa `reason`; respons untuk token yang ada dan tidak ada **identik** (dibandingkan seluruh isi kecuali `request_id`), NFR-10.

Penolakan di Gateway (TK-11, TK-19) dicatat di log Gateway, bukan audit log.

| TK | Skenario | Lapis layanan | Lapis Gateway | Tiket |
| --- | --- | --- | --- | --- |
| TK-01 | Notification memakai token milik Fraud | 403 `SERVICE_MISMATCH` | 403 `ACCESS_DENIED` | M3-06 |
| TK-02 | Reconciliation membuka token DAILY_RECONCILIATION dengan purpose INTERNAL_AUDIT | 403 `PURPOSE_MISMATCH` | 403 | M3-06 |
| TK-03 | token setelah TTL+grace | 410 `EXPIRED` | 403 | M3-06 |
| TK-04 | token dicabut | 403 `REVOKED` | 403 | M3-02/M3-06 |
| TK-05 | token acak | 404 `TOKEN_NOT_FOUND` | 403 | M3-06 |
| TK-06 | purpose di luar whitelist | 403 `POLICY_NOT_ALLOWED`, tanpa baris mapping | 403 | M3-06 |
| TK-07 | Transaction mengirim `subject_id` mentah | 403 `POLICY_NOT_ALLOWED` | 403 | M2-06 |
| TK-08 | de-pseudonimisasi tanpa peran auditor | 403 `FORBIDDEN_ROLE` | 403 | M3-05 |
| TK-09 | re-issue pada transaksi `COMPLETED` | 409 `TX_TERMINAL` | 403 | M2-07 |
| TK-10 | UPDATE `audit_log` oleh peran aplikasi | `42501` pada koneksi `privpay_app` | n/a | M2-01 |
| TK-11 | lonjakan melebihi kuota | n/a | 429 `RATE_LIMITED` | M1-03 |
| TK-12 | token ada vs tidak ada | n/a | respons identik | M1-03/M6-01 |
| TK-13 | FRAUD menukar token ke NOTIFICATION | 403 `POLICY_NOT_ALLOWED` | 403 | M3-06 |
| TK-14 | FRAUD meminta token ACCOUNT | 403 `POLICY_NOT_ALLOWED` | 403 | M3-06 |
| TK-15 | FRAUD membuka token miliknya | 403 `POLICY_NOT_ALLOWED` | 403 | M3-06 |
| TK-16 | Privacy dimatikan saat transaksi | n/a | 503, tanpa data mentah ke hilir | M6-04 |
| TK-17 | cabut seluruh token satu subjek lalu pakai | `REVOKED`, jumlah dan audit | 403 | M3-02 |
| TK-18 | pemindaian repo dan image untuk secret | gitleaks nol temuan (image: DK) | n/a | M0-07 |
| TK-19 | JWT kedaluwarsa atau tidak ada | n/a | 401 `UNAUTHENTICATED` | M1-03 |
| TK-20 | Transaction memanggil `/identity` | 403 `POLICY_NOT_ALLOWED`, tanpa baris brankas | 403 | M2-08 |
| TK-21 | auditor membuka P7 dengan disclosure APPROVED atas `nama` | 200 hanya `nama`, status `USED` | 200 | M3-05 |
| TK-22 | audit rutin | 200 token P7 + transaksi; kenari: tanpa identitas | 200 | M4-07 |
| TK-23 | de-pseudonimisasi tanpa `disclosure_id`/PENDING | 403 `DISCLOSURE_NOT_APPROVED` | 403 | M3-05 |
| TK-24 | pemohon menyetujui sendiri | 403 `SELF_APPROVAL`, status tetap PENDING | 403 | M3-04 |
| TK-25 | pengguna tanpa peran admin menyetujui | 403 `FORBIDDEN_ROLE` | 403 | M3-04 |
| TK-26 | persetujuan dipakai dua kali / setelah 600 detik | 403 `DISCLOSURE_NOT_APPROVED` / 410 `DISCLOSURE_EXPIRED` | 403 | M3-05 |
| TK-27 | dasar atau atribut di luar tabel | 422 `INVALID_BASIS`/`ATTRIBUTE_NOT_ALLOWED`, tanpa baris | 422 `VALIDATION_ERROR` | M3-04 |
| TK-28 | auditor B memakai persetujuan milik auditor A | 403 `REQUESTER_MISMATCH` | 403 | M3-05 |

Kriteria lolos: **dua puluh delapan kasus** (bukan "dua puluh satu", E-04) menghasilkan kode dan reason yang tepat pada lapis yang berlaku.

## 5. Kasus fungsional TF-01..TF-17

Berlaku pada kedua mode kecuali dinyatakan; TF khusus lapisan privasi hanya pada `proposed` (US-09).

| TF | Kasus | Mode | Tiket |
| --- | --- | --- | --- |
| TF-01 | pendaftaran: 201, satu baris `contact_registry` (kunci pseudonim di proposed) | keduanya | M4-08 |
| TF-02 | TX-10001 normal: `COMPLETED`, satu notifikasi, tanpa baris fraud | keduanya | M4-09 |
| TF-03 | TX-10002 mencurigakan: `HELD`, satu baris `fraud_assessments` skor 75 | keduanya | M4-09 |
| TF-04 | TX-10003 token kedaluwarsa: `COMPLETED` dengan token re-issue | proposed | M4-09 |
| TF-05 | rekonsiliasi: satu batch dua item `MATCHED` | keduanya | M4-06 |
| TF-06 | **ditulis ulang (E-02):** audit rutin mengembalikan token P7 + data transaksi tanpa identitas; satu baris audit `GENERATE_TOKEN` (P7); pembukaan diuji di TK-21, TK-23..28 | proposed | M4-07 |
| TF-07 | idempotensi penerbitan: `reused:true` | proposed | M2-05 |
| TF-08 | `Idempotency-Key`: sama+isi sama 200, isi beda 409, paralel | keduanya | M4-01 |
| TF-09 | HELD disetujui analis | keduanya | M4-03 |
| TF-10 | HELD ditolak analis | keduanya | M4-03 |
| TF-11 | Fraud mati → `HELD` `FRAUD_UNAVAILABLE` | keduanya | M4-02 |
| TF-12 | cold start lalu asesmen kedua | keduanya | M4-04 |
| TF-13 | laporan settlement bank (token sama dengan D2 hanya di proposed; laporan tak valid 422) | sebagian | M2-11, M4-06 |
| TF-14 | retensi 90 hari | proposed | M2-09 |
| TF-15 | penerbitan ulang setelah TTL | proposed | M2-05 |
| TF-16 | rekonsiliasi manual | keduanya | M4-06 |
| TF-17 | `PENDING` melewati batas → `FAILED` | keduanya | M4-03 |

## 6. Pemindai kenari dan paparan E(s) (Q-13, PRD 18.2)

**Tiket tersendiri di M2 (M2-10) dan diperluas di M6 (M6-02).** Tujuannya mengukur secara struktural pengenal langsung apa yang benar-benar diterima, disimpan, atau dicatat tiap layanan.

**Nilai kenari:** pembangun data uji membangkitkan nilai unik per atribut per pelanggan (nama, NIK, HP, email, rekening, `customer_id`), berformat valid tetapi jelas palsu: `customer_id` `CUST-` + 6 digit; NIK 16 digit berawalan kode wilayah palsu `9999`; HP `08999` + 7 digit; rekening `9999` + 6 digit; email `canary-<n>@example.test`; nama `Kenari <kata unik> <n>` **[K-24]**. Nilai tidak pernah ditulis tangan atau dipakai selain di data uji.

**Tiga sasaran pemindaian** (pencocokan nilai persis; ekspresi reguler umum kurang andal untuk ID dan nama [Metodologi 16]):

1. **Payload antar-layanan:** URL tiap layanan berasal dari env, sehingga harness uji mengarahkannya ke **proxy pengamat** (`tests/pii-scan`) yang meneruskan lalu lintas dan memindai isi di **memori**; payload tidak pernah ditulis ke disk, keluarannya hanya temuan `{atribut, lokasi, layanan}` (tidak ada nilai). Berlaku juga di fase Docker.
2. **Basis data:** dump tiap database (peran pemilik, khusus tes) setelah skenario; kolom ciphertext Privacy diharapkan hanya berisi ciphertext (NIK/nama terenkripsi di brankas).
3. **Log:** stdout/stderr semua proses, dan seluruh isi `audit_log`.

**E(s) dan nilai harapan (Metodologi Tabel IV):** `E(s) = |P(s)| / 6`. Proposed: Transaction 0, Fraud 0, Reconciliation 0, Notification 1/6 (HP). Baseline: Transaction 4/6, Fraud 4/6, Reconciliation 4/6, Notification 5/6 (`customer_id`, NIK, nama, rekening, + HP). Dilaporkan: nilai teramati vs harapan, presisi dan recall `P(s)` terhadap nilai kenari, rata-rata E(s) seluruh layanan dan hanya dalam cakupan perlindungan (Keycloak/IdP dan basis datanya di luar zona), dan pengurangan relatif baseline→proposed. Jalur audit (pembukaan bersyarat) **dilaporkan terpisah** sebagai paparan terkontrol: jumlah pembukaan, kesesuaian atribut yang dikembalikan dengan yang disetujui, keberadaan baris audit tiap permintaan/persetujuan/pembukaan; dan tidak dihitung dalam E(s) Reconciliation.

**Rincian per kelas data (permintaan Fanny, butir 6):** E(s) per layanan tetap metrik utama; sebagai bukti pendukung dihitung dan dilaporkan **terpisah**: `E_umum(s)` (atas lima pengenal umum: nama, NIK, HP, email, `customer_id`; Pasal 4 ayat 3) dan `E_spesifik(s)` (rekening, data keuangan; ayat 2), dengan jumlah kolom identitas per layanan dari inspeksi skema (FR-24). Kelas ini mengikuti klasifikasi PRD 4 (belum diverifikasi ke teks UU, tidak boleh dikutip sebagai fakta).

**Batas metrik:** mengukur paparan struktural, bukan risiko identifikasi ulang (kombinasi nominal+jam+geohash tidak ditangani).

**Kriteria:** nol temuan di log dan `audit_log` pada proposed; nilai teramati sama dengan harapan; hasil audit rutin tanpa atribut brankas; jumlah dan isi pembukaan sesuai persetujuan.

## 7. Uji penautan dan gagal tertutup

**Penautan (ADR-0003, S-71, S-72):** model penyerang memegang salinan basis data dua atau lebih layanan hilir (mis. Fraud dan Notification, dan Transaction). Skrip mencocokkan rekaman antar-basis data lewat kesamaan pengenal; **tingkat keberhasilan penautan** = proporsi subjek yang rekamannya berhasil ditautkan lintas layanan. Baseline (`customer_id` sama): diharapkan penuh. Proposed: token berbeda per (layanan, purpose) sehingga kueri join lintas basis data lewat pseudonim tidak menghasilkan baris (diharapkan 0 lintas layanan). **Dilaporkan jujur:** penautan di dalam satu layanan dan satu purpose selama TTL tetap mungkin (token dipakai ulang; jendela 30 hari di Fraud), tidak disembunyikan. Hasil bersifat empiris pada skenario yang diuji, bukan bukti formal ketidakterhubungan.

**Gagal tertutup (TK-16, M6-04):** matikan proses Privacy Service saat transaksi berjalan; periksa 503 di Gateway, tidak ada payload berisi data asli sampai ke hilir (pemindai kenari di proxy pengamat), dan catat waktu hingga layanan pulih. Pada fase lokal ini sahih sebagai bukti kebenaran. **Versi dengan replika di compose ditunda** (DK-06, ADR-0004); PRD berlaku: tidak ada syarat lebih dari satu instans (E-12).

## 8. Koleksi Newman dan pengukuran performa

**Newman (M6-01):** koleksi TF-01..17 dan TK-01..28, dijalankan `pnpm newman` pada kedua mode (`PRIVACY_MODE`), tiap folder menyiapkan datanya sendiri (tidak bergantung urutan), semua respons error divalidasi dengan skema JSON (NFR-25, delapan kode), data fiktif.

**k6 (M7-01, ditunda):** parameter PRD 18.4: 100 VU, ramp-up 30 detik, tahan 5 menit, campuran 70% normal dan 30% mencurigakan, 5 pengulangan per mode bergantian baseline/proposed, jeda 2 menit dan pemulihan basis data, 1.000 pelanggan sintetis dengan riwayat Fraud, 60 detik pemanasan dibuang, rate limit mati di kedua mode, ambang p95 ≤ +20%, throughput ≤ −15%, galat < 1%. Statistik per run (p50, p95, p99, RPS, galat) lalu rerata, simpangan baku, dan interval kepercayaan 95% (t, 4 derajat bebas; `t = 2,776`); data mentah dilampirkan dan **tidak dibulatkan ke arah yang menguntungkan**; bila batas atas interval melewati ambang: temuan, bukan disembunyikan. Latensi `/pseudonymize` langsung (NFR-03, p95 ≤ 50 ms) diukur terpisah.

**Syarat validitas (ADR-0004, wajib di tiket M7-01):** tidak ada angka latensi atau throughput dari lingkungan lokal yang boleh masuk laporan. Pengukuran hanya sah pada konfigurasi final yang dijalankan sama untuk baseline dan proposed: **gateway yang sama** (Kong atau adapter, wajib disebut), batas sumber daya sama, perangkat keras dan versi OS/Docker dicatat. Ancaman validitas dituliskan: satu VPS (optimistis), beban closed-loop, PostgreSQL 16 vs 18, pembangkit beban berbagi mesin.

## 9. Kriteria penerimaan

| Tiket | Kriteria | ID |
| --- | --- | --- |
| M2-10 | pemindai kenari v1: pembangun kenari, proxy pengamat (memori saja), dump DB, tangkap log; nol temuan pada `audit_log` dan log Privacy; **tidak ada payload atau nilai kenari di keluaran pemindai** | NFR-15, FR-15, S-43 |
| M6-01 | Newman TF-01..17 dan TK-01..28 pada kedua mode; validasi skema JSON error | NFR-25, TF, TK |
| M6-02 | E(s) per layanan (utama), `E_umum`/`E_spesifik` (pendukung), presisi/recall, jalur audit terpisah, jumlah kolom identitas per layanan | FR-24, FR-18, NFR-17, S-70, US-10 |
| M6-03 | uji penautan baseline vs proposed, join lintas basis data nol baris, jendela TTL dilaporkan | S-71, S-72 |
| M6-04 | gagal tertutup dengan proses Privacy dimatikan | TK-16, NFR-11, S-50 |
| M7-01 | k6 sesuai bagian 8; syarat validitas ADR-0004 | NFR-01, NFR-02, NFR-03, US-11 |
| semua tiket | gerbang lokal: lint, typecheck, test, test:integration, audit, gitleaks | CLAUDE.md |

## 10. Di luar cakupan

Mode `static`, beban selain 100 VU, stress/spike/soak, multi-node, evaluasi naturalistik dengan pengguna/data produksi, pengulangan LINDDUN setelah implementasi (DFD dipertahankan sebagai sumber nilai harapan), pengujian rotasi kunci, serangan kriptografis pada HMAC, penyerang yang telah menguasai kunci atau Privacy Service.

## 11. Keputusan spec (diterima Fanny, bawaan, Gerbang 3)

K-24 format nilai kenari (bagian 6) dan lokasi `tests/pii-scan` untuk proxy pengamat.
