# Kesenjangan kesetiaan baseline: yang diharapkan spek dan E(s) vs yang terlihat di kode

Tanggal: 2026-10-23. Cabang `feat/m5-kesetiaan-baseline`. Analisis ini **tidak mengubah kode**. Pengukuran E(s) ditahan sampai kesenjangan ini diputuskan (`docs/HANDOFF.md`).

Semua nama atribut mengikuti himpunan P milik metodologi: nama, NIK, HP, email, rekening, `customer_id`. Tidak ada nilai yang dikutip; hanya nama atribut dan lokasi.

## 1. Temuan utama: spek tidak sepakat satu sama lain

Premis awal ("spek Transaction, Fraud, Reconciliation, Notification mengharapkan baseline meneruskan atribut mentah") hanya separuh benar. Ada dua kelompok sumber yang saling bertentangan:

| Kelompok | Sumber | Apa katanya tentang baseline |
| --- | --- | --- |
| **A. Penggantian pengenal saja** | `docs/spec/transaction.md` bagian 5 ("Mode baseline", baris 69), `fraud.md` bagian 3 (baris 20), `notification.md` baris 36, `reconciliation.md` baris 15 dan 70, `data-dan-migrasi.md` bagian 9, PRD 11 akhir ("Perbedaan skema pada mode baseline"), ADR-0006 | Kolom pseudonim diganti `customer_id`/`account_number`. Fraud menerima `customer_id`; Notification menerima `customer_id`; repositori menyimpan `customer_id` dan `account_number`. Tidak ada NIK, nama, email di layanan hilir mana pun. |
| **B. Passthrough penuh** | `docs/spec/gateway-tokenizer.md` bagian 8 (baris 82), `docs/spec/pengujian-dan-pengukuran.md` bagian 6 (baris 108), `docs/reference/Bab_Metodologi_v8_teks.txt` baris 75 dan 223, Tabel IV | Gateway meneruskan `customer_id`, rekening, dan (bila ada) NIK, nama, email "apa adanya"; "setiap layanan menyimpan salinannya". E(s) baseline: Transaction, Fraud, Reconciliation 4/6 (`customer_id`, NIK, nama, rekening); Notification 5/6 (+ HP). |

Kelompok A dan B tidak dapat dipenuhi bersamaan: Tabel IV menuntut NIK dan nama terlihat di Fraud, Reconciliation, dan Notification, sedangkan spek ketiga layanan itu (dan skema yang diizinkan PRD 11) tidak punya jalur maupun kolom untuknya. Dalam hierarki CLAUDE.md (DESIGN_DECISIONS dan ADR, lalu PRD v2.4, lalu `docs/spec/`), Tabel IV berasal dari naskah Metodologi, yang bukan salah satu dari ketiganya.

Ada juga pertentangan di dalam kelompok B: Gateway bagian 8 meneruskan **email**, tetapi Tabel IV tidak memasukkan email ke P(s) baseline satu layanan pun (Transaction 4/6 = `customer_id`, NIK, nama, rekening).

## 2. Apa yang terlihat di kode sekarang (baseline)

Penyebab bersama: `Tokenizer.transaction` membangun muatan keluar dari daftar izin di kedua mode (`services/gateway/src/tokenizer/tokenizer.ts:116-128`); `transactionBody` menerima `nik`/`nama`/`email` "hanya untuk dibuang" (`schemas.ts:19-31`); `PassthroughPrivacyPort` hanya mengembalikan `customer_id`/rekening (`baseline/passthrough-privacy-port.ts:11-28`); skema masuk tiap layanan strict dan tidak mengenal NIK/nama (`transaction-http.ts:36-46`, `fraud-http.ts:20-28`, `notification-http.ts:22-35`, `reconciliation-http.ts:36-52`); tabel baseline hanya punya `customer_id`/`account_number`/`phone` (`services/*/migrations/baseline/0001_*.sql`).

