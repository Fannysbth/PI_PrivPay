> **Salinan baca-saja** dari dokumen "PRD PrivPay v2" (rev 186, v2.4, diekspor 19 Okt 2026). Diagram yang tertanam di dokumen asli (use case, arsitektur, DFD, sequence, ERD, flowchart, deployment, milestone) tidak ikut; gambar arsitektur ada di berkas PNG sebelah. Selisih dan kontradiksi internal yang sudah ditemukan: lihat ../OPEN_QUESTIONS.md. Jangan ubah berkas ini; usulan koreksi ditulis di docs/PRD_ERRATA.md.

# PRD PrivPay v2 — Privacy-by-Design Prototype

Oct 6, 2026 · @fanny

PRD v2 menyelaraskan dokumen produk dengan rancangan sistem final: Gateway yang mentokenisasi lebih dulu, pertukaran token antar-service lewat `source_pseudonym`, Policy Evaluation Engine sebagai gerbang setiap penerbitan token, serta audit log yang tidak lagi menyimpan `subject_id`. Semua detail teknis yang dibutuhkan untuk implementasi ada di dokumen ini.

## 1. Ringkasan eksekutif

PrivPay adalah prototipe e-wallet berarsitektur microservices yang dipakai sebagai artefak penelitian, bukan produk produksi. Fungsinya membuktikan satu klaim: identitas pelanggan dapat dihapus dari seluruh layanan hilir tanpa mematahkan proses bisnis transaksi, deteksi fraud, notifikasi, dan rekonsiliasi.

**Masalah.** Pada arsitektur microservices konvensional, satu identitas pelanggan disalin ke setiap basis data layanan. Satu layanan yang jebol memberi penyerang identitas lengkap, dan banyaknya salinan membuat pemenuhan hak penghapusan pada UU PDP sulit diverifikasi.

**Solusi.** Sebuah Privacy Service terpusat menerbitkan token kontekstual yang terikat pada kombinasi subjek, layanan tujuan, dan tujuan pemrosesan, serta memiliki masa berlaku. Layanan hilir hanya menerima token, sedangkan atribut identitas dari pendaftaran (NIK, nama, HP, dan nomor rekening) disimpan sekali, terenkripsi, di brankas identitas milik Privacy Service. Audit internal bekerja di atas pseudonim. Identitas asli hanya dapat dibuka melalui permintaan pembukaan bersyarat yang disetujui admin lain, lalu lima gerbang pemeriksaan, dan selalu tercatat di audit log.

**Nama teknik.** *Context-Aware Service/Purpose-Bound Dynamic Pseudonymization*. Kata "dinamis" berarti token berganti menurut konteks dan siklus hidup, bukan berganti pada setiap request. Teknik ini tergolong *regular (non-blind) pseudonymization*: Privacy Service mengetahui identitas asli. Keterbatasan ini diakui, bukan disembunyikan.

### Perubahan v1 ke v2

| # | Bagian | PRD v1 | PRD v2 | Alasan |
| --- | --- | --- | --- | --- |
| 1 | Alur tokenisasi | Transaction Service memanggil `/pseudonymize` dengan `subject_id` mentah | Gateway mentokenisasi lebih dulu; layanan hilir menukar token miliknya lewat `source_pseudonym` | v1 bertentangan dengan aturan bahwa hanya Privacy Service menerima data mentah |
| 2 | Matriks pemanggilan | Notification hanya didaftarkan sekali per akun | Ditambah `RESOLVE_NOTIF_DOMAIN` pada setiap pengiriman notifikasi | Tanpa ini notifikasi tidak dapat dikirim |
| 3 | Constraint mapping | `UNIQUE (subject_id, service_id, purpose)` | Partial unique index `WHERE status = 'active'` | v1 memblokir penerbitan ulang token setelah kedaluwarsa |
| 4 | Audit log | Menyimpan kolom `subject_id` | Diganti `mapping_id` + `actor_id`; `subject_id` dilarang | v1 menciptakan salinan identitas kedua yang tidak terenkripsi |
| 5 | Otorisasi penerbitan | Pemeriksaan ad-hoc | Policy Evaluation Engine dengan tabel kebijakan final `(Tabel 1, Bagian 6.1)` sebagai STEP 0 | Kombinasi service dan purpose tidak boleh bebas ditentukan saat runtime |
| 6 | Status transaksi | Tidak ada | Tabel `transaction_status` + panggilan pembaruan status dari Transaction | Dibutuhkan oleh aturan re-issue dan gerbang TX\_TERMINAL |
| 7 | Subjek yang dipseudonimkan | Hanya pelanggan | Ditambah `subject_type` (CUSTOMER / ACCOUNT) | Nomor rekening juga data keuangan yang wajib dilindungi |
| 8 | Anti-error | Tidak ada | Grace period + auto re-issuance | Token kedaluwarsa di tengah transaksi tidak boleh menggagalkan transaksi |
| 9 | Enkripsi | `subject_id` terenkripsi | Field-level encryption untuk seluruh kolom subjek + rate limiting di Gateway | Menutup celah privacy hotspot |

### Kriteria keberhasilan

| KPI | Target | Cara ukur |
| --- | --- | --- |
| Paparan PII di layanan hilir | 0 field identitas langsung pada Transaction, Fraud, Reconciliation | Inspeksi skema + dump basis data setelah uji beban |
| Fungsi bisnis utuh | 100% skenario fungsional lulus pada mode proposed | Newman, 3 skenario transaksi |
| Penolakan akses tidak sah | 100% permintaan lintas service atau lintas purpose ditolak | Uji keamanan 4 gate |
| Overhead latensi p95 | ≤ 20% terhadap baseline | k6 |
| Penurunan throughput | ≤ 15% terhadap baseline | k6 |
| Kelengkapan audit | 100% operasi token tercatat, SUCCESS maupun DENIED | Hitung baris `audit_log` versus jumlah panggilan |

Angka 20% dan 15% adalah parameter yang ditetapkan sendiri untuk penelitian ini, bukan standar industri. Nyatakan demikian saat sidang.

## 2. Tujuan, scope, dan non-goals

### Tujuan

| ID | Tujuan | Metrik keberhasilan |
| --- | --- | --- |
| G1 | Menghapus identitas langsung dari seluruh layanan hilir | 0 kolom NIK, nama, email, dan nomor rekening pada transaction-db, fraud-db, reconciliation-db |
| G2 | Menjaga fungsi bisnis tetap berjalan penuh dengan token | 3 skenario transaksi lulus tanpa modifikasi logika bisnis |
| G3 | Mengikat setiap token pada layanan, tujuan, dan masa berlaku | 100% permintaan lintas service atau lintas purpose ditolak dengan reason yang tepat |
| G4 | Mencatat setiap pembukaan identitas secara tidak dapat diubah | 100% `DE_PSEUDONYMIZE` tercatat dengan `actor_id` dan `purpose` |
| G5 | Membuktikan overhead privasi masih dalam batas yang dapat diterima | p95 ≤ 20% dan throughput ≥ 85% terhadap baseline |
| G6 | Menjamin token kedaluwarsa tidak menggagalkan transaksi berjalan | 0 transaksi gagal akibat `TOKEN_EXPIRED` pada uji beban |

### Keterlacakan ke judul skripsi

Setiap kata kunci judul harus punya wujud yang dapat ditunjuk di dokumen ini.

| Kata kunci judul | Wujud di PRD | Bagian |
| --- | --- | --- |
| Implementasi | Prototipe PrivPay yang berjalan pada dua mode, diuji, dan diukur | 17 sampai 19 |
| Pola arsitektur Privacy-by-Design | Tokenisasi di Gateway, Privacy Service sebagai satu-satunya pemegang mapping, dan prinsip PbD yang tercantum pada setiap kebutuhan | 5, 13 |
| Pseudonimisasi dinamis | Token terikat konteks (layanan, tujuan, jenis subjek) dengan TTL, pertukaran, pencabutan, dan retensi | 6 sampai 8 |
| Ekosistem microservices | Tujuh layanan dengan basis data masing-masing dan aturan panggilan searah | 5, 9, 10 |
| Deskripsi: "tidak pernah melihat data asli secara langsung kecuali benar-benar dibutuhkan" | Layanan hilir hanya memegang token. Data asli disimpan terenkripsi di brankas identitas dan dibuka per atribut hanya lewat pembukaan bersyarat pada jalur audit (P7, Tabel 5) yang disetujui admin lain; audit rutin memakai pseudonim; nomor HP ke Notification adalah satu-satunya pengecualian operasional | 4, 6.1, 7.4, 9, 11 |

### In scope

- Tujuh layanan: API Gateway, Auth, Privacy, Transaction, Fraud, Notification, Reconciliation.
- Pseudonimisasi dua jenis subjek: `CUSTOMER` dan `ACCOUNT`.
- Siklus hidup token penuh: terbit, tukar, grace, re-issue, kedaluwarsa, cabut.
- Policy Evaluation Engine dengan whitelist kombinasi tetap, serta brankas identitas terenkripsi (NIK, nama, HP, rekening) yang dibuka per atribut hanya lewat pembukaan bersyarat yang disetujui pihak kedua.
- Audit log append-only beserta endpoint pembacaannya.
- Dua mode penyebaran untuk perbandingan: baseline (tanpa pseudonimisasi) dan proposed.
- Harness pengujian: fungsional, paparan PII, keamanan, dan performa.

### Out of scope

- Aplikasi mobile atau antarmuka pengguna akhir. Klien diwakili koleksi Postman dan skrip k6.
- Integrasi nyata dengan bank, penyedia SMS, atau QRIS. Semuanya disimulasikan.
- *Blind* atau *polymorphic pseudonymization*, yaitu skema di mana penerbit token tidak mengetahui identitas asli.
- Model machine learning untuk fraud. Yang dipakai adalah mesin aturan berbobot.
- Manajemen persetujuan (consent), hak portabilitas data, dan antarmuka subjek data.
- High availability, multi-region, dan disaster recovery.
- Rotasi kunci otomatis. Kolom `key_version` disediakan, prosedur rotasinya tidak diimplementasikan.
- Model saldo dan ledger dompet; kepemilikan rekening sumber tidak diverifikasi.
- Pengiriman ulang notifikasi secara otomatis.

### Non-goals yang sering disalahpahami

| Bukan tujuan | Penjelasan |
| --- | --- |
| Token berganti pada setiap request | Token aktif digunakan ulang selama TTL-nya. Inilah alasan sistem ini disebut semi-dinamis, dan linkability dalam jendela TTL tetap ada |
| Menghilangkan semua PII dari sistem | Nomor HP tetap disimpan Notification, dan Keycloak tetap menyimpan identitas login. Keduanya tercatat sebagai pengecualian yang disengaja |
| Menggantikan enkripsi | Pseudonimisasi berjalan di atas enkripsi kolom dan TLS, bukan menggantikannya |
| Mengukur kinerja produksi | Semua kontainer berjalan di satu VPS, sehingga angka overhead cenderung optimistis dibanding penyebaran terdistribusi |

## 3. Persona dan user stories

&#91;embedded content: use case diagram · 4 actors, 12 use cases\]

Semua jalur yang membuka atau mencabut token menyertakan pencatatan audit, sehingga tidak ada operasi sensitif yang berjalan tanpa jejak.

### Persona

| Persona | Peran | Yang dibutuhkan | Yang tidak boleh dilihat |
| --- | --- | --- | --- |
| Nasabah | Pemilik akun e-wallet | Transaksi berhasil, notifikasi diterima | — |
| Fraud Analyst | Menilai risiko transaksi | Atribut risiko dan skor | Identitas pelanggan dalam bentuk apa pun |
| Admin / Auditor | Mengaudit dan mencabut token | Jejak lengkap siapa membuka apa, untuk tujuan apa | Identitas, kecuali melalui pembukaan bersyarat yang disetujui pihak kedua pada jalur `INTERNAL_AUDIT` yang tercatat |
| Peneliti | Mengukur dan membandingkan dua mode | Metrik paparan PII, latensi, throughput | — |

### User stories dan acceptance criteria

| ID | Story | Prioritas | Acceptance criteria |
| --- | --- | --- | --- |
| US-01 | Sebagai nasabah, saya ingin bertransaksi tanpa identitas saya disebar ke banyak layanan, agar risiko kebocoran berkurang | Must | Setelah transaksi selesai, `transactions` hanya berisi pseudonim; tidak ada NIK, nama, email, atau nomor rekening di transaction-db |
| US-02 | Sebagai nasabah, saya ingin tetap menerima notifikasi SMS, agar saya tahu transaksi berhasil | Must | Notification mengirim SMS tanpa pernah menerima `customer_id`; `notif_token` diterjemahkan ke `notification_domain_id` lebih dulu |
| US-03 | Sebagai nasabah, saya ingin transaksi saya tidak gagal hanya karena token kedaluwarsa | Must | Token yang kedaluwarsa pada transaksi non-terminal diterbitkan ulang otomatis; transaksi tetap `COMPLETED` |
| US-04 | Sebagai fraud analyst, saya ingin menilai risiko dari atribut perilaku, bukan identitas | Must | `/fraud/assess` menerima `fraud_token` dan atribut risiko; fraud-db tidak dapat dijoin ke transaction-db melalui pseudonim |
| US-05 | Sebagai admin, saya ingin mencabut token yang mencurigakan seketika | Should | `POST /pseudonym/{id}/revoke` mengubah status menjadi `revoked`; pemakaian berikutnya ditolak dengan reason `REVOKED` |
| US-06 | Sebagai auditor, saya ingin membuka identitas asli pada kasus tertentu (dasar sah, nomor kasus, persetujuan admin lain) dengan jejak lengkap, sedangkan audit rutin cukup memakai pseudonim | Must | `/de-pseudonymize` berhasil hanya jika lolos 4 gate; satu baris `DE_PSEUDONYMIZE` tercatat lengkap dengan `actor_id` |
| US-07 | Sebagai auditor, saya ingin melihat percobaan akses tidak sah | Must | `GET /audit-log?status=DENIED` menampilkan reason `SERVICE_MISMATCH`, `PURPOSE_MISMATCH`, `TOKEN_NOT_FOUND` |
| US-08 | Sebagai auditor, saya ingin menelusuri riwayat satu token dari lahir sampai mati | Should | `GET /audit-log/timeline/{pseudonym}` mengembalikan rangkaian event terurut waktu |
| US-09 | Sebagai peneliti, saya ingin menjalankan sistem pada dua mode dengan kode yang sama | Must | Satu variabel lingkungan `PRIVACY_MODE` mengalihkan baseline dan proposed tanpa mengubah kode layanan |
| US-10 | Sebagai peneliti, saya ingin mengukur paparan PII secara otomatis | Must | Skrip menghitung jumlah field identitas per basis data pada kedua mode dan menghasilkan tabel perbandingan |
| US-11 | Sebagai peneliti, saya ingin membandingkan latensi dan throughput | Must | k6 menghasilkan p50, p95, p99, dan RPS untuk kedua mode pada beban yang sama |
| US-12 | Sebagai admin, saya ingin permintaan tujuan yang tidak diizinkan ditolak sejak awal | Must | Kombinasi di luar `Tabel 1` ditolak dengan `POLICY_NOT_ALLOWED`, tanpa baris mapping dibuat |
| US-13 | Sebagai auditor, saya ingin tahu siapa saja yang pernah membaca audit log | Could | Setiap `GET /audit-log` menghasilkan baris `VIEW_AUDIT_LOG` |
| US-14 | Sebagai peneliti, saya ingin membuktikan log aplikasi tidak bocor PII | Should | Pemindaian pola NIK, HP, dan nomor rekening pada seluruh log kontainer menghasilkan nol temuan pada mode proposed |

## 4. Klasifikasi data dan kebijakan perlakuan

Dasar klasifikasi adalah Pasal 4 UU PDP: ayat (2) untuk data pribadi spesifik, ayat (3) untuk data pribadi umum. Verifikasi kutipan pasalnya ke PDF resmi sebelum masuk naskah skripsi.

| Field | Kelas | Dasar | Perlakuan di sistem |
| --- | --- | --- | --- |
| Nomor rekening / ID e-wallet | Spesifik | Pasal 4 ayat (2) huruf f, data keuangan pribadi | Dipseudonimkan menjadi `account_token`; nilai asli hanya di Privacy Service, terenkripsi |
| Nominal, riwayat transaksi, saldo | Spesifik | Pasal 4 ayat (2) huruf f | Tetap jelas karena dibutuhkan fungsi bisnis; dipisahkan dari identitas lewat token |
| Nama lengkap | Umum | Pasal 4 ayat (3) huruf a | Tidak pernah diteruskan ke layanan hilir; disimpan terenkripsi di brankas identitas, dibuka hanya lewat pembukaan bersyarat P7 |
| NIK | Umum, hasil tafsir | Pasal 4 ayat (3) huruf f, kombinasi yang mengidentifikasi | Tidak pernah diteruskan ke layanan hilir; disimpan terenkripsi di brankas identitas, dibuka hanya lewat pembukaan bersyarat P7. Diperlakukan setara spesifik dalam desain |
| Nomor HP, email | Umum, hasil tafsir | Pasal 4 ayat (3) huruf f | HP disimpan Notification sebagai pengecualian dan tersimpan terenkripsi di brankas identitas; email hanya di Keycloak |
| `customer_id` internal | Umum, hasil tafsir | Pasal 4 ayat (3) huruf f | Dipseudonimkan menjadi token per layanan dan per tujuan |
| Atribut risiko: nominal, jam, geohash | Abu-abu | Tidak disebut eksplisit | Dikirim jelas ke Fraud tanpa identitas; digabung dengan nominal menjadi bagian profil keuangan |
| Skor risiko fraud | Abu-abu, data turunan | Tidak disebut | Disimpan terhadap `fraud_token`, bukan terhadap identitas |
| Token / pseudonim | Mengikuti data yang dirujuk | EDPB 01/2025 par. 22 | Tetap data pribadi; akses bacanya dibatasi peran |
| Isi `audit_log` | Mengikuti isinya | — | Dirancang agar hanya berisi token, `mapping_id`, dan konteks |

### Tiga perlakuan terhadap data

| Perlakuan | Contoh field | Keterangan |
| --- | --- | --- |
| Dipseudonimkan | `customer_id`, nomor rekening | Diganti token kontekstual sebelum keluar dari Gateway |
| Tidak diteruskan | NIK, nama, email | Dibuang dari payload di Gateway karena tidak dibutuhkan layanan hilir mana pun; nilai aslinya disimpan sekali di brankas identitas saat pendaftaran |
| Dibiarkan jelas karena fungsinya | Nominal, `merchant_id`, geohash, jam, nomor HP di Notification | Dibutuhkan agar fungsi bisnis berjalan; dicatat sebagai keputusan sadar |

### Dua catatan yang perlu dipertahankan saat sidang

1. Pembagian umum dan spesifik tidak menyelesaikan masalah penyebaran. Pasal 4 ayat (3) huruf f menyatakan kombinasi atribut umum yang mengidentifikasi seseorang tetap tercakup, sehingga penyebaran NIK, HP, dan nama ke banyak layanan tetap bermasalah meski masing-masing tergolong umum.
2. UU PDP tidak mendefinisikan pseudonimisasi. Rujukan untuk pernyataan bahwa token tetap merupakan data pribadi adalah EDPB, bukan hukum Indonesia. Tulis demikian di naskah.

## 5. Arsitektur sistem

&#91;embedded content: arsitektur PrivPay · 3 lapisan, 2 zona data, 7 aliran bernomor\]

Garis panggilan berjalan satu arah dari Gateway ke bawah, dan Privacy Service tidak pernah memanggil keluar. Aturan ini mencegah dependensi melingkar dan menyederhanakan analisis mode kegagalan. Aliran bernomor pada diagram: (1) data asli dari klien, (2) permintaan audit, (3) laporan settlement berisi nomor rekening, (4) customer\_id, rekening, dan identitas saat pendaftaran dari Gateway ke Privacy Service, (5) permintaan bertoken dari Gateway ke layanan bisnis, (6) tukar token dan resolve domain antara layanan bisnis dan Privacy Service, (7) nomor HP dan isi SMS generik dari Notification ke penyedia SMS.

### Inventaris layanan

| Layanan | Tanggung jawab | Basis data | Memegang data mentah |
| --- | --- | --- | --- |
| API Gateway (Kong) | Routing, rate limiting, validasi JWT, titik tokenisasi pertama lewat plugin kustom privacy-tokenizer | kong-db (konfigurasi saja) | Ya, hanya dalam perjalanan, tidak disimpan |
| Auth Service (Keycloak) | Autentikasi pengguna dan service account, penerbitan JWT | keycloak-db | Ya, identitas login. Tercatat sebagai batasan penelitian |
| Privacy Service | Penerbitan, pertukaran, dan pembukaan token; Policy Engine; brankas identitas; modul Audit | privacy-db | Ya, satu-satunya penyimpan mapping dan brankas identitas, keduanya terenkripsi |
| Transaction Service | Pemrosesan transaksi, orkestrasi fraud dan notifikasi | transaction-db | Tidak |
| Fraud Service | Penilaian risiko berbasis aturan berbobot | fraud-db | Tidak |
| Notification Service | Registrasi kontak dan pengiriman notifikasi | notification-db | Ya, nomor HP saja. Pengecualian yang disengaja |
| Reconciliation Service | Pencocokan settlement harian dan permintaan audit internal | reconciliation-db | Tidak |

### Aturan arsitektur yang mengikat

1. Hanya Gateway dan Privacy Service yang boleh menerima `customer_id` atau nomor rekening mentah, serta NIK dan nama dari formulir pendaftaran.
2. Layanan hilir meminta token baru dengan menyerahkan token miliknya sebagai `source_pseudonym`, tidak pernah dengan `subject_id`.
3. Privacy Service tidak memanggil layanan lain. Semua panggilan masuk ke arahnya.
4. Setiap layanan memiliki basis datanya sendiri. Tidak ada akses lintas basis data.
5. Token dari satu layanan tidak dapat dipakai layanan lain, sehingga basis data antar-layanan tidak dapat dijoin lewat pseudonim.
6. Log aplikasi setiap layanan hanya boleh memuat token dan `transaction_id`.

### Mekanisme tokenisasi di Gateway

Kong tidak dapat memanggil layanan lain dan mengganti isi permintaan hanya dengan plugin bawaan. Karena itu tokenisasi dilakukan oleh satu plugin kustom, `privacy-tokenizer`, yang dipasang pada route yang membawa identitas dan dijalankan setelah plugin JWT.

1. Plugin `jwt` memvalidasi tanda tangan dan masa berlaku token, lalu meneruskan klaim `customer_id` dan peran.
2. Pada fase `access`, `privacy-tokenizer` membaca `customer_id` dari klaim dan nomor rekening dari isi permintaan, sesuai konfigurasi field per route.
3. Plugin memanggil `POST /pseudonymize` (bentuk 1) dengan token service account API\_GATEWAY yang disimpan di cache sampai 30 detik sebelum kedaluwarsa. Satu permintaan klien menghasilkan satu panggilan per subjek.
4. Plugin mengganti `customer_id` dan nomor rekening dengan token, membuang field identitas lain (NIK, nama, email), dan meneruskan permintaan bersama `transaction_id` yang ia bangkitkan, berformat TX- diikuti nomor unik.
5. Pada fase respons, plugin menyamarkan reason penolakan menjadi ACCESS\_DENIED bagi klien eksternal.
6. Bila Privacy Service tidak tersedia, plugin menolak dengan 503 dan tidak pernah meneruskan data mentah.

Pada `PRIVACY_MODE=baseline`, plugin dikonfigurasi `mode=passthrough`, sehingga jalur Gateway tetap sama tetapi tidak memanggil Privacy Service. Plugin ditulis dalam Lua, bahasa asli Kong, agar tidak menambah hop jaringan. Jika Lua menjadi hambatan pengerjaan, cadangannya adalah layanan tipis `gateway-adapter` di belakang Kong dengan perilaku yang sama. Keduanya berada di zona Gateway sehingga aturan arsitektur tidak berubah, tetapi pengukuran overhead wajib menyebutkan pilihan yang dipakai.

## 6. Mekanisme pseudonimisasi dinamis

Nama resmi teknik ini adalah *Context-Aware Service/Purpose-Bound Dynamic Pseudonymization*. Token tidak bersifat tetap seperti hasil hashing biasa, melainkan kontekstual dan memiliki siklus hidup.

### Apa arti "dinamis" di sini

