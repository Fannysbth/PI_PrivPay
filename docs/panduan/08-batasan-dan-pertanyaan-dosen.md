# 08. Batasan yang jujur dan 25 pertanyaan dosen

Tujuan bab ini: kamu bisa menyebut sendiri kelemahan sistem sebelum dosen menemukannya, dan menjawab pertanyaan dengan berpijak pada kode dan keputusan desain, bukan pada keyakinan. Setiap jawaban memuat rujukan berkas dan, bila relevan, penanda status bukti:

- **[teruji]** ada tes yang dijalankan dan lulus pada gerbang terakhir;
- **[sebagian]** teruji di sebagian lapis saja;
- **[BELUM TERUJI]** belum pernah dijalankan: Docker, gagal-tertutup dengan Docker, Newman end-to-end, kinerja, Kong;
- **[belum diverifikasi]** klaim yang tidak saya periksa ke kode atau sumber.

## Bagian 1. Keterbatasan yang sudah diketahui

Disusun dari [`docs/PRD_RINGKAS.md`](../PRD_RINGKAS.md) bagian 13, [`docs/HANDOFF.md`](../HANDOFF.md), [`docs/OPEN_QUESTIONS.md`](../OPEN_QUESTIONS.md), dan temuan saya saat menulis panduan ini.

### Keterbatasan desain (diakui di PRD)

1. **Privacy Service adalah honeypot.** Pseudonimisasi *regular*: satu layanan mengetahui semua identitas dan menyimpan pemetaan. Penyerang yang menguasai proses plus berkas kunci mendapat segalanya.
2. **Semi-dinamis, bukan dinamis penuh.** Token aktif dipakai ulang selama TTL (D-12), jadi dua rekaman orang yang sama di satu layanan dalam satu jendela TTL bisa ditautkan; di Fraud jendelanya 30 hari.
3. **Dua tempat menyimpan data pribadi dengan sadar:** HP di Notification dan identitas login di IdP/Keycloak (D-08). E(s) Notification = 1/6.
4. **Blind index = pseudonim statis internal.** `subject_lookup` deterministik; kerahasiaan `K_index` krusial, dan ruang `customer_id` hanya sejuta nilai sehingga kunci itu bocor berarti tebakan bisa diuji.
5. **Korelasi atribut tidak ditangani:** kombinasi jumlah, jam, geohash bisa mengidentifikasi ulang tanpa menyentuh token (di luar cakupan).
6. **Token 32 bit** (FINAL): tabrakan ± di 65 ribu token, penebakan secara teori mungkin; dimitigasi retry, batas laju, dan audit.
7. **Skor fraud maksimum 75**, jadi `BLOCK` (>= 90) tak tercapai dengan bobot bawaan; jalur `BLOCK` diuji dengan mengubah bobot di `risk_rules`.
8. **Satu VPS membuat overhead optimistis** saat pengukuran kelak.
9. **Kutipan hukum dan literatur belum diverifikasi:** Pasal 4 UU PDP, EDPB Guidelines 01/2025, Flegel 2005, Petersen 2018 ([`docs/OPEN_QUESTIONS.md`](../OPEN_QUESTIONS.md) bagian D). Jangan dikutip sebagai fakta.

### Keterbatasan implementasi (dicatat saat M4 dan M5)