Kolom "teramati" di bawah diturunkan dari kode dan dari tes yang ada (`services/gateway/test/e2e/equivalence.integration.spec.ts:300-316`, `services/*/test/baseline-repository.integration.spec.ts`). **Belum diukur** oleh pemindai pada payload (proxy pengamat belum dipasang di tumpukan E2E) dan **isi log baseline belum diverifikasi** (tes tidak menuntutnya).

### 2.1 Gateway

| Permukaan | Spek menurut kelompok B | Teramati di kode | Selisih |
| --- | --- | --- | --- |
| Payload ke Transaction | `customer_id`, rekening, NIK, nama, email bila dikirim klien (gateway bagian 8) | `customer_id`, rekening (field `customer_token`/`account_token`); NIK, nama, email **dibuang** | NIK, nama, email |
| Payload ke Notification (`POST /notification/register`, A4) | tidak disebut untuk baseline; Tabel IV: Notification 5/6 | `notification_domain_id` (= `customer_id`), HP | NIK, nama, rekening: tidak ada dasar di kelompok A |
| Payload ke Reconciliation (`settlement/report`) | rekening apa adanya (kelompok A); Tabel IV: + `customer_id`, NIK, nama | `account_pseudonym` (= rekening), jumlah, referensi bank | `customer_id`, NIK, nama: laporan bank memang tidak memuatnya |
| Registrasi `/register` | tidak disebut | formulir divalidasi lalu dibuang; tidak disimpan di mana pun (N-47) | tidak ada selisih terhadap spek A |
| Log, jawaban ke klien | tidak berisi data pribadi (invarian 6) | sama | tidak ada |

Klasifikasi: **NIK, nama ke Transaction = JELAS** (gateway bagian 8 dan Tabel IV sepakat). **Email = AMBIGU** (bagian 8 ya, Tabel IV tidak). Notification dan Reconciliation dari Gateway = AMBIGU (lihat 2.3 dan 2.5).

### 2.2 Transaction

| Permukaan | Spek | Teramati | Selisih |
| --- | --- | --- | --- |
| Payload masuk | kelompok A (bagian 3.1): tujuh field; kelompok B: ditambah NIK, nama | tujuh field (`customer_token`, `account_token` berisi `customer_id`/rekening); skema strict menolak NIK/nama dengan 422 | NIK, nama (menunggu Gateway) |
| Basis data | `customer_id`, `account_number` (data 9) | tepat itu | tidak ada terhadap A; kelompok B ("menyimpan salinannya") butuh kolom NIK/nama = **migrasi baseline** |
| Ke Fraud, Notification | `customer_id` (transaction.md baris 69) | `customer_id` | Tabel IV menuntut NIK, nama, rekening |
| Jawaban `GET /transaction/{id}` | + `account_number` hanya baseline (N-46) | sama | tidak ada |
| Log | token dan `transaction_id` | belum diverifikasi | belum diverifikasi |

E(s) teramati (turunan): 2/6 (`customer_id`, rekening). Harapan Tabel IV: 4/6. Selisih: NIK, nama.

### 2.3 Fraud

| Permukaan | Spek | Teramati | Selisih |
| --- | --- | --- | --- |
| Payload masuk | A: `{customer_id, amount, tx_hour, geohash}` (fraud.md baris 20); B: + NIK, nama, rekening | A | NIK, nama, rekening |
| Basis data | `fraud_assessments.customer_id` | tepat itu | B butuh kolom bila "menyimpan salinan" |

E(s) teramati: 1/6. Harapan: 4/6. **Seluruh selisih AMBIGU**: spek Fraud sendiri (A) sudah menetapkan 1/6, dan menambah field ke `/fraud/assess` mengubah kontrak yang spek sebut eksplisit ("field lain ditolak (422)").

### 2.4 Notification

| Permukaan | Spek | Teramati | Selisih |
| --- | --- | --- | --- |
| `register` | A: `{notification_domain_id (= customer_id), phone, channel}` | A | B: NIK, nama, rekening |
| `send` | A: `customer_id` sebagai `notif_token` | A | B: NIK, nama, rekening |
| Basis data | `contact_registry.customer_id`, `phone`; `notification_log.*_customer_id` | tepat itu | B: kolom tambahan |
| SMS | teks generik tanpa data pribadi | HP penerima di simulator | tidak ada |

