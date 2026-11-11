# Spesifikasi: Privacy Service

Sumber: PRD 6, 6.1, 6.2, 7, 7.4, 8, 10, 11, 12; DESIGN_DECISIONS D-01..D-19; ADR-0005, 0007, 0008, 0010, 0011; prototipe P-2/P-3 (riwayat git `a887931`, `2755840`). Perubahan terhadap PRD ditandai **[Δ PRD]** dan dirangkum di `01-perubahan-prd.md`; keputusan yang diterima Fanny (bawaan, Gerbang 3) ditandai **[K-nn]** (`OPEN_QUESTIONS.md` bagian F).

## 1. Tanggung jawab

Satu-satunya pemegang mapping token↔subjek dan brankas identitas. Menerbitkan, menukar, menerbitkan ulang, mencabut, dan (bersyarat) membuka token; mengevaluasi kebijakan (Tabel 1, 2, 3, 5, 6); menjalankan alur pembukaan identitas empat mata; menulis audit; menjalankan retensi. **Tidak memanggil layanan lain** (invarian 3) dan gagal tertutup bila komponennya tidak tersedia (invarian 8).

## 2. Modul dan seam

Istilah mengikuti skill `codebase-design`. Lapisan HTTP (controller) tipis dan hanya memvalidasi, memanggil modul, dan memetakan error. Logika ada di modul dalam berikut.

| Modul | Interface (ringkas) | Dalamnya |
| --- | --- | --- |
| `PolicyEngine` | **[Δ spec, M2-03]** `evaluate({operation, requestingService, context: {serviceId, purpose, subjectType}, actorRole?})` mengembalikan konteks Tabel 1 atau melempar `POLICY_NOT_ALLOWED`/`FORBIDDEN_ROLE` (`operation` menggantikan `mode`/"cara terbit": `GENERATE_FROM_IDENTITY`, `GENERATE_FROM_TRANSACTION`, `DE_PSEUDONYMIZE`, `RE_ISSUE`); `authorizeCaller(operation, caller)` (RESOLVE_NOTIF_DOMAIN); `exchangeTarget(caller, {serviceId, purpose})` (Tabel 2 sebelum token dibaca) dan `exchangeAllowed(sumber, tujuan, caller)` (setelah kepemilikan terbukti); `contextOf(key)`, `attributesFor(key)` (Tabel 5), `isValidBasis(basis)` (Tabel 6); TTL per purpose disuntik lewat konstruktor | Tabel 1, 2, 3, 5, 6 sebagai konfigurasi bertipe dan beku; murni, tanpa I/O |
| `Crypto` | `FieldCipher.encrypt/decrypt`, `BlindIndex.lookup`, `TokenMint.mint`, `loadKeys` | bagian 5 |
| `TokenService` | `generate`, `generateFromTransaction`, `exchange`, `reIssue`, `resolveDomain` (`revokeToken` dan `revokeSubject` ada di `RevocationService`, M3-02) | `buat_token`, status efektif, kunci per-kombinasi, audit dalam transaksi yang sama |
| `DisclosureService` | `request`, `approve`, `reject`, `open` (de-pseudonymize) | mesin status, lima gerbang ditambah STEP 0, brankas |
| `IdentityVault` | `store`, `open(lookup, attrs)`, `purge(lookup)` | kolom terenkripsi per atribut |
| `AuditWriter` / `AuditReader` | `record(entry, tx?)`; `query(filter)`, `timeline`, `summary` | dua pool koneksi (bagian 3) |
| `RetentionJob` | `run(clock)` | bagian 7.11 |

Seam yang nyata hanya **Clock** (sistem dan palsu). Tidak ada seam repositori: Privacy hanya punya satu implementasi PostgreSQL dan tesnya memakai PostgreSQL asli (qa-checklist: tidak ada mock untuk indeks unik parsial, kunci, `REVOKE/GRANT`). Kontrol di `PolicyEngine` dan `Crypto` diuji murni (unit).

## 3. Konfigurasi

Env (validasi zod saat start, nilai dari `.env.example`): `PRIVACY_MODE`, `GRACE_PERIOD_SECONDS`, `TTL_*` (enam), `DISCLOSURE_APPROVAL_TTL_SECONDS`, `PSEUDONYM_KEY_VERSION`, `RETENTION_DAYS`, `LOG_LEVEL`, `PG_HOST`, `PG_PORT`, dan berkas rahasia: `PSEUDONYM_HMAC_SECRET_FILE`, `BLIND_INDEX_SECRET_FILE`, `FIELD_ENCRYPTION_KEY_FILE`, kata sandi `privpay_app` dan `privpay_auditor`. Start gagal bila rahasia hilang/kosong/bukan 32 byte atau tiga kunci tidak saling berbeda (FR-30).

**Dua pool koneksi:** pool `app` (peran `privpay_app`: tulis mapping, status, brankas, disclosure, dan `INSERT` audit) dan pool `auditor` (peran `privpay_auditor`: hanya `SELECT audit_log` untuk `GET /audit-log*`). Pembacaan audit tidak boleh memakai pool `app`; penulisan audit tidak boleh memakai pool `auditor`. Penulisan audit tidak memakai `RETURNING` (peran `app` tidak punya `SELECT` pada `audit_log`); `id` baris dibangkitkan aplikasi bila dibutuhkan.

## 4. Kontrak API

Konvensi: JSON UTF-8, ISO 8601 UTC, `X-Request-Id`, `Authorization: Bearer <service JWT>` (+ `X-Actor-Token` bila disebut), error seragam (`platform-dan-ci.md` bagian 4), validasi zod yang **menolak field tak dikenal**, batas ukuran body 16 KiB (K-12). Format:

- Tipe bersama (`Pseudonym`, `TransactionId`, `CustomerId`, `AccountNumber`) didefinisikan sekali di `platform-dan-ci.md` bagian 3.1. `purpose` dan `target_service` dari enum Tabel 1.

### 4.1 `POST /pseudonymize`

Tepat satu dari tiga bentuk (campuran: 422).

| Bentuk | Body | Pemanggil sah (dari JWT) |
| --- | --- | --- |
| 1 dari identitas | `{subject_type, subject_id, target_service, purpose, transaction_id?}` | `API_GATEWAY` (P1, P2, P5, P6) |
| 2 pertukaran | `{source_pseudonym, target_service, purpose, transaction_id}` | `TRANSACTION` (X1, X2) |
| 3 dari transaksi | `{subject_type, transaction_id, target_service, purpose}` | `RECONCILIATION` (P6, P7); P7 juga membutuhkan `X-Actor-Token` berperan `auditor` |