| Bukan | Ya |
| --- | --- |
| Token berganti pada setiap request | Token berganti menurut kombinasi layanan dan tujuan |
| Token acak tanpa keterkaitan | Token stabil selama TTL berkat penggunaan ulang baris aktif, bukan karena rumusnya |
| Penerbit tidak tahu identitas asli | Penerbit tahu identitas asli; ini *regular*, bukan *blind pseudonymization* |
| Token berlaku selamanya | Token punya TTL, grace period, dan status |

### Empat pilar

| Pilar | Isi | Konsekuensi desain |
| --- | --- | --- |
| 1. Variabel kombinasi | Token dibentuk dari `(subject_id, service_id, purpose)`, bukan dari `subject_id` saja | Satu orang memegang beberapa token berbeda secara simultan; basis data antar-layanan tidak dapat dijoin |
| 2. Siklus hidup | TTL ditentukan dari SLA proses bisnis; status berpindah `active` → `grace` → `expired` atau `revoked` | Jendela keterkaitan dibatasi waktu |
| 3. Otorisasi saat dibuka | Token hanya dapat dibuka jika layanan dan tujuan pemanggil sama persis dengan saat token dibuat, dan token masih berlaku | Lima gerbang pemeriksaan (termasuk persetujuan pihak kedua) pada `/de-pseudonymize` |
| 4. Anti-error | Token yang kedaluwarsa di tengah proses tidak menggagalkan transaksi, melalui auto re-issuance yang transparan | Grace period dan gerbang `TX_TERMINAL` |

### Pembentukan token

Token dihitung dengan HMAC-SHA256 atas kombinasi konteks, lalu dipotong dan diberi awalan.

```latex
\text{pseudonym} = \text{"PSEU-"} \;\|\; \text{upper}\big(\text{trunc}_{8}\big(\text{HMAC-SHA256}(K,\; \text{subject\_type} \,\|\, \text{subject\_id} \,\|\, \text{service\_id} \,\|\, \text{purpose} \,\|\, \text{nonce})\big)\big)
```

| Variabel | Asal | Catatan |
| --- | --- | --- |
| `K` | Secret HMAC Privacy Service, dari variabel lingkungan | Tidak pernah keluar dari Privacy Service; kandidat rotasi lewat `key_version` |
| `subject_type` | `CUSTOMER` atau `ACCOUNT` | Memisahkan ruang token pelanggan dan rekening |
| `subject_id` | `customer_id` atau nomor rekening | Hanya diketahui Gateway dan Privacy Service |
| `service_id` | Layanan pemilik token (target\_service) | Dikirim sebagai target\_service di body; kombinasinya harus ada di Tabel 1 (Bagian 6.1) |
| `purpose` | Tujuan pemrosesan | Harus ada di whitelist |
| `nonce` | UUID per penerbitan | Membuat token hasil re-issue berbeda dari token sebelumnya |

Karena ada `nonce`, token bersifat tidak dapat ditebak meski penyerang mengetahui kombinasi konteksnya. Tabrakan 8 heksadesimal ditangani dengan unique constraint pada kolom `pseudonym` dan percobaan ulang pembangkitan.

### Contoh: satu pelanggan, empat token simultan

| Subjek | service\_id | purpose | Pseudonym | TTL |
| --- | --- | --- | --- | --- |
| CUST-000102 | TRANSACTION | PAYMENT\_PROCESSING | PSEU-2B7E5D10 | 15 menit |
| CUST-000102 | FRAUD | FRAUD\_DETECTION | PSEU-7BCD04F2 | 30 hari |
| CUST-000102 | NOTIFICATION | NOTIFICATION | PSEU-D51A88E6 | 15 menit |
| CUST-000102 | NOTIFICATION | NOTIFICATION\_REGISTRATION | PSEU-0E94B7D2 | 365 hari |

### Policy Evaluation Engine

Setiap permintaan penerbitan token melewati evaluasi kebijakan sebagai langkah pertama, sebelum mapping apa pun dibuat. Sumber tunggal kebijakan adalah Tabel 1 pada Bagian 6.1, yang memuat kombinasi layanan, tujuan, jenis subjek, cara terbit, TTL, dan izin pembukaan. Bagian ini sengaja tidak mengulang isi tabel itu agar tidak ada dua versi kebijakan. Contoh yang harus gagal: `NOTIFICATION` meminta `SEND_PROMOTION`, `FRAUD` meminta `INTERNAL_AUDIT`, atau `FRAUD` meminta token `ACCOUNT`. Semuanya ditolak `POLICY_NOT_ALLOWED` dan tercatat di audit log.

### 6.1 Tabel kebijakan final

Seluruh isi bagian ini adalah konfigurasi yang ditentukan sebelum koding dimulai, bukan nilai yang ditentukan sistem saat berjalan. Tabel-tabel ini menjadi sumber tunggal untuk Policy Engine, validasi kontrak API, dan skenario uji keamanan. Menambah baris berarti mengubah kebijakan, dan itu keputusan perancang.

#### Istilah yang dipakai pada seluruh dokumen

| Istilah | Arti | Asal nilai |
| --- | --- | --- |
| `requesting_service` | Layanan yang memanggil Privacy Service | Klaim JWT; tidak dapat dipalsukan lewat body |
| `target_service` | Layanan yang akan memegang token | Body permintaan; harus ada di Tabel 1 |
| `service_id` (kolom basis data) | Layanan pemilik token, disalin dari `target_service` saat token diterbitkan | Diturunkan, tidak pernah dikirim klien |
| `source_pseudonym` | Token milik pemanggil yang ditukar | Body, hanya pada pertukaran token |

Contoh: Gateway (`requesting_service` = API\_GATEWAY) meminta token untuk Transaction (`target_service` = TRANSACTION). Baris mapping yang terbentuk menyimpan `service_id` = TRANSACTION, dan hanya TRANSACTION yang kelak dapat memakainya.

#### Tabel 1: konteks yang sah

Setiap baris adalah satu kombinasi yang diizinkan. Permintaan yang tidak cocok dengan salah satu baris ditolak `POLICY_NOT_ALLOWED`.

| # | service\_id | purpose | subject\_type | Cara terbit | TTL (detik) | Boleh dibuka | Peran diperlukan |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P1 | TRANSACTION | PAYMENT\_PROCESSING | CUSTOMER | Dari identitas, oleh Gateway | 900 | Tidak | service |
| P2 | TRANSACTION | PAYMENT\_PROCESSING | ACCOUNT | Dari identitas, oleh Gateway | 900 | Tidak | service |
| P3 | FRAUD | FRAUD\_DETECTION | CUSTOMER | Pertukaran token | 2.592.000 | Tidak | service |
| P4 | NOTIFICATION | NOTIFICATION | CUSTOMER | Pertukaran token | 900 | Tidak, hanya resolve domain | service |
| P5 | NOTIFICATION | NOTIFICATION\_REGISTRATION | CUSTOMER | Dari identitas, oleh Gateway | 31.536.000 | Tidak | service |
| P6 | RECONCILIATION | DAILY\_RECONCILIATION | ACCOUNT | Dari transaksi (Reconciliation) atau dari identitas (Gateway, laporan bank) | 86.400 | Tidak | service |
| P7 | RECONCILIATION | INTERNAL\_AUDIT | CUSTOMER | Dari transaksi | 600 | Ya | auditor |

Kolom `subject_type` menutup celah yang sebelumnya terbuka. Tanpa kolom ini, Fraud dapat meminta token atas nomor rekening, padahal rancangan hanya memberinya token pelanggan. Kolom "cara terbit" menutup celah kedua: hanya P1, P2, P5, dan P6 yang boleh menerima `subject_id` mentah, dan hanya dari Gateway. Untuk P6, `subject_id` itu adalah nomor rekening dari laporan bank. P6 dan P7 juga dapat diterbitkan oleh Reconciliation dari `transaction_id`, karena Reconciliation tidak pernah memegang identitas.

#### Tabel 2: matriks pertukaran token

Pertukaran token hanya sah jika pasangan sumber dan tujuannya ada di tabel ini. Pemeriksaannya dilakukan setelah gerbang kepemilikan token, dan sebelum token baru diterbitkan.

| # | Konteks sumber | Konteks tujuan | Pemanggil | Dipakai pada alur |
| --- | --- | --- | --- | --- |
| X1 | P1 (TRANSACTION, PAYMENT\_PROCESSING, CUSTOMER) | P3 (FRAUD, FRAUD\_DETECTION) | TRANSACTION | C1 |
| X2 | P1 (TRANSACTION, PAYMENT\_PROCESSING, CUSTOMER) | P4 (NOTIFICATION, NOTIFICATION) | TRANSACTION | B7 |

Hanya dua pertukaran yang sah di seluruh sistem. Semua kombinasi lain, misalnya FRAUD menukar tokennya ke NOTIFICATION, atau NOTIFICATION menukar ke RECONCILIATION, ditolak `POLICY_NOT_ALLOWED` meskipun token sumbernya valid dan milik pemanggil. Batasan inilah yang mencegah token mengalir berantai antar-layanan.

#### Tabel 3: matriks operasi

| Operasi | Pemanggil sah | Konteks yang boleh disentuh | Masukan utama |
| --- | --- | --- | --- |
| GENERATE\_TOKEN dari identitas | API\_GATEWAY | P1, P2, P5, P6 | `subject_type` + `subject_id` |
| GENERATE\_TOKEN dari transaksi | RECONCILIATION | P6, P7 | `transaction_id` |
| EXCHANGE\_TOKEN | TRANSACTION | X1, X2 | `source_pseudonym` |
| RESOLVE\_NOTIF\_DOMAIN | NOTIFICATION | Sumber P4, hasil P5 | `notif_token` |
| DE\_PSEUDONYMIZE | RECONCILIATION | P7 saja | `pseudonym` + `purpose` |
| RE\_ISSUE | TRANSACTION | P1, P2 | `pseudonym` lama |
| REVOKE\_TOKEN | ADMIN\_CONSOLE | Semua | `pseudonym` atau `mapping_id` |
| REVOKE\_SUBJECT | ADMIN\_CONSOLE | Semua milik satu subjek | `subject_type` + `subject_id` |
| VIEW\_AUDIT\_LOG | ADMIN\_CONSOLE | — | Filter |
| UPDATE\_TX\_STATUS | TRANSACTION | Tidak menyentuh konteks token | transaction\_id + status; tidak dicatat di audit\_log karena bukan operasi token |

`requesting_service` pada setiap baris diambil dari klaim JWT, bukan dari body permintaan, sehingga layanan tidak dapat mengaku sebagai layanan lain. `target_service` diambil dari body dan harus cocok dengan salah satu baris Tabel 1.

#### Tabel 4: peta proses bisnis ke purpose

| Proses bisnis | purpose | Alasan kombinasi ini diizinkan |
| --- | --- | --- |
| Pendaftaran akun | NOTIFICATION\_REGISTRATION | Notification memerlukan pseudonim stabil sebagai kunci `contact_registry`, karena nomor HP tidak boleh dikunci oleh identitas |
| Pemrosesan pembayaran | PAYMENT\_PROCESSING | Transaction perlu mengenali pelanggan dan rekening selama satu transaksi berlangsung |
| Penilaian risiko | FRAUD\_DETECTION | Fraud perlu mengelompokkan perilaku satu subjek dalam jendela analisis, tanpa mengetahui identitasnya |
| Pengiriman notifikasi | NOTIFICATION | Notification perlu merujuk subjek per transaksi, lalu menerjemahkannya ke pseudonim domain |
| Rekonsiliasi harian | DAILY\_RECONCILIATION | Reconciliation perlu mencocokkan rekening dengan laporan bank dalam satu siklus harian |
| Audit internal | INTERNAL\_AUDIT | Satu-satunya proses yang membenarkan pembukaan identitas, dengan jendela waktu paling sempit |

Purpose yang tidak ada di tabel ini tidak boleh dibuat saat implementasi. Contoh yang harus ditolak: `SEND_PROMOTION`, `MARKETING_ANALYTICS`, dan `DATA_EXPORT`.

#### Tabel 5: atribut brankas yang boleh dikembalikan

Pembukaan identitas tidak pernah mengembalikan seluruh isi brankas. Konteks yang boleh dibuka hanya mendapat atribut yang tercantum di sini, dan kolom lain tidak didekripsi sama sekali. Untuk P7 pun, atribut hanya dibuka lewat permintaan pembukaan yang disetujui admin lain (Bagian 7.4), dan hanya atribut yang disetujui pada permintaan itu; audit rutin tidak membuka atribut apa pun.

| Konteks | Pemanggil | Atribut yang dikembalikan | Alasan |
| --- | --- | --- | --- |
| P7 (RECONCILIATION, INTERNAL\_AUDIT, CUSTOMER) | Reconciliation, atas nama auditor yang memegang permintaan pembukaan berstatus APPROVED | `customer_id`, NIK, nama | Hanya bila ada dasar sah (Tabel 6) dan permintaan disetujui admin lain; atribut dibatasi pada yang disetujui |
| P1 sampai P6 | — | Tidak ada | Tidak ada proses bisnis yang membutuhkan identitas asli |

Nomor HP dan nomor rekening tidak dikembalikan lewat jalur audit karena audit internal tidak membutuhkannya. HP sampai ke Notification lewat pendaftaran kontak (Alur A4), bukan lewat pembukaan token.

#### Tabel 6: dasar pembukaan identitas yang sah

Permintaan pembukaan (Bagian 7.4) harus menyebut salah satu dasar berikut beserta nomor kasus. Dasar lain ditolak dengan `422 INVALID_BASIS`.

| Kode | Dasar | Contoh |
| --- | --- | --- |
| DISPUTE | Sengketa transaksi yang diajukan nasabah atau merchant | Nasabah menyangkal transaksi TX-10002 |
| FRAUD\_CONFIRMED | Dugaan penipuan yang sudah dikonfirmasi Fraud Analyst | Transaksi HELD yang dinyatakan penipuan |
| LEGAL\_REQUEST | Permintaan resmi aparat penegak hukum | Surat permintaan data bernomor |

#### Keputusan penggunaan ulang token

Kunci penggunaan ulang adalah subjek, layanan, dan purpose, tanpa `transaction_id`. Akibatnya dua transaksi berbeda dari pelanggan yang sama dalam satu jendela TTL berbagi token yang sama, sehingga layanan hilir dapat mengaitkan keduanya.

Ini keputusan sadar, bukan kelalaian. Alasannya, Fraud justru memerlukan pengelompokan perilaku satu subjek dalam jendela analisisnya, dan menerbitkan token baru per transaksi akan menghilangkan kemampuan itu sekaligus melipatgandakan baris mapping. Konsekuensinya adalah linkability dalam jendela TTL, dan itulah sebabnya teknik ini disebut semi-dinamis.

#### Penerbitan token dari transaksi

Baris P6 dan P7 diterbitkan dari `transaction_id`, bukan dari `subject_id`, karena Reconciliation tidak pernah memegang identitas. Privacy Service menurunkan subjeknya secara internal.

```
FUNGSI generate_from_transaction(transaction_id, target_service, purpose, subject_type, requesting_service):
  STEP 0  policy = policy_evaluate(requesting_service, target_service, purpose, subject_type, 'dari transaksi')
          JIKA ditolak:
            catat_audit(GENERATE_TOKEN, DENIED, POLICY_NOT_ALLOWED, ...)
            KEMBALIKAN error 403

  STEP 1  src = cari_mapping(transaction_id, subject_type)
            DARI baris yang diterbitkan Gateway (P1 untuk CUSTOMER, P2 untuk ACCOUNT),
            termasuk baris berstatus expired, karena transaksi lampau tetap dapat direkonsiliasi
          JIKA tidak ada ATAU src.purged_at tidak kosong:
            catat_audit(GENERATE_TOKEN, DENIED, TOKEN_NOT_FOUND, ...)
            KEMBALIKAN error 404          // identitas sudah dikosongkan oleh retensi

  STEP 2  subject = dekripsi_subjek(src)          // internal, tidak keluar
  STEP 3  hasil = buat_token(subject.type, subject.id, target_service, purpose,
                             transaction_id, requesting_service, policy)
  STEP 4  catat_audit(GENERATE_TOKEN, SUCCESS, hasil.reused ? 'REUSED_ACTIVE' : 'OK', hasil.mapping_id, ...)
          KEMBALIKAN hasil
```

Pencarian pada STEP 1 memakai indeks `idx_mapping_tx`. Baris kedaluwarsa ikut dibaca selama kolom identitasnya belum dikosongkan oleh job retensi (Bagian 6.2). Setelah dikosongkan, rekonsiliasi atas transaksi lama tidak lagi mungkin; ini konsekuensi yang disengaja dari retensi 90 hari.

### 6.2 Spesifikasi kunci dan pencabutan

Tiga kunci terpisah, tidak boleh saling dipakai ulang. Memakai satu kunci untuk tiga fungsi membuat kebocoran satu kunci merusak ketiganya sekaligus.

| Kunci | Variabel | Algoritma | Fungsi | Boleh dirotasi |
| --- | --- | --- | --- | --- |
| `K_token` | `PSEUDONYM_HMAC_SECRET` | HMAC-SHA256, 256 bit | Membangkitkan nilai pseudonim | Ya, token lama tetap valid karena nilainya tersimpan di mapping |
| `K_index` | `BLIND_INDEX_SECRET` | HMAC-SHA256, 256 bit | Menghitung `subject_lookup` | Tidak diimplementasikan; prosedur tertulis di bawah |
| `K_field` | `FIELD_ENCRYPTION_KEY` | AES-256-GCM | Mengenkripsi kolom brankas identitas dan `subject_id_enc` | Ya, lewat enkripsi ulang bertahap per `key_version` |

#### Blind index

```latex
\text{subject\_lookup} = \text{HMAC-SHA256}\big(K_{index},\; \text{subject\_type} \,\|\, \text{subject\_id}\big)
```

Nilainya deterministik, tanpa `nonce`, karena fungsinya memang sebagai kunci pencarian pada STEP 1 penerbitan. Dua catatan yang harus kamu tulis di naskah. Pertama, `subject_lookup` sendiri adalah pseudonim statis internal, dan itulah harga yang dibayar agar pencarian tetap mungkin di atas kolom terenkripsi. Kedua, nilai ini tidak pernah keluar dari Privacy Service dan tidak pernah masuk audit log.

#### Enkripsi field

```
subject_id_enc = key_version || IV(12 byte acak) || ciphertext || tag(16 byte)
AAD            = subject_type
```

IV dibangkitkan acak pada setiap penulisan, sehingga dua baris dengan subjek sama menghasilkan ciphertext berbeda. Inilah sebabnya pencarian memerlukan `subject_lookup`. `subject_type` dipakai sebagai *additional authenticated data*, agar ciphertext milik satu jenis subjek tidak dapat dipindahkan ke jenis lain.

#### Brankas identitas

Brankas memakai `K_field` yang sama dengan format di atas, dengan AAD = nama kolom, sehingga ciphertext NIK tidak dapat dipindahkan ke kolom nama. Barisnya dicari lewat `customer_lookup` = HMAC(`K_index`, CUSTOMER ‖ `customer_id`), nilai yang sama dengan `subject_lookup` pada baris mapping CUSTOMER. Karena itu pembukaan dari token cukup mengikuti lookup itu tanpa menyimpan `customer_id` dalam bentuk jelas.

#### Prosedur rotasi

| Langkah | Tindakan | Dampak pada token berjalan |
| --- | --- | --- |
| 1 | Naikkan `PSEUDONYM_KEY_VERSION`, pasang kunci baru sebagai kunci tulis | Tidak ada; token lama dibaca dari mapping, bukan dihitung ulang |
| 2 | Enkripsi ulang `subject_id_enc` bertahap dengan `K_field` baru, perbarui `key_version` per baris | Tidak ada; dilakukan per batch |
| 3 | Verifikasi tidak ada baris tersisa dengan `key_version` lama | — |
| 4 | Cabut kunci lama | — |

Seluruh prosedur rotasi pada bagian ini bersifat tertulis. Yang diimplementasikan pada prototipe hanya kolom `key_version` dan pembacaan versi kunci saat mendekripsi.

#### Rotasi K\_index (prosedur tertulis, tidak diimplementasikan)

Rotasi `K_index` lebih berat daripada kunci lain, karena mengubahnya mengubah nilai `subject_lookup` pada seluruh baris. Prosedurnya mengikuti pola rotasi tanpa downtime yang lazim pada pustaka blind index: menambah kolom baru, mengisi ulang, lalu berpindah.

1. Tambah kolom `subject_lookup_v2` beserta indeks unik parsial `WHERE status = 'active'` untuk kolom itu.
2. Selama transisi, penerbitan baru menulis ke kedua kolom, dan pencarian mencoba kolom baru lebih dulu lalu kolom lama.
3. Job pengisian ulang membuka `subject_id_enc` pada baris yang belum dikosongkan, menghitung `subject_lookup_v2`, dan menyimpannya. Baris yang sudah dikosongkan oleh retensi tidak perlu diisi ulang karena tidak akan dicari lagi.
4. Setelah tidak ada baris aktif tersisa tanpa `subject_lookup_v2`, pencarian hanya memakai kolom baru.
5. Cabut `K_index` lama, lalu hapus kolom lama pada migrasi berikutnya.

Alasan tidak diimplementasikan: fokus pengujian ada pada konteks, TTL, dan overhead, bukan siklus kunci. Jika pembimbing meminta bukti, langkah 1 sampai 5 dapat ditambahkan tanpa mengubah skema selain satu kolom.

#### Pencabutan per subjek

Pencabutan per token saja tidak cukup untuk menunjukkan pemenuhan hak penghapusan, karena satu subjek memegang banyak token di banyak layanan.

```
FUNGSI revoke_subject(subject_type, subject_id, actor_id):
  STEP 1  lookup = HMAC(K_index, subject_type || subject_id)
  STEP 2  tandai SEMUA baris aktif dengan subject_lookup ini menjadi 'revoked',
            isi revoked_at = sekarang
  STEP 3  catat satu baris audit REVOKE_SUBJECT per baris yang dicabut,
            dengan mapping_id masing-masing
  STEP 4  JIKA subject_type = 'CUSTOMER': kosongkan baris brankas dengan customer_lookup = lookup, isi purged_at, catat satu baris audit PURGE_IDENTITY
  STEP 5  KEMBALIKAN jumlah token yang dicabut
```

Ini keunggulan desain yang perlu kamu tonjolkan. Pada mode baseline, penghapusan identitas berarti mengejar salinan di lima basis data dan sulit diverifikasi. Pada rancangan ini, satu operasi memutus seluruh token sekaligus, dan jumlah token yang dicabut menjadi bukti yang dapat diaudit.

Perhatikan bahwa pencabutan tidak menghapus baris mapping, hanya mengubah statusnya. Baris tetap disimpan selama masa retensi audit karena `audit_log.mapping_id` merujuknya. Penghapusan fisik baru dilakukan setelah masa retensi berakhir, dan itu perlu ditulis sebagai kebijakan tersendiri.

#### Retensi dan pengosongan identitas

Retensi memakai satu parameter, `RETENTION_DAYS` = 90. Angka ini ditetapkan sendiri untuk penelitian ini, bukan standar, dan harus dinyatakan demikian di naskah. Job retensi berjalan harian dalam dua langkah: menandai baris aktif yang sudah lewat TTL sebagai `expired`, lalu mengosongkan kolom identitas pada baris yang sudah tidak berlaku selama sedikitnya `RETENTION_DAYS`.

```sql
-- Langkah 1: tandai baris aktif yang sudah lewat TTL dan grace period
UPDATE pseudonym_mapping
   SET status = 'expired'
 WHERE status = 'active'
   AND expires_at + interval '30 seconds' < now();

-- Langkah 2: kosongkan identitas pada baris yang sudah tidak berlaku lama
UPDATE pseudonym_mapping
   SET subject_id_enc = NULL,
       subject_lookup = NULL,
       purged_at      = now()
 WHERE purged_at IS NULL
   AND status IN ('expired', 'revoked')
   AND COALESCE(revoked_at, expires_at) < now() - make_interval(days => :retention_days);
```

Setelah pengosongan:

1. Baris mapping tetap ada, sehingga `mapping_id` pada `audit_log` tetap valid.
2. Identitas tidak dapat dibuka lagi. `de_pseudonymize` dan `generate_from_transaction` mengembalikan `TOKEN_NOT_FOUND` untuk baris yang `purged_at`-nya terisi.
3. Job mencatat satu baris audit `PURGE_IDENTITY` per baris yang dikosongkan, dengan `actor_id` = SYSTEM.
4. Penghapusan fisik baris mapping dan `audit_log` berada di luar cakupan prototipe.

Konsekuensi untuk klaim skripsi: pengosongan ini adalah bukti nyata minimisasi data, yaitu identitas hilang dari seluruh sistem setelah tujuannya tercapai. Buktinya dapat diperiksa dengan satu query: tidak boleh ada baris berstatus tidak berlaku yang lebih tua dari `RETENTION_DAYS` dan masih memiliki `subject_id_enc`.

