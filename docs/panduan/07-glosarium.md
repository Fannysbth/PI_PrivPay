# 07. Glosarium

Urutan: (A) awalan ID yang sering muncul di dokumen dan komentar kode, (B) istilah privasi dan domain, (C) istilah kripto dan keamanan, (D) istilah arsitektur dan kode, (E) istilah pengujian dan proses. Glosarium resmi proyek yang lebih pendek ada di [`docs/CONTEXT.md`](../CONTEXT.md).

## A. Awalan ID

| ID | Arti |
| --- | --- |
| **PRD** | Product Requirements Document v2.4; ringkasan di [`docs/PRD_RINGKAS.md`](../PRD_RINGKAS.md), lengkap di [`docs/reference/`](../reference/PRD_PrivPay_v2.4_lengkap.md). "PRD 7.4" berarti bagian 7.4 dokumen lengkap |
| **ADR-nnnn** | Architecture Decision Record: keputusan arsitektur yang dicatat, di [`docs/adr/`](../adr/). Keputusan berstatus FINAL tidak diubah tanpa ADR yang disetujui pemilik |
| **D-nn** | keputusan desain FINAL di [`docs/DESIGN_DECISIONS.md`](../DESIGN_DECISIONS.md) (D-01 audit berbasis pseudonim sampai D-24 data uji fiktif) |
| **FR-nn / NFR-nn** | kebutuhan fungsional / nonfungsional PRD (FR-30 tiga kunci berbeda; NFR-12 timeout dan percobaan ulang) |
| **US-nn** | user story PRD |
| **TF-nn** | tes fungsional (TF-04 token kedaluwarsa di tengah transaksi) |
| **TK-nn** | tes keamanan (TK-08 aktor `admin` tidak boleh membuka identitas); dijalankan di dua lapis: antar-layanan dan lewat Gateway |
| **AZ-nn** | tes otorisasi negatif per endpoint, katalog di [`docs/spec/endpoints.md`](../spec/endpoints.md) |
| **E-nn** | errata/kontradiksi PRD yang ditemukan dan dijawab ([`docs/OPEN_QUESTIONS.md`](../OPEN_QUESTIONS.md) bagian A, [`docs/PRD_ERRATA.md`](../PRD_ERRATA.md)) |
| **Q-nn** | pertanyaan terbuka yang diputuskan atau dikembalikan ke dosen (bagian B dan C `OPEN_QUESTIONS.md`) |
| **K-nn** | keputusan spek yang diusulkan dengan nilai bawaan lalu diterima pemilik (bagian F `OPEN_QUESTIONS.md`); "K" dari "konfirmasi" |
| **N-nn** | keputusan implementasi yang diambil saat membangun, menunggu atau sudah disetujui pemilik (bagian G `OPEN_QUESTIONS.md`). N-45 jendela riwayat Fraud, N-46 `account_number` di baseline, N-47 definisi env tak konsisten |
| **S-nn** | dua penggunaan berbeda: di [`docs/security/security-checklist.md`](../security/security-checklist.md) dan komentar kode, S-nn adalah **butir checklist keamanan** (S-03 kunci berbeda, S-34 audit append-only); di `OPEN_QUESTIONS.md` bagian E, S-01 sampai S-07 adalah butir wajib spek dengan penomoran sendiri. Bila ragu, lihat berkas tempat ia muncul |
| **T-nn** | ancaman di [`docs/security/threat-model.md`](../security/threat-model.md) (T-16 ciphertext dipindah antar baris) |
| **C-nn** | butir QA di [`docs/qa/qa-checklist.md`](../qa/qa-checklist.md) |
| **M0..M8** | milestone PRD 19 (M4 layanan bisnis, **M5 mode baseline**, M6 Newman dan pemindai, M7 k6) |
| **DK-nn** | tiket fase Docker (Compose, Kong, Keycloak, jaringan, fail-closed bersih), belum dikerjakan |
| **M5-02** dst. | nomor tiket di [`docs/tickets/`](../tickets/): milestone-urutan |
| **P1..P7, X1, X2** | konteks token (Tabel 1) dan pertukaran (Tabel 2), lihat bagian B |
| **A1..A5, B, C, D, E** | langkah alur PRD 9: A pendaftaran, B transaksi normal, C mencurigakan, D rekonsiliasi, E audit |
| **HANDOFF, RETRO** | [`docs/HANDOFF.md`](../HANDOFF.md) catatan serah-terima antar sesi kerja; `docs/RETRO_M*.md` evaluasi cara kerja per milestone |