Respons 200: `{pseudonym, expires_at, reused}` (`expires_at` ISO UTC). Permintaan berisi `subject_id` dari layanan selain Gateway: 403 `POLICY_NOT_ALLOWED` (TK-07). `requesting_service` tidak pernah dari body. Audit: `GENERATE_TOKEN` (bentuk 1 dan 3) atau `EXCHANGE_TOKEN` (bentuk 2), tepat satu baris, SUCCESS (`OK`/`REUSED_ACTIVE`) atau DENIED. Reason DENIED: `POLICY_NOT_ALLOWED`; untuk bentuk 2 juga `TOKEN_NOT_FOUND`, `SERVICE_MISMATCH`, `REVOKED`, `EXPIRED`; untuk bentuk 3 `TOKEN_NOT_FOUND` dan `REVOKED` (K-29); semua bentuk juga `IDEMPOTENCY_CONFLICT` (K-28: transaction id yang sama dengan pseudonym lain pada konteks yang sama); `FORBIDDEN_ROLE` untuk P7 tanpa aktor auditor. **[M2-06]** Kolom `pseudonym` baris audit: pada SUCCESS token yang diterbitkan atau dikembalikan (dengan `mapping_id` barisnya); pada DENIED token yang diajukan pemanggil bila ada (bentuk 2: token sumber, dengan `mapping_id`-nya bila ditemukan). Bentuk 2 menolak sumber yang bukan konteks sumber Tabel 2 (`POLICY_NOT_ALLOWED`, setelah kepemilikan terbukti); sumber yang identitasnya sudah dikosongkan retensi dijawab `TOKEN_NOT_FOUND`. Bentuk 3 hanya membaca baris `TRANSACTION`/`PAYMENT_PROCESSING` (P1/P2) dengan `transaction_id` dan `subject_type` itu, termasuk yang `expired`; baris layanan lain yang memuat `transaction_id` sama bukan sumber (invarian 5).

### 4.1a `POST /pseudonymize/batch` (ADR-0019)

P1 dan P2 satu pembayaran dalam satu panggilan. Body `{requests: [<bentuk 1>, ...]}`: 1 sampai 2 elemen, tiap elemen persis bentuk 1 di 4.1 (field tak dikenal ditolak, termasuk di tingkat atas; `requesting_service` tidak pernah dari body, D-16), paling banyak satu elemen per `subject_type` (422 bila dua `CUSTOMER` atau dua `ACCOUNT`). Batas body 16 KiB seperti rute lain. Pemanggil sah: `API_GATEWAY` saja, ditentukan Policy Engine per elemen seperti di 4.1 (pemanggil lain: 403 `POLICY_NOT_ALLOWED`, sama dengan rute tunggal).

Respons 200: `{items: [{pseudonym, expires_at, reused}, ...]}`, urutan sama dengan permintaan; tidak memuat `subject_id`. **Semua atau tidak sama sekali:** seluruh batch satu transaksi basis data. Tiap elemen melewati langkah yang sama dengan bentuk 1 (STEP 0 kebijakan, kunci kombinasi, penerbitan atau pakai ulang, tautan K-28) dan menulis tepat satu baris audit `GENERATE_TOKEN`, SUCCESS (`OK`/`REUSED_ACTIVE`), di transaksi yang sama. Bila satu elemen ditolak (kebijakan, `IDEMPOTENCY_CONFLICT`), seluruh transaksi di-rollback: tidak ada pemetaan baru, tidak ada baris SUCCESS, satu baris DENIED atas elemen yang ditolak, dan jawabannya sama dengan yang diterima elemen itu pada rute tunggal. Kunci advisory diambil menurut urutan `subject_type`, bukan urutan permintaan, agar dua batch dengan urutan terbalik tidak saling menunggu (deadlock); hasil tetap mengikuti urutan permintaan. Privacy atau basis datanya tidak terjangkau: 503 untuk seluruh batch tanpa fallback (invarian 8). Rute 4.1 tetap ada dan tidak berubah.

### 4.2 `POST /resolve-domain`

`{notif_token}` → 200 `{notification_domain_id}`. Pemanggil: `NOTIFICATION`. Audit `RESOLVE_NOTIF_DOMAIN`. DENIED: `POLICY_NOT_ALLOWED`, `TOKEN_NOT_FOUND`, `SERVICE_MISMATCH`, `PURPOSE_MISMATCH`, `REVOKED`, `EXPIRED`.

### 4.3 `POST /de-pseudonymize` **[Δ PRD]** (E-03)

Permintaan: `{pseudonym, purpose, disclosure_id}`, ketiganya wajib. Pemanggil: `RECONCILIATION` dengan `X-Actor-Token` berperan `auditor`. Respons 200: `{mapping_id, attributes: {customer_id?, nik?, nama?}}`; hanya atribut yang disetujui; tidak ada `subject_type`/`subject_id` di tingkat atas; HP dan rekening tidak pernah. Lima gerbang dan syarat tambahan: bagian 7.8. Audit `DE_PSEUDONYMIZE`.

### 4.4 `POST /re-issue`

`{pseudonym, transaction_id}` → 200 `{pseudonym, expires_at, reused}`. Pemanggil: `TRANSACTION`. Audit `RE_ISSUE`. DENIED: `TOKEN_NOT_FOUND`, `SERVICE_MISMATCH`, `POLICY_NOT_ALLOWED`, `REVOKED`, `TX_TERMINAL` (409), `IDEMPOTENCY_CONFLICT` (409; transaction id sudah tertaut ke token lain). **[K-28, ADR-0013]** Baris baru mempertahankan `transaction_id` asli token lama; tautan transaksi permintaan berpindah dari token lama ke penggantinya, dan hanya dari token itu; re-issue tidak pernah membuat tautan baru (tanpa tautan yang menunjuk token lama: `IDEMPOTENCY_CONFLICT`). **[Δ PRD 7.5, M2-07]** Pemanggil yang bukan `TRANSACTION` ditolak `POLICY_NOT_ALLOWED` **sebelum** token dibaca (AZ-23; PRD membaca token lebih dulu): layanan lain tidak dapat menebak token mana yang ada. Urutan selanjutnya: token ada, milik pemanggil, konteks P1/P2 (`POLICY_NOT_ALLOWED`), bukan `revoked`, identitas belum dikosongkan retensi, transaksi belum final. Token `expired` justru yang diterbitkan ulang. Baris audit menyebut token yang diajukan (`pseudonym`, `mapping_id`) pada DENIED dan token baru pada SUCCESS.

### 4.5 `POST /pseudonym/{pseudonym}/revoke`

Tanpa body; pemanggil `ADMIN_CONSOLE` dengan peran `admin`. 200 `{pseudonym, status: "revoked", revoked_at}`. Audit `REVOKE_TOKEN`; DENIED `TOKEN_NOT_FOUND`, `FORBIDDEN_ROLE`. Mencabut token yang sudah `revoked` mengembalikan 200 yang sama (idempoten); token `expired` dapat dicabut (K-11).

### 4.6 `POST /subject/revoke`