Brankas identitas tidak ikut job retensi 90 hari, karena isinya dibutuhkan selama akun masih aktif (kewajiban KYC e-wallet). Isinya dikosongkan oleh `revoke_subject` saat akun ditutup atau subjek meminta penghapusan, dan tercatat sebagai `PURGE_IDENTITY`.

#### Yang harus final sebelum koding

| Keputusan | Nilai | Konsekuensi jika diubah setelah koding |
| --- | --- | --- |
| Tujuh baris konteks pada Tabel 1 | Final | Policy Engine, uji keamanan, dan skenario Bab IV ikut berubah |
| Dua baris pertukaran pada Tabel 2 | Final | Alur orkestrasi Transaction berubah |
| Daftar purpose | Enam nilai | Migrasi data mapping |
| Panjang pseudonim | 8 heksadesimal + awalan `PSEU-` | Migrasi kolom di seluruh basis data hilir |
| Kunci penggunaan ulang token | Subjek, layanan, purpose | Jumlah baris mapping dan hasil pengukuran berubah |
| Pemisahan tiga kunci | Final | Enkripsi ulang seluruh mapping |
| Grace period | 30 detik | Hasil uji TF-04 berubah |
| Masa retensi identitas | 90 hari (RETENTION\_DAYS), kolom identitas dikosongkan | Hasil uji retensi dan klaim minimisasi berubah |
| Rotasi K\_index | Prosedur tertulis, tidak diimplementasikan | Jika ditingkatkan: satu kolom, job pengisian ulang, dan uji cutover |
| Atribut brankas yang boleh dibuka per konteks (Tabel 5) | P7: customer\_id, NIK, nama; konteks lain tidak ada | Kontrak /de-pseudonymize dan kasus uji TK-20, TK-21 berubah |

## 7. Algoritma lengkap

Lima operasi inti. Semuanya berjalan di Privacy Service dan semuanya menulis ke audit log, baik berhasil maupun ditolak.

#### Fungsi bantu

Dua fungsi dipakai oleh semua algoritma di bawah. Keduanya hanya membaca kebijakan pada Bagian 6.1, tidak menyimpan aturan sendiri.

```
FUNGSI status_efektif(m):
  JIKA m.status = 'revoked'                       -> 'revoked'
  JIKA m.status = 'expired'                       -> 'expired'      // lewat TTL saat penerbitan baru, atau hasil re-issue
  JIKA sekarang > m.expires_at + GRACE            -> 'expired'
  JIKA sekarang > m.expires_at                    -> 'grace'
  KEMBALIKAN 'active'

FUNGSI policy_evaluate(requesting_service, target_service, purpose, subject_type, cara):
  baris = Tabel1.cari(target_service, purpose, subject_type)
  JIKA baris tidak ada                            -> tolak POLICY_NOT_ALLOWED
  JIKA cara tidak sah untuk baris itu             -> tolak POLICY_NOT_ALLOWED   // kolom 'cara terbit' dan Tabel 3
  JIKA requesting_service bukan pemanggil sah     -> tolak POLICY_NOT_ALLOWED   // Tabel 3
  KEMBALIKAN baris                                 // memuat ttl_detik dan boleh_dibuka
```

Nilai `cara` adalah salah satu dari `dari identitas`, `dari transaksi`, `pertukaran`, atau `re-issue`. Untuk `re-issue`, konteks yang sah adalah P1 dan P2 sesuai baris RE\_ISSUE pada Tabel 3.

### 7.1 generate\_token — penerbitan dari identitas asli

`generate_token` dipanggil oleh Gateway untuk konteks P1, P2, P5, dan P6, satu-satunya pemanggil yang boleh menyerahkan `subject_id`. Reconciliation tidak memakainya langsung; ia memakai `generate_from_transaction` (Bagian 6.1). Kedua operasi publik itu, bersama `exchange_token` dan `re_issue`, memanggil fungsi inti `buat_token` yang memuat penandaan kedaluwarsa, penggunaan ulang, pembangkitan, dan penyimpanan.

```
FUNGSI buat_token(subject_type, subject_id, target_service, purpose, transaction_id, requesting_service, policy):
  // fungsi inti; berjalan di dalam SATU transaksi basis data; pemanggil yang mencatat audit
  STEP 1  lookup = HMAC(K_index, subject_type | subject_id)
          KUNCI baris (lookup, target_service, purpose) untuk update          // SELECT ... FOR UPDATE

          // tandai baris aktif yang sudah lewat TTL sebelum mencari atau menyisipkan;
          // tanpa ini indeks unik parsial memblokir INSERT setelah TTL habis
          UPDATE pseudonym_mapping SET status = 'expired'
           WHERE subject_lookup = lookup AND service_id = target_service AND purpose = purpose
             AND status = 'active' AND expires_at < sekarang

          cari baris dengan (lookup, target_service, purpose) DAN status = 'active'
          JIKA ditemukan:
            KEMBALIKAN { baris tersebut, reused: true }                     // idempoten dalam jendela TTL

  STEP 2  nonce     = uuid_v4()
          pseudonym = 'PSEU-' + upper(potong_8(HMAC_SHA256(K_token,
                        subject_type | subject_id | target_service | purpose | nonce)))

  STEP 3  expires_at = sekarang + policy.ttl_detik

  STEP 4  INSERT pseudonym_mapping(subject_type, enkripsi(subject_id), lookup, pseudonym,
            target_service, purpose, transaction_id, key_version, created_at, expires_at,
            status = 'active')
          JIKA pelanggaran unique pada kolom pseudonym: ulangi dari STEP 2

  STEP 5  KEMBALIKAN { pseudonym, expires_at, mapping_id, reused: false }

FUNGSI generate_token(subject_type, subject_id, target_service, purpose, transaction_id, requesting_service):
  // penerbitan dari identitas asli; hanya Gateway
  STEP 0  policy = policy_evaluate(requesting_service, target_service, purpose, subject_type, 'dari identitas')
          JIKA ditolak:
            catat_audit(GENERATE_TOKEN, DENIED, POLICY_NOT_ALLOWED, ...)
            KEMBALIKAN error 403
  STEP 1  hasil = buat_token(subject_type, subject_id, target_service, purpose,
                             transaction_id, requesting_service, policy)
  STEP 2  catat_audit(GENERATE_TOKEN, SUCCESS, hasil.reused ? 'REUSED_ACTIVE' : 'OK', hasil.mapping_id, ...)
          KEMBALIKAN hasil
```

### 7.2 exchange\_token — pertukaran token antar-layanan

Ini perubahan terpenting dari PRD v1. Layanan hilir tidak pernah memegang `subject_id`; ia menyerahkan token miliknya. Pemeriksaan matriks pertukaran (Tabel 2) dipecah dua: pasangan pemanggil dan tujuan diperiksa di STEP 0 sebelum token apa pun dibaca, sedangkan jenis subjek dan konteks sumber diperiksa di STEP 2 setelah token terbukti milik pemanggil.

```
FUNGSI exchange_token(source_pseudonym, target_service, target_purpose, transaction_id, requesting_service):
  STEP 0  JIKA (requesting_service, target_service, target_purpose) tidak ada pada Tabel 2:
            catat_audit(EXCHANGE_TOKEN, DENIED, POLICY_NOT_ALLOWED, ...); KEMBALIKAN error 403

  STEP 1  src = cari_mapping(source_pseudonym)
          JIKA tidak ada:                              audit DENIED TOKEN_NOT_FOUND;  error 404
          JIKA src.service_id != requesting_service:   audit DENIED SERVICE_MISMATCH; error 403
          st = status_efektif(src)
          JIKA st = 'revoked':                         audit DENIED REVOKED;          error 403
          JIKA st = 'expired':                         audit DENIED EXPIRED;          error 410

  STEP 2  JIKA (src.service_id, src.purpose, src.subject_type) bukan konteks sumber
            pada baris Tabel 2 yang cocok dengan STEP 0:
            audit DENIED POLICY_NOT_ALLOWED; error 403
          policy = policy_evaluate(requesting_service, target_service, target_purpose,
                                   src.subject_type, 'pertukaran')
          JIKA ditolak: audit DENIED POLICY_NOT_ALLOWED; error 403

  STEP 3  subject = dekripsi_subjek(src)                // internal, tidak keluar
          hasil = buat_token(subject.type, subject.id, target_service, target_purpose,
                             transaction_id, requesting_service, policy)

  STEP 4  catat_audit(EXCHANGE_TOKEN, SUCCESS, hasil.reused ? 'REUSED_ACTIVE' : 'OK', hasil.mapping_id, ...)
          KEMBALIKAN hasil
```

&#91;embedded content: flowchart · exchange\_token, 6 checks\]

Diagram alir exchange\_token. Setiap penolakan berakhir pada satu sink yang sama: baris audit ditulis, klien hanya melihat `ACCESS_DENIED`.

Konsekuensinya, layanan pemanggil sempat memegang dua token domain berbeda sekaligus. Ini aman selama ia tidak menyimpan atau mencatat token domain lain. Cantumkan sebagai keterbatasan di naskah.

### 7.3 resolve\_domain\_pseudonym — penerjemahan ke pseudonim domain

Dipanggil Notification setiap kali mengirim notifikasi. Hasilnya pseudonim domain, bukan identitas asli, sehingga operasinya dinamai terpisah dari de-pseudonimisasi.

```
FUNGSI resolve_domain_pseudonym(notif_token, requesting_service):
  STEP 0  JIKA requesting_service != 'NOTIFICATION':           // Tabel 3
            audit DENIED POLICY_NOT_ALLOWED; error 403

  STEP 1  m = cari_mapping(notif_token)
          JIKA tidak ada:                                      audit DENIED TOKEN_NOT_FOUND;   error 404
          JIKA m.service_id != requesting_service:             audit DENIED SERVICE_MISMATCH;  error 403
          JIKA m.purpose != 'NOTIFICATION':                    audit DENIED PURPOSE_MISMATCH;  error 403
          st = status_efektif(m)
          JIKA st = 'revoked':                                 audit DENIED REVOKED;           error 403
          JIKA st = 'expired':                                 audit DENIED EXPIRED;           error 410

  STEP 2  subject = dekripsi_subjek(m)
  STEP 3  domain = cari_mapping_aktif(subject, 'NOTIFICATION', 'NOTIFICATION_REGISTRATION')
          JIKA tidak ada: audit DENIED TOKEN_NOT_FOUND; error 404

  STEP 4  catat_audit(RESOLVE_NOTIF_DOMAIN, SUCCESS, OK, m.id, ...)
          KEMBALIKAN domain.pseudonym        // bukan subject_id
```

### 7.4 de\_pseudonymize — pembukaan identitas asli

Satu-satunya jalan identitas asli keluar dari Privacy Service, dan hanya dipakai pada pembukaan bersyarat yang sudah disetujui admin lain. Lima gerbang berurutan; GATE 5 memeriksa permintaan pembukaan.

```
FUNGSI de_pseudonymize(pseudonym, purpose_diminta, requesting_service, actor_id, peran, disclosure_id):
  GATE 1  m = cari_mapping(pseudonym)
          JIKA tidak ada                                  -> DENIED TOKEN_NOT_FOUND   404
  GATE 2  JIKA m.service_id != requesting_service         -> DENIED SERVICE_MISMATCH  403
  GATE 3  JIKA m.purpose != purpose_diminta               -> DENIED PURPOSE_MISMATCH  403
  GATE 4  st = status_efektif(m)
          JIKA st = 'revoked'                             -> DENIED REVOKED           403
          JIKA st = 'expired'                             -> DENIED EXPIRED           410

  GATE 5  d = cari_disclosure(disclosure_id)
          JIKA d tidak ada atau d.mapping_id != m.id      -> DENIED DISCLOSURE_NOT_FOUND    404
          JIKA d.status != 'APPROVED'                     -> DENIED DISCLOSURE_NOT_APPROVED 403
          JIKA sekarang > d.expires_at                    -> DENIED DISCLOSURE_EXPIRED      410
          JIKA d.requester_id != actor_id                 -> DENIED REQUESTER_MISMATCH      403

  SYARAT TAMBAHAN
          JIKA Tabel1.cari(m.service_id, m.purpose, m.subject_type).boleh_dibuka = false
                                                          -> DENIED POLICY_NOT_ALLOWED 403
          JIKA peran bukan 'auditor'                      -> DENIED FORBIDDEN_ROLE     403

  LOLOS   subject_id = dekripsi_subjek(m)
          atribut    = buka_brankas(m.subject_lookup, Tabel5.atribut(m.service_id, m.purpose) ∩ d.requested_attrs)
          tandai_dipakai(d)   -- status APPROVED -> USED, used_at = sekarang
          catat_audit(DE_PSEUDONYMIZE, SUCCESS, OK, m.id, actor_id, d.id, nama_atribut, ...)   -- nama atribut, bukan nilainya
          KEMBALIKAN { atribut }   -- customer_id ikut hanya bila termasuk atribut yang disetujui
```

&#91;embedded content: flowchart · de\_pseudonymize, 7 checks termasuk persetujuan pihak kedua\]

Diagram alir de\_pseudonymize (v2.4: pemeriksaan persetujuan admin lain ditambahkan setelah status token). Urutan pemeriksaan tetap, dan kegagalan pertama menghentikan proses.

`buka_brankas` hanya mendekripsi kolom brankas yang tercantum di Tabel 5 untuk konteks token itu dan disetujui pada permintaan pembukaannya; kolom lain tetap berupa ciphertext di memori dan di basis data.

Perhatikan urutannya: gerbang dijalankan berurutan dan berhenti pada kegagalan pertama, sehingga pesan error tidak membocorkan apakah token itu ada. Semua respons gagal memakai bentuk yang seragam.

#### Audit berbasis pseudonim dan pembukaan identitas bersyarat (v2.4)

Audit rutin tidak membuka identitas sama sekali; auditor bekerja dengan token P7, data transaksi, dan audit log. Alasannya, data yang sudah dipseudonimkan menjadi percuma bila audit justru membuka identitas setiap kali (masukan dosen pembimbing, 13 Oktober 2026).

Pembukaan identitas hanya lewat alur bersyarat berikut:

1. Auditor mengajukan `POST /disclosure-requests` dengan token P7, dasar dari Tabel 6, nomor kasus, dan atribut yang diminta (bagian dari `customer_id`, NIK, nama). Status PENDING, tercatat `DISCLOSURE_REQUESTED`.
2. Admin yang bukan pemohon menyetujui atau menolak. Persetujuan berlaku 600 detik dan sekali pakai; tercatat `DISCLOSURE_APPROVED` atau `DISCLOSURE_REJECTED`. Persetujuan oleh pemohon sendiri ditolak `403 SELF_APPROVAL`.
3. Reconciliation memanggil `/de-pseudonymize` dengan `disclosure_id`. GATE 5 memeriksa status APPROVED, belum dipakai, belum kedaluwarsa, dan pemohon yang sama.
4. Hanya atribut yang disetujui yang dikembalikan; status menjadi USED. Audit log mencatat nama atributnya, bukan nilainya.

Pola ini mengikuti pseudonimisasi data audit dengan reidentifikasi bersyarat (Flegel, 2005) dan pembukaan pseudonim yang memerlukan lebih dari satu pihak (Petersen, PET-CON 2018). Keduanya baru dibaca dari slide presentasi, jadi cek naskah lengkapnya sebelum dikutip. Skema threshold kriptografi seperti pada Petersen tidak diimplementasikan dan dicatat sebagai pengembangan lanjutan.

### 7.5 re\_issue — penerbitan ulang otomatis

```
FUNGSI re_issue(pseudonym_lama, transaction_id, requesting_service):
  STEP 1  m = cari_mapping(pseudonym_lama)
          JIKA tidak ada:                             audit DENIED TOKEN_NOT_FOUND;  error 404
          JIKA m.service_id != requesting_service:    audit DENIED SERVICE_MISMATCH; error 403
          policy = policy_evaluate(requesting_service, m.service_id, m.purpose,
                                   m.subject_type, 're-issue')      // hanya P1 dan P2, oleh TRANSACTION
          JIKA ditolak:                               audit DENIED POLICY_NOT_ALLOWED; error 403
          JIKA status_efektif(m) = 'revoked':         audit DENIED REVOKED;          error 403

  STEP 2  st = status_transaksi(transaction_id)
          JIKA st DALAM {COMPLETED, FAILED, CANCELLED}:
            audit DENIED TX_TERMINAL; error 409
            // transaksi sudah selesai, tidak ada alasan sah menerbitkan ulang

  STEP 3  tandai m.status = 'expired'
  STEP 4  baru = buat_token(m.subject_type, dekripsi_subjek(m), m.service_id, m.purpose,
                            transaction_id, requesting_service, policy)
  STEP 5  catat_audit(RE_ISSUE, SUCCESS, OK, baru.mapping_id, ...)
          KEMBALIKAN baru
```

Re-issue tidak membuka celah privasi karena tiga alasan. Pertama, ia tidak mengubah layanan dan tujuan token. Kedua, ia hanya berlaku pada transaksi yang belum terminal. Ketiga, token lama ditandai `expired`, bukan dihapus, sehingga jejaknya tetap dapat diaudit.

### 7.6 Penanganan kasus khusus

| Kasus | Perilaku yang dirancang |
| --- | --- |
| Dua permintaan bersamaan untuk kombinasi yang sama | Transaksi basis data dengan `SELECT ... FOR UPDATE` pada kunci kombinasi; pemenang menerbitkan, yang kalah menerima `REUSED_ACTIVE` |
| Tabrakan nilai pseudonym | Unique constraint menolak, algoritma mengulang dari pembangkitan nonce |
| Privacy Service tidak tersedia | Layanan hilir gagal cepat dengan 503; transaksi ditandai `FAILED`. Tidak ada fallback ke data mentah, karena fallback semacam itu membatalkan seluruh jaminan privasi |
| Secret HMAC bocor | Penyerang dapat menghitung token, tetapi tidak dapat membalik token menjadi identitas tanpa mapping table. Mitigasinya rotasi `key_version` dan enkripsi kolom subjek |
| Jam server tidak sinkron | Grace period 30 detik meredam selisih kecil; seluruh kontainer memakai UTC |
| Token dipakai setelah transaksi selesai | Ditolak `TX_TERMINAL` pada re-issue, dan `EXPIRED` pada pemakaian biasa |
| Baris aktif yang sudah lewat TTL | Ditandai expired di awal buat\_token (STEP 1), dalam transaksi yang sama dengan penerbitan, agar indeks unik parsial tidak memblokir INSERT |

## 8. TTL dan siklus hidup token

&#91;embedded content: siklus hidup token · 5 status, 1 jalur pemulihan\]

Status disimpan sebagai kolom, tetapi tidak diperbarui oleh job penyapu per detik. Pembaruan dilakukan secara malas: pada awal setiap penerbitan token, baris aktif untuk konteks yang sama yang sudah lewat `expires_at` ditandai `expired` dalam transaksi yang sama (Bagian 7.1, STEP 1), dan job harian retensi menandai sisanya. Untuk membaca dipakai status efektif, yang menggabungkan kolom `status`, `expires_at`, dan grace period (fungsi `status_efektif` pada Bagian 7). Tanpa penandaan malas ini, indeks unik parsial `WHERE status = 'active'` akan memblokir penerbitan token baru untuk konteks yang sama setelah TTL habis.

### Penentuan TTL per tujuan

| purpose | TTL | Alasan bisnis |
| --- | --- | --- |
| PAYMENT\_PROCESSING | 900 detik | Durasi wajar satu transaksi QRIS termasuk retry dan konfirmasi |
| FRAUD\_DETECTION | 2.592.000 detik (30 hari) | Fraud membangun profil perilaku (rata-rata nominal dan lokasi terakhir) dari asesmen sebelumnya, sehingga token harus bertahan selama jendela profil. Ini keputusan desain yang disengaja, dan jendela keterkaitan di Fraud menjadi 30 hari |
| NOTIFICATION | 900 detik | Notifikasi dikirim segera setelah transaksi selesai |
| NOTIFICATION\_REGISTRATION | 31.536.000 detik (365 hari) | Pseudonim domain harus stabil karena menjadi kunci `contact_registry` |
| DAILY\_RECONCILIATION | 86.400 detik | Satu siklus batch harian |
| INTERNAL\_AUDIT | 600 detik | Jendela sesempit mungkin untuk satu-satunya jalur pembukaan identitas |

TTL ditetapkan dari SLA proses bisnis, bukan dari angka yang disamakan. Perbedaan antar-purpose inilah yang membuat jendela keterkaitan berbeda per layanan, dan itu perlu kamu sebut sebagai keputusan desain. Nilai sumbernya adalah kolom TTL pada Tabel 1 (Bagian 6.1); tabel ini hanya memberi alasan.

### Grace period

Grace period adalah 30 detik setelah `expires_at`. Dalam jendela ini token masih diterima untuk operasi yang sedang berjalan, tetapi tidak untuk penerbitan baru. Tujuannya meredam selisih jam antar-kontainer dan latensi jaringan, bukan memperpanjang masa berlaku.

### Tiga kondisi yang dibandingkan di Bab IV

| Kondisi | Bentuk identitas di layanan hilir | Linkability lintas layanan | Linkability lintas waktu |
| --- | --- | --- | --- |
| Baseline | `customer_id` asli | Penuh | Penuh |
| Pseudonim statis (HMAC tanpa konteks) | Satu hash tetap | Penuh, karena hash sama di semua layanan | Penuh, karena hash tidak pernah berubah |
| Pseudonim dinamis (rancangan ini) | Token berbeda per layanan dan tujuan | Tidak, kecuali lewat Privacy Service | Terbatas pada jendela TTL |

Baris ketiga adalah klaim utama skripsimu. Kolom terakhir juga memuat pengakuan jujurnya: dalam satu jendela TTL, token digunakan ulang, sehingga keterkaitan masih mungkin. Itulah sebabnya teknik ini disebut semi-dinamis.

## 9. Pemetaan alur antar-service

Lima alur, memakai pelanggan dan transaksi fiktif di Bagian 16. Bab Metodologi v6 menomori aliran data dengan kode DF1 sampai DF19; padanannya dengan kode langkah di bagian ini: DF1 = A1 dan B1; DF2 = A2 dan B2; DF3 = A3, A5, dan B3; DF4 = penyimpanan pemetaan; DF5 = brankas identitas (A5); DF6 = audit log; DF7 = B4; DF8 = A4; DF9 = B6, B7, dan C1; DF10 = C2; DF11 = B8; DF12 = B9; DF13 = B10; DF14 = D1; DF15 dan DF16 = D3; DF17 = D2, E2, dan E3; DF18 = E1, E4, dan C4; DF19 = penyimpanan akun Keycloak. Langkah C4 (peninjauan Fraud Analyst) dan D3 (laporan settlement bank) tetap bagian dari rancangan, tetapi tidak dievaluasi pada Bab Metodologi v6. Kolom terakhir menjawab pertanyaan utama: **mentah** berarti data asli ikut dikirim, **token** berarti sudah diganti pseudonim, **tidak dikirim** berarti dibuang di Gateway karena layanan tujuan tidak membutuhkannya.

### Diagram aliran data (DFD)

&#91;embedded content: DFD level 0 · 1 process, 4 external entities\]

Level 0 menunjukkan batas sistem: identitas mentah hanya masuk dari nasabah dan auditor, dan hanya nomor HP yang keluar ke pihak luar.

&#91;embedded content: DFD level 1 · 6 processes, 5 data stores\]

Level 1 menguraikan platform menjadi enam proses. Hanya proses 2.0 yang dapat memetakan token kembali ke identitas. Basis data milik proses 2.0 (mapping, status transaksi, audit log) digambar pada diagram arsitektur di Bagian 5 dan skema di Bagian 11. Satu-satunya store proses 2.0 yang ditampilkan di sini adalah D7 identity\_vault, karena hanya store inilah yang menyimpan NIK, nama, HP, dan rekening (terenkripsi) sejak pendaftaran A5.

### A. Pendaftaran akun, sekali per pelanggan