## B. Istilah privasi dan domain

| Istilah | Arti |
| --- | --- |
| **Pseudonimisasi** | mengganti pengenal langsung dengan pengenal pengganti (pseudonim) yang hanya bisa dikembalikan dengan informasi tambahan yang disimpan terpisah. Pseudonim tetap data pribadi; ini bukan anonimisasi |
| **Regular vs blind** | pada pseudonimisasi *regular* pihak penerbit (Privacy Service) mengetahui identitas asli; pada *blind* ia tidak. PrivPay regular, dan itu keterbatasan yang diakui |
| **Dinamis / semi-dinamis** | token berganti menurut layanan, tujuan, dan masa berlaku; tetapi token aktif dipakai ulang selama TTL, jadi bukan berganti tiap permintaan |
| **PSEU / token / pseudonim** | pengenal pengganti berbentuk `PSEU-` + 8 heks huruf besar (awalan dari *pseudonym*). Satu token berlaku untuk satu subjek di satu layanan dan satu tujuan |
| **Subjek** | yang dipseudonimkan: pelanggan (`CUSTOMER`) atau rekening (`ACCOUNT`) |
| **Konteks / Tabel 1 (P1..P7)** | kombinasi layanan + tujuan + jenis subjek yang sah. P1 pelanggan→Transaction, P2 rekening→Transaction, P3 pelanggan→Fraud, P4 pelanggan→Notification (per transaksi), P5 pelanggan→Notification (pendaftaran, 1 tahun), P6 rekening→Reconciliation, P7 pelanggan→Reconciliation (audit) |
| **Tabel 2** | hanya dua pertukaran token: P1→P3 dan P1→P4, keduanya oleh Transaction |
| **Tabel 3** | operasi dan pemanggil yang sah (mis. hanya Gateway yang boleh menerbitkan dari identitas) |
| **Tabel 5** | atribut yang boleh dikembalikan saat pembukaan identitas: `customer_id`, `nik`, `nama`, hanya untuk P7; HP dan rekening tidak pernah |
| **Tabel 6** | dasar sah pembukaan: `DISPUTE`, `FRAUD_CONFIRMED`, `LEGAL_REQUEST` |
| **Purpose (tujuan)** | enam nilai whitelist (`PAYMENT_PROCESSING`, `FRAUD_DETECTION`, `NOTIFICATION`, `NOTIFICATION_REGISTRATION`, `DAILY_RECONCILIATION`, `INTERNAL_AUDIT`) |
| **`requesting_service`** | layanan yang memanggil Privacy; selalu dari klaim `azp` JWT, tidak pernah dari body |
| **`target_service`** | layanan yang akan memegang token; dari body, wajib ada di Tabel 1 |
| **Policy Engine** | kelas murni yang memutuskan apakah sebuah operasi, pemanggil, dan konteks sah menurut tabel di atas (`PolicyEngine`) |
| **TTL, grace, status efektif** | masa berlaku token; toleransi 30 detik bagi operasi yang sudah berjalan; status gabungan (`active`, `grace`, `expired`, `revoked`) yang dihitung dari kolom status dan waktu |
| **Pemakaian ulang (`reused`)** | token aktif untuk (subjek, layanan, tujuan) yang sama dikembalikan lagi, audit mencatat `REUSED_ACTIVE` |
| **Pertukaran token (exchange)** | Transaction menukar token P1 miliknya dengan token layanan lain (P3 atau P4) lewat `source_pseudonym`, tanpa pernah mengirim `subject_id` |
| **Re-issue** | penerbitan ulang token yang kedaluwarsa untuk transaksi yang belum final |
| **Pseudonim domain (P5)** | token berumur panjang yang menjadi kunci kontak di Notification; hasil `resolve-domain` dari token P4 |
| **Brankas identitas (`identity_vault`)** | tabel di Privacy yang menyimpan NIK, nama, HP, rekening, `customer_id` terenkripsi per kolom |
| **Mapping (`pseudonym_mapping`)** | tabel di Privacy yang memetakan token ke subjek terenkripsi, dengan masa berlaku dan status |
| **Retensi** | job harian yang mengosongkan identitas pada baris token yang sudah tak berlaku ≥ 90 hari (tetapan peneliti); barisnya tetap ada |
| **Revocation (pencabutan)** | menandai token `revoked`; `revoke_subject` juga mengosongkan brankas pelanggan |
| **Pembukaan identitas / disclosure** | proses bersyarat membuka atribut: auditor mengajukan permintaan, admin lain menyetujui (600 detik, sekali pakai), baru `POST /de-pseudonymize` |
| **Empat mata (four-eyes)** | pemohon dan penyetuju harus orang berbeda; juga dipaksa oleh `CHECK chk_four_eyes` |
| **Gerbang (GATE 1..5)** | lima pemeriksaan berurutan pada `/de-pseudonymize` (token ada, layanan cocok, tujuan cocok, status, permintaan pembukaan sah); berhenti di kegagalan pertama. Jangan campur dengan *gateway* |
| **STEP 0** | pemeriksaan pemanggil (dan peran) yang dilakukan sebelum membaca baris apa pun |
| **Audit rutin** | `audit-request`: token P7 dan data transaksi tanpa identitas |
| **Audit log** | tabel append-only yang mencatat setiap operasi token, `SUCCESS` atau `DENIED`, tanpa nilai identitas |
| **HELD** | transaksi ditahan menunggu analis fraud (di Privacy dicatat `IN_PROGRESS`) |
| **Cold start** | pelanggan tanpa riwayat penilaian; dua aturan fraud (rata-rata, lokasi) dilewati |
| **Idempotensi / `Idempotency-Key`** | UUID dari klien; permintaan yang sama dengan kunci sama menghasilkan satu transaksi; isi berbeda menjadi `409` (ADR-0009) |
| **Settlement / laporan bank** | daftar (rekening, jumlah, referensi bank) yang dikirim bank; dicocokkan dengan transaksi `COMPLETED` |
| **Honeypot** | Privacy Service sebagai titik tunggal yang berisi semua pemetaan; kelemahan struktural pseudonimisasi regular |
| **Linkability (kebisaan-ditautkan)** | kemungkinan menautkan rekaman orang yang sama lintas layanan atau waktu. Di proposed token berbeda per layanan, tetapi di dalam satu layanan selama TTL tetap bisa ditautkan (30 hari di Fraud) |
| **E(s)** | rasio paparan layanan *s* = jumlah pengenal langsung yang diterimanya dibagi 6 (nama, NIK, HP, email, rekening, `customer_id`); metrik utama skripsi |
| **Paparan terkontrol** | atribut yang keluar dari Privacy lewat pembukaan bersyarat; dilaporkan terpisah dari E(s) |
| **Nilai kenari (canary)** | pengenal palsu unik yang disisipkan di data uji lalu dicari persis di basis data, log, dan jawaban |
| **Konsol admin** | klien API berperan admin/auditor (tidak ada UI); `requesting_service = ADMIN_CONSOLE` |
| **PII** | *personally identifiable information*; larangan keras di log, audit, fixture, URL |
| **UU PDP** | undang-undang pelindungan data pribadi Indonesia; kutipan pasal di dokumen proyek belum diverifikasi |