`{subject_type, subject_id}` → 200 `{revoked_count}`. `ADMIN_CONSOLE`, peran `admin`; **[ADR-0014, E-31]** juga `API_GATEWAY` dengan token layanannya, hanya untuk `subject_type = CUSTOMER` (kompensasi pendaftaran), tanpa `actor_id` di audit; `ACCOUNT` oleh Gateway tetap `POLICY_NOT_ALLOWED`. Audit: satu baris `REVOKE_SUBJECT` per token yang dicabut (dengan `mapping_id`) dan, bila subjek `CUSTOMER` dan baris brankas ada, satu baris `PURGE_IDENTITY`. Bila tidak ada token dan tidak ada brankas: satu baris `REVOKE_SUBJECT` DENIED `TOKEN_NOT_FOUND` dan `revoked_count: 0`. ADR-0005 menyerahkan perilaku ini ke spec (contohnya "tanpa baris audit palsu"): satu baris DENIED dipilih, sesuai katalog PRD 12, agar "satu baris audit per operasi" tetap berlaku; itu bukan baris palsu karena operasinya memang ditolak. **[M3-02]** Jawaban HTTP tetap 200 `{revoked_count: 0}`. `PURGE_IDENTITY` dari pencabutan subjek mencatat `requesting_service = ADMIN_CONSOLE` dan `actor_id` admin (bukan `SYSTEM`), tanpa `mapping_id` dan `pseudonym` (brankas tidak punya baris mapping). Hanya baris `active` yang dicabut; baris `expired` yang masih memuat identitas dikosongkan retensi (7.11) atau dicabut satu per satu lewat 4.5. Baris mapping tidak dikosongkan di sini, maka tautan transaksi tidak disentuh (ADR-0013).

### 4.7 `PATCH /transaction-status`

`{transaction_id, status}` dengan `status` ∈ `PENDING`, `IN_PROGRESS`, `COMPLETED`, `FAILED`, `CANCELLED`. Pemanggil `TRANSACTION`. Upsert idempoten; 200 `{transaction_id, status, updated_at}`. **Tidak diaudit** (bukan operasi token). Status terminal (`COMPLETED`, `FAILED`, `CANCELLED`) tidak dapat kembali ke non-terminal: 409 `TX_TERMINAL` (K-09). **[K-30, M2-07]** Status terminal tidak berubah sama sekali: mengulang status terminal yang sama menjawab 200 dengan baris apa adanya (`updated_at` tidak berubah); status lain, termasuk terminal yang berbeda, 409 `TX_TERMINAL`. Satu pernyataan `INSERT ... ON CONFLICT DO UPDATE ... WHERE` membuat dua panggilan serentak tidak dapat lolos bersama.

### 4.8 `GET /audit-log`, `/audit-log/timeline/{pseudonym}`, `/audit-log/summary`

Peran: `auditor` atau `admin` untuk daftar; `auditor` untuk timeline dan summary; `ADMIN_CONSOLE` sebagai pemanggil. Filter daftar: `service`, `status`, `reason`, `pseudonym`, `transaction_id`, `from`, `to`; **[Δ PRD, K-08]** ditambah `action` dan `disclosure_id` supaya admin menemukan permintaan pembukaan yang menunggu tanpa endpoint daftar baru. Paginasi `limit` (50, maks 200) + `cursor` (opak: `created_at` dan `id` terakhir, urutan `created_at DESC, id DESC`); timeline naik menurut waktu. Respons daftar sesuai PRD 10; baris memuat `disclosure_id` dan `attribute_names` bila ada. `summary`: `{total, denied: [{reason, count}], alerts: [{requesting_service, reason, count, window_start}]}`; `alerts` memuat tiga `DENIED` `SERVICE_MISMATCH` atau `TOKEN_NOT_FOUND` dari satu layanan dalam lima menit (komponen opsional "Peringatan sederhana" pada PRD 12, diterima sebagai mitigasi Q-11). Setiap pembacaan menulis satu baris `VIEW_AUDIT_LOG` (SUCCESS) lewat pool `app`. Dibaca lewat pool `auditor`. **[M3-03]** Rincian: `from` inklusif, `to` eksklusif; `limit` di luar 1..200 atau `cursor` yang bukan buatan pembaca = 422 (validasi bentuk, tidak diaudit); kursor memuat `created_at` dengan mikrodetik dan `id`. Penolakan (`POLICY_NOT_ALLOWED` bila pemanggil bukan `ADMIN_CONSOLE`, `FORBIDDEN_ROLE` bila peran tidak cocok) menulis satu `VIEW_AUDIT_LOG` DENIED (K-27); peran yang `aud`-nya tidak melewati Privacy ditolak `authenticate` sebelum layanan dan tidak diaudit di sini. Pembacaan dilakukan lebih dulu, baru baris `VIEW_AUDIT_LOG` ditulis, jadi pembacaan tidak melihat barisnya sendiri; baris itu memuat `pseudonym`/`transaction_id` bila disaring. Peringatan (mengikuti bunyi PRD 12 "Peringatan sederhana": "Tiga DENIED SERVICE_MISMATCH atau TOKEN_NOT_FOUND dari satu layanan dalam lima menit"): kedua reason dihitung bersama per layanan; tiga baris DENIED dalam jendela lima menit yang berakhir di baris itu (batas lima menit termasuk); satu peringatan per layanan (jendela dengan hitungan terbesar), `reason` adalah reason baris yang melengkapi jendela itu. Baris pada respons membuang bidang yang kosong.

### 4.9 `POST /identity`

`{customer_id, nik, nama, hp, rekening}`; hanya `API_GATEWAY`. Validasi: `nik` `^[0-9]{16}$`, `hp` `^08[0-9]{8,12}$`, `rekening` per `AccountNumber`, `nama` 1..100 karakter huruf, spasi, titik, apostrof, tanda hubung. Respons 201 `{customer_id, stored: ["nik","nama","hp","rekening"]}`. **Idempoten (K-10):** pemanggilan ulang dengan `customer_id` yang sama memperbarui ciphertext (IV baru) dan mengembalikan 200 dengan bentuk sama; **[Δ spec, N-25]** bukan satu `INSERT ... ON CONFLICT (customer_lookup) DO UPDATE`: AAD terikat id baris (ADR-0011), jadi pemanggilan ulang harus mengenkripsi untuk id baris yang sudah ada. Di satu transaksi: kunci penasihat pada `customer_lookup`, `SELECT ... FOR UPDATE`, lalu `INSERT` (201) atau `UPDATE` (200); pemanggilan serentak pertama menyisakan satu baris. Pemanggil lain: 403 `POLICY_NOT_ALLOWED`, tidak ada baris brankas baru (TK-20). Audit `STORE_IDENTITY` (SUCCESS `OK`; DENIED `POLICY_NOT_ALLOWED`), tanpa nilai identitas.

### 4.10 `POST /disclosure-requests`, `/{id}/approve`, `/{id}/reject`

Pemanggil `ADMIN_CONSOLE` (token manusia sebagai `Authorization`, ADR-0007).