| # | Dari → Ke | Aksi | Dikirim | Diterima | Perlakuan |
| --- | --- | --- | --- | --- | --- |
| A1 | Klien → Gateway | Daftar akun | NIK, nama, HP, email, nomor rekening | Konfirmasi | Semua mentah; Gateway tidak menyimpan dan tidak mencatat body request |
| A2 | Gateway → Auth | Buat pengguna | Email, username, password | `customer_id` CUST-000101 | Mentah di Keycloak, di luar cakupan pseudonimisasi |
| A3 | Gateway → Privacy | `POST /pseudonymize` | `customer_id`, purpose NOTIFICATION\_REGISTRATION, TTL 365 hari | PSEU-C3A91F55 + `expires_at` | `customer_id` mentah hanya ke Privacy; keluarannya token |
| A4 | Gateway → Notification | `POST /notification/register` | `notification_domain_id`, nomor HP, preferensi kanal | 201 Created | HP mentah, pengecualian disengaja; NIK, nama, email, rekening tidak dikirim |
| A5 | Gateway → Privacy | POST /identity | customer\_id, NIK, nama, HP, nomor rekening | 201 Created | Mentah hanya ke Privacy; disimpan terenkripsi per kolom di brankas identitas dan tidak diteruskan ke layanan lain. Email tidak ikut karena sudah ada di Keycloak |

### B. Transaksi normal, TX-10001

| # | Dari → Ke | Aksi | Dikirim | Diterima | Perlakuan |
| --- | --- | --- | --- | --- | --- |
| B1 | Klien → Gateway | `POST /transaction` + JWT | Rekening sumber, merchant QRIS, nominal, geohash | `transaction_id`, status | Mentah |
| B2 | Gateway → Auth | Validasi JWT | JWT | Valid + `customer_id` | Hanya JWT |
| B3 | Gateway → Privacy | `POST /pseudonymize` dua kali | `customer_id` dan nomor rekening; TRANSACTION, PAYMENT\_PROCESSING, TX-10001 | `customer_token` PSEU-8F29A7C1, `account_token` PSEU-71D92C0E | Mentah ke Privacy; keluarannya token |
| B4 | Gateway → Transaction | `POST /transaction` | `transaction_id`, `customer_token`, `account_token`, `merchant_id`, nominal, geohash | Status akhir setelah B5 sampai B10, diproses sinkron | Tidak dikirim: `customer_id`, rekening, NIK, nama, HP |
| B5 | Transaction (lokal) | Simulasi debit dan kredit (saldo tidak dimodelkan), PENDING → COMPLETED | — | — | Token dan nominal disimpan di transaction-db |
| B6 | Transaction → Privacy | `PATCH /transaction-status` | `transaction_id`, status COMPLETED | 200 | Tanpa identitas; menjadi dasar gerbang TX\_TERMINAL |
| B7 | Transaction → Privacy | `POST /pseudonymize` dengan `source_pseudonym` | PSEU-8F29A7C1; NOTIFICATION, NOTIFICATION, TX-10001 | `notif_token` PSEU-4FE1B3A9 | Transaction hanya menyerahkan token miliknya |
| B8 | Transaction → Notification | `POST /notification/send` | `notif_token`, template TX\_COMPLETED, nominal | 200 | Token, bukan HP |
| B9 | Notification → Privacy | `POST /resolve-domain` | `notif_token` | `notification_domain_id` PSEU-C3A91F55 | Hasilnya pseudonim domain, bukan identitas |
| B10 | Notification → penyedia SMS | Kirim SMS | HP dari `contact_registry` + teks | Status kirim | HP mentah hanya keluar ke penyedia SMS |
| B11 | Gateway → Klien | Respons | `transaction_id`, status | — | Tanpa PII |

&#91;embedded content: sequence diagram · flow B, normal transaction\]

Urutan panggilan alur B. Panah oranye hanya muncul pada dua pesan pertama, sesudahnya semua pesan membawa token.

### C. Transaksi mencurigakan, TX-10002

Langkah B1 sampai B5 sama. Setelah B5 alur bercabang karena nominal melewati ambang Rp1.000.000 dan waktunya di luar pukul 06.00 sampai 22.00.

| # | Dari → Ke | Aksi | Dikirim | Diterima | Perlakuan |
| --- | --- | --- | --- | --- | --- |
| C1 | Transaction → Privacy | `POST /pseudonymize` dengan `source_pseudonym` | PSEU-2B7E5D10; FRAUD, FRAUD\_DETECTION, TTL 2.592.000 | `fraud_token` PSEU-7BCD04F2 | Token berbeda dari token Transaction, tidak dapat ditautkan oleh Fraud |
| C2 | Transaction → Fraud | `POST /fraud/assess` | `fraud_token`, nominal, jam, geohash | `risk_score` 75, `decision` HOLD\_FOR\_VERIFICATION | Tanpa identitas; atribut risiko dikirim jelas |
| C3 | Transaction (lokal) | Status → HELD | — | — | Dilanjutkan B6 dengan status IN\_PROGRESS, lalu B7 sampai B10 dengan template TX\_HELD\_VERIFY; analis menyelesaikan transaksi pada C4 |
| C4 | Fraud Analyst → Gateway → Transaction | POST /transaction/{transaction\_id}/review | decision APPROVE atau REJECT, catatan | Status COMPLETED atau FAILED | Analis hanya melihat transaction\_id, nominal, skor, dan aturan terpicu; Transaction memperbarui status ke Privacy (B6) lalu mengirim notifikasi TX\_COMPLETED atau TX\_REJECTED |

Fraud tidak menerima umur akun maupun rata-rata historis dari Transaction. Fraud menghitung sendiri rata-rata nominal dan lokasi terakhir dari riwayat asesmen berkunci `fraud_token` miliknya di fraud-db. Transaction hanya mengirim nominal, jam, dan geohash, dan hanya bila nominal mencapai `FRAUD_AMOUNT_THRESHOLD`. Akibatnya profil Fraud hanya mencakup transaksi di atas ambang, dan profil terputus bila token berganti (cold start).

### D. Rekonsiliasi harian

| # | Dari → Ke | Aksi | Dikirim | Diterima | Perlakuan |
| --- | --- | --- | --- | --- | --- |
| D1 | Reconciliation → Transaction | Ambil transaksi COMPLETED per tanggal | Tanggal | Daftar `transaction_id`, nominal, `completed_at` | Tanpa token dan tanpa identitas; transaksi HELD tidak ikut |
| D2 | Reconciliation → Privacy | `POST /pseudonymize` per transaksi | `transaction_id`; RECONCILIATION, DAILY\_RECONCILIATION, TTL 86400 | `account_token` PSEU-B80D2C4F | Privacy menurunkan rekening dari baris mapping transaksi itu |
| D3 | Bank simulator → Gateway → Privacy → Reconciliation | POST /settlement/report; Gateway menokenisasi lalu POST /reconciliation/settlement-report | Nomor rekening, nominal, `bank_reference` | `account_token`, nominal, `bank_reference` | Gateway menokenisasi nomor rekening (konteks P6, dari identitas) sebelum meneruskan; tokennya sama dengan hasil D2 karena subjek, layanan, dan purpose sama |
| D4 | Reconciliation (lokal) | Cocokkan token, nominal, tanggal | — | `settlement_batches`, `settlement_items` | Token dan nominal saja |

### E. Audit internal dan administrasi

| # | Dari → Ke | Aksi | Dikirim | Diterima | Perlakuan |
| --- | --- | --- | --- | --- | --- |
| E1 | Auditor → Gateway → Reconciliation | `POST /reconciliation/audit-request` | `transaction_id`, alasan, JWT peran auditor | `request_id`, token P7, nominal, status (tanpa identitas) | Tanpa identitas pelanggan |
| E2 | Reconciliation → Privacy | `POST /pseudonymize` | `transaction_id`; RECONCILIATION, INTERNAL\_AUDIT, TTL 600 | PSEU-6C3F8A21 | Token 10 menit |
| E2a | Auditor → Gateway → Privacy | POST /disclosure-requests | Token P7, dasar (Tabel 6), nomor kasus, atribut diminta | disclosure\_id, status PENDING | Hanya bila identitas benar-benar dibutuhkan; tercatat DISCLOSURE\_REQUESTED |
| E2b | Admin → Gateway → Privacy | POST /disclosure-requests/{id}/approve | disclosure\_id, JWT peran admin | Status APPROVED, berlaku 600 detik, sekali pakai | Penyetuju harus bukan pemohon; tercatat DISCLOSURE\_APPROVED atau REJECTED |
| E3 | Reconciliation → Privacy | `POST /de-pseudonymize` | PSEU-6C3F8A21, purpose INTERNAL\_AUDIT, disclosure\_id berstatus APPROVED | Hanya atribut yang disetujui (contoh: nama), setelah lolos 5 gate | Hanya terjadi pada pembukaan bersyarat (setelah E2a dan E2b); satu-satunya titik identitas asli keluar; tidak disimpan di reconciliation-db |
| E4 | Admin atau Auditor → Privacy | `GET /audit-log`, `POST /pseudonym/{id}/revoke` | Filter, `mapping_id` | Baris log, konfirmasi | Log hanya berisi token dan `mapping_id` |

&#91;embedded content: sequence diagram · flow E, internal audit\]

Urutan alur E. Identitas asli kembali melalui tiga pesan dan tidak disimpan di reconciliation-db.

### Ringkasan paparan per layanan

| Layanan | Menerima | Tidak boleh melihat |
| --- | --- | --- |
| API Gateway | Data mentah, hanya dalam perjalanan | — |
| Privacy Service | `customer_id` dan rekening mentah; menyimpan mapping dan brankas identitas (NIK, nama, HP, rekening), keduanya terenkripsi | — |
| Transaction | `customer_token`, `account_token`, `merchant_id`, nominal, geohash | `customer_id`, NIK, nama, HP, rekening |
| Fraud | `fraud_token`, nominal, jam, geohash | Identitas apa pun, termasuk token milik layanan lain |
| Notification | `notification_domain_id`, nomor HP, `notif_token` per transaksi | NIK, nama, rekening |
| Reconciliation | `account_token`, nominal, tanggal, `bank_reference` | Identitas, kecuali pada jalur INTERNAL\_AUDIT |

NIK dan nama tidak muncul di tabel layanan hilir mana pun. Pengecualian yang tercatat hanya dua: nomor HP di Notification pada A4, dan `subject_id` beserta NIK dan nama yang dikembalikan saat audit pada E3. Keduanya perlu ditulis sebagai kasus yang benar-benar dibutuhkan di Bab III.

## 10. Spesifikasi API

Semua panggilan antar-layanan memakai HTTP dan JSON, diautentikasi dengan service account JWT dari Keycloak. `requesting_service` selalu diambil dari klaim JWT, tidak pernah dari body request. `target_service` dikirim di body dan divalidasi terhadap Tabel 1 (Bagian 6.1). Pemisahan ini mencegah layanan mengaku sebagai layanan lain.

### Daftar endpoint

| Endpoint | Metode | Pemanggil yang sah | Peran | Fungsi |
| --- | --- | --- | --- | --- |
| `/pseudonymize` | POST | Gateway (dari identitas), Reconciliation (dari transaksi), Transaction (pertukaran) | service | Terbitkan atau tukar token |
| `/resolve-domain` | POST | Notification | service | Terjemahkan `notif_token` ke pseudonim domain |
| `/de-pseudonymize` | POST | Reconciliation | service + auditor | Buka identitas asli |
| `/re-issue` | POST | Transaction | service | Terbitkan ulang token kedaluwarsa |
| `/pseudonym/{pseudonym}/revoke` | POST | Konsol admin | admin | Cabut satu token |
| `/subject/revoke` | POST | Konsol admin | admin | Cabut seluruh token satu subjek |
| `/transaction-status` | PATCH | Transaction | service | Perbarui status transaksi |
| `/audit-log` | GET | Konsol admin | auditor, admin | Baca audit log |
| `/audit-log/timeline/{pseudonym}` | GET | Konsol admin | auditor | Riwayat satu token |
| `/audit-log/summary` | GET | Konsol admin | auditor | Rekap DENIED per reason |
| `/transaction` | POST | Gateway | service | Proses transaksi |
| `/fraud/assess` | POST | Transaction | service | Nilai risiko |
| `/notification/register` | POST | Gateway | service | Daftarkan kontak |
| `/notification/send` | POST | Transaction | service | Kirim notifikasi |
| `/reconciliation/audit-request` | POST | Gateway | auditor | Minta audit transaksi; hasilnya token P7, tanpa identitas |
| /disclosure-requests | POST | Gateway | auditor | Ajukan pembukaan identitas bersyarat |
| /disclosure-requests/{id}/approve | POST | Gateway | admin (bukan pemohon) | Setujui permintaan pembukaan |
| /disclosure-requests/{id}/reject | POST | Gateway | admin | Tolak permintaan pembukaan |
| `/settlement/report` | POST | Bank simulator | bank | Terima laporan settlement berisi rekening mentah; Gateway menokenisasinya |
| `/reconciliation/settlement-report` | POST | Gateway | service | Terima laporan settlement yang sudah bertoken |
| `/health`, `/metrics` | GET | Internal | — | Kesehatan dan metrik |
| `/transaction/held` | GET | Gateway | fraud\_analyst | Daftar transaksi HELD tanpa identitas |
| `/transaction/{transaction_id}/review` | POST | Gateway | fraud\_analyst | Setujui atau tolak transaksi HELD |
| `/reconciliation/run` | POST | Penjadwal internal, konsol admin | admin | Jalankan rekonsiliasi untuk satu tanggal |
| /identity | POST | Gateway | service | Simpan atribut identitas pendaftaran ke brankas identitas |

### Kontrak inti

`POST /pseudonymize` menerima salah satu dari tiga bentuk, dan hanya satu.

```json
// Bentuk 1 — penerbitan dari identitas asli. Hanya Gateway.
{
  "subject_type": "CUSTOMER",
  "subject_id": "CUST-000101",
  "target_service": "TRANSACTION",
  "purpose": "PAYMENT_PROCESSING",
  "transaction_id": "TX-10001"
}

// Bentuk 2 — pertukaran token. Hanya Transaction (Tabel 2).
{
  "source_pseudonym": "PSEU-8F29A7C1",
  "target_service": "NOTIFICATION",
  "purpose": "NOTIFICATION",
  "transaction_id": "TX-10001"
}

// Bentuk 3 — penerbitan dari transaksi. Hanya Reconciliation (P6 dan P7).
{
  "subject_type": "ACCOUNT",
  "transaction_id": "TX-10001",
  "target_service": "RECONCILIATION",
  "purpose": "DAILY_RECONCILIATION"
}

// Respons 200, sama untuk ketiga bentuk
{
  "pseudonym": "PSEU-4FE1B3A9",
  "expires_at": "2026-10-05T12:20:04Z",
  "reused": false
}
```

Permintaan yang memuat `subject_id` dari layanan selain Gateway ditolak 403 dengan `POLICY_NOT_ALLOWED`. Aturan inilah yang memaksa alur v2 dan menutup celah PRD v1. Setiap bentuk hanya sah untuk pemanggil yang tercantum pada Tabel 3 (Bagian 6.1).

```json
// POST /de-pseudonymize — permintaan
{ "pseudonym": "PSEU-6C3F8A21", "purpose": "INTERNAL_AUDIT" }

// Respons 200
{ "subject_type": "CUSTOMER", "subject_id": "CUST-000102", "mapping_id": "m19",
  "attributes": { "nik": "3273012203880002", "nama": "Budi Santoso" } }
// atribut mengikuti Tabel 5; HP dan rekening tidak pernah dikembalikan

// Respons gagal, bentuk seragam untuk semua kegagalan
{ "error": "ACCESS_DENIED", "reason": "PURPOSE_MISMATCH", "audit_id": "a19" }
```

```json
// POST /fraud/assess — permintaan
{
  "pseudonym": "PSEU-7BCD04F2",
  "amount": 8000000,
  "tx_hour": 2,
  "geohash": "qqt8h"
}

// Respons 200
{
  "risk_score": 75.00,
  "decision": "HOLD_FOR_VERIFICATION",
  "rules_fired": ["AMOUNT_OVER_THRESHOLD", "AMOUNT_OVER_3X_AVG", "ODD_HOUR_OUTSIDE_06_22", "NEW_LOCATION_VS_LAST_3"],
  "rules_skipped": [],
  "prior_count": 1
}
```

```json
// POST /settlement/report — dari Bank simulator ke Gateway (rekening mentah)
{
  "batch_date": "2026-10-05",
  "items": [
    { "account_number": "1234567801", "amount": 35000, "bank_reference": "BNK-20261005-0001" }
  ]
}

// POST /reconciliation/settlement-report — dari Gateway ke Reconciliation (sudah bertoken)
{
  "batch_date": "2026-10-05",
  "items": [
    { "account_pseudonym": "PSEU-B80D2C4F", "amount": 35000, "bank_reference": "BNK-20261005-0001" }
  ]
}
```

Gateway menokenisasi setiap nomor rekening dengan konteks P6 (`DAILY_RECONCILIATION`, ACCOUNT) sebelum meneruskan. Karena kunci penggunaan ulang adalah subjek, layanan, dan purpose, token yang dihasilkan sama dengan token dari alur D2, sehingga pencocokan berdasarkan token berhasil.

### Penilaian risiko di Fraud

Transaction memanggil Fraud hanya bila `amount` mencapai `FRAUD_AMOUNT_THRESHOLD`. Fraud menilai dengan empat aturan berbobot pada tabel `risk_rules` (Bagian 16), memakai riwayat asesmen berkunci token FRAUD\_DETECTION yang sama. Karena token itu berumur 30 hari (Tabel 1, P3), riwayat ini bertahan selama 30 hari dan terputus saat token berganti atau dicabut.

```
FUNGSI evaluate_risk(pseudonym, amount, tx_hour, geohash):
  riwayat     = SELECT amount, geohash FROM fraud_assessments
                 WHERE pseudonym = :pseudonym ORDER BY assessed_at DESC
  prior_count = jumlah baris riwayat
  skor = 0 ; fired = [] ; skipped = []

  JIKA amount >= FRAUD_AMOUNT_THRESHOLD:     skor += 10 ; fired += AMOUNT_OVER_THRESHOLD
  JIKA tx_hour di luar 06:00 sampai 22:00:   skor += 20 ; fired += ODD_HOUR_OUTSIDE_06_22

  JIKA prior_count = 0:                      // cold start
    skipped += [AMOUNT_OVER_3X_AVG, NEW_LOCATION_VS_LAST_3]
  SELAIN ITU:
    avg = rata-rata amount seluruh riwayat
    JIKA amount > 3,00 * avg:                       skor += 25 ; fired += AMOUNT_OVER_3X_AVG
    JIKA geohash tidak ada di 3 geohash terbaru:    skor += 20 ; fired += NEW_LOCATION_VS_LAST_3

  decision = ALLOW (skor < 50) | HOLD_FOR_VERIFICATION (50 sampai 89) | BLOCK (skor >= 90)
  INSERT fraud_assessments(pseudonym, amount, tx_hour, geohash, prior_count, avg, skor, decision, fired)
  KEMBALIKAN { risk_score, decision, rules_fired, rules_skipped, prior_count }
```

Keputusan memengaruhi status transaksi: ALLOW melanjutkan ke COMPLETED, HOLD\_FOR\_VERIFICATION menjadi HELD, dan BLOCK menjadi FAILED. Dengan bobot saat ini skor maksimum adalah 75, sehingga ambang BLOCK 90 tidak dapat tercapai pada prototipe. Ambang itu dipertahankan sebagai ruang untuk aturan tambahan, dan pengujian hanya mencakup ALLOW dan HOLD\_FOR\_VERIFICATION. Profil Fraud hanya mencakup transaksi di atas ambang, dan setiap penggantian token mengulang cold start.

### Kontrak lengkap per endpoint

Konvensi yang berlaku untuk semua endpoint:

- Setiap permintaan membawa `Authorization: Bearer <JWT>` dan `X-Request-Id` (UUID; dibangkitkan Gateway bila klien tidak mengirimnya).
- Waktu memakai ISO 8601 UTC, nominal berupa bilangan bulat rupiah, dan isi berupa JSON UTF-8.
- Daftar memakai `limit` (bawaan 50, maksimum 200) dan `cursor`.
- `POST /transaction` wajib membawa header `Idempotency-Key` berisi UUID dari klien.

#### Format error seragam

```json
{ "error": { "code": "ACCESS_DENIED", "reason": "SERVICE_MISMATCH", "message": "Akses ditolak", "request_id": "3f2b9c1e-6d1a-4e55-9a40-0c1d8e7a2b11" } }
```

Antar-layanan, respons memuat `reason` spesifik seperti pada tabel kode error di bawah. Ke klien eksternal, Gateway menghapus `reason` pada fase respons dan hanya memakai enam `code`: UNAUTHENTICATED (401), ACCESS\_DENIED (403), VALIDATION\_ERROR (422), RATE\_LIMITED (429), SERVICE\_UNAVAILABLE (503), dan INTERNAL\_ERROR (500). TOKEN\_NOT\_FOUND, SERVICE\_MISMATCH, PURPOSE\_MISMATCH, EXPIRED, REVOKED, POLICY\_NOT\_ALLOWED, dan FORBIDDEN\_ROLE semuanya tampil sebagai ACCESS\_DENIED 403 di sisi klien.

#### Transaksi

```json
// POST /transaction  (klien ke Gateway; header Idempotency-Key: 7c9e6679-7425-40de-944b-e07fc1f90ae7)
{ "source_account": "1234567801", "merchant_id": "M-0001", "amount": 35000, "geohash": "qqgu4" }

// Respons 201
{ "transaction_id": "TX-10001", "status": "COMPLETED" }
// status akhir: COMPLETED, HELD, atau FAILED. Pengulangan dengan kunci yang sama mengembalikan 200 dengan
// isi yang sama dan tidak membuat transaksi baru. Kunci yang sama dengan isi berbeda: 409 IDEMPOTENCY_CONFLICT.

// POST /transaction  (Gateway ke Transaction; hanya token)
{ "transaction_id": "TX-10001", "idempotency_key": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "customer_token": "PSEU-8F29A7C1", "account_token": "PSEU-71D92C0E",
  "merchant_id": "M-0001", "amount": 35000, "geohash": "qqgu4" }

// GET /transaction/held?limit=50  (peran fraud_analyst)
{ "items": [ { "transaction_id": "TX-10002", "amount": 8000000, "risk_score": 75.00,
               "fraud_decision": "HOLD_FOR_VERIFICATION", "created_at": "2026-10-05T02:47:13Z" } ],
  "next_cursor": null }

// POST /transaction/TX-10002/review  (peran fraud_analyst)
{ "decision": "APPROVE", "reason_code": "CONFIRMED_BY_CUSTOMER" }
// decision: APPROVE atau REJECT. reason_code: CONFIRMED_BY_CUSTOMER, SUSPECTED_FRAUD, OTHER. Tidak ada teks bebas,
// agar analis tidak dapat memasukkan data pribadi ke dalam catatan.

// Respons 200
{ "transaction_id": "TX-10002", "status": "COMPLETED", "reviewed_at": "2026-10-05T03:05:41Z" }
// REJECT menghasilkan status FAILED. Transaksi yang tidak berstatus HELD: 409 NOT_HELD.
```

#### Notifikasi

```json
// POST /notification/register  (klien ke Gateway: { "phone": "081200000001", "channel": "SMS" }; customer_id dari JWT)
// Gateway ke Notification, setelah tokenisasi konteks P5:
{ "notification_domain_id": "PSEU-C3A91F55", "phone": "081200000001", "channel": "SMS" }
// Respons 201
{ "notification_domain_id": "PSEU-C3A91F55", "registered_at": "2026-09-20T08:15:02Z" }

// POST /notification/send  (Transaction ke Notification)
{ "notif_token": "PSEU-4FE1B3A9", "template": "TX_COMPLETED", "amount": 35000, "transaction_id": "TX-10001" }
// Respons 200
{ "status": "SENT" }
// status: SENT atau FAILED. template: TX_COMPLETED, TX_HELD_VERIFY, atau TX_REJECTED.

// POST /resolve-domain  (Notification ke Privacy)
{ "notif_token": "PSEU-4FE1B3A9" }
// Respons 200
{ "notification_domain_id": "PSEU-C3A91F55" }
```

#### Privacy Service: operasi pendukung

```json
// POST /re-issue  (Transaction ke Privacy)
{ "pseudonym": "PSEU-A64C19B8", "transaction_id": "TX-10003" }
// Respons 200
{ "pseudonym": "PSEU-5A83F0B7", "expires_at": "2026-10-05T14:42:10Z", "reused": false }

// PATCH /transaction-status  (Transaction ke Privacy)
{ "transaction_id": "TX-10001", "status": "COMPLETED" }
// Respons 200
{ "transaction_id": "TX-10001", "status": "COMPLETED", "updated_at": "2026-10-05T12:05:08Z" }
// status yang sah: PENDING, IN_PROGRESS, COMPLETED, FAILED, CANCELLED

// POST /pseudonym/PSEU-7BCD04F2/revoke  (konsol admin, peran admin; tanpa body)
// Respons 200
{ "pseudonym": "PSEU-7BCD04F2", "status": "revoked", "revoked_at": "2026-10-05T03:20:05Z" }

// POST /subject/revoke  (konsol admin, peran admin)
{ "subject_type": "CUSTOMER", "subject_id": "CUST-000102" }
// Respons 200
{ "revoked_count": 4 }
```