## C. Istilah kripto dan keamanan

| Istilah | Arti |
| --- | --- |
| **`K_token`** | kunci HMAC untuk menurunkan nilai token (`PSEUDONYM_HMAC_SECRET_FILE`) |
| **`K_index`** | kunci HMAC untuk blind index (`BLIND_INDEX_SECRET_FILE`) |
| **`K_field`** | kunci AES-256-GCM untuk kolom terenkripsi (`FIELD_ENCRYPTION_KEY_FILE`), diberi nomor versi |
| **HMAC-SHA256** | kode autentikasi pesan berkunci; dipakai untuk token dan blind index. Tanpa kuncinya keluarannya tidak bisa dihitung ulang |
| **Blind index (`subject_lookup`)** | HMAC deterministik dari (jenis subjek, id subjek) agar baris subjek bisa dicari tanpa dekripsi; pseudonim statis internal yang tak boleh keluar dari basis data Privacy |
| **Nonce** | nilai acak sekali pakai (UUID v4) yang membuat token tak dapat diturunkan ulang dari subjek |
| **AES-256-GCM** | enkripsi simetris yang sekaligus mengautentikasi (mendeteksi perubahan). Format blob: versi kunci (2 byte), IV (12), ciphertext, tag (16) |
| **IV** | *initialization vector*, 12 byte acak baru untuk setiap penulisan |
| **Tag** | 16 byte penanda keaslian GCM; gagal bila data, kunci, atau AAD berubah |
| **AAD** | *additional authenticated data*: data yang tidak dienkripsi tetapi ikut diautentikasi; di sini mengikat ciphertext ke jenis baris, kolom atau jenis subjek, dan id baris, sehingga ciphertext tak bisa dipindah |
| **`node:crypto`** | modul kripto bawaan Node; satu-satunya pustaka kripto yang dipakai |
| **`timingSafeEqual` / `safeEqual`** | perbandingan waktu-tetap untuk rahasia (`===` bocor panjang awalan yang cocok) |
| **JWT, RS256** | token bertanda tangan; RS256 = RSA dengan SHA-256, satu-satunya algoritma yang diterima |
| **JWKS** | daftar kunci publik penerbit token yang diambil layanan untuk memeriksa tanda tangan |
| **`azp`, `aud`, `iss`, `exp`, `sub`** | klaim JWT: klien pemegang token, audiens (layanan tujuan), penerbit, kedaluwarsa, subjek |
| **Service account / actor token** | token layanan di `Authorization` menentukan pemanggil; token manusia di `X-Actor-Token` divalidasi ulang penerima untuk id dan peran (ADR-0007) |
| **Gagal tertutup (fail closed)** | bila ragu atau komponen privasi mati: tolak (403/503), jangan teruskan data mentah |
| **Gagal cepat (fail fast)** | konfigurasi salah menghentikan proses saat start dengan pesan yang hanya menyebut nama variabel |
| **Least privilege** | peran database hanya diberi hak minimal (`privpay_app` hanya `INSERT` pada `audit_log`) |
| **Append-only** | hanya boleh ditambah; ditegakkan lewat `REVOKE UPDATE, DELETE` |
| **Kunci penasihat (advisory lock)** | kunci PostgreSQL berbasis angka yang dipakai `buat_token` agar permintaan paralel untuk kombinasi yang sama berbaris (ADR-0010) |
| **gitleaks** | pemindai rahasia pada pohon kerja dan riwayat git |

