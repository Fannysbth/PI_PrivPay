# PRD PrivPay v2.4 — ringkas

Ringkasan untuk kerja harian. Rujukan bagian ("PRD x.y") mengacu ke `docs/reference/PRD_PrivPay_v2.4_lengkap.md`. Bila ringkasan ini berbeda dari PRD lengkap, PRD lengkap menang, lalu laporkan selisihnya ke user.

## 1. Tujuan

Membuktikan bahwa identitas pelanggan dapat dihapus dari semua layanan hilir tanpa mematahkan transaksi, deteksi fraud, notifikasi, dan rekonsiliasi. Nama teknik: Context-Aware Service/Purpose-Bound Dynamic Pseudonymization. Jenisnya *regular (non-blind)*: Privacy Service mengetahui identitas asli (keterbatasan yang diakui). "Dinamis" = token berganti menurut layanan, tujuan, dan siklus hidup; bukan berganti tiap request (token aktif dipakai ulang selama TTL, jadi semi-dinamis).

KPI (PRD 1): paparan PII di Transaction/Fraud/Reconciliation = 0 field identitas; 100% skenario fungsional lulus di mode proposed; 100% akses lintas service/purpose ditolak; kenaikan latensi p95 ≤ 20% dan penurunan throughput ≤ 15% terhadap baseline (ambang ditetapkan sendiri); 100% operasi token tercatat di audit.

## 2. Layanan (PRD 5)

| Layanan | Tugas | DB | Data mentah |
| --- | --- | --- | --- |
| API Gateway (Kong + plugin `privacy-tokenizer`) | Routing, rate limit, validasi JWT, tokenisasi pertama, buang NIK/nama/email | kong-db (konfigurasi) | Ya, hanya transit |
| Auth (Keycloak) | Autentikasi, JWT, peran, service account | keycloak-db | Ya (identitas login; keterbatasan) |
| Privacy Service | Token, pertukaran, pembukaan, Policy Engine, brankas identitas, modul Audit | privacy-db | Ya, terenkripsi; satu-satunya pemegang mapping |
| Transaction | Proses transaksi, orkestrasi Fraud dan Notification | transaction-db | Tidak |
| Fraud | Skor risiko aturan berbobot | fraud-db | Tidak |
| Notification | Registrasi kontak, kirim notifikasi | notification-db | HP saja (pengecualian sadar) |
| Reconciliation | Cocokkan settlement, permintaan audit | reconciliation-db | Tidak |

Di luar tujuh layanan itu ada pihak simulasi: bank simulator dan penyedia SMS simulator (PRD Out of scope: integrasi nyata). Bentuknya diputuskan di Fase 1 (OPEN_QUESTIONS Q-06).

## 3. Token (PRD 6)

`pseudonym = "PSEU-" || UPPER(trunc_8hex(HMAC-SHA256(K_token, subject_type || subject_id || service_id || purpose || nonce)))`, nonce = UUID v4 per penerbitan. Dipakai ulang untuk (subjek, layanan, purpose) selama masih aktif (kunci pakai-ulang tanpa `transaction_id`). Tabrakan ditangani unique constraint + ulang dari nonce.

Tiga kunci terpisah (jangan dipakai ulang): `K_token` (`PSEUDONYM_HMAC_SECRET`), `K_index` (`BLIND_INDEX_SECRET`; `subject_lookup = HMAC(K_index, subject_type || subject_id)`), `K_field` (`FIELD_ENCRYPTION_KEY`; AES-256-GCM, format `key_version || IV12 || ciphertext || tag16`, AAD = subject_type untuk mapping, nama kolom untuk brankas). Ketiganya dari berkas rahasia/Docker secret (dibaca lewat `*_FILE`, NFR-22), hanya ada di privacy-service.

Status: `active` → (grace 30 detik) → `expired` | `revoked`. `status_efektif` menggabungkan kolom status, `expires_at`, dan grace. Penandaan expired dilakukan malas di awal `buat_token` (dalam transaksi yang sama) agar indeks unik parsial tidak memblokir INSERT.

## 4. Tabel kebijakan (PRD 6.1) — final

Tabel 1, konteks sah (selain ini ditolak `POLICY_NOT_ALLOWED`, tanpa baris mapping):

| # | service_id | purpose | subject | Cara terbit | TTL detik | Dibuka? |
| --- | --- | --- | --- | --- | --- | --- |
| P1 | TRANSACTION | PAYMENT_PROCESSING | CUSTOMER | identitas, oleh Gateway | 900 | Tidak |
| P2 | TRANSACTION | PAYMENT_PROCESSING | ACCOUNT | identitas, oleh Gateway | 900 | Tidak |
| P3 | FRAUD | FRAUD_DETECTION | CUSTOMER | pertukaran | 2.592.000 | Tidak |
| P4 | NOTIFICATION | NOTIFICATION | CUSTOMER | pertukaran | 900 | Tidak (hanya resolve domain) |
| P5 | NOTIFICATION | NOTIFICATION_REGISTRATION | CUSTOMER | identitas, oleh Gateway | 31.536.000 | Tidak |
| P6 | RECONCILIATION | DAILY_RECONCILIATION | ACCOUNT | transaksi (Reconciliation) atau identitas (Gateway, laporan bank) | 86.400 | Tidak |
| P7 | RECONCILIATION | INTERNAL_AUDIT | CUSTOMER | transaksi | 600 | Ya, peran auditor |