10. **Pencabutan bukan pemblokiran.** Gateway masih bisa menerbitkan token baru untuk subjek yang dicabut; token yang terbit bersamaan dengan `revoke_subject` bisa lolos (batas (a), `docs/security/review-M3.md`). Run bab 01 memperlihatkannya.
11. **Pencabutan tidak menghapus nomor HP di Notification:** Notification tidak punya endpoint hapus kontak (ADR-0005). Setelah `revoke_subject`, token domainnya dicabut tetapi baris `contact_registry` (HP) tetap ada.
12. **Kegagalan sebagian pada pendaftaran:** bila jawaban Notification hilang di langkah A4, HP bisa tersimpan tanpa pendaftaran selesai; bila jawaban IdP hilang di A2, pengguna yatim bisa tersisa (batas yang dicatat, PRD 20 tambahan M4).
13. **Batas laju** memakai `req.ip` tanpa `trust proxy`, benar selama tak ada proksi; harus ditinjau saat Kong atau Docker dipakai. Penjadwal job satu instans per layanan (dua instans menjalankan job dua kali).
14. **Pembersih `resync` mengambil 100 baris** belum-didengar tertua per putaran; baris yang ditolak Privacy secara permanen ditandai `privacy_rejected_at` (N-40) tetapi tanpa penghitung percobaan.
15. **Kepemilikan `source_account` tidak diperiksa** terhadap token nasabah (di luar cakupan: tidak ada model saldo/ledger).
16. **Rantai hash audit hanya dirancang** (`prev_hash`/`row_hash` kosong, Q-12): pemilik skema atau superuser dapat mengubah `audit_log` tanpa terdeteksi; hanya peran aplikasi yang dibatasi.
17. **Rotasi kunci otomatis tidak ada**; hanya `key_version` dan prosedur tertulis.
18. **Pemeriksaan `SELF_APPROVAL` tidak terjangkau lewat pengguna dev-idp** karena pemohon harus `auditor`, penyetuju harus `admin`, dan ADR-0007 butir 8 mewajibkan satu peran per manusia (N-49). Jalurnya dibuktikan lewat HTTP dengan dua token berperan tunggal yang memakai `sub` yang sama (peran lolos, aturan empat mata menolak, satu baris DENIED, permintaan tetap PENDING; `http.integration.spec.ts`), dan `chk_four_eyes` diuji langsung sebagai peran aplikasi (TK-24).
19. **Windows tidak mengirim SIGTERM ke anak proses**; jalur mati-anggun hanya teruji di Linux/CI (catatan di `tests/smoke/built-service.smoke.spec.ts`). Workflow CI belum pernah dijalankan di GitHub (N-07).

### Keterbatasan lingkungan dan validitas

20. **Belum ada Docker, Compose, Kong, plugin Lua, Keycloak, TLS antar-layanan.** Gateway lokal adalah pengganti; plugin Lua belum diuji terhadap vektor kontrak (DK-02).
21. **Gagal-tertutup dengan Docker/replika belum diuji** (DK-06, M6-04, M7). Teruji: di tingkat Gateway lokal, Privacy dimatikan menghasilkan 503.
22. **Newman end-to-end belum ada** (M6-01). TK-01, TK-06, TK-09, TK-13, TK-14, TK-15 baru teruji di lapis layanan dan relay jawaban kawat, belum end-to-end lewat Gateway.
23. **Kinerja belum diukur sama sekali** (M7); angka lokal sengaja tidak diambil (ADR-0004). **E(s) dan uji penautan belum dilaporkan** (M6-02, M6-03); pemindainya sudah ada.
24. **N-45, jendela riwayat Fraud.** Disamakan 30 hari, tetapi di proposed riwayat hilang saat token berganti sedangkan di baseline tidak. Ancaman validitas yang harus dilaporkan.
25. **PostgreSQL 18 di fase lokal, target 16** (ADR-0004).

### Temuan baru dari penulisan panduan ini (belum dibahas di dokumen lain)

26. **Harapan E(s) baseline di spek belum seluruhnya teramati.** Spek per layanan hanya mengganti pengenal, sedangkan Gateway bagian 8 dan Tabel IV meminta atribut mentah (4/6 dan 5/6). Setelah G1, Transaction baseline menerima NIK dan nama bila klien mengirimnya; Fraud, Reconciliation, dan Notification tetap 1/6, 1/6, 2/6 menunggu keputusan A atau B. Detail di [05](05-mode-baseline-proposed.md) dan [`docs/security/kesenjangan-baseline.md`](../security/kesenjangan-baseline.md).
27. ~~Tiga kunci Privacy tidak punya skrip pembuat lokal dan tidak ada satu perintah untuk menyalakan semuanya~~: sudah ada `pnpm dev:keys`, `pnpm dev:up`, `pnpm dev:down` ([01](01-menjalankan-sistem.md)). Layanan tetap tidak membaca `.env`.
28. **Nama field kawat berisi identitas pada baseline** (`customer_token`, `pseudonym`, `notif_token`, `account_pseudonym`): bisa menyesatkan pembaca log atau skema.
29. ~~Fraud punya izin meminta token ke `privacy-service`~~: izin itu dicabut (`fraud: []` di registri dev-idp), dan tesnya membuktikan Fraud ditolak untuk audience mana pun.
30. ~~Dokumen usang~~ `docs/PENJELASAN_MODE_BASELINE.md` dan `docs/security/review-M5.md` sudah diperbarui; log baseline kini diasersi bersih untuk satu skenario (bukan bukti umum).