```json
// POST /identity  (Gateway ke Privacy, Alur A5; hanya service account API_GATEWAY)
{ "customer_id": "CUST-000101", "nik": "3273015501900001", "nama": "Rina Wijaya",
  "hp": "081200000001", "rekening": "1234567801" }
// Respons 201
{ "customer_id": "CUST-000101", "stored": ["nik", "nama", "hp", "rekening"] }
// Pemanggil selain API_GATEWAY: 403 POLICY_NOT_ALLOWED, tercatat STORE_IDENTITY DENIED
```

#### Audit dan rekonsiliasi

```json
// GET /audit-log?status=DENIED&reason=EXPIRED&from=2026-10-05T00:00:00Z&limit=50  (peran auditor atau admin)
// Filter: service, status, reason, pseudonym, transaction_id, from, to
{ "items": [ { "id": "b1d6f0c2-5a77-4c0e-8a53-2f7d9e1c4a60", "created_at": "2026-10-06T09:41:05Z",
               "action": "DE_PSEUDONYMIZE", "status": "DENIED", "reason": "EXPIRED",
               "requesting_service": "RECONCILIATION", "actor_id": "usr-auditor-01",
               "pseudonym": "PSEU-6C3F8A21", "purpose": "INTERNAL_AUDIT",
               "transaction_id": "TX-10002", "mapping_id": "7e2a91d4-0b3c-4f68-9d15-6a8c3e0f2b97" } ],
  "next_cursor": null }

// GET /audit-log/timeline/PSEU-7BCD04F2  (peran auditor): { "items": [ ...baris yang sama, urut waktu naik ] }
// GET /audit-log/summary?from=2026-10-05T00:00:00Z&to=2026-10-07T00:00:00Z  (peran auditor)
{ "total": 19, "denied": [ { "reason": "EXPIRED", "count": 1 }, { "reason": "SERVICE_MISMATCH", "count": 1 } ] }

// POST /reconciliation/audit-request  (peran auditor, lewat Gateway)
{ "transaction_id": "TX-10002", "reason_code": "AMOUNT_MISMATCH" }
// reason_code: AMOUNT_MISMATCH, DISPUTE, atau OTHER
// Respons 200
{ "request_id": "9a4d5e07-3b1c-4c52-8f0e-1d7b6a2c9e34", "transaction_id": "TX-10002", "audit_token": "PSEU-6C3F8A21", "amount": 150000, "status": "COMPLETED" }
// Audit rutin tidak mengembalikan customer_id, NIK, atau nama.

// POST /disclosure-requests  (peran auditor, lewat Gateway)
{ "audit_token": "PSEU-6C3F8A21", "basis": "DISPUTE", "case_ref": "KASUS-2026-014", "attributes": ["nama"] }
// Respons 201: { "disclosure_id": "d-01", "status": "PENDING" }
// POST /disclosure-requests/d-01/approve  (peran admin, bukan pemohon)
// Respons 200: { "disclosure_id": "d-01", "status": "APPROVED", "expires_at": "2026-10-06T09:40:12Z" }
// Setelah itu Reconciliation memanggil /de-pseudonymize dengan disclosure_id; respons hanya { "nama": "..." } dan tidak disimpan di reconciliation-db.

// POST /reconciliation/run  (penjadwal internal atau peran admin)
{ "date": "2026-10-05" }
// Respons 200
{ "batch_id": "B-20261005", "tx_count": 2, "matched": 2, "unmatched": 0, "status": "MATCHED" }
// status batch: MATCHED, PARTIAL (sebagian item tidak berpasangan), atau MISMATCHED (tidak satu pun cocok)

// GET /health
{ "status": "ok", "service": "privacy-service", "mode": "proposed", "time": "2026-10-05T12:00:00Z" }
// GET /metrics mengembalikan teks format Prometheus.
```

### Kode error dan pemetaan HTTP

| reason | HTTP | Dipicu oleh | Dicatat sebagai |
| --- | --- | --- | --- |
| `OK` | 200 | Operasi berhasil | SUCCESS |
| `REUSED_ACTIVE` | 200 | Token aktif untuk kombinasi yang sama masih ada | SUCCESS |
| `TOKEN_NOT_FOUND` | 404 | Pseudonim tidak ada di mapping | DENIED |
| `SERVICE_MISMATCH` | 403 | Pemanggil bukan pemilik token | DENIED |
| `PURPOSE_MISMATCH` | 403 | Tujuan berbeda dari saat token dibuat | DENIED |
| `EXPIRED` | 410 | Lewat `expires_at` + grace | DENIED |
| `REVOKED` | 403 | Token dicabut admin | DENIED |
| `POLICY_NOT_ALLOWED` | 403 | Kombinasi layanan dan tujuan di luar whitelist | DENIED |
| `TX_TERMINAL` | 409 | Re-issue pada transaksi yang sudah selesai | DENIED |
| `FORBIDDEN_ROLE` | 403 | Peran JWT tidak memenuhi syarat | DENIED |
| `RATE_LIMITED` | 429 | Melebihi kuota di Gateway | Log Kong, bukan audit log |
| UNAUTHENTICATED | 401 | JWT tidak ada, kedaluwarsa, atau tidak sah | Log Kong, bukan audit log |
| VALIDATION\_ERROR | 422 | Isi atau parameter permintaan tidak valid | Log aplikasi, bukan audit log |
| IDEMPOTENCY\_CONFLICT | 409 | Idempotency-Key sama dengan isi permintaan berbeda | Log aplikasi |
| NOT\_HELD | 409 | Review pada transaksi yang tidak berstatus HELD | Log aplikasi |
| SERVICE\_UNAVAILABLE | 503 | Layanan yang dibutuhkan tidak tersedia setelah percobaan ulang | Log Kong atau log aplikasi |

Respons gagal tidak membedakan antara token tidak ada dan token bukan milik pemanggil pada pesan yang terlihat klien. Keduanya memakai bentuk `ACCESS_DENIED`; perbedaannya hanya terekam di audit log.

### Kebijakan kegagalan antar-layanan

Setiap kegagalan harus berakhir pada perilaku yang sudah ditetapkan, bukan pada tebakan saat implementasi. Waktu tunggu dan percobaan ulang mengikuti NFR-12.

| Kegagalan | Perlakuan | Alasan |
| --- | --- | --- |
| Privacy Service tidak tersedia saat Gateway menokenisasi | Gateway menolak dengan 503 SERVICE\_UNAVAILABLE; tidak ada fallback ke data mentah | NFR-11: privasi tidak boleh turun saat sistem gagal |
| Pertukaran token untuk Fraud gagal, atau Fraud melewati batas waktu | Transaksi ditahan dengan status HELD dan keputusan FRAUD\_UNAVAILABLE; notifikasi TX\_HELD\_VERIFY tetap dikirim | Gagal aman: transaksi di atas ambang tidak lolos tanpa penilaian |
| Notification tidak tersedia, atau pertukaran token notifikasi gagal | Transaksi tetap COMPLETED; notifikasi dilewati dan dicatat di log aplikasi dengan transaction\_id; tidak dikirim ulang otomatis | Notifikasi bukan bagian dari kebenaran transaksi; pengiriman ulang di luar cakupan |
| `PATCH /transaction-status` ke Privacy gagal setelah semua percobaan | Transaksi tetap pada status lokalnya; kegagalan dicatat di log aplikasi | Dampaknya hanya gerbang TX\_TERMINAL yang longgar untuk transaksi itu; dicatat sebagai keterbatasan |
| Transaction berhenti di tengah proses | Transaksi PENDING yang lebih lama dari `TX_PENDING_TIMEOUT_SECONDS` ditandai FAILED oleh job di Transaction | Mencegah transaksi menggantung |
| Item laporan settlement tidak berpasangan dengan transaksi | Item ditandai tidak cocok dan batch berstatus PARTIAL | Satu item tidak boleh menghentikan batch |
| Laporan settlement tidak valid (rekening kosong, nominal negatif) | 422 VALIDATION\_ERROR; tidak ada token yang diterbitkan | Data tidak valid tidak boleh sampai ke Privacy Service |

## 11. Skema database final

Setiap layanan memiliki basis datanya sendiri. Tidak ada foreign key lintas basis data.

&#91;embedded content: ERD · privacy-db, 4 tables\]

ERD privacy-db. Satu-satunya relasi kunci asing adalah `audit_log.mapping_id`; hubungan ke `transaction_status` bersifat logis melalui `transaction_id`.

### privacy-db

```sql
CREATE TYPE subject_type_enum AS ENUM ('CUSTOMER', 'ACCOUNT');
CREATE TYPE token_status_enum AS ENUM ('active', 'expired', 'revoked');

CREATE TABLE pseudonym_mapping (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type    subject_type_enum NOT NULL,
  subject_id_enc  BYTEA        NULL,       -- field-level encryption; dikosongkan oleh job retensi
  subject_lookup  BYTEA        NULL,       -- blind index; dikosongkan oleh job retensi
  pseudonym       VARCHAR(16)  NOT NULL UNIQUE,
  service_id      VARCHAR(32)  NOT NULL,   -- layanan pemilik token (target_service saat terbit)
  purpose         VARCHAR(48)  NOT NULL,
  transaction_id  VARCHAR(32),
  key_version     SMALLINT     NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ  NOT NULL,
  revoked_at      TIMESTAMPTZ,
  purged_at       TIMESTAMPTZ,
  status          token_status_enum NOT NULL DEFAULT 'active',
  CONSTRAINT chk_purged CHECK (
    purged_at IS NULL OR (subject_id_enc IS NULL AND subject_lookup IS NULL))
);

-- Partial unique index, menggantikan UNIQUE (subject_id, service_id, purpose) di PRD v1.
-- Agar tidak memblokir penerbitan ulang, baris aktif yang sudah lewat TTL harus lebih dulu
-- ditandai 'expired' di dalam transaksi penerbitan yang sama (lihat Bagian 7.1, STEP 1).
CREATE UNIQUE INDEX uq_mapping_active
  ON pseudonym_mapping (subject_lookup, service_id, purpose)
  WHERE status = 'active';

CREATE INDEX idx_mapping_pseudonym ON pseudonym_mapping (pseudonym);
CREATE INDEX idx_mapping_expiry    ON pseudonym_mapping (expires_at)
  WHERE status = 'active';
CREATE INDEX idx_mapping_tx        ON pseudonym_mapping (transaction_id);
CREATE INDEX idx_mapping_purge     ON pseudonym_mapping (expires_at)
  WHERE purged_at IS NULL;

CREATE TABLE transaction_status (
  transaction_id  VARCHAR(32) PRIMARY KEY,
  status          VARCHAR(16) NOT NULL,   -- PENDING, IN_PROGRESS, COMPLETED, FAILED, CANCELLED
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  action             VARCHAR(32) NOT NULL,
  status             VARCHAR(8)  NOT NULL,   -- SUCCESS | DENIED
  reason             VARCHAR(32) NOT NULL,
  requesting_service VARCHAR(32) NOT NULL,
  actor_id           VARCHAR(64),            -- ID manusia dari Keycloak; SYSTEM untuk job; kosong untuk antar-service
  pseudonym          VARCHAR(16),
  purpose            VARCHAR(48),
  transaction_id     VARCHAR(32),
  mapping_id         UUID REFERENCES pseudonym_mapping(id),
  key_version        SMALLINT,
  prev_hash          CHAR(64),
  row_hash           CHAR(64)
  -- Tidak ada kolom subject_id. Ini perbaikan utama dari PRD v1.
);

CREATE INDEX idx_audit_time   ON audit_log (created_at DESC);
CREATE INDEX idx_audit_denied ON audit_log (status, reason) WHERE status = 'DENIED';
CREATE INDEX idx_audit_pseu   ON audit_log (pseudonym);

-- Append-only ditegakkan di tingkat hak akses, bukan hanya konvensi.
REVOKE UPDATE, DELETE ON audit_log FROM privacy_app;
GRANT  INSERT          ON audit_log TO   privacy_app;
GRANT  SELECT          ON audit_log TO   auditor_role;
```

Kolom `subject_lookup` perlu penjelasan. Karena `subject_id_enc` dienkripsi dengan IV acak, nilainya berbeda setiap kali dan tidak dapat dicari. `subject_lookup` adalah HMAC deterministik atas subjek yang sama, dipakai hanya sebagai kunci pencarian pada STEP 1 algoritma penerbitan. Ini pola *blind index* yang lazim, dan perlu kamu sebut sebagai keputusan desain karena ia sendiri merupakan pseudonim statis internal.

```sql
-- Brankas identitas: satu baris per pelanggan, diisi saat pendaftaran (Alur A5).
CREATE TABLE identity_vault (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_lookup  BYTEA        NULL UNIQUE,  -- HMAC(K_index, 'CUSTOMER' || customer_id); sama dengan subject_lookup
  customer_id_enc  BYTEA        NULL,         -- AES-256-GCM, AAD = 'customer_id'
  nik_enc          BYTEA        NULL,         -- AAD = 'nik'
  nama_enc         BYTEA        NULL,         -- AAD = 'nama'
  hp_enc           BYTEA        NULL,         -- AAD = 'hp'
  rekening_enc     BYTEA        NULL,         -- AAD = 'rekening'
  key_version      SMALLINT     NOT NULL DEFAULT 1,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  purged_at        TIMESTAMPTZ,
  CONSTRAINT chk_vault_purged CHECK (
    purged_at IS NULL OR (customer_lookup IS NULL AND customer_id_enc IS NULL AND nik_enc IS NULL
                          AND nama_enc IS NULL AND hp_enc IS NULL AND rekening_enc IS NULL))
);

-- Auditor membaca identitas hanya lewat /de-pseudonymize dengan disclosure_id yang disetujui, tidak pernah lewat tabel.
REVOKE ALL ON identity_vault FROM auditor_role;
```

Tabel `identity_vault` tergambar di kanan bawah ERD di atas. Ia tidak memakai kunci asing ke `pseudonym_mapping`; keduanya terhubung lewat nilai lookup yang sama, sehingga brankas dapat dikosongkan tanpa memutus rujukan `audit_log`.

```sql
-- Permintaan pembukaan identitas bersyarat (v2.4).
CREATE TABLE disclosure_request (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mapping_id       UUID         NOT NULL REFERENCES pseudonym_mapping(id),  -- token P7
  basis            VARCHAR(32)  NOT NULL,   -- kode Tabel 6
  case_ref         VARCHAR(64)  NOT NULL,
  requested_attrs  TEXT[]       NOT NULL,   -- bagian dari {customer_id, nik, nama}
  requester_id     VARCHAR(64)  NOT NULL,
  approver_id      VARCHAR(64),
  status           VARCHAR(16)  NOT NULL DEFAULT 'PENDING',  -- PENDING, APPROVED, REJECTED, USED, EXPIRED
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  decided_at       TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ,              -- decided_at + 600 detik
  used_at          TIMESTAMPTZ,
  CONSTRAINT chk_four_eyes CHECK (approver_id IS NULL OR approver_id <> requester_id)
);
-- audit_log mendapat kolom disclosure_id (FK ke tabel ini).
```

### transaction-db

```sql
CREATE TABLE merchants (
  merchant_id VARCHAR(16) PRIMARY KEY,
  name        VARCHAR(64) NOT NULL,
  category    VARCHAR(32) NOT NULL,
  qris_id     VARCHAR(32) NOT NULL UNIQUE
);

CREATE TABLE transactions (
  transaction_id     VARCHAR(32) PRIMARY KEY,
  idempotency_key    VARCHAR(64) NOT NULL UNIQUE,   -- dari header Idempotency-Key
  customer_pseudonym VARCHAR(16) NOT NULL,
  account_pseudonym  VARCHAR(16) NOT NULL,
  merchant_id        VARCHAR(16) NOT NULL REFERENCES merchants(merchant_id),
  amount             NUMERIC(18,2) NOT NULL,
  geohash            VARCHAR(12),
  status             VARCHAR(16) NOT NULL,  -- PENDING, COMPLETED, HELD, FAILED
  risk_score         NUMERIC(5,2),          -- NULL bila tidak dikirim ke Fraud
  fraud_decision     VARCHAR(24),           -- ALLOW, HOLD_FOR_VERIFICATION, BLOCK, FRAUD_UNAVAILABLE
  reviewed_by        VARCHAR(64),           -- ID analis dari Keycloak, bukan pelanggan
  reviewed_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at       TIMESTAMPTZ
  -- Tidak menyimpan fraud_token maupun notif_token. Keduanya hanya transit.
);

CREATE INDEX idx_tx_account ON transactions (account_pseudonym, created_at);
CREATE INDEX idx_tx_held    ON transactions (status) WHERE status = 'HELD';
```

### fraud-db

```sql
CREATE TABLE fraud_assessments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pseudonym         VARCHAR(16)   NOT NULL,   -- token FRAUD_DETECTION, berumur 30 hari
  amount            NUMERIC(18,2) NOT NULL,
  tx_hour           SMALLINT      NOT NULL,
  geohash           VARCHAR(12),
  prior_count       INTEGER       NOT NULL,   -- jumlah asesmen sebelumnya pada token yang sama
  avg_prior_amount  NUMERIC(18,2),            -- rata-rata nominal asesmen sebelumnya; NULL bila prior_count = 0
  risk_score        NUMERIC(5,2)  NOT NULL,
  decision          VARCHAR(24)   NOT NULL,
  rules_fired       TEXT[]        NOT NULL DEFAULT '{}',
  assessed_at       TIMESTAMPTZ   NOT NULL DEFAULT now()
  -- Tidak menyimpan transaction_id, agar fraud-db tidak dapat dijoin ke transaction-db.
);

CREATE INDEX idx_fraud_profile ON fraud_assessments (pseudonym, assessed_at DESC);

CREATE TABLE risk_rules (
  rule       VARCHAR(32) PRIMARY KEY,
  parameter  VARCHAR(64) NOT NULL,
  weight     SMALLINT    NOT NULL,
  active     BOOLEAN     NOT NULL DEFAULT true
);
```

### notification-db

```sql
CREATE TABLE contact_registry (
  pseudonym     VARCHAR(16) PRIMARY KEY,   -- notification_domain_id, TTL 365 hari
  phone         VARCHAR(20) NOT NULL,      -- satu-satunya PII asli di luar Privacy dan Keycloak
  channel       VARCHAR(16) NOT NULL DEFAULT 'SMS',
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE notification_log (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_pseudonym     VARCHAR(16) NOT NULL,   -- notif_token per transaksi
  recipient_pseudonym  VARCHAR(16) NOT NULL,   -- notification_domain_id
  template             VARCHAR(32) NOT NULL,
  channel              VARCHAR(16) NOT NULL,
  sent_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  status               VARCHAR(16) NOT NULL
  -- Tidak menyimpan isi pesan, karena isi memuat nominal dan dapat menjadi profil.
);
```

### reconciliation-db

```sql
CREATE TABLE settlement_batches (
  batch_id     VARCHAR(20) PRIMARY KEY,
  batch_date   DATE        NOT NULL,
  tx_count     INTEGER     NOT NULL,
  total_amount NUMERIC(18,2) NOT NULL,
  status       VARCHAR(16) NOT NULL,   -- MATCHED, PARTIAL, MISMATCHED
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE settlement_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id          VARCHAR(20) NOT NULL REFERENCES settlement_batches(batch_id),
  account_pseudonym VARCHAR(16) NOT NULL,
  amount            NUMERIC(18,2) NOT NULL,
  bank_reference    VARCHAR(32) NOT NULL,
  matched           BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE audit_requests (
  request_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id VARCHAR(32) NOT NULL,
  reason_code    VARCHAR(24) NOT NULL,   -- AMOUNT_MISMATCH, DISPUTE, OTHER; tanpa teks bebas
  actor_id       VARCHAR(64) NOT NULL,
  requested_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  -- Hasil de-pseudonimisasi tidak disimpan di sini, hanya diteruskan ke auditor.
);
```

### Perbedaan skema pada mode baseline

Pada mode baseline, kolom bertipe pseudonim diganti kolom identitas asli: `transactions.customer_id`, `transactions.account_number`, `fraud_assessments.customer_id`, `settlement_items.account_number`, dan `contact_registry` memakai `customer_id` sebagai kunci. Privacy Service tidak dipanggil sama sekali. Perbedaan jumlah kolom identitas inilah yang menjadi metrik paparan PII di Bab IV.

## 12. Audit log dan modul Audit

Audit adalah modul di dalam Privacy Service, bukan layanan kedelapan. Memisahkannya akan menambah satu hop pada setiap permintaan, satu basis data lagi, dan memaksa Privacy Service memanggil keluar, yang melanggar aturan arah panggilan searah. Jika penguji menuntut layanan tersendiri, jawabannya adalah trade-off ini, bukan ketidakmampuan.

### Kamus kolom audit log

| Kolom | Isi | Contoh | Catatan |
| --- | --- | --- | --- |
| `id` | UUID baris | a05 | Dibuat basis data |
| `created_at` | Waktu event | 05/10 12:05:02 | Diisi `now()`, bukan oleh pemanggil |
| `action` | Jenis event | GENERATE\_TOKEN | Katalog di bawah |
| `status` | SUCCESS atau DENIED | DENIED | — |
| `reason` | Kode alasan | SERVICE\_MISMATCH | Selalu terisi, juga untuk SUCCESS yang bernilai OK |
| `requesting_service` | Layanan pemanggil | TRANSACTION | Dari klaim JWT, bukan body request |
| `actor_id` | ID manusia dari Keycloak | usr-auditor-01 | Kosong untuk panggilan antar-service |
| `pseudonym` | Token yang dimaksud | PSEU-8F29A7C1 | Kosong jika token belum atau gagal dibuat |
| `purpose` | Tujuan yang diminta pemanggil | PAYMENT\_PROCESSING | Berbeda dari tujuan di baris mapping berarti PURPOSE\_MISMATCH |
| `transaction_id` | Konteks transaksi | TX-10001 | Bukan PII |
| `mapping_id` | Kunci asing ke `pseudonym_mapping.id` | m01 | Pengganti `subject_id` |
| `key_version` | Versi kunci HMAC | 1 | Untuk forensik setelah rotasi kunci |
| `prev_hash`, `row_hash` | Rantai hash antar-baris | — | Opsional, mendeteksi baris yang dihapus atau diubah |

### Katalog action

| Action | Dicatat saat | Status dan reason yang mungkin |
| --- | --- | --- |
| GENERATE\_TOKEN | `/pseudonymize` dengan `subject_id` | SUCCESS: OK, REUSED\_ACTIVE. DENIED: POLICY\_NOT\_ALLOWED |
| EXCHANGE\_TOKEN | `/pseudonymize` dengan `source_pseudonym` | SUCCESS: OK, REUSED\_ACTIVE. DENIED: TOKEN\_NOT\_FOUND, SERVICE\_MISMATCH, PURPOSE\_MISMATCH, EXPIRED, REVOKED, POLICY\_NOT\_ALLOWED |
| RESOLVE\_NOTIF\_DOMAIN | Notification menerjemahkan `notif_token` | SUCCESS: OK. DENIED: reason gerbang yang sama, termasuk reason GATE 5 (DISCLOSURE\_NOT\_APPROVED, DISCLOSURE\_EXPIRED, REQUESTER\_MISMATCH) |
| DE\_PSEUDONYMIZE | `/de-pseudonymize` | SUCCESS: OK. DENIED: TOKEN\_NOT\_FOUND, SERVICE\_MISMATCH, PURPOSE\_MISMATCH, EXPIRED, REVOKED, FORBIDDEN\_ROLE |
| RE\_ISSUE | `/re-issue` | SUCCESS: OK. DENIED: TX\_TERMINAL, TOKEN\_NOT\_FOUND |
| REVOKE\_TOKEN | Pencabutan manual oleh admin | SUCCESS: OK. DENIED: TOKEN\_NOT\_FOUND |
| VIEW\_AUDIT\_LOG | Auditor membaca log | SUCCESS: OK |
| REVOKE\_SUBJECT | Admin mencabut seluruh token satu subjek; satu baris per token yang dicabut | SUCCESS: OK. DENIED: TOKEN\_NOT\_FOUND |
| PURGE\_IDENTITY | Job retensi mengosongkan kolom identitas mapping, atau revoke\_subject mengosongkan brankas identitas; satu baris per baris mapping, actor\_id = SYSTEM | SUCCESS: OK |
| STORE\_IDENTITY | /identity saat pendaftaran; satu baris per pelanggan, tanpa nilai identitas | SUCCESS: OK. DENIED: POLICY\_NOT\_ALLOWED (pemanggil bukan Gateway) |

