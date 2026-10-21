# Spesifikasi: Transaction Service

Sumber: PRD 9 (alur B, C), 10 (kontrak transaksi, kebijakan kegagalan), 11, 13 (FR-16, 17, 34..36, 39, 40), 14 (NFR-12, 23, 24); ADR-0006, 0008, 0009. **[Δ PRD]** dan **[K-nn]** seperti pada spec lain.

## 1. Tanggung jawab

Memproses transaksi dengan token dan atribut non-identitas, mengorkestrasi Fraud dan Notification, menjaga idempotensi (`Idempotency-Key`), mengelola transaksi `HELD` (daftar dan review), menandai transaksi `PENDING` yang menggantung, dan memperbarui status ke Privacy Service. Saldo dan ledger tidak dimodelkan; debit dan kredit disimulasikan (PRD 20 asumsi 7). Tidak pernah memegang `customer_id`, NIK, nama, HP, atau rekening pada mode proposed.

## 2. Modul dan seam

| Modul | Interface | Catatan |
| --- | --- | --- |
| `TransactionProcessor` | `process(req)` mengembalikan `{status, httpStatus, body}` | memuat idempotensi, orkestrasi, dan mesin status; modul dalam |
| `TransactionRepository` | seam **repositori per mode** (ADR-0006): `insertPending`, `find`, `updateTokens`, `finish`, `listHeld`, `sweepPending`, `completedOn`, `byId` | dua adapter: proposed (token) dan baseline (identitas); kode domain tidak mengimpor folder per mode |
| `SubjectReferencePort` | `forFraud(row)`, `forNotification(row)`, `reissue(row)` | dua adapter nyata: proposed (menukar/menerbitkan ulang lewat Privacy, X1/X2, `re-issue`) dan baseline (mengembalikan identitas apa adanya); perbedaan mode terisolasi di sini |
| `FraudClient`, `NotificationClient`, `PrivacyClient` | `assess`, `send`, `exchange`/`reIssue`/`patchStatus` | memakai `HttpClient` bersama; adapter palsu untuk tes |
| `Delay` | `wait(ms)` | `FakeDelay` di tes (tanpa `sleep` nyata) |

## 3. Kontrak API

Konvensi: `platform-dan-ci.md` bagian 4 dan 6. Pemanggil rute transaksi harus `API_GATEWAY` (selain itu 403 `POLICY_NOT_ALLOWED`).

### 3.1 `POST /transaction`

Permintaan (Gateway→Transaction): `{transaction_id, idempotency_key, customer_token, account_token, merchant_id, amount, geohash}` (zod ketat; `idempotency_key` UUID; token `Pseudonym`; `amount` bilangan bulat ≥ 1; `merchant_id` harus ada di `merchants`, selain itu 422). Respons 201 `{transaction_id, status}` (`COMPLETED`, `HELD`, atau `FAILED`); replay identik 200 dengan isi sama; 409 `IDEMPOTENCY_CONFLICT`.

### 3.2 `GET /transaction/held`

Peran `fraud_analyst` (via `X-Actor-Token`, `Authorization`=`API_GATEWAY`). Query `limit` (50, maks 200), `cursor` (opak: `created_at`, `transaction_id`; urutan `created_at ASC`). Respons `{items:[{transaction_id, amount, risk_score, fraud_decision, created_at}], next_cursor}`. Tidak memuat identitas maupun token.

### 3.3 `POST /transaction/{transaction_id}/review`

Peran `fraud_analyst`. Body `{decision: "APPROVE"|"REJECT", reason_code: "CONFIRMED_BY_CUSTOMER"|"SUSPECTED_FRAUD"|"OTHER"}` (tanpa teks bebas). Respons 200 `{transaction_id, status, reviewed_at}`. Baris dikunci (`SELECT ... FOR UPDATE`); status harus `HELD`, selain itu 409 `NOT_HELD` (review ganda paralel: satu berhasil, satu `NOT_HELD`). `APPROVE`→`COMPLETED`, `REJECT`→`FAILED`; `reviewed_by` = `sub` token aktor, `reviewed_at`, `completed_at` (bila selesai). Status di Privacy diperbarui (`PATCH`), notifikasi `TX_COMPLETED` atau `TX_REJECTED` dikirim (gagal kirim tidak mengubah hasil).

### 3.4 Endpoint untuk Reconciliation **[Δ PRD, K-18]**

PRD 9 (D1, E1) mengandaikan Reconciliation membaca transaksi, tetapi PRD 10 tidak mendaftarkan endpoint-nya. Disetujui Fanny (Gerbang 3, errata E-23/E-24):