## Bagian 2. Dua puluh lima pertanyaan yang mungkin diajukan dosen

### 1. Mengapa pseudonimisasi, bukan enkripsi saja atau anonimisasi?

Layanan hilir tetap harus bekerja: Transaction butuh "orang yang sama" untuk idempotensi dan riwayat, Fraud butuh profil per orang, Notification butuh nomor HP, Reconciliation butuh rekening. Anonimisasi total mematahkan fungsi itu. Enkripsi saja mengharuskan setiap layanan memegang kunci. Pseudonimisasi memberi tiap layanan pengenal yang bermakna *hanya baginya* (token per layanan dan tujuan, Tabel 1), sementara identitas asli hanya ada, terenkripsi, di Privacy Service. Ia *regular*, bukan *blind*, dan itu diakui sebagai keterbatasan (PRD 20). Rujukan: [00](00-peta-besar.md), [`docs/PRD_RINGKAS.md`](../PRD_RINGKAS.md) bagian 1. **[teruji]** lewat tes fungsional dan E2E.

### 2. Apa maksud "dinamis" bila token dipakai ulang?

Token berganti menurut **layanan, tujuan, dan siklus hidup** (TTL, kedaluwarsa, pencabutan, re-issue), bukan menurut setiap permintaan. Token aktif untuk (subjek, layanan, tujuan) dipakai ulang (`TokenService.issue`, audit `REUSED_ACTIVE`). Alasan: idempotensi, riwayat fraud, dan rekonsiliasi memerlukan kestabilan dalam jendela tertentu. Harganya: linkability di dalam satu layanan selama TTL (30 hari di Fraud), yang diakui dan akan dilaporkan di uji penautan (D-12). Rujukan: `services/privacy-service/src/token/token-service.ts`. **[teruji]** pemakaian ulang dan konkurensi; **[BELUM TERUJI]** ukuran linkability (M6-03).

### 3. Jika Privacy Service dibobol, apa yang hilang?

Tergantung apa yang dikuasai penyerang. Dengan **hanya salinan database**: ciphertext AES-GCM tanpa `K_field`, nilai blind index tanpa `K_index`, dan token; identitas tidak terbaca. Dengan **berkas kunci tapi tanpa akses runtime**: bisa mendekripsi salinan database. Dengan **kendali penuh atas proses**: segalanya. Itulah sifat honeypot pseudonimisasi regular. Mitigasi yang ada: tiga kunci terpisah, peran database minimal (aplikasi tak punya `DELETE`; auditor tak bisa membaca brankas), audit tanpa PII. Mitigasi yang tidak ada: HSM/KMS, rotasi otomatis. Rujukan: [04](04-keamanan.md) bagian 1 dan 10.

### 4. Mengapa tiga kunci terpisah?

Memperkecil dampak bocornya satu kunci dan memisahkan tiga tugas: `K_token` (membuat nilai token), `K_index` (mencari baris), `K_field` (menyimpan rahasia). Kode memeriksa bahwa ketiganya berbeda dan 32 byte saat start (`createKeys`, S-03), dan material kunci disimpan di `WeakMap` agar tak terjangkau logger atau serialisasi. Rujukan: `services/privacy-service/src/crypto/keys.ts`. **[teruji]** `crypto.spec.ts`, `startup.spec.ts`.

### 5. Mengapa AAD memuat id baris, padahal PRD menulis nama kolom?

Untuk menutup serangan "tukar ciphertext": penulis database memindahkan ciphertext antar baris sejenis. Jika AAD hanya jenis subjek atau nama kolom, ciphertext dari baris lain tetap terdekripsi sebagai milik baris ini. Dengan AAD `('mapping', subject_type, id baris)` dan `('vault', kolom, id baris)`, dekripsi gagal (T-16, ADR-0011). Biayanya: id baris dibuat aplikasi sebelum `INSERT`, dan `IdentityVault.store` harus mengambil id yang ada sebelum mengenkripsi ulang (N-25). Rujukan: `crypto/parts.ts`, `crypto/field-cipher.ts`, ADR-0011. **[teruji]** tes pindah-antar-baris dan antar-kolom (S-31).