- `POST /disclosure-requests`: `{audit_token, basis, case_ref, attributes}`; peran `auditor`. `basis` ∈ `DISPUTE`, `FRAUD_CONFIRMED`, `LEGAL_REQUEST` (selain itu 422 `INVALID_BASIS`); `attributes` himpunan tak kosong ⊆ {`customer_id`,`nik`,`nama`} (selain itu 422 `ATTRIBUTE_NOT_ALLOWED`); `case_ref` `^[A-Z0-9-]{1,64}$` (K-12). Token harus P7 aktif milik `RECONCILIATION`/`INTERNAL_AUDIT`. Respons 201 `{disclosure_id, status: "PENDING"}`; tidak ada baris bila 422.
- `.../approve`: peran `admin`; penyetuju ≠ pemohon (403 `SELF_APPROVAL`, status tetap `PENDING`); 200 `{disclosure_id, status: "APPROVED", expires_at}` dengan `expires_at = decided_at + DISCLOSURE_APPROVAL_TTL_SECONDS`.
- `.../reject`: peran `admin`; 200 `{disclosure_id, status: "REJECTED"}`.
- Approve/reject pada status selain `PENDING`: 409 `DISCLOSURE_NOT_PENDING` (K-01). Tanpa peran admin: 403 `FORBIDDEN_ROLE` (TK-25). `disclosure_id` tak dikenal: 404 `DISCLOSURE_NOT_FOUND`.

**[M3-04]** Urutan keputusan: `approve`/`reject` memeriksa pemanggil (`POLICY_NOT_ALLOWED`) dan peran (`FORBIDDEN_ROLE`), lalu baris ada (`DISCLOSURE_NOT_FOUND`, baris dikunci `FOR UPDATE`), lalu `PENDING` (`DISCLOSURE_NOT_PENDING`), lalu pada `approve` penyetuju ≠ pemohon (`SELF_APPROVAL`). `reject` mengisi `decided_at` dan tidak mengisi `approver_id` (pelaku ada di audit). Permintaan: pemanggil dan peran, `basis`, `attributes`, lalu token (`TOKEN_NOT_FOUND`, `SERVICE_MISMATCH`, `PURPOSE_MISMATCH`, `REVOKED`, `EXPIRED`), semuanya `DISCLOSURE_REQUESTED` DENIED; atribut duplikat atau bukan teks = 422 bentuk. `case_ref` tidak masuk audit. Pemohon adalah `sub` token, bukan body. `DISCLOSURE_APPROVAL_TTL_SECONDS` wajib di env (tanpa nilai bawaan). Pemakaian dan kedaluwarsa persetujuan diuji di M3-05. Audit: `DISCLOSURE_REQUESTED`, `DISCLOSURE_APPROVED`, `DISCLOSURE_REJECTED`. Penolakan 422 pada permintaan juga ditulis sebagai `DISCLOSURE_REQUESTED` DENIED (`INVALID_BASIS`/`ATTRIBUTE_NOT_ALLOWED`) tanpa baris `disclosure_request` (K-07).

### 4.11 `GET /health`, `GET /metrics`

Sesuai `platform-dan-ci.md` bagian 8.

## 5. Kripto (ADR-0011) **[Δ PRD]**

Hanya `node:crypto`. Tiga kunci terpisah (`K_token`, `K_index`, `K_field`), masing-masing 32 byte, saling berbeda; tidak pernah keluar dari proses (tidak di log, respons, atau variabel layanan lain, NFR-07).

- **Penyandian "||":** setiap bagian diberi awalan panjang 4 byte (big-endian). `subject_lookup = HMAC-SHA256(K_index, enc(subject_type, subject_id))`; `pseudonym = "PSEU-" + upper(8 heks pertama HMAC-SHA256(K_token, enc(subject_type, subject_id, service_id, purpose, nonce)))` dengan `nonce` UUID v4 per penerbitan.
- **Blob:** `key_version(uint16 BE) || IV(12 byte acak per penulisan) || ciphertext || tag(16)`; dekripsi memilih kunci menurut `key_version` dan gagal untuk versi tak dikenal.
- **AAD terikat baris:** mapping `enc('mapping', subject_type, id)`; brankas `enc('vault', nama_kolom, id)`. Dengan itu ciphertext tidak dapat dipindah antar baris, antar jenis subjek, atau antar kolom (diuji di prototipe pada tingkat fungsi dan pada basis data dengan peran asli). AAD tidak memuat `subject_lookup`, sehingga rotasi `K_index` tidak merusak dekripsi.
- `id` baris dibangkitkan aplikasi sebelum enkripsi dan INSERT.
- Perbandingan rahasia: `safeEqual` (`timingSafeEqual`).

## 6. Policy Engine

Tabel 1, 2, 3, 5, 6 ditulis sebagai konstanta bertipe di `PolicyEngine` (konfigurasi, bukan tabel basis data); TTL tiap purpose dari env. Mengubah isi tabel = ADR. `evaluate` memeriksa: baris Tabel 1 (layanan, purpose, jenis subjek) → cara terbit → pemanggil sah (Tabel 3) → syarat peran (dalam kode: aturan Tabel 3 dicari lewat pemanggil lebih dulu, lalu baris Tabel 1; tidak terlihat dari luar karena setiap kegagalan sebelum peran adalah `POLICY_NOT_ALLOWED`, M2-03) (kolom "Peran diperlukan": `service`, atau `auditor` untuk P7). Pertukaran: pasangan (pemanggil, tujuan, purpose) pada Tabel 2 diperiksa sebelum token dibaca (7.5 STEP 0), konteks sumber setelah kepemilikan terbukti (STEP 2). `contextOf(mapping).bolehDibuka` hanya benar untuk P7.

Mode: bila `PRIVACY_MODE=baseline`, Privacy Service tidak dijalankan (PRD 17).

## 7. Algoritma

Semua operasi memakai `Clock` yang disuntik. Setiap operasi menulis tepat satu baris audit (sukses di **transaksi yang sama** dengan perubahan keadaan; penolakan lewat transaksi singkat terpisah yang di-commit setelah transaksi operasi dibatalkan). Bila baris audit tidak dapat ditulis, operasi gagal (500) dan tidak pernah berhasil tanpa jejak.

### 7.1 `status_efektif(m, now)`

`revoked`→`revoked`; `expired`→`expired`; `now > expires_at + GRACE`→`expired`; `now > expires_at`→`grace`; selainnya `active`. Batas tepat diuji dengan `FakeClock` (qa C-01). Grace menerima operasi yang sedang berjalan, bukan penerbitan baru.

### 7.2 `buat_token` **[Δ PRD, ADR-0010]**

Satu transaksi dengan langkah (urutan wajib):