Tabel 2, pertukaran token (hanya dua): X1 P1→P3 oleh TRANSACTION; X2 P1→P4 oleh TRANSACTION.

Tabel 3, operasi dan pemanggil sah: GENERATE dari identitas (API_GATEWAY; P1,P2,P5,P6); GENERATE dari transaksi (RECONCILIATION; P6,P7); EXCHANGE (TRANSACTION; X1,X2); RESOLVE_NOTIF_DOMAIN (NOTIFICATION); DE_PSEUDONYMIZE (RECONCILIATION; P7 saja); RE_ISSUE (TRANSACTION; P1,P2); REVOKE_TOKEN dan REVOKE_SUBJECT dan VIEW_AUDIT_LOG (ADMIN_CONSOLE); UPDATE_TX_STATUS (TRANSACTION; tidak diaudit).

Tabel 5, atribut brankas yang boleh dikembalikan: hanya P7 dan hanya `customer_id`, NIK, nama, itu pun hanya yang disetujui pada permintaan pembukaan. P1 sampai P6: tidak ada. HP dan rekening tidak pernah dikembalikan lewat jalur audit.

Tabel 6, dasar pembukaan sah: `DISPUTE`, `FRAUD_CONFIRMED`, `LEGAL_REQUEST` + nomor kasus. Dasar lain: `422 INVALID_BASIS`.

## 5. Algoritma inti (PRD 7)

`generate_token` (Gateway; STEP 0 policy_evaluate → `buat_token`), `generate_from_transaction` (Reconciliation; P6/P7; menolak bila `purged_at` terisi), `exchange_token` (STEP 0 pasangan Tabel 2; STEP 1 token ada, milik pemanggil, status; STEP 2 konteks sumber; STEP 3 `buat_token`), `resolve_domain_pseudonym` (Notification → pseudonim domain P5, bukan identitas), `re_issue` (hanya P1/P2, hanya transaksi belum terminal, token lama jadi expired), `de_pseudonymize` (GATE 1 token ada; 2 service cocok; 3 purpose cocok; 4 status; 5 permintaan pembukaan APPROVED, belum kedaluwarsa, pemohon sama; lalu `boleh_dibuka` dan peran auditor). Gerbang berhenti di kegagalan pertama; respons seragam. Semua operasi menulis audit, sukses maupun ditolak.

`revoke_subject`: cabut semua token aktif satu subjek (satu baris audit per token), kosongkan brankas bila CUSTOMER (`PURGE_IDENTITY`), kembalikan jumlah. Job retensi harian: tandai expired, kosongkan identitas mapping yang tidak berlaku ≥ `RETENTION_DAYS` (90, tetapan sendiri); brankas tidak ikut job ini.

## 6. Pembukaan identitas bersyarat (v2.4, PRD 7.4)

Audit rutin (`POST /reconciliation/audit-request`) hanya mengembalikan token P7 dan data transaksi, tanpa identitas. Membuka identitas: auditor `POST /disclosure-requests` (token P7, dasar, nomor kasus, atribut diminta) → admin lain `approve` (berlaku 600 detik, sekali pakai; pemohon menyetujui sendiri = `403 SELF_APPROVAL`) → Reconciliation memanggil `/de-pseudonymize` dengan `disclosure_id` → hanya atribut yang disetujui dikembalikan, status jadi USED, audit mencatat nama atribut (bukan nilai). Basis data memaksa `approver_id <> requester_id`.

## 7. Alur (PRD 9)

A pendaftaran (A1 klien→Gateway; A2 Keycloak; A3 token NOTIFICATION_REGISTRATION; A4 daftar HP ke Notification; A5 `POST /identity` simpan brankas). B transaksi normal (tokenisasi customer+rekening di Gateway; Transaction proses; PATCH status ke Privacy; tukar token ke Notification; kirim; resolve domain; SMS). C transaksi mencurigakan (nominal ≥ `FRAUD_AMOUNT_THRESHOLD`: tukar token ke Fraud, `/fraud/assess`, HELD; C4 review analis, tidak dievaluasi di Bab Metodologi). D rekonsiliasi harian (D3 laporan bank, tidak dievaluasi). E audit rutin, pembukaan bersyarat, admin.

## 8. Endpoint (PRD 10)