### 6. Token hanya 32 bit; bukankah mudah bertabrakan atau ditebak?

Diputuskan FINAL (D-11) dan risikonya dicatat (Q-11). Tabrakan di ± 65 ribu token ditangani `UNIQUE` pada `pseudonym` dan ulangan sampai 20 kali dengan nonce baru (`MAX_PSEUDONYM_ATTEMPTS`, uji dengan menyuntik HMAC yang sengaja bertabrakan). Menebak token valid secara teori mungkin (4,3 miliar kemungkinan), tetapi token terikat layanan + tujuan + TTL, ada batas laju 100/menit, dan setiap `TOKEN_NOT_FOUND` tercatat dengan peringatan di `/audit-log/summary`. **[teruji]** tabrakan dan peringatan; **[BELUM TERUJI]** serangan penebakan nyata.

### 7. Bagaimana kamu membuktikan kode bisnis sama di kedua mode?

Empat lapis: (1) rancangan, ports-and-adapters dengan SQL per mode (ADR-0006, [05](05-mode-baseline-proposed.md)); (2) tes arsitektur yang gagal bila kode domain mengimpor folder mode atau menyebut mode (`tests/repo/mode-folders.spec.ts`); (3) tes kesetaraan: skenario yang sama lewat seluruh tumpukan di kedua mode, jawaban, baris, dan SMS dibandingkan (`equivalence.integration.spec.ts`); (4) mutasi yang membuktikan tes itu bisa gagal. Caveat: N-45 (jendela riwayat), dan fungsi yang memang hanya ada di proposed (audit, pembukaan identitas). **[teruji]**.

### 8. Apa tepatnya E(s), dan apa batasnya?

`E(s)` = jumlah pengenal langsung yang diterima layanan *s* dibagi 6 (nama, NIK, HP, email, rekening, `customer_id`), diukur dengan nilai kenari di payload, database, dan log. Ia mengukur paparan **struktural**, bukan risiko identifikasi ulang (korelasi atribut tidak ditangani). Nilai harapan proposed: Transaction, Fraud, Reconciliation 0; Notification 1/6. Peringatan penting: harapan baseline di spek (4/6 dan 5/6) hanya teramati penuh di Transaction (setelah G1); Fraud, Reconciliation, dan Notification menunggu keputusan A atau B (temuan 26). Rujukan: [`docs/spec/pengujian-dan-pengukuran.md`](../spec/pengujian-dan-pengukuran.md) bagian 6, [05](05-mode-baseline-proposed.md). **[sebagian]** pemindai teruji, **[BELUM TERUJI]** laporan E(s) (M6-02).

### 9. Bagaimana kinerjanya, berapa overhead pseudonimisasi?

**[BELUM TERUJI].** Tidak ada angka, dan itu disengaja: angka dari mesin lokal (PostgreSQL 18, Gateway pengganti, satu mesin) tidak sah masuk laporan (ADR-0004). Rencana: k6, 100 VU, 5 pengulangan bergantian per mode, p95 <= +20%, throughput <= -15%, galat < 1%, pada konfigurasi final yang sama untuk kedua mode, dengan ancaman validitas ditulis (satu VPS, closed-loop, pembangkit beban berbagi mesin). Jangan mengutip angka dari percobaan lokal.

### 10. Apa yang terjadi bila Privacy Service mati?

Gagal tertutup (invarian 8, D-09). Gateway: `pseudonymize` gagal menjadi `SERVICE_UNAVAILABLE`, permintaan berhenti dengan 503 dan tidak ada data diteruskan; tidak ada baris transaksi dibuat. Transaction: pertukaran token untuk Fraud gagal berarti `HELD` dengan `FRAUD_UNAVAILABLE` (tidak pernah `COMPLETED`); notifikasi gagal tidak membatalkan transaksi; PATCH status yang gagal diulang pembersih. Rujukan: [03](03-alur-end-to-end.md) bagian B. **[sebagian]** teruji di E2E lokal (`scenarios.integration.spec.ts`, "Privacy down"); **[BELUM TERUJI]** dengan Docker, replika, dan beban (M6-04, M7).