Penolakan rate limit terjadi di Gateway sebelum permintaan sampai ke Privacy Service, jadi tercatat di log Kong, bukan di `audit_log`. Penandaan `expired` karena waktu tidak dicatat sebagai event audit, karena itu pembaruan status malas dan bukan operasi pengguna. Pembaruan status transaksi (`UPDATE_TX_STATUS`) juga tidak dicatat karena bukan operasi token.

### Contoh isi audit log

Satu transaksi normal menghasilkan sekitar enam baris. Contoh berikut dipilih agar setiap action dan reason muncul sekurangnya sekali. Tanggal ditulis dd/mm, tahun 2026.

| id | created\_at | action | status | reason | service | actor\_id | pseudonym | purpose | tx | mapping |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a01 | 05/10 02:47:12 | EXCHANGE\_TOKEN | SUCCESS | REUSED\_ACTIVE | TRANSACTION | — | PSEU-7BCD04F2 | FRAUD\_DETECTION | TX-10002 | m06 |
| a02 | 05/10 02:47:14 | EXCHANGE\_TOKEN | SUCCESS | REUSED\_ACTIVE | TRANSACTION | — | PSEU-7BCD04F2 | FRAUD\_DETECTION | TX-10002 | m06 |
| a03 | 05/10 03:12:40 | DE\_PSEUDONYMIZE | DENIED | SERVICE\_MISMATCH | NOTIFICATION | — | PSEU-7BCD04F2 | NOTIFICATION | TX-10002 | m06 |
| a04 | 05/10 03:20:05 | REVOKE\_TOKEN | SUCCESS | OK | ADMIN\_CONSOLE | usr-admin-01 | PSEU-7BCD04F2 | — | TX-10002 | m06 |
| a05 | 05/10 12:05:02 | GENERATE\_TOKEN | SUCCESS | OK | API\_GATEWAY | — | PSEU-8F29A7C1 | PAYMENT\_PROCESSING | TX-10001 | m01 |
| a06 | 05/10 12:05:04 | EXCHANGE\_TOKEN | SUCCESS | OK | TRANSACTION | — | PSEU-4FE1B3A9 | NOTIFICATION | TX-10001 | m03 |
| a07 | 05/10 12:05:09 | RESOLVE\_NOTIF\_DOMAIN | SUCCESS | OK | NOTIFICATION | — | PSEU-4FE1B3A9 | NOTIFICATION | TX-10001 | m03 |
| a08 | 05/10 14:10:03 | EXCHANGE\_TOKEN | SUCCESS | REUSED\_ACTIVE | TRANSACTION | — | PSEU-E2F6A013 | FRAUD\_DETECTION | TX-10003 | m10 |
| a09 | 05/10 14:27:10 | RE\_ISSUE | SUCCESS | OK | TRANSACTION | — | PSEU-5A83F0B7 | PAYMENT\_PROCESSING | TX-10003 | m11 |
| a10 | 05/10 14:45:00 | RE\_ISSUE | DENIED | TX\_TERMINAL | TRANSACTION | — | PSEU-5A83F0B7 | PAYMENT\_PROCESSING | TX-10003 | m11 |
| a11 | 05/10 15:12:00 | DE\_PSEUDONYMIZE | DENIED | POLICY\_NOT\_ALLOWED | FRAUD | — | PSEU-E2F6A013 | FRAUD\_DETECTION | TX-10003 | m10 |
| a12 | 06/10 00:10:05 | GENERATE\_TOKEN | SUCCESS | OK | RECONCILIATION | — | PSEU-B80D2C4F | DAILY\_RECONCILIATION | TX-10001 | m17 |
| a13 | 06/10 09:30:12 | GENERATE\_TOKEN | SUCCESS | OK | RECONCILIATION | usr-auditor-01 | PSEU-6C3F8A21 | INTERNAL\_AUDIT | TX-10002 | m19 |
| a14 | 06/10 09:31:40 | DE\_PSEUDONYMIZE | SUCCESS | OK | RECONCILIATION | usr-auditor-01 | PSEU-6C3F8A21 | INTERNAL\_AUDIT | TX-10002 | m19 |
| a15 | 06/10 09:41:05 | DE\_PSEUDONYMIZE | DENIED | EXPIRED | RECONCILIATION | usr-auditor-01 | PSEU-6C3F8A21 | INTERNAL\_AUDIT | TX-10002 | m19 |
| a16 | 06/10 09:45:00 | DE\_PSEUDONYMIZE | DENIED | TOKEN\_NOT\_FOUND | FRAUD | — | PSEU-FFFF0000 | FRAUD\_DETECTION | — | — |
| a17 | 06/10 10:02:11 | GENERATE\_TOKEN | DENIED | POLICY\_NOT\_ALLOWED | NOTIFICATION | — | — | SEND\_PROMOTION | — | — |
| a18 | 06/10 10:15:30 | VIEW\_AUDIT\_LOG | SUCCESS | OK | ADMIN\_CONSOLE | usr-auditor-01 | — | — | — | — |
| a19 | 06/10 11:20:00 | DE\_PSEUDONYMIZE | DENIED | PURPOSE\_MISMATCH | RECONCILIATION | — | PSEU-B80D2C4F | INTERNAL\_AUDIT | TX-10001 | m17 |

Baris a15 ditolak karena token INTERNAL\_AUDIT hanya berlaku 10 menit ditambah toleransi 30 detik, sehingga berakhir pukul 09:40:42. Baris a03, a11, a16, dan a19 menjadi bahan skenario pengujian keamanan di Bab IV.

### Komponen modul Audit

| Komponen | Isi | Status |
| --- | --- | --- |
| Tabel `audit_log` | Append-only; akun aplikasi hanya INSERT, auditor hanya SELECT | Wajib |
| `GET /audit-log` | Filter service, status, reason, pseudonym, transaction, rentang waktu | Wajib |
| `GET /audit-log/timeline/{pseudonym}` | Riwayat satu token dari terbit sampai kedaluwarsa atau dicabut | Usulan |
| `GET /audit-log/summary` | Jumlah DENIED per reason, per service, per jam | Usulan, bahan Bab IV |
| Rantai hash | `row_hash = SHA-256(prev_hash ‖ isi baris)` | Opsional |
| Peran akses | Service account menulis saja; auditor membaca; admin membaca dan mencabut | Wajib |
| Pencatatan pembacaan | Setiap `GET /audit-log` menghasilkan baris VIEW\_AUDIT\_LOG | Usulan |
| Retensi | Baris `pseudonym_mapping` tidak dihapus karena `mapping_id` merujuknya; kolom identitasnya dikosongkan setelah `RETENTION_DAYS` (90 hari). `audit_log` tidak dihapus dalam prototipe | Keputusan final: 90 hari |
| Peringatan sederhana | Tiga DENIED SERVICE\_MISMATCH atau TOKEN\_NOT\_FOUND dari satu layanan dalam lima menit ditandai di summary | Opsional |

### Pertanyaan yang harus dapat dijawab

| Pertanyaan auditor | Cara menjawab |
| --- | --- |
| Siapa membuka identitas asli dan untuk apa? | `action = DE_PSEUDONYMIZE` dan `status = SUCCESS`; lihat `actor_id`, `purpose`, `transaction_id` |
| Adakah percobaan akses tidak sah? | `status = DENIED` dengan reason SERVICE\_MISMATCH, PURPOSE\_MISMATCH, atau TOKEN\_NOT\_FOUND |
| Apa yang terjadi pada token tertentu? | `timeline/{pseudonym}`: terbit, tukar, re-issue, ditolak, dicabut |
| Token mana yang dicabut dan oleh siapa? | `action = REVOKE_TOKEN` |
| Siapa saja yang pernah membaca audit log? | `action = VIEW_AUDIT_LOG` |

### Yang tidak boleh masuk audit log

NIK, nama, nomor HP, email, nomor rekening, `subject_id`, nominal transaksi, geohash, secret HMAC, dan JWT. Larangan yang sama berlaku untuk log aplikasi setiap layanan: isinya hanya token dan `transaction_id`. Log terdistribusi menjadi penyimpanan data pribadi kedua kalau tidak dijaga.

## 13. Functional requirements

Setiap FR tertaut ke user story, endpoint, dan cara verifikasinya. Kolom prinsip merujuk prinsip Privacy-by-Design yang mendasarinya.

| ID | Kebutuhan | Story | Endpoint | Prinsip PbD | Verifikasi |
| --- | --- | --- | --- | --- | --- |
| FR-01 | Gateway memvalidasi JWT setiap permintaan dan menolak yang tidak sah | US-01 | `/transaction` | End-to-end security | Uji dengan JWT kedaluwarsa, harus 401 |
| FR-02 | Gateway mentokenisasi `customer_id` dan nomor rekening sebelum meneruskan ke layanan mana pun | US-01 | `/pseudonymize` | Privacy by default | Inspeksi payload keluar Gateway |
| FR-03 | Gateway membuang NIK, nama, dan email dari permintaan ke layanan hilir | US-01 | — | Data minimisation | Inspeksi payload keluar Gateway |
| FR-04 | Privacy Service mengevaluasi kebijakan sebagai langkah pertama setiap penerbitan token | US-12 | `/pseudonymize` | Proactive not reactive | Permintaan di luar whitelist ditolak 403 tanpa baris mapping |
| FR-05 | Privacy Service menerbitkan token dari kombinasi subjek, layanan, tujuan, dan nonce | US-01 | `/pseudonymize` | Privacy embedded in design | Satu subjek menghasilkan token berbeda pada layanan berbeda |
| FR-06 | Privacy Service menggunakan ulang token aktif untuk kombinasi yang sama dalam jendela TTL | US-01 | `/pseudonymize` | Full functionality | Panggilan kedua mengembalikan `reused: true` |
| FR-07 | Privacy Service menukar token tanpa pernah menerima `subject_id` dari layanan hilir | US-01 | `/pseudonymize` | Data minimisation | Permintaan `subject_id` dari Transaction ditolak 403 |
| FR-08 | Privacy Service menerjemahkan `notif_token` menjadi pseudonim domain, bukan identitas | US-02 | `/resolve-domain` | Data minimisation | Respons berisi PSEU, bukan CUST |
| FR-09 | Privacy Service membuka identitas asli hanya setelah permintaan pembukaan disetujui admin yang bukan pemohon, lolos lima gerbang, dan peran auditor | US-06 | `/de-pseudonymize` | End-to-end security | Lima kasus negatif ditolak dengan reason yang tepat |
| FR-10 | Privacy Service menerbitkan ulang token kedaluwarsa pada transaksi yang belum terminal | US-03 | `/re-issue` | Full functionality | Transaksi dengan token kedaluwarsa tetap COMPLETED |
| FR-11 | Privacy Service menolak re-issue pada transaksi terminal | US-03 | `/re-issue` | End-to-end security | Respons 409 TX\_TERMINAL |
| FR-12 | Admin dapat mencabut token sehingga pemakaian berikutnya gagal | US-05 | `/pseudonym/{id}/revoke` | Visibility and transparency | Pemakaian setelah revoke menghasilkan reason REVOKED |
| FR-13 | Setiap operasi token tercatat di audit log append-only, berhasil maupun ditolak | US-07 | — | Visibility and transparency | Jumlah baris audit sama dengan jumlah panggilan |
| FR-14 | Auditor dapat memfilter audit log menurut layanan, status, reason, token, transaksi, dan waktu | US-07 | `/audit-log` | Visibility and transparency | Query gabungan mengembalikan hasil yang benar |
| FR-15 | Audit log tidak memuat identitas dalam bentuk apa pun | US-07 | — | Data minimisation | Pemindaian kolom dan nilai audit\_log nihil PII |
| FR-16 | Transaction memproses transaksi hanya dengan token dan atribut non-identitas | US-01 | `/transaction` | Privacy by default | Skema transaction-db tidak memiliki kolom identitas |
| FR-17 | Transaction memperbarui status transaksi ke Privacy Service | US-03 | `/transaction-status` | Full functionality | Baris `transaction_status` terisi untuk setiap transaksi |
| FR-18 | Fraud menilai risiko dari atribut perilaku tanpa identitas | US-04 | `/fraud/assess` | Data minimisation | fraud-db tidak dapat dijoin ke transaction-db lewat pseudonim |
| FR-19 | Notification mendaftarkan kontak terhadap pseudonim domain berumur panjang | US-02 | `/notification/register` | Privacy embedded in design | `contact_registry` berkunci PSEU |
| FR-20 | Notification mengirim notifikasi tanpa pernah menerima identitas | US-02 | `/notification/send` | Data minimisation | Payload masuk hanya memuat token |
| FR-21 | Reconciliation mencocokkan settlement hanya dengan token, nominal, dan tanggal | US-01 | — | Privacy by default | reconciliation-db nihil identitas |
| FR-22 | Reconciliation dapat mengajukan permintaan audit yang memicu pembukaan identitas tercatat | US-06 | `/reconciliation/audit-request` | Visibility and transparency | Satu baris `audit_requests` dan satu baris audit log per permintaan |
| FR-23 | Sistem dapat dijalankan pada dua mode lewat satu variabel lingkungan | US-09 | — | — | `PRIVACY_MODE=baseline` dan `proposed` berjalan tanpa perubahan kode |
| FR-24 | Sistem menyediakan skrip pengukuran paparan PII untuk kedua mode | US-10 | — | — | Skrip menghasilkan tabel perbandingan jumlah field identitas |
| FR-25 | Semua kolom subjek di Privacy Service dienkripsi di tingkat field | US-01 | — | End-to-end security | Dump basis data menampilkan ciphertext, bukan plaintext |
| FR-26 | Gateway menerapkan rate limiting per service account | US-12 | — | End-to-end security | Permintaan melebihi kuota menghasilkan 429 |
| FR-27 | Policy Engine memvalidasi subject\_type dan cara terbit, bukan hanya pasangan layanan dan tujuan | US-12 | `/pseudonymize` | Data minimisation | Fraud meminta token ACCOUNT ditolak POLICY\_NOT\_ALLOWED |
| FR-28 | Pertukaran token hanya sah untuk pasangan yang terdaftar di matriks pertukaran | US-12 | `/pseudonymize` | Proactive not reactive | Pertukaran FRAUD ke NOTIFICATION ditolak meski token sumber valid |
| FR-29 | Admin dapat mencabut seluruh token milik satu subjek dalam satu operasi | US-05 | `/subject/revoke` | Visibility and transparency | Seluruh token subjek berstatus revoked, jumlahnya dikembalikan dan tercatat di audit log |
| FR-30 | Privacy Service memakai tiga kunci terpisah untuk token, blind index, dan enkripsi field | US-01 | — | End-to-end security | Inspeksi konfigurasi: tiga variabel berbeda, tidak ada yang dipakai ulang |
| FR-31 | Job retensi mengosongkan kolom identitas mapping yang tidak berlaku lebih dari RETENTION\_DAYS (90 hari) | US-01 | — | Data minimisation | Setelah job berjalan, tidak ada baris tidak berlaku lebih tua dari 90 hari yang masih memiliki subject\_id\_enc |
| FR-32 | Gateway menokenisasi laporan settlement bank sebelum meneruskannya ke Reconciliation | US-01 | `/settlement/report` | Data minimisation | reconciliation-db tidak memuat nomor rekening dari laporan bank, dan token hasilnya sama dengan token alur D2 |
| FR-33 | Penerbitan token menandai baris aktif yang sudah lewat TTL sebagai expired dalam transaksi yang sama | US-03 | `/pseudonymize` | Full functionality | Penerbitan untuk konteks yang sama setelah TTL berhasil tanpa pelanggaran unique index |
| FR-34 | Fraud Analyst melihat daftar transaksi HELD tanpa identitas | US-04 | `/transaction/held` | Data minimisation | Respons hanya memuat transaction\_id, nominal, skor, dan keputusan |
| FR-35 | Fraud Analyst menyetujui atau menolak transaksi HELD | US-04 | `/transaction/{id}/review` | Full functionality | Status menjadi COMPLETED atau FAILED, status di Privacy ikut diperbarui, reviewed\_by terisi |
| FR-36 | POST /transaction idempoten terhadap Idempotency-Key | US-01 | `/transaction` | Full functionality | Dua permintaan identik menghasilkan satu transaksi dan respons yang sama |
| FR-37 | Fraud menghitung profil riwayat sendiri berkunci fraud\_token dan menangani cold start | US-04 | `/fraud/assess` | Privacy embedded in design | Asesmen pertama melaporkan dua aturan di rules\_skipped; asesmen berikutnya memakai riwayat |
| FR-38 | Gateway mentokenisasi lewat plugin privacy-tokenizer dan menolak 503 bila Privacy Service tidak tersedia | US-01 | `/transaction` | Privacy by default | Payload keluar Gateway tanpa identitas; Privacy Service dimatikan menghasilkan 503 |
| FR-39 | Transaksi PENDING yang melewati batas waktu ditandai FAILED | US-03 | — | Full functionality | Transaksi PENDING lebih tua dari TX\_PENDING\_TIMEOUT\_SECONDS menjadi FAILED |
| FR-40 | Transaction menahan transaksi sebagai HELD (FRAUD\_UNAVAILABLE) bila Fraud tidak tersedia | US-04 | `/fraud/assess` | End-to-end security | Dengan Fraud dimatikan, transaksi di atas ambang berstatus HELD |
| FR-41 | Rekonsiliasi dapat dipicu manual untuk satu tanggal | US-01 | `/reconciliation/run` | Full functionality | Batch untuk tanggal yang diminta terbentuk dan status batch sesuai hasil pencocokan |
| FR-42 | Privacy Service menyimpan NIK, nama, HP, dan nomor rekening dari pendaftaran di brankas identitas, terenkripsi per kolom | US-06 | /identity | End-to-end security | Dump identity\_vault hanya berisi ciphertext; pemanggil selain Gateway ditolak (TK-20) |
| FR-43 | Pembukaan identitas hanya mengembalikan atribut brankas yang tercantum di Tabel 5 untuk konteks token dan disetujui pada permintaan pembukaan | US-06 | /de-pseudonymize | Data minimisation | Audit rutin tanpa atribut brankas (TK-22); respons pembukaan hanya memuat atribut yang disetujui, tanpa HP dan rekening (TK-21) |
| FR-44 | Pencabutan per subjek mengosongkan baris brankas identitas subjek itu | US-05 | /subject/revoke | Data minimisation | Setelah revoke\_subject, kolom brankas kosong dan purged\_at terisi (TK-17) |

## 14. Non-functional requirements

| ID | Kategori | Kebutuhan | Target terukur | Cara verifikasi |
| --- | --- | --- | --- | --- |
| NFR-01 | Performa | Overhead latensi mode proposed terhadap baseline | p95 ≤ 20% | k6, 100 VU, 5 menit, beban identik |
| NFR-02 | Performa | Penurunan throughput | ≤ 15% | k6, RPS rata-rata |
| NFR-03 | Performa | Latensi penerbitan token di Privacy Service | p95 ≤ 50 ms tanpa beban eksternal | Pengukuran langsung ke `/pseudonymize` |
| NFR-04 | Performa | Pencarian mapping | Selalu lewat indeks, tidak ada sequential scan | `EXPLAIN ANALYZE` pada query utama |
| NFR-05 | Keamanan | Enkripsi field pada kolom subjek | AES-256-GCM, kunci dimuat dari Docker secret | Inspeksi dump basis data |
| NFR-06 | Keamanan | Transport antar-layanan | TLS di Kong untuk klien eksternal dan pada jalur Gateway ke Privacy Service; panggilan lain hanya membawa token dan memakai jaringan Docker internal yang terisolasi | Konfigurasi Kong dan pemeriksaan sertifikat |
| NFR-07 | Keamanan | Secret HMAC tidak pernah meninggalkan Privacy Service | Tidak ada di log, respons, maupun variabel layanan lain | Pencarian pola pada seluruh log dan konfigurasi |
| NFR-08 | Keamanan | Rate limiting per service account | 100 permintaan per menit per akun untuk klien eksternal di Kong; plugin dinonaktifkan pada uji performa (kedua mode) dan diaktifkan kembali pada TK-11 | Uji lonjakan menghasilkan 429 |
| NFR-09 | Keamanan | Audit log tidak dapat diubah oleh akun aplikasi | UPDATE dan DELETE dicabut di tingkat basis data | Percobaan UPDATE harus gagal |
| NFR-10 | Keamanan | Pesan error tidak membocorkan keberadaan token | Semua kegagalan memakai bentuk `ACCESS_DENIED` | Perbandingan respons untuk token ada dan tidak ada |
| NFR-11 | Reliability | Kegagalan Privacy Service tidak menyebabkan fallback ke data mentah | Layanan hilir gagal cepat dengan 503 | Uji dengan Privacy Service dimatikan |
| NFR-12 | Reliability | Timeout panggilan antar-layanan | 3 detik, maksimum 2 retry dengan backoff | Konfigurasi klien HTTP dan uji injeksi keterlambatan |
| NFR-13 | Reliability | Idempotensi penerbitan token | Permintaan berulang dalam TTL mengembalikan token yang sama | Dua panggilan berturut-turut |
| NFR-14 | Observability | Setiap layanan mengekspos `/health` dan `/metrics` | Format Prometheus | Scrape manual |
| NFR-15 | Observability | Log aplikasi tidak memuat PII | Pemindaian pola NIK, HP, rekening nihil temuan | Skrip pemindai pada log seluruh kontainer |
| NFR-16 | Observability | Korelasi antar-layanan memakai `transaction_id`, bukan identitas | Hadir di semua log | Inspeksi log |
| NFR-17 | Kepatuhan | Seluruh penyimpanan identitas terpusat di satu layanan | Hanya privacy-db dan keycloak-db | Inventaris skema |
| NFR-18 | Kepatuhan | Kolom identitas mapping dikosongkan setelah RETENTION\_DAYS; baris mapping dan audit\_log dipertahankan | RETENTION\_DAYS = 90, parameter yang ditetapkan sendiri | Konfigurasi retensi |
| NFR-19 | Portabilitas | Seluruh sistem berjalan dari satu `docker compose up` | Tidak ada langkah manual selain menyalin berkas env | Uji dari mesin bersih |
| NFR-20 | Konsistensi waktu | Seluruh kontainer memakai UTC | Selisih jam di bawah toleransi grace | Pemeriksaan `date` di setiap kontainer |
| NFR-21 | Keamanan | Masa berlaku JWT | Access token paling lama 5 menit; token service account di-cache sampai 30 detik sebelum kedaluwarsa | Inspeksi realm Keycloak dan uji token kedaluwarsa |
| NFR-22 | Keamanan | Pengelolaan secret | Tiga kunci Privacy Service dimuat dari Docker secret; tidak ada di repositori maupun image | Pemindaian repositori dan docker history |
| NFR-23 | Reliability | Idempotensi POST /transaction | Idempotency-Key yang sama menghasilkan nol transaksi ganda | Dua permintaan identik berurutan dan paralel |
| NFR-24 | Reliability | Gagal aman saat Fraud tidak tersedia | Transaksi di atas ambang berstatus HELD, bukan COMPLETED | Uji dengan Fraud dimatikan |
| NFR-25 | Kompatibilitas | Format error seragam | Semua respons error memuat code, message, dan request\_id | Validasi skema JSON pada koleksi Postman |

## 15. Analisis keamanan dan privacy hotspot

Kejujuran tentang kelemahan desain lebih bernilai daripada klaim yang terlalu kuat. Bagian ini adalah bahan pertahanan saat sidang.

### Privacy hotspot: Privacy Service

Privacy Service memegang secret HMAC, kunci enkripsi, dan seluruh mapping table sekaligus. Ia adalah titik kegagalan tunggal sekaligus sasaran paling bernilai bagi penyerang, atau yang sering disebut honeypot. Penyerang yang menguasai layanan ini memperoleh kemampuan membalik seluruh token.

Brankas identitas memperbesar dampak hotspot ini. Penyerang yang menguasai Privacy Service beserta `K_field` kini dapat membuka NIK dan nama, bukan hanya `customer_id`. Mitigasinya tetap enkripsi per kolom, tiga kunci terpisah, pembatasan atribut per konteks (Tabel 5), persetujuan pihak kedua untuk setiap pembukaan, dan larangan akses langsung ke tabel brankas; risiko sisanya ditulis sebagai keterbatasan.