- `GET /transaction/completed?date=YYYY-MM-DD&limit&cursor`: `{items:[{transaction_id, amount, completed_at}], next_cursor}`; hanya `COMPLETED` (HELD dan FAILED tidak ikut); tanggal menurut `completed_at` UTC; tanpa token dan tanpa identitas; pemanggil `RECONCILIATION`.
- `GET /transaction/{transaction_id}`: `{transaction_id, amount, status, created_at, completed_at}`; pemanggil `RECONCILIATION`; tidak ada: 404 `TRANSACTION_NOT_FOUND` (K-02).

### 3.5 `GET /health`, `GET /metrics`

Sesuai `platform-dan-ci.md` bagian 8.

## 4. Mesin status

```
PENDING ─(ALLOW atau di bawah ambang)─▶ COMPLETED
PENDING ─(HOLD_FOR_VERIFICATION atau FRAUD_UNAVAILABLE)─▶ HELD ─(APPROVE)─▶ COMPLETED
                                                           └─(REJECT)──▶ FAILED
PENDING ─(BLOCK)─▶ FAILED
PENDING ─(lewat TX_PENDING_TIMEOUT_SECONDS)─▶ FAILED
```

`COMPLETED` dan `FAILED` terminal. Pembaruan status ke Privacy: `COMPLETED`→`COMPLETED`, `HELD`→`IN_PROGRESS`, `FAILED`→`FAILED` (PRD asumsi 4).

## 5. Alur pemrosesan

1. **Idempotensi (ADR-0009):** `INSERT ... (status 'PENDING') ON CONFLICT (idempotency_key) DO NOTHING RETURNING transaction_id`. Bila ada baris: bandingkan `customer_token`, `account_token`, `merchant_id`, `amount`, `geohash` dengan permintaan. Sama dan status terminal/`HELD`: 200 dengan isi tersimpan. Sama tetapi masih `PENDING` (pemenang sedang memproses): tunggu lewat `Delay` hingga `HTTP_TIMEOUT_MS`, lalu kembalikan 200 bila sudah selesai, selain itu 409 `IDEMPOTENCY_CONFLICT` yang aman diulang. Berbeda: 409 `IDEMPOTENCY_CONFLICT` tanpa membocorkan data baris. Jendela efektif sama dengan `TTL_PAYMENT_PROCESSING`; di luar itu kunci yang sama menghasilkan 409 (keterbatasan tercatat).
2. **Keputusan fraud:** bila `amount < FRAUD_AMOUNT_THRESHOLD`: lanjut ke 3 dengan `COMPLETED`. Bila `≥`: tukar token ke Fraud (X1, `forFraud`), lalu `POST /fraud/assess` dengan `{pseudonym, amount, tx_hour (UTC), geohash}` (tanpa retry, bukan idempoten). `ALLOW`→`COMPLETED`; `HOLD_FOR_VERIFICATION`→`HELD`; `BLOCK`→`FAILED`. **[M4-01, sementara sampai M4-02]** Fraud belum terpasang: jumlah di atas atau sama dengan ambang menjadi `HELD` dengan `fraud_decision='FRAUD_UNAVAILABLE'` (jalur kegagalan Fraud), tidak pernah `COMPLETED`. **Kegagalan pertukaran atau timeout Fraud:** `HELD` dengan `fraud_decision='FRAUD_UNAVAILABLE'` (NFR-24, TF-11), notifikasi `TX_HELD_VERIFY` tetap dikirim.
3. **Selesai:** simpan `status`, `risk_score`, `fraud_decision`, `completed_at`; `PATCH /transaction-status` ke Privacy (idempoten; gagal setelah semua percobaan: dicatat di log dengan `transaction_id`, status lokal tetap, keterbatasan PRD 20 no. 12).
4. **Notifikasi:** tukar token ke Notification (X2, `forNotification`) lalu `POST /notification/send` (tanpa retry) dengan template `TX_COMPLETED`, `TX_HELD_VERIFY`, atau `TX_REJECTED` (BLOCK). Kegagalan di sini tidak mengubah status transaksi dan dicatat di log dengan `transaction_id`; tidak ada pengiriman ulang otomatis.
5. **Token kedaluwarsa di tengah proses (TF-04):** bila pertukaran mengembalikan `EXPIRED`, `reissue` kedua token (hanya selama transaksi non-terminal), perbarui `customer_token`/`account_token` pada baris, ulangi pertukaran satu kali. `TX_TERMINAL` atau penolakan lain diperlakukan sebagai kegagalan langkah itu (jalur 2 atau 4). `re-issue` aman diulang (Privacy mengembalikan token baru yang sama pada panggilan kedua).
6. **Pembersih `PENDING`:** job periodik (`TX_SWEEP_INTERVAL_SECONDS`, bawaan 30, **[K-19]**) menandai `FAILED` baris `PENDING` yang lebih tua dari `TX_PENDING_TIMEOUT_SECONDS` dan memperbarui Privacy (usaha terbaik). `Clock` disuntik (TF-17).