## D. Istilah arsitektur dan kode

| Istilah | Arti |
| --- | --- |
| **Microservices** | sistem terdiri dari beberapa layanan kecil, masing-masing proses, database, dan tanggung jawab sendiri, berkomunikasi lewat HTTP |
| **Gateway** | pintu tunggal klien eksternal (di sini `services/gateway`, pengganti Kong) |
| **Kong, Keycloak** | API gateway dan penyedia identitas yang direncanakan untuk fase Docker; belum ada. Fase lokal memakai Gateway buatan sendiri dan dev-idp |
| **dev-idp** | penerbit JWT tiruan fase lokal ([`tools/dev-idp`](../../tools/dev-idp)) |
| **Ports-and-adapters** | pola yang memisahkan kebutuhan kode bisnis (port) dari cara memenuhinya (adapter); lihat [05](05-mode-baseline-proposed.md) |
| **Akar komposisi (composition root)** | satu tempat yang merakit objek dan memilih adaptor (`*.module.ts`) |
| **Repositori** | kelas yang membungkus akses basis data satu agregat; di sini satu kelas per layanan dengan SQL per mode |
| **`SubjectSql`** | objek berisi pernyataan SQL yang menyebut kolom subjek, disuplai folder mode |
| **Mode / `PRIVACY_MODE`** | `baseline` (identitas apa adanya) atau `proposed` (dengan lapisan privasi); hanya dua (ADR-0003) |
| **Baseline / Proposed** | kondisi pembanding tanpa dan dengan lapisan privasi; "proposed" adalah usulan skripsi |
| **Adaptor passthrough** | `PassthroughPrivacyPort`: mengembalikan identitas apa adanya |
| **`DomainError(reason, cause)`** | error domain; `reason` kode tetap, `cause` kategori pendek, tidak pernah nilai |
| **`code` vs `reason`** | ke klien eksternal hanya delapan `code` (ADR-0008); `reason` rinci hanya antar-layanan dan audit |
| **`ErrorMasker`** | di Gateway, mengubah reason hilir menjadi salah satu delapan code |
| **zod** | pustaka validasi skema; semua input batas (HTTP, env, pesan) divalidasi, field tak dikenal ditolak |
| **NestJS** | kerangka server TypeScript yang dipakai semua layanan |
| **pnpm workspaces, corepack** | pengelola paket monorepo; corepack memanggil pnpm versi yang dikunci (`corepack pnpm ...`) |
| **Migrasi** | berkas SQL bernomor yang membuat/mengubah tabel; hanya maju; folder `common/`, `proposed/`, `baseline/` |
| **Peran pemilik vs peran runtime** | pemilik skema menjalankan migrasi; peran runtime dipakai aplikasi dan tak pernah memiliki skema |
| **`Clock` / `FakeClock`** | waktu yang disuntik supaya tes tidak tidur; selalu UTC |
| **Scheduler** | penjadwal job berkala satu instans per layanan (retensi, pembersih transaksi, rekonsiliasi harian) |
| **Loopback** | alamat `127.0.0.1`; fase lokal hanya mengikat ke sana |