Privacy: `POST /pseudonymize` (3 bentuk), `/resolve-domain`, `/de-pseudonymize`, `/re-issue`, `/pseudonym/{p}/revoke`, `/subject/revoke`, `PATCH /transaction-status`, `GET /audit-log` (+`/timeline/{p}`, `/summary`), `/identity`, `/disclosure-requests` (+`/{id}/approve`, `/{id}/reject`). Transaction: `POST /transaction` (wajib `Idempotency-Key`), `GET /transaction/held`, `POST /transaction/{id}/review`. Fraud: `POST /fraud/assess`. Notification: `/notification/register`, `/notification/send`. Reconciliation: `/reconciliation/audit-request`, `/reconciliation/settlement-report`, `/reconciliation/run`. Gateway: `/settlement/report`. Semua: `/health`, `/metrics`. Konvensi: Bearer JWT, `X-Request-Id`, ISO 8601 UTC, rupiah bilangan bulat, pagination `limit` (50, maks 200) + `cursor`, format error seragam, ke klien hanya delapan `code` (401 UNAUTHENTICATED, 403 ACCESS_DENIED, 422 VALIDATION_ERROR, 429 RATE_LIMITED, 503 SERVICE_UNAVAILABLE, 500 INTERNAL_ERROR, 409 IDEMPOTENCY_CONFLICT, 409 NOT_HELD; ADR-0008).

## 9. Data (PRD 11)

privacy-db: `pseudonym_mapping` (enum, indeks unik parsial `uq_mapping_active ... WHERE status='active'`, `chk_purged`), `transaction_status`, `audit_log` (append-only lewat REVOKE UPDATE/DELETE, tanpa `subject_id`, + `disclosure_id`), `identity_vault` (kolom *_enc, `REVOKE ALL` dari `auditor_role`), `disclosure_request` (`chk_four_eyes`). transaction-db: `merchants`, `transactions` (pseudonim saja). fraud-db: `fraud_assessments` (tanpa `transaction_id`), `risk_rules`. notification-db: `contact_registry` (satu-satunya HP), `notification_log` (tanpa isi pesan). reconciliation-db: `settlement_batches`, `settlement_items`, `audit_requests`. Mode baseline: kolom pseudonim diganti kolom identitas asli (PRD 11 akhir).

## 10. Kebutuhan dan pengujian

FR-01 sampai FR-44, NFR-01 sampai NFR-25 (PRD 13, 14); tes TF-01..TF-17, TK-01..TK-28, paparan PII E(s), performa k6 (PRD 18). Pemetaan kebutuhan→tes: PRD 18.5. Mode: `PRIVACY_MODE=baseline|proposed` (hanya dua kondisi, ADR-0003).

## 11. Milestone (PRD 19)

M0 repo, Compose, kerangka tujuh layanan, skema DB, `/health` hijau. M1 Keycloak, service account, peran, Kong (JWT 401, rate limit 429). M2 Privacy Service inti (`/pseudonymize`, enkripsi field, indeks unik parsial, re-issue, retensi) + plugin tokenizer. M3 Policy Engine, audit_log append-only, `/audit-log`, `/de-pseudonymize` lima gerbang, `/disclosure-requests` (TK-01..TK-10, TK-13..TK-15 + TK terkait disclosure). M4 Transaction, Fraud, Notification, Reconciliation (mode proposed), tiga skenario ujung ke ujung. **M5 gerbang**: mode baseline dengan logika bisnis identik, satu env pengalih. M6 Postman/Newman, pemindai PII. M7 k6 5 pengulangan per mode, tabel paparan. M8 analisis dan penulisan.

## 12. Di luar cakupan (PRD 2)

UI/mobile, integrasi bank/SMS/QRIS nyata, blind/polymorphic pseudonymization, ML fraud, consent/portabilitas, HA/multi-region/DR, rotasi kunci otomatis (hanya `key_version`), model saldo/ledger, kirim ulang notifikasi otomatis, rotasi `K_index` (prosedur tertulis).

## 13. Keterbatasan yang harus tetap jujur (PRD 20)

Privacy Service adalah honeypot; semi-dinamis (linkability dalam TTL, 30 hari di Fraud); Keycloak dan Notification menyimpan PII; korelasi atribut tidak ditangani; `subject_lookup` adalah pseudonim statis internal (kerahasiaan `K_index` krusial); skor fraud maks 75 sehingga ambang BLOCK 90 tak tercapai; satu VPS membuat overhead optimistis.

**Tambahan dari implementasi (M4, ditambahkan atas keputusan Fanny 2026-10-22):** (a) bila jawaban dari Notification hilang pada langkah A4 pendaftaran, nomor HP dapat tersimpan di `contact_registry` tanpa pendaftaran selesai (Notification tidak punya endpoint hapus kontak; brankas dikosongkan dan token domain dicabut, ADR-0005); (b) bila jawaban IdP hilang pada A2, pengguna IdP yatim dapat tersisa dan nama penggunanya terpakai; (c) pembatas laju `POST /register` berkunci `req.ip`, benar selama tidak ada proksi di depan Gateway: harus ditinjau ulang saat Kong atau Docker dipakai (`trust proxy`, `X-Forwarded-For`); (d) penjadwal job memakai satu instans per layanan: dua instans menjalankan setiap job dua kali (M4-10).