### 11. Bagaimana mencegah orang dalam membuka identitas sembarangan?

Pembukaan hanya lewat alur bersyarat: auditor mengajukan dengan dasar dari Tabel 6 dan nomor kasus, admin lain menyetujui, persetujuan sekali pakai dan berlaku 600 detik, hanya atribut `customer_id`/`nik`/`nama` yang disetujui yang keluar, HP dan rekening tidak pernah, dan setiap langkah (termasuk penolakan) tercatat dengan nama atribut, tanpa nilai. Lima gerbang ditambah STEP 0 (pemanggil dan peran). Batasnya: orang yang menguasai database **dan** berkas kunci, atau pemilik skema, berada di luar mekanisme ini. Rujukan: [03](03-alur-end-to-end.md) bagian D, [04](04-keamanan.md). **[teruji]** TK-21 sampai TK-28 di lapis layanan; end-to-end lewat Newman **[BELUM TERUJI]**.

### 12. Untuk apa `chk_four_eyes` bila peran sudah memisahkan auditor dan admin?

Pertahanan berlapis. Satu pengguna dev-idp hanya punya satu peran (ADR-0007 butir 8), jadi pemohon (auditor) tak mungkin sekaligus penyetuju (admin) lewat pengguna seed; pemeriksaan kode `SELF_APPROVAL` dan `CHECK` database berperan bila identitas yang sama dapat memegang dua peran (Keycloak) atau bila seseorang menulis langsung ke tabel. Keduanya teruji: lewat HTTP dengan dua token berperan tunggal yang memakai `sub` yang sama, dan `chk_four_eyes` langsung sebagai peran aplikasi (TK-24). Rujukan: `disclosure-service.ts`, `migrations/proposed/0001_privacy_tables.sql`. **[teruji]** di lapis layanan dan SQL.

### 13. Bagaimana audit log dijamin tidak bisa diubah?

Di tingkat hak akses: peran aplikasi hanya `INSERT` (tanpa `UPDATE`, `DELETE`, bahkan `SELECT`), peran auditor hanya `SELECT`, tes terhubung sebagai peran sungguhan (S-34, TK-10). Jujur tentang batasnya: **pemilik skema atau superuser masih bisa mengubahnya**, dan rantai hash (`prev_hash`/`row_hash`) hanya dirancang, bukan dikerjakan (Q-12, pertanyaan ini juga dikembalikan ke dosen). Maka audit di sini *append-only bagi aplikasi*, bukan *tamper-evident*. **[teruji]** hak akses; rantai hash **tidak ada**.

### 14. Bagaimana mencegah transaksi ganda pada permintaan bersamaan?

`Idempotency-Key` wajib; `insertPending` memakai `ON CONFLICT DO NOTHING`, sehingga tepat satu permintaan menang dan menjalankan orkestrasi; yang kalah membandingkan lima field (token pelanggan, token rekening, merchant, jumlah, geohash) dan menjawab 200 dengan data tersimpan, 409 bila beda, setelah menunggu pemenang `PENDING` hingga `HTTP_TIMEOUT_MS` (K-25). Kunci efektif selama token P1 berlaku (ADR-0009). Rujukan: `transaction/processor.ts` (`process`, `replay`). **[teruji]** 2 dan 20 permintaan serentak, minimal 20 putaran, PostgreSQL asli.

### 15. Bagaimana bila token kedaluwarsa di tengah transaksi?

`withReissue`: `TokenExpiredError` dari pertukaran (410 `EXPIRED`) membuat Transaction meminta Privacy menerbitkan ulang kedua token, menyimpan yang baru, dan mencoba langkah itu sekali lagi (TF-04). Privacy menolak re-issue untuk transaksi yang sudah final (`TX_TERMINAL`), karena itu urutannya: notifikasi dulu, baru PATCH status final, menyimpang dari urutan spek dengan alasan tertulis. Rujukan: `transaction/followups.ts`, `processor.ts` (`orchestrate`). **[teruji]** E2E TX-10003.

### 16. Bagaimana kamu memastikan tidak ada data pribadi di log dan audit?