Ini konsekuensi logis dari memilih pendekatan stateful, dan ia tetap lebih baik daripada baseline karena satu alasan: pada baseline, identitas yang sama tersebar di lima basis data, sehingga satu layanan mana pun yang jebol sudah cukup. Pada rancangan ini, hanya satu layanan yang bernilai, dan layanan itu dapat diperkuat secara khusus.

### Model ancaman dan mitigasi

| Ancaman | Dampak | Mitigasi dalam rancangan | Sisa risiko |
| --- | --- | --- | --- |
| Privacy Service dikuasai penyerang | Seluruh identitas terbuka | Enkripsi field, pemisahan kunci dari basis data, audit log append-only, rate limiting | Tinggi; diakui sebagai keterbatasan |
| Secret HMAC bocor | Penyerang dapat menghitung token | Token tetap tidak dapat dibalik tanpa mapping table; `key_version` menyiapkan rotasi | Sedang |
| Service account dicuri | Penyerang menyamar sebagai layanan | `service_id` dari klaim JWT, gerbang SERVICE\_MISMATCH, rate limiting, audit DENIED | Sedang |
| Layanan hilir mencoba token milik layanan lain | Penautan lintas layanan | Gerbang SERVICE\_MISMATCH, token berbeda per layanan | Rendah |
| Penautan dalam jendela TTL | Fraud dapat mengaitkan beberapa transaksi dari orang yang sama selama 30 hari (TTL P3) | TTL purpose lain diperpendek sesuai SLA; TTL P3 sengaja 30 hari untuk profiling | Sedang pada Fraud, rendah pada layanan lain; ini batas teknik semi-dinamis |
| Serangan korelasi lewat atribut | Nominal, jam, dan geohash dapat mengidentifikasi ulang tanpa token | Di luar cakupan; perlu k-anonymity atau differential privacy | Tinggi; disebut sebagai arah penelitian lanjutan |
| Log aplikasi memuat PII | Penyimpanan identitas kedua | Larangan eksplisit, skrip pemindai sebagai bagian pengujian | Rendah |
| Dump basis data Privacy Service | Mapping terbaca | Enkripsi field pada kolom subjek | Sedang |
| Pencabutan identitas tidak lengkap | Hak penghapusan tidak terpenuhi | Penghapusan baris mapping memutus seluruh token sekaligus | Rendah; ini justru keunggulan desain |

### Tiga kelemahan yang harus kamu siapkan jawabannya

1. **Privacy Service adalah honeypot.** Jawaban: trade-off yang disengaja; alternatifnya adalah skema *blind pseudonymization*, yang menghilangkan kemampuan audit internal dan berada di luar cakupan penelitian ini.
2. **Dinamisnya hanya semi-dinamis.** Token aktif digunakan ulang dalam jendela TTL, sehingga linkability masih mungkin di dalam jendela itu. Jawaban: jendelanya terukur dan dapat dipersempit lewat kebijakan, berbeda dari pseudonim statis yang jendelanya tak terbatas.
3. **Ambang 20% dan 15% ditetapkan sendiri.** Jawaban: keduanya adalah parameter penelitian yang dinyatakan terbuka, bukan standar industri, dan seluruh kontainer berjalan di satu VPS sehingga angkanya cenderung optimistis.

## 16. Data uji fiktif

Semua nilai buatan. NIK, nomor HP, dan nomor rekening tidak merujuk ke orang atau rekening nyata. Tanggal ditulis dd/mm, tahun 2026 kecuali disebut lain.

### Sumber mentah, hanya dilihat Gateway dan Privacy Service

| customer\_id | NIK | Nama | HP | Email | Rekening |
| --- | --- | --- | --- | --- | --- |
| CUST-000101 | 3273015501900001 | Rina Wijaya | 081200000001 | rina.wijaya@example.test | 1234567801 |
| CUST-000102 | 3273012203880002 | Budi Santoso | 081200000002 | budi.santoso@example.test | 1234567802 |
| CUST-000103 | 3273016507950003 | Sari Dewi | 081200000003 | sari.dewi@example.test | 1234567803 |

Saat pendaftaran (A5), NIK, nama, HP, dan rekening dari tabel ini disimpan di `identity_vault` dalam bentuk ciphertext. Dump privacy-db tidak boleh menampilkan satu pun nilai di atas sebagai teks biasa.

### Permintaan transaksi dari klien, 05/10/2026

| transaction\_id | customer\_id | Rekening | Merchant | Nominal (Rp) | Waktu | Geohash | Skenario |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TX-10001 | CUST-000101 | 1234567801 | MRC-001 | 35.000 | 12:05:02 | qqgu4 | Normal, di bawah ambang fraud |
| TX-10002 | CUST-000102 | 1234567802 | MRC-002 | 8.000.000 | 02:47:10 | qqt8h | Mencurigakan: nominal besar, dini hari, lokasi baru |
| TX-10003 | CUST-000103 | 1234567803 | MRC-003 | 1.500.000 | 14:10:01 | qqgu4 | Lolos fraud, token kedaluwarsa di tengah proses lalu diterbitkan ulang |

### privacy-db: `pseudonym_mapping`

Kolom subjek sebenarnya terenkripsi; di sini dibuka untuk ilustrasi. Status ditampilkan per 06/10 14:53.

| id | subject | pseudonym | service\_id | purpose | tx | created\_at | expires\_at | status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| m01 | CUSTOMER:CUST-000101 | PSEU-8F29A7C1 | TRANSACTION | PAYMENT\_PROCESSING | TX-10001 | 05/10 12:05:02 | 05/10 12:20:02 | expired |
| m02 | ACCOUNT:1234567801 | PSEU-71D92C0E | TRANSACTION | PAYMENT\_PROCESSING | TX-10001 | 05/10 12:05:02 | 05/10 12:20:02 | expired |
| m03 | CUSTOMER:CUST-000101 | PSEU-4FE1B3A9 | NOTIFICATION | NOTIFICATION | TX-10001 | 05/10 12:05:04 | 05/10 12:20:04 | expired |
| m04 | CUSTOMER:CUST-000102 | PSEU-2B7E5D10 | TRANSACTION | PAYMENT\_PROCESSING | TX-10002 | 05/10 02:47:10 | 05/10 03:02:10 | expired |
| m05 | ACCOUNT:1234567802 | PSEU-90AC3E77 | TRANSACTION | PAYMENT\_PROCESSING | TX-10002 | 05/10 02:47:10 | 05/10 03:02:10 | expired |
| m06 | CUSTOMER:CUST-000102 | PSEU-7BCD04F2 | FRAUD | FRAUD\_DETECTION | TX-09871 | 28/09 11:20:08 | 28/10 11:20:08 | revoked |
| m07 | CUSTOMER:CUST-000102 | PSEU-D51A88E6 | NOTIFICATION | NOTIFICATION | TX-10002 | 05/10 02:47:15 | 05/10 03:02:15 | expired |
| m08 | CUSTOMER:CUST-000103 | PSEU-A64C19B8 | TRANSACTION | PAYMENT\_PROCESSING | TX-10003 | 05/10 14:10:01 | 05/10 14:25:01 | expired |
| m09 | ACCOUNT:1234567803 | PSEU-3E08F5D4 | TRANSACTION | PAYMENT\_PROCESSING | TX-10003 | 05/10 14:10:01 | 05/10 14:25:01 | expired |
| m10 | CUSTOMER:CUST-000103 | PSEU-E2F6A013 | FRAUD | FRAUD\_DETECTION | TX-09902 | 29/09 16:40:11 | 29/10 16:40:11 | active |
| m11 | CUSTOMER:CUST-000103 | PSEU-5A83F0B7 | TRANSACTION | PAYMENT\_PROCESSING | TX-10003 | 05/10 14:27:10 | 05/10 14:42:10 | expired |
| m12 | ACCOUNT:1234567803 | PSEU-C07B91E5 | TRANSACTION | PAYMENT\_PROCESSING | TX-10003 | 05/10 14:27:10 | 05/10 14:42:10 | expired |
| m13 | CUSTOMER:CUST-000103 | PSEU-58B7C9AE | NOTIFICATION | NOTIFICATION | TX-10003 | 05/10 14:28:05 | 05/10 14:43:05 | expired |
| m14 | CUSTOMER:CUST-000101 | PSEU-C3A91F55 | NOTIFICATION | NOTIFICATION\_REGISTRATION | — | 20/09 08:15:00 | 20/09/2027 08:15 | active |
| m15 | CUSTOMER:CUST-000102 | PSEU-0E94B7D2 | NOTIFICATION | NOTIFICATION\_REGISTRATION | — | 22/09 10:40:00 | 22/09/2027 10:40 | active |
| m16 | CUSTOMER:CUST-000103 | PSEU-6D12E4A0 | NOTIFICATION | NOTIFICATION\_REGISTRATION | — | 25/09 19:05:00 | 25/09/2027 19:05 | active |
| m17 | ACCOUNT:1234567801 | PSEU-B80D2C4F | RECONCILIATION | DAILY\_RECONCILIATION | TX-10001 | 06/10 00:10:05 | 07/10 00:10:05 | active |
| m18 | ACCOUNT:1234567803 | PSEU-C47F5B02 | RECONCILIATION | DAILY\_RECONCILIATION | TX-10003 | 06/10 00:10:06 | 07/10 00:10:06 | active |
| m19 | CUSTOMER:CUST-000102 | PSEU-6C3F8A21 | RECONCILIATION | INTERNAL\_AUDIT | TX-10002 | 06/10 09:30:12 | 06/10 09:40:12 | expired |

Beberapa hal yang perlu diperhatikan. Pelanggan yang sama memegang token berbeda di tiap layanan, misalnya CUST-000102 pada m04, m06, dan m07. Baris m08 dan m11 memakai kombinasi subjek, layanan, dan tujuan yang identik, sehingga constraint unik harus parsial dengan klausa `WHERE status = 'active'`. Baris m06 berstatus `revoked` karena dicabut admin pada baris audit a04. Baris m06 dan m10 diterbitkan sebelum 05/10 (28/09 dan 29/09) dengan TTL 30 hari, sehingga pertukaran pada 05/10 menghasilkan REUSED\_ACTIVE (a01 dan a08) dan riwayat awal h01 dan h02 sudah ada di fraud-db. Baris m10 masih aktif, sehingga upaya Fraud membukanya pada a11 ditolak POLICY\_NOT\_ALLOWED, bukan EXPIRED.

### privacy-db: `transaction_status`

| transaction\_id | status | updated\_at |
| --- | --- | --- |
| TX-10001 | COMPLETED | 05/10 12:05:08 |
| TX-10002 | IN\_PROGRESS, setara HELD di transaction-db | 05/10 02:47:18 |
| TX-10003 | COMPLETED | 05/10 14:28:04 |

### transaction-db

| merchant\_id | Nama | Kategori | QRIS ID |
| --- | --- | --- | --- |
| MRC-001 | Warung Kopi Nusa | Kuliner | ID.QRIS.0001 |
| MRC-002 | Toko Elektronik Mega | Elektronik | ID.QRIS.0002 |
| MRC-003 | Toko Gadget Prima | Elektronik | ID.QRIS.0003 |

| transaction\_id | customer\_pseudonym | account\_pseudonym | merchant | Nominal (Rp) | Status | created\_at | completed\_at |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TX-10001 | PSEU-8F29A7C1 | PSEU-71D92C0E | MRC-001 | 35.000,00 | COMPLETED | 05/10 12:05:02 | 05/10 12:05:08 |
| TX-10002 | PSEU-2B7E5D10 | PSEU-90AC3E77 | MRC-002 | 8.000.000,00 | HELD | 05/10 02:47:10 | — |
| TX-10003 | PSEU-5A83F0B7 | PSEU-C07B91E5 | MRC-003 | 1.500.000,00 | COMPLETED | 05/10 14:10:01 | 05/10 14:28:04 |

TX-10003 memakai token hasil re-issue, yaitu m11 dan m12, bukan token awal m08 dan m09 yang kedaluwarsa pukul 14:25:01 saat transaksi masih berjalan.

Kolom baru pada transaksi uji: TX-10001 tidak memiliki `risk_score` maupun `fraud_decision` karena tidak dikirim ke Fraud; TX-10002 memiliki skor 75,00 dan keputusan HOLD\_FOR\_VERIFICATION; TX-10003 memiliki skor 10,00 dan keputusan ALLOW. Setiap transaksi membawa `idempotency_key` unik dari klien. Kolom `reviewed_by` dan `reviewed_at` kosong sampai analis menyelesaikan transaksi yang HELD.

### fraud-db

| id | pseudonym | Nominal (Rp) | Jam | Geohash | Riwayat | Rata-rata sebelumnya (Rp) | Skor | Keputusan | assessed\_at |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| h01 | PSEU-7BCD04F2 | 2.000.000,00 | 13 | qqgu7 | 0 | — | 10,00 | ALLOW | 28/09 11:20:10 |
| h02 | PSEU-E2F6A013 | 1.200.000,00 | 16 | qqgu4 | 0 | — | 10,00 | ALLOW | 29/09 16:40:13 |
| f01 | PSEU-7BCD04F2 | 8.000.000,00 | 2 | qqt8h | 1 | 2.000.000,00 | 75,00 | HOLD\_FOR\_VERIFICATION | 05/10 02:47:13 |
| f02 | PSEU-E2F6A013 | 1.500.000,00 | 14 | qqgu4 | 1 | 1.200.000,00 | 10,00 | ALLOW | 05/10 14:10:04 |

| rule | Parameter | Bobot |
| --- | --- | --- |
| AMOUNT\_OVER\_THRESHOLD | 1.000.000 | 10 |
| AMOUNT\_OVER\_3X\_AVG | pengali 3,00 terhadap rata-rata asesmen sebelumnya | 25 |
| ODD\_HOUR\_OUTSIDE\_06\_22 | di luar 06:00 sampai 22:00 | 20 |
| NEW\_LOCATION\_VS\_LAST\_3 | geohash berbeda dari 3 asesmen terakhir pada token yang sama | 20 |

Batas keputusan: ALLOW di bawah 50; HOLD\_FOR\_VERIFICATION 50 sampai 89; BLOCK 90 ke atas. Baris h01 dan h02 adalah riwayat awal (seed) yang dinilai sebelum 05/10, tepat setelah token Fraud masing-masing pertama kali terbit (m06 dan m10). Keduanya cold start, sehingga hanya aturan nominal dan jam yang dievaluasi, dan keduanya berskor 10. Skor f01 sebesar 75 berasal dari empat aturan yang semuanya terpicu, yaitu 10 + 25 + 20 + 20: nominal 8.000.000 lebih dari tiga kali rata-rata sebelumnya 2.000.000, dan lokasi qqt8h berbeda dari qqgu7. Skor f02 sebesar 10 berasal dari satu aturan, karena 1.500.000 kurang dari tiga kali 1.200.000 dan lokasi qqgu4 sama dengan asesmen sebelumnya. TX-10001 tidak memiliki baris karena nominalnya di bawah ambang dan tidak dikirim ke Fraud.

Perhatikan bahwa token Fraud pada f01, yaitu PSEU-7BCD04F2, berbeda dari token Transaction untuk orang yang sama, yaitu PSEU-2B7E5D10. Inilah yang membuat fraud-db tidak dapat dijoin langsung ke transaction-db.

### notification-db

| pseudonym | HP | Channel | registered\_at |
| --- | --- | --- | --- |
| PSEU-C3A91F55 | 081200000001 | SMS | 20/09/2026 |
| PSEU-0E94B7D2 | 081200000002 | SMS | 22/09/2026 |
| PSEU-6D12E4A0 | 081200000003 | SMS | 25/09/2026 |

| id | sender\_pseudonym | recipient\_pseudonym | Template | Channel | sent\_at | Status |
| --- | --- | --- | --- | --- | --- | --- |
| n01 | PSEU-4FE1B3A9 | PSEU-C3A91F55 | TX\_COMPLETED | SMS | 05/10 12:05:10 | SENT |
| n02 | PSEU-D51A88E6 | PSEU-0E94B7D2 | TX\_HELD\_VERIFY | SMS | 05/10 02:47:20 | SENT |
| n03 | PSEU-58B7C9AE | PSEU-6D12E4A0 | TX\_COMPLETED | SMS | 05/10 14:28:08 | SENT |

`contact_registry` adalah satu-satunya tempat nomor HP asli disimpan di luar Keycloak, dan itu pengecualian yang disengaja pada alur A.

### reconciliation-db

| batch\_id | Tanggal | Jumlah transaksi | Total (Rp) | Status | created\_at |
| --- | --- | --- | --- | --- | --- |
| B-20261005 | 05/10/2026 | 2 | 1.535.000,00 | MATCHED | 06/10 00:10:00 |

| id | batch\_id | account\_pseudonym | Nominal (Rp) | bank\_reference | Cocok |
| --- | --- | --- | --- | --- | --- |
| i01 | B-20261005 | PSEU-B80D2C4F | 35.000,00 | BNK-20261005-0001 | ya |
| i02 | B-20261005 | PSEU-C47F5B02 | 1.500.000,00 | BNK-20261005-0002 | ya |

TX-10002 yang berstatus HELD tidak masuk batch, sehingga total batch adalah 35.000 ditambah 1.500.000 sama dengan 1.535.000.

### Catatan Keycloak dan Kong

keycloak-db menyimpan data pengguna mentah, yaitu nama, email, HP, dan NIK, dan hanya diakses Auth Service. kong-db hanya berisi konfigurasi route dan plugin, tanpa data pribadi.

## 17. Tech stack dan konfigurasi

| Komponen | Pilihan | Alasan |
| --- | --- | --- |
| Bahasa dan framework | TypeScript dengan NestJS | Struktur modul yang seragam antar-layanan memudahkan perbandingan kode baseline dan proposed |
| Basis data | PostgreSQL 16, satu instans per layanan | Dukungan partial unique index, enum, dan `gen_random_uuid()` yang dipakai skema |
| API Gateway | Kong | Rate limiting dan plugin JWT tersedia tanpa kode tambahan; tokenisasi memakai satu plugin kustom (Lua) yang memanggil Privacy Service |
| Identity provider | Keycloak | Service account dan peran auditor dan admin tanpa membangun sendiri |
| Kriptografi | Node `crypto`: HMAC-SHA256 dan AES-256-GCM | Pustaka standar, tidak menambah dependensi yang harus dipertanggungjawabkan |
| Orkestrasi | Docker Compose | Satu perintah untuk menjalankan seluruh sistem di satu VPS |
| Uji fungsional | Postman dan Newman | Koleksi dapat dijalankan berulang dan dilampirkan sebagai bukti |
| Uji performa | k6 | Skrip berbentuk kode, hasilnya terstruktur dan dapat diulang |
| Observability | Prometheus dan Grafana | Pengambilan metrik latensi per endpoint |

&#91;embedded content: deployment diagram · single VPS, 3 networks\]

Diagram deployment. Semua kontainer berada pada satu VPS, sehingga latensi antar-layanan lebih kecil daripada penyebaran terdistribusi. Hal ini dicatat sebagai keterbatasan di Bagian 20.

### Dua mode perbandingan

Perbandingan hanya sahih jika kode bisnisnya identik. Selain dua mode utama di tabel ini, Bab Metodologi v6 memakai satu nilai tambahan: PRIVACY\_MODE=static, yaitu token HMAC atas subject\_id saja yang dipakai bersama semua layanan, khusus untuk uji penautan. Karena itu mode diatur lewat satu variabel lingkungan, bukan lewat dua basis kode.

| Aspek | `PRIVACY_MODE=baseline` | `PRIVACY_MODE=proposed` |
| --- | --- | --- |
| Privacy Service | Tidak dipanggil | Dipanggil pada setiap titik tokenisasi |
| Payload ke layanan hilir | `customer_id`, nomor rekening, NIK, nama | Token saja |
| Skema basis data hilir | Kolom identitas | Kolom pseudonim |
| Policy Engine | Nonaktif | Aktif |
| Audit log | Tidak ada | Penuh |
| Logika bisnis | Identik | Identik |

### Variabel lingkungan utama

```
PRIVACY_MODE=proposed            # baseline | proposed
PSEUDONYM_HMAC_SECRET=...        # hanya di kontainer privacy-service
PSEUDONYM_KEY_VERSION=1
BLIND_INDEX_SECRET=...           # K_index, hanya di privacy-service
FIELD_ENCRYPTION_KEY=...         # AES-256-GCM, hanya di privacy-service
GRACE_PERIOD_SECONDS=30
TTL_PAYMENT_PROCESSING=900
TTL_FRAUD_DETECTION=2592000
TTL_NOTIFICATION=900
TTL_NOTIFICATION_REGISTRATION=31536000
TTL_DAILY_RECONCILIATION=86400
TTL_INTERNAL_AUDIT=600
FRAUD_AMOUNT_THRESHOLD=1000000
FRAUD_ODD_HOUR_START=22
FRAUD_ODD_HOUR_END=6
HTTP_TIMEOUT_MS=3000
HTTP_MAX_RETRY=2
TX_PENDING_TIMEOUT_SECONDS=300
RATE_LIMIT_PER_MINUTE=100
RETENTION_DAYS=90                # pengosongan kolom identitas mapping; parameter ditetapkan sendiri
RATE_LIMIT_ENABLED=true          # false pada uji performa, identik pada kedua mode
TZ=UTC
```

Seluruh nilai TTL dan ambang fraud dijadikan variabel agar eksperimen dapat mengubahnya tanpa menyentuh kode, dan agar nilai yang dipakai saat pengukuran dapat dilampirkan di naskah.

## 18. Rencana pengujian

Empat jenis pengujian, masing-masing memiliki kriteria lolos yang terukur. Catatan cakupan: kasus TF-09, TF-10, dan TF-13 (peninjauan Fraud Analyst dan laporan settlement bank) tetap dikerjakan sebagai uji fungsional pendukung, tetapi alur C4 dan D3 tidak termasuk dalam evaluasi paparan, penautan, dan performa pada Bab Metodologi v6.

### 18.1 Pengujian fungsional

| Kasus | Masukan | Harapan |
| --- | --- | --- |
| TF-01 | Pendaftaran akun | 201, satu baris `contact_registry` berkunci pseudonim |
| TF-02 | TX-10001 transaksi normal | COMPLETED, satu notifikasi terkirim, tidak ada baris fraud |
| TF-03 | TX-10002 transaksi mencurigakan | HELD, satu baris `fraud_assessments` dengan skor 75 |
| TF-04 | TX-10003 token kedaluwarsa di tengah proses | COMPLETED dengan token hasil re-issue, bukan gagal |
| TF-05 | Rekonsiliasi harian | Satu batch berisi dua item, status MATCHED |
| TF-06 | Permintaan audit internal | `subject_id` dikembalikan, satu baris DE\_PSEUDONYMIZE SUCCESS |
| TF-07 | Idempotensi penerbitan | Panggilan kedua mengembalikan token sama dengan `reused: true` |
| TF-08 | Pengulangan POST /transaction dengan Idempotency-Key yang sama | Satu transaksi dan respons 200 berisi isi yang sama; kunci sama dengan isi berbeda menghasilkan 409 |
| TF-09 | Transaksi HELD disetujui Fraud Analyst | COMPLETED, reviewed\_by terisi, status di Privacy diperbarui, notifikasi TX\_COMPLETED terkirim |
| TF-10 | Transaksi HELD ditolak Fraud Analyst | FAILED, notifikasi TX\_REJECTED terkirim, tidak ikut batch rekonsiliasi |
| TF-11 | Fraud dimatikan saat transaksi di atas ambang | HELD dengan keputusan FRAUD\_UNAVAILABLE, notifikasi TX\_HELD\_VERIFY terkirim |
| TF-12 | Asesmen pertama pada token Fraud baru, lalu asesmen kedua | Pertama: rules\_skipped berisi dua aturan; kedua: memakai riwayat dan prior\_count 1 |
| TF-13 | Laporan settlement bank berisi rekening mentah | Token sama dengan hasil alur D2, reconciliation-db tanpa nomor rekening; laporan tidak valid menghasilkan 422 |
| TF-14 | Job retensi dijalankan pada data berumur lebih dari 90 hari | Kolom identitas kosong dan purged\_at terisi, satu baris audit PURGE\_IDENTITY per baris, query pemeriksaan retensi nol baris |
| TF-15 | Penerbitan ulang konteks yang sama setelah TTL habis | Berhasil tanpa pelanggaran unique index |
| TF-16 | Rekonsiliasi dipicu manual untuk satu tanggal | Batch terbentuk dan statusnya sesuai hasil pencocokan |
| TF-17 | Transaksi PENDING melewati batas waktu | Ditandai FAILED oleh job pembersih |

### 18.2 Pengukuran paparan PII

Ini metrik utama skripsimu. Hitung per layanan dan per kelas data, bukan satu angka total.