1. `lookup = BlindIndex(subject_type, subject_id)`.
2. **Kunci advisory transaksi** `pg_advisory_xact_lock(hashtextextended(hex(lookup) || '|' || service || '|' || purpose, 0))`. Ini mekanisme utama pencegah penerbitan ganda; `SELECT ... FOR UPDATE` pada baris yang belum ada tidak mengunci apa pun (terbukti: 456 dari 1000 permintaan paralel ditolak `23505 uq_mapping_active` di prototipe) dan boleh tetap ada untuk baris yang ada tetapi tidak dianggap cukup.
3. **Penandaan kedaluwarsa:** `UPDATE ... SET status='expired' WHERE subject_lookup=… AND service_id=… AND purpose=… AND status='active' AND expires_at < now`. Tanpanya, INSERT setelah TTL melanggar `uq_mapping_active` (T-06, FR-33).
4. Cari baris aktif; bila ada, kembalikan `{reused: true}`.
5. `id = uuid v4`; `enc = FieldCipher.encrypt(subject_id, AAD(mapping, subject_type, id))`.
6. Ulangi sampai 20 kali (batas dipilih spec, K-12; pada tabrakan yang dipaksa prototipe memerlukan 4 percobaan): `nonce`, `pseudonym`, `INSERT ... ON CONFLICT (pseudonym) DO NOTHING RETURNING id`; bila 0 baris, ulang dari nonce baru ("ulangi dari STEP 2" pada ADR-0010 berarti langkah pembangkitan nonce dan nilai pseudonym; INSERT biasa yang gagal unique membatalkan seluruh transaksi PostgreSQL, sehingga "ulangi dari STEP 2" PRD tidak dapat berjalan tanpa `ON CONFLICT`). Lebih dari 20 kali: 500.
7. `expires_at = now + TTL(purpose)`; sisipkan baris audit; commit.

**Alternatif tercatat (strategi B):** ulang seluruh transaksi bila `uq_mapping_active` dilanggar. Dipakai hanya bila kunci advisory tidak dapat dipakai (mis. pooler mode transaksi).

### 7.3 `generate_token` (bentuk 1)

STEP 0 `PolicyEngine.evaluate(..., cara='dari identitas')`; ditolak → audit DENIED `POLICY_NOT_ALLOWED`, 403. STEP 1 `buat_token`. STEP 2 audit SUCCESS `OK`/`REUSED_ACTIVE` (satu transaksi dengan 7.2).

### 7.4 `generate_from_transaction` (bentuk 3)

Seperti PRD 6.1 dengan pembaruan: **[Δ PRD, K-28/K-29, ADR-0013]** baris sumber dicari lewat `transaction_link` (`transaction_id`, `subject_type`, TRANSACTION, PAYMENT_PROCESSING) dari token P1 (CUSTOMER) atau P2 (ACCOUNT) termasuk yang `expired`; tidak ada tautan atau `purged_at` terisi → audit DENIED `TOKEN_NOT_FOUND`, 404; sumber `revoked` → DENIED `REVOKED`, 403. Setiap penerbitan atau pemakaian ulang (semua bentuk dan re-issue) menulis tautan konteks tujuannya; transaction id yang sama dengan pseudonym lain pada konteks yang sama → DENIED `IDEMPOTENCY_CONFLICT`, 409, operasi dibatalkan. Subjek didekripsi internal dengan AAD baris sumber; `buat_token` memakai `subject_id` itu.

### 7.5 `exchange_token` (bentuk 2)

PRD 7.2 tanpa perubahan logika: STEP 0 pasangan Tabel 2 (`POLICY_NOT_ALLOWED`); STEP 1 token ada (`TOKEN_NOT_FOUND`), milik pemanggil (`SERVICE_MISMATCH`), status (`REVOKED` 403, `EXPIRED` 410); STEP 2 konteks sumber dan `policy_evaluate`; STEP 3 `buat_token`; STEP 4 audit.

### 7.6 `resolve_domain_pseudonym`

PRD 7.3: hanya `NOTIFICATION`; mengembalikan pseudonim domain P5 aktif untuk subjek yang sama, bukan `subject_id`. **[M3-01]** Urutan: pemanggil (`POLICY_NOT_ALLOWED`, sebelum token dibaca), token ada, milik pemanggil (`SERVICE_MISMATCH`), `purpose = NOTIFICATION` (`PURPOSE_MISMATCH`), status (`REVOKED`/`EXPIRED`), identitas belum dikosongkan; lalu P5 dicari lewat `subject_lookup` baris itu (subjek tidak didekripsi). P5 yang tidak ada, dicabut, atau lewat TTL: `TOKEN_NOT_FOUND`. Baris audit SUCCESS menyebut token yang diajukan.

### 7.7 `re_issue`

PRD 7.5. Pemanggil `TRANSACTION`, konteks P1/P2 saja, transaksi tidak boleh terminal menurut `transaction_status` (baris tidak ada = non-terminal). Token lama ditandai `expired` lalu `buat_token` (di bawah kunci yang sama). Dipanggil dua kali dengan token lama yang sama, hasil keduanya sama (token baru dipakai ulang), sehingga aman diulang (diuji).

### 7.8 `de_pseudonymize` (lima gerbang) **[Δ PRD]**

Gerbang berurutan, berhenti di kegagalan pertama, respons seragam:

1. token ada → `TOKEN_NOT_FOUND` 404; 2. `m.service_id = requesting_service` → `SERVICE_MISMATCH`; 3. `m.purpose = purpose` → `PURPOSE_MISMATCH`; 4. `status_efektif` → `REVOKED` 403/`EXPIRED` 410; 5. `disclosure_id`: ada dan `mapping_id` cocok → `DISCLOSURE_NOT_FOUND` 404; status `APPROVED` → `DISCLOSURE_NOT_APPROVED` 403 (termasuk `USED`, `PENDING`, `REJECTED`); `now ≤ expires_at` → `DISCLOSURE_EXPIRED` 410; `requester_id = actor_id` → `REQUESTER_MISMATCH` 403. **[Δ spec, N-29]** Pemanggil (Tabel 3) dan peran auditor diperiksa lebih dulu, sebelum baris apa pun dibaca: gerbang 5 menuntut pemohon = aktor dan pemohon selalu auditor, sehingga bila peran diperiksa sesudahnya, aktor `admin` mendapat `REQUESTER_MISMATCH` dan `FORBIDDEN_ROLE` (TK-08) tidak pernah terjangkau. Respons endpoint ini memakai `Cache-Control: no-store`. Lalu syarat tambahan: `boleh_dibuka` (selain P7: `POLICY_NOT_ALLOWED`) dan peran `auditor` (`FORBIDDEN_ROLE`; TK-08).

Lolos: dalam **satu transaksi**, kunci baris `disclosure_request` (`SELECT ... FOR UPDATE`) dan periksa ulang status `APPROVED`, buka brankas hanya untuk atribut yang diminta ∩ Tabel 5 (kolom lain tidak didekripsi), tandai `USED` dan isi `used_at`, tulis audit `DE_PSEUDONYMIZE` SUCCESS dengan `attribute_names` dan `disclosure_id`, lalu commit. Pemakaian paralel dua kali: tepat satu berhasil. Bila mapping ada tetapi baris brankas hilang atau `purged_at` terisi: DENIED `TOKEN_NOT_FOUND` 404 (K-13). `customer_id` didekripsi dari `customer_id_enc` brankas, bukan dari mapping.

### 7.9 Alur pembukaan identitas

Mesin status di bagian 8. Pemohon dan penyetuju memakai peran berbeda (satu peran per manusia, ADR-0007) dan `chk_four_eyes` memaksa `approver_id ≠ requester_id` juga di basis data. Persetujuan sekali pakai, berlaku 600 detik. Penerima hasil (Reconciliation) tidak menyimpan atribut (T-14).