Berlapis: logger hanya menerima field dari daftar dan memvalidasi bentuknya (`logger.ts`); tidak ada kolom untuk identitas di `audit_log` dan format `actor_id`, `pseudonym`, dll. divalidasi regex; ESLint melarang `console.*`; dan pemindai kenari mencari nilai persis di database, log, metrik, audit, dan jawaban setelah skenario penuh. Karena "nol temuan" tak berarti apa-apa bila pemindai buta, ada **kontrol positif** (data sengaja ditaruh dan harus ditemukan). Pada **baseline** log juga diasersi bersih untuk satu skenario (suite kesetaraan memindai log semua proses); itu bukan bukti umum. **[teruji]** kedua mode untuk satu skenario.

### 17. Mengapa membuat Gateway sendiri alih-alih memakai Kong?

Keputusan ADR-0004: fase awal dikerjakan lokal tanpa Docker, dan prototipe plugin Lua `privacy-tokenizer` ditunda. `gateway-adapter` NestJS menjalankan perilaku tokenisasi yang sama; tes kontrak (`tests/security/gateway-contract/*.json`, `gateway-contract.spec.ts`) disiapkan agar plugin Lua kelak diuji terhadap vektor yang sama. Konsekuensi untuk pengukuran: Gateway yang dipakai wajib disebut dan sama untuk kedua mode (ADR-0004). **[BELUM TERUJI]** Kong dan plugin Lua (DK-02).

### 18. Apakah dev-idp aman? Ia memberi token tanpa kata sandi.

Tidak dimaksudkan aman untuk dunia nyata; ia pengganti lokal. Pengamannya: menolak start kecuali `NODE_ENV` adalah `development`/`test` dan `DEV_IDP_ENABLED=true`, hanya mengikat loopback, kunci RSA dibuat di memori dan tak pernah ditulis. Risiko yang diterima: proses lain di mesin bisa meminta token untuk pengguna seed mana pun. Keycloak menggantinya di fase Docker (DK-04); pemetaan klaimnya adalah utang. Layanan lain memeriksa token dengan RS256 saja, `aud`, umur maksimum 300 detik, dan `azp` dari daftar tetap. Rujukan: `tools/dev-idp/README.md`, `packages/common/src/authenticate.ts`. **[teruji]** tes dev-idp dan autentikasi; Keycloak **[BELUM TERUJI]**.

### 19. Apakah pencabutan sama dengan "hak untuk dilupakan"?

Tidak bisa diklaim begitu. `revoke_subject` mencabut semua token aktif subjek dan mengosongkan brankas (semua kolom terenkripsi dan blind index menjadi `NULL`, `purged_at` diisi; baris dan audit tetap). Tetapi: nomor HP di Notification tetap (tidak ada endpoint hapus), IdP/Keycloak tetap, Gateway boleh menerbitkan token baru, dan baris retensi hanya mengosongkan kolom, tidak menghapus baris. Maka ini *minimisasi dan pencabutan akses*, bukan penghapusan menyeluruh. Rujukan: [03](03-alur-end-to-end.md) bagian E dan F. **[teruji]** pengosongan brankas (TK-17, S-37, S-36).

### 20. Apakah pseudonim masih data pribadi menurut hukum?

Prinsip umumnya: data yang dapat dikaitkan kembali ke orang dengan informasi tambahan tetap data pribadi, jadi pseudonim mengurangi risiko dan paparan tetapi bukan anonimisasi. Itu sebabnya skripsi mengukur *paparan struktural* (E(s)), bukan mengklaim data keluar dari lingkup pelindungan. **[belum diverifikasi]** kutipan pasal UU PDP dan pedoman EDPB di PRD; proyek sendiri mencatat itu belum diverifikasi, jadi jangan menyebut nomor pasal di sidang tanpa memeriksanya.

### 21. Bagaimana rekonsiliasi bekerja tanpa identitas?

