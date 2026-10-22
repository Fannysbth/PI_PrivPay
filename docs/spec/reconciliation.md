# Spesifikasi: Reconciliation Service dan bank simulator

Sumber: PRD 9 (alur D dan E), 10, 11, 13 (FR-21, 22, 32, 41), 16, 18.1 (TF-05, 06, 13, 16); D-01..D-05; ADR-0007, 0008. **[Δ PRD]** dan **[K-nn]** seperti pada spec lain.

## 1. Tanggung jawab

Mencocokkan settlement harian dengan transaksi memakai token rekening, menerima laporan settlement yang sudah bertoken, dan melayani audit internal berbasis pseudonim (D-01) serta menjadi perantara pembukaan identitas bersyarat ke Privacy Service (D-02). Reconciliation tidak pernah memegang identitas dan **tidak menyimpan hasil pembukaan identitas** (T-14).

## 2. Modul dan seam

| Modul | Interface | Catatan |
| --- | --- | --- |
| `Reconciler` (murni) | `match(transactions, items)` mengembalikan `{pairs, unmatchedItems, unmatchedTransactions, status}` | algoritma pencocokan tanpa I/O |
| `ReconciliationService` | `run(date)`, `receiveReport(report)`, `auditRequest(req, actor)`, `disclose(req, actor)` | orkestrasi D1..D4 dan E |
| `ReconciliationRepository` | seam repositori per mode | proposed `account_pseudonym`, baseline `account_number` |
| `TransactionClient`, `PrivacyClient` | `completedOn(date)`, `byId(id)`; `accountToken(transactionId)`, `auditToken(transactionId, actorToken)`, `open(auditToken, disclosureId, actorToken)` | adapter palsu untuk tes |

## 3. Kontrak

### 3.1 `POST /reconciliation/settlement-report` (D3, setelah tokenisasi Gateway)

Pemanggil `API_GATEWAY`. `{batch_date, items:[{account_pseudonym, amount, bank_reference}]}`; validasi: tanggal ISO, 1..500 item, `Pseudonym`, `amount` bilangan bulat ≥ 1, `bank_reference` `^[A-Z0-9-]{1,32}$`, `UNIQUE (batch_id, bank_reference)` (K-05). Laporan disimpan sebagai `settlement_items` untuk batch tanggal itu. **Satu laporan per tanggal; pengiriman ulang dengan isi identik 200, dengan isi berbeda 409 `IDEMPOTENCY_CONFLICT`** (K-22). Respons 202 `{batch_date, item_count}`. Tidak ada nomor rekening di muatan maupun basis data (FR-32).

### 3.2 `POST /reconciliation/run` (D1..D4, FR-41)

Pemanggil: penjadwal internal atau `API_GATEWAY` dengan `X-Actor-Token` berperan `admin`. `{date}` (ISO). Langkah:

1. **D1:** `GET /transaction/completed?date=` ke Transaction (endpoint diusulkan, K-18; JWT `RECONCILIATION`), berhalaman; hanya `COMPLETED`; HELD dan FAILED tidak ikut.
2. **D2:** tiap transaksi: `POST /pseudonymize` bentuk 3 `{ACCOUNT, transaction_id, RECONCILIATION, DAILY_RECONCILIATION}` (idempoten; Privacy menurunkan rekening dari baris mapping transaksi). `TOKEN_NOT_FOUND` (identitas sudah dikosongkan retensi): transaksi dihitung tidak berpasangan dan batch lanjut (satu item tidak boleh menghentikan batch).
3. **D4:** `Reconciler.match` mencocokkan `(account_pseudonym, amount)` secara satu-ke-satu antara transaksi dan item laporan tanggal yang sama; `bank_reference` unik; item atau transaksi yang tidak berpasangan ditandai. Simpan `settlement_batches` (`batch_id = B-YYYYMMDD`) dan `settlement_items.matched`.
4. Status batch **[K-22]**: `unmatched = (#item − matched) + (#transaksi − matched)`; `MATCHED` bila `unmatched = 0`; `MISMATCHED` bila `matched = 0` dan ada item atau transaksi; selain itu `PARTIAL`.
5. Respons 200 `{batch_id, tx_count, matched, unmatched, status}` (contoh PRD: `B-20261005`, 2, 2, 0, `MATCHED`). Menjalankan ulang tanggal yang sama menimpa batch itu (idempoten); tidak ada laporan untuk tanggal itu: batch dengan `item_count = 0` dihitung sesuai aturan di atas.

Penjadwal harian: `RECON_DAILY_RUN_UTC` (bawaan `00:10`, **[K-23]**), memakai `Clock`; menjalankan tanggal sebelumnya.

### 3.3 `POST /reconciliation/audit-request` (audit rutin, E1/E2, D-01)

Pemanggil `API_GATEWAY` dengan `X-Actor-Token` berperan `auditor`. `{transaction_id, reason_code}`; `reason_code` ∈ `AMOUNT_MISMATCH`, `DISPUTE`, `OTHER` (tanpa teks bebas). Langkah: ambil data transaksi (`GET /transaction/{id}`, K-18; tidak ada → `TRANSACTION_NOT_FOUND` 404, K-02); `POST /pseudonymize` bentuk 3 `{CUSTOMER, transaction_id, RECONCILIATION, INTERNAL_AUDIT}` dengan `X-Actor-Token` (P7 membutuhkan aktor auditor); simpan satu baris `audit_requests (transaction_id, reason_code, actor_id)`. Respons 200 `{request_id, transaction_id, audit_token, amount, status}`. **Tidak ada `customer_id`, NIK, atau nama** (TK-22). Satu baris `audit_requests` dan satu baris audit Privacy per permintaan (FR-22).