### 7.10 `revoke_token`, `revoke_subject`

Seperti 4.5 dan 4.6 dan PRD 6.2: `revoke_subject` menghitung `lookup`, menandai semua baris aktif subjek `revoked` dengan `revoked_at`, satu audit per token, mengosongkan brankas (`customer_id_enc`, `nik_enc`, `nama_enc`, `hp_enc`, `rekening_enc`, `customer_lookup`, `purged_at`) bila `CUSTOMER`. Baris mapping tidak dihapus.

### 7.11 Retensi (`RetentionJob`)

Harian (`RETENTION_JOB_RUN_UTC`, wajib di env, contoh `01:00`, K-26; **[M4-10]** dijalankan `Scheduler` bersama sesudah layanan listen, tidak tumpang tindih, `RETENTION_DAYS` juga wajib) dan dapat dipicu di tes. Langkah 1: tandai `expired` baris aktif dengan `expires_at + GRACE < now`. Langkah 2: kosongkan `subject_id_enc`, `subject_lookup`, isi `purged_at` pada baris `expired`/`revoked` yang `COALESCE(revoked_at, expires_at) < now − RETENTION_DAYS`; satu audit `PURGE_IDENTITY` per baris, `actor_id='SYSTEM'`. Brankas tidak ikut job. Satu transaksi per batch. **[M2-09]** Batch dipilih `ORDER BY id LIMIT n FOR UPDATE SKIP LOCKED`: baris yang sedang dipegang pertukaran, re-issue, atau pencabutan dilewati dan diambil pada lari berikutnya (tidak menunggu, sehingga tidak ada tunggu melingkar); dua job serentak membagi baris tanpa dobel. Baris audit `PURGE_IDENTITY`: `requesting_service = 'PRIVACY_SERVICE'`, `actor_id = 'SYSTEM'`, `pseudonym`, `purpose`, `mapping_id`, `key_version`; langkah 1 tidak diaudit (spec 9.1). `RetentionJob.overdueCount()` adalah kueri pemeriksaan PRD 6.2 (TF-14): baris `expired`/`revoked` yang lebih tua dari `RETENTION_DAYS` dan masih memuat `subject_id_enc`; nol setelah lari yang tidak terhalang kunci. `nextRunAt(now, "HH:MM")` memberi saat berikutnya yang tegas setelah `now` (UTC). Pembacaan `RETENTION_DAYS` dan `RETENTION_JOB_RUN_UTC` dari env dan penjadwalannya menunggu pemasangan layanan.

## 8. Mesin status

**Token:** `active → expired` (waktu atau re-issue), `active → revoked`, `expired → revoked` (K-11). `grace` adalah status efektif, bukan kolom. `revoked` terminal.

**Disclosure:** `PENDING → APPROVED → USED`; `PENDING → REJECTED`; `APPROVED → EXPIRED` (ditandai lazily saat diperiksa/dibaca; GATE 5 tetap memakai `now > expires_at`). `USED`, `REJECTED`, `EXPIRED` terminal. Transisi di luar daftar ditolak (qa C-09).

**transaction_status:** non-terminal `PENDING`, `IN_PROGRESS`; terminal `COMPLETED`, `FAILED`, `CANCELLED`. `HELD` di transaction-db dicatat `IN_PROGRESS` (asumsi PRD 4).

## 9. Audit

### 9.1 Katalog action **[Δ PRD, E-05]**

`GENERATE_TOKEN`, `EXCHANGE_TOKEN`, `RESOLVE_NOTIF_DOMAIN`, `DE_PSEUDONYMIZE`, `RE_ISSUE`, `REVOKE_TOKEN`, `REVOKE_SUBJECT`, `PURGE_IDENTITY`, `STORE_IDENTITY`, `VIEW_AUDIT_LOG`, `DISCLOSURE_REQUESTED`, `DISCLOSURE_APPROVED`, `DISCLOSURE_REJECTED`. Reason GATE 5 (`DISCLOSURE_NOT_FOUND`, `DISCLOSURE_NOT_APPROVED`, `DISCLOSURE_EXPIRED`, `REQUESTER_MISMATCH`) berlaku pada `DE_PSEUDONYMIZE`, tidak pada `RESOLVE_NOTIF_DOMAIN`. `UPDATE_TX_STATUS` dan penandaan `expired` karena waktu tidak diaudit; rate limit dan JWT tidak sah dicatat di log Gateway, bukan audit.

### 9.2 Aturan

Boleh dicatat: `action`, `status`, `reason`, `requesting_service`, `actor_id`, `pseudonym`, `purpose`, `transaction_id`, `mapping_id`, `disclosure_id`, `attribute_names`, `key_version`. Dilarang: NIK, nama, HP, email, rekening, `subject_id`, nominal, geohash, rahasia, JWT, nilai atribut hasil pembukaan. Ditegakkan oleh DDL (tidak ada kolom untuk itu, `chk_attribute_names`), tipe `AuditEntry`, tes, dan pemindai kenari. Kegagalan sebelum pemanggil teridentifikasi (JWT tidak sah) tidak diaudit di Privacy.

**Format kolom bebas (M2-04):** `AuditWriter.record` menolak entri sebelum SQL dikirim bila `pseudonym` bukan `^PSEU-[0-9A-F]{8}$`, `transaction_id` bukan `^TX-[0-9]{1,29}$` (keduanya `platform-dan-ci.md` 3.1), `purpose` bukan `^[A-Z][A-Z0-9_]{0,47}$`, atau `actor_id` bukan `^(?![0-9]+$)[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` (tanpa `@`, titik, spasi, dan tidak seluruhnya angka, sehingga email, nama, dan angka mirip NIK tidak lolos). Penolakan melempar `AuditEntryError` yang hanya memuat nama field, dan operasi gagal 500 tanpa keadaan setengah jadi. Pola tidak membuktikan nilai bukan data pribadi; ia hanya menutup saluran yang mudah.

### 9.3 Rantai hash (hanya dirancang)

Rancangan, tidak diimplementasikan: `row_hash = SHA-256(prev_hash ‖ isi baris kanonik)`, `prev_hash` = `row_hash` baris sebelumnya menurut urutan penulisan yang diserialisasi (satu penulis per instans atau kunci advisory khusus audit). Rujukan konsep: Schneier dan Kelsey 1999; Crosby dan Wallach 2009 (belum diverifikasi, cek sumber sebelum dikutip). Kolom `prev_hash`/`row_hash` tetap ada (nullable) dan tidak diisi; implementasi tidak sebelum M3 stabil dan menunggu jawaban dosen (PRD 20 no. 2).

### 9.4 Penolakan: keputusan (diaudit) dan validasi bentuk (tidak diaudit)