E(s) teramati: 2/6 (`customer_id`, HP). Harapan: 5/6. **Seluruh selisih AMBIGU** (alasan sama dengan Fraud). Catatan: Notification menyimpan HP di kedua mode (D-08), jadi HP bukan bagian selisih.

### 2.5 Reconciliation

| Permukaan | Spek | Teramati | Selisih |
| --- | --- | --- | --- |
| Laporan settlement | A: `account_number` (reconciliation.md baris 15, 70) | rekening | B: `customer_id`, NIK, nama (laporan bank tidak memuatnya) |
| Dari Transaction (`completed`, `byId`) | `{transaction_id, amount, completed_at}` + `account_number` pada `byId` (N-46) | sama | B: `customer_id`, NIK, nama akan butuh disimpan dan dikirim Transaction |
| Basis data | `settlement_items.account_number` | tepat itu | B: kolom tambahan |

E(s) teramati: 1/6 (rekening). Harapan: 4/6. **Seluruh selisih AMBIGU** dan satu-satunya jalur untuk mencapainya (NIK/nama di Transaction diteruskan ke Reconciliation) memerlukan penyimpanan di Transaction, yaitu migrasi baseline.

## 3. Ringkasan klasifikasi

| # | Selisih | Status | Alasan |
| --- | --- | --- | --- |
| G1 (SELESAI, N-48) | Gateway baseline meneruskan **NIK dan nama** (bila dikirim klien) ke Transaction; Transaction baseline menerimanya (tanpa menyimpan) | **JELAS, diperbaiki di Langkah 2** | gateway bagian 8 dan Tabel IV sepakat; tidak butuh migrasi, ADR, atau kode error baru. Perluasan skema masuk Transaction hanya di baseline dicatat sebagai N-48 untuk persetujuan (preseden N-46). |
| G2 | Gateway meneruskan **email** | AMBIGU | gateway bagian 8: ya; Tabel IV: P(s) baseline tidak memuat email |
| G3 | NIK, nama, rekening ke **Fraud** | AMBIGU | fraud.md (A) vs Tabel IV (B); kontrak `/fraud/assess` strict |
| G4 | NIK, nama, rekening ke **Notification** (`register` dan `send`) | AMBIGU | notification.md (A) vs Tabel IV (B); jalur `register` satu-satunya tempat Gateway memegang formulir |
| G5 | `customer_id`, NIK, nama ke **Reconciliation** | AMBIGU | tidak ada jalur tanpa menyimpan di Transaction |
| G6 | Layanan **menyimpan salinan** NIK/nama | AMBIGU dan **berhenti**: butuh migrasi baseline | Metodologi (B) vs PRD 11 dan data 9 (A) |
| G7 | Log baseline bersih/tidak | belum diverifikasi | tes tidak menuntutnya; akan dicakup tes baru bila log dapat dipindai |

## 4. Keputusan yang diminta dari pemilik skripsi

1. Mana yang berlaku untuk baseline: **A (penggantian pengenal)** atau **B (passthrough penuh, Tabel IV)**? Bila A, Tabel IV harus diubah menjadi 2/6, 1/6, 1/6, 2/6 (naskah metodologi dan `pengujian-dan-pengukuran.md` bagian 6, bukan kode). Bila B, G3 sampai G6 dikerjakan dan G6 membutuhkan migrasi baseline.
2. Email diteruskan di baseline atau tidak (G2).

G1 dikerjakan lebih dulu karena dua sumber (gateway bagian 8 dan Tabel IV) sepakat dan spek Transaction bagian 3.1 hanya diam soal baseline; ia tidak bergantung pada G3 sampai G6. Bila keputusan nomor 1 ternyata A, G1 dibatalkan dengan satu commit (ia berdiri sendiri) dan Tabel IV diubah.