Mode baseline: langkah sama; `SubjectReferencePort` baseline tidak memanggil Privacy, Fraud menerima `customer_id`, Notification menerima `customer_id`; repositori baseline menyimpan `customer_id` dan `account_number` (ADR-0006).

## 6. Invarian keamanan

Tidak ada kolom, log, atau muatan keluar berisi identitas (proposed); log hanya `transaction_id` dan token; `fraud_token` dan `notif_token` tidak disimpan (hanya transit); hanya `API_GATEWAY` (dan `RECONCILIATION` untuk 3.4) yang memanggil; peran `fraud_analyst` untuk 3.2 dan 3.3 diperiksa dari token aktor; tidak ada fallback ke data mentah; kegagalan Fraud tidak pernah menyelesaikan transaksi di atas ambang sebagai `COMPLETED`.

## 7. Kasus gagal

| Kasus | Perilaku |
| --- | --- |
| Fraud mati/timeout/pertukaran gagal | `HELD`, `FRAUD_UNAVAILABLE`, `TX_HELD_VERIFY` |
| Notification mati/pertukaran gagal | transaksi tetap `COMPLETED`, notifikasi dilewati dan dicatat |
| `PATCH` ke Privacy gagal | status lokal tetap, dicatat di log |
| Proses berhenti di tengah | `PENDING` → `FAILED` oleh pembersih |
| Merchant tidak dikenal | 422 |
| Kunci idempotensi sama, isi beda | 409 |
| Review pada transaksi bukan `HELD` | 409 `NOT_HELD` |
| Token kedaluwarsa | re-issue lalu coba lagi satu kali |

## 8. Kriteria penerimaan

| Tiket | Kriteria | ID |
| --- | --- | --- |
| M4-01 | skema dan repositori proposed; transaksi hanya token (inspeksi skema); `201`/`200`/`409` idempotensi: sama, beda `amount`/`merchant_id`/`geohash`/rekening/pelanggan, replay setelah re-issue, replay di luar jendela, tanpa kolom identitas | FR-16, FR-36, NFR-23, TF-08 |
| M4-01 | **`ON CONFLICT` paralel (kriteria wajib hasil Fase 2, bukan catatan):** dua dan 20 permintaan identik bersamaan, ≥ 20 putaran, di PostgreSQL asli dengan peran asli: tepat satu baris, semua respons 200/201 dengan `transaction_id` sama, tanpa 5xx; permintaan bersamaan dengan isi beda: satu menang, lainnya 409; pemenang berhenti di `PENDING`: yang kalah 409 setelah penantian (`FakeDelay`); penantian tidak memakai `sleep` nyata | NFR-23, S-02, T-13 |
| M4-02 | orkestrasi: di bawah/atas ambang, `ALLOW`/`HOLD`/`BLOCK` (skor disuntik), Fraud mati → `HELD`+`FRAUD_UNAVAILABLE`, Notification mati → `COMPLETED`, PATCH gagal dicatat, re-issue di tengah proses (TF-04), retry hanya untuk operasi idempoten (uji injeksi keterlambatan) | FR-10, FR-17, FR-40, NFR-12, NFR-24, TF-02, TF-03, TF-04, TF-11 |
| M4-03 | daftar `HELD` tanpa identitas, review APPROVE/REJECT, `NOT_HELD`, review paralel, pembersih `PENDING` | FR-34, FR-35, FR-39, TF-09, TF-10, TF-17 |
| M4-01/M4-06 | endpoint 3.4 (bila disetujui) | FR-21, TF-05 |
| M5-01/M5-02 | adapter repositori dan `SubjectReferencePort` baseline; suite perilaku yang sama lulus pada kedua adapter | FR-23, ADR-0006 |

## 9. Di luar cakupan

Model saldo/ledger, verifikasi kepemilikan rekening, pengiriman ulang notifikasi otomatis, pembatalan pelanggan (`CANCELLED` hanya dikenal di Privacy), teks bebas pada review.

## 10. Keputusan spec (diterima Fanny, bawaan, Gerbang 3)

K-18 endpoint 3.4 (PRD 10 tidak mendaftarkannya). K-19 `TX_SWEEP_INTERVAL_SECONDS` (env baru, bawaan 30). K-25 penantian pemenang yang masih `PENDING` hingga `HTTP_TIMEOUT_MS` lewat `Delay` sebelum menjawab 200 atau 409 (ADR-0009 hanya menyebut respons akhirnya). Selain itu K-02 dan K-16 pada spec lain berlaku di sini.