**Aturan pemilah.** Penolakan yang hasilnya bergantung pada identitas pemanggil, status token atau permintaan, peran, atau tabel kebijakan (Tabel 1, 2, 3, 5, 6) adalah **keputusan**: dilempar sebagai `DeniedOperation`, tepat satu baris DENIED (bagian 7). Penolakan yang hanya bergantung pada sintaks permintaan itu sendiri (skema zod, field tak dikenal, tipe atau pola salah, bentuk campuran, ukuran body) adalah **validasi bentuk**: 422 `VALIDATION_ERROR`, tidak membaca basis data, tidak diaudit. Urutannya: autentikasi (di luar Privacy) → validasi bentuk → keputusan.

**Keputusan yang diaudit**, dicocokkan dengan katalog PRD (kolom Sumber; "spec" berarti spec menambahkannya dan pseudokode PRD tidak menyebut baris audit untuk reason itu):

| Action | Reason DENIED | Sumber |
| --- | --- | --- |
| `GENERATE_TOKEN` | `POLICY_NOT_ALLOWED` (termasuk `subject_id` dari bukan Gateway, TK-07), `TOKEN_NOT_FOUND` (bentuk 3) | PRD 7.1, 6.1 |
| `GENERATE_TOKEN` | `FORBIDDEN_ROLE` (P7 tanpa aktor auditor) | spec 4.1 (Tabel 1, kolom peran) |
| `EXCHANGE_TOKEN` | `POLICY_NOT_ALLOWED`, `TOKEN_NOT_FOUND`, `SERVICE_MISMATCH`, `REVOKED`, `EXPIRED` | PRD 7.2 |
| `RESOLVE_NOTIF_DOMAIN` | `POLICY_NOT_ALLOWED`, `TOKEN_NOT_FOUND`, `SERVICE_MISMATCH`, `PURPOSE_MISMATCH`, `REVOKED`, `EXPIRED` | PRD 7.3 |
| `DE_PSEUDONYMIZE` | `TOKEN_NOT_FOUND` (juga brankas hilang, K-13), `SERVICE_MISMATCH`, `PURPOSE_MISMATCH`, `REVOKED`, `EXPIRED`, `POLICY_NOT_ALLOWED`, `FORBIDDEN_ROLE` | PRD 7.4 |
| `DE_PSEUDONYMIZE` | `DISCLOSURE_NOT_FOUND`, `DISCLOSURE_NOT_APPROVED`, `DISCLOSURE_EXPIRED`, `REQUESTER_MISMATCH` (GATE 5) | PRD 7.4 + E-03, E-05 |
| `RE_ISSUE` | `TOKEN_NOT_FOUND`, `SERVICE_MISMATCH`, `POLICY_NOT_ALLOWED`, `REVOKED`, `TX_TERMINAL` | PRD 7.5 |
| `REVOKE_TOKEN` | `TOKEN_NOT_FOUND`, `FORBIDDEN_ROLE` | spec 4.5 |
| `REVOKE_SUBJECT` | `TOKEN_NOT_FOUND` (tidak ada token dan tidak ada brankas), `FORBIDDEN_ROLE` | spec 4.6, ADR-0005, katalog PRD 12 |
| `STORE_IDENTITY` | `POLICY_NOT_ALLOWED` | spec 4.9 (TK-20) |
| `DISCLOSURE_REQUESTED` | `INVALID_BASIS`, `ATTRIBUTE_NOT_ALLOWED` | spec 4.10, K-07 |

**Belum ditetapkan (K-27, menunggu Fanny; belum dikodekan):** `SELF_APPROVAL`, `DISCLOSURE_NOT_PENDING`, `FORBIDDEN_ROLE`, dan `DISCLOSURE_NOT_FOUND` pada `approve`/`reject`/permintaan; kegagalan token (`TOKEN_NOT_FOUND`, `SERVICE_MISMATCH`, bukan P7) pada `POST /disclosure-requests`; `FORBIDDEN_ROLE` pada `GET /audit-log` (4.8 hanya menyebut `VIEW_AUDIT_LOG` SUCCESS). Katalog PRD tidak menyebut baris audit untuk reason ini. Usulan spec: semuanya keputusan yang diaudit (`DISCLOSURE_REQUESTED`/`APPROVED`/`REJECTED`, `VIEW_AUDIT_LOG` DENIED), karena KPI PRD 1 menyatakan 100% operasi tercatat, SUCCESS maupun DENIED.

**Tidak diaudit:** validasi bentuk (di atas); JWT tidak sah (401) dan rate limit (429), yang dicatat di log Gateway; `PATCH /transaction-status` termasuk 409 `TX_TERMINAL` (K-09), karena `UPDATE_TX_STATUS` bukan operasi token (PRD Tabel 3; `TX_TERMINAL` pada `RE_ISSUE` tetap diaudit); penandaan `expired` karena waktu; galat infrastruktur 503 dan 500 (bukan keputusan; bila baris audit sendiri tidak dapat ditulis, operasi gagal 500 dan tentu tanpa baris).

**"Ditolak 422 tanpa baris" (S-24, TK-27, K-07).** `INVALID_BASIS` dan `ATTRIBUTE_NOT_ALLOWED` memeriksa nilai terhadap Tabel 6 dan Tabel 5, tabel kebijakan, bukan sintaks; karena itu keputusan yang diaudit walau klien melihat `VALIDATION_ERROR` 422 (ADR-0008). "Tanpa baris" berarti **tidak ada baris `disclosure_request`**; token tidak dibaca dan tidak ada baris `pseudonym_mapping` yang berubah. Ini tidak berarti tanpa audit: tepat satu baris `audit_log` `DISCLOSURE_REQUESTED` DENIED dengan reason `INVALID_BASIS` atau `ATTRIBUTE_NOT_ALLOWED`, `mapping_id` dan `disclosure_id` kosong, `attribute_names` kosong (nama di luar daftar tidak boleh disimpan: `chk_attribute_names`). Urutan: pola `case_ref` dan bentuk umum (validasi bentuk, tidak diaudit) → `basis` → `attributes` → token. Bila dasar dan atribut sama-sama salah, reason-nya `INVALID_BASIS`. Tes TK-27 menegaskan dua hal: 0 baris `disclosure_request` dan 1 baris audit DENIED.

## 10. Invarian keamanan

1. Hanya Gateway dan Privacy menerima `customer_id`/rekening mentah (bentuk 1 hanya `API_GATEWAY`); 2. hilir menukar dengan `source_pseudonym`; 3. tidak ada panggilan keluar; 4. satu layanan satu basis data; 5. token satu layanan tidak berlaku di layanan lain; 6. log hanya token dan `transaction_id`; 7. `requesting_service` hanya dari `azp` token layanan; 8. Privacy mati = 503 di Gateway.

Tambahan: tidak ada fallback ke data mentah; tidak ada endpoint di luar daftar (kecuali yang disetujui di `01-perubahan-prd.md`); aplikasi tidak terhubung sebagai pemilik skema; tidak ada `DELETE` pada tabel mana pun, kecuali `transaction_link` yang dihapus retensi (ADR-0013); respons error tidak membedakan token tidak ada dan bukan milik pemanggil di sisi klien.

## 11. Kasus gagal