&#91;embedded content: PII exposure · baseline vs proposed\]

Contoh bentuk hasil pengukuran: jumlah kolom identitas mentah per layanan pada kedua mode. Angka akhir tetap harus diambil dari pengukuran sebenarnya. Metrik utama yang dilaporkan di Bab Metodologi v6 adalah rasio paparan E(s), yaitu jumlah jenis pengenal langsung yang diterima layanan s dibagi enam jenis (nama, NIK, nomor HP, email, nomor rekening, customer\_id), diverifikasi dengan nilai kenari. Jumlah kolom pada tabel di bawah menjadi bukti pendukung dari inspeksi skema. Nilai harapan pada mode proposed: Transaction, Fraud, dan Reconciliation 0, Notification 1/6 (nomor HP, pengecualian yang disengaja); jalur audit E3 dilaporkan terpisah sebagai paparan terkontrol.

| Variabel | Definisi | Cara ukur |
| --- | --- | --- |
| Jumlah field identitas per layanan | Banyaknya kolom yang memuat identitas langsung atau tidak langsung | Inspeksi skema setelah uji beban |
| Jumlah layanan yang memegang identitas | Banyaknya basis data yang memuat sekurangnya satu field identitas | Inventaris skema |
| Paparan field spesifik | Khusus nomor rekening dan data keuangan | Dipisahkan dari field umum |
| Kebocoran lewat log | Jumlah temuan pola NIK, HP, dan rekening di seluruh log kontainer | Pemindaian nilai kenari: nilai unik per atribut pengenal dicocokkan persis di payload, basis data, dan log |
| Keterkaitan lintas layanan | Dapat tidaknya dua basis data dijoin lewat pseudonim bersama | Query join percobaan |

Kriteria lolos: pada mode proposed, jumlah field identitas di Transaction, Fraud, dan Reconciliation adalah nol; kebocoran lewat log adalah nol; dan query join lintas layanan tidak menghasilkan baris.

### 18.3 Pengujian keamanan dan kontrol akses

| Kasus | Skenario | Harapan |
| --- | --- | --- |
| TK-01 | Notification memakai token milik Fraud | 403 SERVICE\_MISMATCH |
| TK-02 | Reconciliation membuka token DAILY\_RECONCILIATION dengan purpose INTERNAL\_AUDIT | 403 PURPOSE\_MISMATCH |
| TK-03 | Pemakaian token setelah TTL dan grace habis | 410 EXPIRED |
| TK-04 | Pemakaian token yang telah dicabut | 403 REVOKED |
| TK-05 | Token acak yang tidak pernah diterbitkan | 404 TOKEN\_NOT\_FOUND |
| TK-06 | Permintaan purpose di luar whitelist | 403 POLICY\_NOT\_ALLOWED, tanpa baris mapping |
| TK-07 | Transaction mengirim `subject_id` mentah | 403 POLICY\_NOT\_ALLOWED |
| TK-08 | De-pseudonimisasi tanpa peran auditor | 403 FORBIDDEN\_ROLE |
| TK-09 | Re-issue pada transaksi COMPLETED | 409 TX\_TERMINAL |
| TK-10 | Percobaan UPDATE pada `audit_log` oleh akun aplikasi | Gagal di tingkat hak akses basis data |
| TK-11 | Lonjakan permintaan melebihi kuota | 429 di Gateway |
| TK-12 | Perbandingan respons token ada dan tidak ada | Bentuk respons identik dari sisi klien |
| TK-13 | FRAUD menukar token ke NOTIFICATION | 403 POLICY\_NOT\_ALLOWED meski token sumber valid |
| TK-14 | FRAUD meminta token ACCOUNT | 403 POLICY\_NOT\_ALLOWED |
| TK-15 | FRAUD membuka token FRAUD\_DETECTION miliknya sendiri | 403 POLICY\_NOT\_ALLOWED karena P3 tidak boleh dibuka |
| TK-16 | Privacy Service dimatikan saat klien mengirim transaksi | 503 SERVICE\_UNAVAILABLE, tidak ada data mentah yang diteruskan |
| TK-17 | Cabut seluruh token satu subjek, lalu pakai salah satunya | Semua revoked, pemakaian menghasilkan REVOKED, jumlah dikembalikan dan tercatat |
| TK-18 | Pemindaian repositori dan image untuk secret | Nol temuan |
| TK-19 | JWT kedaluwarsa atau tidak ada | 401 UNAUTHENTICATED di Kong |
| TK-20 | Transaction memanggil /identity | 403 POLICY\_NOT\_ALLOWED, tidak ada baris brankas baru |
| TK-21 | Auditor membuka token P7 dengan permintaan pembukaan APPROVED atas atribut nama | 200 dengan nama saja; customer\_id, NIK, HP, dan rekening tidak ada di respons; status permintaan menjadi USED |
| TK-22 | Auditor menjalankan audit rutin (POST /reconciliation/audit-request) | 200 berisi token P7 dan data transaksi; pemindaian kenari tidak menemukan customer\_id, NIK, atau nama |
| TK-23 | De-pseudonimisasi token P7 tanpa disclosure\_id atau dengan permintaan PENDING | 403 DISCLOSURE\_NOT\_APPROVED, tercatat DENIED |
| TK-24 | Admin yang sama dengan pemohon menyetujui permintaannya sendiri | 403 SELF\_APPROVAL, status tetap PENDING |
| TK-25 | Pengguna tanpa peran admin menyetujui permintaan | 403 FORBIDDEN\_ROLE |
| TK-26 | Persetujuan dipakai kedua kali, atau dipakai setelah 600 detik | 403 DISCLOSURE\_NOT\_APPROVED (status USED) atau 410 DISCLOSURE\_EXPIRED |
| TK-27 | Permintaan pembukaan dengan dasar di luar Tabel 6, atau atribut di luar Tabel 5 | 422 INVALID\_BASIS atau 422 ATTRIBUTE\_NOT\_ALLOWED, tidak ada baris disclosure\_request |
| TK-28 | Auditor B memakai permintaan yang disetujui milik auditor A | 403 REQUESTER\_MISMATCH |

Kriteria lolos: kedua puluh satu kasus menghasilkan kode dan reason yang tepat. Penolakan oleh Privacy Service menghasilkan tepat satu baris audit DENIED, sedangkan penolakan di Gateway (TK-11 dan TK-19) dicatat di log Kong.

### 18.4 Pengujian performa

| Variabel | Nilai |
| --- | --- |
| Alat | k6 |
| Beban | 100 virtual user, ramp-up 30 detik, tahan 5 menit |
| Skenario | Campuran 70% transaksi normal dan 30% transaksi mencurigakan |
| Metrik | p50, p95, p99 latensi end-to-end; RPS; tingkat kesalahan |
| Pengulangan | 5 kali per mode, dengan jeda 2 menit dan reset basis data di antara run |
| Ambang latensi | Kenaikan p95 ≤ 20% |
| Ambang throughput | Penurunan ≤ 15% |
| Ambang kesalahan | Di bawah 1% pada kedua mode |
| Rate limiting | Dinonaktifkan pada kedua mode saat pengukuran; nilai 100 per menit dipulihkan hanya untuk TK-11 |
| Perangkat keras | VPS dengan paling sedikit 4 vCPU, 8 GB RAM, dan SSD; spesifikasi aktual, versi OS, dan versi Docker dicatat di naskah |
| Pembangkit beban | k6 dari mesin terpisah bila tersedia; bila di VPS yang sama, k6 dibatasi pada inti CPU tersendiri dan hal itu dicatat sebagai keterbatasan |
| Pemanasan | 60 detik pertama setiap run dibuang dari perhitungan |
| Data awal | 1.000 pelanggan sintetis dengan riwayat Fraud awal (seed), dipulihkan ke keadaan yang sama sebelum setiap run |
| Urutan run | Bergantian: baseline, proposed, baseline, proposed, dan seterusnya, agar penyimpangan akibat kondisi VPS tidak menumpuk pada satu mode |
| Statistik | Per run dihitung p50, p95, p99, RPS, dan tingkat kesalahan; antar run dilaporkan rerata, simpangan baku, dan interval kepercayaan 95% (distribusi t, 4 derajat kebebasan) |
| Pelaporan | Angka mentah per run dilampirkan; bila batas atas interval kepercayaan melewati ambang, hal itu ditulis sebagai temuan, bukan disembunyikan |

Ukur juga latensi internal `/pseudonymize` secara terpisah, agar kamu dapat menjelaskan berapa bagian dari overhead yang berasal dari Privacy Service dan berapa dari hop jaringan tambahan. Tanpa pemisahan ini, angka overhead sulit dipertahankan saat ditanya penyebabnya.

Dua catatan untuk naskah. Ambang 20% dan 15% adalah parameter yang kamu tetapkan sendiri, bukan standar industri. Seluruh kontainer berjalan di satu VPS, sehingga latensi antar-layanan jauh lebih kecil daripada penyebaran terdistribusi nyata, dan angka overhead yang dihasilkan cenderung optimistis. Nyatakan keduanya di bagian keterbatasan.

### 18.5 Keterlacakan kebutuhan ke pengujian

Tabel berikut memastikan tidak ada kebutuhan tanpa pembuktian. Kebutuhan yang dibuktikan oleh pengukuran atau inspeksi, bukan kasus uji, ditunjukkan dengan bagian atau metodenya.

| Kebutuhan | Dibuktikan oleh |
| --- | --- |
| FR-01, NFR-21 | TK-19 |
| FR-02, FR-03, FR-38 | TF-02, inspeksi payload keluar Gateway (18.2), TK-16 |
| FR-04, FR-27, FR-28 | TK-06, TK-13, TK-14 |
| FR-05, FR-06, NFR-13 | TF-07 |
| FR-07 | TK-07 |
| FR-08, FR-19, FR-20 | TF-01, TF-02 |
| FR-09, FR-22 | TF-06, TK-08, TK-15 |
| FR-10, FR-11, FR-33 | TF-04, TF-15, TK-09 |
| FR-12, FR-29 | TK-04, TK-17 |
| FR-13, FR-14, FR-15, NFR-09 | TK-10, pencocokan jumlah baris audit dengan jumlah panggilan, pemindaian PII pada audit\_log |
| FR-16, FR-18, FR-21 | Pengukuran paparan PII dan query join percobaan (18.2) |
| FR-17 | TF-02 (baris transaction\_status terisi) |
| FR-23, FR-24 | M5 dan skrip pengukuran (18.2) |
| FR-25, NFR-05, NFR-22 | Inspeksi dump basis data, TK-18 |
| FR-26, NFR-08 | TK-11 |
| FR-30 | Inspeksi konfigurasi tiga kunci |
| FR-31, NFR-18 | TF-14 |
| FR-32 | TF-13 |
| FR-34, FR-35 | TF-09, TF-10 |
| FR-36, NFR-23 | TF-08 |
| FR-37 | TF-03, TF-12 |
| FR-39 | TF-17 |
| FR-40, NFR-24 | TF-11 |
| FR-41 | TF-16 |
| NFR-01 sampai NFR-04 | Pengujian performa (18.4) |
| NFR-06, NFR-07, NFR-12 | Inspeksi konfigurasi, pencarian pola pada log, uji injeksi keterlambatan |
| NFR-10 | TK-05, TK-12 |
| NFR-11 | TK-16 |
| NFR-14 sampai NFR-17 | Scrape manual, pemindai log, inventaris skema |
| NFR-19, NFR-20 | Uji dari mesin bersih, pemeriksaan jam tiap kontainer |
| NFR-25 | Validasi skema JSON pada koleksi Postman |
| FR-42, FR-43, FR-44 | TK-20, TK-21, TK-17 (brankas kosong setelah pencabutan), inspeksi dump identity\_vault |

## 19. Rencana pengembangan

&#91;embedded content: rencana milestone · 9 tahap, 1 gerbang\]

Tanggal mulai bersifat indikatif; yang mengikat adalah urutan dan gerbangnya. M5 adalah gerbang penting: pengukuran apa pun sebelum kedua mode berjalan akan menghasilkan perbandingan yang tidak sahih.

| Milestone | Keluaran | Kriteria selesai |
| --- | --- | --- |
| M0 | Repositori, Docker Compose, kerangka tujuh layanan, skema basis data | `docker compose up` menyalakan seluruh layanan dan `/health` hijau |
| M1 | Keycloak, service account, peran, Kong dengan validasi JWT dan rate limiting | Permintaan tanpa JWT valid ditolak 401, lonjakan ditolak 429 |
| M2 | Privacy Service: `/pseudonymize`, enkripsi field, partial unique index, re-issue, job retensi, plugin privacy-tokenizer di Kong | Satu subjek menghasilkan token berbeda per layanan; re-issue berhasil |
| M3 | Policy Evaluation Engine, `audit_log` append-only, `/audit-log`, `/de-pseudonymize` lima gerbang, /disclosure-requests | Kasus keamanan yang bergantung pada Privacy Service (TK-01 sampai TK-10, TK-13 sampai TK-15) ditolak dengan reason yang tepat |
| M4 | Transaction (idempotensi, review transaksi HELD), Fraud (profil riwayat), Notification, Reconciliation pada mode proposed | Tiga skenario transaksi lulus ujung ke ujung |
| M5 | Mode baseline dengan logika bisnis identik | Satu variabel lingkungan mengalihkan mode tanpa perubahan kode |
| M6 | Koleksi Postman, skrip pemindai PII, berkas Newman | Seluruh kasus fungsional dan keamanan lulus pada kedua mode |
| M7 | Skrip k6, lima pengulangan per mode, tabel paparan PII | Data mentah hasil pengukuran lengkap dan dapat diulang |
| M8 | Analisis hasil, tabel perbandingan, penulisan Bab IV dan V | Seluruh klaim di naskah tertaut ke data pengukuran |

## 20. Risiko, keterbatasan, dan pertanyaan terbuka

### Risiko teknis

| Risiko | Dampak | Mitigasi |
| --- | --- | --- |
| Privacy Service menjadi bottleneck pada beban tinggi | Overhead latensi melebihi ambang 20% | Indeks pada kolom pencarian, connection pooling, pengukuran latensi internal secara terpisah |
| Partial unique index terlewat saat implementasi | Re-issue gagal di INSERT, dan kegagalannya baru terlihat saat uji beban | Masukkan TF-04 ke pengujian wajib sejak M2 |
| Selisih jam antar-kontainer | Token ditolak EXPIRED secara keliru | Seluruh kontainer memakai UTC, grace period 30 detik |
| Kebocoran PII lewat log aplikasi | Metrik paparan PII tidak nol | Skrip pemindai sebagai bagian pipeline pengujian, bukan pemeriksaan manual di akhir |
| Semua kontainer di satu VPS | Angka overhead optimistis | Dinyatakan sebagai keterbatasan, bukan ditutupi |
| Waktu pengerjaan melebihi jadwal | Bab IV tidak selesai | M5 sebagai gerbang; jika mundur, kurangi cakupan pengujian opsional, bukan cakupan keamanan |
| Plugin kustom Kong (Lua) memakan waktu di luar perkiraan | M2 mundur dan tokenisasi Gateway tertunda | Spike satu hari di awal M1; cadangan berupa layanan tipis gateway-adapter di zona Gateway dengan perilaku sama |
| Profil Fraud jarang terbentuk karena token berganti atau transaksi di atas ambang sedikit | Aturan rata-rata dan lokasi jarang terpicu, sehingga demonstrasi fraud lemah | Data uji dan skrip k6 memakai kumpulan pelanggan tetap dengan riwayat awal (seed); hasil dilaporkan apa adanya |
| Pembangkit beban berbagi VPS dengan sistem yang diukur | Angka latensi dan throughput bias | k6 dibatasi pada inti CPU tersendiri atau dijalankan dari mesin terpisah; cara yang dipakai dicatat |

### Asumsi

1. Gateway melakukan tokenisasi lebih dulu, dan layanan hilir meminta token baru dengan menyerahkan token miliknya.
2. `audit_log` memakai `mapping_id` dan `actor_id`, bukan `subject_id`.
3. Tabel `pseudonym_mapping` memiliki kolom `subject_type` karena rekening juga dipseudonimkan.
4. Status `HELD` di transaction-db dicatat sebagai `IN_PROGRESS` di `transaction_status`.
5. Nomor rekening pada laporan settlement bank diganti token sebelum sampai ke Reconciliation.
6. Seluruh data uji bersifat fiktif.
7. Saldo dan ledger dompet tidak dimodelkan: debit dan kredit pada langkah B5 disimulasikan, dan kepemilikan rekening sumber tidak diverifikasi.
8. Penyedia SMS dan bank mitra disimulasikan oleh simulator, bukan layanan nyata.

### Keterbatasan penelitian

1. Teknik ini tergolong *regular pseudonymization*, bukan *blind* atau *polymorphic*. Privacy Service mengetahui identitas asli.
2. Pseudonimisasi bersifat semi-dinamis. Token aktif digunakan ulang dalam jendela TTL, sehingga linkability masih mungkin di dalam jendela itu.
3. Keycloak menyimpan identitas login mentah, dan Notification menyimpan nomor HP. Keduanya di luar cakupan pseudonimisasi.
4. Layanan pemanggil sempat memegang dua token domain berbeda saat pertukaran token berlangsung.
5. Serangan korelasi berbasis atribut, misalnya kombinasi nominal, jam, dan lokasi, tidak ditangani rancangan ini.
6. Ambang 20% dan 15% adalah parameter yang ditetapkan sendiri, bukan standar industri.
7. `subject_lookup` adalah pseudonim statis internal yang diperlukan agar pencarian mapping tetap mungkin di atas kolom terenkripsi. ID pelanggan berurutan berentropi rendah, sehingga kerahasiaan `K_index` krusial, dan rotasinya hanya berupa prosedur tertulis.
8. Retensi 90 hari adalah parameter yang ditetapkan sendiri. Setelah kolom identitas dikosongkan, identitas tidak dapat dibuka lagi dan rekonsiliasi atas transaksi lama tidak mungkin.
9. Policy Engine hanya memvalidasi kombinasi layanan dan tujuan; ia tidak dapat memverifikasi bahwa layanan benar-benar sedang menjalankan proses bisnis yang diklaim. Layanan yang diretas dapat meminta tujuan sah mana pun untuk dirinya, dan whitelist yang sempit serta audit log yang membatasi kerusakannya.
10. Fraud memegang profil perilaku (nominal, jam, lokasi) di bawah satu token berumur 30 hari. Jendela keterkaitan di Fraud karenanya lebih panjang daripada di layanan lain, dan profil itu rawan terhadap korelasi atribut.
11. Profil Fraud hanya mencakup transaksi di atas ambang, dan terputus (cold start) setiap kali token berganti atau dicabut.
12. Notifikasi tidak dikirim ulang otomatis, dan kegagalan `PATCH /transaction-status` hanya dicatat, sehingga gerbang TX\_TERMINAL longgar untuk transaksi yang terdampak.
13. Dengan empat aturan yang ada, skor maksimum 75, sehingga ambang BLOCK 90 tidak dapat tercapai.
14. TLS antar-layanan hanya dipasang pada jalur yang membawa identitas mentah; layanan lain mengandalkan isolasi jaringan Docker.

### Pertanyaan terbuka untuk dosen pembimbing

1. Apakah modul Audit di dalam Privacy Service dapat diterima, atau penguji mengharapkan layanan audit tersendiri meski menambah hop dan melanggar aturan panggilan searah?
2. Apakah rantai hash pada audit log perlu diimplementasikan, atau cukup dijelaskan sebagai rancangan?
3. Apakah pengukuran paparan PII perlu dipisah menurut kelas data umum dan spesifik, atau cukup satu angka agregat per layanan?
4. Apakah perbandingan tiga kondisi, yaitu baseline, pseudonim statis, dan pseudonim dinamis, perlu diimplementasikan ketiganya, atau kondisi statis cukup dianalisis secara teoretis?
5. Apakah pengosongan kolom identitas setelah 90 hari dapat diterima sebagai demonstrasi minimisasi data, atau penguji mengharapkan masa retensi yang berpijak pada regulasi?
6. Apakah tujuh baris konteks pada Tabel 1 dan dua pertukaran pada Tabel 2 sudah final?
7. Apakah jendela keterkaitan 30 hari di Fraud, demi profil perilaku, dapat diterima sebagai kompromi antara privasi dan fungsi bisnis, atau profil sebaiknya dipindah ke jendela yang lebih pendek?

### Referensi yang perlu kamu verifikasi sendiri

UU No. 27 Tahun 2022 tentang Pelindungan Data Pribadi, khususnya Pasal 4 ayat (2) dan (3); EDPB Guidelines 01/2025 tentang pseudonimisasi, terutama paragraf 22; serta literatur *polymorphic* dan *blind pseudonymization* yang sudah kamu kumpulkan. Kutipan pasal dan nomor paragraf di dokumen ini berasal dari pembahasan sebelumnya dan belum diverifikasi ke dokumen aslinya, jadi periksa langsung ke PDF resmi sebelum masuk naskah.

## Lampiran A. Glosarium

| Istilah | Arti |
| --- | --- |
| Pseudonim, token | Pengenal pengganti yang diterbitkan Privacy Service untuk satu subjek pada satu konteks |
| Subjek | Pelanggan (CUSTOMER) atau rekening (ACCOUNT) yang dipseudonimkan |
| Konteks | Kombinasi layanan pemilik, tujuan, dan jenis subjek pada Tabel 1 |
| TTL | Masa berlaku token sejak diterbitkan |
| Grace period | Toleransi 30 detik setelah TTL untuk selisih jam dan permintaan yang sedang berjalan |
| Penggunaan ulang | Pengembalian token aktif yang sama untuk subjek, layanan, dan tujuan yang sama dalam jendela TTL |
| Pertukaran token | Penerbitan token baru bagi layanan lain dengan menyerahkan token sumber, tanpa subject\_id |
| Re-issue | Penerbitan ulang token yang kedaluwarsa pada transaksi yang belum terminal |
| De-pseudonimisasi | Pembukaan identitas asli dari token, hanya lewat permintaan yang disetujui admin lain, lima gerbang, dan peran auditor |
| Blind index | HMAC deterministik atas subjek (subject\_lookup) untuk pencarian di atas kolom terenkripsi |
| Pseudonim domain | Token berumur panjang yang dipakai Notification untuk mendaftarkan kontak (P5) |
| HELD | Status transaksi yang ditahan menunggu review Fraud Analyst |
| Cold start | Keadaan token Fraud tanpa riwayat asesmen, sehingga dua aturan tidak dievaluasi |
| Baseline, proposed | Dua mode perbandingan: tanpa dan dengan Privacy Service |
| Brankas identitas | Tabel identity\_vault di Privacy Service yang menyimpan NIK, nama, HP, dan rekening satu pelanggan, terenkripsi per kolom; dibuka per atribut hanya lewat jalur audit |

## Lampiran B. Riwayat revisi

| Versi | Tanggal | Perubahan |
| --- | --- | --- |
| v1 | tidak tercatat | PRD awal dengan pseudonimisasi dan audit log yang masih memuat subject\_id |
| v2 | 06/10/2026 | Gateway menokenisasi lebih dulu; audit\_log tanpa subject\_id; dua jenis subjek; tabel kebijakan dan spesifikasi kriptografi; lima algoritma inti |
| v2.1 | 07/10/2026 | Enam penghalang diselesaikan (penandaan kedaluwarsa, pemisahan requesting\_service dan target\_service, penyelarasan algoritma, satu tabel kebijakan, operasi yang belum terdefinisi, rate limit saat uji beban); retensi 90 hari; rotasi K\_index sebagai prosedur tertulis |
| v2.2 | 07/10/2026 | Profil Fraud berumur 30 hari; kontrak API lengkap dan format error seragam; kebijakan kegagalan; idempotensi dan review transaksi HELD; mekanisme Gateway; rancangan eksperimen dan keterlacakan pengujian; glosarium |
| v2.3 | 10/10/2026 | Brankas identitas: NIK, nama, HP, rekening disimpan terenkripsi saat pendaftaran (A5, /identity, identity\_vault); Tabel 5 atribut yang boleh dibuka; de\_pseudonymize dan revoke\_subject diperluas; STORE\_IDENTITY; FR-42 sampai FR-44; TK-20 dan TK-21; keterlacakan ke deskripsi skripsi |
| v2.4 | 13/10/2026 | Audit internal berbasis pseudonim; pembukaan identitas bersyarat dengan persetujuan admin lain (empat mata), sekali pakai 600 detik, atribut dibatasi yang disetujui (Tabel 6, disclosure\_request, GATE 5, alur E2a dan E2b, TK-22 sampai TK-28); masukan dosen pembimbing |