## E. Istilah pengujian dan proses

| Istilah | Arti |
| --- | --- |
| **Tes dulu (TDD)** | tes ditulis lebih dulu dan terbukti gagal dengan alasan yang benar sebelum kode |
| **Seam** | titik batas tempat tes mengamati perilaku tanpa menyentuh bagian dalam |
| **Mutasi** | sengaja merusak kode pengaman lalu memastikan tes gagal; bukti tes benar-benar menjaga |
| **Kontrol positif** | menaruh data asli dengan sengaja untuk membuktikan pemindai bisa menemukannya |
| **Gerbang** | rangkaian pemeriksaan yang harus hijau sebelum tiket atau milestone dinyatakan selesai (lint, typecheck, test, integrasi, smoke, audit, gitleaks, pii-scan). Beda dengan *gerbang* GATE 1..5 di bagian B |
| **Smoke test** | menjalankan hasil build sebagai proses nyata dan memeriksa `/health` |
| **Equivalence (kesetaraan)** | skenario yang sama di kedua mode menghasilkan perilaku domain yang sama |
| **E2E** | tes seluruh tumpukan layanan sekaligus |
| **Newman / k6** | alat koleksi Postman dan beban; keduanya belum dipakai (M6, M7) |
| **Flake** | tes yang kadang gagal tanpa perubahan kode; di proyek ini diperlakukan sebagai bug yang harus dijelaskan |
| **Model ancaman / LINDDUN / STRIDE** | kerangka ancaman ([`docs/security/threat-model.md`](../security/threat-model.md)); skripsi membatasi LINDDUN pada Linkability, Identifiability, Disclosure of information |
| **Ancaman validitas** | hal yang bisa membuat perbandingan baseline vs proposed tidak adil (mis. N-45) |