| Kasus | Perilaku |
| --- | --- |
| Basis data tidak tersedia/timeout | 503 `SERVICE_UNAVAILABLE`; tidak ada keadaan setengah jadi (transaksi batal) |
| Rahasia/kunci hilang saat start | proses tidak start; pesan tanpa nilai |
| Audit tidak dapat ditulis | operasi gagal 500; tidak berhasil tanpa audit |
| Tabrakan nilai pseudonym > 20 kali | 500 `INTERNAL_ERROR`; dicatat di log dengan `request_id` |
| `key_version` tak dikenal pada dekripsi | 500; tidak membocorkan detail |
| Permintaan paralel kombinasi sama | satu `reused:false`, sisanya `reused:true`, satu baris aktif |
| Persetujuan dipakai paralel | tepat satu `DE_PSEUDONYMIZE` SUCCESS |
| Jam tidak sinkron | grace 30 detik meredam; semua UTC |

## 12. Kriteria penerimaan

Tes ditulis lebih dulu dan terbukti gagal; nama tes memuat ID. Basis data PostgreSQL asli dengan peran asli.

| Tiket | Kriteria | ID |
| --- | --- | --- |
| M2-02 | round trip, IV acak, integritas (versi/IV/ciphertext/tag), pemindahan antar baris, jenis, kolom ditolak; kunci 32 byte dan berbeda; "||" tak ambigu; dump tanpa plaintext; rotasi `subject_lookup` tidak merusak dekripsi | S-31, S-32, FR-25, FR-30, NFR-05, T-16 |
| M2-03 | tabel kebijakan: semua baris sah lolos, kombinasi lain ditolak; peran P7 | FR-04, FR-27, FR-28, TK-06, TK-13, TK-14 |
| M2-04 | **dua pool** (bagian 3): `INSERT` audit lewat `privpay_app` tanpa `RETURNING` berhasil; `GET /audit-log` lewat `privpay_auditor` berhasil; pool `auditor` tidak dapat menulis atau membaca mapping/brankas; satu baris audit per operasi (SUCCESS dan DENIED) | FR-13, TK-10, S-34, S-35 |
| M2-05 | `buat_token`: 50 permintaan paralel (≥ 5 putaran) satu `reused:false`/49 `reused:true`/satu baris aktif; **tes penjaga** bahwa tanpa kunci advisory skenario itu ditolak `uq_mapping_active`; tabrakan pseudonym diulang (injeksi); `FakeClock` batas grace | TF-07, NFR-13, C-03, C-04, T-05 |
| M2-05 | **TF-15 khusus:** tes berurutan (tanpa konkurensi): terbitkan, majukan `FakeClock` melewati TTL, terbitkan lagi: berhasil, pseudonym berbeda, baris lama `expired`. Tes ini harus **gagal sendirian** bila langkah penandaan kedaluwarsa (7.2 butir 3) dihapus, karena INSERT melanggar `uq_mapping_active` secara deterministik. Tes penjaga SQL langsung membuktikan pelanggaran `23505` bila baris aktif kedaluwarsa tidak ditandai | TF-15, FR-33, C-02, T-06 |
| M2-05 | `EXPLAIN` tanpa `Seq Scan` pada ≥ 20.000 baris | NFR-04 |
| M2-06 | pertukaran X1/X2, semua penolakan Tabel 2; bentuk 3 untuk P6/P7; baris `purged` → 404 | FR-07, FR-28, TK-01, TK-07, TK-13 |
| M2-07 | re-issue: transaksi terminal 409, token lama `expired`, token baru berbeda; **dua kali dipanggil hasil sama**; `PATCH /transaction-status` | TK-09, C-05, FR-10, FR-11, FR-17 |
| M2-08 | `/identity` hanya Gateway, idempoten, ciphertext per kolom, TK-20 | FR-42, TK-20 |
| M2-09 | retensi: kolom kosong, `chk_purged`, satu audit `PURGE_IDENTITY` per baris, `generate_from_transaction` → `TOKEN_NOT_FOUND`, kueri pemeriksaan nol baris | FR-31, NFR-18, TF-14, C-06 |
| M3-01 | `/resolve-domain` | FR-08 |
| M3-02 | revoke token/subjek; brankas dikosongkan; `PURGE_IDENTITY`; jumlah dikembalikan | FR-12, FR-29, FR-44, TK-04, TK-17 |
| M3-03 | `GET /audit-log*` dengan filter, paginasi, `VIEW_AUDIT_LOG`, `alerts` | FR-14, US-07, US-08, US-13 |
| M3-04 | alur disclosure: PENDING→APPROVED→USED, REJECTED, EXPIRED; `SELF_APPROVAL`; `FORBIDDEN_ROLE`; `INVALID_BASIS`/`ATTRIBUTE_NOT_ALLOWED` tanpa baris; `chk_four_eyes` | TK-24, TK-25, TK-27 |
| M3-05 | lima gerbang + syarat tambahan; pembukaan sah hanya atribut yang disetujui; sekali pakai; pemohon lain ditolak; paralel | TK-08, TK-15, TK-21, TK-23, TK-26, TK-28, FR-09, FR-43 |
| M3-06 | seluruh TK sisi Privacy dalam dua lapis (reason rinci + tepat satu baris audit; lewat Gateway hanya `ACCESS_DENIED`) | TK-01..TK-10, TK-13..TK-15, NFR-10, ADR-0008 |
| M1-02 | **`timingSafeEqual`:** setiap perbandingan rahasia lewat `safeEqual` (lihat `platform-dan-ci.md`) | T-10 |

**Kriteria wajib dari hasil Fase 2:** (1) dua pool audit terbukti dengan tes pada M2-04; (2) `timingSafeEqual` pada M1-02; (3) `ON CONFLICT` paralel `POST /transaction` pada `transaction.md` M4-01; (4) TF-15 khusus pada M2-05. Keempatnya adalah kriteria penerimaan tiket, bukan catatan.

## 13. Di luar cakupan

Implementasi rantai hash, rotasi kunci (hanya `key_version` dan prosedur tertulis), rotasi `K_index`, penghapusan fisik mapping/audit, pembukaan lewat jalur selain disclosure, replika/HA, mode `static` (ADR-0003).

## 14. Keputusan spec (diterima Fanny, bawaan, Gerbang 3)

K-06 pola `AccountNumber` `^[0-9]{8,20}$`. K-07 `INVALID_BASIS`/`ATTRIBUTE_NOT_ALLOWED` ditulis sebagai audit DENIED. K-08 filter `action` dan `disclosure_id` pada `GET /audit-log`. K-09 status transaksi terminal tidak dapat kembali. K-10 `/identity` idempoten (201 lalu 200). K-11 token `expired` dapat dicabut dan pencabutan ulang idempoten. K-12 batas body 16 KiB, pola `case_ref`, batas 20 percobaan tabrakan nilai pseudonym. K-26 jam job retensi (`RETENTION_JOB_RUN_UTC`). K-13 brankas hilang saat pembukaan → `TOKEN_NOT_FOUND`.