Laporan bank tiba di Gateway, rekeningnya diganti token P6 (satu token per rekening untuk Reconciliation) sebelum sampai ke Reconciliation. Saat `run`, Reconciliation membaca transaksi `COMPLETED` hari itu dari Transaction (hanya jumlah dan waktu) dan meminta token P6 per transaksi dari Privacy (Privacy menurunkan rekening dari token P2 lewat `transaction_link`). `match` memasangkan (token rekening, jumlah) satu lawan satu secara deterministik. Bila Privacy tak menjawab, run berhenti 503 sebelum batch disentuh. Rujukan: [03](03-alur-end-to-end.md) bagian G, `reconciliation/reconciler.ts`. **[teruji]** E2E (`scenarios.integration.spec.ts`: tiga transaksi hari itu, tiga cocok, status `MATCHED`, TX yang `HELD` tidak ikut) dan, dalam run bab 01, `PARTIAL` (dua cocok dari tujuh transaksi).

### 22. Mengapa satu database per layanan tanpa foreign key lintas? Bisakah penyerang menggabungkan data lewat pseudonim?

Invarian 4 dan 5: satu layanan satu database, dan token satu layanan tidak berlaku di layanan lain. Fraud sengaja tidak menyimpan `transaction_id`, sehingga `fraud_assessments` tak bisa di-join ke `transactions`. Token pelanggan yang sama berbeda di Transaction (P1), Fraud (P3), dan Notification (P4/P5). Karena itu join lintas basis data lewat pseudonim diharapkan nol baris. Pengecualian yang diakui: penautan **di dalam** satu layanan selama TTL. **[sebagian]** skema dan tes per layanan; **[BELUM TERUJI]** percobaan join dan skrip penautan (M6-03, S-71, S-72).

### 23. Bagaimana rotasi kunci?

Tidak ada rotasi otomatis. Yang ada: setiap ciphertext membawa `key_version` sehingga dekripsi memilih kunci menurut versi, dan `KeyMaterial.field` adalah peta versi ke kunci; `PSEUDONYM_KEY_VERSION` memilih versi penulisan. Prosedur rotasi (terutama `K_index`, yang mengubah semua blind index) adalah prosedur tertulis di luar cakupan implementasi (PRD 2). **[BELUM TERUJI]** rotasi.

### 24. Apa ancaman terhadap validitas perbandingan baseline vs proposed?

Yang sudah teridentifikasi: (1) N-45, riwayat Fraud berbeda saat token berganti; (2) N-46, Reconciliation baseline mengambil rekening dari Transaction, proposed dari Privacy; (3) registrasi baseline tidak menyimpan NIK dan nama; (4) fungsi yang hanya ada di proposed dihitung terpisah; (5) lingkungan (satu mesin, PostgreSQL 18, Gateway pengganti, dev-idp); (6) harapan E(s) baseline di spek sebagian belum cocok dengan kode (temuan 26); (7) beban k6 bersifat closed-loop. Rujukan: [05](05-mode-baseline-proposed.md) bagian akhir, `docs/OPEN_QUESTIONS.md` N-45..N-47.

### 25. Apa bagian paling lemah dari sistem ini, dan apa yang akan kamu ubah?

Jawaban jujur yang berpijak pada daftar di atas: (a) bukti end-to-end dan kinerja belum ada: Docker, gagal-tertutup dengan replika, Newman, k6, E(s), penautan, dan itu pekerjaan M6 dan M7; (b) audit bukan *tamper-evident* (rantai hash belum dikerjakan); (c) pencabutan tidak menghapus HP di Notification; (d) harapan E(s) baseline perlu diselaraskan dengan kode atau sebaliknya (keputusan A atau B); (e) validasi penuh Keycloak/Kong belum ada. Yang tidak boleh diklaim: bahwa sistem anonim, aman terhadap orang dalam yang menguasai kunci dan database, atau sudah terukur kinerjanya.

## Bagian 3. Ringkasan status bukti untuk cepat dibuka di sidang

| Hal | Status |
| --- | --- |
| Kode bisnis sama di kedua mode, mode benar-benar berbeda | teruji (tes arsitektur, kesetaraan, pemindai, mutasi) |
| Pemisahan token antar-layanan, tiga kunci, AAD, blind index | teruji (unit dan integrasi) |
| Pembukaan identitas empat mata, sekali pakai, 600 detik, audit | teruji di lapis layanan; Newman end-to-end belum |
| Gagal tertutup | teruji lokal; dengan Docker/replika belum |
| Kinerja (k6), E(s) resmi, uji penautan | belum |
| Docker, Kong, Keycloak, TLS | belum |
| Kutipan hukum dan literatur | belum diverifikasi |