### 3.4 `POST /reconciliation/disclosure` **[Δ PRD, K-15]**

PRD 9 (E3) menyebut Reconciliation memanggil `/de-pseudonymize` pada pembukaan bersyarat, tetapi tidak ada rute yang memicunya dan PRD 10 tidak mendaftarkannya. Disetujui Fanny (Gerbang 3, errata E-25): pemanggil `API_GATEWAY` dengan `X-Actor-Token` berperan `auditor`; `{audit_token, disclosure_id}`; Reconciliation memanggil `POST /de-pseudonymize {pseudonym: audit_token, purpose: "INTERNAL_AUDIT", disclosure_id}` dengan JWT `RECONCILIATION` + `X-Actor-Token` yang sama; respons 200 `{attributes}` **hanya diteruskan dan tidak disimpan** (tidak ada tabel, log, atau metrik yang memuat nilainya). Penolakan Privacy diteruskan (klien melihat `ACCESS_DENIED`).

### 3.5 `GET /health`, `GET /metrics`

Sesuai `platform-dan-ci.md` bagian 8.

## 4. Bank simulator

Layanan NestJS kecil; `POST /simulate/settlement {batch_date}` membangun laporan dari seed fiktif (rekening `1234567801..03` dan nominal dari PRD 16) lalu memanggil Gateway `POST /settlement/report` dengan JWT peran `bank` (`azp=bank-simulator`). Data uji fiktif jelas palsu, tidak ada PII nyata, dan tidak ada kredensial di repo (rahasia klien dari berkas `secrets/`). Dapat menyuntikkan item tidak valid (rekening kosong, nominal negatif) dan item tak berpasangan untuk TF-13/TF-16.

**[M4-06, N-32, N-33]** Batch dibuat saat laporan atau run pertama tiba (`tx_count = 0`, `total_amount = 0`, `status = MISMATCHED` sampai run menimpa); laporan yang tiba setelah run tanpa laporan adalah laporan pertama. `TOKEN_NOT_FOUND` dan `REVOKED` dari Privacy pada D2 = transaksi tak berpasangan; jawaban Privacy lain = run berhenti 503 sebelum batch disentuh. Reconciliation sendiri menegakkan 500 item dan 64 KiB (N-27) dan menolak `bank_reference` ganda dalam satu laporan (422), bukan hanya Gateway. `DailyRun` (`nextRunAt`, `runPrevious`) ada tetapi belum dijadwalkan ke siklus hidup proses.

## 5. Invarian dan kasus gagal

Tidak ada nomor rekening di `settlement_items` dan tidak ada hasil pembukaan di `reconciliation-db` (inspeksi skema dan pemindai kenari); `audit-request` tidak membuka atribut brankas; hanya peran yang disebut dapat memanggil; kegagalan satu transaksi tidak menghentikan batch; laporan tidak valid → 422 tanpa token terbit (validasi di Gateway). Privacy mati saat D2: transaksi dihitung tidak berpasangan atau batch ditunda dengan 503 (K-22). Transaction mati saat D1: 503, batch tidak dibuat.

## 6. Kriteria penerimaan

| Tiket | Kriteria | ID |
| --- | --- | --- |
| M4-06 | `Reconciler`: dua item cocok → `MATCHED`, item tak berpasangan → `PARTIAL`, tak satu pun cocok → `MISMATCHED`; token D2 sama dengan token D3; HELD tidak ikut (total 1.535.000 pada data PRD 16); `TOKEN_NOT_FOUND` tidak menghentikan batch | FR-21, FR-41, TF-05, TF-13, TF-16, C-10 |
| M4-06 | laporan tak valid → 422 tanpa token terbit; tanpa nomor rekening di basis data; pengiriman ulang laporan | FR-32, TF-13, S-38 |
| M4-07 | `audit-request`: token P7 + data transaksi tanpa identitas (pemindai kenari tidak menemukan `customer_id`/NIK/nama); satu baris `audit_requests` dan satu audit Privacy; peran auditor wajib | FR-22, TK-22, TF-06 (ditulis ulang) |
| M4-07 | `disclosure`: hanya atribut yang disetujui diteruskan; tidak disimpan di `reconciliation-db`, log, atau metrik (pemindai kenari); penolakan diteruskan | FR-09, FR-43, TK-21, S-27, T-14 |
| M4-06 | bank simulator: kasus valid, tidak valid, tak berpasangan | TF-13, TF-16 |
| M5-01 | adapter baseline | FR-23 |

## 7. Di luar cakupan

Peninjauan settlement oleh manusia, rekonsiliasi multi-bank, laporan format bank nyata, UI audit.

## 8. Keputusan spec (diterima Fanny, bawaan, Gerbang 3)

K-15 rute `/reconciliation/disclosure`. K-18 endpoint Transaction untuk D1/E1. K-22 aturan status batch, satu laporan per tanggal, dan perilaku bila laporan atau Privacy tidak ada. K-23 jam penjadwal harian `RECON_DAILY_RUN_UTC`.
